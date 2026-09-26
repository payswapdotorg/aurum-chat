// Implementation of the migration module's public operations (see
// contract.ts). W094 — Migration and Dual-Run Continuity.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by `newId()` where
// the id is needed before the insert; timestamps come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`migration_not_found` /
// `round_not_found` / `conflict_not_found` / `comparison_not_found`), no
// existence leak.
//
// W094 acceptance — "customer can run incumbent and Aurum in parallel;
// conflicts are surfaced; rollback is possible; no silent data loss or
// duplicate authority" — is carried by these deliberate properties, all
// tested:
//
//   1. THE STAGED IMPORT LIFECYCLE IS THE PRODUCT: snapshot → transform →
//      staged → review → commit, each phase an explicit, tenant-scoped
//      call. An abandoned round never becomes a delta base (its window is
//      re-read — no silent data loss); every committed record carries its
//      full provenance and its payload/provenance columns are immutable
//      at the STORAGE level (trigger); the transform surfaces issues, it
//      never drops.
//
//   2. IDENTIFIERS ARE PRESERVED, COLLISIONS ARE SURFACED: the
//      external↔Aurum map links each source system's external ids to
//      Aurum entities (per source system; one live migration per
//      incumbent). A natural-key match to a single claim of the SAME
//      source system links (a re-issued external id keeps its Aurum
//      identity); a cross-system collision or an ambiguous multi-entity
//      match raises an EXPLICIT conflict record and links NOTHING until
//      a human resolves (the W095 ambiguous-match rule applied to
//      migration) — never auto-merged.
//
//   3. DUAL-RUN IS IMPORT + COMPARE, NEVER A SECOND ACTION PIPELINE:
//      delta rounds read what changed in the incumbent since the last
//      COMMITTED round; comparison rounds evaluate the same question
//      against incumbent-imported state and native Aurum state through
//      the W084 reconciliation semantics (compare.ts reuses
//      reconcileOperation — one comparison model, no fork). The module
//      exposes NO write path to the incumbent (the reader port is
//      read-only; the verification transport's execute side is never
//      invoked — the tests carry a canary). Writes a customer configures
//      ride the EXISTING deep-action path (W084), never this module.
//
//   4. ROLLBACK SEQUESTERS, IT NEVER DELETES: sequesterMigration
//      logically quarantines the migration's committed imports — every
//      live query excludes them (derived from the migration's status;
//      the rows are untouched) while the audit view retains everything.
//      Native Aurum data is never touched: the module owns only its own
//      tables and holds no write path into any other module.
//
//   5. RETIREMENT IS A CHAIN OF EVIDENCE-LINKED CHECKPOINTS:
//      dual-running → compare-clean (requires a completed comparison
//      round with zero divergences — its id is frozen on the migration)
//      → incumbent-read-only → incumbent-retired, each transition an
//      auditable event. The identifier map stays live through retirement
//      (identifiers remain preserved for historical references).
//
//   6. NO DUPLICATE AUTHORITY: Aurum remains the single organizational
//      truth. The incumbent exists here only as provenance-tagged
//      imported records and the identifier map; every surface this
//      module exposes is a read of that provenance or a lifecycle
//      transition. There is deliberately NO operation that queries the
//      incumbent as authority, writes incumbent state into another
//      module's tables, or makes the incumbent a second truth store.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  IntegrationError,
  getSystem,
  type InventorySystem,
} from '@/modules/integration-intelligence/contract';
import {
  ConnectionBrokerError,
  getConnection,
  type BrokerConnection,
} from '@/modules/connection-broker/contract';
import {
  VerticalKitsError,
  getKitInstallation,
  getKitVersion,
  type KitInstallationDetail,
  type VerticalKitVersionWithVerification,
} from '@/modules/vertical-kits/contract';
import {
  jsonDeepEqual,
  type DeepActionInspectRequest,
  type DeepActionState,
  type DeepActionTransport,
} from '@/modules/deep-actions/contract';
import { MigrationError } from './errors';
import {
  buildIncumbentMissingReason,
  compareEntity,
  detectSchemaHintIssues,
  type KitSchemaHintLike,
} from './compare';
import {
  assertMigrationTenantContext,
  canonicalizeNativeStates,
  canonicalizeSnapshotResult,
  isPlainJsonValue,
  validateCaptureSnapshotInput,
  validateCreateMigrationInput,
  validateGetComparisonRoundQuery,
  validateGetIdentityConflictQuery,
  validateGetMigrationQuery,
  validateListComparisonRoundsQuery,
  validateListIdentityConflictsQuery,
  validateListImportedRecordsQuery,
  validateListImportRoundsQuery,
  validateListIdentifierMappingsQuery,
  validateListMigrationEventsQuery,
  validateListMigrationsQuery,
  validateMigrationIdInput,
  validateListCurrentImportedStatesQuery,
  validateResolveConflictInput,
  validateResolveExternalIdQuery,
  validateRunComparisonInput,
  validateRoundIdInput,
  validateSequesterInput,
} from './validation';
import type {
  ComparisonEntry,
  ComparisonRound,
  CreateMigrationInput,
  CreateMigrationResult,
  CaptureSnapshotInput,
  CaptureSnapshotResult,
  CommitImportRoundResult,
  CurrentImportedState,
  IdentityConflict,
  IdentityConflictCandidate,
  IdentifierMapEntry,
  ImportRound,
  ImportedRecord,
  ImportedRecordIssue,
  Migration,
  MigrationEventType,
  MigrationIncumbentReader,
  MigrationNativeReader,
  ResolveExternalIdResult,
  ResolveIdentityConflictInput,
  RunComparisonRoundResult,
} from './types';
import { MIGRATION_LIVE_STATUSES } from './types';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** Authority claim that administers a migration's consequential steps. */
export const MIGRATION_AUTHORITY_ADMINISTER = 'migration:administer';

/** Authority claim required to review a staged import round. */
export const MIGRATION_AUTHORITY_REVIEW = 'migration:review';

/** The provider-neutral channel key recorded on the module's evidence. */
const MIGRATION_CHANNEL = 'migration';

// ---------------------------------------------------------------------------
// Port wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

let wiredIncumbentReader: MigrationIncumbentReader | null = null;
let wiredNativeReader: MigrationNativeReader | null = null;
let wiredVerificationTransport: DeepActionTransport | null = null;

/** Wires (or clears) the incumbent reader — the import path's seam. */
export function setMigrationIncumbentReader(reader: MigrationIncumbentReader | null): void {
  wiredIncumbentReader = reader;
}

/** The currently wired incumbent reader (null = none). */
export function getMigrationIncumbentReader(): MigrationIncumbentReader | null {
  return wiredIncumbentReader;
}

/** Wires (or clears) the native-state reader — the comparison's Aurum side. */
export function setMigrationNativeReader(reader: MigrationNativeReader | null): void {
  wiredNativeReader = reader;
}

/** The currently wired native-state reader (null = none). */
export function getMigrationNativeReader(): MigrationNativeReader | null {
  return wiredNativeReader;
}

/**
 * Wires (or clears) the verification transport — the W084/W088
 * composition: any DeepActionTransport (edge-backed for private/on-prem
 * incumbents via the edge-connector's factory, broker-backed for SaaS)
 * verifies each staged record by re-reading it at commit. Only its
 * INSPECT side is ever invoked — the module never writes back to the
 * incumbent through this or any other path.
 */
export function setMigrationVerificationTransport(transport: DeepActionTransport | null): void {
  wiredVerificationTransport = transport;
}

/** The currently wired verification transport (null = none). */
export function getMigrationVerificationTransport(): DeepActionTransport | null {
  return wiredVerificationTransport;
}

function requireIncumbentReader(): MigrationIncumbentReader {
  if (wiredIncumbentReader === null) {
    throw new MigrationError(
      'reader_unavailable',
      'no incumbent reader is wired — setMigrationIncumbentReader first; the import lifecycle refuses to fake a snapshot',
    );
  }
  return wiredIncumbentReader;
}

function requireNativeReader(): MigrationNativeReader {
  if (wiredNativeReader === null) {
    throw new MigrationError(
      'native_reader_unavailable',
      'no native-state reader is wired — setMigrationNativeReader first; the comparison refuses to fake native Aurum state',
    );
  }
  return wiredNativeReader;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface MigrationRow extends DbRow {
  id: string;
  tenant_id: string;
  incumbent_system_id: string;
  incumbent_system_key: string;
  incumbent_system_display_name: string;
  incumbent_connection_id: string;
  incumbent_read_capability_key: string;
  kit_installation_id: string | null;
  kit_key: string | null;
  kit_version: string | null;
  kit_integration_key: string | null;
  status: Migration['status'];
  compare_clean_round_id: string | null;
  read_only_at: Date | string | null;
  retired_at: Date | string | null;
  sequestered_at: Date | string | null;
  sequestered_by: string | null;
  sequester_reason: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RoundRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  round_number: number;
  kind: ImportRound['kind'];
  status: ImportRound['status'];
  snapshot_ref: string;
  since_snapshot_ref: string | null;
  raw_record_count: number;
  transform_issue_count: number;
  verification: ImportRound['verification'];
  verified_count: number;
  divergent_count: number;
  conflict_count: number;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  committed_at: Date | string | null;
  abandoned_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
}

interface RecordRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  round_id: string;
  position: number;
  source_system_key: string;
  external_id: string;
  match_key: string | null;
  entity_type: string | null;
  snapshot_ref: string;
  payload: Record<string, unknown> | null;
  tombstone: boolean;
  issues: ImportedRecordIssue[];
  state: ImportedRecord['state'];
  disposition: ImportedRecord['disposition'];
  aurum_entity_id: string | null;
  identity_conflict_id: string | null;
  created_at: Date | string;
  committed_at: Date | string | null;
}

