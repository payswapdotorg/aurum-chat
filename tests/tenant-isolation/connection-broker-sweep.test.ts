// W044 — Tenant Isolation Verification · the connection-broker sweep (W082).
//
// The connection-broker module (W082 — Universal Connection Broker) owns
// tenant-scoped tables for its concepts: universal broker connections
// (connect/revoke/refresh lifecycle), connection audit events, per-flow
// sync/webhook checkpoints with append-only history, the delivery ledger,
// provider-health outage evidence and broker hot-swap verifications.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * connections are tenant-scoped: one tenant's connection (by id, by
//     broker connection id, by bound source) is invisible to the other
//     (uniform not-found, no existence leak);
//   * the webhook edge resolves broker envelopes onto THIS tenant's
//     connections only;
//   * checkpoints, replay targets, health evidence and swap evidence stay
//     per-tenant;
//   * the bound sources-gateway connector re-authorization path is driven
//     only by the owning tenant's context.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/connection-broker/tests/); this sweep is the two-tenant
// proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import {
  completeConnection,
  ConnectionBrokerError,
  getConnection,
  getConnectionCheckpoint,
  getProviderHealth,
  initiateConnection,
  listCheckpointHistory,
  listConnections,
  listHotSwapVerifications,
  receiveBrokerWebhook,
  refreshConnection,
  replayConnectionCheckpoint,
  revokeConnection,
  runConnectionSync,
  verifyBrokerHotSwap,
  wireConnectionBrokers,
  type BrokerHttpClient,
  type BrokerHttpRequest,
  type BrokerHttpResponse,
  type ConnectionBroker,
} from '@/modules/connection-broker/contract';
import { createNangoBroker } from '@/modules/connection-broker/adapters/nango';
import { createEmbeddedBroker } from '@/modules/connection-broker/adapters/embedded';
import { registerSource } from '@/modules/sources/contract';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(
  code: ConnectionBrokerError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ConnectionBrokerError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ConnectionBrokerError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// A minimal scripted broker backend (nango + embedded dialects)
// ---------------------------------------------------------------------------

class SweepBackend implements BrokerHttpClient {
  readonly nangoConnections = new Map<string, { provider: string; accountId: string; expiresAt: string }>();
  readonly embAuthorizations = new Map<string, string>();
  private counter = 0;

  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
    const nowIso = new Date().toISOString();
    const nangoConnection = /^\/connection\/([^/]+)$/.exec(request.path);
    if (request.method === 'GET' && nangoConnection !== null) {
      const entry = this.nangoConnections.get(decodeURIComponent(nangoConnection[1]!));
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      return {
        status: 200,
        body: {
          connection_id: nangoConnection[1],
          provider_config_key: entry.provider,
          connection_config: { account_id: entry.accountId },
          credentials: {
            type: 'OAUTH2',
            // Fake token fragments — assembled at runtime, discarded by the adapter.
            access_token: ['nango_at_', 'sweep', '_plain'].join(''),
            refresh_token: ['nango_rt_', 'sweep', '_plain'].join(''),
            expires_at: entry.expiresAt,
            scopes: ['read'],
          },
        },
      };
    }
    if (request.method === 'POST' && request.path === '/connection/refresh') {
      const body = request.body as { connection_id?: string };
      const entry = this.nangoConnections.get(body.connection_id ?? '');
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      entry.expiresAt = new Date(Date.parse(entry.expiresAt) + 3_600_000).toISOString();
      return { status: 200, body: {} };
    }
    if (request.method === 'DELETE' && nangoConnection !== null) {
      this.nangoConnections.delete(decodeURIComponent(nangoConnection[1]!));
      return { status: 200, body: {} };
    }
    if (request.method === 'GET' && /^\/sync\//.test(request.path)) {
      const id = /^\/sync\/([^/]+)\/records$/.exec(request.path)![1]!;
      const tenantTag = id.slice(0, 8);
      return {
        status: 200,
        body: {
          records: [
            {
              id: `sweep-${tenantTag}-1`,
              kind: 'crm.contact.updated',
              occurredAt: nowIso,
              data: { recordId: `sweep-${tenantTag}-1` },
            },
          ],
          nextCursor: `cursor-${tenantTag}`,
        },
      };
    }
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st_${this.counter}`;
      this.embAuthorizations.set(body.connection_id ?? '', state);
      return { status: 201, body: { authorization_url: 'https://broker.example/oauth/x', state, expires_at: new Date(Date.now() + 900_000).toISOString() } };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const state = this.embAuthorizations.get(decodeURIComponent(callback[1]!));
      const body = request.body as { state?: string };
      if (state === undefined || body.state !== state) return { status: 401, body: { error: 'authorization session unknown or expired' } };
      this.counter += 1;
      const embId = `emb_${this.counter}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: ['read'],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    if (request.method === 'POST' && /\/refresh$/.test(request.path)) {
      return { status: 200, body: { credential_ref: 'embedded-connection:x', provider_account_id: 'eacct-x', scopes: ['read'], expires_at: new Date(Date.now() + 7_200_000).toISOString() } };
    }
    if (request.method === 'GET' && /\/records$/.test(request.path)) {
      return { status: 200, body: { records: [], next_cursor: null, has_more: false } };
    }
    if (request.method === 'DELETE') return { status: 204, body: null };
    return { status: 404, body: { error: 'no route' } };
  }
}

