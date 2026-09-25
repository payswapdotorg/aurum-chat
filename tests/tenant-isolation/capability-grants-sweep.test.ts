// W044 — Tenant Isolation Verification · the capability-grants sweep (W083).
//
// The capability-grants module (W083 — Progressive Capability Grants) owns
// tenant-scoped tables for its concepts: the per-connection read-only
// capability envelope, scoped authority grant requests (the asks routed
// through the actions module's W009 gate), the authority grants
// themselves, the append-only grant lifecycle events and the append-only
// invocation ledger.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * the read-only envelope, the asks, the grants and the invocation
//     ledger are tenant-scoped: one tenant's records (by connection id,
//     by grant id, by request id, by invocation id) are invisible to the
//     other (uniform not-found, no existence leak);
//   * cross-tenant establish/invoke/ask through another tenant's
//     connection id are refused before any state is touched (the
//     connection-broker contract's uniform not-found applies);
//   * each tenant's listings show exactly its own records.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/capability-grants/tests/); this sweep is the two-tenant
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
import * as grants from '@/modules/capability-grants/contract';
import * as integration from '@/modules/integration-intelligence/contract';
import * as sources from '@/modules/sources/contract';
import {
  completeConnection,
  createEmbeddedBroker,
  initiateConnection,
  wireConnectionBrokers,
  type BrokerHttpClient,
  type BrokerHttpRequest,
  type BrokerHttpResponse,
} from '@/modules/connection-broker/contract';
import type { SourceFetchResult, SourceTransport } from '@/modules/sources/contract';
import { CapabilityGrantsError } from '@/modules/capability-grants/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: CapabilityGrantsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected CapabilityGrantsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof CapabilityGrantsError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Minimal scripted backends (the sources directory + the embedded broker)
// ---------------------------------------------------------------------------

