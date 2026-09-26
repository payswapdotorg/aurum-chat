// W044 — Tenant Isolation Verification · the migration sweep (W094).
//
// The migration module (W094 — Migration and Dual-Run Continuity) owns
// tenant-scoped tables for its concepts: the migration and its
// progressive-retirement checkpoint chain, the staged import rounds, the
// EVIDENCE-shaped imported records (immutable payload/provenance), the
// external↔Aurum identifier map per source system, the identity-collision
// conflict ledger, the dual-run comparison rounds with their structured
// entries, and the append-only lifecycle events.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * a migration (and its rounds, records, map, conflicts and events) is
//     invisible to the other tenant: every read and every lifecycle call
//     through another tenant's ids is uniformly not-found (no existence
//     leak);
//   * cross-tenant lifecycle advances cannot touch another tenant's
//     migration before the not-found refusal (the status never moves);
//   * the identifier map is per source system PER TENANT: another
//     tenant's external-id resolution is not-found even for the same
//     (system key, external id) pair;
//   * each tenant's listings show exactly its own migrations, records
//     and map entries.
//
// The deep per-phase isolation cases live in the module's own suite
// (src/modules/migration/tests/); this sweep is the two-tenant proof the
// W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import * as migration from '@/modules/migration/contract';
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
import { MigrationError } from '@/modules/migration/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: MigrationError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected MigrationError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Minimal scripted backends (the sources directory + the embedded broker —
// the provider side stays behind the seams; the incumbent is the module's
// own deterministic fixture double)
// ---------------------------------------------------------------------------

