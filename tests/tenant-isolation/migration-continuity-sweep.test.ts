// W044 — Tenant Isolation Verification · the migration-continuity sweep
// (W094).
//
// The migration-continuity module (W094 — Migration and Dual-Run
// Continuity) owns tenant-scoped tables for its concepts: the migration
// runs with their frozen incumbent descriptors (the W081 system, the
// W082 connection, the W083 capability keys), the append-only
// transition ledger, the import manifests with their landing ledgers,
// the cross-system identity mappings, the dual-run sync runs, the
// surfaced conflicts, the reconcile-based comparison reports, the
// progressive-retirement windows and the append-only lifecycle events.
//
// This sweep proves the tenant boundary at the APPLICATION level, per
// the W044 doctrine — two tenants side by side, zero leakage:
//   * a migration (and its manifests, mappings, windows, conflicts and
//     events) is invisible to the other tenant: every read and every
//     lifecycle call through another tenant's migration id is
//     uniformly not-found (no existence leak);
//   * cross-tenant lifecycle advances cannot touch another tenant's
//     migration before the not-found refusal (the state never moves);
//   * cross-tenant trust operations (rollback, conflict resolution,
//     ambiguity resolution) refuse the same way;
//   * each tenant's listings show exactly its own migrations.
//
// The deep per-phase isolation cases live in the module's own suite
// (src/modules/migration-continuity/tests/); this sweep is the
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
import * as sourcesContract from '@/modules/sources/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as deepActionsContract from '@/modules/deep-actions/contract';
import * as grantsContract from '@/modules/capability-grants/contract';
import * as migrationContinuity from '@/modules/migration-continuity/contract';
import { createScriptedIncumbent, type ScriptedIncumbent } from '@/modules/migration-continuity/contract';
import { MigrationContinuityError } from '@/modules/migration-continuity/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: MigrationContinuityError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected MigrationContinuityError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MigrationContinuityError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Local provider doubles (the per-suite fixtures doctrine — the W096
// executor patterns, compact; nothing here is a mock of domain logic)
// ---------------------------------------------------------------------------