interface MapEntryRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  source_system_key: string;
  external_id: string;
  match_key: string | null;
  aurum_entity_id: string;
  round_id: string;
  origin: 'import' | 'conflict-resolution';
  created_by: string;
  created_at: Date | string;
}

interface ConflictRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  round_id: string;
  record_id: string;
  external_id: string;
  match_key: string | null;
  kind: IdentityConflict['kind'];
  candidates: IdentityConflictCandidate[];
  status: IdentityConflict['status'];
  resolution_aurum_entity_id: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
}

interface ComparisonRoundRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  status: 'completed';
  compared_entity_count: number;
  agreement_count: number;
  divergence_count: number;
  note: string | null;
  created_by: string;
  created_at: Date | string;
}

interface ComparisonEntryRow extends DbRow {
  id: string;
  tenant_id: string;
  comparison_round_id: string;
  position: number;
  aurum_entity_id: string;
  kind: ComparisonEntry['kind'];
  mismatches: ComparisonEntry['mismatches'];
  incumbent_only_fields: ComparisonEntry['incumbentOnlyFields'];
  native_only_fields: ComparisonEntry['nativeOnlyFields'];
  reason: string | null;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  position: number;
  event: MigrationEventType;
  detail: string | null;
  round_id: string | null;
  comparison_round_id: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapMigration(row: MigrationRow): Migration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    incumbentSystemId: row.incumbent_system_id,
    incumbentSystemKey: row.incumbent_system_key,
    incumbentSystemDisplayName: row.incumbent_system_display_name,
    incumbentConnectionId: row.incumbent_connection_id,
    incumbentReadCapabilityKey: row.incumbent_read_capability_key,
    kitInstallationId: row.kit_installation_id,
    kitKey: row.kit_key,
    kitVersion: row.kit_version,
    kitIntegrationKey: row.kit_integration_key,
    status: row.status,
    compareCleanRoundId: row.compare_clean_round_id,
    readOnlyAt: toIso(row.read_only_at),
    retiredAt: toIso(row.retired_at),
    sequesteredAt: toIso(row.sequestered_at),
    sequesteredBy: row.sequestered_by,
    sequesterReason: row.sequester_reason,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapRound(row: RoundRow): ImportRound {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    roundNumber: row.round_number,
    kind: row.kind,
    status: row.status,
    snapshotRef: row.snapshot_ref,
    sinceSnapshotRef: row.since_snapshot_ref,
    rawRecordCount: row.raw_record_count,
    transformIssueCount: row.transform_issue_count,
    verification: row.verification,
    verifiedCount: row.verified_count,
    divergentCount: row.divergent_count,
    conflictCount: row.conflict_count,
    reviewedBy: row.reviewed_by,
    reviewedAt: toIso(row.reviewed_at),
    committedAt: toIso(row.committed_at),
    abandonedAt: toIso(row.abandoned_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
  };
}

function mapRecord(row: RecordRow): ImportedRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    roundId: row.round_id,
    position: row.position,
    sourceSystemKey: row.source_system_key,
    externalId: row.external_id,
    matchKey: row.match_key,
    entityType: row.entity_type,
    snapshotRef: row.snapshot_ref,
    payload: row.payload === null ? null : (row.payload as Record<string, unknown>),
    tombstone: row.tombstone,
    issues: Array.isArray(row.issues) ? row.issues : [],
    state: row.state,
    disposition: row.disposition,
    aurumEntityId: row.aurum_entity_id,
    identityConflictId: row.identity_conflict_id,
    createdAt: toIso(row.created_at)!,
    committedAt: toIso(row.committed_at),
  };
}

function mapMapEntry(row: MapEntryRow): IdentifierMapEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    sourceSystemKey: row.source_system_key,
    externalId: row.external_id,
    matchKey: row.match_key,
    aurumEntityId: row.aurum_entity_id,
    roundId: row.round_id,
    origin: row.origin,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
  };
}

function mapConflict(row: ConflictRow): IdentityConflict {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    roundId: row.round_id,
    recordId: row.record_id,
    externalId: row.external_id,
    matchKey: row.match_key,
    kind: row.kind,
    candidates: Array.isArray(row.candidates) ? row.candidates : [],
    status: row.status,
    resolutionAurumEntityId: row.resolution_aurum_entity_id,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    resolvedAt: toIso(row.resolved_at),
    createdAt: toIso(row.created_at)!,
  };
}

function mapComparisonRound(row: ComparisonRoundRow): ComparisonRound {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    status: row.status,
    comparedEntityCount: row.compared_entity_count,
    agreementCount: row.agreement_count,
    divergenceCount: row.divergence_count,
    note: row.note,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
  };
}

function mapComparisonEntry(row: ComparisonEntryRow): ComparisonEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    comparisonRoundId: row.comparison_round_id,
    position: row.position,
    aurumEntityId: row.aurum_entity_id,
    kind: row.kind,
    mismatches: Array.isArray(row.mismatches) ? row.mismatches : [],
    incumbentOnlyFields: Array.isArray(row.incumbent_only_fields)
      ? row.incumbent_only_fields
      : [],
    nativeOnlyFields: Array.isArray(row.native_only_fields) ? row.native_only_fields : [],
    reason: row.reason,
  };
}

function mapEvent(row: EventRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    position: row.position,
    event: row.event,
    detail: row.detail,
    roundId: row.round_id,
    comparisonRoundId: row.comparison_round_id,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at)!,
  };
}

// ---------------------------------------------------------------------------
// Loaders + guards
// ---------------------------------------------------------------------------

async function findMigrationRow(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
): Promise<MigrationRow | null> {
  const rows = await db.query<MigrationRow>(
    `SELECT * FROM migration_migrations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, migrationId],
  );
  return rows.rows[0] ?? null;
}

async function loadMigration(ctx: TenantContext, migrationId: string): Promise<MigrationRow> {
  const row = await findMigrationRow(getDb(), ctx, migrationId);
  if (row === null) {
    throw new MigrationError(
      'migration_not_found',
      `no migration '${migrationId}' exists in this tenant`,
    );
  }
  return row;
}

function requireMigrationStatus(row: MigrationRow, expected: readonly Migration['status'][]): MigrationRow {
  if (!expected.includes(row.status)) {
    throw new MigrationError(
      'migration_not_pending_status',
      `migration '${row.id}' is '${row.status}' — this operation requires ${expected.join(' or ')}`,
    );
  }
  return row;
}

async function findRoundRow(
  db: Queryable,
  ctx: TenantContext,
  roundId: string,
): Promise<RoundRow | null> {
  const rows = await db.query<RoundRow>(
    `SELECT * FROM migration_rounds WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, roundId],
  );
  return rows.rows[0] ?? null;
}

async function loadRound(ctx: TenantContext, roundId: string): Promise<RoundRow> {
  const row = await findRoundRow(getDb(), ctx, roundId);
  if (row === null) {
    throw new MigrationError(
      'round_not_found',
      `no import round '${roundId}' exists in this tenant`,
    );
  }
  return row;
}

function requireRoundStatus(row: RoundRow, expected: ImportRound['status']): RoundRow {
  if (row.status !== expected) {
    throw new MigrationError(
      'round_not_pending_phase',
      `import round '${row.id}' is '${row.status}' — this phase requires '${expected}'`,
    );
  }
  return row;
}

async function listRecordRows(
  db: Queryable,
  ctx: TenantContext,
  roundId: string,
): Promise<RecordRow[]> {
  const rows = await db.query<RecordRow>(
    `SELECT * FROM migration_imported_records WHERE tenant_id = $1 AND round_id = $2 ORDER BY position`,
    [ctx.tenantId, roundId],
  );
  return rows.rows;
}

async function recordEvent(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
  event: MigrationEventType,
  detail: string | null,
  at: Date,
  links?: { roundId?: string | null; comparisonRoundId?: string | null },
): Promise<void> {
  // Monotonic per-migration position: the service clock can hold still
  // within one phase (test-controllable time), so the audit feed stays
  // ordered.
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM migration_events
       WHERE tenant_id = $1 AND migration_id = $2`,
    [ctx.tenantId, migrationId],
  );
  await db.query(
    `INSERT INTO migration_events (
       id, tenant_id, migration_id, position, event, detail,
       round_id, comparison_round_id, recorded_by, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      newId(),
      ctx.tenantId,
      migrationId,
      next.rows[0]?.next ?? 1,
      event,
      detail,
      links?.roundId ?? null,
      links?.comparisonRoundId ?? null,
      ctx.principalId,
      at,
    ],
  );
}

