// Integration tests for the destinations module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W037
// acceptance: "Provider-independent outbound destinations for BI,
// warehouses, CRM/ERP, spreadsheets, APIs and webhooks with authorization
// and provenance."
//
//  * registration — creation, idempotent re-registration as the
//    re-authorization path (authorization fields move, identity does
//    not), account normalization, derived category/content-constraint
//    metadata, list filters (provider/category/status), status flips,
//    uniform cross-tenant not-found discipline (ADR-0001);
//  * authorization — three layers, all tested:
//      - the actions gate (W009 'data-export' @ EXECUTE): under the
//        built-in default matrix exports WAIT for a human approval; a
//        tenant policy row may allow (instant attempt) or forbid
//        (terminal rejection, no transport call); the gate is authorized
//        ONCE per delivery (stable idempotency key) and replayed on
//        retries — an approval between pumps unlocks without duplicating
//        gate history;
//      - provider authorization (OAuth/credentials isolation): lapsed
//        grants fail fast, transport-reported refreshes advance the
//        recorded expiry, re-registration re-authorizes, credentials
//        destinations reject reported expiries loudly;
//      - evidence-level authorization: referenced observations must be
//        readable by the dispatching principal and must not be tagged
//        'no-export' (the W004 usage tag this module consumes);
//  * provider independence — the SAME canonical batch delivers through
//    warehouse/webhook/spreadsheet/API destinations with per-provider
//    envelopes; structured providers reject non-object records BEFORE
//    any gate request or transport call; envelope providers accept any
//    JSON;
//  * idempotency — a recorded caller key replays the original delivery
//    (no duplicate gate request, no duplicate delivery);
//  * retries — transient transport failures (receipts and thrown
//    transports) record failed attempts and retry to delivery;
//    provider-unavailable leaves the delivery pending and retryable;
//    terminal outcomes are not retryable;
//  * replay/reprocessing — replayDelivery re-delivers recorded content as
//    a NEW delivery under a FRESH full gate authorization, linking back
//    through replayedFromId;
//  * provenance/audit — deliveries carry records, evidence references,
//    the gate request link and the replay origin; attempts are the
//    append-only physical audit (envelope, outcome, provider
//    acknowledgment, timing window);
//  * ADR-0009 — destinations never become domain truth: no destinations
//    operation records an observation;
//  * tenant isolation — another tenant's destinations, deliveries,
//    attempts and operations are indistinguishable from missing;
//  * storage discipline — the delivery ledger is append-only with
//    forward-only lifecycle transitions and a one-way gate link;
//    attempts are strictly append-only; the destinations table enforces
//    OAuth/credentials coherence;
//  * serialization — a concurrent attempt on the same delivery fails
//    explicitly with `delivery_busy`.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as destinationsContract from '../contract';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
  type ActionRequest,
} from '@/modules/actions/contract';
import { listObservations, recordObservation } from '@/modules/observations/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { getLock } from '@/infra/lock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { DestinationsError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';
import type {
  DestinationDeliveryRequest,
  DestinationTransport,
  TransportReceipt,
} from '../types';

const {
  dispatchDelivery,
  getDelivery,
  getDestination,
  getDestinationTransport,
  listDeliveries,
  listDeliveryAttempts,
  listDestinations,
  registerDestination,
  replayDelivery,
  retryDelivery,
  setDestinationStatus,
  setDestinationTransport,
} = destinationsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
// Tests that assert exact gate-request counts or ledger contents mint
// their own fresh tenant inline (the per-test clock reset would otherwise
// make `requested_at DESC` ordering non-deterministic inside a shared
// tenant).
const tenantRegister = newId();
const tenantIdempotency = newId();
const tenantProvenance = newId();
const tenantProviders = newId();
const tenantUnavailable = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantBusy = newId();
const tenantTruth = newId();
const tenantB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

async function expectCode(
  code: DestinationsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected DestinationsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof DestinationsError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** A provider-neutral transport that records every delivery request. */
class ScriptedTransport implements DestinationTransport {
  readonly requests: DestinationDeliveryRequest[] = [];
  private scripted: (TransportReceipt | Error)[] = [];
  private ackCounter = 0;

  /** Queue exact receipts/throws (consumed in order); unscripted deliveries succeed with a fresh ack id. */
  script(...results: (TransportReceipt | Error)[]): void {
    this.scripted.push(...results);
  }

  async deliver(request: DestinationDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    const next = this.scripted.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    this.ackCounter += 1;
    return { status: 'delivered', providerDeliveryId: `ack-${this.ackCounter}`, detail: null };
  }
}

let transport: ScriptedTransport;

const BASE_TIME = Date.parse('2026-09-14T08:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

/** The canonical export batch used across the provider-independence group. */
const BATCH = [
  { recordId: 'opp-1', data: { name: 'Expand to EU', value: 42000 } },
  { recordId: 'opp-2', data: { name: 'Renew ACME', value: 18000 } },
];

let accountCounter = 0;
async function registerWebhook(
  tenantId: string,
  overrides: Partial<Parameters<typeof registerDestination>[1]> = {},
): Promise<string> {
  // Default account ids are unique per call so every test owns a fresh
  // destination even inside a shared tenant.
  accountCounter += 1;
  const { destination } = await registerDestination(member(tenantId), {
    provider: 'webhook',
    providerAccountId: `https://hooks.acme.com/aurum/${accountCounter}`,
    displayName: 'Acme BI webhook',
    authKind: 'credentials',
    credentialRef: 'secret-store://webhook/acme',
    ...overrides,
  });
  return destination.id;
}

/** Records one piece of tenant-visible evidence and returns its id. */
async function recordEvidence(
  ctx: TenantContext,
  usage: string[] = [],
  visibility: 'tenant' | 'principal' = 'tenant',
): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'findings.opportunity',
    payload: { name: 'Expand to EU', value: 42000 },
    observedAt: '2026-09-14T09:30:00Z',
    source: { kind: 'agent', id: null, label: 'opportunity-engine' },
    channel: 'cognition',
    permissions: {
      visibility,
      workspaceId: null,
      principalId: visibility === 'principal' ? ctx.principalId : null,
      usage,
    },
    confidence: { value: 0.8, method: 'opportunity-engine', basis: null },
  });
  return observation.id;
}