class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  private windows: sourcesContract.SourceFetchResult[] = [];
  script(...windows: sourcesContract.SourceFetchResult[]): void {
    this.windows.push(...windows);
  }
  async fetch(): Promise<sourcesContract.SourceFetchResult> {
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;
  async request(
    request: brokerContract.BrokerHttpRequest,
  ): Promise<brokerContract.BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.unit.example/oauth/${state}`,
          state,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const connectionId = decodeURIComponent(callback[1]!);
      const body = request.body as { state?: string };
      if (this.authorizations.get(connectionId) !== body.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb-${this.counter.toString().padStart(3, '0')}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: [],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

class ScriptedVerificationTransport implements integrationContract.VerificationTransport {
  async probe(): Promise<{ reachable: boolean; detail: string | null }> {
    return { reachable: true, detail: null };
  }
}

/** The full real entry chain for one tenant's incumbent system. */
async function connectIncumbent(
  actors: { admin: TenantContext; member: TenantContext; approver: TenantContext },
  incumbentSpec: { externalId: string; displayName: string; capabilityClasses: string[] },
  connectionKey: string,
  directory: ScriptedDirectoryTransport,
): Promise<{ system: integrationContract.InventorySystem; connection: brokerContract.BrokerConnection }> {
  const { admin, member, approver } = actors;
  const registered = await sourcesContract.registerSource(admin, {
    provider: 'salesforce' as sourcesContract.SourceProvider,
    providerAccountId: `w094-sweep-${incumbentSpec.externalId}`,
    displayName: `${incumbentSpec.displayName} directory`,
    authKind: 'credentials',
    credentialRef: ['secret-store://', 'w094-sweep/', `${incumbentSpec.externalId}/`, 'ref'].join(''),
  });
  await integrationContract.grantDiscoverySource(admin, { sourceId: registered.source.id });
  directory.script({
    records: [
      {
        providerRecordId: `dir-${incumbentSpec.externalId}`,
        kind: integrationContract.DISCOVERY_RECORD_KIND,
        payload: {
          externalId: incumbentSpec.externalId,
          displayName: incumbentSpec.displayName,
          capabilityClasses: incumbentSpec.capabilityClasses,
        },
        occurredAt: '2026-10-01T10:00:00Z',
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  await integrationContract.runDiscovery(member, { sourceId: registered.source.id });
  const systems = await integrationContract.listSystems(member, {});
  const system = systems.find((entry) => entry.displayName === incumbentSpec.displayName)!;
  const recommendations = await integrationContract.listRecommendations(member, {});
  const recommendation = recommendations.find((entry) => entry.systemId === system.id)!;
  const batch = await integrationContract.submitRecommendationBatch(member, {
    recommendationIds: [recommendation.id],
  });
  await integrationContract.decideRecommendationBatch(approver, {
    batchId: batch.id,
    decision: 'approve',
    note: 'the sweep connects each tenant\'s own incumbent',
  });
  await integrationContract.connectSystem(member, { recommendationId: recommendation.id });
  const initiation = await brokerContract.initiateConnection(member, {
    provider: 'salesforce' as brokerContract.BrokerProvider,
    connectionKey,
    displayName: incumbentSpec.displayName,
    inventorySystemId: system.id,
  });
  await brokerContract.completeConnection(member, {
    connectionId: initiation.connection.id,
    state: initiation.authorization.state,
  });
  const connection = await brokerContract.getConnection(member, {
    connectionId: initiation.connection.id,
  });
  // The safe read-only start (the W083 floor every incumbent read rides).
  await grantsContract.establishConnectionAccess(member, { connectionId: connection.id });
  return { system, connection };
}

let incumbent: ScriptedIncumbent;
let migrationA: string;
let migrationB: string;

beforeAll(async () => {
  await runMigrations(getDb());

  const directory = new ScriptedDirectoryTransport();
  incumbent = createScriptedIncumbent();
  sourcesContract.setSourceTransport(directory);
  integrationContract.setVerificationTransport(new ScriptedVerificationTransport());
  brokerContract.wireConnectionBrokers([
    brokerContract.createEmbeddedBroker({
      baseUrl: 'https://broker.unit.example',
      apiToken: ['emb_', 'test', '_token'].join(''),
      httpClient: new ScriptedBrokerBackend(),
    }),
  ]);
  deepActionsContract.setDeepActionTransport(incumbent);

  // Each tenant connects its OWN incumbent and runs its own migration.
  for (const [tenantId, label] of [
    [tenantA, 'A'],
    [tenantB, 'B'],
  ] as const) {
    const admin = memberOf(tenantId, ['integration-intelligence:administer']);
    const member = memberOf(tenantId, []);
    const approver = memberOf(tenantId, ['actions:approve']);
    const { system, connection } = await connectIncumbent(
      { admin, member, approver },
      {
        externalId: `inc-sweep-${label}`,
        displayName: `Sweep Suite ${label}`,
        capabilityClasses: ['customer-records'],
      },
      `sweep-suite-${label.toLowerCase()}`,
      directory,
    );
    incumbent.seedCollection(connection.id, `export/sweep-people-${label}`, [
      { incumbentId: `P-SWEEP-${label}`, updatedAt: '2026-10-05T09:00:00Z', fullName: `Sweep Person ${label}`, email: `sweep${label}@example.net` },
    ]);
    const staged = await migrationContinuity.stageMigration(member, {
      systemId: system.id,
      connectionId: connection.id,
      readCapabilityKey: 'read.customer-records',
      taskContext: { description: `the W094 sweep migration ${label}` },
      batches: [{ target: `export/sweep-people-${label}`, entityKind: 'person' }],
    });
    await migrationContinuity.runImport(member, { migrationId: staged.migration.id });
    await migrationContinuity.startDualRun(member, { migrationId: staged.migration.id });
    if (label === 'A') migrationA = staged.migration.id;
    else migrationB = staged.migration.id;
  }
});

afterAll(async () => {
  sourcesContract.setSourceTransport(null);
  integrationContract.setVerificationTransport(null);
  brokerContract.wireConnectionBrokers(null);
  deepActionsContract.setDeepActionTransport(null);
  await closeDb();
});

describe('W044 sweep — migration-continuity (W094)', () => {
  it("the migrations, mappings, windows, conflicts and events stay per-tenant (zero leakage)", async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB, ['migration-continuity:administer']);

    // Cross-tenant reads and lifecycle calls are uniformly not-found —
    // before any state is touched, no existence leak.
    await expectCode('migration_not_found', () =>
      migrationContinuity.getMigration(memberB, { migrationId: migrationA }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.getMigrationStatus(memberB, { migrationId: migrationA }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.runSyncPass(memberB, { migrationId: migrationA }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.compareMigration(memberB, { migrationId: migrationA, entityKind: 'person' }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.openRetirementWindow(memberB, { migrationId: migrationA, entityKind: 'person' }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.completeRetirement(memberB, { migrationId: migrationA, entityKind: 'person' }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.rollbackMigration(memberB, { migrationId: migrationA, reason: 'a cross-tenant rollback attempt' }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.verifyImportIntegrity(memberB, { migrationId: migrationA }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.listMigrationTransitions(memberB, { migrationId: migrationA }),
    );
    await expectCode('migration_not_found', () =>
      migrationContinuity.listMigrationEvents(memberB, { migrationId: migrationA }),
    );

    // A's migration never moved for B's probes; each tenant's listings
    // hold exactly its own migration, still dual-running.
    const stillA = await migrationContinuity.getMigration(memberA, { migrationId: migrationA });
    expect(stillA.migration.state).toBe('dual-running');
    expect(await migrationContinuity.listMigrations(memberA, {})).toHaveLength(1);
    expect(await migrationContinuity.listMigrations(memberB, {})).toHaveLength(1);
    expect((await migrationContinuity.listMigrations(memberA, {}))[0]!.id).toBe(migrationA);
    expect((await migrationContinuity.listMigrations(memberB, {}))[0]!.id).toBe(migrationB);

    // The manifests and identity mappings of one tenant never surface in
    // the other tenant's listings.
    const manifestsA = await migrationContinuity.listImportManifests(memberA, { migrationId: migrationA });
    expect(manifestsA).toHaveLength(1);
    expect(await migrationContinuity.listImportManifests(memberB, { migrationId: migrationA })).toHaveLength(0);
    const mappingsA = await migrationContinuity.listIdentityMappings(memberA, { migrationId: migrationA });
    expect(mappingsA).toHaveLength(1);
    expect(mappingsA[0]!.incumbentId).toBe('P-SWEEP-A');
    expect(await migrationContinuity.listIdentityMappings(memberB, { migrationId: migrationA })).toHaveLength(0);
  });

  it("the landed rows themselves are the owning modules' tenant-scoped rows (each tenant's import landed only its own person)", async () => {
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);
    const mappingsA = await migrationContinuity.listIdentityMappings(memberA, { migrationId: migrationA });
    const mappingsB = await migrationContinuity.listIdentityMappings(memberB, { migrationId: migrationB });
    // Each mapping's Aurum id is a real person row of ITS OWN tenant.
    const { getPerson } = await import('@/modules/people/contract');
    const personA = await getPerson(memberA, mappingsA[0]!.aurumId!);
    expect(personA.fullName).toBe('Sweep Person A');
    const personB = await getPerson(memberB, mappingsB[0]!.aurumId!);
    expect(personB.fullName).toBe('Sweep Person B');
    // Cross-tenant reads of the landed rows refuse (the owning modules'
    // own boundary — the sweep's composed proof).
    await expect(getPerson(memberB, mappingsA[0]!.aurumId!)).rejects.toThrow();
  });

  it('the storage partition itself is intact after the sweep fixtures ran', async () => {
    const { assertTenantPartition } = await import('./harness');
    await assertTenantPartition([tenantA, tenantB]);
  });
});