function requireAuthority(ctx: TenantContext, claim: string, action: string): void {
  if (!ctx.authority.includes(claim)) {
    throw new MigrationError(
      'forbidden',
      `${action} requires the '${claim}' authority claim`,
    );
  }
}

/** The open-round guard: at most one open round per migration. */
async function requireNoOpenRound(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
): Promise<void> {
  const open = await db.query<{ id: string }>(
    `SELECT id FROM migration_rounds
       WHERE tenant_id = $1 AND migration_id = $2 AND status IN ('snapshotted', 'staged', 'reviewed')
       ORDER BY round_number DESC LIMIT 1`,
    [ctx.tenantId, migrationId],
  );
  if (open.rows[0] !== undefined) {
    throw new MigrationError(
      'round_open',
      `import round '${open.rows[0].id}' is still open (abandon it first — an abandoned round never becomes a delta base, so its window is re-read)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cross-module loaders (tenant-scoped through the owning contracts)
// ---------------------------------------------------------------------------

/** Loads a Tool & System Inventory entry through the W081 contract. */
async function loadIncumbentSystem(ctx: TenantContext, systemId: string): Promise<InventorySystem> {
  try {
    return await getSystem(ctx, { systemId });
  } catch (error) {
    if (error instanceof IntegrationError && error.code === 'system_not_found') {
      throw new MigrationError(
        'system_not_found',
        `no inventory system '${systemId}' exists in this tenant — the incumbent must be a discovered W081 inventory system`,
      );
    }
    throw error;
  }
}

/** Loads a broker connection through the W082 contract. */
async function loadConnection(ctx: TenantContext, connectionId: string): Promise<BrokerConnection> {
  try {
    return await getConnection(ctx, { connectionId });
  } catch (error) {
    if (error instanceof ConnectionBrokerError && error.code === 'connection_not_found') {
      throw new MigrationError(
        'connection_not_found',
        `no connection '${connectionId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

/** Loads a kit installation through the W092 contract. */
async function loadKitInstallation(
  ctx: TenantContext,
  installationId: string,
): Promise<KitInstallationDetail> {
  try {
    return await getKitInstallation(ctx, { installationId });
  } catch (error) {
    if (error instanceof VerticalKitsError && error.code === 'installation_not_found') {
      throw new MigrationError(
        'kit_not_found',
        `no kit installation '${installationId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

/** Loads a kit version (with its manifest) through the W092 contract. */
async function loadKitVersion(
  ctx: TenantContext,
  kitVersionId: string,
): Promise<VerticalKitVersionWithVerification> {
  try {
    return await getKitVersion(ctx, { kitVersionId });
  } catch (error) {
    if (error instanceof VerticalKitsError && error.code === 'kit_version_not_found') {
      throw new MigrationError(
        'kit_not_found',
        `no kit version '${kitVersionId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// createMigration — the incumbent relationship, frozen
// ---------------------------------------------------------------------------

export async function createMigration(
  ctx: TenantContext,
  input: CreateMigrationInput,
): Promise<CreateMigrationResult> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_ADMINISTER, 'creating a migration');
  const valid = validateCreateMigrationInput(input);

  // The incumbent must be a discovered W081 inventory system, and the read
  // capability must be on its live surface (a migration you cannot read
  // is not a migration).
  const system = await loadIncumbentSystem(ctx, valid.incumbentSystemId);
  const capability = system.capabilities.find(
    (entry) => entry.key === valid.incumbentReadCapabilityKey,
  );
  if (capability === undefined) {
    throw new MigrationError(
      'capability_not_offered',
      `capability '${valid.incumbentReadCapabilityKey}' is not on the surface of '${system.displayName}' — the offered capabilities are ${system.capabilities.map((c) => c.key).join(', ')}`,
    );
  }
  if (capability.mode !== 'read') {
    throw new MigrationError(
      'capability_not_offered',
      `capability '${valid.incumbentReadCapabilityKey}' on '${system.displayName}' is a ${capability.mode} capability — import rounds exercise READ capabilities`,
    );
  }

  // The incumbent reads ride a CONNECTED W082 broker connection (the
  // opaque credentialRef discipline: it is loaded live when needed and
  // passes straight through to the wired reader / verification transport;
  // it is never persisted here).
  const connection = await loadConnection(ctx, valid.incumbentConnectionId);
  if (connection.status !== 'connected') {
    throw new MigrationError(
      'connection_not_connected',
      `connection '${valid.incumbentConnectionId}' is '${connection.status}', not 'connected' — a disconnected connection confers no read`,
    );
  }

  // The optional W092 kit binding: the installation must exist and be
  // active, and the integration key must be declared by the installed
  // version's manifest (the industry-shaped incumbent surface).
  let kitKey: string | null = null;
  let kitVersion: string | null = null;
  if (valid.kitInstallationId !== null) {
    const installation = await loadKitInstallation(ctx, valid.kitInstallationId);
    if (installation.installation.status !== 'active') {
      throw new MigrationError(
        'kit_not_found',
        `kit installation '${valid.kitInstallationId}' is '${installation.installation.status}', not 'active' — an inactive kit binds nothing`,
      );
    }
    const version = await loadKitVersion(ctx, installation.installation.kitVersionId);
    const declared = version.manifest.edgeIntegrations.find(
      (entry) => entry.integrationKey === valid.kitIntegrationKey,
    );
    if (declared === undefined) {
      throw new MigrationError(
        'kit_integration_not_declared',
        `kit '${version.kitKey}' ${version.version} does not declare an integration '${valid.kitIntegrationKey}' — the declared integrations are ${version.manifest.edgeIntegrations.map((entry) => entry.integrationKey).join(', ')}`,
      );
    }
    kitKey = version.kitKey;
    kitVersion = version.version;
  }

  const db = getDb();
  const at = now();

  // One LIVE migration per incumbent system (the identifier map is per
  // source system; a second concurrent migration would fork it). An
  // identical live migration replays idempotently.
  const existing = await db.query<MigrationRow>(
    `SELECT * FROM migration_migrations
       WHERE tenant_id = $1 AND incumbent_system_id = $2
         AND status IN ('dual-running', 'compare-clean', 'incumbent-read-only')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, valid.incumbentSystemId],
  );
  const live = existing.rows[0];
  if (live !== undefined) {
    const identical =
      live.incumbent_connection_id === valid.incumbentConnectionId &&
      live.incumbent_read_capability_key === valid.incumbentReadCapabilityKey &&
      (live.kit_installation_id ?? null) === valid.kitInstallationId &&
      (live.kit_integration_key ?? null) === valid.kitIntegrationKey;
    if (!identical) {
      throw new MigrationError(
        'live_migration_exists',
        `a live migration for system '${system.displayName}' already exists (${live.id}) with a different configuration — one live migration per incumbent system`,
      );
    }
    return { migration: mapMigration(live), created: false };
  }

  const migrationId = newId();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO migration_migrations (
         id, tenant_id, incumbent_system_id, incumbent_system_key,
         incumbent_system_display_name, incumbent_connection_id,
         incumbent_read_capability_key, kit_installation_id, kit_key,
         kit_version, kit_integration_key, status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'dual-running', $12, $13, $13)`,
      [
        migrationId,
        ctx.tenantId,
        valid.incumbentSystemId,
        system.systemKey,
        system.displayName,
        valid.incumbentConnectionId,
        valid.incumbentReadCapabilityKey,
        valid.kitInstallationId,
        kitKey,
        kitVersion,
        valid.kitIntegrationKey,
        ctx.principalId,
        at,
      ],
    );
    await recordEvent(
      tx,
      ctx,
      migrationId,
      'created',
      `migration off incumbent '${system.displayName}' (${system.systemKey}) via connection '${valid.incumbentConnectionId}'`,
      at,
    );
  });

  const row = (await findMigrationRow(db, ctx, migrationId))!;
  return { migration: mapMigration(row), created: true };
}

// ---------------------------------------------------------------------------
// SNAPSHOT — the staged round opens with the incumbent's versioned answer
// ---------------------------------------------------------------------------

export async function captureSnapshot(
  ctx: TenantContext,
  input: CaptureSnapshotInput,
): Promise<CaptureSnapshotResult> {
  assertMigrationTenantContext(ctx);
  const valid = validateCaptureSnapshotInput(input);
  const db = getDb();
  const migration = requireMigrationStatus(
    await loadMigration(ctx, valid.migrationId),
    [...MIGRATION_LIVE_STATUSES],
  );
  await requireNoOpenRound(db, ctx, migration.id);

  // The delta base: the last COMMITTED round's snapshot reference (an
  // abandoned round never becomes a base, so its window is re-read — no
  // silent data loss).
  const lastCommitted = await db.query<RoundRow>(
    `SELECT * FROM migration_rounds
       WHERE tenant_id = $1 AND migration_id = $2 AND status = 'committed'
       ORDER BY round_number DESC LIMIT 1`,
    [ctx.tenantId, migration.id],
  );
  const base = lastCommitted.rows[0]?.snapshot_ref ?? null;
  let kind: 'full' | 'delta';
  if (valid.kind === null) {
    kind = base === null ? 'full' : 'delta';
  } else {
    kind = valid.kind;
    if (kind === 'delta' && base === null) {
      throw new MigrationError(
        'invalid_input',
        'an explicit delta round requires a committed round to read changes since — capture a full round first',
      );
    }
  }

  const reader = requireIncumbentReader();
  // The connection's OPAQUE credentialRef is loaded live and passes
  // straight through to the reader (the W082 discipline — never stored).
  const connection = await loadConnection(ctx, migration.incumbent_connection_id);
  if (connection.status !== 'connected') {
    throw new MigrationError(
      'connection_not_connected',
      `connection '${migration.incumbent_connection_id}' is '${connection.status}', not 'connected' — the incumbent read cannot ride it`,
    );
  }

  const roundId = newId();
  const snapshot = canonicalizeSnapshotResult(
    await reader.readSnapshot({
      connectionId: migration.incumbent_connection_id,
      credentialRef: connection.credentialRef ?? '',
      systemKey: migration.incumbent_system_key,
      readCapabilityKey: migration.incumbent_read_capability_key,
      sinceSnapshotRef: kind === 'delta' ? base : null,
      idempotencyKey: `${MIGRATION_CHANNEL}:${roundId}`,
    }),
    'the incumbent reader',
  );

  const at = now();
  const recordIds = snapshot.records.map(() => newId());
  await db.transaction(async (tx) => {
    const next = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(round_number), 0) + 1 AS next FROM migration_rounds
         WHERE tenant_id = $1 AND migration_id = $2`,
      [ctx.tenantId, migration.id],
    );
    const roundNumber = next.rows[0]?.next ?? 1;
    await tx.query(
      `INSERT INTO migration_rounds (
         id, tenant_id, migration_id, round_number, kind, status,
         snapshot_ref, since_snapshot_ref, raw_record_count, created_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'snapshotted', $6, $7, $8, $9, $10)`,
      [
        roundId,
        ctx.tenantId,
        migration.id,
        roundNumber,
        kind,
        snapshot.snapshotRef,
        kind === 'delta' ? base : null,
        snapshot.records.length,
        ctx.principalId,
        at,
      ],
    );
    for (const [index, record] of snapshot.records.entries()) {
      await tx.query(
        `INSERT INTO migration_imported_records (
           id, tenant_id, migration_id, round_id, position, source_system_key,
           external_id, match_key, entity_type, snapshot_ref, payload, tombstone,
           state, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'snapshotted', $13)`,
        [
          recordIds[index],
          ctx.tenantId,
          migration.id,
          roundId,
          index + 1,
          migration.incumbent_system_key,
          record.externalId,
          record.matchKey,
          record.entityType,
          snapshot.snapshotRef,
          record.payload === null ? null : JSON.stringify(record.payload),
          record.tombstone,
          at,
        ],
      );
    }
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'snapshot-captured',
      `${kind} round ${roundNumber}: ${snapshot.records.length} record(s) at snapshot '${snapshot.snapshotRef}'`,
      at,
      { roundId },
    );
  });

  const round = mapRound((await findRoundRow(db, ctx, roundId))!);
  const records = (await listRecordRows(db, ctx, roundId)).map(mapRecord);
  return { round, records };
}

// ---------------------------------------------------------------------------
// TRANSFORM — deterministic validation; issues surfaced, never dropped
// ---------------------------------------------------------------------------

export async function transformImportRound(
  ctx: TenantContext,
  input: { roundId: string },
): Promise<{ round: ImportRound; records: ImportedRecord[] }> {
  assertMigrationTenantContext(ctx);
  const valid = validateRoundIdInput(input);
  const db = getDb();
  const round = requireRoundStatus(await loadRound(ctx, valid.roundId), 'snapshotted');
  const migration = requireMigrationStatus(
    await loadMigration(ctx, round.migration_id),
    [...MIGRATION_LIVE_STATUSES],
  );

  // The kit's schema hints (when the migration is kit-bound) drive the
  // per-record issue detection — read through the W092 contract.
  let schemaHints: readonly KitSchemaHintLike[] = [];
  let hintedEntities: Set<string> | null = null;
  if (migration.kit_installation_id !== null) {
    const installation = await loadKitInstallation(ctx, migration.kit_installation_id);
    const version = await loadKitVersion(ctx, installation.installation.kitVersionId);
    const declared = version.manifest.edgeIntegrations.find(
      (entry) => entry.integrationKey === migration.kit_integration_key,
    );
    schemaHints = version.manifest.dataSchemaHints;
    hintedEntities =
      declared === undefined ? new Set<string>() : new Set(declared.schemaHintEntities);
  }

  const records = await listRecordRows(db, ctx, round.id);
  const at = now();
  let issueRecords = 0;
  await db.transaction(async (tx) => {
    for (const record of records) {
      const issues: ImportedRecordIssue[] =
        record.tombstone || record.payload === null
          ? []
          : detectSchemaHintIssues(record.payload, record.entity_type, schemaHints);
      if (
        hintedEntities !== null &&
        !record.tombstone &&
        record.entity_type !== null &&
        hintedEntities.has(record.entity_type) === false &&
        schemaHints.some((hint) => hint.entity === record.entity_type)
      ) {
        // The record's entity type is hinted by the kit but NOT covered by
        // the bound integration's declared entities — surfaced, not hidden.
        issues.push({
          code: 'schema-hint-entity-outside-integration',
          field: null,
          detail: `the bound kit hints entity '${record.entity_type}' but the bound integration '${migration.kit_integration_key}' does not declare it`,
        });
      }
      if (issues.length > 0) issueRecords += 1;
      await tx.query(
        `UPDATE migration_imported_records SET state = 'staged', issues = $3::jsonb
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, record.id, JSON.stringify(issues)],
      );
    }
    await tx.query(
      `UPDATE migration_rounds SET status = 'staged', transform_issue_count = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, round.id, issueRecords],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'transformed',
      `round ${round.round_number}: ${records.length} record(s) staged, ${issueRecords} with surfaced issues`,
      at,
      { roundId: round.id },
    );
  });

  const updated = mapRound((await findRoundRow(db, ctx, round.id))!);
  return { round: updated, records: (await listRecordRows(db, ctx, round.id)).map(mapRecord) };
}

// ---------------------------------------------------------------------------
// REVIEW — the human gate before anything links
// ---------------------------------------------------------------------------

export async function reviewImportRound(
  ctx: TenantContext,
  input: { roundId: string },
): Promise<ImportRound> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_REVIEW, 'reviewing an import round');
  const valid = validateRoundIdInput(input);
  const db = getDb();
  const round = requireRoundStatus(await loadRound(ctx, valid.roundId), 'staged');
  const migration = requireMigrationStatus(
    await loadMigration(ctx, round.migration_id),
    [...MIGRATION_LIVE_STATUSES],
  );
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_rounds SET status = 'reviewed', reviewed_by = $3, reviewed_at = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, round.id, ctx.principalId, at],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'reviewed',
      `round ${round.round_number} reviewed for commit`,
      at,
      { roundId: round.id },
    );
  });
  return mapRound((await findRoundRow(db, ctx, round.id))!);
}

// ---------------------------------------------------------------------------
// COMMIT — identifiers preserved, collisions surfaced (never auto-merged)
// ---------------------------------------------------------------------------

/**
 * Canonicalizes one verification-transport read (the deep-actions
 * canonicalization discipline): plain JSON only, modest size, a boolean
 * `found` — a provider object cannot cross.
 */
function canonicalizeVerificationRead(
  result: unknown,
  externalId: string,
): { found: boolean; state: unknown } {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new MigrationError(
      'invalid_reader_result',
      `the verification transport returned a non-object read for '${externalId}' — provider objects never cross the module`,
    );
  }
  const candidate = result as Partial<DeepActionState>;
  if (typeof candidate.found !== 'boolean') {
    throw new MigrationError(
      'invalid_reader_result',
      `the verification transport returned a read without a boolean 'found' for '${externalId}'`,
    );
  }
  const state = candidate.state === undefined ? null : candidate.state;
  if (!isPlainJsonValue(state)) {
    throw new MigrationError(
      'invalid_reader_result',
      `the verification transport returned a non-JSON state for '${externalId}' — provider objects never cross the module`,
    );
  }
  const serialized = JSON.stringify(state) ?? 'null';
  if (serialized.length > 262_144) {
    throw new MigrationError(
      'invalid_reader_result',
      `the verification transport returned a state exceeding 262144 bytes for '${externalId}' — large artifacts belong in object storage`,
    );
  }
  return { found: candidate.found, state };
}


/** Inserts one identifier-map entry inside a commit/resolution transaction. */
async function insertMapEntry(
  tx: Queryable,
  ctx: TenantContext,
  input: {
    migrationId: string;
    sourceSystemKey: string;
    externalId: string;
    matchKey: string | null;
    aurumEntityId: string;
    roundId: string;
    origin: 'import' | 'conflict-resolution';
    at: Date;
  },
): Promise<MapEntryRow> {
  const entryId = newId();
  await tx.query(
    `INSERT INTO migration_identifier_map (
       id, tenant_id, migration_id, source_system_key, external_id,
       match_key, aurum_entity_id, round_id, origin, created_by, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entryId,
      ctx.tenantId,
      input.migrationId,
      input.sourceSystemKey,
      input.externalId,
      input.matchKey,
      input.aurumEntityId,
      input.roundId,
      input.origin,
      ctx.principalId,
      input.at,
    ],
  );
  return {
    id: entryId,
    tenant_id: ctx.tenantId,
    migration_id: input.migrationId,
    source_system_key: input.sourceSystemKey,
    external_id: input.externalId,
    match_key: input.matchKey,
    aurum_entity_id: input.aurumEntityId,
    round_id: input.roundId,
    origin: input.origin,
    created_by: ctx.principalId,
    created_at: input.at,
  };
}

export async function commitImportRound(
  ctx: TenantContext,
  input: { roundId: string },
): Promise<CommitImportRoundResult> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_ADMINISTER, 'committing an import round');
  const valid = validateRoundIdInput(input);
  const db = getDb();
  const round = requireRoundStatus(await loadRound(ctx, valid.roundId), 'reviewed');
  const migration = requireMigrationStatus(
    await loadMigration(ctx, round.migration_id),
    [...MIGRATION_LIVE_STATUSES],
  );
  const records = await listRecordRows(db, ctx, round.id);

  // The commit-time verification reads (the W084/W088 composition): each
  // staged record is re-read through the wired deep-action transport and
  // compared with the staged payload. Divergences are SURFACED (recorded
  // on the round and as an event) — never silently fixed, and never a
  // reason to drop evidence. No transport wired → the honest 'not-wired'.
  let verification: 'not-wired' | 'verified' | 'divergent' = 'not-wired';
  let verifiedCount = 0;
  let divergentCount = 0;
  const divergentDetails: string[] = [];
  if (wiredVerificationTransport !== null && records.length > 0) {
    // The connection's OPAQUE credentialRef loads live and passes through.
    const connection = await loadConnection(ctx, migration.incumbent_connection_id);
    if (connection.status !== 'connected') {
      throw new MigrationError(
        'connection_not_connected',
        `connection '${migration.incumbent_connection_id}' is '${connection.status}', not 'connected' — the verification read cannot ride it`,
      );
    }
    verification = 'verified';
    for (const record of records) {
      if (record.tombstone) continue;
      const request: DeepActionInspectRequest = {
        connectionId: migration.incumbent_connection_id,
        credentialRef: connection.credentialRef ?? '',
        systemKey: migration.incumbent_system_key,
        capabilityKey: migration.incumbent_read_capability_key,
        target: record.external_id,
        idempotencyKey: `${MIGRATION_CHANNEL}:${round.id}:${record.id}:verify`,
      };
      const read = canonicalizeVerificationRead(
        await wiredVerificationTransport.inspect(request),
        record.external_id,
      );
      if (read.found && jsonDeepEqual(read.state, record.payload)) {
        verifiedCount += 1;
      } else {
        verification = 'divergent';
        divergentCount += 1;
        divergentDetails.push(
          read.found
            ? `'${record.external_id}': the verification read diverges from the staged payload`
            : `'${record.external_id}': the verification read did not find the record`,
        );
      }
    }
  }

  const at = now();
  const conflictIds: string[] = [];
  const mapEntryIds: string[] = [];

  await db.transaction(async (tx) => {
    // The existing map entries of THIS migration, by external id.
    const ownEntries = await tx.query<MapEntryRow>(
      `SELECT * FROM migration_identifier_map WHERE tenant_id = $1 AND migration_id = $2`,
      [ctx.tenantId, migration.id],
    );
    const ownByExternalId = new Map(ownEntries.rows.map((row) => [row.external_id, row]));

    const insertedEntries: MapEntryRow[] = [];

    for (const record of records) {
      const existing = ownByExternalId.get(record.external_id);

      // A tombstone: the incumbent deleted the record. The map entry (if
      // any) is PRESERVED — identifiers survive deletion; the current
      // imported state becomes the tombstone.
      if (record.tombstone) {
        await tx.query(
          `UPDATE migration_imported_records
             SET state = 'committed', disposition = 'tombstone',
                 aurum_entity_id = $3, committed_at = $4
             WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, record.id, existing?.aurum_entity_id ?? null, at],
        );
        continue;
      }

      // The external id is already mapped (a delta-round update of the
      // same incumbent entity — identifiers preserved by construction).
      if (existing !== undefined) {
        await tx.query(
          `UPDATE migration_imported_records
             SET state = 'committed', disposition = 'update',
                 aurum_entity_id = $3, committed_at = $4
             WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, record.id, existing.aurum_entity_id, at],
        );
        continue;
      }

      // A record with no natural key always mints a fresh entity.
      if (record.match_key === null) {
        const entity = newId();
        await tx.query(
          `UPDATE migration_imported_records
             SET state = 'committed', disposition = 'new',
                 aurum_entity_id = $3, committed_at = $4
             WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, record.id, entity, at],
        );
        const entry = await insertMapEntry(tx, ctx, {
          migrationId: migration.id,
          sourceSystemKey: migration.incumbent_system_key,
          externalId: record.external_id,
          matchKey: record.match_key,
          aurumEntityId: entity,
          roundId: round.id,
          origin: 'import',
          at,
        });
        insertedEntries.push(entry);
        ownByExternalId.set(record.external_id, entry);
        continue;
      }

      // The candidate claims: LIVE map entries (any migration, excluding
      // sequestered ones) carrying the same natural match key — including
      // entries this round already established.
      const claims = await tx.query<MapEntryRow>(
        `SELECT m.* FROM migration_identifier_map m
           JOIN migration_migrations mig
             ON mig.tenant_id = m.tenant_id AND mig.id = m.migration_id
          WHERE m.tenant_id = $1 AND m.match_key = $2 AND mig.status <> 'sequestered'`,
        [ctx.tenantId, record.match_key],
      );
      const candidates: MapEntryRow[] = claims.rows;
      const distinctEntities = new Set(candidates.map((candidate) => candidate.aurum_entity_id));

      if (candidates.length === 0) {
        // No claim: mint a fresh Aurum entity.
        const entity = newId();
        await tx.query(
          `UPDATE migration_imported_records
             SET state = 'committed', disposition = 'new',
                 aurum_entity_id = $3, committed_at = $4
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, record.id, entity, at],
        );
        const entry = await insertMapEntry(tx, ctx, {
          migrationId: migration.id,
          sourceSystemKey: migration.incumbent_system_key,
          externalId: record.external_id,
          matchKey: record.match_key,
          aurumEntityId: entity,
          roundId: round.id,
          origin: 'import',
          at,
        });
        insertedEntries.push(entry);
        ownByExternalId.set(record.external_id, entry);
        continue;
      }

      if (
        distinctEntities.size === 1 &&
        candidates[0]!.source_system_key === migration.incumbent_system_key
      ) {
        // One claim, SAME source system: the natural key resolves through
        // the map (a re-issued external id keeps its Aurum identity).
        const entity = candidates[0]!.aurum_entity_id;
        await tx.query(
          `UPDATE migration_imported_records
             SET state = 'committed', disposition = 'matched',
                 aurum_entity_id = $3, committed_at = $4
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, record.id, entity, at],
        );
        const entry = await insertMapEntry(tx, ctx, {
          migrationId: migration.id,
          sourceSystemKey: migration.incumbent_system_key,
          externalId: record.external_id,
          matchKey: record.match_key,
          aurumEntityId: entity,
          roundId: round.id,
          origin: 'import',
          at,
        });
        insertedEntries.push(entry);
        ownByExternalId.set(record.external_id, entry);
        continue;
      }

      // A COLLISION: another external system claims the same entity
      // (cross-system), or the claims span multiple Aurum entities
      // (ambiguous). Surface an explicit conflict record; link NOTHING
      // until a human resolves (the W095 rule applied to migration).
      const conflictId = newId();
      const kind: IdentityConflict['kind'] =
        distinctEntities.size > 1 ? 'ambiguous-match' : 'cross-system-collision';
      const candidateClaims: IdentityConflictCandidate[] = candidates.map((candidate) => ({
        sourceSystemKey: candidate.source_system_key,
        externalId: candidate.external_id,
        aurumEntityId: candidate.aurum_entity_id,
        migrationId: candidate.migration_id,
      }));
      await tx.query(
        `INSERT INTO migration_identity_conflicts (
           id, tenant_id, migration_id, round_id, record_id, external_id,
           match_key, kind, candidates, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          conflictId,
          ctx.tenantId,
          migration.id,
          round.id,
          record.id,
          record.external_id,
          record.match_key,
          kind,
          JSON.stringify(candidateClaims),
          at,
        ],
      );
      await tx.query(
        `UPDATE migration_imported_records
           SET state = 'committed', disposition = 'conflicted',
               identity_conflict_id = $3, committed_at = $4
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, record.id, conflictId, at],
      );
      conflictIds.push(conflictId);
      await recordEvent(
        tx,
        ctx,
        migration.id,
        'identity-conflict-raised',
        `${kind} on '${record.external_id}' (match key '${record.match_key}') — ${candidateClaims.length} claim(s), never auto-merged`,
        at,
        { roundId: round.id },
      );
    }

    mapEntryIds.push(...insertedEntries.map((entry) => entry.id));

    await tx.query(
      `UPDATE migration_rounds
         SET status = 'committed', committed_at = $3, verification = $4,
             verified_count = $5, divergent_count = $6, conflict_count = $7
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, round.id, at, verification, verifiedCount, divergentCount, conflictIds.length],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'committed',
      `round ${round.round_number} committed: ${records.length} record(s), ${conflictIds.length} conflict(s), verification '${verification}'`,
      at,
      { roundId: round.id },
    );
    if (divergentDetails.length > 0) {
      await recordEvent(
        tx,
        ctx,
        migration.id,
        'verification-divergence',
        divergentDetails.join('; ').slice(0, 500),
        at,
        { roundId: round.id },
      );
    }
  });

  const updatedRound = mapRound((await findRoundRow(db, ctx, round.id))!);
  const updatedRecords = (await listRecordRows(db, ctx, round.id)).map(mapRecord);
  const conflictRows = conflictIds.length
    ? (
        await db.query<ConflictRow>(
          `SELECT * FROM migration_identity_conflicts WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [ctx.tenantId, conflictIds],
        )
      ).rows
    : [];
  const entryRows = mapEntryIds.length
    ? (
        await db.query<MapEntryRow>(
          `SELECT * FROM migration_identifier_map WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [ctx.tenantId, mapEntryIds],
        )
      ).rows
    : [];
  return {
    round: updatedRound,
    records: updatedRecords,
    conflicts: conflictRows.map(mapConflict),
    mapEntries: entryRows.map(mapMapEntry),
  };
}