/** Allows data-export @ EXECUTE for a tenant through the authority matrix. */
async function allowExports(tenantId: string): Promise<void> {
  await setAuthorityPolicy(admin(tenantId), {
    actionKind: 'data-export',
    approvalLevels: [],
    forbiddenLevels: [],
  });
}

/** Forbids data-export @ EXECUTE for a tenant through the authority matrix. */
async function forbidExports(tenantId: string): Promise<void> {
  await setAuthorityPolicy(admin(tenantId), {
    actionKind: 'data-export',
    approvalLevels: [],
    forbiddenLevels: ['EXECUTE'],
  });
}

async function gateRequests(tenantId: string): Promise<ActionRequest[]> {
  return listActionRequests(member(tenantId), { actionKind: 'data-export' });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setDestinationTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  transport = new ScriptedTransport();
  setDestinationTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setDestinationTransport(null);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('destination registration', () => {
  it('creates a destination with canonical account id and derived capabilities', async () => {
    const { destination, created } = await registerDestination(member(tenantRegister), {
      provider: 'snowflake',
      providerAccountId: '  Acme-Prod ',
      displayName: '  Acme Warehouse  ',
      authKind: 'oauth',
      credentialRef: 'secret-store://snowflake/acme',
      oauthScopes: ['warehouse.insert'],
      oauthExpiresAt: '2027-06-01T00:00:00Z',
    });
    expect(created).toBe(true);
    expect(destination.provider).toBe('snowflake');
    expect(destination.providerAccountId).toBe('acme-prod');
    expect(destination.displayName).toBe('Acme Warehouse');
    expect(destination.status).toBe('active');
    expect(destination.category).toBe('warehouse');
    expect(destination.requiresObjectRecords).toBe(true);
    expect(destination.oauthScopes).toEqual(['warehouse.insert']);
    expect(destination.oauthExpiresAt).toBe('2027-06-01T00:00:00.000Z');
    // Credential ISOLATION: only the opaque reference exists, never a value.
    expect(destination.credentialRef).toBe('secret-store://snowflake/acme');

    const read = await getDestination(member(tenantRegister), destination.id);
    expect(read.id).toBe(destination.id);

    // Envelope-style providers: any JSON record data.
    const { destination: hook } = await registerDestination(member(tenantRegister), {
      provider: 'webhook',
      providerAccountId: 'https://hooks.acme.com/aurum',
      authKind: 'credentials',
      credentialRef: 'secret-store://webhook/acme',
    });
    expect(hook.category).toBe('webhook');
    expect(hook.requiresObjectRecords).toBe(false);
  });

  it('re-registration is the re-authorization path (identity immutable, authorization moves)', async () => {
    const ctx = member(tenantRegister);
    const first = await registerDestination(ctx, {
      provider: 'webhook',
      providerAccountId: 'https://hooks.acme.com/aurum/9',
      authKind: 'credentials',
      credentialRef: 'secret-store://webhook/acme',
    });
    expect(first.created).toBe(true);
    advance(60);
    const second = await registerDestination(ctx, {
      provider: 'webhook',
      providerAccountId: 'https://hooks.acme.com/aurum/9',
      authKind: 'oauth',
      credentialRef: 'secret-store://webhook/acme-v2',
      oauthScopes: ['push.write'],
      oauthExpiresAt: '2027-03-01T00:00:00Z',
      displayName: 'ignored on re-registration',
    });
    expect(second.created).toBe(false);
    expect(second.destination.id).toBe(first.destination.id);
    expect(second.destination.authKind).toBe('oauth');
    expect(second.destination.credentialRef).toBe('secret-store://webhook/acme-v2');
    expect(second.destination.oauthScopes).toEqual(['push.write']);
    expect(second.destination.oauthExpiresAt).toBe('2027-03-01T00:00:00.000Z');
    // Identity and first-registration metadata never change.
    expect(second.destination.providerAccountId).toBe(first.destination.providerAccountId);
    expect(second.destination.displayName).toBe(first.destination.displayName);
    expect(second.destination.createdBy).toBe(first.destination.createdBy);
    expect(second.destination.createdAt).toBe(first.destination.createdAt);
  });

  it('lists with provider/category/status filters and flips status', async () => {
    const tenantLists = newId(); // fresh tenant: list assertions stay exact
    const ctx = member(tenantLists);
    await registerDestination(ctx, {
      provider: 'looker',
      providerAccountId: 'acme-looker',
      authKind: 'credentials',
      credentialRef: 'secret-store://looker/acme',
    });
    advance(1); // distinct created_at keeps list ordering deterministic
    const { destination: sf } = await registerDestination(ctx, {
      provider: 'salesforce',
      providerAccountId: '00Dxx0000000001',
      authKind: 'oauth',
      credentialRef: 'secret-store://salesforce/acme',
      oauthScopes: ['api'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    advance(1);
    await registerDestination(ctx, {
      provider: 'webhook',
      providerAccountId: 'https://hooks.acme.com/lists',
      authKind: 'credentials',
      credentialRef: 'secret-store://webhook/acme',
    });

    expect(await listDestinations(ctx, {})).toHaveLength(3);
    expect(await listDestinations(ctx, { provider: 'salesforce' })).toHaveLength(1);
    // categories are derived adapter classifications — resolved onto their
    // provider sets at query time
    expect(await listDestinations(ctx, { category: 'bi' })).toHaveLength(1);
    expect(await listDestinations(ctx, { category: 'crm-erp' })).toHaveLength(1);
    expect(await listDestinations(ctx, { category: 'warehouse' })).toHaveLength(0);

    const disabled = await setDestinationStatus(ctx, {
      destinationId: sf.id,
      status: 'disabled',
    });
    expect(disabled.status).toBe('disabled');
    expect(await listDestinations(ctx, { status: 'active' })).toHaveLength(2);
    expect(await listDestinations(ctx, { status: 'disabled' })).toHaveLength(1);

    await expectCode('destination_not_found', () =>
      setDestinationStatus(ctx, { destinationId: newId(), status: 'active' }),
    );
    await expectCode('destination_not_found', () => getDestination(ctx, newId()));
  });
});

// ---------------------------------------------------------------------------
// The authority gate (W009 'data-export' @ EXECUTE)
// ---------------------------------------------------------------------------

describe('the authority gate', () => {
  it('holds deliveries for human approval under the built-in default matrix', async () => {
    const tenant = newId();
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const result = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(result.created).toBe(true);
    expect(result.attempt).toBeNull();
    expect(result.delivery.status).toBe('pending');
    expect(result.delivery.provider).toBe('webhook');
    expect(result.delivery.requestedBy).toBe(ctx.principalId);
    // Nothing left the system and the gate request is recorded + linked.
    expect(transport.requests).toHaveLength(0);
    const requests = await gateRequests(tenant);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.actionKind).toBe('data-export');
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.status).toBe('pending');
    expect(request.idempotencyKey).toBe(`destinations:delivery:${result.delivery.id}`);
    expect(request.payload).toEqual({
      destinationId,
      deliveryId: result.delivery.id,
      provider: 'webhook',
      kind: 'findings.opportunities',
      recordCount: 2,
      provenanceObservationIds: [],
    });
    expect(result.delivery.actionRequestId).toBe(request.id);
    expect(await listDeliveryAttempts(ctx, { deliveryId: result.delivery.id })).toEqual([]);
  });

  it('an approval between pumps unlocks the delivery without duplicating gate history', async () => {
    const tenant = newId();
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const { delivery } = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    // Still gated — a pump retry changes nothing and attempts nothing.
    const stillPending = await retryDelivery(ctx, { deliveryId: delivery.id });
    expect(stillPending.attempt).toBeNull();
    expect(stillPending.delivery.status).toBe('pending');
    expect(transport.requests).toHaveLength(0);

    // The human decision (a different, authorized principal decides).
    await decideApproval(approver(tenant), {
      requestId: delivery.actionRequestId!,
      decision: 'approve',
    });
    const retried = await retryDelivery(ctx, { deliveryId: delivery.id });
    expect(retried.attempt).not.toBeNull();
    expect(retried.attempt!.attemptNumber).toBe(1);
    expect(retried.attempt!.outcome).toBe('delivered');
    expect(retried.attempt!.providerDeliveryId).toBe('ack-1');
    expect(retried.delivery.status).toBe('delivered');
    expect(transport.requests).toHaveLength(1);
    // ONE gate request for the whole lifecycle — the retry replayed it.
    expect(await gateRequests(tenant)).toHaveLength(1);
  });

  it('a tenant policy row that allows EXECUTE delivers immediately', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const result = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(result.attempt).not.toBeNull();
    expect(result.delivery.status).toBe('delivered');
    expect(transport.requests).toHaveLength(1);
    const request = (await gateRequests(tenant))[0]!;
    expect(request.status).toBe('approved'); // policy auto-approval
    expect(request.evaluation.outcome).toBe('allowed');
    expect(request.evaluation.resolvedVia).toBe('kind');
  });

  it('a tenant policy row that forbids EXECUTE rejects the delivery terminally', async () => {
    const tenant = newId();
    await forbidExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const result = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(result.attempt).toBeNull();
    expect(result.delivery.status).toBe('rejected');
    expect(transport.requests).toHaveLength(0); // forbidden exports never leave
    await expectCode('delivery_not_retryable', () =>
      retryDelivery(ctx, { deliveryId: result.delivery.id }),
    );
    expect((await gateRequests(tenant))[0]!.status).toBe('rejected');
  });

  it('a human rejection terminates a pending delivery', async () => {
    const tenant = newId();
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const { delivery } = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    await decideApproval(approver(tenant), {
      requestId: delivery.actionRequestId!,
      decision: 'reject',
    });
    const retried = await retryDelivery(ctx, { deliveryId: delivery.id });
    expect(retried.attempt).toBeNull();
    expect(retried.delivery.status).toBe('rejected');
    expect(transport.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('dispatch idempotency', () => {
  it('a recorded key replays the original delivery without re-gating', async () => {
    await allowExports(tenantIdempotency);
    const ctx = member(tenantIdempotency);
    const destinationId = await registerWebhook(tenantIdempotency);
    const first = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'export-2026-09-14-001',
    });
    expect(first.created).toBe(true);
    expect(first.delivery.status).toBe('delivered');
    expect(transport.requests).toHaveLength(1);

    const second = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'export-2026-09-14-001',
    });
    expect(second.created).toBe(false);
    expect(second.attempt).toBeNull();
    expect(second.delivery.id).toBe(first.delivery.id);
    expect(second.delivery.status).toBe('delivered');
    // No duplicate gate request, no duplicate physical delivery.
    expect(await gateRequests(tenantIdempotency)).toHaveLength(1);
    expect(transport.requests).toHaveLength(1);
    expect(await listDeliveries(ctx, {})).toHaveLength(1);

    // A distinct key is a distinct delivery.
    const third = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'export-2026-09-14-002',
    });
    expect(third.created).toBe(true);
    expect(await listDeliveries(ctx, {})).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Evidence-level authorization (the W004 usage tags this module consumes)
// ---------------------------------------------------------------------------

describe('evidence-level authorization', () => {
  it("refuses to export evidence tagged 'no-export'", async () => {
    const tenant = newId();
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const observationId = await recordEvidence(ctx, ['no-export']);
    await expectCode('evidence_export_forbidden', () =>
      dispatchDelivery(ctx, {
        destinationId,
        kind: 'findings.opportunities',
        records: BATCH,
        provenanceObservationIds: [observationId],
      }),
    );
    // Refused BEFORE the gate and before any transport call.
    expect(await gateRequests(tenant)).toEqual([]);
    expect(transport.requests).toHaveLength(0);
    expect(await listDeliveries(ctx, {})).toEqual([]);
  });

  it('uniformly reports foreign or unreadable evidence as missing (no leak)', async () => {
    const tenant = newId();
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    // Foreign-tenant evidence.
    const foreign = await recordEvidence(member(tenantB));
    await expectCode('evidence_not_found', () =>
      dispatchDelivery(ctx, {
        destinationId,
        kind: 'findings.opportunities',
        records: BATCH,
        provenanceObservationIds: [foreign],
      }),
    );
    // Principal-scoped evidence of ANOTHER principal is unreadable here.
    const owner = member(tenant);
    const scoped = await recordEvidence(owner, [], 'principal');
    await expectCode('evidence_not_found', () =>
      dispatchDelivery(ctx, {
        destinationId,
        kind: 'findings.opportunities',
        records: BATCH,
        provenanceObservationIds: [scoped],
      }),
    );
    expect(await gateRequests(tenant)).toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });

  it('exports evidence readable by the dispatching principal (principal scope honored)', async () => {
    const tenant = newId();
    const owner = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const scoped = await recordEvidence(owner, [], 'principal');
    const plain = await recordEvidence(member(tenant));
    const result = await dispatchDelivery(owner, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      provenanceObservationIds: [scoped, plain],
    });
    expect(result.delivery.status).toBe('pending'); // gate holds; evidence passed
    expect(result.delivery.provenanceObservationIds).toEqual([scoped, plain]);
  });
});

// ---------------------------------------------------------------------------
// Provider independence + content constraints
// ---------------------------------------------------------------------------

describe('provider independence', () => {
  it('delivers the SAME canonical batch through warehouse/webhook/spreadsheet/API destinations', async () => {
    await allowExports(tenantProviders);
    const ctx = member(tenantProviders);
    const { destination: snowflake } = await registerDestination(ctx, {
      provider: 'snowflake',
      providerAccountId: 'acme-prod',
      authKind: 'credentials',
      credentialRef: 'secret-store://snowflake/acme',
    });
    const { destination: hook } = await registerDestination(ctx, {
      provider: 'webhook',
      providerAccountId: 'https://hooks.acme.com/aurum',
      authKind: 'credentials',
      credentialRef: 'secret-store://webhook/acme',
    });
    const { destination: sheets } = await registerDestination(ctx, {
      provider: 'google-sheets',
      providerAccountId: 'sheet-17',
      authKind: 'credentials',
      credentialRef: 'secret-store://sheets/acme',
    });
    const { destination: api } = await registerDestination(ctx, {
      provider: 'http-api',
      providerAccountId: 'https://api.acme.com/v1/exports',
      authKind: 'credentials',
      credentialRef: 'secret-store://api/acme',
    });

    const deliveries = [];
    for (const destination of [snowflake, hook, sheets, api]) {
      const result = await dispatchDelivery(ctx, {
        destinationId: destination.id,
        kind: 'findings.opportunities',
        records: BATCH,
      });
      expect(result.delivery.status).toBe('delivered');
      deliveries.push(result.delivery);
    }
    expect(transport.requests).toHaveLength(4);

    // Domain semantics identical across providers: same kind, same records —
    // only the provider key (and its opaque ids) differ.
    for (const delivery of deliveries) {
      expect(delivery.kind).toBe('findings.opportunities');
      expect(delivery.records).toEqual(BATCH);
      expect(delivery.status).toBe('delivered');
    }
    expect(new Set(deliveries.map((delivery) => delivery.provider))).toEqual(
      new Set(['snowflake', 'webhook', 'google-sheets', 'http-api']),
    );

    // The provider-specific envelopes differ per provider (adapter isolation).
    const [sfReq, hookReq, sheetsReq, apiReq] = transport.requests;
    expect(sfReq!.envelope.shape).toBe('rows');
    expect(sfReq!.envelope.body).toEqual({
      table: 'findings.opportunities',
      rows: [{ name: 'Expand to EU', value: 42000 }, { name: 'Renew ACME', value: 18000 }],
    });
    expect(hookReq!.envelope.shape).toBe('event');
    expect((hookReq!.envelope.body as Record<string, unknown>).event).toBe('findings.opportunities');
    expect(sheetsReq!.envelope.shape).toBe('rows');
    expect((sheetsReq!.envelope.body as Record<string, unknown>).values).toEqual([
      ['Expand to EU', 42000], // cell order: sorted field names (name, value)
      ['Renew ACME', 18000],
    ]);
    expect(apiReq!.envelope.shape).toBe('records');

    // The transport port stays provider-neutral: opaque references only.
    for (const request of transport.requests) {
      expect(request.credentialRef).toMatch(/^secret-store:\/\//);
      expect(request.providerAccountId.length).toBeGreaterThan(0);
      expect(request.attempt).toBe(1);
    }
  });

  it('structured providers reject non-object records BEFORE any gate request', async () => {
    const tenant = newId(); // fresh tenant: gate-count assertions stay exact
    const ctx = member(tenant); // default policy — gate would hold
    const { destination: snowflake } = await registerDestination(ctx, {
      provider: 'snowflake',
      providerAccountId: 'acme-prod-2',
      authKind: 'credentials',
      credentialRef: 'secret-store://snowflake/acme',
    });
    await expectCode('invalid_delivery_records', () =>
      dispatchDelivery(ctx, {
        destinationId: snowflake.id,
        kind: 'metrics.samples',
        records: [{ recordId: 'm-1', data: 42 }],
      }),
    );
    expect(await gateRequests(tenant)).toEqual([]); // nothing re-gated
    expect(transport.requests).toHaveLength(0);
    expect(await listDeliveries(ctx, {})).toEqual([]); // nothing recorded

    // Envelope-style providers accept the same data.
    const { destination: hook } = await registerDestination(ctx, {
      provider: 'http-api',
      providerAccountId: 'https://api.acme.com/v2/exports',
      authKind: 'credentials',
      credentialRef: 'secret-store://api/acme',
    });
    const result = await dispatchDelivery(ctx, {
      destinationId: hook.id,
      kind: 'metrics.samples',
      records: [{ recordId: 'm-1', data: 42 }],
    });
    expect(result.delivery.status).toBe('pending'); // default policy holds it
  });
});

// ---------------------------------------------------------------------------
// Transport outcomes: retries, failures, unavailability
// ---------------------------------------------------------------------------

describe('transport outcomes and retries', () => {
  it('a transient failure retries to delivery with append-only attempts', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    transport.script({ status: 'failed', providerDeliveryId: null, detail: 'connect timeout' });
    const first = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(first.delivery.status).toBe('failed');
    expect(first.attempt!.outcome).toBe('failed');
    expect(first.attempt!.detail).toBe('connect timeout');
    expect(first.attempt!.providerDeliveryId).toBeNull();

    advance(30);
    const retried = await retryDelivery(ctx, { deliveryId: first.delivery.id });
    expect(retried.attempt!.attemptNumber).toBe(2);
    expect(retried.attempt!.outcome).toBe('delivered');
    expect(retried.delivery.status).toBe('delivered');

    const attempts = await listDeliveryAttempts(ctx, { deliveryId: first.delivery.id });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'delivered']);
    // One gate request across the retry.
    expect(await gateRequests(tenant)).toHaveLength(1);
  });

  it('a thrown transport becomes a recorded failed attempt (transient)', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    transport.script(new Error('socket hang up'));
    const result = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(result.delivery.status).toBe('failed');
    expect(result.attempt!.outcome).toBe('failed');
    expect(result.attempt!.detail).toContain('socket hang up');

    const retried = await retryDelivery(ctx, { deliveryId: result.delivery.id });
    expect(retried.delivery.status).toBe('delivered');
  });

  it("a provider rejection is terminal — re-delivery needs a replay", async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    transport.script({ status: 'rejected', providerDeliveryId: null, detail: 'schema mismatch' });
    const result = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(result.delivery.status).toBe('rejected');
    await expectCode('delivery_not_retryable', () =>
      retryDelivery(ctx, { deliveryId: result.delivery.id }),
    );
    expect(transport.requests).toHaveLength(1);
  });

  it('no wired transport fails explicitly and stays retryable', async () => {
    await allowExports(tenantUnavailable);
    const ctx = member(tenantUnavailable);
    const destinationId = await registerWebhook(tenantUnavailable);
    setDestinationTransport(null);
    await expectCode('provider_unavailable', () =>
      dispatchDelivery(ctx, { destinationId, kind: 'findings.opportunities', records: BATCH }),
    );
    // The delivery exists, gated+approved, with NO attempt recorded.
    const [recorded] = await listDeliveries(ctx, {});
    expect(recorded).toBeDefined();
    const delivery = recorded!;
    expect(delivery.status).toBe('pending');
    expect(await listDeliveryAttempts(ctx, { deliveryId: delivery.id })).toEqual([]);
    expect(delivery.actionRequestId).not.toBeNull();

    setDestinationTransport(transport);
    const retried = await retryDelivery(ctx, { deliveryId: delivery.id });
    expect(retried.delivery.status).toBe('delivered');
    expect(retried.attempt!.attemptNumber).toBe(1);
  });

  it('a disabled destination refuses dispatch and retries', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    transport.script({ status: 'failed', providerDeliveryId: null, detail: 'boom' });
    const { delivery } = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(delivery.status).toBe('failed');
    await setDestinationStatus(ctx, { destinationId, status: 'disabled' });
    await expectCode('destination_disabled', () =>
      retryDelivery(ctx, { deliveryId: delivery.id }),
    );
    await expectCode('destination_disabled', () =>
      dispatchDelivery(ctx, { destinationId, kind: 'findings.opportunities', records: BATCH }),
    );
    expect(transport.requests).toHaveLength(1); // only the first attempt
  });
});