let backend: SweepBackend;
let nango: ConnectionBroker;
let embedded: ConnectionBroker;

beforeAll(async () => {
  await runMigrations(getDb());
  backend = new SweepBackend();
  nango = createNangoBroker({
    baseUrl: 'https://nango.sweep.example',
    // Fake instance secret — assembled from fragments at runtime.
    secretKey: ['nango_sk_live_', 'sweep', '_fragment'].join(''),
    httpClient: backend,
  });
  embedded = createEmbeddedBroker({
    baseUrl: 'https://broker.sweep.example',
    apiToken: ['embedded_tok_', 'sweep', '_fragment'].join(''),
    httpClient: backend,
  });
  wireConnectionBrokers([nango, embedded]);
});

afterAll(async () => {
  wireConnectionBrokers(null);
  await closeDb();
});

describe('W044 sweep — connection-broker (W082)', () => {
  let connectionA: string;
  let brokerConnectionA: string;
  let connectionB: string;

  it('connections, grants and the lifecycle stay per-tenant (zero leakage)', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    const initiatedA = await initiateConnection(memberA, {
      provider: 'hubspot',
      connectionKey: 'sweep-a',
      scopes: ['read'],
    });
    backend.nangoConnections.set(initiatedA.connection.id, {
      provider: 'hubspot',
      // Digits-only: the sources hubspot adapter normalizes portal ids.
      accountId: '24017701',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const completedA = await completeConnection(memberA, {
      connectionId: initiatedA.connection.id,
      state: initiatedA.authorization.state,
    });
    connectionA = completedA.connection.id;
    brokerConnectionA = completedA.connection.brokerConnectionId!;

    const initiatedB = await initiateConnection(memberB, {
      provider: 'hubspot',
      connectionKey: 'sweep-b',
      scopes: ['read'],
    });
    backend.nangoConnections.set(initiatedB.connection.id, {
      provider: 'hubspot',
      accountId: '24017702',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const completedB = await completeConnection(memberB, {
      connectionId: initiatedB.connection.id,
      state: initiatedB.authorization.state,
    });
    connectionB = completedB.connection.id;

    // Each tenant sees exactly its own connection.
    const listedA = await listConnections(memberA, {});
    const listedB = await listConnections(memberB, {});
    expect(listedA.map((connection) => connection.id)).toEqual([connectionA]);
    expect(listedB.map((connection) => connection.id)).toEqual([connectionB]);

    // Cross-tenant lifecycle operations are uniformly not-found (no leak).
    await expectCode('connection_not_found', () => getConnection(memberB, { connectionId: connectionA }));
    await expectCode('connection_not_found', () => refreshConnection(memberB, { connectionId: connectionA }));
    await expectCode('connection_not_found', () => revokeConnection(memberB, { connectionId: connectionA }));
    await expectCode('connection_not_found', () => runConnectionSync(memberB, { connectionId: connectionA }));
    await expectCode('connection_not_found', () =>
      replayConnectionCheckpoint(memberB, { connectionId: connectionA, flow: 'sync', fromStart: true }),
    );
  });

  it('the webhook edge resolves broker envelopes onto THIS tenant only', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);
    // Tenant A's broker connection id inside the envelope — tenant B
    // resolves it as unknown (indistinguishable from missing).
    await expectCode('connection_not_found', () =>
      receiveBrokerWebhook(memberB, {
        payload: {
          connectionId: brokerConnectionA,
          providerConfigKey: 'hubspot',
          deliveryId: 'sweep-del-1',
          occurredAt: '2026-09-23T12:05:00Z',
          records: [
            { id: 'sweep-a-1', kind: 'crm.contact.updated', occurredAt: '2026-09-23T12:04:00Z', data: { recordId: 1 } },
          ],
        },
      }),
    );
    // The owning tenant processes it fine.
    const delivered = await receiveBrokerWebhook(memberA, {
      payload: {
        connectionId: brokerConnectionA,
        providerConfigKey: 'hubspot',
        deliveryId: 'sweep-del-1',
        occurredAt: '2026-09-23T12:05:00Z',
        records: [
          { id: 'sweep-a-1', kind: 'crm.contact.updated', occurredAt: '2026-09-23T12:04:00Z', data: { recordId: 1 } },
        ],
      },
    });
    expect(delivered.ingested).toBe(1);
    // And tenant B never saw the ledger claim.
    expect(await listConnections(memberB, {})).toHaveLength(1);
  });

  it('checkpoints, health evidence and swap evidence stay per-tenant', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    // Tenant A syncs; its checkpoint/ledger/history exist for A only.
    const synced = await runConnectionSync(memberA, { connectionId: connectionA });
    expect(synced.ingested).toBe(1);
    expect((await getConnectionCheckpoint(memberA, { connectionId: connectionA, flow: 'sync' }))?.cursor).toContain('cursor-');
    const historyA = await listCheckpointHistory(memberA, { connectionId: connectionA, flow: 'sync' });
    expect(historyA.length).toBeGreaterThanOrEqual(1);

    // Cross-tenant checkpoint reads are not-found (loader-guarded).
    await expectCode('connection_not_found', () =>
      getConnectionCheckpoint(memberB, { connectionId: connectionA, flow: 'sync' }),
    );
    await expectCode('connection_not_found', () =>
      listCheckpointHistory(memberB, { connectionId: connectionA, flow: 'sync' }),
    );

    // Health evidence: A observes an outage; B has none and never sees A's.
    backend.nangoConnections.delete(connectionA);
    await expectCode('broker_failure', () => refreshConnection(memberA, { connectionId: connectionA }));
    expect((await getProviderHealth(memberA, { provider: 'hubspot', broker: 'nango' }))?.health).toBe('unavailable');
    expect(await getProviderHealth(memberB, { provider: 'hubspot', broker: 'nango' })).toBeNull();

    // Swap evidence: tenant A verifies a two-broker swap; tenant B's list
    // stays empty (its own connections were never swapped). The embedded
    // target needs the embedded broker ACTIVE for its initiation.
    backend.nangoConnections.set(connectionA, {
      provider: 'hubspot',
      accountId: '24017701',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    wireConnectionBrokers([embedded, nango]);
    const initiatedEmbedded = await initiateConnection(memberA, { provider: 'hubspot', connectionKey: 'sweep-a-emb', scopes: ['read'] });
    const embeddedCompleted = await completeConnection(memberA, {
      connectionId: initiatedEmbedded.connection.id,
      state: initiatedEmbedded.authorization.state,
    });
    const swap = await verifyBrokerHotSwap(memberA, {
      connectionIdA: connectionA,
      connectionIdB: embeddedCompleted.connection.id,
    });
    expect(['equivalent', 'completed-divergent', 'failed']).toContain(swap.verification.outcome);
    expect(await listHotSwapVerifications(memberA, {})).toHaveLength(1);
    expect(await listHotSwapVerifications(memberB, {})).toEqual([]);
    await expectCode('connection_not_found', () =>
      verifyBrokerHotSwap(memberB, { connectionIdA: connectionA, connectionIdB: connectionB }),
    );
    // Restore the default wiring (nango active) for the tests that follow.
    wireConnectionBrokers([nango, embedded]);
  });

  it('the bound sources-gateway connector re-authorization is driven by the owning tenant only', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);
    // Tenant B binds one of ITS OWN sources — never tenant A's.
    const { source: sourceB } = await registerSource(memberB, {
      provider: 'jira',
      providerAccountId: 'sweep-jira-b',
      authKind: 'credentials',
      credentialRef: 'secret-store://sweep/b-placeholder',
    });
    const initiated = await initiateConnection(memberB, {
      provider: 'jira',
      connectionKey: 'sweep-b-jira',
      bindSourceId: sourceB.id,
      scopes: ['read:jira'],
    });
    backend.nangoConnections.set(initiated.connection.id, {
      provider: 'jira',
      accountId: 'sweep-jira-b',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const completed = await completeConnection(memberB, {
      connectionId: initiated.connection.id,
      state: initiated.authorization.state,
    });
    // The bound connector now carries the BROKER-issued opaque reference,
    // re-registered through the sources contract under tenant B's context.
    expect(completed.connection.bindSourceId).toBe(sourceB.id);
    // Tenant A never sees tenant B's connection or its re-authorized source.
    await expectCode('connection_not_found', () => getConnection(memberA, { connectionId: completed.connection.id }));
    await expectCode('connection_not_found', () => refreshConnection(memberA, { connectionId: completed.connection.id }));
  });
});
