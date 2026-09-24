// Integration tests for the connection-broker module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W082
// acceptance: "connect/revoke/refresh; webhook/sync checkpoints; provider
// outages are localized; credential values never enter domain state;
// broker replacement does not change domain contracts."
//
//  * lifecycle — initiate (pending + hand-off), complete (grant lands,
//    opaque references only), refresh (grant rotation, bound connectors
//    re-registered), revoke (broker-side destruction FIRST, connectors
//    disabled), re-initiation after revocation, state-machine refusals,
//    explicit `broker_unavailable` when nothing is wired;
//  * bindings — W036/W037/W081 bindings validated through the owning
//    contracts (existence + provider match), the sources re-authorization
//    path driven by connect/refresh, connector disabling on revoke;
//  * sync checkpoints — claim-then-checkpoint, dedupe on re-pulls, failed
//    pulls leave the cursor unchanged, exhausted windows keep the last
//    cursor, replay rewinds under dedupe with an audited history;
//  * webhooks — broker envelopes parsed by the private adapters, ledger
//    dedupe on redelivery, forward-only watermark, cross-tenant resolution
//    uniformly not-found;
//  * outage localization — failures become canonical `broker_failure`
//    carrying the normalized failure + append-only health evidence for
//    exactly one (provider, broker) pair; OTHER providers keep working;
//    the cooldown gate fast-fails sync without touching state; refresh is
//    the ungated healing path; operator overrides are claim-gated;
//  * credential isolation — token values inside scripted broker responses
//    never reach a connection row, a contract result or a bound connector;
//  * broker replacement — connections route through their RECORDED broker
//    (unwiring it is explicit), new connections follow the active one, and
//    verifyBrokerHotSwap proves the same canonical request through two
//    different brokers (equivalent / divergent / failed outcomes), recorded
//    append-only plus the canonical W089 evidence record;
//  * the sources composition bridge — broker-backed pulls become
//    observations through W036's own polling contract;
//  * tenant isolation + storage discipline (append-only tables, guarded
//    checkpoint state).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { listObservations } from '@/modules/observations/contract';
import {
  getSource,
  pollSource,
  registerSource,
  setSourceStatus,
  setSourceTransport,
  type Source,
  type SourceProvider,
} from '@/modules/sources/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { ConnectionBrokerError } from '../errors';
import { createEmbeddedBroker } from '../adapters/embedded';
import { createNangoBroker } from '../adapters/nango';
import type {
  BrokerHttpClient,
  BrokerHttpRequest,
  BrokerHttpResponse,
  BrokerProvider,
  ConnectionBroker,
} from '../types';
import * as brokerContract from '../contract';

const {
  completeConnection,
  createBrokerSourceTransport,
  getConnection,
  getConnectionCheckpoint,
  getProviderHealth,
  getWiredBrokers,
  initiateConnection,
  listCheckpointHistory,
  listConnectionEvents,
  listConnections,
  listHotSwapVerifications,
  listProviderHealth,
  listWiredBrokers,
  receiveBrokerWebhook,
  refreshConnection,
  replayConnectionCheckpoint,
  revokeConnection,
  runConnectionSync,
  setProviderHealth,
  verifyBrokerHotSwap,
  wireConnectionBrokers,
} = brokerContract;

// ---------------------------------------------------------------------------
// The scripted broker backend — ONE http client speaking BOTH dialects
// ---------------------------------------------------------------------------

interface ScriptedWindow {
  records: { id: string; kind: string; occurredAt: string; data: unknown }[];
  nextCursor: string | null;
  hasMore?: boolean;
}

/**
 * A fake managed-broker server implementing the nango AND embedded wire
 * dialects over the shared BrokerHttpClient port, with scriptable sync
 * windows and failures. All its times derive from the test clock so
 * cooldown/expiry behavior is deterministic.
 */
class ScriptedBrokerBackend implements BrokerHttpClient {
  readonly requests: BrokerHttpRequest[] = [];
  /** Fake token material the nango metadata response carries — assembled from fragments at runtime. */
  readonly nangoAccessToken = ['nango_at_', 'svc', '_plain'].join('');
  readonly nangoRefreshToken = ['nango_rt_', 'svc', '_plain'].join('');
  readonly nangoConnections = new Map<
    string,
    { provider: string; accountId: string; scopes: string[]; expiresAt: string; revoked: boolean }
  >();
  readonly embAuthorizations = new Map<string, { state: string; provider: string }>();
  readonly embConnections = new Map<
    string,
    { provider: string; accountId: string; credentialRef: string; scopes: string[]; expiresAt: string; revoked: boolean }
  >();
  grantTtlMs = 3_600_000;
  private readonly syncQueues = new Map<string, (ScriptedWindow | { __status: number } | Error)[]>();
  private counter = 0;
  /** Unique per backend instance so account ids never collide across tests (the DB persists). */
  private readonly instanceTag = Math.random().toString(36).slice(2, 8);