// ---------------------------------------------------------------------------
// OAuth / credentials isolation
// ---------------------------------------------------------------------------

describe('authorization state', () => {
  it('a lapsed OAuth grant fails dispatch fast (no transport call)', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const { destination } = await registerDestination(ctx, {
      provider: 'looker',
      providerAccountId: 'acme-looker',
      authKind: 'oauth',
      credentialRef: 'secret-store://looker/acme',
      oauthScopes: ['push.write'],
      oauthExpiresAt: '2026-09-14T09:00:00Z', // lapses at BASE_TIME + 1h
    });
    advance(2 * 3_600); // now past the grant
    await expectCode('destination_authorization_expired', () =>
      dispatchDelivery(ctx, { destinationId: destination.id, kind: 'metrics.samples', records: BATCH }),
    );
    expect(transport.requests).toHaveLength(0); // failed fast, no delivery attempted
  });

  it('a transport-reported grant refresh updates the recorded expiry', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const { destination } = await registerDestination(ctx, {
      provider: 'looker',
      providerAccountId: 'acme-looker-2',
      authKind: 'oauth',
      credentialRef: 'secret-store://looker/acme',
      oauthScopes: ['push.write'],
      oauthExpiresAt: '2026-09-14T09:00:00Z',
    });
    advance(1_800); // 08:30 — before the 09:00 expiry
    transport.script({
      status: 'delivered',
      providerDeliveryId: 'ack-refresh',
      detail: null,
      authorizationExpiresAt: '2026-09-21T09:00:00Z',
    });
    const delivered = await dispatchDelivery(ctx, {
      destinationId: destination.id,
      kind: 'metrics.samples',
      records: BATCH,
    });
    expect(delivered.delivery.status).toBe('delivered');
    expect((await getDestination(ctx, destination.id)).oauthExpiresAt).toBe(
      '2026-09-21T09:00:00.000Z',
    );
    advance(2 * 3_600); // past the ORIGINAL expiry, inside the refreshed one
    const second = await dispatchDelivery(ctx, {
      destinationId: destination.id,
      kind: 'metrics.samples',
      records: BATCH,
    });
    expect(second.delivery.status).toBe('delivered');
  });

  it('re-registration (re-authorization) unblocks a lapsed grant', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const { destination } = await registerDestination(ctx, {
      provider: 'looker',
      providerAccountId: 'acme-looker-3',
      authKind: 'oauth',
      credentialRef: 'secret-store://looker/acme',
      oauthScopes: ['push.write'],
      oauthExpiresAt: '2026-09-14T09:00:00Z',
    });
    advance(2 * 3_600);
    await expectCode('destination_authorization_expired', () =>
      dispatchDelivery(ctx, { destinationId: destination.id, kind: 'metrics.samples', records: BATCH }),
    );
    const reauthorized = await registerDestination(ctx, {
      provider: 'looker',
      providerAccountId: 'acme-looker-3',
      authKind: 'oauth',
      credentialRef: 'secret-store://looker/acme-v2',
      oauthScopes: ['push.write'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(reauthorized.created).toBe(false);
    const delivered = await dispatchDelivery(ctx, {
      destinationId: destination.id,
      kind: 'metrics.samples',
      records: BATCH,
    });
    expect(delivered.delivery.status).toBe('delivered');
  });

  it('credentials-authorized destinations reject transport-reported grant expiries loudly', async () => {
    const tenant = newId();
    await allowExports(tenant);
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    transport.script({
      status: 'delivered',
      providerDeliveryId: 'ack-x',
      detail: null,
      authorizationExpiresAt: '2027-01-01T00:00:00Z',
    });
    await expect(
      dispatchDelivery(ctx, { destinationId, kind: 'findings.opportunities', records: BATCH }),
    ).rejects.toThrow(/internal invariant violation/);
    // Nothing was recorded as delivered for the incoherent receipt.
    const [recorded] = await listDeliveries(ctx, {});
    expect(recorded).toBeDefined();
    expect(recorded!.status).toBe('pending');
    expect(await listDeliveryAttempts(ctx, { deliveryId: recorded!.id })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Replay (reprocessing)
// ---------------------------------------------------------------------------

describe('replay', () => {
  it('re-delivers recorded content as a NEW delivery under a FRESH full gate', async () => {
    const tenant = newId();
    const ctx = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const evidence = await recordEvidence(member(tenant));
    // Deliver the original through the human-approval path.
    const original = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      provenanceObservationIds: [evidence],
    });
    await decideApproval(approver(tenant), {
      requestId: original.delivery.actionRequestId!,
      decision: 'approve',
    });
    const pumped = await retryDelivery(ctx, { deliveryId: original.delivery.id });
    expect(pumped.delivery.status).toBe('delivered');
    expect(transport.requests).toHaveLength(1);

    // Replay: same content, fresh delivery, fresh gate authorization.
    const replayed = await replayDelivery(ctx, { deliveryId: original.delivery.id });
    expect(replayed.created).toBe(true);
    expect(replayed.delivery.id).not.toBe(original.delivery.id);
    expect(replayed.delivery.replayedFromId).toBe(original.delivery.id);
    expect(replayed.delivery.kind).toBe(original.delivery.kind);
    expect(replayed.delivery.records).toEqual(BATCH);
    expect(replayed.delivery.provenanceObservationIds).toEqual([evidence]);
    expect(replayed.delivery.status).toBe('pending'); // the fresh gate holds it
    expect(replayed.attempt).toBeNull();
    expect(transport.requests).toHaveLength(1); // nothing new left the system
    expect(await gateRequests(tenant)).toHaveLength(2);

    // The original is untouched by the replay.
    const stillOriginal = await getDelivery(ctx, { deliveryId: original.delivery.id });
    expect(stillOriginal.status).toBe('delivered');
    expect(await listDeliveryAttempts(ctx, { deliveryId: original.delivery.id })).toHaveLength(1);

    // The replay completes through its own approval.
    await decideApproval(approver(tenant), {
      requestId: replayed.delivery.actionRequestId!,
      decision: 'approve',
    });
    const completed = await retryDelivery(ctx, { deliveryId: replayed.delivery.id });
    expect(completed.delivery.status).toBe('delivered');
    expect(transport.requests).toHaveLength(2);
    expect(completed.attempt!.attemptNumber).toBe(1);
  });

  it('replay refuses recorded content whose evidence became non-exportable by policy', async () => {
    // Observations and their usage tags are immutable — but the REPLAY
    // runs with the CURRENT principal, and principal-scoped evidence of
    // another principal cannot be re-exported through a replay.
    const tenant = newId();
    const owner = member(tenant);
    const stranger = member(tenant);
    const destinationId = await registerWebhook(tenant);
    const scoped = await recordEvidence(owner, [], 'principal');
    await allowExports(tenant);
    const original = await dispatchDelivery(owner, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      provenanceObservationIds: [scoped],
    });
    expect(original.delivery.status).toBe('delivered');
    await expectCode('evidence_not_found', () =>
      replayDelivery(stranger, { deliveryId: original.delivery.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Provenance and audit reads
// ---------------------------------------------------------------------------

describe('provenance and audit reads', () => {
  it('exposes the delivery ledger and the attempt trail with full provenance', async () => {
    await allowExports(tenantProvenance);
    const ctx = member(tenantProvenance);
    const requester = member(tenantProvenance);
    const destinationId = await registerWebhook(tenantProvenance);
    const evidence = await recordEvidence(member(tenantProvenance));
    advance(10);
    const { delivery, attempt } = await dispatchDelivery(requester, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      provenanceObservationIds: [evidence],
      idempotencyKey: 'export-audit-001',
    });
    expect(delivery.requestedBy).toBe(requester.principalId);
    expect(delivery.idempotencyKey).toBe('export-audit-001');

    const read = await getDelivery(ctx, { deliveryId: delivery.id });
    expect(read).toEqual(delivery);

    // The attempt is the physical audit: envelope + outcome + timing.
    expect(attempt!.envelope.shape).toBe('event');
    expect((attempt!.envelope.body as Record<string, unknown>).event).toBe('findings.opportunities');
    expect(attempt!.startedAt).toBe(new Date(BASE_TIME + 10_000).toISOString());
    expect(attempt!.completedAt).toBe(attempt!.startedAt);

    // Ledger reads filter and order.
    expect(await listDeliveries(ctx, { destinationId })).toHaveLength(1);
    expect(await listDeliveries(ctx, { status: 'delivered' })).toHaveLength(1);
    expect(await listDeliveries(ctx, { status: 'pending' })).toHaveLength(0);
    expect(await listDeliveries(ctx, { provider: 'webhook' })).toHaveLength(1);
    expect(await listDeliveries(ctx, { kind: 'findings.opportunities' })).toHaveLength(1);
    expect(await listDeliveries(ctx, { kind: 'metrics.samples' })).toHaveLength(0);
    expect(await listDeliveries(ctx, { destinationId: newId() })).toHaveLength(0);

    await expectCode('delivery_not_found', () => getDelivery(ctx, { deliveryId: newId() }));
    await expectCode('delivery_not_found', () =>
      listDeliveryAttempts(ctx, { deliveryId: newId() }),
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0009 — destinations never become domain truth
// ---------------------------------------------------------------------------

describe('never domain truth', () => {
  it('no destinations operation records an observation', async () => {
    await allowExports(tenantTruth);
    const ctx = member(tenantTruth);
    const destinationId = await registerWebhook(tenantTruth);
    const first = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'truth-1',
    });
    expect(first.delivery.status).toBe('delivered');
    const second = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'truth-2',
    });
    expect(second.delivery.status).toBe('delivered');
    // A transient failure plus its retry — the full retry lifecycle.
    transport.script({ status: 'failed', providerDeliveryId: null, detail: 'x' });
    const third = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'truth-3',
    });
    expect(third.delivery.status).toBe('failed');
    const recovered = await retryDelivery(ctx, { deliveryId: third.delivery.id });
    expect(recovered.delivery.status).toBe('delivered');
    // And a replay of recorded content.
    const replayed = await replayDelivery(ctx, { deliveryId: first.delivery.id });
    expect(replayed.delivery.replayedFromId).toBe(first.delivery.id);

    // Full lifecycle exercised — and ZERO evidence was minted from it.
    expect(await listObservations(ctx, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation sweep
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it("another tenant's destinations, deliveries and operations are invisible", async () => {
    await allowExports(tenantIsolation);
    const ctxA = member(tenantIsolation);
    const destinationId = await registerWebhook(tenantIsolation);
    const { delivery } = await dispatchDelivery(ctxA, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(delivery.status).toBe('delivered');

    const b = member(tenantB);
    await expectCode('destination_not_found', () => getDestination(b, destinationId));
    await expectCode('destination_not_found', () =>
      setDestinationStatus(b, { destinationId, status: 'disabled' }),
    );
    await expectCode('destination_not_found', () =>
      dispatchDelivery(b, { destinationId, kind: 'findings.opportunities', records: BATCH }),
    );
    await expectCode('delivery_not_found', () => getDelivery(b, { deliveryId: delivery.id }));
    await expectCode('delivery_not_found', () =>
      retryDelivery(b, { deliveryId: delivery.id }),
    );
    await expectCode('delivery_not_found', () =>
      replayDelivery(b, { deliveryId: delivery.id }),
    );
    await expectCode('delivery_not_found', () =>
      listDeliveryAttempts(b, { deliveryId: delivery.id }),
    );
    expect(await listDeliveries(b, {})).toEqual([]);
    expect(await listDestinations(b, {})).toEqual([]);

    // The wired transport is shared infrastructure; tenant A's delivery
    // under tenant B's context never reaches it.
    const requestsBefore = transport.requests.length;
    await expectCode('destination_not_found', () =>
      dispatchDelivery(b, { destinationId, kind: 'findings.opportunities', records: BATCH }),
    );
    expect(transport.requests.length).toBe(requestsBefore);
    // And no foreign gate request was minted.
    expect(await gateRequests(tenantB)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('the destinations table rejects credentials rows with OAuth state (CHECK)', async () => {
    await expect(
      getDb().query(
        `INSERT INTO destinations (
           tenant_id, provider, provider_account_id, auth_kind, credential_ref,
           oauth_scopes, oauth_expires_at, created_by
         ) VALUES ($1, 'webhook', 'k', 'credentials', 'r', '["push"]'::jsonb, NULL, $2)`,
        [tenantStorage, member(tenantStorage).principalId],
      ),
    ).rejects.toThrow(/destinations_credentials_have_no_oauth_state/);
  });

  it('the delivery ledger is append-only with a forward-only lifecycle', async () => {
    await allowExports(tenantStorage);
    const ctx = member(tenantStorage);
    const destinationId = await registerWebhook(tenantStorage);
    const { delivery } = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(delivery.status).toBe('delivered');

    // Substantive fields are immutable.
    await expect(
      getDb().query(`UPDATE destination_deliveries SET kind = 'tampered' WHERE id = $1`, [
        delivery.id,
      ]),
    ).rejects.toThrow(/append-only outbound ledger/);
    await expect(
      getDb().query(`UPDATE destination_deliveries SET records = '[]'::jsonb WHERE id = $1`, [
        delivery.id,
      ]),
    ).rejects.toThrow(/append-only outbound ledger/);
    // The lifecycle never regresses.
    await expect(
      getDb().query(
        `UPDATE destination_deliveries SET status = 'pending' WHERE id = $1`,
        [delivery.id],
      ),
    ).rejects.toThrow(/move forward only/);
    await expect(
      getDb().query(`UPDATE destination_deliveries SET status = 'failed' WHERE id = $1`, [
        delivery.id,
      ]),
    ).rejects.toThrow(/move forward only/);
    // DELETE and TRUNCATE are forbidden outright.
    await expect(
      getDb().query(`DELETE FROM destination_deliveries WHERE id = $1`, [delivery.id]),
    ).rejects.toThrow(/append-only outbound ledger/);
    await expect(getDb().query(`TRUNCATE destination_deliveries`)).rejects.toThrow(
      /append-only outbound ledger/,
    );

    // Forward transitions ARE legal at the storage level (the service's
    // only updates): a pending row may resolve.
    const pending = await dispatchDelivery(member(tenantStorage), {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
      idempotencyKey: 'storage-forward-1',
    });
    expect(pending.delivery.status).toBe('delivered'); // policy-allowed → immediate
    await expect(
      getDb().query(`UPDATE destination_deliveries SET status = 'failed' WHERE id = $1`, [
        pending.delivery.id,
      ]),
    ).rejects.toThrow(/move forward only/); // delivered is terminal even in SQL
  });

  it('attempts are strictly append-only', async () => {
    await allowExports(tenantStorage);
    const ctx = member(tenantStorage);
    const destinationId = await registerWebhook(tenantStorage);
    const { delivery } = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    const attemptId = (await listDeliveryAttempts(ctx, { deliveryId: delivery.id }))[0]!.id;
    await expect(
      getDb().query(`UPDATE destination_delivery_attempts SET outcome = 'failed' WHERE id = $1`, [
        attemptId,
      ]),
    ).rejects.toThrow(/append-only delivery audit/);
    await expect(
      getDb().query(`DELETE FROM destination_delivery_attempts WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/append-only delivery audit/);
    await expect(getDb().query(`TRUNCATE destination_delivery_attempts`)).rejects.toThrow(
      /append-only delivery audit/,
    );
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serialization', () => {
  it('a concurrent attempt on the same delivery fails explicitly', async () => {
    await allowExports(tenantBusy);
    const ctx = member(tenantBusy);
    const destinationId = await registerWebhook(tenantBusy);
    transport.script({ status: 'failed', providerDeliveryId: null, detail: 'first try failed' });
    const { delivery } = await dispatchDelivery(ctx, {
      destinationId,
      kind: 'findings.opportunities',
      records: BATCH,
    });
    expect(delivery.status).toBe('failed');

    const lock = getLock();
    const key = `destinations:deliver:${delivery.id}`;
    const token = await lock.acquire(key, 5_000);
    expect(token).not.toBeNull();
    try {
      await expectCode('delivery_busy', () => retryDelivery(ctx, { deliveryId: delivery.id }));
      expect((await listDeliveryAttempts(ctx, { deliveryId: delivery.id })).length).toBe(1);
    } finally {
      await lock.release(key, token!);
    }
    const retried = await retryDelivery(ctx, { deliveryId: delivery.id });
    expect(retried.delivery.status).toBe('delivered');
    expect(retried.attempt!.attemptNumber).toBe(2);
    // One gate request across the whole busy/retry lifecycle.
    expect(await gateRequests(tenantBusy)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Contract surface sanity
// ---------------------------------------------------------------------------

describe('contract surface', () => {
  it('exposes the transport port and no default transport is wired', async () => {
    // The beforeEach of each test wires a fresh scripted transport; the
    // afterEach unwinds it. Between tests the default state is "none".
    expect(getDestinationTransport()).toBe(transport); // wired for THIS test
    setDestinationTransport(null);
    expect(getDestinationTransport()).toBeNull();
  });
});