// ---------------------------------------------------------------------------
// ABANDON — the explicit dead end (the window is re-read, nothing lost)
// ---------------------------------------------------------------------------

export async function abandonImportRound(
  ctx: TenantContext,
  input: { roundId: string },
): Promise<ImportRound> {
  assertMigrationTenantContext(ctx);
  const valid = validateRoundIdInput(input);
  const db = getDb();
  const round = await loadRound(ctx, valid.roundId);
  if (round.status !== 'snapshotted' && round.status !== 'staged' && round.status !== 'reviewed') {
    throw new MigrationError(
      'round_not_pending_phase',
      `import round '${round.id}' is '${round.status}' — only an open round can be abandoned`,
    );
  }
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_imported_records SET state = 'abandoned'
         WHERE tenant_id = $1 AND round_id = $2`,
      [ctx.tenantId, round.id],
    );
    await tx.query(
      `UPDATE migration_rounds SET status = 'abandoned', abandoned_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, round.id, at],
    );
    await recordEvent(
      tx,
      ctx,
      round.migration_id,
      'round-abandoned',
      `round ${round.round_number} abandoned — its window is re-read by the next round (never a delta base)`,
      at,
      { roundId: round.id },
    );
  });
  return mapRound((await findRoundRow(db, ctx, round.id))!);
}