class SweepDirectory implements sources.SourceTransport {
  async fetch(): Promise<sources.SourceFetchResult> {
    return {
      records: [
        {
          providerRecordId: 'sweep-dir-w094',
          kind: 'directory.system.discovered',
          payload: {
            externalId: 'sweep-incumbent',
            displayName: 'Sweep Incumbent',
            capabilityClasses: ['customer-records'],
          },
          occurredAt: '2026-09-25T10:00:00Z',
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

/** Full W081→W082 setup for one tenant: one discovered, connected system. */
async function connectIncumbent(tenantId: string): Promise<{ systemId: string; connectionId: string }> {
  const adminCtx = memberOf(tenantId, ['integration-intelligence:administer']);
  const memberCtx = memberOf(tenantId);
  const { source } = await sources.registerSource(adminCtx, {
    provider: 'notion',
    providerAccountId: `ws-${tenantId.slice(0, 8)}`,
    displayName: 'Sweep directory',
    authKind: 'oauth',
    // Fake credential fragments — assembled at runtime.
    credentialRef: ['secret-store://', 'w094-sweep/', `${tenantId.slice(0, 8)}/ref`].join(''),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await integration.grantDiscoverySource(adminCtx, { sourceId: source.id });
  await integration.runDiscovery(memberCtx, { sourceId: source.id });
  const systems = await integration.listSystems(memberCtx, {});
  const system = systems.find((entry) => entry.displayName === 'Sweep Incumbent')!;
  const initiated = await initiateConnection(memberCtx, {
    provider: 'notion',
    connectionKey: `sweep-w094-${tenantId.slice(0, 8)}`,
    displayName: 'Sweep Incumbent',
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(memberCtx, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return { systemId: system.id, connectionId: completed.connection.id };
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
  migration.setMigrationIncumbentReader(null);
  migration.setMigrationNativeReader(null);
  await closeDb();
});

describe('W044 sweep — migration (W094)', () => {
  it('the migrations, rounds, records, map and events stay per-tenant (zero leakage)', async () => {
    const adminA = memberOf(tenantA, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const reviewerA = memberOf(tenantA, [migration.MIGRATION_AUTHORITY_REVIEW]);
    const memberA = memberOf(tenantA);
    const adminB = memberOf(tenantB, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const reviewerB = memberOf(tenantB, [migration.MIGRATION_AUTHORITY_REVIEW]);
    const memberB = memberOf(tenantB);

    // Each tenant builds its own incumbent world.
    const sideA = await connectIncumbent(tenantA);
    const sideB = await connectIncumbent(tenantB);

    // The incumbent double serves BOTH tenants' records through the same
    // read-only port (per-tenant migrations read their own windows).
    const incumbent = new migration.FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
    ]);
    migration.setMigrationIncumbentReader(incumbent);

    const createdA = await migration.createMigration(adminA, {
      incumbentSystemId: sideA.systemId,
      incumbentConnectionId: sideA.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const createdB = await migration.createMigration(adminB, {
      incumbentSystemId: sideB.systemId,
      incumbentConnectionId: sideB.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    expect(createdA.migration.tenantId).toBe(tenantA);
    expect(createdB.migration.tenantId).toBe(tenantB);
    // Each tenant discovered its OWN source-scoped copy of the incumbent
    // (the system key embeds the tenant's own source id) — the map is
    // per tenant by construction, and the cross-tenant resolution checks
    // below prove the boundary holds even for the same external id.
    expect(createdA.migration.incumbentSystemKey).not.toBe(createdB.migration.incumbentSystemKey);
    expect(createdA.migration.incumbentSystemKey.endsWith(':sweep-incumbent')).toBe(true);
    expect(createdB.migration.incumbentSystemKey.endsWith(':sweep-incumbent')).toBe(true);

    // Cross-tenant reads and lifecycle calls are uniformly not-found —
    // before any state is touched, no existence leak.
    await expectCode('migration_not_found', () =>
      migration.getMigration(memberB, { migrationId: createdA.migration.id }),
    );
    await expectCode('migration_not_found', () =>
      migration.captureSnapshot(memberB, { migrationId: createdA.migration.id }),
    );
    await expectCode('migration_not_found', () =>
      migration.runComparisonRound(memberB, { migrationId: createdA.migration.id }),
    );
    await expectCode('migration_not_found', () =>
      migration.sequesterMigration(adminB, { migrationId: createdA.migration.id, reason: 'x' }),
    );
    await expectCode('migration_not_found', () =>
      migration.advanceToCompareClean(adminB, { migrationId: createdA.migration.id }),
    );
    await expectCode('migration_not_found', () =>
      migration.listMigrationEvents(memberB, { migrationId: createdA.migration.id }),
    );
    // Another tenant's external-id resolution is not-found EVEN FOR the
    // same (source system key, external id) pair.
    await expectCode('migration_not_found', () =>
      migration.resolveExternalId(memberB, {
        sourceSystemKey: createdA.migration.incumbentSystemKey,
        externalId: 'C-1',
      }),
    );
    // A's migration never moved; B's listings hold exactly B's own.
    expect(
      (await migration.getMigration(memberA, { migrationId: createdA.migration.id })).status,
    ).toBe('dual-running');
    expect(await migration.listMigrations(memberB, {})).toHaveLength(1);
    expect((await migration.listMigrations(memberB, {}))[0]!.id).toBe(createdB.migration.id);

    // Tenant A commits a full round; B sees nothing of it.
    const capturedA = await migration.captureSnapshot(memberA, {
      migrationId: createdA.migration.id,
    });
    await migration.transformImportRound(memberA, { roundId: capturedA.round.id });
    await migration.reviewImportRound(reviewerA, { roundId: capturedA.round.id });
    const commitA = await migration.commitImportRound(adminA, { roundId: capturedA.round.id });
    expect(commitA.records).toHaveLength(1);

    await expectCode('round_not_found', () =>
      migration.transformImportRound(memberB, { roundId: capturedA.round.id }),
    );
    await expectCode('round_not_found', () =>
      migration.reviewImportRound(reviewerB, { roundId: capturedA.round.id }),
    );
    await expectCode('round_not_found', () =>
      migration.commitImportRound(adminB, { roundId: capturedA.round.id }),
    );
    await expectCode('round_not_found', () =>
      migration.abandonImportRound(memberB, { roundId: capturedA.round.id }),
    );
    await expectCode('round_not_found', () =>
      migration.getImportRound(memberB, { roundId: capturedA.round.id }),
    );
    // B's record listings hold nothing of A's world (a foreign migration
    // id is uniformly not-found); A's hold its own.
    await expectCode('migration_not_found', () =>
      migration.listImportedRecords(memberB, { migrationId: createdA.migration.id }),
    );
    expect(await migration.listIdentifierMappings(memberB, {})).toEqual([]);
    expect(
      await migration.listImportedRecords(memberA, { migrationId: createdA.migration.id }),
    ).toHaveLength(1);
    expect(await migration.listIdentifierMappings(memberA, {})).toHaveLength(1);
    // A's map resolves; B's same-shaped pair does not.
    const resolvedA = await migration.resolveExternalId(memberA, {
      sourceSystemKey: createdA.migration.incumbentSystemKey,
      externalId: 'C-1',
    });
    expect(resolvedA.entry.migrationId).toBe(createdA.migration.id);
    await expectCode('migration_not_found', () =>
      migration.resolveExternalId(memberB, {
        sourceSystemKey: createdB.migration.incumbentSystemKey,
        externalId: 'C-1',
      }),
    );
    // A's committed record's provenance is intact and tenant-scoped.
    expect(commitA.records[0]!.tenantId).toBe(tenantA);
    expect(commitA.records[0]!.sourceSystemKey).toBe(createdA.migration.incumbentSystemKey);
  });
});