  constructor(private readonly nowProvider: () => Date) {}

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString().padStart(3, '0')}`;
  }

  /** Seed the nango-side metadata for one domain connection id. */
  seedNangoConnection(connectionId: string, provider: string, accountId: string, scopes: string[] = []): void {
    this.nangoConnections.set(connectionId, {
      provider,
      accountId,
      scopes,
      expiresAt: new Date(this.nowProvider().getTime() + this.grantTtlMs).toISOString(),
      revoked: false,
    });
  }

  /** Force a grant expiry on either dialect's connection (lapse testing). */
  forceExpiry(brokerKey: 'nango' | 'embedded', connectionId: string, expiresAt: string | null): void {
    if (brokerKey === 'nango') {
      const entry = this.nangoConnections.get(connectionId);
      if (entry !== undefined && expiresAt !== null) entry.expiresAt = expiresAt;
    } else {
      const entry = this.embConnections.get(connectionId);
      if (entry !== undefined && expiresAt !== null) entry.expiresAt = expiresAt;
    }
  }

  /** Queue sync windows (canonical form; shaped per dialect on serve). */
  scriptSync(brokerKey: 'nango' | 'embedded', brokerConnectionId: string, ...windows: (ScriptedWindow | { __status: number } | Error)[]): void {
    const queue = this.syncQueues.get(`${brokerKey}:${brokerConnectionId}`) ?? [];
    queue.push(...windows);
    this.syncQueues.set(`${brokerKey}:${brokerConnectionId}`, queue);
  }

  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
    this.requests.push(request);
    const url = `${request.path}?${new URLSearchParams(
      Object.entries(request.query ?? {}).map(([key, value]) => [key, String(value)]),
    ).toString()}`;

    // --- nango dialect -----------------------------------------------------
    const nangoConnection = /^\/connection\/([^/]+)$/.exec(request.path);
    if (request.method === 'GET' && nangoConnection !== null) {
      const id = decodeURIComponent(nangoConnection[1]!);
      const entry = this.nangoConnections.get(id);
      if (entry === undefined || entry.revoked) {
        return { status: 404, body: { error: `connection not found: ${id}` } };
      }
      return {
        status: 200,
        body: {
          connection_id: id,
          provider_config_key: entry.provider,
          connection_config: { account_id: entry.accountId },
          credentials: {
            type: 'OAUTH2',
            access_token: this.nangoAccessToken,
            refresh_token: this.nangoRefreshToken,
            expires_at: entry.expiresAt,
            scopes: entry.scopes,
          },
        },
      };
    }
    if (request.method === 'POST' && request.path === '/connection/refresh') {
      const body = request.body as { connection_id?: string };
      const entry = this.nangoConnections.get(body.connection_id ?? '');
      if (entry === undefined || entry.revoked) {
        return { status: 404, body: { error: 'connection not found' } };
      }
      // A refresh ADVANCES the grant expiry (never rewinds it).
      entry.expiresAt = new Date(Date.parse(entry.expiresAt) + this.grantTtlMs).toISOString();
      return { status: 200, body: {} };
    }
    const nangoDelete = /^\/connection\/([^/]+)$/.exec(request.path);
    if (request.method === 'DELETE' && nangoDelete !== null) {
      const entry = this.nangoConnections.get(decodeURIComponent(nangoDelete[1]!));
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      entry.revoked = true;
      return { status: 200, body: {} };
    }
    const nangoSync = /^\/sync\/([^/]+)\/records$/.exec(request.path);
    if (request.method === 'GET' && nangoSync !== null) {
      const outcome = this.consumeSync('nango', decodeURIComponent(nangoSync[1]!));
      if (outcome === null) return { status: 200, body: { records: [], nextCursor: null } };
      if (outcome instanceof Error) throw outcome;
      if ('__status' in outcome) return { status: outcome.__status, body: { error: 'scripted failure' } };
      return {
        status: 200,
        body: {
          records: outcome.records.map((record) => ({
            id: record.id,
            kind: record.kind,
            occurredAt: record.occurredAt,
            data: record.data,
          })),
          nextCursor: outcome.nextCursor,
        },
      };
    }

    // --- embedded dialect --------------------------------------------------
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string; provider?: string };
      const state = this.nextId('st');
      this.embAuthorizations.set(body.connection_id ?? '', { state, provider: body.provider ?? '' });
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.unit.example/oauth/${state}`,
          state,
          expires_at: new Date(this.nowProvider().getTime() + 900_000).toISOString(),
        },
      };
    }
    const embCallback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && embCallback !== null) {
      const domainConnectionId = decodeURIComponent(embCallback[1]!);
      const authorization = this.embAuthorizations.get(domainConnectionId);
      const body = request.body as { state?: string };
      if (authorization === undefined || body.state !== authorization.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      const embId = this.nextId('emb');
      const provider = authorization.provider as BrokerProvider;
      const accountId = `eacct-${this.instanceTag}-${embId}`;
      const expiresAt = new Date(this.nowProvider().getTime() + this.grantTtlMs).toISOString();
      this.embConnections.set(embId, {
        provider,
        accountId,
        credentialRef: `embedded-connection:${embId}`,
        scopes: [],
        expiresAt,
        revoked: false,
      });
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: accountId,
          credential_ref: `embedded-connection:${embId}`,
          scopes: [],
          expires_at: expiresAt,
        },
      };
    }
    const embRefresh = /^\/v1\/connections\/([^/]+)\/refresh$/.exec(request.path);
    if (request.method === 'POST' && embRefresh !== null) {
      const entry = this.embConnections.get(decodeURIComponent(embRefresh[1]!));
      if (entry === undefined || entry.revoked) {
        return { status: 404, body: { error: 'connection not found' } };
      }
      // A refresh ADVANCES the grant expiry (never rewinds it).
      entry.expiresAt = new Date(Date.parse(entry.expiresAt) + this.grantTtlMs).toISOString();
      return {
        status: 200,
        body: {
          credential_ref: entry.credentialRef,
          provider_account_id: entry.accountId,
          scopes: entry.scopes,
          expires_at: entry.expiresAt,
        },
      };
    }
    const embDelete = /^\/v1\/connections\/([^/]+)$/.exec(request.path);
    if (request.method === 'DELETE' && embDelete !== null) {
      const entry = this.embConnections.get(decodeURIComponent(embDelete[1]!));
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      entry.revoked = true;
      return { status: 204, body: null };
    }
    const embRecords = /^\/v1\/connections\/([^/]+)\/records$/.exec(request.path);
    if (request.method === 'GET' && embRecords !== null) {
      const outcome = this.consumeSync('embedded', decodeURIComponent(embRecords[1]!));
      if (outcome === null) return { status: 200, body: { records: [], next_cursor: null, has_more: false } };
      if (outcome instanceof Error) throw outcome;
      if ('__status' in outcome) return { status: outcome.__status, body: { error: 'scripted failure' } };
      return {
        status: 200,
        body: {
          records: outcome.records.map((record) => ({
            id: record.id,
            kind: record.kind,
            occurred_at: record.occurredAt,
            data: record.data,
          })),
          next_cursor: outcome.nextCursor,
          has_more: outcome.hasMore ?? outcome.nextCursor !== null,
        },
      };
    }

    return { status: 404, body: { error: `no scripted route for ${request.method} ${url}` } };
  }

  private consumeSync(brokerKey: 'nango' | 'embedded', brokerConnectionId: string): ScriptedWindow | { __status: number } | Error | null {
    const queue = this.syncQueues.get(`${brokerKey}:${brokerConnectionId}`);
    if (queue === undefined || queue.length === 0) return null;
    return queue.shift()!;
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let clockMs = Date.parse('2026-09-23T12:00:00Z');
let backend: ScriptedBrokerBackend;
let nango: ConnectionBroker;
let embedded: ConnectionBroker;

const tenantLifecycle = newId();
const tenantBindings = newId();
const tenantSync = newId();
const tenantWebhook = newId();
const tenantOutageA = newId();
const tenantOutageB = newId();
const tenantOutageC = newId();
const tenantOutageD = newId();
const tenantOutageE = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantBridge = newId();
const tenantSwap = newId();
const tenantB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['connection-broker:administer'] };
}

