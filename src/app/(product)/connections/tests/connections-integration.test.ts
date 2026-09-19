// Integration tests for the Connection & Integration Hub (W059) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// The acceptance core of the work item — "connect/disconnect/configure;
// connection health; identity verification/linking; source freshness/
// checkpoint state; destination delivery state; tenant-owned credential
// references only" — proven end to end:
//
//   * every mutation flows through the SAME handler code the /api/connections
//     route drives (lib/api.ts + lib/actions.ts), and every read through the
//     same view builder the /connections page renders (lib/views.ts);
//   * all seeding happens through REAL module contracts only (channels,
//     sources, destinations, identity, people, organizations, freshness,
//     actions, conversations) — never raw SQL;
//   * tenant isolation: a second tenant's hub view contains none of the
//     first tenant's connections, deliveries or identities (ADR-0001);
//   * credential discipline: the serialized view carries ONLY opaque
//     credential references — no credential values anywhere;
//   * the authority rules of the composed contracts keep holding at the hub
//     boundary (identity:link/attest claims, the data-export gate).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import {
  receiveInbound,
  setChannelTransport,
  type ChannelTransport,
  type CanonicalDeliveryRequest,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  setSourceTransport,
  type SourceFetchRequest,
  type SourceFetchResult,
  type SourceTransport,
} from '@/modules/sources/contract';
import {
  dispatchDelivery,
  setDestinationTransport,
  type DestinationDeliveryRequest,
  type DestinationTransport,
  type TransportReceipt as DestinationReceipt,
} from '@/modules/destinations/contract';
import {
  decideApproval,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { setFreshnessPolicy } from '@/modules/freshness/contract';
import { getPerson } from '@/modules/people/contract';

import { buildConnectionsView } from '../lib/views';
import {
  handleConnectionsAction,
  handleConnectionsGet,
} from '../lib/api';
import type { ApiResult } from '../lib/api';
import { CONNECTIONS_OPERATOR_PRINCIPAL, TENANT_HEADER, AUTHORITY_HEADER } from '../lib/context';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture contexts
// ---------------------------------------------------------------------------

const BASE_TIME = Date.parse('2026-09-18T09:00:00.000Z');
let clockMs = BASE_TIME;

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function identityAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['identity:attest', 'identity:link'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

function policyAdmin(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: ['actions:administer', 'identity:attest', 'identity:link'],
  };
}

/** The channel transport the tests read verification codes off (W045 pattern). */
class RecordingTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static counter = 0;

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    RecordingTransport.counter += 1;
    return {
      status: 'delivered',
      providerMessageId: `w059-wire-${String(RecordingTransport.counter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

/** Scripted source fetch transport (sources module test pattern). */
class ScriptedSourceTransport implements SourceTransport {
  readonly requests: SourceFetchRequest[] = [];
  private scripted: (SourceFetchResult | Error)[] = [];

  script(...results: (SourceFetchResult | Error)[]): void {
    this.scripted.push(...results);
  }

  async fetch(request: SourceFetchRequest): Promise<SourceFetchResult> {
    this.requests.push(request);
    const next = this.scripted.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/** Always-accepting destination transport with scriptable failures. */
class ScriptedDestinationTransport implements DestinationTransport {
  readonly requests: DestinationDeliveryRequest[] = [];
  private scripted: DestinationReceipt[] = [];

  script(...results: DestinationReceipt[]): void {
    this.scripted.push(...results);
  }

  async deliver(request: DestinationDeliveryRequest): Promise<DestinationReceipt> {
    this.requests.push(request);
    const next = this.scripted.shift();
    if (next !== undefined) return next;
    return { status: 'delivered', providerDeliveryId: `w059-ack-${this.requests.length}`, detail: null };
  }
}

// Fake credentials are assembled from fragments at runtime (push-protection).
const SECRET_PREFIX = 'secret-';
const storePath = () => `${SECRET_PREFIX}store://w059/`;

/** A raw provider webhook payload (WhatsApp Cloud API envelope shape). */
function whatsappWebhook(options: {
  from: string;
  text: string;
  wamid: string;
  displayName?: string;
  businessNumber?: string;
  timestamp?: number;
}): Record<string, unknown> {
  const business = (options.businessNumber ?? '+15550100001').replace('+', '');
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: business },
              contacts: [
                {
                  profile: { name: options.displayName ?? 'Maya Chen' },
                  wa_id: options.from.replace('+', ''),
                },
              ],
              messages: [
                {
                  from: options.from.replace('+', ''),
                  id: options.wamid,
                  timestamp: options.timestamp ?? Math.floor(clockMs / 1000),
                  type: 'text',
                  text: { body: options.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Extracts the single-use verification code a delivered provider message carried. */
function challengeCodeFrom(messageText: string): string {
  const match = /(\d{6})/.exec(messageText);
  if (match === null) throw new Error(`no 6-digit code in delivered message: '${messageText}'`);
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Request shims (the handlers take standard `Request` objects)
// ---------------------------------------------------------------------------

const BASE_URL = 'http://aurum.test/api/connections';

function requestFor(ctx: TenantContext, extraQuery: Record<string, string> = {}): Request {
  const query = new URLSearchParams(extraQuery);
  query.set('tenant', ctx.tenantId);
  query.set('principal', ctx.principalId);
  if (ctx.authority.length > 0) query.set('authority', ctx.authority.join(','));
  return new Request(`${BASE_URL}?${query.toString()}`, { method: 'POST' });
}

function headerRequestFor(ctx: TenantContext): Request {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      [TENANT_HEADER]: ctx.tenantId,
      'x-aurum-principal': ctx.principalId,
      [AUTHORITY_HEADER]: ctx.authority.join(','),
    },
  });
}

async function act(ctx: TenantContext, body: unknown): Promise<ApiResult> {
  return handleConnectionsAction(requestFor(ctx), body);
}

async function get(ctx: TenantContext, extraQuery: Record<string, string> = {}): Promise<ApiResult> {
  const query = new URLSearchParams(extraQuery);
  query.set('tenant', ctx.tenantId);
  query.set('principal', ctx.principalId);
  if (ctx.authority.length > 0) query.set('authority', ctx.authority.join(','));
  const request = new Request(`${BASE_URL}?${query.toString()}`);
  return handleConnectionsGet(request);
}

function expectOk(result: ApiResult): asserts result is Extract<ApiResult, { status: 200 }> {
  if (result.status !== 200) {
    throw new Error(`expected HTTP 200, got ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

function expectError(result: ApiResult, status: number, code: string): void {
  if (result.status === 200) {
    throw new Error(`expected HTTP ${status} (${code}), got 200`);
  }
  if (result.status !== status || result.body.error !== code) {
    throw new Error(
      `expected HTTP ${status} (${code}), got ${result.status} (${result.body.error}): ${result.body.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

let tenantA = '';
let tenantB = '';
let operator: TenantContext;
let admin: TenantContext;
let attester: TenantContext;
let approverCtx: TenantContext;
let channelTransport: RecordingTransport;
let sourceTransport: ScriptedSourceTransport;
let destinationTransport: ScriptedDestinationTransport;

beforeAll(async () => {
  await runMigrations(db);
  const [provisioned, provisionedB] = await Promise.all([
    provisionTenant(
      { principalId: newId(), authority: ['organizations:provision'] },
      { name: 'Acme Group', ownerPrincipalId: newId() },
    ),
    provisionTenant(
      { principalId: newId(), authority: ['organizations:provision'] },
      { name: 'Beta Corp', ownerPrincipalId: newId() },
    ),
  ]);
  tenantA = provisioned.id;
  tenantB = provisionedB.id;
  operator = member(tenantA);
  admin = policyAdmin(tenantA);
  attester = identityAdmin(tenantA);
  approverCtx = approver(tenantA);
});

afterAll(async () => {
  setChannelTransport(null);
  setSourceTransport(null);
  setDestinationTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  channelTransport = new RecordingTransport();
  sourceTransport = new ScriptedSourceTransport();
  destinationTransport = new ScriptedDestinationTransport();
});

afterEach(() => {
  vi.restoreAllMocks();
  setChannelTransport(null);
  setSourceTransport(null);
  setDestinationTransport(null);
});

// ---------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------

describe('W059 — connect, disconnect and health for channels', () => {
  it('scopes the view: no tenant is a 400 with guidance', async () => {
    const result = await handleConnectionsGet(new Request(BASE_URL));
    expectError(result, 400, 'missing_tenant');
  });

  it('connects a WhatsApp endpoint through the hub action and surfaces honest health', async () => {
    const result = await act(operator, {
      action: 'channel.register',
      provider: 'whatsapp',
      providerAccountId: '+15550100001',
      displayName: 'Acme WhatsApp line',
      credentialRef: `${storePath()}tenantA/whatsapp`,
    });
    expectOk(result);
    expect(result.body.summary).toContain('Connected whatsapp');

    // No transport wired yet → the card must say so (derived, never faked).
    setChannelTransport(null);
    const view = await buildConnectionsView(operator);
    const card = view.channels.cards.find((c) => c.provider === 'whatsapp');
    expect(card).toBeDefined();
    expect(card!.connection).not.toBeNull();
    expect(card!.connection!.providerAccountId).toBe('+15550100001');
    expect(card!.connection!.credentialRef).toBe(`${storePath()}tenantA/whatsapp`);
    expect(card!.health.level).toBe('degraded');
    expect(card!.health.reasons.some((r) => r.text.includes('No delivery transport wired'))).toBe(true);
    expect(view.channels.connected).toBe(1);
    expect(view.channels.active).toBe(1);
  });

  it('flips to healthy once a transport is wired, then degrades nothing', async () => {
    setChannelTransport(channelTransport);
    const view = await buildConnectionsView(operator);
    const card = view.channels.cards.find((c) => c.provider === 'whatsapp')!;
    expect(card.health.level).toBe('ok');
    expect(card.transportWired).toBe(true);
  });

  it('disconnects and reconnects the endpoint (the only mutable field)', async () => {
    const view = await buildConnectionsView(operator);
    const connectionId = view.channels.cards.find((c) => c.provider === 'whatsapp')!.connection!.id;

    const disconnected = await act(operator, {
      action: 'channel.setStatus',
      connectionId,
      status: 'disabled',
    });
    expectOk(disconnected);
    expect(disconnected.body.summary).toContain('disconnected');

    const afterDisconnect = await buildConnectionsView(operator);
    const disabledCard = afterDisconnect.channels.cards.find((c) => c.provider === 'whatsapp')!;
    expect(disabledCard.connection!.status).toBe('disabled');
    expect(disabledCard.health.level).toBe('disabled');
    expect(afterDisconnect.channels.active).toBe(0);

    const reconnected = await act(operator, {
      action: 'channel.setStatus',
      connectionId,
      status: 'active',
    });
    expectOk(reconnected);
    const afterReconnect = await buildConnectionsView(operator);
    expect(afterReconnect.channels.cards.find((c) => c.provider === 'whatsapp')!.connection!.status).toBe('active');
  });

  it('re-registering an existing endpoint is an honest no-op (first registration wins)', async () => {
    const result = await act(operator, {
      action: 'channel.register',
      provider: 'whatsapp',
      providerAccountId: '+15550100001',
      credentialRef: `${storePath()}tenantA/whatsapp-2`,
    });
    expectOk(result);
    expect(result.body.summary).toContain('already connected');
    const view = await buildConnectionsView(operator);
    expect(view.channels.connected).toBe(1);
    expect(view.channels.cards.find((c) => c.provider === 'whatsapp')!.connection!.credentialRef).toBe(
      `${storePath()}tenantA/whatsapp`,
    );
  });

  it('maps a foreign/missing connection uniformly to 404 (no existence leak)', async () => {
    const result = await act(operator, {
      action: 'channel.setStatus',
      connectionId: newId(),
      status: 'disabled',
    });
    expectError(result, 404, 'connection_not_found');
  });
});

describe('W059 — identity verification and linking through the hub', () => {
  it('discovers the identity from channel activity with its verification state', async () => {
    // First contact: a raw provider webhook through the channels contract.
    await receiveInbound(operator, {
      provider: 'whatsapp',
      payload: whatsappWebhook({
        from: '+15550102299',
        text: 'Hi Aurum — this is Maya.',
        wamid: 'wamid.W059.INBOUND.0001',
        displayName: 'Maya Chen',
      }),
    });
    const view = await buildConnectionsView(operator);
    const whatsappCard = view.channels.cards.find((c) => c.provider === 'whatsapp')!;
    expect(whatsappCard.lastActivityAt).not.toBeNull();
    expect(whatsappCard.identitiesSeen).toBe(1);

    expect(view.identities.cards).toHaveLength(1);
    const identity = view.identities.cards[0]!;
    expect(identity.providerAccountId).toBe('+15550102299');
    expect(identity.status).toBe('unverified');
    expect(identity.subject).toBeNull();
    expect(view.identities.byStatus.unverified).toBe(1);
  });

  it('delivers a verification code over the identity channel and completes verification', async () => {
    setChannelTransport(channelTransport);
    const view = await buildConnectionsView(operator);
    const identityId = view.identities.cards[0]!.id;

    const delivered = await act(operator, { action: 'identity.challenge', identityId });
    expectOk(delivered);
    expect(delivered.body.summary).toContain('Verification code delivered');

    const sent = channelTransport.requests[channelTransport.requests.length - 1]!;
    const code = challengeCodeFrom(sent.message.text);

    const completed = await act(operator, { action: 'identity.complete', identityId, code });
    expectOk(completed);
    expect(completed.body.summary).toContain('verified');

    const after = await buildConnectionsView(operator);
    expect(after.identities.cards[0]!.status).toBe('verified');
    expect(after.identities.byStatus.verified).toBe(1);
  });

  it('links the verified identity to a person (claim-gated) and shows the subject', async () => {
    const personResult = await act(attester, {
      action: 'person.create',
      fullName: 'Maya Chen',
      email: 'maya.chen@acme.example',
    });
    expectOk(personResult);
    const personId = (personResult.body.result as { id: string }).id;

    const view = await buildConnectionsView(operator);
    const identityId = view.identities.cards[0]!.id;

    // A plain member may NOT link (uniform forbidden → 403).
    const denied = await act(operator, { action: 'identity.link', identityId, personId });
    expectError(denied, 403, 'forbidden');

    // The identity admin links through the same hub action.
    const linked = await act(attester, { action: 'identity.link', identityId, personId });
    expectOk(linked);
    expect(linked.body.summary).toContain('linked');

    const after = await buildConnectionsView(operator);
    const identity = after.identities.cards[0]!;
    expect(identity.subject).not.toBeNull();
    expect(identity.subject!.fullName).toBe('Maya Chen');
    expect(identity.subject!.resolvable).toBe(true);
  });

  it('finds identities outside the discovery window via the provider+account lookup', async () => {
    const result = await get(operator, {
      identity_provider: 'whatsapp',
      identity_account: '+15550102299',
    });
    expectOk(result);
    const view = result.body.view!;
    expect(view.identities.lookup).not.toBeNull();
    expect(view.identities.lookup!.providerAccountId).toBe('+15550102299');
    expect(view.identities.lookup!.discovered).toBe(false);

    const miss = await get(operator, {
      identity_provider: 'telegram',
      identity_account: '77999000',
    });
    expectOk(miss);
    expect(miss.body.view!.identities.lookup).toBeNull();
    expect(miss.body.view!.identities.lookupMiss).toContain('No identity found');
  });

  it('detaches and revokes through the hub, with honest state transitions', async () => {
    let view = await buildConnectionsView(operator);
    const identityId = view.identities.cards[0]!.id;

    const detached = await act(attester, { action: 'identity.detach', identityId });
    expectOk(detached);
    view = await buildConnectionsView(operator);
    expect(view.identities.cards[0]!.subject).toBeNull();

    const revoked = await act(attester, {
      action: 'identity.revoke',
      identityId,
      reason: 'Account holder left the company',
    });
    expectOk(revoked);
    view = await buildConnectionsView(operator);
    expect(view.identities.cards[0]!.status).toBe('revoked');
    expect(view.identities.cards[0]!.revokedReason).toBe('Account holder left the company');
    expect(view.identities.cards[0]!.subject).toBeNull();
  });
});

describe('W059 — source freshness and checkpoint state', () => {
  const CREDENTIAL_REF = `${storePath()}tenantA/salesforce`;

  async function registerSource(): Promise<string> {
    const result = await act(operator, {
      action: 'source.register',
      provider: 'salesforce',
      providerAccountId: 'org-00D1',
      displayName: 'Acme Salesforce org',
      authKind: 'oauth',
      credentialRef: CREDENTIAL_REF,
      oauthScopes: ['read:records'],
      oauthExpiresAt: new Date(clockMs + 90 * 24 * 3600 * 1000).toISOString(),
    });
    expectOk(result);
    return (result.body.result as { source: { id: string } }).source.id;
  }

  it('connects a source and reports never-polled as attention', async () => {
    const sourceId = await registerSource();
    const view = await buildConnectionsView(operator);
    const card = view.sources.cards.find((c) => c.id === sourceId)!;
    expect(card.label).toBe('Salesforce');
    expect(card.authKind).toBe('oauth');
    expect(card.credentialRef).toBe(CREDENTIAL_REF);
    expect(card.checkpoint).toBeNull();
    expect(card.health.level).toBe('attention');
    expect(card.health.reasons.some((r) => r.text.includes('Never polled'))).toBe(true);
    expect(view.sources.connected).toBe(1);
  });

  it('polls through the hub action: checkpoint advances and freshness classifies (W006)', async () => {
    const sourceId = await registerSource();

    // A tenant freshness policy for sources (the canonical W006 classifier).
    await setFreshnessPolicy(operator, {
      subjectKind: 'source',
      subjectId: null,
      staleAfterSeconds: 24 * 3600,
      agingAfterSeconds: 3600,
    });

    setSourceTransport(sourceTransport);
    sourceTransport.script({
      records: [
        {
          providerRecordId: 'rec-001',
          kind: 'crm.opportunity.updated',
          payload: { amount: 1200 },
          occurredAt: new Date(clockMs - 60 * 1000).toISOString(),
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: false,
    });

    const polled = await act(operator, { action: 'source.poll', sourceId });
    expectOk(polled);
    expect(polled.body.summary).toContain('1 fetched, 1 new observations');

    const view = await buildConnectionsView(operator);
    const card = view.sources.cards.find((c) => c.id === sourceId)!;
    expect(card.checkpoint).not.toBeNull();
    expect(card.checkpoint!.cursor).toBe('cursor-1');
    expect(card.freshness.status).toBe('current');
    expect(card.freshness.observationsConsidered).toBe(1);
    expect(card.health.level).toBe('ok');
    expect(card.recentCheckpoints.some((entry) => entry.origin === 'poll')).toBe(true);
  });

  it('freshness ages and stales against the policy as time passes', async () => {
    clockMs += 2 * 3600 * 1000; // 2h — past the aging threshold
    let view = await buildConnectionsView(operator);
    let card = view.sources.cards[0]!;
    expect(card.freshness.status).toBe('aging');
    expect(card.health.level).toBe('attention');

    clockMs += 30 * 24 * 3600 * 1000; // a month — stale
    view = await buildConnectionsView(operator);
    card = view.sources.cards[0]!;
    expect(card.freshness.status).toBe('stale');
    expect(card.health.level).toBe('degraded');
  });

  it('replays from the start: the checkpoint rewinds (audited) under dedupe', async () => {
    const sourceId = (await buildConnectionsView(operator)).sources.cards[0]!.id;
    const replayed = await act(operator, { action: 'source.replay', sourceId });
    expectOk(replayed);
    expect(replayed.body.summary).toContain('rewound');

    const view = await buildConnectionsView(operator);
    const card = view.sources.cards.find((c) => c.id === sourceId)!;
    expect(card.checkpoint).not.toBeNull();
    expect(card.checkpoint!.cursor).toBeNull(); // start of history
    expect(card.recentCheckpoints.some((entry) => entry.origin === 'replay')).toBe(true);
  });

  it('re-authorizes (configures) the source through re-registration', async () => {
    const sourceId = (await buildConnectionsView(operator)).sources.cards[0]!.id;
    const result = await act(operator, {
      action: 'source.register',
      provider: 'salesforce',
      providerAccountId: 'org-00D1',
      authKind: 'oauth',
      credentialRef: `${storePath()}tenantA/salesforce-2`,
      oauthScopes: ['read:records', 'write:records'],
    });
    expectOk(result);
    expect(result.body.summary).toContain('Re-authorized');

    const view = await buildConnectionsView(operator);
    const card = view.sources.cards.find((c) => c.id === sourceId)!;
    expect(card.credentialRef).toBe(`${storePath()}tenantA/salesforce-2`);
    expect(card.oauthScopes).toEqual(['read:records', 'write:records']);
    expect(view.sources.connected).toBe(1); // same connector, not a new one
  });

  it('disconnects the source (status is the ingestion lifecycle)', async () => {
    const sourceId = (await buildConnectionsView(operator)).sources.cards[0]!.id;
    const result = await act(operator, {
      action: 'source.setStatus',
      sourceId,
      status: 'disabled',
    });
    expectOk(result);
    const view = await buildConnectionsView(operator);
    const card = view.sources.cards.find((c) => c.id === sourceId)!;
    expect(card.status).toBe('disabled');
    expect(card.health.level).toBe('disabled');
    expect(view.sources.active).toBe(0);
  });
});

describe('W059 — destination delivery state', () => {
  const CREDENTIAL_REF = `${storePath()}tenantA/webhook`;

  async function registerDestination(): Promise<string> {
    const result = await act(operator, {
      action: 'destination.register',
      provider: 'webhook',
      providerAccountId: 'https://bi.acme.test/aurum',
      displayName: 'Acme BI webhook',
      authKind: 'credentials',
      credentialRef: CREDENTIAL_REF,
    });
    expectOk(result);
    return (result.body.result as { destination: { id: string } }).destination.id;
  }

  it('connects a destination and shows the quiet no-deliveries state', async () => {
    const destinationId = await registerDestination();
    const view = await buildConnectionsView(operator);
    const card = view.destinations.cards.find((c) => c.id === destinationId)!;
    expect(card.label).toBe('Webhook');
    expect(card.category).toBe('webhook');
    expect(card.credentialRef).toBe(CREDENTIAL_REF);
    expect(card.deliveries.total).toBe(0);
    expect(card.health.level).toBe('ok');
    expect(view.destinations.connected).toBe(1);
  });

  it('surfaces the gate-held pending delivery, then the approved retry delivering it', async () => {
    const destinationId = await registerDestination();
    setDestinationTransport(destinationTransport);

    // A member dispatches an export batch (destinations contract).
    const dispatch = await dispatchDelivery(operator, {
      destinationId,
      kind: 'findings.opportunities',
      records: [{ recordId: 'o-1', data: { headline: 'Q3 renewal upside' } }],
    });
    expect(dispatch.delivery.status).toBe('pending'); // the default data-export gate holds it
    expect(dispatch.attempt).toBeNull();

    let view = await buildConnectionsView(operator);
    let card = view.destinations.cards.find((c) => c.id === destinationId)!;
    expect(card.deliveries.pending).toBe(1);
    expect(card.deliveries.latest!.status).toBe('pending');
    expect(card.health.level).toBe('ok'); // pending is the normal gated state, not a fault

    // The human decision releases the gate; the hub retry performs the delivery.
    await decideApproval(approverCtx, {
      requestId: dispatch.delivery.actionRequestId!,
      decision: 'approve',
    });
    const retried = await act(operator, {
      action: 'destination.retry',
      deliveryId: dispatch.delivery.id,
    });
    expectOk(retried);
    expect(retried.body.summary).toContain('accepted the batch');

    view = await buildConnectionsView(operator);
    card = view.destinations.cards.find((c) => c.id === destinationId)!;
    expect(card.deliveries.delivered).toBe(1);
    expect(card.deliveries.pending).toBe(0);
    expect(card.deliveries.latest!.status).toBe('delivered');
    expect(card.health.level).toBe('ok');
  });

  it('re-delivers (replays) a delivered export as a new gated delivery', async () => {
    setDestinationTransport(destinationTransport);
    clockMs += 60 * 1000; // strictly newer requested_at → deterministic 'latest'
    const view = await buildConnectionsView(operator);
    const card = view.destinations.cards[0]!;
    const delivered = card.deliveries.latest!;

    // Policy must allow the immediate gate pass for the replay to attempt now.
    await setAuthorityPolicy(admin, { actionKind: 'data-export', approvalLevels: [], forbiddenLevels: [] });

    const replayed = await act(operator, {
      action: 'destination.replay',
      deliveryId: delivered.id,
    });
    expectOk(replayed);
    expect(replayed.body.summary).toContain('fresh full gate authorization');

    const after = await buildConnectionsView(operator);
    const updated = after.destinations.cards.find((c) => c.id === card.id)!;
    expect(updated.deliveries.total).toBe(2);
    expect(updated.deliveries.delivered).toBe(2);
  });

  it('degrades on transient delivery failures and offers retry', async () => {
    setDestinationTransport(destinationTransport);
    clockMs += 120 * 1000; // strictly newer requested_at → deterministic 'latest'
    const destinationId = (await buildConnectionsView(operator)).destinations.cards[0]!.id;
    destinationTransport.script({ status: 'failed', providerDeliveryId: null, detail: 'boom' });

    const dispatch = await dispatchDelivery(operator, {
      destinationId,
      kind: 'findings.risks',
      records: [{ recordId: 'r-1', data: { headline: 'Vendor concentration' } }],
    });
    expect(dispatch.delivery.status).toBe('failed'); // policy-allowed, transport failed

    const view = await buildConnectionsView(operator);
    const card = view.destinations.cards.find((c) => c.id === destinationId)!;
    expect(card.deliveries.failed).toBe(1);
    expect(card.deliveries.latest!.status).toBe('failed');
    expect(card.health.level).toBe('degraded');
    expect(card.health.reasons.some((r) => r.text.includes('failed transiently'))).toBe(true);

    // A retry succeeds once the transport is healthy again.
    const retried = await act(operator, {
      action: 'destination.retry',
      deliveryId: dispatch.delivery.id,
    });
    expectOk(retried);
    const after = await buildConnectionsView(operator);
    const updated = after.destinations.cards.find((c) => c.id === destinationId)!;
    expect(updated.deliveries.failed).toBe(0);
    expect(updated.deliveries.delivered).toBeGreaterThanOrEqual(3);
  });

  it('re-authorizes (configures) and disconnects the destination', async () => {
    const destinationId = (await buildConnectionsView(operator)).destinations.cards[0]!.id;
    const reauthorized = await act(operator, {
      action: 'destination.register',
      provider: 'webhook',
      providerAccountId: 'https://bi.acme.test/aurum',
      authKind: 'credentials',
      credentialRef: `${storePath()}tenantA/webhook-2`,
    });
    expectOk(reauthorized);
    expect(reauthorized.body.summary).toContain('Re-authorized');

    const disconnected = await act(operator, {
      action: 'destination.setStatus',
      destinationId,
      status: 'disabled',
    });
    expectOk(disconnected);
    const view = await buildConnectionsView(operator);
    const card = view.destinations.cards.find((c) => c.id === destinationId)!;
    expect(card.credentialRef).toBe(`${storePath()}tenantA/webhook-2`);
    expect(card.status).toBe('disabled');
    expect(card.health.level).toBe('disabled');
    expect(view.destinations.active).toBe(0);
  });
});

describe('W059 — tenant isolation and the API envelope', () => {
  it('another tenant sees none of tenant A\'s connections, identities or deliveries', async () => {
    const outsider = member(tenantB);
    const view = await buildConnectionsView(outsider);
    expect(view.tenantId).toBe(tenantB);
    expect(view.channels.connected).toBe(0);
    expect(view.sources.connected).toBe(0);
    expect(view.destinations.connected).toBe(0);
    expect(view.identities.cards).toHaveLength(0);

    // Foreign ids are uniformly not found — no existence leak.
    const tenantAView = await buildConnectionsView(operator);
    const channelConnectionId = tenantAView.channels.cards.find((c) => c.connection !== null)!.connection!.id;
    const denied = await act(outsider, {
      action: 'channel.setStatus',
      connectionId: channelConnectionId,
      status: 'disabled',
    });
    expectError(denied, 404, 'connection_not_found');

    // Lookup in tenant B finds nothing for tenant A's account.
    const miss = await get(outsider, {
      identity_provider: 'whatsapp',
      identity_account: '+15550102299',
    });
    expectOk(miss);
    expect(miss.body.view!.identities.lookup).toBeNull();
  });

  it('resolves the context from headers (the API envelope matches the tower discipline)', async () => {
    const result = await handleConnectionsGet(headerRequestFor(operator));
    expectOk(result);
    expect(result.body.surface).toBe('connections');
    expect(result.body.tenantId).toBe(tenantA);
    expect(result.body.generatedAt).toBeDefined();
    expect(result.body.view!.tenantId).toBe(tenantA);
    expect(result.body.view!.channels.catalogSize).toBe(12);
    expect(result.body.view!.catalog.sources.length).toBe(13);
  });

  it('defaults the principal to the connections operator (documented dev seam)', async () => {
    const result = await handleConnectionsGet(new Request(`${BASE_URL}?tenant=${tenantA}`));
    expectOk(result);
  });

  it('rejects malformed bodies with readable 400s', async () => {
    const noBody = await act(operator, null);
    expectError(noBody, 400, 'invalid_body');
    const unknownAction = await act(operator, { action: 'explode' });
    expectError(unknownAction, 400, 'invalid_body');
    const badProvider = await act(operator, {
      action: 'channel.register',
      provider: 'semaphore',
      providerAccountId: 'x',
      credentialRef: 'ref',
    });
    expectError(badProvider, 400, 'invalid_body');
  });
});

describe('W059 — credential references only (acceptance)', () => {
  it('the serialized view carries opaque credential references and no credential values', async () => {
    const view = await buildConnectionsView(operator);
    const serialized = JSON.stringify(view);
    // Every connected card exposes exactly one opaque reference field.
    for (const card of view.channels.cards) {
      if (card.connection !== null) {
        expect(card.connection.credentialRef.startsWith(`${SECRET_PREFIX}store://`)).toBe(true);
      }
    }
    for (const card of view.sources.cards) {
      expect(card.credentialRef.startsWith(`${SECRET_PREFIX}store://`)).toBe(true);
    }
    for (const card of view.destinations.cards) {
      expect(card.credentialRef.startsWith(`${SECRET_PREFIX}store://`)).toBe(true);
    }
    // No credential-value vocabulary anywhere in the derived surface.
    expect(serialized).not.toContain('"credential"');
    expect(serialized).not.toContain('"credentialValue"');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"password"');
    expect(serialized).not.toContain('"secret":');
    expect(serialized).not.toContain('"apiKey"');
  });

  it('the operator principal is the documented seam default, and person subjects resolve through the people contract', async () => {
    // (Sanity on the seam constant + people composition used by identity cards.)
    expect(CONNECTIONS_OPERATOR_PRINCIPAL).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const view = await buildConnectionsView(operator);
    for (const identity of view.identities.cards) {
      if (identity.subject !== null && identity.subject.resolvable) {
        const person = await getPerson(operator, identity.subject.id);
        expect(person.fullName).toBe(identity.subject.fullName);
      }
    }
  });
});