// ---------------------------------------------------------------------------
// Conflict resolution — the explicit human identity decision
// ---------------------------------------------------------------------------

export async function resolveIdentityConflict(
  ctx: TenantContext,
  input: ResolveIdentityConflictInput,
): Promise<IdentityConflict> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_ADMINISTER, 'resolving an identity conflict');
  const valid = validateResolveConflictInput(input);
  const db = getDb();
  const conflictRows = await db.query<ConflictRow>(
    `SELECT * FROM migration_identity_conflicts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.conflictId],
  );
  const conflict = conflictRows.rows[0];
  if (conflict === undefined) {
    throw new MigrationError(
      'conflict_not_found',
      `no identity conflict '${valid.conflictId}' exists in this tenant`,
    );
  }
  if (conflict.status !== 'open') {
    throw new MigrationError(
      'conflict_not_open',
      `identity conflict '${conflict.id}' is already resolved`,
    );
  }
  const migration = await loadMigration(ctx, conflict.migration_id);
  if (migration.status === 'sequestered') {
    throw new MigrationError(
      'migration_already_final',
      `migration '${migration.id}' is sequestered — its conflicts stay as surfaced evidence`,
    );
  }
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_identity_conflicts
         SET status = 'resolved', resolution_aurum_entity_id = $3,
             resolution_note = $4, resolved_by = $5, resolved_at = $6
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, conflict.id, valid.aurumEntityId, valid.note, ctx.principalId, at],
    );
    await tx.query(
      `UPDATE migration_imported_records
         SET disposition = 'resolved', aurum_entity_id = $3
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, conflict.record_id, valid.aurumEntityId],
    );
    await insertMapEntry(tx, ctx, {
      migrationId: conflict.migration_id,
      sourceSystemKey: migration.incumbent_system_key,
      externalId: conflict.external_id,
      matchKey: conflict.match_key,
      aurumEntityId: valid.aurumEntityId,
      roundId: conflict.round_id,
      origin: 'conflict-resolution',
      at,
    });
    await recordEvent(
      tx,
      ctx,
      conflict.migration_id,
      'identity-conflict-resolved',
      `conflict on '${conflict.external_id}' resolved to '${valid.aurumEntityId}' by an explicit decision`,
      at,
      { roundId: conflict.round_id },
    );
  });
  const updated = await db.query<ConflictRow>(
    `SELECT * FROM migration_identity_conflicts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, conflict.id],
  );
  return mapConflict(updated.rows[0]!);
}

// ---------------------------------------------------------------------------
// COMPARISON — the dual-run question, evaluated and surfaced
// ---------------------------------------------------------------------------

interface CurrentStateRow extends DbRow {
  aurum_entity_id: string;
  record_id: string;
  external_id: string;
  payload: Record<string, unknown> | null;
  tombstone: boolean;
  round_id: string;
  round_number: number;
}

/** The current incumbent-imported state per entity of ONE migration. */
async function listCurrentStateRows(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
): Promise<CurrentStateRow[]> {
  const rows = await db.query<CurrentStateRow>(
    `SELECT DISTINCT ON (mapped.aurum_entity_id)
       mapped.aurum_entity_id, r.id AS record_id, r.external_id,
       r.payload, r.tombstone, r.round_id, rd.round_number
     FROM migration_identifier_map mapped
     JOIN migration_imported_records r
       ON r.tenant_id = mapped.tenant_id
      AND r.migration_id = mapped.migration_id
      AND r.external_id = mapped.external_id
      AND r.state = 'committed'
     JOIN migration_rounds rd
       ON rd.tenant_id = r.tenant_id AND rd.id = r.round_id
     WHERE mapped.tenant_id = $1 AND mapped.migration_id = $2
     ORDER BY mapped.aurum_entity_id, rd.round_number DESC, r.position DESC`,
    [ctx.tenantId, migrationId],
  );
  return rows.rows;
}

export async function runComparisonRound(
  ctx: TenantContext,
  input: { migrationId: string; note?: string | null },
): Promise<RunComparisonRoundResult> {
  assertMigrationTenantContext(ctx);
  const valid = validateRunComparisonInput(input);
  const db = getDb();
  const migration = requireMigrationStatus(
    await loadMigration(ctx, valid.migrationId),
    [...MIGRATION_LIVE_STATUSES],
  );

  const reader = requireNativeReader();
  // The COMPLETE native state set: entities the incumbent never imported
  // surface as 'incumbent-missing' divergences (never hidden).
  const native = canonicalizeNativeStates(
    await reader.readNativeStates({ entityIds: null }),
    'the native-state reader',
  );
  const nativeByEntity = new Map(native.states.map((entry) => [entry.aurumEntityId, entry.state]));

  const currentStates = await listCurrentStateRows(db, ctx, migration.id);
  const incumbentByEntity = new Map(currentStates.map((row) => [row.aurum_entity_id, row]));

  // The compared universe: every entity either side knows, deterministic
  // order (aurum entity id).
  const entityIds = [...new Set([...incumbentByEntity.keys(), ...nativeByEntity.keys()])].sort();

  const entries: Array<{
    aurumEntityId: string;
    kind: ComparisonEntry['kind'];
    mismatches: ComparisonEntry['mismatches'];
    incumbentOnlyFields: ComparisonEntry['incumbentOnlyFields'];
    nativeOnlyFields: ComparisonEntry['nativeOnlyFields'];
    reason: string | null;
  }> = [];
  let agreementCount = 0;
  let divergenceCount = 0;

  for (const entityId of entityIds) {
    const incumbent = incumbentByEntity.get(entityId);
    const nativeState = nativeByEntity.get(entityId) ?? null;
    if (incumbent === undefined) {
      // A native-only entity: the incumbent never imported it.
      entries.push({
        aurumEntityId: entityId,
        kind: 'incumbent-missing',
        mismatches: [],
        incumbentOnlyFields: [],
        nativeOnlyFields: [],
        reason: buildIncumbentMissingReason(entityId),
      });
      divergenceCount += 1;
      continue;
    }
    const verdict = compareEntity({
      aurumEntityId: entityId,
      incumbentState: incumbent.tombstone ? null : (incumbent.payload as Record<string, unknown>),
      nativeState,
    });
    entries.push({
      aurumEntityId: entityId,
      kind: verdict.kind,
      mismatches: verdict.mismatches,
      incumbentOnlyFields: verdict.incumbentOnlyFields,
      nativeOnlyFields: verdict.nativeOnlyFields,
      reason: verdict.reason,
    });
    if (verdict.kind === 'agreement') {
      agreementCount += 1;
    } else {
      divergenceCount += 1;
    }
  }

  const at = now();
  const comparisonRoundId = newId();
  const entryIds = entries.map(() => newId());
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO migration_comparison_rounds (
         id, tenant_id, migration_id, status, compared_entity_count,
         agreement_count, divergence_count, note, created_by, created_at
       ) VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, $9)`,
      [
        comparisonRoundId,
        ctx.tenantId,
        migration.id,
        entries.length,
        agreementCount,
        divergenceCount,
        valid.note,
        ctx.principalId,
        at,
      ],
    );
    for (const [index, entry] of entries.entries()) {
      await tx.query(
        `INSERT INTO migration_comparison_entries (
           id, tenant_id, comparison_round_id, position, aurum_entity_id,
           kind, mismatches, incumbent_only_fields, native_only_fields, reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
        [
          entryIds[index],
          ctx.tenantId,
          comparisonRoundId,
          index + 1,
          entry.aurumEntityId,
          entry.kind,
          JSON.stringify(entry.mismatches),
          JSON.stringify(entry.incumbentOnlyFields),
          JSON.stringify(entry.nativeOnlyFields),
          entry.reason,
        ],
      );
    }
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'comparison-completed',
      `comparison round: ${entries.length} entity(ies), ${agreementCount} agreement(s), ${divergenceCount} divergence(s)`,
      at,
      { comparisonRoundId },
    );
  });

  const roundRows = await db.query<ComparisonRoundRow>(
    `SELECT * FROM migration_comparison_rounds WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, comparisonRoundId],
  );
  const entryRows = await db.query<ComparisonEntryRow>(
    `SELECT * FROM migration_comparison_entries
       WHERE tenant_id = $1 AND comparison_round_id = $2 ORDER BY position`,
    [ctx.tenantId, comparisonRoundId],
  );
  return { round: mapComparisonRound(roundRows.rows[0]!), entries: entryRows.rows.map(mapComparisonEntry) };
}

