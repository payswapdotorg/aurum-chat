// Integration tests for the migration module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W094
// acceptance end-to-end:
//
// "customer can run incumbent and Aurum in parallel; conflicts are
//  surfaced; rollback is possible; no silent data loss or duplicate
//  authority."
//
//  * THE DUAL-RUN JOURNEY — an incumbent discovered through W081 and
//    connected through W082 (embedded broker, scripted backend); a full
//    import round walks snapshot → transform → review → commit with the
//    fixture incumbent; every committed record carries its full
//    provenance; the external↔Aurum map resolves; the incumbent CHURNS
//    and a delta round imports updates, additions and a tombstone (the
//    re-issued external id keeps its Aurum identity — identifiers
//    preserved); comparison rounds surface SEEDED divergences as
//    structured entries with deterministic reasons; after the native
//    side converges a clean comparison justifies the retirement
//    checkpoints (compare-clean → incumbent-read-only →
//    incumbent-retired), and the identifier map stays live after
//    retirement;
//
//  * CONFLICTS ARE SURFACED — a cross-system collision (two incumbent
//    systems claiming the same natural key) raises an explicit conflict
//    record and links NOTHING until a human resolves it; the ambiguous
//    multi-entity case raises its own kind; resolution creates the map
//    entry through an audited decision;
//
//  * ROLLBACK IS POSSIBLE — sequestration quarantines the committed
//    imports (excluded from live queries, retained in the audit view,
//    rows never deleted), force-abandons open rounds, and leaves native
//    Aurum state untouched; a fresh migration for the same system mints
//    fresh identifiers while the sequestered ones remain as audit;
//
//  * NO SILENT DATA LOSS — an abandoned round's window is re-read by the
//    next round; the transform surfaces issues without dropping records;
//    verification divergences are recorded, never swallowed;
//
//  * NO DUPLICATE AUTHORITY / NO WRITE-BACK — the module's incumbent
//    port is read-only by construction, and a canary verification
//    transport whose EXECUTE side throws proves the module never invokes
//    it; the W088 composition is exercised for real (an edge runtime
//    built from the edge-connector contract's own deterministic doubles
//    serves the verification reads through signed edge jobs);
//
//  * THE W092 COMPOSITION — a kit-bound migration validates against the
//    installed kit's declared integration and schema hints;
//
//  * STATE DISCIPLINE — phase calls out of order, open-round blocks,
//    unwired readers, authority claims, unknown ids, idempotent create
//    replay, one-live-migration-per-system;
//
//  * STORAGE DISCIPLINE — the events ledger is append-only
//    (UPDATE/DELETE/TRUNCATE refused at the storage level) and imported
//    records' payload/provenance columns are immutable (the trigger
//    rejects evidence mutation; the workflow columns still move).
//
//  * TENANT ISOLATION — two tenants, zero leakage (the deep per-op
//    matrix lives in the tenant-isolation sweep; here the lifecycle
//    boundary).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as sourcesContract from '@/modules/sources/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as verticalKits from '@/modules/vertical-kits/contract';
import * as edgeConnector from '@/modules/edge-connector/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { MigrationError } from '../errors';
import * as migration from '../contract';
import type {
  DeepActionInspectRequest,
  DeepActionReceipt,
  DeepActionState,
  DeepActionTransport,
} from '@/modules/deep-actions/contract';

const {
  grantDiscoverySource,
  listSystems,
  runDiscovery,
} = integrationContract;
const { registerSource, setSourceTransport } = sourcesContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;

const {
  createMigration,
  captureSnapshot,
  transformImportRound,
  reviewImportRound,
  commitImportRound,
  abandonImportRound,
  resolveExternalId,
  resolveIdentityConflict,
  runComparisonRound,
  advanceToCompareClean,
  advanceToIncumbentReadOnly,
  retireIncumbent,
  sequesterMigration,
  getMigration,
  listMigrations,
  getImportRound,
  listImportRounds,
  listImportedRecords,
  listIdentifierMappings,
  listIdentityConflicts,
  getComparisonRound,
  listComparisonRounds,
  listMigrationEvents,
  listCurrentImportedStates,
  setMigrationIncumbentReader,
  setMigrationNativeReader,
  setMigrationVerificationTransport,
  FixtureIncumbent,
  FixtureNativeStore,
  MIGRATION_AUTHORITY_ADMINISTER,
  MIGRATION_AUTHORITY_REVIEW,
} = migration;

// A FRESH tenant per test so counts stay deterministic.
function freshTenant(): string {
  return newId();
}

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function migrationAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [MIGRATION_AUTHORITY_ADMINISTER] };
}

function reviewerOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [MIGRATION_AUTHORITY_REVIEW] };
}

function integrationAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['integration-intelligence:administer'] };
}

function edgeAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['edge-connector:administer'] };
}

function kitAdminOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['vertical-kits:administer'] };
}

function approverOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectMigrationError(
  code: MigrationError['code'],
  fn: () => Promise<unknown>,
): Promise<MigrationError> {
  try {
    await fn();
    throw new Error(`expected MigrationError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

// ---------------------------------------------------------------------------
// The W081→W082 fixtures (exactly the deep-actions module's own test
// discipline — the composed chain runs against REAL contracts)
// ---------------------------------------------------------------------------

class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  readonly fetches: unknown[] = [];

  async fetch(request: unknown): Promise<sourcesContract.SourceFetchResult> {
    this.fetches.push(request);
    // The directory ALWAYS answers with the full incumbent listing (the
    // sweep pattern — every authorized poll sees both systems).
    return {
      records: [
        directoryRecord('w094-crm', 'W094 Legacy CRM', ['customer-records']),
        directoryRecord('w094-billing', 'W094 Legacy Billing', ['customer-records']),
      ],
      nextCursor: null,
      hasMore: false,
    };
  }
}

class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(request: brokerContract.BrokerHttpRequest): Promise<brokerContract.BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.w094.example/oauth/${state}`,
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
          scopes: ['read'],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

function directoryRecord(
  externalId: string,
  displayName: string,
  capabilityClasses: string[],
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${externalId}`,
    kind: 'directory.system.discovered',
    payload: { externalId, displayName, capabilityClasses },
    occurredAt: '2026-09-25T10:00:00Z',
  };
}

/**
 * Discovers + connects one incumbent system for a tenant: one directory
 * record, one granted discovery run, one completed broker connection.
 */
async function connectIncumbentSystem(
  tenantId: string,
  options: { externalId: string; displayName: string; connectionSuffix?: string },
): Promise<{ systemId: string; systemKey: string; connectionId: string }> {
  const admin = integrationAdminOf(tenantId);
  const member = memberOf(tenantId);
  const { source } = await registerSource(admin, {
    provider: 'notion',
    providerAccountId: `w094-${options.externalId}-${tenantId.slice(0, 8)}`,
    displayName: `W094 directory ${options.externalId}`,
    authKind: 'oauth',
    credentialRef: ['secret-store://', 'w094/', `${options.externalId}/ref`].join(''),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await grantDiscoverySource(admin, { sourceId: source.id });
  await runDiscovery(member, { sourceId: source.id });
  const systems = await listSystems(member, {});
  const system = systems.find((entry) => entry.displayName === options.displayName);
  if (system === undefined) {
    throw new Error(`the scripted directory did not surface '${options.displayName}'`);
  }
  const initiated = await initiateConnection(member, {
    provider: 'notion',
    connectionKey: `w094-${options.externalId}-${options.connectionSuffix ?? ''}-${tenantId.slice(0, 8)}`,
    displayName: options.displayName,
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(member, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return {
    systemId: system.id,
    systemKey: system.systemKey,
    connectionId: completed.connection.id,
  };
}

// ---------------------------------------------------------------------------
// The module's port doubles (the provider side behind the seams)
// ---------------------------------------------------------------------------

/** The canary verification transport: its EXECUTE side throws — proving
 *  the module never invokes it (no write-back through this module). */
class CanaryVerificationTransport implements DeepActionTransport {
  readonly inspectRequests: DeepActionInspectRequest[] = [];
  /** When set, inspect answers with this state instead of the staged payload. */
  divergeOn = new Set<string>();
  notFound = new Set<string>();
  private readonly states = new Map<string, unknown>();

  seed(target: string, state: unknown): void {
    this.states.set(target, state);
  }

  async inspect(request: DeepActionInspectRequest): Promise<DeepActionState> {
    this.inspectRequests.push(request);
    if (this.notFound.has(request.target)) {
      return { found: false, state: null };
    }
    if (this.divergeOn.has(request.target)) {
      return { found: true, state: { diverged: true } };
    }
    const state = this.states.get(request.target);
    return { found: state !== undefined, state: state ?? null };
  }

  async execute(): Promise<DeepActionReceipt> {
    throw new Error(
      'CANARY: the migration module must never execute a write against the incumbent through the verification transport',
    );
  }
}

/** Walks one import round through the whole staged lifecycle. */
async function walkRound(
  tenantId: string,
  migrationId: string,
): Promise<{ roundId: string; commit: migration.CommitImportRoundResult }> {
  const admin = migrationAdminOf(tenantId);
  const reviewer = reviewerOf(tenantId);
  const captured = await captureSnapshot(memberOf(tenantId), { migrationId });
  await transformImportRound(memberOf(tenantId), { roundId: captured.round.id });
  await reviewImportRound(reviewer, { roundId: captured.round.id });
  const commit = await commitImportRound(admin, { roundId: captured.round.id });
  return { roundId: captured.round.id, commit };
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

let directory: ScriptedDirectoryTransport;

beforeAll(async () => {
  await runMigrations(getDb());
  directory = new ScriptedDirectoryTransport();
  setSourceTransport(directory);
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.w094.example',
      apiToken: ['embedded_tok_', 'w094', '_fragment'].join(''),
      httpClient: new ScriptedBrokerBackend(),
    }),
  ]);
});

afterAll(async () => {
  setSourceTransport(null);
  wireConnectionBrokers(null);
  setMigrationIncumbentReader(null);
  setMigrationNativeReader(null);
  setMigrationVerificationTransport(null);
  edgeConnector.wireEdgeSigner(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The dual-run journey (the acceptance core)
// ---------------------------------------------------------------------------

describe('the dual-run journey (parallel incumbent and Aurum)', () => {
  it('walks import → identifiers → delta → comparison → retirement with every link readable', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const reviewer = reviewerOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-100', matchKey: 'cust-100', entityType: 'customer', payload: { stage: 'active', seats: 10 } },
      { externalId: 'C-200', matchKey: 'cust-200', entityType: 'customer', payload: { stage: 'onboarding' } },
      { externalId: 'C-300', matchKey: 'cust-300', entityType: 'customer', payload: { stage: 'active', seats: 3 } },
    ]);
    setMigrationIncumbentReader(incumbent);
    const native = new FixtureNativeStore();
    setMigrationNativeReader(native);

    const { systemId, systemKey, connectionId } = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });

    // -- creation freezes the incumbent relationship --------------------
    const created = await createMigration(admin, {
      incumbentSystemId: systemId,
      incumbentConnectionId: connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    expect(created.created).toBe(true);
    expect(created.migration.status).toBe('dual-running');
    expect(created.migration.incumbentSystemKey).toBe(systemKey);
    // An identical live migration replays idempotently; a different one
    // is refused (one live migration per incumbent system).
    const replay = await createMigration(admin, {
      incumbentSystemId: systemId,
      incumbentConnectionId: connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    expect(replay.created).toBe(false);
    expect(replay.migration.id).toBe(created.migration.id);

    // -- the full import round ------------------------------------------
    const migrationId = created.migration.id;
    const captured = await captureSnapshot(member, { migrationId });
    expect(captured.round.kind).toBe('full');
    expect(captured.round.status).toBe('snapshotted');
    expect(captured.round.rawRecordCount).toBe(3);
    expect(captured.records.map((record) => record.externalId)).toEqual(['C-100', 'C-200', 'C-300']);
    // The opaque credentialRef passed straight through to the reader
    // (never stored, never interpreted).
    expect(incumbent.requests[0]!.credentialRef).toMatch(/^embedded-connection:emb-/);
    expect(incumbent.requests[0]!.systemKey).toBe(systemKey);

    await transformImportRound(member, { roundId: captured.round.id });
    await reviewImportRound(reviewer, { roundId: captured.round.id });
    const commit = await commitImportRound(admin, { roundId: captured.round.id });
    expect(commit.round.status).toBe('committed');
    expect(commit.round.verification).toBe('not-wired');

    // Every committed record carries its full provenance.
    for (const record of commit.records) {
      expect(record.sourceSystemKey).toBe(systemKey);
      expect(record.snapshotRef).toBe(captured.round.snapshotRef);
      expect(record.roundId).toBe(captured.round.id);
      expect(record.disposition).toBe('new');
      expect(record.aurumEntityId).not.toBeNull();
    }

    // The identifier map: three external ids → three Aurum entities.
    expect(commit.mapEntries).toHaveLength(3);
    const resolution = await resolveExternalId(member, {
      sourceSystemKey: systemKey,
      externalId: 'C-100',
    });
    expect(resolution.entry.aurumEntityId).toBe(
      commit.records.find((record) => record.externalId === 'C-100')!.aurumEntityId,
    );
    expect(resolution.currentState?.payload).toEqual({ stage: 'active', seats: 10 });

    // -- the incumbent churns; a delta round imports the changes --------
    incumbent.churn({
      upserts: [
        { externalId: 'C-200', matchKey: 'cust-200', entityType: 'customer', payload: { stage: 'active' } },
        { externalId: 'C-400', matchKey: 'cust-400', entityType: 'customer', payload: { stage: 'onboarding' } },
        // A RE-ISSUED external id for an existing customer (the incumbent
        // re-created the record under a new id): the Aurum identity is
        // preserved through the natural key.
        { externalId: 'C-100R', matchKey: 'cust-100', entityType: 'customer', payload: { stage: 'active', seats: 11 } },
      ],
      deletions: ['C-300'],
      deletedAt: '2026-09-26T09:00:00Z',
    });

    const delta = await captureSnapshot(member, { migrationId });
    expect(delta.round.kind).toBe('delta');
    expect(delta.round.sinceSnapshotRef).toBe(captured.round.snapshotRef);
    expect(delta.round.snapshotRef).not.toBe(captured.round.snapshotRef);
    const deltaIds = delta.records.map((record) => record.externalId).sort();
    expect(deltaIds).toEqual(['C-100R', 'C-200', 'C-300', 'C-400']);
    await transformImportRound(member, { roundId: delta.round.id });
    await reviewImportRound(reviewer, { roundId: delta.round.id });
    const deltaCommit = await commitImportRound(admin, { roundId: delta.round.id });

    const byDisposition = new Map(
      deltaCommit.records.map((record) => [record.externalId, record]),
    );
    expect(byDisposition.get('C-200')!.disposition).toBe('update');
    expect(byDisposition.get('C-400')!.disposition).toBe('new');
    expect(byDisposition.get('C-100R')!.disposition).toBe('matched');
    // Identifiers preserved across the re-issue: C-100R resolves to the
    // SAME Aurum entity C-100 minted.
    expect(byDisposition.get('C-100R')!.aurumEntityId).toBe(resolution.entry.aurumEntityId);
    // The tombstone: the map entry stays (identifiers survive deletion),
    // the current imported state is tombstoned.
    expect(byDisposition.get('C-300')!.disposition).toBe('tombstone');
    expect(byDisposition.get('C-300')!.aurumEntityId).toBe(
      commit.records.find((record) => record.externalId === 'C-300')!.aurumEntityId,
    );
    const tombstoned = await resolveExternalId(member, {
      sourceSystemKey: systemKey,
      externalId: 'C-300',
    });
    expect(tombstoned.currentState?.tombstone).toBe(true);
    expect(tombstoned.currentState?.payload).toBeNull();

    // The current imported state per entity (the dual-run view). The
    // tombstoned entity is excluded by default (the live view) and
    // included on request (the audit view).
    const states = await listCurrentImportedStates(member, { migrationId });
    expect(states).toHaveLength(3);
    const stateByEntity = new Map(states.map((state) => [state.externalId, state]));
    expect(stateByEntity.get('C-100R')!.payload).toEqual({ stage: 'active', seats: 11 });
    expect(stateByEntity.get('C-100')).toBeUndefined(); // superseded by the re-issue
    const withTombstones = await listCurrentImportedStates(member, {
      migrationId,
      includeTombstoned: true,
    });
    expect(withTombstones).toHaveLength(4);
    expect(
      withTombstones.find((state) => state.externalId === 'C-300')!.tombstone,
    ).toBe(true);

    // -- the comparison surfaces seeded divergences ----------------------
    const mapForMirror = commit.mapEntries.concat(deltaCommit.mapEntries)
      .map((entry) => ({ externalId: entry.externalId, aurumEntityId: entry.aurumEntityId }));
    native.mirror(
      incumbent,
      mapForMirror,
      [
        { externalId: 'C-100R', override: { stage: 'churned' } },
        { externalId: 'C-400', override: {}, remove: ['stage'] },
      ],
    );
    // A native-only entity the incumbent never imported.
    native.setEntity('aurum-native-only-1', { stage: 'active' });
    // The native side still HOLDS the entity the incumbent tombstoned
    // (the incumbent-deleted divergence).
    native.setEntity(
      commit.records.find((record) => record.externalId === 'C-300')!.aurumEntityId!,
      { stage: 'active', seats: 3 },
    );

    const divergent = await runComparisonRound(member, {
      migrationId,
      note: 'W094 dual-run comparison with seeded divergences',
    });
    expect(divergent.round.comparedEntityCount).toBe(5);
    expect(divergent.round.agreementCount).toBe(1); // C-200 only
    expect(divergent.round.divergenceCount).toBe(4);
    const byEntity = new Map(divergent.entries.map((entry) => [entry.aurumEntityId, entry]));
    const c100 = byEntity.get(resolution.entry.aurumEntityId)!;
    expect(c100.kind).toBe('divergence');
    expect(c100.mismatches).toEqual([
      { path: 'stage', expected: 'active', actual: 'churned' },
    ]);
    expect(c100.reason).toContain("field 'stage' diverges (incumbent-imported 'active' vs native 'churned')");
    const c400Entity = deltaCommit.records.find((record) => record.externalId === 'C-400')!.aurumEntityId!;
    const c400 = byEntity.get(c400Entity)!;
    expect(c400.kind).toBe('divergence');
    expect(c400.incumbentOnlyFields).toEqual([{ field: 'stage', value: 'onboarding' }]);
    const c300Entity = byEntity.get(
      commit.records.find((record) => record.externalId === 'C-300')!.aurumEntityId!,
    )!;
    expect(c300Entity.kind).toBe('incumbent-deleted');
    expect(byEntity.get('aurum-native-only-1')!.kind).toBe('incumbent-missing');

    // Divergences are SURFACED and retrievable — the structured report.
    const report = await getComparisonRound(member, { comparisonRoundId: divergent.round.id });
    expect(report.entries).toHaveLength(5);
    expect(report.round.note).toBe('W094 dual-run comparison with seeded divergences');

    // The retirement checkpoints REQUIRE the clean evidence.
    await expectMigrationError('compare_clean_required', () =>
      advanceToCompareClean(admin, { migrationId }),
    );

    // -- the native side converges; a clean round justifies retirement ---
    native.mirror(incumbent, mapForMirror);
    native.removeEntity('aurum-native-only-1');
    // The tombstoned entity: the native side drops it too — both agree.
    native.removeEntity(
      commit.records.find((record) => record.externalId === 'C-300')!.aurumEntityId!,
    );
    const clean = await runComparisonRound(member, { migrationId, note: 'converged' });
    expect(clean.round.divergenceCount).toBe(0);
    expect(clean.round.agreementCount).toBe(4);

    const compareClean = await advanceToCompareClean(admin, { migrationId });
    expect(compareClean.status).toBe('compare-clean');
    expect(compareClean.compareCleanRoundId).toBe(clean.round.id);
    const readOnly = await advanceToIncumbentReadOnly(admin, { migrationId });
    expect(readOnly.status).toBe('incumbent-read-only');
    expect(readOnly.readOnlyAt).not.toBeNull();
    const retired = await retireIncumbent(admin, { migrationId });
    expect(retired.status).toBe('incumbent-retired');
    expect(retired.retiredAt).not.toBeNull();

    // After retirement the identifier map stays LIVE (identifiers are
    // preserved forever — historical references keep resolving).
    const postRetirement = await resolveExternalId(member, {
      sourceSystemKey: systemKey,
      externalId: 'C-100R',
    });
    expect(postRetirement.entry.aurumEntityId).toBe(resolution.entry.aurumEntityId);

    // The audit trail carries the whole journey, evidence-linked.
    const events = await listMigrationEvents(member, { migrationId, limit: 500 });
    const eventTypes = events.map((event) => event.event);
    expect(eventTypes).toContain('created');
    expect(eventTypes).toContain('snapshot-captured');
    expect(eventTypes).toContain('transformed');
    expect(eventTypes).toContain('reviewed');
    expect(eventTypes).toContain('committed');
    expect(eventTypes).toContain('comparison-completed');
    expect(eventTypes).toContain('compare-clean-checkpoint');
    expect(eventTypes).toContain('incumbent-read-only-checkpoint');
    expect(eventTypes).toContain('incumbent-retired');
    const checkpoint = events.find((event) => event.event === 'compare-clean-checkpoint')!;
    expect(checkpoint.comparisonRoundId).toBe(clean.round.id);
  });
});

// ---------------------------------------------------------------------------
// Conflicts surfaced, never auto-merged
// ---------------------------------------------------------------------------

describe('identity conflicts (collisions surfaced, never auto-merged)', () => {
  it('a cross-system collision raises an explicit conflict and links nothing until a human resolves', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const member = memberOf(tenant);

    // TWO incumbent systems, both holding a customer with natural key
    // 'shared-cust-1' under different external ids.
    const crm = new FixtureIncumbent([
      { externalId: 'CRM-1', matchKey: 'shared-cust-1', entityType: 'customer', payload: { stage: 'active' } },
    ]);
    const billing = new FixtureIncumbent([
      { externalId: 'BIL-1', matchKey: 'shared-cust-1', entityType: 'customer', payload: { stage: 'active', region: 'eu' } },
    ]);
    const crmSide = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const billingSide = await connectIncumbentSystem(tenant, {
      externalId: 'w094-billing',
      displayName: 'W094 Legacy Billing',
    });

    // The CRM migration commits first: its record mints a fresh entity.
    setMigrationIncumbentReader(crm);
    const crmMigration = (
      await createMigration(admin, {
        incumbentSystemId: crmSide.systemId,
        incumbentConnectionId: crmSide.connectionId,
        incumbentReadCapabilityKey: 'read.customer-records',
      })
    ).migration;
    const crmCommit = (await walkRound(tenant, crmMigration.id)).commit;
    expect(crmCommit.records[0]!.disposition).toBe('new');
    const crmEntity = crmCommit.records[0]!.aurumEntityId!;

    // The billing migration commits the SAME natural key from ANOTHER
    // system: a cross-system collision — surfaced, never auto-merged.
    setMigrationIncumbentReader(billing);
    const billingMigration = (
      await createMigration(admin, {
        incumbentSystemId: billingSide.systemId,
        incumbentConnectionId: billingSide.connectionId,
        incumbentReadCapabilityKey: 'read.customer-records',
      })
    ).migration;
    const billingCommit = (await walkRound(tenant, billingMigration.id)).commit;
    const billingRecord = billingCommit.records[0]!;
    expect(billingRecord.disposition).toBe('conflicted');
    expect(billingRecord.aurumEntityId).toBeNull(); // NOTHING linked
    expect(billingCommit.conflicts).toHaveLength(1);
    const conflict = billingCommit.conflicts[0]!;
    expect(conflict.kind).toBe('cross-system-collision');
    expect(conflict.candidates).toEqual([
      {
        sourceSystemKey: crmSide.systemKey,
        externalId: 'CRM-1',
        aurumEntityId: crmEntity,
        migrationId: crmMigration.id,
      },
    ]);

    // The conflict is retrievable and open.
    const open = await listIdentityConflicts(member, { migrationId: billingMigration.id, status: 'open' });
    expect(open).toHaveLength(1);
    const fetched = await migration.getIdentityConflict(member, { conflictId: conflict.id });
    expect(fetched.status).toBe('open');

    // A human resolves: the billing external id maps to a DIFFERENT Aurum
    // entity (the tenant's deliberate decision — a separate billing
    // profile), through an audited decision.
    const resolvedEntity = newId();
    const resolved = await resolveIdentityConflict(admin, {
      conflictId: conflict.id,
      aurumEntityId: resolvedEntity,
      note: 'the billing profile stays a separate entity by deliberate decision',
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionAurumEntityId).toBe(resolvedEntity);
    // The record now carries its link; the map resolves.
    const resolvedResolution = await resolveExternalId(member, {
      sourceSystemKey: billingSide.systemKey,
      externalId: 'BIL-1',
    });
    expect(resolvedResolution.entry.aurumEntityId).toBe(resolvedEntity);
    expect(resolvedResolution.entry.origin).toBe('conflict-resolution');
    // An already-resolved conflict cannot be re-resolved.
    await expectMigrationError('conflict_not_open', () =>
      resolveIdentityConflict(admin, { conflictId: conflict.id, aurumEntityId: resolvedEntity }),
    );

    // The AMBIGUOUS case: another billing record with the same natural
    // key now faces TWO candidate entities (the CRM one and the resolved
    // billing one) — ambiguous, never auto-merged.
    billing.seed([
      { externalId: 'BIL-2', matchKey: 'shared-cust-1', entityType: 'customer', payload: { stage: 'active' } },
    ]);
    billing.churn({ upserts: [], deletions: [], deletedAt: '2026-09-27T09:00:00Z' });
    // ^ churn with no changes still commits a version; seed+version:
    billing.commitVersion();
    const second = await captureSnapshot(member, { migrationId: billingMigration.id });
    expect(second.records.map((record) => record.externalId)).toEqual(['BIL-2']);
    await transformImportRound(member, { roundId: second.round.id });
    await reviewImportRound(reviewerOf(tenant), { roundId: second.round.id });
    const secondCommit = await commitImportRound(admin, { roundId: second.round.id });
    const secondRecord = secondCommit.records[0]!;
    expect(secondRecord.disposition).toBe('conflicted');
    expect(secondCommit.conflicts[0]!.kind).toBe('ambiguous-match');
    expect(secondCommit.conflicts[0]!.candidates).toHaveLength(2);
  });

  it('refuses a second live migration for the same incumbent system with a different configuration', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    setMigrationIncumbentReader(
      new FixtureIncumbent([
        { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { a: 1 } },
      ]),
    );
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    await connectIncumbentSystem(tenant, {
      externalId: 'w094-billing',
      displayName: 'W094 Legacy Billing',
    });
    const other = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
      connectionSuffix: 'alt',
    });
    // A different connection for the SAME system: refused.
    await expectMigrationError('live_migration_exists', () =>
      createMigration(admin, {
        incumbentSystemId: side.systemId,
        incumbentConnectionId: other.connectionId,
        incumbentReadCapabilityKey: 'read.customer-records',
      }),
    );
    expect(other.connectionId).not.toBe(side.connectionId);
  });
});

// ---------------------------------------------------------------------------
// Rollback (sequestration)
// ---------------------------------------------------------------------------

describe('rollback (sequestration quarantines, never deletes)', () => {
  it('excludes the committed imports from live queries while the audit view retains everything', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
      { externalId: 'C-2', matchKey: 'k-2', entityType: null, payload: { stage: 'onboarding' } },
    ]);
    setMigrationIncumbentReader(incumbent);
    const native = new FixtureNativeStore();
    setMigrationNativeReader(native);
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const migrationId = created.migration.id;
    const first = await walkRound(tenant, migrationId);
    expect(first.commit.records).toHaveLength(2);

    // An open round exists when the rollback lands: it is force-abandoned
    // (rollback stays available; its records retained as evidence).
    await captureSnapshot(member, { migrationId });

    native.mirror(incumbent, first.commit.mapEntries);
    const before = await runComparisonRound(member, { migrationId });

    const sequestered = await sequesterMigration(admin, {
      migrationId,
      reason: 'the incumbent data quality failed review — rollback to re-baseline',
    });
    expect(sequestered.status).toBe('sequestered');
    expect(sequestered.sequesterReason).toContain('failed review');

    // LIVE queries exclude the quarantined imports.
    expect(await listImportedRecords(member, { migrationId })).toEqual([]);
    await expectMigrationError('migration_not_found', () =>
      resolveExternalId(member, { sourceSystemKey: side.systemKey, externalId: 'C-1' }),
    );
    expect(await listIdentifierMappings(member, { migrationId })).toEqual([]);
    expect(
      await listImportedRecords(member, { migrationId, includeSequestered: true }),
    ).toHaveLength(2);
    // The evidence rows themselves are INTACT (never deleted) — the audit
    // view still shows the payload and provenance.
    const auditRecords = await listImportedRecords(member, {
      migrationId,
      includeSequestered: true,
    });
    expect(auditRecords.map((record) => record.payload)).toEqual([
      { stage: 'active' },
      { stage: 'onboarding' },
    ]);
    expect(auditRecords.every((record) => record.state === 'committed')).toBe(true);
    // The force-abandoned open round is visible in the audit view.
    const rounds = await listImportRounds(member, { migrationId });
    expect(rounds.map((round) => round.status).sort()).toEqual(['abandoned', 'committed']);

    // Native Aurum state was never touched: the module holds no write
    // path into it (the fixture native store is exactly as mirrored).
    expect(native.entityIds()).toHaveLength(2);

    // Sequester is terminal: no further rounds, no un-sequester.
    await expectMigrationError('migration_not_pending_status', () =>
      captureSnapshot(member, { migrationId }),
    );
    await expectMigrationError('migration_not_pending_status', () =>
      runComparisonRound(member, { migrationId }),
    );
    await expectMigrationError('migration_not_pending_status', () =>
      sequesterMigration(admin, { migrationId, reason: 'again' }),
    );

    // A FRESH migration for the same system is the roll-forward path: it
    // mints fresh identifiers (the sequestered ones remain as audit).
    const fresh = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    expect(fresh.created).toBe(true);
    expect(fresh.migration.id).not.toBe(migrationId);
    const freshCommit = (await walkRound(tenant, fresh.migration.id)).commit;
    expect(freshCommit.records).toHaveLength(2);
    expect(freshCommit.records[0]!.aurumEntityId).not.toBe(
      first.commit.records[0]!.aurumEntityId,
    );
    const freshResolution = await resolveExternalId(member, {
      sourceSystemKey: side.systemKey,
      externalId: 'C-1',
    });
    expect(freshResolution.entry.migrationId).toBe(fresh.migration.id);
    // The comparison rounds of the sequestered migration remain readable.
    const comparisons = await listComparisonRounds(member, { migrationId });
    expect(comparisons.map((round) => round.id)).toContain(before.round.id);
  });
});

// ---------------------------------------------------------------------------
// The no-write-back canary + verification divergences (W084/W088)
// ---------------------------------------------------------------------------

describe('the verification transport (the W084/W088 composition)', () => {
  it('verifies each staged record at commit and NEVER executes a write (the canary)', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const reviewer = reviewerOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
      { externalId: 'C-2', matchKey: 'k-2', entityType: null, payload: { stage: 'onboarding' } },
    ]);
    setMigrationIncumbentReader(incumbent);
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });

    const canary = new CanaryVerificationTransport();
    canary.seed('C-1', { stage: 'active' });
    canary.seed('C-2', { stage: 'onboarding' });
    canary.divergeOn.add('C-2'); // the verification read diverges for C-2
    setMigrationVerificationTransport(canary);

    const captured = await captureSnapshot(member, { migrationId: created.migration.id });
    await transformImportRound(member, { roundId: captured.round.id });
    await reviewImportRound(reviewer, { roundId: captured.round.id });
    const commit = await commitImportRound(admin, { roundId: captured.round.id });

    // The verification reads rode the transport for every live record.
    expect(canary.inspectRequests.map((request) => request.target).sort()).toEqual(['C-1', 'C-2']);
    expect(canary.inspectRequests[0]!.capabilityKey).toBe('read.customer-records');
    expect(canary.inspectRequests[0]!.systemKey).toBe(side.systemKey);
    // The canary NEVER threw: no execute() call ever happened (the module
    // never writes back to the incumbent through this or any path).
    expect(commit.round.verification).toBe('divergent');
    expect(commit.round.verifiedCount).toBe(1);
    expect(commit.round.divergentCount).toBe(1);
    // The divergent record is STILL COMMITTED (evidence, never dropped)
    // and the divergence is surfaced in the audit feed.
    expect(commit.records.every((record) => record.state === 'committed')).toBe(true);
    const events = await listMigrationEvents(member, { migrationId: created.migration.id });
    expect(events.map((event) => event.event)).toContain('verification-divergence');
    setMigrationVerificationTransport(null);
  });

  it('composes the Edge Connector boundary for private/on-prem incumbents (real edge jobs)', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const reviewer = reviewerOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'cust-1042', matchKey: 'k-1042', entityType: null, payload: { stage: 'onboarding' } },
    ]);
    setMigrationIncumbentReader(incumbent);
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });

    // A REAL edge runtime, built from the edge-connector contract's own
    // deterministic doubles: the verification reads ride signed edge jobs
    // against the private-API store (the W088 composition — no live
    // network, the fixtures/doubles doctrine).
    const KEY_ID = 'key-2026-w094';
    const KEY_MATERIAL = ['edge-enroll-', 'w094', '-material'].join('');
    const edgeAdmin = edgeAdminOf(tenant);
    edgeConnector.wireEdgeSigner(
      edgeConnector.createHmacSigner({ secretKeys: { [KEY_ID]: KEY_MATERIAL } }),
    );
    const detail = await edgeConnector.registerEdgeRuntime(edgeAdmin, {
      name: 'Plant incumbent edge',
      signingKeyId: KEY_ID,
      connectivity: ['private-api'],
      allowlist: [
        {
          capabilityKey: 'read.customer-records',
          mode: 'read',
          connectivity: 'private-api',
          secretRef: 'edge-vault://w094-read',
          secretScopes: ['crm.read'],
        },
      ],
      staleAfterSeconds: 300,
    });
    const privateApi = edgeConnector.createPrivateApiDouble({
      states: { 'cust-1042': { stage: 'onboarding' } },
    });
    const { wrapped, records } = edgeConnector.recordAdapters({ 'private-api': privateApi });
    const sim = edgeConnector.createInMemoryEdgeRuntime({
      tenantId: tenant,
      edgeId: detail.runtime.id,
      keyId: KEY_ID,
      secretKey: KEY_MATERIAL,
      localAllowlist: [
        {
          capabilityKey: 'read.customer-records',
          mode: 'read' as const,
          connectivity: 'private-api' as const,
          secretRef: 'edge-vault://w094-read',
          secretScopes: ['crm.read'],
        },
      ],
      localSecrets: { 'edge-vault://w094-read': 'local-read-material' },
      adapters: { 'private-api': wrapped['private-api'] },
    });
    await sim.heartbeat({ version: '1.0.0' });
    setMigrationVerificationTransport(
      edgeConnector.createEdgeDeepActionTransport(member, {
        edgeId: detail.runtime.id,
        drive: async () => {
          await sim.dialHomeOnce();
        },
      }),
    );

    const captured = await captureSnapshot(member, { migrationId: created.migration.id });
    await transformImportRound(member, { roundId: captured.round.id });
    await reviewImportRound(reviewer, { roundId: captured.round.id });
    const commit = await commitImportRound(admin, { roundId: captured.round.id });

    // The edge executed the verification read (a real edge job served it).
    expect(commit.round.verification).toBe('verified');
    expect(commit.round.verifiedCount).toBe(1);
    expect(records.get('private-api')!.length).toBe(1);
    expect(records.get('private-api')![0]!.target).toBe('cust-1042');
    setMigrationVerificationTransport(null);
    edgeConnector.wireEdgeSigner(null);
  });
});

// ---------------------------------------------------------------------------
// The W092 composition (kit binding)
// ---------------------------------------------------------------------------

describe('the vertical-kit binding (W092)', () => {
  it('validates the integration declaration and surfaces schema-hint issues at transform', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const reviewer = reviewerOf(tenant);
    const member = memberOf(tenant);
    const kitAdmin = kitAdminOf(tenant);
    const approver = approverOf(tenant);

    // Register + install + approve + activate the shipped accounting kit.
    const registered = await verticalKits.registerKitVersion(kitAdmin, {
      manifest: verticalKits.ACCOUNTING_LEDGER_ERP_KIT,
    });
    const verification = await verticalKits.runKitVerification(kitAdmin, {
      kitVersionId: registered.version.id,
    });
    expect(verification.outcome).toBe('verified');
    const installed = await verticalKits.installKit(kitAdmin, {
      kitKey: verticalKits.ACCOUNTING_LEDGER_ERP_KIT.kitKey,
      version: verticalKits.ACCOUNTING_LEDGER_ERP_KIT.version,
      justification: 'W094 kit-bound migration test',
    });
    const decided = await verticalKits.decideKitReview(approver, {
      installationId: installed.installation.id,
      decision: 'approve',
      note: 'W094 acceptance: approved for the migration binding',
    });
    expect(decided.installation.status).toBe('granted');
    const activated = await verticalKits.activateKit(kitAdmin, {
      installationId: decided.installation.id,
    });
    expect(activated.installation.status).toBe('active');

    // The incumbent holds ledger-account records, one violating the kit's
    // declared schema hints (accountCode wrong type; name missing).
    const incumbent = new FixtureIncumbent([
      {
        externalId: 'ACC-1',
        matchKey: 'acc-1000',
        entityType: 'ledger-account',
        payload: { accountCode: 1000, name: 'Cash', accountType: 'asset', active: true },
      },
      {
        externalId: 'ACC-2',
        matchKey: 'acc-2000',
        entityType: 'ledger-account',
        payload: { accountCode: '2000', accountType: 'liability', active: true },
      },
    ]);
    setMigrationIncumbentReader(incumbent);
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });

    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
      kitBinding: {
        installationId: activated.installation.id,
        integrationKey: 'ledger-erp-sor',
      },
    });
    expect(created.migration.kitKey).toBe('accounting-ledger-erp');
    expect(created.migration.kitVersion).toBe('1.0.0');
    expect(created.migration.kitIntegrationKey).toBe('ledger-erp-sor');

    const captured = await captureSnapshot(member, { migrationId: created.migration.id });
    const transformed = await transformImportRound(member, { roundId: captured.round.id });
    expect(transformed.round.transformIssueCount).toBe(2);
    const issuesByRecord = new Map(
      transformed.records.map((record) => [record.externalId, record.issues]),
    );
    expect(issuesByRecord.get('ACC-1')!.map((issue) => issue.code)).toEqual([
      'schema-hint-type-mismatch',
    ]);
    expect(issuesByRecord.get('ACC-2')!.map((issue) => issue.code).sort()).toEqual([
      'schema-hint-required-field-missing',
    ]);
    // The issues SURFACED, never dropped: both records still commit.
    await reviewImportRound(reviewer, { roundId: captured.round.id });
    const commit = await commitImportRound(admin, { roundId: captured.round.id });
    expect(commit.records).toHaveLength(2);
    expect(commit.records.every((record) => record.state === 'committed')).toBe(true);

    // An undeclared integration key is refused loudly.
    await expectMigrationError('kit_integration_not_declared', () =>
      createMigration(admin, {
        incumbentSystemId: side.systemId,
        incumbentConnectionId: side.connectionId,
        incumbentReadCapabilityKey: 'read.customer-records',
        kitBinding: { installationId: activated.installation.id, integrationKey: 'no-such-sor' },
      }),
    );
    // A suspended kit binds nothing.
    await verticalKits.suspendKit(kitAdmin, { installationId: activated.installation.id });
    await expectMigrationError('kit_not_found', () =>
      createMigration(admin, {
        incumbentSystemId: side.systemId,
        incumbentConnectionId: side.connectionId,
        incumbentReadCapabilityKey: 'read.customer-records',
        kitBinding: { installationId: activated.installation.id, integrationKey: 'ledger-erp-sor' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// State discipline
// ---------------------------------------------------------------------------

describe('state discipline', () => {
  it('enforces the forward-only round chain, the open-round block and the reader wiring', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const reviewer = reviewerOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
    ]);

    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });

    // No reader wired: the honest refusal, never a fake snapshot.
    setMigrationIncumbentReader(null);
    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    await expectMigrationError('reader_unavailable', () =>
      captureSnapshot(member, { migrationId: created.migration.id }),
    );
    setMigrationIncumbentReader(incumbent);
    // No native reader wired: the honest refusal, never a fake comparison.
    setMigrationNativeReader(null);
    await expectMigrationError('native_reader_unavailable', () =>
      runComparisonRound(member, { migrationId: created.migration.id }),
    );

    // An explicit delta without a committed round is refused (no round
    // has committed yet — before any round opens).
    await expectMigrationError('invalid_input', () =>
      captureSnapshot(member, { migrationId: created.migration.id, kind: 'delta' }),
    );

    // The phase chain: transform before snapshot is impossible (no round
    // exists); review before transform; commit before review.
    const captured = await captureSnapshot(member, { migrationId: created.migration.id });
    const unknownRound = newId();
    await expectMigrationError('round_not_found', () =>
      transformImportRound(member, { roundId: unknownRound }),
    );
    await expectMigrationError('round_not_pending_phase', () =>
      reviewImportRound(reviewer, { roundId: captured.round.id }),
    );
    await expectMigrationError('round_not_pending_phase', () =>
      commitImportRound(admin, { roundId: captured.round.id }),
    );

    // While the round is open, no new round and no retirement checkpoint.
    await expectMigrationError('round_open', () =>
      captureSnapshot(member, { migrationId: created.migration.id }),
    );
    await expectMigrationError('round_open', () =>
      advanceToCompareClean(admin, { migrationId: created.migration.id }),
    );

    // Authority: review needs the review claim; commit and the
    // checkpoints need the administer claim.
    await transformImportRound(member, { roundId: captured.round.id });
    await expectMigrationError('forbidden', () =>
      reviewImportRound(member, { roundId: captured.round.id }),
    );
    await reviewImportRound(reviewer, { roundId: captured.round.id });
    await expectMigrationError('forbidden', () =>
      commitImportRound(member, { roundId: captured.round.id }),
    );
    await commitImportRound(admin, { roundId: captured.round.id });

    // Unknown migrations and cross-tenant reads are uniformly not-found
    // (no existence leak).
    await expectMigrationError('migration_not_found', () =>
      getMigration(memberOf(freshTenant()), { migrationId: created.migration.id }),
    );
    await expectMigrationError('migration_not_found', () =>
      getMigration(member, { migrationId: newId() }),
    );
    await expectMigrationError('round_not_found', () =>
      getImportRound(memberOf(freshTenant()), { roundId: captured.round.id }),
    );
    await expectMigrationError('comparison_not_found', () =>
      getComparisonRound(member, { comparisonRoundId: newId() }),
    );
  });

  it('an abandoned round never becomes a delta base — its window is re-read (no silent data loss)', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
    ]);
    setMigrationIncumbentReader(incumbent);
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const migrationId = created.migration.id;

    // Round 1 commits.
    const first = await walkRound(tenant, migrationId);
    expect(first.commit.records).toHaveLength(1);

    // Round 2 snapshots, is ABANDONED before commit — then the incumbent
    // churns (a change that only round 2's window would have carried).
    const second = await captureSnapshot(member, { migrationId });
    incumbent.churn({
      upserts: [{ externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'retired' } }],
      deletions: [],
      deletedAt: '2026-09-28T09:00:00Z',
    });
    const abandoned = await abandonImportRound(member, { roundId: second.round.id });
    expect(abandoned.status).toBe('abandoned');
    // An abandoned round cannot be revived.
    await expectMigrationError('round_not_pending_phase', () =>
      transformImportRound(member, { roundId: second.round.id }),
    );
    await expectMigrationError('round_not_pending_phase', () =>
      abandonImportRound(member, { roundId: second.round.id }),
    );

    // Round 3's delta reads since round 1's snapshot — the churn that
    // happened after round 2's abandoned window is NOT lost.
    const third = await captureSnapshot(member, { migrationId });
    expect(third.round.kind).toBe('delta');
    expect(third.round.sinceSnapshotRef).toBe(first.commit.round.snapshotRef);
    expect(third.records.map((record) => record.externalId)).toEqual(['C-1']);
    expect(third.records[0]!.payload).toEqual({ stage: 'retired' });
    await transformImportRound(member, { roundId: third.round.id });
    await reviewImportRound(reviewerOf(tenant), { roundId: third.round.id });
    const thirdCommit = await commitImportRound(admin, { roundId: third.round.id });
    expect(thirdCommit.records[0]!.disposition).toBe('update');
    expect(thirdCommit.records[0]!.payload).toEqual({ stage: 'retired' });
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('the events ledger is append-only and the evidence columns are immutable', async () => {
    const tenant = freshTenant();
    const admin = migrationAdminOf(tenant);
    const member = memberOf(tenant);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
    ]);
    setMigrationIncumbentReader(incumbent);
    setMigrationNativeReader(new FixtureNativeStore());
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const created = await createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const commit = (await walkRound(tenant, created.migration.id)).commit;

    // The events ledger refuses UPDATE/DELETE/TRUNCATE at the storage level.
    const db = getDb();
    await expect(db.query(`UPDATE migration_events SET detail = 'tampered'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM migration_events`)).rejects.toThrow();
    await expect(db.query(`TRUNCATE migration_events`)).rejects.toThrow();

    // The imported record's payload/provenance columns are immutable...
    await expect(
      db.query(
        `UPDATE migration_imported_records SET payload = '{"stage": "tampered"}'::jsonb WHERE tenant_id = $1`,
        [tenant],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `UPDATE migration_imported_records SET external_id = 'tampered' WHERE tenant_id = $1`,
        [tenant],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `UPDATE migration_imported_records SET match_key = 'tampered' WHERE tenant_id = $1`,
        [tenant],
      ),
    ).rejects.toThrow();
    // ...while the forward-only workflow columns still move (the
    // disposition of a linked record may transition onward).
    const workflowUpdate = await db.query(
      `UPDATE migration_imported_records SET disposition = 'update' WHERE tenant_id = $1 AND id = $2`,
      [tenant, commit.records[0]!.id],
    );
    expect(workflowUpdate.rowCount).toBe(1);
    // The payload survived every attempt untouched.
    const after = await listImportedRecords(member, { migrationId: created.migration.id });
    expect(after[0]!.payload).toEqual({ stage: 'active' });
    expect(after[0]!.externalId).toBe('C-1');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (the lifecycle boundary; the deep matrix lives in the
// tenant-isolation sweep)
// ---------------------------------------------------------------------------

describe('tenant isolation (the lifecycle boundary)', () => {
  it('another tenant sees nothing of this migration, its rounds, records or map', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const adminA = migrationAdminOf(tenantA);
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
    ]);
    setMigrationIncumbentReader(incumbent);
    const side = await connectIncumbentSystem(tenantA, {
      externalId: 'w094-crm',
      displayName: 'W094 Legacy CRM',
    });
    const created = await createMigration(adminA, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const commit = (await walkRound(tenantA, created.migration.id)).commit;

    // Cross-tenant reads and lifecycle calls are uniformly not-found.
    await expectMigrationError('migration_not_found', () =>
      getMigration(memberB, { migrationId: created.migration.id }),
    );
    await expectMigrationError('migration_not_found', () =>
      captureSnapshot(memberB, { migrationId: created.migration.id }),
    );
    await expectMigrationError('round_not_found', () =>
      transformImportRound(memberB, { roundId: commit.round.id }),
    );
    await expectMigrationError('migration_not_found', () =>
      resolveExternalId(memberB, { sourceSystemKey: side.systemKey, externalId: 'C-1' }),
    );
    // B's listings hold exactly nothing of A's world (a foreign
    // migration id is uniformly not-found, never a silently empty list).
    expect(await listMigrations(memberB, {})).toEqual([]);
    await expectMigrationError('migration_not_found', () =>
      listImportedRecords(memberB, { migrationId: created.migration.id }),
    );
    expect(await listIdentifierMappings(memberB, {})).toEqual([]);
    // A's own view is intact.
    expect(await listMigrations(memberA, {})).toHaveLength(1);
    expect(await listIdentifierMappings(memberA, {})).toHaveLength(1);
  });
});