class SweepDirectory implements SourceTransport {
  async fetch(): Promise<SourceFetchResult> {
    return {
      records: [
        {
          providerRecordId: 'sweep-dir-1',
          kind: 'directory.system.discovered',
          payload: {
            externalId: 'sweep-crm',
            displayName: 'Sweep CRM',
            capabilityClasses: ['customer-records', 'sales-pipeline'],
          },
          occurredAt: '2026-09-23T10:00:00Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
  }
}

class SweepBroker implements BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st_${this.counter}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: 'https://broker.sweep.example/oauth/x',
          state,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const state = this.authorizations.get(decodeURIComponent(callback[1]!));
      const body = request.body as { state?: string };
      if (state === undefined || body.state !== state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
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
    return { status: 404, body: { error: 'no scripted route' } };
  }
}

/** Full W081→W082→W083 setup for one tenant: one discovered, connected system. */
async function connectSystem(tenantId: string): Promise<string> {
  const adminCtx = memberOf(tenantId, ['integration-intelligence:administer']);
  const memberCtx = memberOf(tenantId);
  const { source } = await sources.registerSource(adminCtx, {
    provider: 'notion',
    providerAccountId: `ws-${tenantId.slice(0, 8)}`,
    displayName: 'Sweep directory',
    authKind: 'oauth',
    // Fake credential fragments — assembled at runtime.
    credentialRef: ['secret-store://', 'w083-sweep/', `${tenantId.slice(0, 8)}/ref`].join(''),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await integration.grantDiscoverySource(adminCtx, { sourceId: source.id });
  await integration.runDiscovery(memberCtx, { sourceId: source.id });
  const systems = await integration.listSystems(memberCtx, {});
  const system = systems.find((entry) => entry.displayName === 'Sweep CRM')!;
  const initiated = await initiateConnection(memberCtx, {
    provider: 'notion',
    connectionKey: `sweep-${tenantId.slice(0, 8)}`,
    displayName: 'Sweep CRM',
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(memberCtx, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return completed.connection.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
  sources.setSourceTransport(new SweepDirectory());
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.sweep.example',
      apiToken: ['embedded_tok_', 'sweep', '_fragment'].join(''),
      httpClient: new SweepBroker(),
    }),
  ]);
});

afterAll(async () => {
  sources.setSourceTransport(null);
  wireConnectionBrokers(null);
  await closeDb();
});

describe('W044 sweep — capability-grants (W083)', () => {
  let connectionA: string;
  let connectionB: string;

  it('the envelopes, asks, grants and invocation ledger stay per-tenant (zero leakage)', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    connectionA = await connectSystem(tenantA);
    connectionB = await connectSystem(tenantB);

    // Each tenant establishes its own read-only envelope.
    const accessA = await grants.establishConnectionAccess(memberA, { connectionId: connectionA });
    const accessB = await grants.establishConnectionAccess(memberB, { connectionId: connectionB });
    expect(accessA.tenantId).toBe(tenantA);
    expect(accessB.tenantId).toBe(tenantB);
    expect(await grants.getConnectionAccess(memberA, { connectionId: connectionA }).then((v) => v.connectionMode)).toBe('read-only');

    // Cross-tenant establish/invoke/ask through the other's connection id
    // are uniformly not-found (the broker contract's discipline — no
    // existence leak, no state touched).
    await expectCode('connection_not_found', () =>
      grants.establishConnectionAccess(memberB, { connectionId: connectionA }),
    );
    await expectCode('connection_not_found', () =>
      grants.invokeCapability(memberB, {
        connectionId: connectionA,
        capabilityKey: 'read.customer-records',
        taskContext: { description: 'cross-tenant probe' },
      }),
    );
    await expectCode('connection_not_found', () =>
      grants.requestCapabilityAuthority(memberB, {
        connectionId: connectionA,
        capabilityKeys: ['write.customer-records'],
        taskContext: { description: 'cross-tenant probe' },
      }),
    );
    // The envelope reads and listings stay per-tenant.
    await expectCode('access_not_found', () => grants.getConnectionAccess(memberB, { connectionId: connectionA }));
    expect((await grants.listGrantEvents(memberA, { connectionId: connectionA })).length).toBeGreaterThan(0);
    await expectCode('access_not_found', () => grants.listGrantEvents(memberB, { connectionId: connectionA }));
  });

  it('the asks, grants and invocations of one tenant are invisible to the other', async () => {
    const memberA = memberOf(tenantA);
    const approverA = memberOf(tenantA, ['actions:approve']);
    const memberB = memberOf(tenantB);

    // Tenant A walks the progressive path: ask → approve → grant → invoke.
    const ask = await grants.requestCapabilityAuthority(memberA, {
      connectionId: connectionA,
      capabilityKeys: ['write.customer-records'],
      taskContext: { description: 'Sweep tenant A task' },
    });
    const decided = await grants.decideGrantRequest(approverA, {
      requestId: ask.request!.id,
      decision: 'approve',
    });
    expect(decided.status).toBe('approved');
    const [grantA] = await grants.listCapabilityGrants(memberA, { connectionId: connectionA });
    expect(grantA).toBeDefined();
    const allowedA = await grants.invokeCapability(memberA, {
      connectionId: connectionA,
      capabilityKey: 'write.customer-records',
      taskContext: { description: 'Sweep tenant A write' },
    });
    expect(allowedA.outcome).toBe('allowed');
    const [invocationA] = await grants.listCapabilityInvocations(memberA, { connectionId: connectionA });

    // Tenant B sees none of it — uniform not-found on every surface.
    await expectCode('grant_not_found', () => grants.getCapabilityGrant(memberB, { grantId: grantA!.id }));
    await expectCode('grant_request_not_found', () =>
      grants.getGrantRequest(memberB, { requestId: ask.request!.id }),
    );
    await expectCode('invocation_not_found', () =>
      grants.getCapabilityInvocation(memberB, { invocationId: invocationA!.id }),
    );
    // And its listings hold exactly its own records (its envelope, no
    // grants, no asks, no invocations).
    expect(await grants.listCapabilityGrants(memberB, {})).toHaveLength(0);
    expect(await grants.listGrantRequests(memberB, {})).toHaveLength(0);
    expect(await grants.listCapabilityInvocations(memberB, {})).toHaveLength(0);
    expect((await grants.getConnectionAccess(memberB, { connectionId: connectionB })).connectionMode).toBe('read-only');
    // Tenant A's own listings stay complete.
    expect(await grants.listCapabilityGrants(memberA, {})).toHaveLength(1);
    expect(await grants.listGrantRequests(memberA, {})).toHaveLength(1);
    expect(await grants.listCapabilityInvocations(memberA, {})).toHaveLength(1);
  });

  it('revocation is claim-gated and its trail stays with the owning tenant', async () => {
    const memberA = memberOf(tenantA);
    const adminA = memberOf(tenantA, ['capability-grants:administer']);
    const memberB = memberOf(tenantB);

    const [grantA] = await grants.listCapabilityGrants(memberA, { connectionId: connectionA });
    // Tenant B cannot revoke A's grant (uniform not-found first).
    const adminB = memberOf(tenantB, ['capability-grants:administer']);
    await expectCode('grant_not_found', () => grants.revokeCapabilityGrant(adminB, { grantId: grantA!.id }));
    // The owning admin can.
    const revoked = await grants.revokeCapabilityGrant(adminA, {
      grantId: grantA!.id,
      note: 'sweep revocation',
    });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedBy).toBe(adminA.principalId);
    // The capability is denied again for A; B's world is untouched.
    const deniedA = await grants.invokeCapability(memberA, {
      connectionId: connectionA,
      capabilityKey: 'write.customer-records',
      taskContext: { description: 'Sweep post-revocation' },
    });
    expect(deniedA.outcome).toBe('denied');
    expect(deniedA.denial!.requestedScope[0]!.state).toBe('revoked');
    expect((await grants.getConnectionAccess(memberB, { connectionId: connectionB })).connectionMode).toBe('read-only');
  });
});
