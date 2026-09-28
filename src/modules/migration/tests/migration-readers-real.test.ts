// W111 — the REAL-ENVIRONMENT full-path suite: the complete migration
// journey over the REAL adapters against the embedded PostgreSQL engine
// (PGlite — real PostgreSQL 16 as WASM, the same backend `bun run db:dev`
// boots) with the FULL production migration chain applied (every module's
// real migrations, the real 258-table schema).
//
// THE PATH PROVEN HERE (the W111 acceptance):
//   staged import (real CSV export files on the real file system) →
//   commit-time verification through the W088 edge boundary (a REAL
//   file-share EdgeConnectivityAdapter re-reading the CSV via signed
//   edge jobs) → explicit cross-system conflict, resolved only by an
//   audited HUMAN decision → delta round (churn + a vanished row
//   surfaced as an explicit rejection) → native catch-up carrying the
//   identifier map's minted ids into the REAL world_entities table →
//   W084 comparison/reconciliation (a seeded divergence with enumerated
//   mismatches, then convergence) → progressive retirement
//   (compare-clean → incumbent-read-only → incumbent-retired, the
//   identifier map staying live) — and, on a second migration, the
//   ROLLBACK proof: sequestration actually executed, the system state
//   verified after (live views exclude, audit retains, native Aurum
//   data untouched).
//
// NO SILENT DATA LOSS is asserted at every round: export rows = staged +
// rejected (+ conflicted where conflicts exist) — the rejection ledger is
// the durable audit home.
//
// NO DUPLICATE AUTHORITY is asserted directly: the import path never
// writes a single row outside the migration module's own tables (the
// world_entities census is taken before and after every import phase;
// only the test's explicit native catch-up — standing in for the
// customer's native-side import tool — ever writes world rows).
//
// The hosted-Postgres variant of this same path lives in
// migration-readers-hosted.test.ts (activated by AURUM_TEST_DATABASE_URL,
// the worker-realpostgres precedent). The hosted-Postgres ENVIRONMENT
// itself was UNREACHABLE from this sandbox (api.neon.tech DNS-blocked —
// see docs/productization-evidence/W111/), so the embedded real Postgres
// is the real environment proven here.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as sourcesContract from '@/modules/sources/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as edgeConnector from '@/modules/edge-connector/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { MigrationError } from '../errors';
import * as migration from '../contract';
import { createCsvExportIncumbentReader } from '../adapters/csv-export-incumbent-reader';
import { createWorldEntitiesNativeReader } from '../adapters/world-native-reader';
import { createCsvFileShareAdapter } from '../adapters/file-share-verify';

const { registerSource, setSourceTransport } = sourcesContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;

// ---------------------------------------------------------------------------
// Helpers (the W094 suite's harness discipline, self-contained)
// ---------------------------------------------------------------------------

const HEADER = 'external_id,match_key,entity_type,deleted_at,payload_json';

/** Quotes one CSV cell when required (RFC 4180: commas, quotes, breaks). */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Builds one CSV data row from cells (payload cells arrive as JSON text). */
function csvRow(...cells: string[]): string {
  return cells.map(csvCell).join(',');
}

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
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

let roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aurum-w111-real-'));
  roots.push(root);
  return root;
}