async function expectCode(
  code: ConnectionBrokerError['code'],
  fn: () => Promise<unknown>,
): Promise<ConnectionBrokerError> {
  try {
    await fn();
    throw new Error(`expected ConnectionBrokerError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ConnectionBrokerError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

/** Connects one nango-backed connection for the tenant (the happy path). */
async function connectNango(
  ctx: TenantContext,
  provider: BrokerProvider,
  connectionKey: string,
  accountId: string,
): Promise<{ connectionId: string; brokerConnectionId: string }> {
  const initiated = await initiateConnection(ctx, {
    provider,
    connectionKey,
    scopes: ['read'],
  });
  backend.seedNangoConnection(initiated.connection.id, provider, accountId, ['read']);
  const completed = await completeConnection(ctx, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return {
    connectionId: completed.connection.id,
    brokerConnectionId: completed.connection.brokerConnectionId!,
  };
}

/** Connects one embedded-backed connection (requires embedded to be ACTIVE). */
async function connectEmbedded(
  ctx: TenantContext,
  provider: BrokerProvider,
  connectionKey: string,
): Promise<{ connectionId: string; brokerConnectionId: string }> {
  const initiated = await initiateConnection(ctx, { provider, connectionKey, scopes: [] });
  const completed = await completeConnection(ctx, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return {
    connectionId: completed.connection.id,
    brokerConnectionId: completed.connection.brokerConnectionId!,
  };
}

function rec(id: string, kind = 'crm.contact.updated', occurredAt = '2026-09-23T11:00:00Z') {
  return { id, kind, occurredAt, data: { recordId: id } };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  clockMs = Date.parse('2026-09-23T12:00:00Z');
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  backend = new ScriptedBrokerBackend(() => new Date(clockMs));
  nango = createNangoBroker({
    baseUrl: 'https://nango.unit.example',
    // Fake Nango instance secret — assembled from fragments at runtime.
    secretKey: ['nango_sk_live_', 'it', '_fragment'].join(''),
    httpClient: backend,
  });
  embedded = createEmbeddedBroker({
    baseUrl: 'https://broker.unit.example',
    apiToken: ['embedded_tok_', 'it', '_fragment'].join(''),
    httpClient: backend,
  });
  wireConnectionBrokers([nango, embedded]);
});

afterEach(() => {
  wireConnectionBrokers(null);
  setSourceTransport(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Lifecycle: connect / refresh / revoke (the OAuth/token core)
// ---------------------------------------------------------------------------

describe('connection-broker service — lifecycle', () => {
  it('refuses every operation explicitly when no broker is wired', async () => {
    wireConnectionBrokers(null);
    const ctx = member(tenantLifecycle);
    await expectCode('broker_unavailable', () =>
      initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'hs-1' }),
    );
    expect(listWiredBrokers()).toEqual([]);
    expect(getWiredBrokers()).toEqual([]);
  });

  it('initiate → pending connection with the authorization hand-off, audited', async () => {
    const ctx = member(tenantLifecycle);
    const result = await initiateConnection(ctx, {
      provider: 'hubspot',
      connectionKey: 'hs-main',
      displayName: 'HubSpot main',
      scopes: ['crm.objects.read', 'crm.objects.write'],
      redirectTo: 'https://aurum.example/connected',
    });
    const connection = result.connection;
    expect(connection.status).toBe('pending');
    expect(connection.broker).toBe('nango');
    expect(connection.credentialRef).toBeNull();
    expect(connection.brokerConnectionId).toBeNull();
    expect(connection.requestedScopes).toEqual(['crm.objects.read', 'crm.objects.write']);
    expect(result.authorization.authorizationUrl).toMatch(/^https:\/\/nango\.unit\.example\/oauth\/connect\?/);
    expect(result.authorization.state).toBe(connection.id);
    expect(result.authorization.expiresAt).toBeTruthy();
    const events = await listConnectionEvents(ctx, { connectionId: connection.id });
    expect(events.map((event) => event.event)).toEqual(['connect_initiated']);
  });

  it('complete → connected with the opaque grant; refresh rotates it; the state machine refuses wrong transitions', async () => {
    const ctx = member(tenantLifecycle);
    const initiated = await initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'hs-2', scopes: ['read'] });
    const connectionId = initiated.connection.id;

    // A forged state token cannot complete someone else's handshake.
    await expectCode('connection_invalid_state', () => completeConnection(ctx, { connectionId, state: 'forged' }));

    backend.seedNangoConnection(connectionId, 'hubspot', 'acct-77', ['crm.objects.read']);
    const completed = await completeConnection(ctx, { connectionId, state: initiated.authorization.state });
    const connection = completed.connection;
    expect(connection.status).toBe('connected');
    expect(connection.brokerConnectionId).toBe(connectionId); // nango: the domain id doubles as the broker id
    expect(connection.providerAccountId).toBe('acct-77');
    expect(connection.credentialRef).toBe(`nango-connection:${connectionId}`);
    expect(connection.oauthScopes).toEqual(['crm.objects.read']);
    expect(connection.oauthExpiresAt).toBeTruthy();
    expect(connection.authorizationState).toBeNull();
    // Credential isolation: no token fragment anywhere on the connection.
    expect(JSON.stringify(connection)).not.toContain('nango_at_');
    expect(JSON.stringify(connection)).not.toContain('nango_rt_');

    // Completing an already-connected connection refuses.
    await expectCode('connection_invalid_state', () =>
      completeConnection(ctx, { connectionId, state: initiated.authorization.state }),
    );
    // Initiating over a connected key refuses (revoke first).
    await expectCode('connection_conflict', () =>
      initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'hs-2' }),
    );

    const before = connection.oauthExpiresAt!;
    const refreshed = await refreshConnection(ctx, { connectionId });
    expect(Date.parse(refreshed.connection.oauthExpiresAt!)).toBeGreaterThan(Date.parse(before));
    expect(refreshed.connection.lastRefreshedAt).toBeTruthy();
    // The credential reference is STABLE across refreshes — token rotation
    // is broker-internal; only non-secret state moves.
    expect(refreshed.connection.credentialRef).toBe(connection.credentialRef);

    const events = await listConnectionEvents(ctx, { connectionId });
    expect(events.map((event) => event.event).sort()).toEqual(['connect_initiated', 'connected', 'refreshed']);
  });

  it('an expired authorization hand-off marks the connection failed and demands re-initiation', async () => {
    const ctx = member(tenantLifecycle);
    const initiated = await initiateConnection(ctx, { provider: 'stripe', connectionKey: 'st-1' });
    // Advance past the 15-minute hand-off window.
    clockMs += 16 * 60_000;
    const error = await expectCode('connection_authorization_expired', () =>
      completeConnection(ctx, { connectionId: initiated.connection.id, state: initiated.authorization.state }),
    );
    expect(error.message).toContain('re-initiate');
    const parked = await getConnection(ctx, { connectionId: initiated.connection.id });
    expect(parked.status).toBe('failed');
    const events = await listConnectionEvents(ctx, { connectionId: initiated.connection.id });
    expect(events.map((event) => event.event)).toContain('connect_failed');
    clockMs -= 16 * 60_000;
  });

  it('revoke destroys the grant broker-side FIRST, parks the connection and audits it', async () => {
    const ctx = member(tenantLifecycle);
    const { connectionId } = await connectNango(ctx, 'stripe', 'st-2', 'acct-st');
    const revoked = await revokeConnection(ctx, { connectionId, note: 'offboarding' });
    expect(revoked.connection.status).toBe('revoked');
    expect(revoked.connection.revokedBy).toBe(ctx.principalId);
    expect(revoked.connection.revocationNote).toBe('offboarding');
    expect(revoked.connection.revokedAt).toBeTruthy();
    // The broker-side connection is really gone (the backend marked it
    // revoked when the DELETE landed — the domain only parks the row AFTER
    // that call succeeded).
    expect(backend.nangoConnections.get(connectionId)?.revoked).toBe(true);
    await expectCode('connection_invalid_state', () => revokeConnection(ctx, { connectionId }));
    // Operations refuse on a revoked connection.
    await expectCode('connection_invalid_state', () => refreshConnection(ctx, { connectionId }));
    await expectCode('connection_invalid_state', () => runConnectionSync(ctx, { connectionId }));
  });

  it('re-initiating a revoked or failed key re-issues the hand-off on the same row identity', async () => {
    const ctx = member(tenantLifecycle);
    const { connectionId } = await connectNango(ctx, 'stripe', 'st-3', 'acct-st3');
    await revokeConnection(ctx, { connectionId });
    const reissued = await initiateConnection(ctx, { provider: 'stripe', connectionKey: 'st-3' });
    expect(reissued.connection.id).toBe(connectionId);
    expect(reissued.connection.status).toBe('pending');
    expect(reissued.connection.revokedAt).toBeNull();
    // And it can complete again (a fresh grant).
    backend.seedNangoConnection(connectionId, 'stripe', 'acct-st3', []);
    const completed = await completeConnection(ctx, { connectionId, state: reissued.authorization.state });
    expect(completed.connection.status).toBe('connected');
  });

  it('a second connection for the same provider account is an explicit conflict', async () => {
    const ctx = member(tenantLifecycle);
    await connectNango(ctx, 'jira', 'jr-1', 'acct-dup');
    const initiated = await initiateConnection(ctx, { provider: 'jira', connectionKey: 'jr-2' });
    backend.seedNangoConnection(initiated.connection.id, 'jira', 'acct-dup', []);
    await expectCode('connection_conflict', () =>
      completeConnection(ctx, { connectionId: initiated.connection.id, state: initiated.authorization.state }),
    );
    const conflict = await getConnection(ctx, { connectionId: initiated.connection.id });
    expect(conflict.status).toBe('failed');
  });

  it('lists connections with filters and validates inputs loudly', async () => {
    const ctx = member(tenantLifecycle);
    await connectNango(ctx, 'linear', 'ln-1', 'acct-ln');
    const listed = await listConnections(ctx, { provider: 'linear' });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider).toBe('linear');
    const byStatus = await listConnections(ctx, { status: 'connected' });
    expect(byStatus.length).toBeGreaterThanOrEqual(1);
    await expect(listConnections(ctx, { provider: 'sap' as unknown as BrokerProvider })).rejects.toThrowError(
      /provider must be one of/,
    );
    await expectCode('connection_not_found', () => getConnection(ctx, { connectionId: 'not-a-uuid' }));
    await expectCode('connection_not_found', () => getConnection(ctx, { connectionId: newId() }));
  });
});

// ---------------------------------------------------------------------------
// Bindings: the W036/W037/W081 gateway integration
// ---------------------------------------------------------------------------

describe('connection-broker service — gateway bindings', () => {
  async function registerPlaceholderSource(ctx: TenantContext, provider: SourceProvider, accountId: string): Promise<Source> {
    const registration = await registerSource(ctx, {
      provider,
      providerAccountId: accountId,
      authKind: 'credentials',
      // Fake placeholder credential — assembled from fragments at runtime.
      credentialRef: ['secret-store://', provider, '/placeholder'].join(''),
    });
    return registration.source;
  }

  it('validates bindings through the owning contracts BEFORE any broker interaction', async () => {
    const ctx = member(tenantBindings);
    await expectCode('invalid_input', () =>
      initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'hs-b1', bindSourceId: newId() }),
    );
    const foreignProvider = await registerPlaceholderSource(ctx, 'stripe', 'acct-fp');
    await expectCode('invalid_input', () =>
      initiateConnection(ctx, {
        provider: 'hubspot',
        connectionKey: 'hs-b2',
        bindSourceId: foreignProvider.id,
      }),
    );
    await expectCode('invalid_input', () =>
      initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'hs-b3', inventorySystemId: newId() }),
    );
    await expectCode('invalid_input', () =>
      initiateConnection(ctx, { provider: 'looker', connectionKey: 'lk-b1', bindDestinationId: newId() }),
    );
  });

  it('completion drives the sources re-authorization path; refresh moves it; revoke disables the connector', async () => {
    const ctx = member(tenantBindings);
    const source = await registerPlaceholderSource(ctx, 'hubspot', '24015501');
    const initiated = await initiateConnection(ctx, {
      provider: 'hubspot',
      connectionKey: 'hs-bound',
      bindSourceId: source.id,
      scopes: ['crm.objects.read'],
    });
    backend.seedNangoConnection(initiated.connection.id, 'hubspot', '24015501', ['crm.objects.read']);
    const completed = await completeConnection(ctx, {
      connectionId: initiated.connection.id,
      state: initiated.authorization.state,
    });

    // The bound connector was re-registered through the sources contract:
    // OAuth-kind authorization, the BROKER-issued opaque credential
    // reference, the granted scopes and the grant expiry — no token value.
    const reauthorized = await getSource(ctx, source.id);
    expect(reauthorized.authKind).toBe('oauth');
    expect(reauthorized.credentialRef).toBe(completed.connection.credentialRef);
    expect(reauthorized.oauthScopes).toEqual(['crm.objects.read']);
    expect(reauthorized.oauthExpiresAt).toBe(completed.connection.oauthExpiresAt);
    expect(reauthorized.status).toBe('active');
    expect(JSON.stringify(reauthorized)).not.toContain('nango_at_');

    const before = reauthorized.oauthExpiresAt!;
    const refreshed = await refreshConnection(ctx, { connectionId: completed.connection.id });
    const afterRefresh = await getSource(ctx, source.id);
    expect(Date.parse(afterRefresh.oauthExpiresAt!)).toBeGreaterThan(Date.parse(before));
    expect(afterRefresh.credentialRef).toBe(refreshed.connection.credentialRef);

    await revokeConnection(ctx, { connectionId: completed.connection.id });
    const disabled = await getSource(ctx, source.id);
    expect(disabled.status).toBe('disabled');
  });

  it("re-enabling a disabled bound connector stays the gateways' own lifecycle decision", async () => {
    const ctx = member(tenantBindings);
    const source = await registerPlaceholderSource(ctx, 'jira', 'acct-jb');
    const initiated = await initiateConnection(ctx, {
      provider: 'jira',
      connectionKey: 'jr-bound',
      bindSourceId: source.id,
      scopes: ['read:jira'],
    });
    backend.seedNangoConnection(initiated.connection.id, 'jira', 'acct-jb', ['read:jira']);
    await completeConnection(ctx, { connectionId: initiated.connection.id, state: initiated.authorization.state });
    await revokeConnection(ctx, { connectionId: initiated.connection.id });
    const enabled = await setSourceStatus(ctx, { sourceId: source.id, status: 'active' });
    expect(enabled.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Sync checkpoints
// ---------------------------------------------------------------------------

describe('connection-broker service — sync checkpoints', () => {
  it('claims records, advances the checkpoint after the claim, dedupes re-pulls and replays', async () => {
    const ctx = member(tenantSync);
    const { connectionId, brokerConnectionId } = await connectNango(ctx, 'hubspot', 'hs-sync', 'acct-sync');

    // Nothing ever pulled: no checkpoint row.
    expect(await getConnectionCheckpoint(ctx, { connectionId, flow: 'sync' })).toBeNull();

    backend.scriptSync(
      'nango',
      brokerConnectionId,
      { records: [rec('r1'), rec('r2')], nextCursor: 'cur-A', hasMore: true },
    );
    const first = await runConnectionSync(ctx, { connectionId });
    expect(first.fetched).toBe(2);
    expect(first.ingested).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.checkpoint?.cursor).toBe('cur-A');
    let history = await listCheckpointHistory(ctx, { connectionId, flow: 'sync' });
    expect(history).toHaveLength(1);
    expect(history[0]!.origin).toBe('sync');
    expect(history[0]!.cursor).toBe('cur-A');
    expect(history[0]!.recordedBy).toBe(ctx.principalId);

    // The same window again: the ledger dedupes (one claim per record, ever).
    backend.scriptSync('nango', brokerConnectionId, {
      records: [rec('r1'), rec('r2')],
      nextCursor: 'cur-A',
      hasMore: true,
    });
    const second = await runConnectionSync(ctx, { connectionId });
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(second.checkpoint?.cursor).toBe('cur-A');
    history = await listCheckpointHistory(ctx, { connectionId, flow: 'sync' });
    expect(history).toHaveLength(1); // unchanged cursor adds no history

    // A failed pull leaves the checkpoint untouched (retry re-fetches).
    backend.scriptSync('nango', brokerConnectionId, { __status: 503 });
    await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId }));
    expect((await getConnectionCheckpoint(ctx, { connectionId, flow: 'sync' }))?.cursor).toBe('cur-A');
    expect(await listCheckpointHistory(ctx, { connectionId, flow: 'sync' })).toHaveLength(1);
    // The recorded cooldown (60s) must expire before the next pull.
    clockMs += 61_000;

    // An exhausted window (null next cursor) keeps the last cursor.
    backend.scriptSync('nango', brokerConnectionId, { records: [rec('r3')], nextCursor: null, hasMore: false });
    const third = await runConnectionSync(ctx, { connectionId });
    expect(third.ingested).toBe(1);
    expect(third.checkpoint?.cursor).toBe('cur-A');
    expect(third.hasMore).toBe(false);

    // Replay to a recorded entry rewinds under dedupe (audited).
    const replay = await replayConnectionCheckpoint(ctx, {
      connectionId,
      flow: 'sync',
      checkpointId: history[0]!.id,
    });
    expect(replay.checkpoint.cursor).toBe('cur-A');
    expect(replay.rewoundTo?.id).toBe(history[0]!.id);
    const fromStart = await replayConnectionCheckpoint(ctx, { connectionId, flow: 'sync', fromStart: true });
    expect(fromStart.checkpoint.cursor).toBeNull();
    expect(fromStart.rewoundTo).toBeNull();
    const afterReplay = await listCheckpointHistory(ctx, { connectionId, flow: 'sync' });
    expect(afterReplay.filter((entry) => entry.origin === 'replay')).toHaveLength(2);

    await expectCode('checkpoint_not_found', () =>
      replayConnectionCheckpoint(ctx, { connectionId, flow: 'sync', checkpointId: newId() }),
    );
    await expectCode('invalid_input', () =>
      replayConnectionCheckpoint(ctx, { connectionId, flow: 'sync' }),
    );
  });

  it('rejects syncs on non-connected connections and validates inputs', async () => {
    const ctx = member(tenantSync);
    const initiated = await initiateConnection(ctx, { provider: 'stripe', connectionKey: 'st-sync' });
    await expectCode('connection_invalid_state', () => runConnectionSync(ctx, { connectionId: initiated.connection.id }));
    const { connectionId } = await connectNango(ctx, 'stripe', 'st-sync2', 'acct-s2');
    await expect(runConnectionSync(ctx, { connectionId, maxRecords: 0 })).rejects.toThrowError(/maxRecords/);
    await expect(runConnectionSync(ctx, { connectionId, maxRecords: 201 })).rejects.toThrowError(/maxRecords/);
  });
});

// ---------------------------------------------------------------------------
// Webhook checkpoints
// ---------------------------------------------------------------------------

describe('connection-broker service — webhook checkpoints', () => {
  it('parses envelopes, claims on the ledger, dedupes redeliveries and moves the watermark forward-only', async () => {
    const ctx = member(tenantWebhook);
    const { connectionId, brokerConnectionId } = await connectNango(ctx, 'hubspot', 'hs-wh', 'acct-wh');

    const envelope = (occurredAt: string, records: ReturnType<typeof rec>[], deliveryId: string) => ({
      connectionId: brokerConnectionId,
      providerConfigKey: 'hubspot',
      deliveryId,
      occurredAt,
      records,
    });

    const first = await receiveBrokerWebhook(ctx, {
      payload: envelope('2026-09-23T12:05:00Z', [rec('w1'), rec('w2')], 'del-1'),
    });
    expect(first.fetched).toBe(2);
    expect(first.ingested).toBe(2);
    expect(first.checkpoint?.flow).toBe('webhook');
    expect(first.checkpoint?.cursor).toBe('2026-09-23T12:05:00Z');

    // Redelivery of the same envelope dedupes; the watermark does not move.
    const redelivered = await receiveBrokerWebhook(ctx, {
      payload: envelope('2026-09-23T12:05:00Z', [rec('w1'), rec('w2')], 'del-1'),
    });
    expect(redelivered.ingested).toBe(0);
    expect(redelivered.duplicates).toBe(2);
    expect(redelivered.checkpoint?.cursor).toBe('2026-09-23T12:05:00Z');
    const history = await listCheckpointHistory(ctx, { connectionId, flow: 'webhook' });
    expect(history).toHaveLength(1);
    expect(history[0]!.origin).toBe('webhook');

    // A later envelope with one NEW record claims only that record.
    const second = await receiveBrokerWebhook(ctx, {
      payload: envelope('2026-09-23T12:10:00Z', [rec('w2'), rec('w3')], 'del-2'),
    });
    expect(second.ingested).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(second.checkpoint?.cursor).toBe('2026-09-23T12:10:00Z');

    // A LATE envelope (older watermark) still claims fresh records but
    // never rewinds the watermark.
    const late = await receiveBrokerWebhook(ctx, {
      payload: envelope('2026-09-23T12:01:00Z', [rec('w4')], 'del-0'),
    });
    expect(late.ingested).toBe(1);
    expect(late.checkpoint?.cursor).toBe('2026-09-23T12:10:00Z');

    // Sync and webhook flows share the ledger: a sync delivering a record
    // the webhook already claimed is a duplicate (and vice versa).
    backend.scriptSync('nango', brokerConnectionId, { records: [rec('w3')], nextCursor: 'cur-W', hasMore: false });
    const overlap = await runConnectionSync(ctx, { connectionId });
    expect(overlap.ingested).toBe(0);
    expect(overlap.duplicates).toBe(1);
  });

  it('refuses malformed envelopes, unknown connections and non-connected grants; honors the broker pin', async () => {
    const ctx = member(tenantWebhook);
    await expectCode('invalid_webhook_payload', () => receiveBrokerWebhook(ctx, { payload: { hello: true } }));
    await expectCode('connection_not_found', () =>
      receiveBrokerWebhook(ctx, { payload: { connectionId: 'nope', providerConfigKey: 'hubspot', occurredAt: '2026-09-23T12:00:00Z', records: [] } }),
    );
    const { connectionId, brokerConnectionId } = await connectNango(ctx, 'hubspot', 'hs-wh2', 'acct-wh2');
    await expectCode('unsupported_broker', () =>
      receiveBrokerWebhook(ctx, { broker: 'martian', payload: {} }),
    );
    // The embedded dialect cannot parse the nango envelope → payload error.
    await expectCode('invalid_webhook_payload', () =>
      receiveBrokerWebhook(ctx, { broker: 'embedded', payload: { connectionId: brokerConnectionId, providerConfigKey: 'hubspot', occurredAt: '2026-09-23T12:00:00Z', records: [] } }),
    );
    await revokeConnection(ctx, { connectionId });
    await expectCode('connection_invalid_state', () =>
      receiveBrokerWebhook(ctx, {
        payload: { connectionId: brokerConnectionId, providerConfigKey: 'hubspot', occurredAt: '2026-09-23T12:20:00Z', records: [rec('w9')] },
      }),
    );
  });

  it('webhook replay rewinds the watermark to a recorded entry (gap re-processing under dedupe)', async () => {
    const ctx = member(tenantWebhook);
    const { connectionId, brokerConnectionId } = await connectNango(ctx, 'stripe', 'st-wh', 'acct-swh');
    const envelope = (occurredAt: string, id: string) => ({
      connectionId: brokerConnectionId,
      providerConfigKey: 'stripe',
      deliveryId: id,
      occurredAt,
      records: [rec(id, 'payment.charge.succeeded', occurredAt)],
    });
    await receiveBrokerWebhook(ctx, { payload: envelope('2026-09-23T12:01:00Z', 'd1') });
    clockMs += 1_000;
    await receiveBrokerWebhook(ctx, { payload: envelope('2026-09-23T12:02:00Z', 'd2') });
    const history = await listCheckpointHistory(ctx, { connectionId, flow: 'webhook' });
    expect(history).toHaveLength(2);
    // history is newest-first: [1] is the 12:01 delivery.
    expect(history[1]!.cursor).toBe('2026-09-23T12:01:00Z');
    const rewound = await replayConnectionCheckpoint(ctx, {
      connectionId,
      flow: 'webhook',
      checkpointId: history[1]!.id,
    });
    expect(rewound.checkpoint.cursor).toBe('2026-09-23T12:01:00Z');
  });
});

// ---------------------------------------------------------------------------
// Outage localization
// ---------------------------------------------------------------------------

describe('connection-broker service — provider outages are localized', () => {
  it('a broker failure becomes a canonical broker_failure + health evidence for ONE pair; other providers keep syncing', async () => {
    const ctx = member(tenantOutageA);
    const hubspot = await connectNango(ctx, 'hubspot', 'hs-out', 'acct-out');
    const stripe = await connectNango(ctx, 'stripe', 'st-out', 'acct-out2');

    backend.scriptSync('nango', hubspot.brokerConnectionId, { __status: 503 });
    const error = await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    expect(error.failure).not.toBeNull();
    expect(error.failure!.category).toBe('provider_unavailable');
    expect(error.failure!.gateway).toBe('connection-broker');
    expect(error.failure!.provider).toBe('nango');
    expect(error.message).toContain('localized');

    // The outage is recorded for exactly (hubspot, nango) — as evidence.
    const health = await getProviderHealth(ctx, { provider: 'hubspot', broker: 'nango' });
    expect(health?.health).toBe('unavailable');
    expect(health?.category).toBe('provider_unavailable');
    expect(health?.expiresAt).toBeTruthy();

    // The OTHER provider's connection keeps operating (localized!).
    backend.scriptSync('nango', stripe.brokerConnectionId, {
      records: [rec('ok-1')],
      nextCursor: 'cur-ok',
      hasMore: false,
    });
    const ok = await runConnectionSync(ctx, { connectionId: stripe.connectionId });
    expect(ok.ingested).toBe(1);
    // A never-failed pair carries NO outage evidence at all (health
    // evidence exists only once observed — no fake 'available' rows).
    expect(await getProviderHealth(ctx, { provider: 'stripe', broker: 'nango' })).toBeNull();
  });

  it('the cooldown gate fast-fails sync WITHOUT touching the broker, the checkpoint or the ledger', async () => {
    const ctx = member(tenantOutageB);
    const hubspot = await connectNango(ctx, 'hubspot', 'hs-cd', 'acct-cd');
    backend.scriptSync('nango', hubspot.brokerConnectionId, { records: [rec('cd-1')], nextCursor: 'cur-cd', hasMore: false });
    await runConnectionSync(ctx, { connectionId: hubspot.connectionId });

    backend.scriptSync('nango', hubspot.brokerConnectionId, { __status: 503 });
    await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    const requestsAfterFailure = backend.requests.length;

    const gated = await expectCode('provider_outage', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    expect(gated.message).toContain('untouched');
    // No broker request happened for the gated attempt.
    expect(backend.requests.length).toBe(requestsAfterFailure);
    // The checkpoint and history did not move.
    expect((await getConnectionCheckpoint(ctx, { connectionId: hubspot.connectionId, flow: 'sync' }))?.cursor).toBe('cur-cd');
    expect(await listCheckpointHistory(ctx, { connectionId: hubspot.connectionId, flow: 'sync' })).toHaveLength(1);
  });

  it('refresh is the ungated healing path: a successful refresh records the recovery and unblocks sync', async () => {
    const ctx = member(tenantOutageC);
    const hubspot = await connectNango(ctx, 'hubspot', 'hs-heal', 'acct-heal');
    backend.scriptSync('nango', hubspot.brokerConnectionId, { __status: 503 });
    await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    await expectCode('provider_outage', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));

    // Refresh is NOT gated — it is the healing path.
    const refreshed = await refreshConnection(ctx, { connectionId: hubspot.connectionId });
    expect(refreshed.connection.status).toBe('connected');
    expect((await getProviderHealth(ctx, { provider: 'hubspot', broker: 'nango' }))?.health).toBe('available');

    backend.scriptSync('nango', hubspot.brokerConnectionId, {
      records: [rec('healed-1')],
      nextCursor: 'cur-healed',
      hasMore: false,
    });
    const healed = await runConnectionSync(ctx, { connectionId: hubspot.connectionId });
    expect(healed.ingested).toBe(1);
  });

  it('an expired cooldown resolves back to available; operator-recovery outages are indefinite until overridden', async () => {
    const ctx = member(tenantOutageD);
    const stripe = await connectNango(ctx, 'stripe', 'st-cd2', 'acct-cd2');

    // Automatic-recovery outage (bounded cooldown).
    backend.scriptSync('nango', stripe.brokerConnectionId, { __status: 503 });
    await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId: stripe.connectionId }));
    clockMs += 61_000; // past OUTAGE_COOLDOWN_MS
    backend.scriptSync('nango', stripe.brokerConnectionId, { records: [rec('back-1')], nextCursor: 'cur-back', hasMore: false });
    const back = await runConnectionSync(ctx, { connectionId: stripe.connectionId });
    expect(back.ingested).toBe(1);

    // Operator-recovery outage (auth failure): indefinite cooldown.
    const hubspot = await connectNango(ctx, 'hubspot', 'hs-auth', 'acct-auth');
    backend.scriptSync('nango', hubspot.brokerConnectionId, { __status: 401 });
    await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    expect((await getProviderHealth(ctx, { provider: 'hubspot', broker: 'nango' }))?.expiresAt).toBeNull();
    clockMs += 10 * 60_000;
    await expectCode('provider_outage', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    // A failing refresh keeps it unhealthy (honest).
    // (The scripted nango backend refresh succeeds by default, so force a
    // failure by revoking the broker-side connection → 404 → auth_failure.)
    // Operator override lifts it — claim-gated.
    await expectCode('invalid_context', () =>
      setProviderHealth(member(tenantOutageD), { provider: 'hubspot', broker: 'nango', health: 'available' }),
    );
    const override = await setProviderHealth(admin(tenantOutageD), {
      provider: 'hubspot',
      broker: 'nango',
      health: 'available',
    });
    expect(override.health).toBe('available');
    backend.scriptSync('nango', hubspot.brokerConnectionId, { records: [rec('auth-1')], nextCursor: null, hasMore: false });
    const recovered = await runConnectionSync(ctx, { connectionId: hubspot.connectionId });
    expect(recovered.ingested).toBe(1);
  });

  it('lists current health per (provider, broker) pair', async () => {
    const ctx = member(tenantOutageE);
    const hubspot = await connectNango(ctx, 'hubspot', 'hs-ls', 'acct-ls');
    backend.scriptSync('nango', hubspot.brokerConnectionId, { __status: 429 });
    await expectCode('broker_failure', () => runConnectionSync(ctx, { connectionId: hubspot.connectionId }));
    const listed = await listProviderHealth(ctx, {});
    const row = listed.find((entry) => entry.provider === 'hubspot' && entry.broker === 'nango');
    expect(row?.health).toBe('degraded');
    expect(row?.category).toBe('rate_limited');
    // getProviderHealth without a broker pin follows the latest event.
    const pinned = await getProviderHealth(ctx, { provider: 'hubspot' });
    expect(pinned?.broker).toBe('nango');
  });
});

// ---------------------------------------------------------------------------
// Credential isolation
// ---------------------------------------------------------------------------

describe('connection-broker service — credential values never enter domain state', () => {
  it('token fragments inside broker responses never reach rows, results or bound connectors', async () => {
    const ctx = member(tenantIsolation);
    const { source } = await registerSource(ctx, {
      provider: 'hubspot',
      providerAccountId: '24015503',
      authKind: 'credentials',
      credentialRef: 'secret-store://hubspot/placeholder',
    });
    const initiated = await initiateConnection(ctx, {
      provider: 'hubspot',
      connectionKey: 'hs-iso',
      bindSourceId: source.id,
      scopes: ['read'],
    });
    backend.seedNangoConnection(initiated.connection.id, 'hubspot', '24015503', ['read']);
    const completed = await completeConnection(ctx, {
      connectionId: initiated.connection.id,
      state: initiated.authorization.state,
    });

    // The connection contract result.
    expect(JSON.stringify(completed.connection)).not.toContain(backend.nangoAccessToken);
    expect(JSON.stringify(completed.connection)).not.toContain(backend.nangoRefreshToken);
    // The bound connector (sources contract read).
    const bound = await getSource(ctx, source.id);
    expect(JSON.stringify(bound)).not.toContain(backend.nangoAccessToken);
    // The persisted rows themselves.
    const rows = await getDb().query<{
      connections: string;
      events: string;
      records: string;
    }>(
      `SELECT
         (SELECT coalesce(string_agg(to_jsonb(c)::text, ','), '') FROM broker_connections c WHERE c.tenant_id = $1) AS connections,
         (SELECT coalesce(string_agg(to_jsonb(e)::text, ','), '') FROM broker_connection_events e WHERE e.tenant_id = $1) AS events,
         (SELECT coalesce(string_agg(to_jsonb(r)::text, ','), '') FROM broker_records r WHERE r.tenant_id = $1) AS records`,
      [ctx.tenantId],
    );
    for (const column of ['connections', 'events', 'records'] as const) {
      expect(rows.rows[0]![column]).not.toContain('nango_at_');
      expect(rows.rows[0]![column]).not.toContain('nango_rt_');
    }
    // And the only credential-shaped value persisted is the opaque ref.
    expect(completed.connection.credentialRef).toBe(`nango-connection:${initiated.connection.id}`);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('connection-broker service — tenant isolation', () => {
  it("another tenant's connections, checkpoints, health and evidence are indistinguishable from missing", async () => {
    const ctxA = member(tenantIsolation);
    const ctxB = member(tenantB);
    const { connectionId, brokerConnectionId } = await connectNango(ctxA, 'hubspot', 'hs-iso2', 'acct-iso2');
    backend.scriptSync('nango', brokerConnectionId, { records: [rec('t-1')], nextCursor: 'cur-t', hasMore: false });
    await runConnectionSync(ctxA, { connectionId });

    await expectCode('connection_not_found', () => getConnection(ctxB, { connectionId }));
    await expectCode('connection_not_found', () => refreshConnection(ctxB, { connectionId }));
    await expectCode('connection_not_found', () => revokeConnection(ctxB, { connectionId }));
    await expectCode('connection_not_found', () => runConnectionSync(ctxB, { connectionId }));
    await expectCode('connection_not_found', () => replayConnectionCheckpoint(ctxB, { connectionId, flow: 'sync', fromStart: true }));
    // The webhook envelope resolves onto THIS tenant's connection only.
    await expectCode('connection_not_found', () =>
      receiveBrokerWebhook(ctxB, {
        payload: {
          connectionId: brokerConnectionId,
          providerConfigKey: 'hubspot',
          occurredAt: '2026-09-23T12:00:00Z',
          records: [rec('t-1')],
        },
      }),
    );
    expect(await listConnections(ctxB, {})).toEqual([]);
    expect(await getProviderHealth(ctxB, { provider: 'hubspot', broker: 'nango' })).toBeNull();
    expect(await listHotSwapVerifications(ctxB, {})).toEqual([]);
    await expectCode('connection_not_found', () =>
      listCheckpointHistory(ctxB, { connectionId, flow: 'sync' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('connection-broker service — storage discipline', () => {
  it('the audit, ledger, health and verification tables are append-only; checkpoints move only their cursor', async () => {
    const ctx = member(tenantStorage);
    const { connectionId, brokerConnectionId } = await connectNango(ctx, 'hubspot', 'hs-store', 'acct-store');
    backend.scriptSync('nango', brokerConnectionId, { records: [rec('s-1')], nextCursor: 'cur-s', hasMore: false });
    await runConnectionSync(ctx, { connectionId });
    await receiveBrokerWebhook(ctx, {
      payload: {
        connectionId: brokerConnectionId,
        providerConfigKey: 'hubspot',
        occurredAt: '2026-09-23T12:03:00Z',
        records: [rec('s-2')],
      },
    });

    const db = getDb();
    // Seed the health + verification tables through legal paths first so
    // the append-only triggers have rows to defend (UPDATEs on empty tables
    // are vacuous no-ops).
    await setProviderHealth(admin(tenantStorage), {
      provider: 'hubspot',
      broker: 'nango',
      health: 'degraded',
      category: 'rate_limited',
      reason: 'storage-discipline seed',
    });
    await db.query(
      `INSERT INTO broker_hot_swap_verifications (
         tenant_id, capability, request_digest, provider, broker_a, connection_a, result_a,
         broker_b, connection_b, result_b, outcome, note, requested_by, verified_at
       ) VALUES ($1, 'connection-sync', $2, 'hubspot', 'nango', $3, $4, 'embedded', $5, $6,
                 'equivalent', NULL, 'storage-discipline', $7)`,
      [
        tenantStorage,
        'a'.repeat(64),
        connectionId,
        'b'.repeat(64),
        newId(),
        'c'.repeat(64),
        new Date(clockMs),
      ],
    );
    await expect(db.query(`UPDATE broker_connection_events SET detail = 'tampered'`)).rejects.toThrowError(/append-only/);
    await expect(db.query(`DELETE FROM broker_records`)).rejects.toThrowError(/append-only/);
    await expect(db.query(`UPDATE broker_checkpoint_history SET cursor = 'tampered'`)).rejects.toThrowError(/append-only/);
    await expect(db.query(`UPDATE broker_provider_health_events SET state = 'available'`)).rejects.toThrowError(/append-only/);
    await expect(db.query(`UPDATE broker_hot_swap_verifications SET outcome = 'equivalent'`)).rejects.toThrowError(/append-only/);
    await expect(db.query(`DELETE FROM broker_checkpoints`)).rejects.toThrowError(/forbidden/);
    await expect(
      db.query(`UPDATE broker_checkpoints SET connection_id = gen_random_uuid()`),
    ).rejects.toThrowError(/only the cursor and updated_at may change/);
    // The legal move: the cursor (and updated_at).
    await db.query(`UPDATE broker_checkpoints SET cursor = 'moved', updated_at = now()`);
    const moved = await getConnectionCheckpoint(ctx, { connectionId, flow: 'sync' });
    expect(moved?.cursor).toBe('moved');
  });
});

// ---------------------------------------------------------------------------
// The sources composition bridge
// ---------------------------------------------------------------------------

describe('connection-broker service — the sources composition bridge', () => {
  it("broker-backed pulls become observations through W036's own polling contract", async () => {
    const ctx = member(tenantBridge);
    const { source } = await registerSource(ctx, {
      provider: 'hubspot',
      providerAccountId: '24015504',
      authKind: 'credentials',
      credentialRef: 'secret-store://hubspot/placeholder',
    });
    const initiated = await initiateConnection(ctx, {
      provider: 'hubspot',
      connectionKey: 'hs-bridge',
      bindSourceId: source.id,
      scopes: ['read'],
    });
    backend.seedNangoConnection(initiated.connection.id, 'hubspot', '24015504', ['read']);
    const completed = await completeConnection(ctx, {
      connectionId: initiated.connection.id,
      state: initiated.authorization.state,
    });
    const brokerConnectionId = completed.connection.brokerConnectionId!;

    setSourceTransport(createBrokerSourceTransport());
    backend.scriptSync('nango', brokerConnectionId, {
      records: [rec('obs-1', 'crm.contact.updated')],
      nextCursor: 'cur-obs',
      hasMore: false,
    });
    const poll = await pollSource(ctx, { sourceId: source.id });
    expect(poll.fetched).toBe(1);
    expect(poll.ingested).toBe(1);
    expect(poll.checkpoint?.cursor).toBe('cur-obs');

    const observations = await listObservations(ctx, { sourceKind: 'source', sourceId: source.id });
    expect(observations).toHaveLength(1);
    expect(observations[0]!.kind).toBe('crm.contact.updated');
    expect(observations[0]!.channel).toBe('hubspot');

    // The bridge pulled through the broker connection bound to the source,
    // with the connection's opaque credential reference and the source's
    // own cursor discipline (sources advances ITS checkpoint).
    const syncRequest = backend.requests.find(
      (request) => request.method === 'GET' && /^\/sync\//.test(request.path),
    );
    expect(syncRequest?.path).toContain(brokerConnectionId);
    expect(syncRequest?.headers?.['Authorization']).toBeTruthy();
    // A re-poll of the same window is suppressed by the sources ledger.
    backend.scriptSync('nango', brokerConnectionId, {
      records: [rec('obs-1', 'crm.contact.updated')],
      nextCursor: 'cur-obs',
      hasMore: false,
    });
    const rePoll = await pollSource(ctx, { sourceId: source.id });
    expect(rePoll.ingested).toBe(0);
    expect(rePoll.duplicates).toBe(1);
  });

  it('the bridge refuses sources without a live broker connection and localizes broker failures', async () => {
    const ctx = member(tenantBridge);
    const { source } = await registerSource(ctx, {
      provider: 'stripe',
      providerAccountId: '24015505',
      authKind: 'credentials',
      credentialRef: 'secret-store://stripe/placeholder',
    });
    setSourceTransport(createBrokerSourceTransport());
    // No connection bound to this source → the sources poll wraps the
    // localized refusal as an honest fetch failure.
    await expect(pollSource(ctx, { sourceId: source.id })).rejects.toThrowError(
      /no broker-backed connection is bound to source/,
    );

    const initiated = await initiateConnection(ctx, {
      provider: 'stripe',
      connectionKey: 'st-bridge',
      bindSourceId: source.id,
      scopes: ['read'],
    });
    backend.seedNangoConnection(initiated.connection.id, 'stripe', '24015505', ['read']);
    await completeConnection(ctx, { connectionId: initiated.connection.id, state: initiated.authorization.state });
    backend.scriptSync('nango', initiated.connection.id, { __status: 503 });
    await expect(pollSource(ctx, { sourceId: source.id })).rejects.toThrowError(/fetch_failed|failed to fetch/i);
    // The outage is localized as health evidence for exactly this pair.
    expect((await getProviderHealth(ctx, { provider: 'stripe', broker: 'nango' }))?.health).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Broker replacement + hot-swap evidence
// ---------------------------------------------------------------------------

describe('connection-broker service — broker replacement does not change domain contracts', () => {
  it('connections route through their RECORDED broker; unwiring it is explicit; new connections follow the active one', async () => {
    const ctx = member(tenantSwap);
    const nangoBacked = await connectNango(ctx, 'hubspot', 'hs-route', 'acct-route');

    // Swap the active broker: new connections go to the embedded broker.
    wireConnectionBrokers([embedded, nango]);
    const embeddedBacked = await connectEmbedded(ctx, 'hubspot', 'hs-route-emb');
    expect(embeddedBacked.connectionId).not.toBe(nangoBacked.connectionId);
    const embeddedConnection = await getConnection(ctx, { connectionId: embeddedBacked.connectionId });
    expect(embeddedConnection.broker).toBe('embedded');
    expect(embeddedConnection.credentialRef).toMatch(/^embedded-connection:emb_/);

    // The OLD connection keeps operating through its recorded broker.
    backend.scriptSync('nango', nangoBacked.brokerConnectionId, {
      records: [rec('route-1')],
      nextCursor: 'cur-route',
      hasMore: false,
    });
    const oldSync = await runConnectionSync(ctx, { connectionId: nangoBacked.connectionId });
    expect(oldSync.ingested).toBe(1);

    // Unwiring the recorded broker is an explicit, honest refusal.
    wireConnectionBrokers([embedded]);
    await expectCode('broker_unavailable', () =>
      runConnectionSync(ctx, { connectionId: nangoBacked.connectionId }),
    );
    // ...while the embedded-backed connection is unaffected.
    backend.scriptSync('embedded', embeddedBacked.brokerConnectionId, {
      records: [rec('route-2')],
      nextCursor: 'cur-route-emb',
      hasMore: false,
    });
    const embSync = await runConnectionSync(ctx, { connectionId: embeddedBacked.connectionId });
    expect(embSync.ingested).toBe(1);
  });

  it('the same canonical request through two brokers: equivalent outcome + canonical evidence + persisted verification', async () => {
    const ctx = member(tenantSwap);
    const a = await connectNango(ctx, 'hubspot', 'hs-swap-a', 'acct-swap-a');
    const embeddedBacked = await (async () => {
      wireConnectionBrokers([embedded, nango]);
      return connectEmbedded(ctx, 'hubspot', 'hs-swap-b');
    })();
    const b = { connectionId: embeddedBacked.connectionId, brokerConnectionId: embeddedBacked.brokerConnectionId };

    // Both brokers serve the SAME canonical window (hasMore true + a
    // non-null cursor: the nango dialect DERIVES hasMore from the cursor,
    // the embedded dialect reports it — equivalent alternatives agree).
    const window = { records: [rec('swap-1'), rec('swap-2')], nextCursor: 'cur-swap', hasMore: true };
    backend.scriptSync('nango', a.brokerConnectionId, window);
    backend.scriptSync('embedded', b.brokerConnectionId, window);

    const result = await verifyBrokerHotSwap(ctx, {
      connectionIdA: a.connectionId,
      connectionIdB: b.connectionId,
    });
    expect(result.verification.outcome).toBe('equivalent');
    expect(result.verification.provider).toBe('hubspot');
    expect(result.verification.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verification.resultA).toBe(result.verification.resultB);
    // The canonical W089 evidence record.
    expect(result.evidence.sdk).toBe('provider-hot-swap-evidence');
    expect(result.evidence.gateway).toBe('connection-broker');
    expect(result.evidence.capability).toBe('connection-sync');
    expect(result.evidence.providerA.provider).toBe('nango');
    expect(result.evidence.providerB.provider).toBe('embedded');
    expect(result.evidence.providerA.provider).not.toBe(result.evidence.providerB.provider);
    expect(result.evidence.outcome).toBe('equivalent');
    expect(result.evidence.comparison).toBe('deterministic-structural');

    const listed = await listHotSwapVerifications(ctx, {});
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(result.verification.id);
  });

  it('divergent results and failed targets are honest outcomes', async () => {
    const ctx = member(tenantSwap);
    const a = await connectNango(ctx, 'stripe', 'st-swap-a', 'acct-sw-a');
    wireConnectionBrokers([embedded, nango]);
    const b = await connectEmbedded(ctx, 'stripe', 'st-swap-b');

    backend.scriptSync('nango', a.brokerConnectionId, {
      records: [rec('div-1')],
      nextCursor: 'cur-div',
      hasMore: false,
    });
    backend.scriptSync('embedded', b.brokerConnectionId, {
      records: [rec('div-1'), rec('div-2')],
      nextCursor: 'cur-div',
      hasMore: false,
    });
    const divergent = await verifyBrokerHotSwap(ctx, {
      connectionIdA: a.connectionId,
      connectionIdB: b.connectionId,
    });
    expect(divergent.verification.outcome).toBe('completed-divergent');
    expect(divergent.evidence.outcome).toBe('completed-divergent');

    // One target failing → the honest 'failed' outcome (localized evidence).
    backend.scriptSync('nango', a.brokerConnectionId, { __status: 503 });
    backend.scriptSync('embedded', b.brokerConnectionId, {
      records: [rec('div-1')],
      nextCursor: 'cur-div',
      hasMore: false,
    });
    const failed = await verifyBrokerHotSwap(ctx, {
      connectionIdA: a.connectionId,
      connectionIdB: b.connectionId,
    });
    expect(failed.verification.outcome).toBe('failed');
    expect(failed.verification.resultA).toBe('failed');
    expect(failed.evidence.providerA.resultKind).toBe('failed');
    expect((await getProviderHealth(ctx, { provider: 'stripe', broker: 'nango' }))?.health).toBe('unavailable');
  });

  it('validates its targets loudly', async () => {
    const ctx = member(tenantSwap);
    const a = await connectNango(ctx, 'jira', 'jr-swap-a', 'acct-jr-a');
    await expectCode('invalid_input', () =>
      verifyBrokerHotSwap(ctx, { connectionIdA: a.connectionId, connectionIdB: a.connectionId }),
    );
    const initiated = await initiateConnection(ctx, { provider: 'jira', connectionKey: 'jr-swap-b' });
    await expectCode('connection_invalid_state', () =>
      verifyBrokerHotSwap(ctx, { connectionIdA: a.connectionId, connectionIdB: initiated.connection.id }),
    );
    wireConnectionBrokers([embedded, nango]);
    const b = await connectEmbedded(ctx, 'linear', 'ln-swap-b');
    await expectCode('invalid_input', () =>
      verifyBrokerHotSwap(ctx, { connectionIdA: a.connectionId, connectionIdB: b.connectionId }),
    );
    // Same broker on both sides is not a swap.
    wireConnectionBrokers([nango, embedded]);
    const a2 = await connectNango(ctx, 'jira', 'jr-swap-a2', 'acct-jr-a2');
    await expectCode('invalid_input', () =>
      verifyBrokerHotSwap(ctx, { connectionIdA: a.connectionId, connectionIdB: a2.connectionId }),
    );
  });
});