// ---------------------------------------------------------------------------
// The retirement checkpoints — evidence-linked, auditable
// ---------------------------------------------------------------------------

/** The latest completed comparison round of a migration (null = none). */
async function latestComparisonRound(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
): Promise<ComparisonRoundRow | null> {
  const rows = await db.query<ComparisonRoundRow>(
    `SELECT * FROM migration_comparison_rounds
       WHERE tenant_id = $1 AND migration_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, migrationId],
  );
  return rows.rows[0] ?? null;
}

async function requireCleanComparison(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
): Promise<ComparisonRoundRow> {
  const latest = await latestComparisonRound(db, ctx, migrationId);
  if (latest === null || latest.divergence_count > 0) {
    throw new MigrationError(
      'compare_clean_required',
      latest === null
        ? `migration '${migrationId}' has no completed comparison round — run one before this checkpoint`
        : `the latest comparison round (${latest.id}) holds ${latest.divergence_count} divergence(s) — resolve them and run a clean round before this checkpoint`,
    );
  }
  return latest;
}

export async function advanceToCompareClean(
  ctx: TenantContext,
  input: { migrationId: string },
): Promise<Migration> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_ADMINISTER, 'advancing to the compare-clean checkpoint');
  const valid = validateMigrationIdInput(input);
  const db = getDb();
  const migration = requireMigrationStatus(
    await loadMigration(ctx, valid.migrationId),
    ['dual-running'],
  );
  await requireNoOpenRound(db, ctx, migration.id);
  const clean = await requireCleanComparison(db, ctx, migration.id);
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_migrations
         SET status = 'compare-clean', compare_clean_round_id = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, migration.id, clean.id, at],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'compare-clean-checkpoint',
      `comparison round ${clean.id} holds zero divergences (the evidence link)`,
      at,
      { comparisonRoundId: clean.id },
    );
  });
  return mapMigration((await findMigrationRow(db, ctx, migration.id))!);
}

export async function advanceToIncumbentReadOnly(
  ctx: TenantContext,
  input: { migrationId: string },
): Promise<Migration> {
  assertMigrationTenantContext(ctx);
  requireAuthority(
    ctx,
    MIGRATION_AUTHORITY_ADMINISTER,
    'advancing to the incumbent-read-only checkpoint',
  );
  const valid = validateMigrationIdInput(input);
  const db = getDb();
  const migration = requireMigrationStatus(
    await loadMigration(ctx, valid.migrationId),
    ['compare-clean'],
  );
  await requireNoOpenRound(db, ctx, migration.id);
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_migrations
         SET status = 'incumbent-read-only', read_only_at = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, migration.id, at, at],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'incumbent-read-only-checkpoint',
      `the incumbent is now read-only (justified by comparison round ${migration.compare_clean_round_id})`,
      at,
      { comparisonRoundId: migration.compare_clean_round_id },
    );
  });
  return mapMigration((await findMigrationRow(db, ctx, migration.id))!);
}

export async function retireIncumbent(
  ctx: TenantContext,
  input: { migrationId: string },
): Promise<Migration> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_ADMINISTER, 'retiring the incumbent');
  const valid = validateMigrationIdInput(input);
  const db = getDb();
  const migration = requireMigrationStatus(
    await loadMigration(ctx, valid.migrationId),
    ['incumbent-read-only'],
  );
  await requireNoOpenRound(db, ctx, migration.id);
  // Retirement re-checks the evidence: the LATEST comparison round must
  // still be clean (divergences that appeared after read-only block
  // retirement until a fresh clean round justifies it).
  await requireCleanComparison(db, ctx, migration.id);
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_migrations
         SET status = 'incumbent-retired', retired_at = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, migration.id, at, at],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'incumbent-retired',
      'the incumbent is retired — Aurum is the sole system; the identifier map stays live (identifiers preserved)',
      at,
    );
  });
  return mapMigration((await findMigrationRow(db, ctx, migration.id))!);
}

// ---------------------------------------------------------------------------
// ROLLBACK — sequestration (quarantine, never deletion)
// ---------------------------------------------------------------------------

export async function sequesterMigration(
  ctx: TenantContext,
  input: { migrationId: string; reason: string },
): Promise<Migration> {
  assertMigrationTenantContext(ctx);
  requireAuthority(ctx, MIGRATION_AUTHORITY_ADMINISTER, 'sequestering a migration (rollback)');
  const valid = validateSequesterInput(input);
  const db = getDb();
  const migration = requireMigrationStatus(
    await loadMigration(ctx, valid.migrationId),
    [...MIGRATION_LIVE_STATUSES],
  );
  const at = now();
  await db.transaction(async (tx) => {
    // Rollback stays available: any open round is force-abandoned (its
    // records retained as evidence; its window simply never committed).
    const open = await tx.query<RoundRow>(
      `SELECT * FROM migration_rounds
         WHERE tenant_id = $1 AND migration_id = $2
           AND status IN ('snapshotted', 'staged', 'reviewed')`,
      [ctx.tenantId, migration.id],
    );
    for (const round of open.rows) {
      await tx.query(
        `UPDATE migration_imported_records SET state = 'abandoned'
           WHERE tenant_id = $1 AND round_id = $2`,
        [ctx.tenantId, round.id],
      );
      await tx.query(
        `UPDATE migration_rounds SET status = 'abandoned', abandoned_at = $3
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, round.id, at],
      );
      await recordEvent(
        tx,
        ctx,
        migration.id,
        'round-abandoned',
        `round ${round.round_number} force-abandoned by the rollback`,
        at,
        { roundId: round.id },
      );
    }
    await tx.query(
      `UPDATE migration_migrations
         SET status = 'sequestered', sequestered_at = $3, sequestered_by = $4,
             sequester_reason = $5, updated_at = $6
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, migration.id, at, ctx.principalId, valid.reason, at],
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'sequestered',
      `rollback: committed imports quarantined (retained for audit, excluded from live queries) — ${valid.reason}`.slice(
        0,
        500,
      ),
      at,
    );
  });
  return mapMigration((await findMigrationRow(db, ctx, migration.id))!);
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

export async function getMigration(
  ctx: TenantContext,
  query: { migrationId: string },
): Promise<Migration> {
  assertMigrationTenantContext(ctx);
  const valid = validateGetMigrationQuery(query);
  return mapMigration(await loadMigration(ctx, valid.migrationId));
}

export async function listMigrations(
  ctx: TenantContext,
  query: { status?: Migration['status'] | null; limit?: number },
): Promise<Migration[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListMigrationsQuery(query);
  const rows = await getDb().query<MigrationRow>(
    `SELECT * FROM migration_migrations
       WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
    [ctx.tenantId, valid.status, valid.limit],
  );
  return rows.rows.map(mapMigration);
}