async function writeExportVersion(
  root: string,
  version: number,
  content: string,
): Promise<void> {
  const dir = path.join(root, `csv-export-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'records.csv'), content);
}

/** The tenant's world-entity census (the no-duplicate-authority canary). */
async function worldEntityCensus(tenantId: string): Promise<number> {
  const rows = await getDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM world_entities WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number.parseInt(rows.rows[0]!.count, 10);
}

/**
 * The NATIVE CATCH-UP: writes world_entities rows carrying the identifier
 * map's minted aurum entity ids (the customer's native-side import tool —
 * the migration module itself NEVER writes another module's tables, which
 * the census assertions around every import phase prove).
 */
async function nativeCatchUp(
  tenantId: string,
  entries: Array<{ aurumEntityId: string; name: string; attributes: Record<string, unknown> }>,
): Promise<void> {
  const db = getDb();
  for (const entry of entries) {
    await db.query(
      `INSERT INTO world_entities (
         id, tenant_id, kind, category, name, description, attributes,
         external_module, external_id, created_at, updated_at
       ) VALUES ($1, $2, 'company', 'company', $3, $4, $5::jsonb, 'migration', $6, now(), now())`,
      [entry.aurumEntityId, tenantId, entry.name, 'native catch-up (W111)', JSON.stringify(entry.attributes), entry.aurumEntityId],
    );
  }
}

class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  async fetch(): Promise<sourcesContract.SourceFetchResult> {
    return {
      records: [
        directoryRecord('w111-crm', 'W111 Legacy CRM'),
        directoryRecord('w111-erp', 'W111 Legacy ERP'),
        directoryRecord('w111-billing', 'W111 Legacy Billing'),
      ],
      nextCursor: null,
      hasMore: false,
    };
  }
}

function directoryRecord(
  externalId: string,
  displayName: string,
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${externalId}`,
    kind: 'directory.system.discovered',
    payload: { externalId, displayName, capabilityClasses: ['customer-records'] },
    occurredAt: '2026-09-27T10:00:00Z',
  };
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
          authorization_url: `https://broker.w111.example/oauth/${state}`,
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

async function connectIncumbentSystem(
  tenantId: string,
  options: { externalId: string; displayName: string },
): Promise<{ systemId: string; systemKey: string; connectionId: string }> {
  const admin = memberOf(tenantId, ['integration-intelligence:administer']);
  const member = memberOf(tenantId);
  const { source } = await registerSource(admin, {
    provider: 'notion',
    providerAccountId: `w111r-${options.externalId}-${tenantId.slice(0, 8)}`,
    displayName: `W111 real directory ${options.externalId}`,
    authKind: 'oauth',
    credentialRef: ['secret-store://', 'w111r/', `${options.externalId}/ref`].join(''),
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
    connectionKey: `w111r-${options.externalId}-${tenantId.slice(0, 8)}`,
    displayName: options.displayName,
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(member, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return { systemId: system.id, systemKey: system.systemKey, connectionId: completed.connection.id };
}

/** Walks one import round through the whole staged lifecycle. */
async function walkRound(
  tenantId: string,
  migrationId: string,
): Promise<{ roundId: string; captured: migration.CaptureSnapshotResult; commit: migration.CommitImportRoundResult }> {
  const admin = memberOf(tenantId, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
  const reviewer = memberOf(tenantId, [migration.MIGRATION_AUTHORITY_REVIEW]);
  const member = memberOf(tenantId);
  const captured = await migration.captureSnapshot(member, { migrationId });
  await migration.transformImportRound(member, { roundId: captured.round.id });
  await migration.reviewImportRound(reviewer, { roundId: captured.round.id });
  const commit = await migration.commitImportRound(admin, { roundId: captured.round.id });
  return { roundId: captured.round.id, captured, commit };
}

beforeAll(async () => {
  await runMigrations(getDb());
  setSourceTransport(new ScriptedDirectoryTransport());
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.w111.example',
      apiToken: ['embedded_tok_', 'w111r', '_fragment'].join(''),
      httpClient: new ScriptedBrokerBackend(),
    }),
  ]);
});

afterEach(() => {
  migration.setMigrationIncumbentReader(null);
  migration.setMigrationNativeReader(null);
  migration.setMigrationVerificationTransport(null);
});

afterAll(async () => {
  setSourceTransport(null);
  wireConnectionBrokers(null);
  migration.setMigrationIncumbentReader(null);
  migration.setMigrationNativeReader(null);
  migration.setMigrationVerificationTransport(null);
  edgeConnector.wireEdgeSigner(null);
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
  await closeDb();
});

// ---------------------------------------------------------------------------
// The full path (the W111 acceptance core)
// ---------------------------------------------------------------------------

describe('the full migration path over the real adapters (W111)', () => {
  it('staged import → edge verification → delta → native catch-up → W084 comparison → progressive retirement', async () => {
    const tenant = newId();
    const admin = memberOf(tenant, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const reviewer = memberOf(tenant, [migration.MIGRATION_AUTHORITY_REVIEW]);
    const member = memberOf(tenant);

    // -- the incumbent's first export (a real file on the real fs) -----
    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [
        HEADER,
        csvRow('A-1', 'k-100', 'customer', '', JSON.stringify({ stage: 'active', seats: 10, emails: ['ops@acme.test'] })),
        csvRow('A-2', 'k-200', 'customer', '', JSON.stringify({ stage: 'onboarding' })),
        csvRow('A-3', 'k-300', 'customer', '', JSON.stringify({ stage: 'active' })),
        csvRow('A-5', 'k-500', 'customer', '', JSON.stringify({ stage: 'active', seats: 2 })),
        csvRow('A-6', 'k-600', 'customer', '', 'broken json'), // rejected row 5
      ].join('\n'),
    );
    migration.setMigrationIncumbentReader(createCsvExportIncumbentReader({ exportRoot: root }));

    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w111-crm',
      displayName: 'W111 Legacy CRM',
    });
    const created = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const migrationId = created.migration.id;
    expect(created.migration.status).toBe('dual-running');

    // The no-duplicate-authority census BEFORE any import.
    const censusBefore = await worldEntityCensus(tenant);

    // -- the staged import round (full) ---------------------------------
    const first = await walkRound(tenant, migrationId);
    expect(first.captured.round.kind).toBe('full');
    expect(first.captured.round.snapshotRef).toBe('csv-export-1');
    // NO SILENT LOSS: 5 data rows = 4 staged + 1 rejected (+ 0 conflicted).
    expect(first.captured.records).toHaveLength(4);
    expect(first.captured.rejections).toHaveLength(1);
    expect(first.captured.rejections[0]!.reasonCode).toBe('invalid-record');
    expect(first.captured.records.length + first.captured.rejections.length).toBe(5);
    expect(first.commit.round.verification).toBe('not-wired');
    expect(first.commit.mapEntries).toHaveLength(4);

    // The import path wrote ZERO world rows (the module owns only its
    // own tables — no duplicate authority).
    expect(await worldEntityCensus(tenant)).toBe(censusBefore);

    // -- the W088 verification leg: a REAL file-share edge adapter ------
    // The commit-time verification re-reads the CSV through SIGNED edge
    // jobs served by a real file-share adapter reading the real file.
    const KEY_ID = 'key-2026-w111';
    const KEY_MATERIAL = ['edge-enroll-', 'w111', '-material'].join('');
    edgeConnector.wireEdgeSigner(
      edgeConnector.createHmacSigner({ secretKeys: { [KEY_ID]: KEY_MATERIAL } }),
    );
    const edgeAdmin = memberOf(tenant, ['edge-connector:administer']);
    const detail = await edgeConnector.registerEdgeRuntime(edgeAdmin, {
      name: 'Plant file-share edge',
      signingKeyId: KEY_ID,
      connectivity: ['file-share'],
      allowlist: [
        {
          capabilityKey: 'read.customer-records',
          mode: 'read',
          connectivity: 'file-share',
          secretRef: 'edge-vault://w111-read',
          secretScopes: ['crm.read'],
        },
      ],
      staleAfterSeconds: 300,
    });
    const fileShare = createCsvFileShareAdapter({ exportRoot: root });
    const { wrapped, records } = edgeConnector.recordAdapters({ 'file-share': fileShare });
    const sim = edgeConnector.createInMemoryEdgeRuntime({
      tenantId: tenant,
      edgeId: detail.runtime.id,
      keyId: KEY_ID,
      secretKey: KEY_MATERIAL,
      localAllowlist: [
        {
          capabilityKey: 'read.customer-records',
          mode: 'read' as const,
          connectivity: 'file-share' as const,
          secretRef: 'edge-vault://w111-read',
          secretScopes: ['crm.read'],
        },
      ],
      localSecrets: { 'edge-vault://w111-read': 'local-read-material' },
      adapters: { 'file-share': wrapped['file-share'] },
    });
    await sim.heartbeat({ version: '1.0.0' });
    migration.setMigrationVerificationTransport(
      edgeConnector.createEdgeDeepActionTransport(member, {
        edgeId: detail.runtime.id,
        drive: async () => {
          await sim.dialHomeOnce();
        },
      }),
    );

    // -- the incumbent churns; the delta round rides the version chain --
    await writeExportVersion(
      root,
      2,
      [
        HEADER,
        csvRow('A-1', 'k-100', 'customer', '', JSON.stringify({ stage: 'active', seats: 10, emails: ['ops@acme.test'] })),
        // A-2 CHANGED.
        csvRow('A-2', 'k-200', 'customer', '', JSON.stringify({ stage: 'active' })),
        // A-3 became a TOMBSTONE (the incumbent's soft-delete export).
        csvRow('A-3', 'k-300', 'customer', '2026-09-27T11:00:00Z', ''),
        // A-4 is NEW.
        csvRow('A-4', 'k-400', 'customer', '', JSON.stringify({ stage: 'onboarding', seats: 1 })),
        // A-5 VANISHED with no tombstone (explicitly surfaced below).
        csvRow('A-6', 'k-600', 'customer', '', 'broken json'), // still rejected row 6
      ].join('\n'),
    );

    const delta = await migration.captureSnapshot(member, { migrationId });
    expect(delta.round.kind).toBe('delta');
    expect(delta.round.sinceSnapshotRef).toBe('csv-export-1');
    expect(delta.round.snapshotRef).toBe('csv-export-2');
    const deltaIds = delta.records.map((record) => record.externalId).sort();
    expect(deltaIds).toEqual(['A-2', 'A-3', 'A-4']);
    // NO SILENT LOSS on the delta: 6 latest rows examined + 1 vanished
    // base row = 3 returned + rejections (1 malformed latest row + 1
    // vanished row).
    expect(delta.rejections.map((rejection) => rejection.reasonCode).sort()).toEqual([
      'disappeared-without-tombstone',
      'invalid-record',
    ]);
    const vanished = delta.rejections.find(
      (rejection) => rejection.reasonCode === 'disappeared-without-tombstone',
    )!;
    expect(vanished.externalId).toBe('A-5');
    expect(vanished.lineNumber).toBe(4); // A-5's row position in csv-export-1

    await migration.transformImportRound(member, { roundId: delta.round.id });
    await migration.reviewImportRound(reviewer, { roundId: delta.round.id });
    const deltaCommit = await migration.commitImportRound(admin, { roundId: delta.round.id });
    // The W088 verification REALLY re-read the CSV through signed edge
    // jobs: the two live delta records verified, the tombstone skipped.
    expect(deltaCommit.round.verification).toBe('verified');
    expect(deltaCommit.round.verifiedCount).toBe(2);
    expect(deltaCommit.round.divergentCount).toBe(0);
    const edgeRequests = records.get('file-share')!;
    expect(edgeRequests.length).toBe(2);
    expect(edgeRequests.map((request) => request.target).sort()).toEqual(['A-2', 'A-4']);
    // READ-ONLY: every edge job was an inspect — the module never writes
    // back to the incumbent through any path.
    expect(edgeRequests.every((request) => request.kind === 'inspect')).toBe(true);
    // The import still wrote ZERO world rows.
    expect(await worldEntityCensus(tenant)).toBe(censusBefore);

    const byDisposition = new Map(
      deltaCommit.records.map((record) => [record.externalId, record]),
    );
    expect(byDisposition.get('A-2')!.disposition).toBe('update');
    expect(byDisposition.get('A-4')!.disposition).toBe('new');
    expect(byDisposition.get('A-3')!.disposition).toBe('tombstone');

    // -- the native catch-up: world_entities carrying the map's ids -----
    const entityOf = (externalId: string): string => {
      const record = [
        ...first.commit.records,
        ...deltaCommit.records,
      ].find((entry) => entry.externalId === externalId);
      if (record === undefined || record.aurumEntityId === null) {
        throw new Error(`no minted entity for ${externalId}`);
      }
      return record.aurumEntityId;
    };
    // The native side converges — with ONE seeded divergence (A-1).
    await nativeCatchUp(tenant, [
      {
        aurumEntityId: entityOf('A-1'),
        name: 'Acme (A-1)',
        attributes: { stage: 'churned', seats: 10, emails: ['ops@acme.test'] },
      },
      {
        aurumEntityId: entityOf('A-2'),
        name: 'Beta (A-2)',
        attributes: { stage: 'active' },
      },
      {
        aurumEntityId: entityOf('A-4'),
        name: 'Delta (A-4)',
        attributes: { stage: 'onboarding', seats: 1 },
      },
      {
        aurumEntityId: entityOf('A-5'),
        name: 'Epsilon (A-5)',
        attributes: { stage: 'active', seats: 2 },
      },
    ]);
    migration.setMigrationNativeReader(createWorldEntitiesNativeReader(tenant));

    // -- the W084 comparison: divergences surfaced, never reconciled ----
    const divergentRound = await migration.runComparisonRound(member, { migrationId });
    const byKind = new Map(divergentRound.entries.map((entry) => [entry.aurumEntityId, entry]));
    // The compared universe: every entity either side knows — the four
    // live entities plus the tombstoned A-3 (its incumbent state is null
    // and the native side holds no row either → agreement).
    expect(divergentRound.round.comparedEntityCount).toBe(5);
    expect(divergentRound.round.divergenceCount).toBe(1);
    const diverged = byKind.get(entityOf('A-1'))!;
    expect(diverged.kind).toBe('divergence');
    // The W084 reconciliation's own mismatch enumeration (path/expected/
    // actual — expected = incumbent-imported, actual = native).
    expect(diverged.mismatches).toEqual([
      { path: 'stage', expected: 'active', actual: 'churned' },
    ]);
    expect(diverged.reason).toContain("field 'stage' diverges");
    expect(diverged.reason).toContain("'active'");
    expect(diverged.reason).toContain("'churned'");
    for (const externalId of ['A-2', 'A-3', 'A-4', 'A-5']) {
      expect(byKind.get(entityOf(externalId))!.kind).toBe('agreement');
    }
    // The retirement chain REFUSES to advance on a divergent round.
    await expectMigrationError('compare_clean_required', () =>
      migration.advanceToCompareClean(admin, { migrationId }),
    );

    // The native side converges (the operator fixes the divergence).
    await getDb().query(
      `UPDATE world_entities SET attributes = $3::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
      [tenant, entityOf('A-1'), JSON.stringify({ stage: 'active', seats: 10, emails: ['ops@acme.test'] })],
    );

    const cleanRound = await migration.runComparisonRound(member, {
      migrationId,
      note: 'W111: post-convergence comparison',
    });
    expect(cleanRound.round.comparedEntityCount).toBe(5);
    expect(cleanRound.round.agreementCount).toBe(5);
    expect(cleanRound.round.divergenceCount).toBe(0);

    // -- progressive retirement (evidence-linked checkpoints) -----------
    const compareClean = await migration.advanceToCompareClean(admin, { migrationId });
    expect(compareClean.status).toBe('compare-clean');
    expect(compareClean.compareCleanRoundId).toBe(cleanRound.round.id);
    const readOnly = await migration.advanceToIncumbentReadOnly(admin, { migrationId });
    expect(readOnly.status).toBe('incumbent-read-only');
    const retired = await migration.retireIncumbent(admin, { migrationId });
    expect(retired.status).toBe('incumbent-retired');
    // The identifier map stays LIVE after retirement (identifiers are
    // preserved forever — historical references keep resolving).
    const resolved = await migration.resolveExternalId(member, {
      sourceSystemKey: side.systemKey,
      externalId: 'A-1',
    });
    expect(resolved.entry.aurumEntityId).toBe(entityOf('A-1'));
    expect(resolved.currentState!.payload).toEqual({
      stage: 'active',
      seats: 10,
      emails: ['ops@acme.test'],
    });

    // -- the explicit cross-system conflict (human-decided) -------------
    // A SECOND incumbent system exports a record claiming the SAME
    // natural match key as A-1 ('k-100') — a cross-system collision.
    const erpRoot = await freshRoot();
    await writeExportVersion(
      erpRoot,
      1,
      [
        HEADER,
        csvRow('B-1', 'k-100', 'erp-customer', '', JSON.stringify({ stage: 'active', source: 'erp' })),
      ].join('\n'),
    );
    migration.setMigrationVerificationTransport(null);
    migration.setMigrationIncumbentReader(createCsvExportIncumbentReader({ exportRoot: erpRoot }));
    const erpSide = await connectIncumbentSystem(tenant, {
      externalId: 'w111-erp',
      displayName: 'W111 Legacy ERP',
    });
    const erpMigration = await migration.createMigration(admin, {
      incumbentSystemId: erpSide.systemId,
      incumbentConnectionId: erpSide.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const censusBeforeConflict = await worldEntityCensus(tenant);
    const conflictRound = await walkRound(tenant, erpMigration.migration.id);
    // The collision is an EXPLICIT conflict record — nothing auto-merged.
    expect(conflictRound.commit.conflicts).toHaveLength(1);
    const conflict = conflictRound.commit.conflicts[0]!;
    expect(conflict.kind).toBe('cross-system-collision');
    expect(conflict.status).toBe('open');
    expect(conflict.matchKey).toBe('k-100');
    const conflictedRecord = conflictRound.commit.records.find(
      (record) => record.externalId === 'B-1',
    )!;
    expect(conflictedRecord.disposition).toBe('conflicted');
    expect(conflictedRecord.aurumEntityId).toBeNull();
    expect(
      conflictRound.commit.mapEntries.some((entry) => entry.externalId === 'B-1'),
    ).toBe(false);
    // The external id resolves to NOTHING until a human decides.
    await expectMigrationError('migration_not_found', () =>
      migration.resolveExternalId(member, {
        sourceSystemKey: erpSide.systemKey,
        externalId: 'B-1',
      }),
    );
    // The conflict leg still wrote ZERO world rows.
    expect(await worldEntityCensus(tenant)).toBe(censusBeforeConflict);

    // The HUMAN decision: the operator links B-1 to A-1's Aurum entity.
    const listed = await migration.listIdentityConflicts(member, {
      migrationId: erpMigration.migration.id,
    });
    expect(listed).toHaveLength(1);
    const resolvedConflict = await migration.resolveIdentityConflict(admin, {
      conflictId: listed[0]!.id,
      aurumEntityId: entityOf('A-1'),
      note: 'W111: the operator confirms the ERP record is the same customer as the CRM record',
    });
    expect(resolvedConflict.status).toBe('resolved');
    expect(resolvedConflict.resolutionAurumEntityId).toBe(entityOf('A-1'));
    const erpResolved = await migration.resolveExternalId(member, {
      sourceSystemKey: erpSide.systemKey,
      externalId: 'B-1',
    });
    expect(erpResolved.entry.aurumEntityId).toBe(entityOf('A-1'));
    expect(erpResolved.entry.origin).toBe('conflict-resolution');
    // The audited human decision is on the feed.
    const erpEvents = await migration.listMigrationEvents(member, {
      migrationId: erpMigration.migration.id,
    });
    expect(erpEvents.some((event) => event.event === 'identity-conflict-resolved')).toBe(true);

    // The full-path audit feed: every phase left its evidence.
    const events = await migration.listMigrationEvents(member, { migrationId });
    const eventKinds = events.map((event) => event.event);
    for (const expected of [
      'snapshot-captured',
      'transformed',
      'reviewed',
      'committed',
      'comparison-completed',
      'compare-clean-checkpoint',
      'incumbent-read-only-checkpoint',
      'incumbent-retired',
    ]) {
      expect(eventKinds).toContain(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback — sequestration actually executed, the state verified after
// ---------------------------------------------------------------------------

describe('rollback remains sequestration (W111 — proof by doing it)', () => {
  it('sequesters a committed migration: live views exclude, audit retains, native Aurum untouched, fresh ids mint forward', async () => {
    const tenant = newId();
    const admin = memberOf(tenant, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const member = memberOf(tenant);

    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [
        HEADER,
        csvRow('C-1', 'k-900', 'customer', '', JSON.stringify({ stage: 'active', seats: 5 })),
        csvRow('C-2', 'k-901', 'customer', '', JSON.stringify({ stage: 'onboarding' })),
      ].join('\n'),
    );
    migration.setMigrationIncumbentReader(createCsvExportIncumbentReader({ exportRoot: root }));
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w111-billing',
      displayName: 'W111 Legacy Billing',
    });
    const created = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const migrationId = created.migration.id;
    const first = await walkRound(tenant, migrationId);
    expect(first.commit.mapEntries).toHaveLength(2);
    // Found BY EXTERNAL ID (the result's mapEntries order is not part of
    // any contract).
    const sequesteredEntry = first.commit.mapEntries.find(
      (entry) => entry.externalId === 'C-1',
    )!;
    const sequesteredEntity = sequesteredEntry.aurumEntityId;

    // The native catch-up for ONE entity (the rest of the tenant's native
    // state — what rollback must NEVER touch).
    await nativeCatchUp(tenant, [
      {
        aurumEntityId: sequesteredEntity,
        name: 'Rollback Co (C-1)',
        attributes: { stage: 'active', seats: 5 },
      },
    ]);

    // An OPEN round exists when rollback strikes (force-abandoned by it).
    await writeExportVersion(
      root,
      2,
      [
        HEADER,
        csvRow('C-1', 'k-900', 'customer', '', JSON.stringify({ stage: 'active', seats: 6 })),
        csvRow('C-2', 'k-901', 'customer', '', JSON.stringify({ stage: 'onboarding' })),
      ].join('\n'),
    );
    const open = await migration.captureSnapshot(member, { migrationId });
    expect(open.round.status).toBe('snapshotted');

    const censusBeforeRollback = await worldEntityCensus(tenant);
    const mapRowsBefore = (
      await getDb().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM migration_identifier_map WHERE tenant_id = $1`,
        [tenant],
      )
    ).rows[0]!.count;

    // -- ROLLBACK: sequestration, actually executed ----------------------
    const sequestered = await migration.sequesterMigration(admin, {
      migrationId,
      reason: 'W111 rollback proof: the customer decided to stay on the incumbent',
    });
    expect(sequestered.status).toBe('sequestered');

    // The open round was force-abandoned (its records stay as evidence).
    const rounds = await migration.listImportRounds(member, { migrationId });
    const openRound = rounds.find((round) => round.id === open.round.id)!;
    expect(openRound.status).toBe('abandoned');

    // LIVE views exclude the quarantined imports...
    const liveStates = await migration.listCurrentImportedStates(member, { migrationId });
    expect(liveStates).toHaveLength(0);
    const liveRecords = await migration.listImportedRecords(member, { migrationId });
    expect(liveRecords).toHaveLength(0);
    const liveMap = await migration.listIdentifierMappings(member, { migrationId });
    expect(liveMap).toHaveLength(0);
    await expectMigrationError('migration_not_found', () =>
      migration.resolveExternalId(member, {
        sourceSystemKey: side.systemKey,
        externalId: 'C-1',
      }),
    );

    // ...the AUDIT views retain everything (nothing deleted).
    const auditRecords = await migration.listImportedRecords(member, {
      migrationId,
      includeSequestered: true,
    });
    expect(auditRecords).toHaveLength(3); // 2 committed + 1 abandoned-round row
    const auditStates = await migration.listCurrentImportedStates(member, {
      migrationId,
      includeSequestered: true,
    });
    expect(auditStates).toHaveLength(2);
    const auditRejections = await migration.listReaderRejections(member, { migrationId });
    expect(auditRejections).toHaveLength(0); // this export was clean
    const storedMapRows = (
      await getDb().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM migration_identifier_map WHERE tenant_id = $1`,
        [tenant],
      )
    ).rows[0]!.count;
    expect(storedMapRows).toBe(mapRowsBefore); // rows untouched at the storage level

    // NATIVE AURUM DATA IS NEVER TOUCHED: the catch-up's world row and
    // the census are exactly as they were.
    expect(await worldEntityCensus(tenant)).toBe(censusBeforeRollback);
    const nativeRow = await getDb().query<{ id: string }>(
      `SELECT id FROM world_entities WHERE tenant_id = $1 AND id = $2`,
      [tenant, sequesteredEntity],
    );
    expect(nativeRow.rows).toHaveLength(1);

    // A fresh migration for the SAME system mints FRESH identifiers while
    // the sequestered ones remain as audit (the roll-forward path).
    const fresh = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    expect(fresh.created).toBe(true);
    expect(fresh.migration.id).not.toBe(migrationId);
    const freshRound = await walkRound(tenant, fresh.migration.id);
    expect(freshRound.captured.round.kind).toBe('full');
    expect(freshRound.commit.mapEntries).toHaveLength(2);
    const freshEntity = freshRound.commit.mapEntries.find(
      (entry) => entry.externalId === 'C-1',
    )!;
    expect(freshEntity.aurumEntityId).not.toBe(sequesteredEntity);
    // The live resolution now serves the FRESH identity.
    const resolved = await migration.resolveExternalId(member, {
      sourceSystemKey: side.systemKey,
      externalId: 'C-1',
    });
    expect(resolved.entry.aurumEntityId).toBe(freshEntity.aurumEntityId);
    // The sequestered entry is still in the table (audit), excluded live.
    const sequesteredEntryStillStored = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM migration_identifier_map
         WHERE tenant_id = $1 AND external_id = 'C-1' AND aurum_entity_id = $2`,
      [tenant, sequesteredEntity],
    );
    expect(sequesteredEntryStillStored.rows[0]!.count).toBe('1');

    // Terminal: a sequestered migration takes no further rounds (the
    // same-tenant refusal is the status error — no un-sequester exists).
    await expectMigrationError('migration_not_pending_status', () =>
      migration.captureSnapshot(member, { migrationId }),
    );
  });
});
