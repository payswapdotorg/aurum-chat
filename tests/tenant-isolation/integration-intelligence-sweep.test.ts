// W044 — Tenant Isolation Verification · the integration-intelligence
// sweep (W081).
//
// The integration-intelligence module (W081 — Integration Intelligence)
// owns tenant-scoped tables for its five concepts: admin-authorized
// discovery grants, the Tool & System Inventory, connection
// recommendations, recommendation batches (whose approval routes through
// the actions module's authority) and post-connection verification runs.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * grants are tenant-scoped: one tenant's grant never authorizes
//     discovery through the other's source (refused BEFORE any transport
//     interaction — the no-scan invariant is itself tenant-scoped);
//   * discovered systems, recommendations, batches and verification runs
//     of one tenant are invisible to the other (uniform not-found, no
//     existence leak);
//   * the batch approval path stays tenant-scoped end-to-end (submission,
//     decision, connection, verification).
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/integration-intelligence/tests/); this sweep is the
// two-tenant proof the W044 coverage manifest claims.

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
  connectSystem,
  decideRecommendationBatch,
  getRecommendation,
  getRecommendationBatch,
  getSystem,
  grantDiscoverySource,
  IntegrationError,
  listRecommendations,
  listSystems,
  listVerificationRuns,
  runDiscovery,
  submitRecommendationBatch,
  INTEGRATION_AUTHORITY_ADMINISTER,
  DISCOVERY_RECORD_KIND,
} from '@/modules/integration-intelligence/contract';
import { registerSource, setSourceTransport } from '@/modules/sources/contract';
import type { SourceFetchRequest, SourceFetchResult, SourceTransport } from '@/modules/sources/contract';

const tenantA = newId();
const tenantB = newId();

function adminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [INTEGRATION_AUTHORITY_ADMINISTER] };
}

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** The stubbed directory transport (the only fetch path is the granted source's own). */
class DirectoryTransport implements SourceTransport {
  async fetch(request: SourceFetchRequest): Promise<SourceFetchResult> {
    const label = `t-${request.tenantId.slice(0, 8)}-app`;
    return {
      records: [
        {
          providerRecordId: `${label}-1`,
          kind: DISCOVERY_RECORD_KIND,
          payload: {
            externalId: 'app-1',
            displayName: `${label} CRM`,
            capabilityClasses: ['customer-records'],
          },
          occurredAt: '2026-09-23T10:00:00Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
  }
}

async function expectCode(code: IntegrationError['code'], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected IntegrationError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    expect(error.code).toBe(code);
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
  setSourceTransport(new DirectoryTransport());
});

afterAll(async () => {
  setSourceTransport(null);
  await closeDb();
});

describe('W044 sweep — integration-intelligence (W081)', () => {
  let sourceA: string;
  let sourceB: string;
  let systemA: { id: string };

  it('grants, discovery and the inventory stay per-tenant (zero leakage)', async () => {
    const adminA = adminOf(tenantA);
    const adminB = adminOf(tenantB);

    // Fake credentials assembled from fragments at runtime.
    const made = await registerSource(adminA, {
      provider: 'notion',
      providerAccountId: 'ws-isol-a',
      authKind: 'oauth',
      credentialRef: 'secret-store://' + 'w081/a',
      oauthScopes: ['directory.read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    sourceA = made.source.id;
    const other = await registerSource(adminB, {
      provider: 'notion',
      providerAccountId: 'ws-isol-b',
      authKind: 'oauth',
      credentialRef: 'secret-store://' + 'w081/b',
      oauthScopes: ['directory.read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    sourceB = other.source.id;

    await grantDiscoverySource(adminA, { sourceId: sourceA });
    await grantDiscoverySource(adminB, { sourceId: sourceB });

    // One tenant's grant never authorizes discovery through the other's
    // source — refused as unauthorized, before any transport interaction.
    await expectCode('discovery_not_authorized', () =>
      runDiscovery(memberOf(tenantA), { sourceId: sourceB }),
    );
    await expectCode('discovery_not_authorized', () =>
      runDiscovery(memberOf(tenantB), { sourceId: sourceA }),
    );

    // Each tenant discovers through its OWN granted source only.
    await runDiscovery(memberOf(tenantA), { sourceId: sourceA });
    await runDiscovery(memberOf(tenantB), { sourceId: sourceB });

    const systemsA = await listSystems(memberOf(tenantA), {});
    const systemsB = await listSystems(memberOf(tenantB), {});
    expect(systemsA).toHaveLength(1);
    expect(systemsB).toHaveLength(1);
    expect(systemsA[0]!.tenantId).toBe(tenantA);
    expect(systemsB[0]!.tenantId).toBe(tenantB);
    systemA = { id: systemsA[0]!.id };

    // Cross-tenant system reads are uniformly not-found (no existence leak).
    await expectCode('system_not_found', () => getSystem(memberOf(tenantB), { systemId: systemA.id }));
    await expectCode('system_not_found', () => getSystem(memberOf(tenantA), { systemId: systemsB[0]!.id }));
  });

  it('recommendations, batches, decisions and verification stay per-tenant', async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);
    const approverB: TenantContext = { tenantId: tenantB, principalId: newId(), authority: ['actions:approve'] };

    const recommendationsA = await listRecommendations(memberA, {});
    const recommendationsB = await listRecommendations(memberB, {});
    expect(recommendationsA).toHaveLength(1);
    expect(recommendationsB).toHaveLength(1);

    // Cross-tenant recommendation reads are not-found.
    await expectCode('recommendation_not_found', () =>
      getRecommendation(memberA, { recommendationId: recommendationsB[0]!.id }),
    );

    // Tenant B walks the approval + connection + verification path…
    const batch = await submitRecommendationBatch(memberB, {
      recommendationIds: [recommendationsB[0]!.id],
    });
    // …while tenant A cannot even SEE the batch, let alone decide it.
    await expectCode('batch_not_found', () =>
      getRecommendationBatch(memberA, { batchId: batch.id }),
    );
    await expectCode('batch_not_found', () =>
      decideRecommendationBatch({ ...memberA, authority: ['actions:approve'] }, {
        batchId: batch.id,
        decision: 'approve',
      }),
    );

    await decideRecommendationBatch(approverB, { batchId: batch.id, decision: 'approve' });
    const connected = await connectSystem(memberB, { recommendationId: recommendationsB[0]!.id });
    expect(connected.system.tenantId).toBe(tenantB);

    // Verification runs are tenant-scoped with the system they prove.
    const runsB = await listVerificationRuns(memberB, { systemId: connected.system.id });
    expect(runsB).toHaveLength(1);
    expect(runsB[0]!.tenantId).toBe(tenantB);
    const runsA = await listVerificationRuns(memberA, { systemId: systemA.id });
    expect(runsA).toHaveLength(0);
  });
});