export async function getImportRound(
  ctx: TenantContext,
  query: { roundId: string },
): Promise<{ round: ImportRound; records: ImportedRecord[] }> {
  assertMigrationTenantContext(ctx);
  const valid = validateRoundIdInput(query);
  const round = await loadRound(ctx, valid.roundId);
  const records = (await listRecordRows(getDb(), ctx, round.id)).map(mapRecord);
  return { round: mapRound(round), records };
}

export async function listImportRounds(
  ctx: TenantContext,
  query: { migrationId: string; status?: ImportRound['status'] | null; limit?: number },
): Promise<ImportRound[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListImportRoundsQuery(query);
  await loadMigration(ctx, valid.migrationId);
  const rows = await getDb().query<RoundRow>(
    `SELECT * FROM migration_rounds
       WHERE tenant_id = $1 AND migration_id = $2 AND ($3::text IS NULL OR status = $3)
       ORDER BY round_number DESC LIMIT $4`,
    [ctx.tenantId, valid.migrationId, valid.status, valid.limit],
  );
  return rows.rows.map(mapRound);
}

export async function listImportedRecords(
  ctx: TenantContext,
  query: {
    migrationId: string;
    roundId?: string | null;
    includeSequestered?: boolean;
    limit?: number;
  },
): Promise<ImportedRecord[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListImportedRecordsQuery(query);
  await loadMigration(ctx, valid.migrationId);
  const rows = await getDb().query<RecordRow>(
    `SELECT r.* FROM migration_imported_records r
       JOIN migration_migrations m
         ON m.tenant_id = r.tenant_id AND m.id = r.migration_id
      WHERE r.tenant_id = $1 AND r.migration_id = $2
        AND ($3::uuid IS NULL OR r.round_id = $3)
        AND ($4 OR m.status <> 'sequestered')
      ORDER BY r.round_id, r.position LIMIT $5`,
    [ctx.tenantId, valid.migrationId, valid.roundId, valid.includeSequestered, valid.limit],
  );
  return rows.rows.map(mapRecord);
}

export async function listIdentifierMappings(
  ctx: TenantContext,
  query: { migrationId?: string | null; limit?: number },
): Promise<IdentifierMapEntry[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListIdentifierMappingsQuery(query);
  if (valid.migrationId !== null) {
    await loadMigration(ctx, valid.migrationId);
  }
  const rows = await getDb().query<MapEntryRow>(
    `SELECT m.* FROM migration_identifier_map m
       JOIN migration_migrations mig
         ON mig.tenant_id = m.tenant_id AND mig.id = m.migration_id
      WHERE m.tenant_id = $1
        AND ($2::uuid IS NULL OR m.migration_id = $2)
        AND mig.status <> 'sequestered'
      ORDER BY m.source_system_key, m.external_id LIMIT $3`,
    [ctx.tenantId, valid.migrationId, valid.limit],
  );
  return rows.rows.map(mapMapEntry);
}

export async function getIdentityConflict(
  ctx: TenantContext,
  query: { conflictId: string },
): Promise<IdentityConflict> {
  assertMigrationTenantContext(ctx);
  const valid = validateGetIdentityConflictQuery(query);
  const rows = await getDb().query<ConflictRow>(
    `SELECT * FROM migration_identity_conflicts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.conflictId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new MigrationError(
      'conflict_not_found',
      `no identity conflict '${valid.conflictId}' exists in this tenant`,
    );
  }
  return mapConflict(row);
}

export async function listIdentityConflicts(
  ctx: TenantContext,
  query: {
    migrationId?: string | null;
    status?: IdentityConflict['status'] | null;
    limit?: number;
  },
): Promise<IdentityConflict[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListIdentityConflictsQuery(query);
  const rows = await getDb().query<ConflictRow>(
    `SELECT * FROM migration_identity_conflicts
       WHERE tenant_id = $1
         AND ($2::uuid IS NULL OR migration_id = $2)
         AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [ctx.tenantId, valid.migrationId, valid.status, valid.limit],
  );
  return rows.rows.map(mapConflict);
}

export async function getComparisonRound(
  ctx: TenantContext,
  query: { comparisonRoundId: string },
): Promise<{ round: ComparisonRound; entries: ComparisonEntry[] }> {
  assertMigrationTenantContext(ctx);
  const valid = validateGetComparisonRoundQuery(query);
  const roundRows = await getDb().query<ComparisonRoundRow>(
    `SELECT * FROM migration_comparison_rounds WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.comparisonRoundId],
  );
  const round = roundRows.rows[0];
  if (round === undefined) {
    throw new MigrationError(
      'comparison_not_found',
      `no comparison round '${valid.comparisonRoundId}' exists in this tenant`,
    );
  }
  const entryRows = await getDb().query<ComparisonEntryRow>(
    `SELECT * FROM migration_comparison_entries
       WHERE tenant_id = $1 AND comparison_round_id = $2 ORDER BY position`,
    [ctx.tenantId, valid.comparisonRoundId],
  );
  return { round: mapComparisonRound(round), entries: entryRows.rows.map(mapComparisonEntry) };
}

export async function listComparisonRounds(
  ctx: TenantContext,
  query: { migrationId: string; limit?: number },
): Promise<ComparisonRound[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListComparisonRoundsQuery(query);
  await loadMigration(ctx, valid.migrationId);
  const rows = await getDb().query<ComparisonRoundRow>(
    `SELECT * FROM migration_comparison_rounds
       WHERE tenant_id = $1 AND migration_id = $2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [ctx.tenantId, valid.migrationId, valid.limit],
  );
  return rows.rows.map(mapComparisonRound);
}

export async function listMigrationEvents(
  ctx: TenantContext,
  query: { migrationId: string; limit?: number },
): Promise<ReturnType<typeof mapEvent>[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListMigrationEventsQuery(query);
  await loadMigration(ctx, valid.migrationId);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM migration_events
       WHERE tenant_id = $1 AND migration_id = $2
      ORDER BY recorded_at DESC, position DESC LIMIT $3`,
    [ctx.tenantId, valid.migrationId, valid.limit],
  );
  return rows.rows.map(mapEvent);
}

export async function listCurrentImportedStates(
  ctx: TenantContext,
  query: { migrationId: string; includeTombstoned?: boolean },
): Promise<CurrentImportedState[]> {
  assertMigrationTenantContext(ctx);
  const valid = validateListCurrentImportedStatesQuery(query);
  const migration = await loadMigration(ctx, valid.migrationId);
  const rows = await listCurrentStateRows(getDb(), ctx, migration.id);
  return rows
    .filter((row) => valid.includeTombstoned || !row.tombstone)
    .map((row) => ({
      aurumEntityId: row.aurum_entity_id,
      externalId: row.external_id,
      payload: row.payload === null ? null : (row.payload as Record<string, unknown>),
      tombstone: row.tombstone,
      roundId: row.round_id,
      roundNumber: row.round_number,
      recordId: row.record_id,
    }));
}

export async function resolveExternalId(
  ctx: TenantContext,
  query: { sourceSystemKey: string; externalId: string },
): Promise<ResolveExternalIdResult> {
  assertMigrationTenantContext(ctx);
  const valid = validateResolveExternalIdQuery(query);
  const db = getDb();
  // The LIVE map: entries of non-sequestered migrations (retired
  // migrations' entries stay live — identifiers are preserved forever).
  const rows = await db.query<MapEntryRow>(
    `SELECT m.* FROM migration_identifier_map m
       JOIN migration_migrations mig
         ON mig.tenant_id = m.tenant_id AND mig.id = m.migration_id
      WHERE m.tenant_id = $1 AND m.source_system_key = $2 AND m.external_id = $3
        AND mig.status <> 'sequestered'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [ctx.tenantId, valid.sourceSystemKey, valid.externalId],
  );
  const entry = rows.rows[0];
  if (entry === undefined) {
    throw new MigrationError(
      'migration_not_found',
      `no live mapping of external id '${valid.externalId}' from source system '${valid.sourceSystemKey}' exists in this tenant`,
    );
  }
  // The current imported state of the resolved entity (within the entry's
  // migration — provenance-tagged imported state, never authority).
  const current = await db.query<CurrentStateRow>(
    `SELECT DISTINCT ON (r.external_id)
       mapped.aurum_entity_id, r.id AS record_id, r.external_id,
       r.payload, r.tombstone, r.round_id, rd.round_number
     FROM migration_identifier_map mapped
     JOIN migration_imported_records r
       ON r.tenant_id = mapped.tenant_id
      AND r.migration_id = mapped.migration_id
      AND r.external_id = mapped.external_id
      AND r.state = 'committed'
     JOIN migration_rounds rd
       ON rd.tenant_id = r.tenant_id AND rd.id = r.round_id
     WHERE mapped.tenant_id = $1 AND mapped.id = $2
     ORDER BY r.external_id, rd.round_number DESC, r.position DESC`,
    [ctx.tenantId, entry.id],
  );
  const state = current.rows[0];
  return {
    entry: mapMapEntry(entry),
    currentState:
      state === undefined
        ? null
        : {
            aurumEntityId: state.aurum_entity_id,
            externalId: state.external_id,
            payload: state.payload === null ? null : (state.payload as Record<string, unknown>),
            tombstone: state.tombstone,
            roundId: state.round_id,
            roundNumber: state.round_number,
            recordId: state.record_id,
          },
  };
}
