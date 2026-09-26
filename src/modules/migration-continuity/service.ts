// Implementation of the migration-continuity module's public operations
// (see contract.ts). W094 — Migration and Dual-Run Continuity.
//
// Conventions (IMPLEMENTMENTATION-STACK §3/§8): all SQL goes through the
// db port with `$n` placeholders; ids are uuids minted by `newId()`;
// timestamps come from the injectable clock and are never
// caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`migration_not_found`), no existence leak.
// Module SQL touches ONLY this module's tables; every other module's
// data moves exclusively through its public contract.
//
// THE REAL SEAMS (never a private channel):
//   * the incumbent system enters through the W081 discovery >
//     recommendation > approval > connection chain — stageMigration
//     validates the system + the capability keys against the LIVE
//     inventory surface and the broker connection against the W082
//     connection record (status 'connected', opaque credentialRef);
//   * every incumbent read and back-write executes through the W084
//     DeepActionTransport port (getDeepActionTransport — wired at
//     process start; nothing wired = the honest `transport_unavailable`
//     refusal, never a fake read), behind the W083 capability gate
//     (invokeCapability — the deep-actions pipeline's own discipline);
//   * imported conversations / evidence / people land as REAL rows in
//     the owning modules' tables through their public contract writes
//     (conversations.createConversation/recordMessage,
//     people.createPerson, observations.recordObservation); this module
//     owns ONLY the migration records;
//   * the legacy-vs-Aurum comparison REUSES the W084 reconcileOperation
//     VERBATIM (the W093 computer-use precedent — no second evidence
//     model);
//   * identifier preservation re-uses the W095 unified-identity
//     verification semantics: ambiguous mappings stay
//     `unverified-external` and NEVER merge silently;
//   * incumbent records map onto kit-declared entity kinds where a
//     vertical kit is installed (W092 manifests); unmapped kinds stay
//     raw evidence — semantics are never guessed.
//
// W094 acceptance — "customer can run incumbent and Aurum in parallel;
// conflicts are surfaced; rollback is possible; no silent data loss or
// duplicate authority" — is carried by these deliberate properties,
// all tested:
//
//   1. NO SILENT DATA LOSS: every import batch records a manifest
//      (entity kind, counts in/out, content checksums of what was read
//      AND of what landed — read back through the owning contracts —
//      plus the per-record landing ledger). runImport fails HARD on a
//      count mismatch, and verifyImportIntegrity re-derives everything
//      later (a manifest that disagrees with the landed rows is the
//      `import_integrity_mismatch` refusal).
//
//   2. NO DUPLICATE AUTHORITY: during staged/imported/dual-running the
//      INCUMBENT is the authority of record; a kind's authority
//      transfers to Aurum exactly when its retirement window completes
//      (completeRetirement — the only path), and rollback restores the
//      incumbent. The authority is DERIVED (lifecycle.ts), never
//      stored twice.
//
//   3. CONFLICTS ARE SURFACED, NEVER AUTO-RESOLVED: a sync pass that
//      finds the same logical record touched on both sides records a
//      conflict row with BOTH versions, both timestamps, provenance and
//      the W084 reconciliation diff — and lands nothing, back-writes
//      nothing. Resolution is a claim-gated human decision.
//
//   4. ROLLBACK IS POSSIBLE: every lifecycle transition has a recorded
//      reverse; rolling back restores the previous state's authority
//      surface (windows roll back or re-open) and RETAINS the full
//      evidence trail (the rollback is itself a transition row).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type { ChannelProvider } from '@/modules/identity/contract';
import { getConnection, type BrokerConnection } from '@/modules/connection-broker/contract';
import {
  getDeepActionTransport,
  reconcileOperation,
  type DeepActionState,
  type DeepActionTransport,
  type OperationReconciliation,
} from '@/modules/deep-actions/contract';
import { getSystem, type InventorySystem } from '@/modules/integration-intelligence/contract';
import { invokeCapability } from '@/modules/capability-grants/contract';
import {
  createConversation,
  getConversation,
  listMessages,
  recordMessage,
  type Message,
} from '@/modules/conversations/contract';
import { createPerson, getPerson } from '@/modules/people/contract';
import {
  getObservation,
  recordObservation,
  type Observation,
} from '@/modules/observations/contract';
import {
  getKitVersion,
  listKitInstallations,
  type KitInstallation,
} from '@/modules/vertical-kits/contract';
import { MigrationContinuityError } from './errors';
import {
  authorityForKind,
  canTransitionMigration,
  rollbackTargetOf,
} from './lifecycle';
import { checksumOf } from './digest';
import {
  assertMigrationContinuityTenantContext,
  isPlainObject,
  isPlainJsonValue,
  MAX_RECORDS_PER_BATCH,
  MAX_VALUE_BYTES,
  parseConversationRecord,
  parsePersonRecord,
  requireAdminister,
  validateCompareMigrationInput,
  validateGetByIdQuery,
  validateGetMigrationQuery,
  validateIncumbentRecord,
  validateListConflictsQuery,
  validateListEventsQuery,
  validateListManifestsQuery,
  validateListMappingsQuery,
  validateListMigrationsQuery,
  validateListReportsQuery,
  validateListSyncRunsQuery,
  validateListTransitionsQuery,
  validateMigrationTarget,
  validateResolveConflictInput,
  validateResolveMappingAmbiguityInput,
  validateRetirementKindInput,
  validateRollbackMigrationInput,
  validateStageMigrationInput,
  type ValidatedBatchPlan,
} from './validation';
import type {
  AuthorityOfResult,
  ComparisonOutcomeRow,
  ComparisonReport,
  IdentityMapping,
  ImportIntegrityReport,
  ImportManifest,
  Migration,
  MigrationConflict,
  MigrationConflictTaxonomy,
  MigrationDetail,
  MigrationEvent,
  MigrationEventType,
  MigrationState,
  MigrationStatusResult,
  MigrationTransition,
  RetirementWindow,
  SyncRun,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** The provider-neutral channel key recorded on the module's evidence. */
const MIGRATION_CHANNEL = 'migration-continuity';

/** The canonical authority claim of the module's trust operations. */
export const MIGRATION_CONTINUITY_AUTHORITY_ADMINISTER = 'migration-continuity:administer';

/** The observation kinds this module records (the W004 evidence ledger). */
export const RAW_EVIDENCE_OBSERVATION_KIND = 'migration-continuity.raw';
export const KIT_EVIDENCE_OBSERVATION_KIND_PREFIX = 'vertical-kit.';
export const SYNC_UPDATE_OBSERVATION_KIND = 'migration-continuity.sync-update';

/** The canonical confidence record attached to this module's evidence. */
const IMPORT_CONFIDENCE = {
  value: 1,
  method: 'deterministic-import',
  basis: 'the incumbent record read through the deep-action transport port and landed through the owning module contract',
} as const;

/** The plain-language landing labels recorded on the manifests. */
const CONTRACT_WRITES = {
  conversation: 'conversations.recordMessage',
  person: 'people.createPerson',
  observation: 'observations.recordObservation',
} as const;

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface MigrationRow extends DbRow {
  id: string;
  tenant_id: string;
  task_context: unknown;
  system_id: string;
  system_key: string;
  system_display_name: string;
  connection_id: string;
  read_capability_key: string;
  write_capability_key: string | null;
  state: MigrationState;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface TransitionRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  position: number;
  kind: 'forward' | 'rollback';
  from_state: MigrationState | null;
  to_state: MigrationState;
  reason: string;
  evidence: unknown;
  recorded_by: string;
  recorded_at: Date;
}

interface ManifestRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  batch_no: number;
  target: string;
  entity_kind: string;
  resolution: 'conversation' | 'person' | 'kit-kind' | 'raw-evidence' | null;
  kit_key: string | null;
  kit_entity: string | null;
  contract_write: string | null;
  expected_count: number;
  landed_count: number;
  source_checksum: string | null;
  landed_checksum: string | null;
  landed_records: unknown;
  status: 'planned' | 'ok' | 'mismatch';
  detail: string | null;
  imported_at: Date | null;
}

interface MappingRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  incumbent_id: string;
  incumbent_kind: string;
  aurum_id: string | null;
  aurum_kind: string | null;
  current_aurum_id: string | null;
  verification_state: 'verified' | 'unverified-external';
  match_basis: string;
  candidates: unknown;
  provenance: unknown;
  last_incumbent_checksum: string | null;
  last_aurum_checksum: string | null;
  last_incumbent_form: unknown;
  mapped_at: Date;
  updated_at: Date;
}

interface SyncRunRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  sequence: number;
  records_read: number;
  records_landed: number;
  back_writes_attempted: number;
  back_writes_accepted: number;
  back_writes_refused: number;
  back_writes_failed: number;
  back_writes_blocked: number;
  conflicts_detected: number;
  status: 'running' | 'completed' | 'failed';
  detail: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface ConflictRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  entity_kind: string;
  incumbent_id: string;
  aurum_id: string | null;
  taxonomy: MigrationConflictTaxonomy;
  incumbent_version: unknown;
  aurum_version: unknown;
  incumbent_updated_at: Date | null;
  aurum_updated_at: Date | null;
  provenance: unknown;
  reconciliation: unknown;
  resolution: 'none' | 'incumbent' | 'aurum';
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  status: 'open' | 'resolved';
  detected_in_sync_run: string | null;
  detected_at: Date;
}

interface ReportRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  entity_kind: string;
  matched_count: number;
  diverged_count: number;
  incumbent_only_count: number;
  aurum_only_count: number;
  clean: boolean;
  outcomes: unknown;
  compared_at: Date;
}

interface WindowRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  entity_kind: string;
  sequence: number;
  status: 'open' | 'retired' | 'rolled-back';
  closed_with_report_id: string | null;
  opened_at: Date;
  opened_by: string;
  retired_at: Date | null;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  migration_id: string;
  position: number;
  event: MigrationEventType;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function mapMigration(row: MigrationRow): Migration {
  const context = isPlainObject(row.task_context) ? row.task_context : {};
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskContext: {
      description: typeof context['description'] === 'string' ? context['description'] : '',
      requestedFor: typeof context['requestedFor'] === 'string' ? context['requestedFor'] : null,
    },
    systemId: row.system_id,
    systemKey: row.system_key,
    systemDisplayName: row.system_display_name,
    connectionId: row.connection_id,
    readCapabilityKey: row.read_capability_key,
    writeCapabilityKey: row.write_capability_key,
    state: row.state,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapTransition(row: TransitionRow): MigrationTransition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    position: row.position,
    kind: row.kind,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    evidence: isPlainObject(row.evidence) ? row.evidence : {},
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function mapManifest(row: ManifestRow): ImportManifest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    batchNo: row.batch_no,
    target: row.target,
    entityKind: row.entity_kind,
    resolution: row.resolution,
    kitKey: row.kit_key,
    kitEntity: row.kit_entity,
    contractWrite: row.contract_write,
    expectedCount: row.expected_count,
    landedCount: row.landed_count,
    sourceChecksum: row.source_checksum,
    landedChecksum: row.landed_checksum,
    landedRecords: Array.isArray(row.landed_records)
      ? (row.landed_records as ImportManifest['landedRecords'])
      : [],
    status: row.status,
    detail: row.detail,
    importedAt: iso(row.imported_at),
  };
}

function mapMapping(row: MappingRow): IdentityMapping {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    incumbentId: row.incumbent_id,
    incumbentKind: row.incumbent_kind,
    aurumId: row.aurum_id,
    aurumKind: row.aurum_kind,
    currentAurumId: row.current_aurum_id,
    verificationState: row.verification_state,
    matchBasis: row.match_basis as IdentityMapping['matchBasis'],
    candidates: Array.isArray(row.candidates)
      ? (row.candidates as IdentityMapping['candidates'])
      : [],
    provenance: isPlainObject(row.provenance) ? row.provenance : {},
    lastIncumbentChecksum: row.last_incumbent_checksum,
    lastAurumChecksum: row.last_aurum_checksum,
    mappedAt: row.mapped_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    sequence: row.sequence,
    recordsRead: row.records_read,
    recordsLanded: row.records_landed,
    backWritesAttempted: row.back_writes_attempted,
    backWritesAccepted: row.back_writes_accepted,
    backWritesRefused: row.back_writes_refused,
    backWritesFailed: row.back_writes_failed,
    backWritesBlocked: row.back_writes_blocked,
    conflictsDetected: row.conflicts_detected,
    status: row.status,
    detail: row.detail,
    startedAt: row.started_at.toISOString(),
    finishedAt: iso(row.finished_at),
  };
}

function mapConflict(row: ConflictRow): MigrationConflict {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    entityKind: row.entity_kind,
    incumbentId: row.incumbent_id,
    aurumId: row.aurum_id,
    taxonomy: row.taxonomy,
    incumbentVersion: isPlainObject(row.incumbent_version) ? row.incumbent_version : null,
    aurumVersion: isPlainObject(row.aurum_version) ? row.aurum_version : null,
    incumbentUpdatedAt: iso(row.incumbent_updated_at),
    aurumUpdatedAt: iso(row.aurum_updated_at),
    provenance: isPlainObject(row.provenance) ? row.provenance : {},
    reconciliation: isPlainObject(row.reconciliation) ? row.reconciliation : null,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    resolvedAt: iso(row.resolved_at),
    status: row.status,
    detectedInSyncRun: row.detected_in_sync_run,
    detectedAt: row.detected_at.toISOString(),
  };
}

function mapReport(row: ReportRow): ComparisonReport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    entityKind: row.entity_kind,
    matchedCount: row.matched_count,
    divergedCount: row.diverged_count,
    incumbentOnlyCount: row.incumbent_only_count,
    aurumOnlyCount: row.aurum_only_count,
    clean: row.clean,
    outcomes: Array.isArray(row.outcomes) ? (row.outcomes as ComparisonOutcomeRow[]) : [],
    comparedAt: row.compared_at.toISOString(),
  };
}

function mapWindow(row: WindowRow): RetirementWindow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    entityKind: row.entity_kind,
    sequence: row.sequence,
    status: row.status,
    closedWithReportId: row.closed_with_report_id,
    openedAt: row.opened_at.toISOString(),
    openedBy: row.opened_by,
    retiredAt: iso(row.retired_at),
  };
}

function mapEvent(row: EventRow): MigrationEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    migrationId: row.migration_id,
    position: row.position,
    event: row.event,
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clampDetail(detail: string, max = 500): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}

async function loadMigrationRow(ctx: TenantContext, migrationId: string): Promise<MigrationRow> {
  const rows = await getDb().query<MigrationRow>(
    `SELECT * FROM migration_runs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, migrationId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new MigrationContinuityError(
      'migration_not_found',
      `no migration '${migrationId}' exists in this tenant`,
    );
  }
  return row;
}

function requireState(row: MigrationRow, allowed: MigrationState[], operation: string): MigrationRow {
  if (!allowed.includes(row.state)) {
    throw new MigrationContinuityError(
      'migration_not_pending_phase',
      `migration '${row.id}' is '${row.state}' — ${operation} requires ${allowed.join(' or ')}`,
    );
  }
  return row;
}

async function nextPosition(
  db: Queryable,
  table: 'migration_events' | 'migration_transitions',
  ctx: TenantContext,
  migrationId: string,
): Promise<number> {
  const rows = await db.query<{ max: number | null }>(
    `SELECT MAX(position) AS max FROM ${table} WHERE tenant_id = $1 AND migration_id = $2`,
    [ctx.tenantId, migrationId],
  );
  return (rows.rows[0]?.max ?? 0) + 1;
}

async function recordEvent(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
  event: MigrationEventType,
  detail: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO migration_events (id, tenant_id, migration_id, position, event, detail, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId(),
      ctx.tenantId,
      migrationId,
      await nextPosition(db, 'migration_events', ctx, migrationId),
      event,
      detail,
      ctx.principalId,
      now(),
    ],
  );
}

async function appendTransition(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
  kind: 'forward' | 'rollback',
  fromState: MigrationState | null,
  toState: MigrationState,
  reason: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO migration_transitions
       (id, tenant_id, migration_id, position, kind, from_state, to_state, reason, evidence, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      newId(),
      ctx.tenantId,
      migrationId,
      await nextPosition(db, 'migration_transitions', ctx, migrationId),
      kind,
      fromState,
      toState,
      clampDetail(reason, 2000),
      JSON.stringify(evidence),
      ctx.principalId,
      now(),
    ],
  );
}

/** Moves the migration from EXACTLY `fromState` to `toState`, recording the transition. */
async function transitionMigrationState(
  db: Queryable,
  ctx: TenantContext,
  migrationId: string,
  fromState: MigrationState,
  toState: MigrationState,
  kind: 'forward' | 'rollback',
  reason: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const updated = await db.query(
    `UPDATE migration_runs SET state = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND state = $5`,
    [ctx.tenantId, migrationId, toState, now(), fromState],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw new MigrationContinuityError(
      'migration_not_pending_phase',
      `migration '${migrationId}' is not '${fromState}' — the transition to '${toState}' cannot land`,
    );
  }
  await appendTransition(db, ctx, migrationId, kind, fromState, toState, reason, evidence);
}

function requireTransport(): DeepActionTransport {
  const transport = getDeepActionTransport();
  if (transport === null) {
    throw new MigrationContinuityError(
      'transport_unavailable',
      'no deep-action transport is wired — setDeepActionTransport first; the migration refuses to fake incumbent reads',
    );
  }
  return transport;
}

async function loadActiveConnection(
  ctx: TenantContext,
  migration: MigrationRow,
): Promise<BrokerConnection> {
  const connection = await getConnection(ctx, { connectionId: migration.connection_id });
  if (connection.status !== 'connected') {
    throw new MigrationContinuityError(
      'connection_not_active',
      `the broker connection '${migration.connection_id}' is '${connection.status}' — the migration rides a connected incumbent only`,
    );
  }
  return connection;
}

function readTaskContext(migration: MigrationRow): {
  description: string;
  requestedFor: string | null;
} {
  const context = isPlainObject(migration.task_context) ? migration.task_context : {};
  return {
    description:
      typeof context['description'] === 'string'
        ? context['description']
        : 'the migration of the incumbent system of record',
    requestedFor:
      typeof context['requestedFor'] === 'string' ? context['requestedFor'] : null,
  };
}

/** Invokes the migration's READ capability through the W083 gate (the floor). */
async function invokeReadCapability(ctx: TenantContext, migration: MigrationRow): Promise<void> {
  const taskContext = readTaskContext(migration);
  const invocation = await invokeCapability(ctx, {
    connectionId: migration.connection_id,
    capabilityKey: migration.read_capability_key,
    taskContext: { description: taskContext.description, requestedFor: taskContext.requestedFor },
  });
  if (invocation.outcome === 'denied') {
    throw new MigrationContinuityError(
      'read_capability_denied',
      `the read capability '${migration.read_capability_key}' was denied on connection '${migration.connection_id}' — the incumbent cannot be read`,
    );
  }
}

/** Canonicalizes one transport read (the deep-actions discipline). */
function canonicalizeState(state: DeepActionState, target: string): DeepActionState {
  if (!isPlainJsonValue(state)) {
    throw new MigrationContinuityError(
      'invalid_transport_result',
      `the transport returned a non-canonical state for target '${target}' — provider objects never cross the gateway`,
    );
  }
  const serialized = JSON.stringify(state) ?? 'null';
  if (serialized.length > MAX_VALUE_BYTES) {
    throw new MigrationContinuityError(
      'invalid_transport_result',
      `the transport returned a state exceeding ${MAX_VALUE_BYTES} bytes for target '${target}' — large artifacts belong behind opaque references`,
    );
  }
  return state;
}

/** Reads one incumbent collection target through the transport (W083-gated). */
async function readIncumbentCollection(
  ctx: TenantContext,
  migration: MigrationRow,
  transport: DeepActionTransport,
  connection: BrokerConnection,
  target: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>[]> {
  await invokeReadCapability(ctx, migration);
  const raw = await transport.inspect({
    connectionId: migration.connection_id,
    credentialRef: connection.credentialRef ?? '',
    systemKey: migration.system_key,
    capabilityKey: migration.read_capability_key,
    target,
    idempotencyKey,
  });
  const state = canonicalizeState(raw, target);
  if (!state.found) {
    throw new MigrationContinuityError(
      'import_batch_not_found',
      `the incumbent reports no collection '${target}' — the planned batch cannot be read`,
    );
  }
  const body = isPlainObject(state.state) ? state.state : null;
  if (body === null || !Array.isArray(body['records'])) {
    throw new MigrationContinuityError(
      'invalid_transport_result',
      `the incumbent collection '${target}' did not serve a {records: [...]} canonical state`,
    );
  }
  const records = body['records'] as unknown[];
  if (records.length > MAX_RECORDS_PER_BATCH) {
    throw new MigrationContinuityError(
      'invalid_transport_result',
      `the incumbent collection '${target}' served ${records.length} records — the batch limit is ${MAX_RECORDS_PER_BATCH}`,
    );
  }
  return records.map((record) => {
    if (!isPlainObject(record)) {
      throw new MigrationContinuityError(
        'invalid_transport_result',
        `the incumbent collection '${target}' served a non-object record`,
      );
    }
    return record;
  });
}

// ---------------------------------------------------------------------------
// The entity-kind resolution ladder + the canonical versions
// ---------------------------------------------------------------------------

interface KindResolution {
  resolution: 'conversation' | 'person' | 'kit-kind' | 'raw-evidence';
  kitKey: string | null;
  kitEntity: string | null;
}

/**
 * The deterministic ladder: conversations and people have real owning
 * modules (their public contract writes land the records when the
 * record carries the canonical shape); an INSTALLED vertical kit
 * declares vertical entity kinds (its manifest's dataSchemaHints); and
 * everything else stays RAW EVIDENCE with the incumbent kind preserved
 * — semantics are never guessed.
 */
async function resolveEntityKind(
  ctx: TenantContext,
  entityKind: string,
): Promise<KindResolution> {
  if (entityKind === 'conversation' || entityKind === 'person') {
    return { resolution: entityKind, kitKey: null, kitEntity: null };
  }
  // Kit-declared kinds: only an INSTALLED (active) kit's manifest
  // declares them.
  const installations = await listKitInstallations(ctx, { status: 'active' });
  for (const installation of installations as KitInstallation[]) {
    const version = await getKitVersion(ctx, { kitVersionId: installation.kitVersionId });
    const declared = version.manifest.dataSchemaHints.some((hint) => hint.entity === entityKind);
    if (declared) {
      return { resolution: 'kit-kind', kitKey: installation.kitKey, kitEntity: entityKind };
    }
  }
  return { resolution: 'raw-evidence', kitKey: null, kitEntity: null };
}

/** The canonical INCUMBENT version of a logical record. */
function canonicalIncumbentVersion(
  record: Record<string, unknown>,
  resolution: KindResolution,
): Record<string, unknown> {
  if (resolution.resolution === 'conversation') {
    const parsed = parseConversationRecord(record);
    if (parsed !== null) {
      return {
        channel: parsed.channel,
        subject: parsed.subject,
        turns: parsed.turns.map((turn) => ({
          turnId: turn.turnId,
          direction: turn.direction,
          actorLabel: turn.actorLabel,
          sentAt: turn.sentAt,
          payload: turn.payload,
        })),
      };
    }
    return record;
  }
  if (resolution.resolution === 'person') {
    const parsed = parsePersonRecord(record);
    if (parsed !== null) {
      return { fullName: parsed.fullName, email: parsed.email };
    }
    return record;
  }
  return record;
}

/** The canonical AURUM version of a landed logical record (read back). */
async function canonicalAurumVersion(
  ctx: TenantContext,
  mapping: MappingRow,
): Promise<{ version: Record<string, unknown>; updatedAt: string | null }> {
  const currentId = mapping.current_aurum_id ?? mapping.aurum_id;
  if (currentId === null) {
    return { version: {}, updatedAt: null };
  }
  // A SUPERSEDING sync-update observation is the current view (the
  // originally landed row stays as immutable evidence behind it).
  const superseded =
    mapping.current_aurum_id !== null && mapping.current_aurum_id !== mapping.aurum_id;
  if (superseded || mapping.aurum_kind === null) {
    const observation = (await getObservation(ctx, currentId)) as Observation;
    const payload = isPlainObject(observation.payload) ? observation.payload : {};
    // A sync-update observation carries the CANONICAL version of the
    // record it supersedes; kit/raw landings carry the raw record.
    const inner = isPlainObject(payload['canonicalVersion'])
      ? payload['canonicalVersion']
      : isPlainObject(payload['record'])
        ? payload['record']
        : payload;
    return { version: inner, updatedAt: observation.recordedAt };
  }
  if (mapping.aurum_kind === 'conversation') {
    const conversation = await getConversation(ctx, currentId);
    const messages = (await listMessages(ctx, {
      conversationId: currentId,
      limit: 500,
    })) as Message[];
    return {
      version: {
        channel: messages[0]?.channel ?? null,
        subject: conversation.title,
        turns: messages.map((message) => ({
          turnId: message.providerMessageId ?? message.id,
          direction: message.direction,
          actorLabel: message.actor.label,
          sentAt: new Date(message.sentAt).toISOString(),
          payload: message.payload,
        })),
      },
      updatedAt: conversation.createdAt,
    };
  }
  if (mapping.aurum_kind === 'person') {
    const person = await getPerson(ctx, currentId);
    return {
      version: { fullName: person.fullName, email: person.email },
      updatedAt: person.updatedAt,
    };
  }
  // An observation-backed landing (kit kinds / raw evidence).
  const observation = (await getObservation(ctx, currentId)) as Observation;
  const payload = isPlainObject(observation.payload) ? observation.payload : {};
  const inner = isPlainObject(payload['record']) ? payload['record'] : payload;
  return { version: inner, updatedAt: observation.recordedAt };
}

// ---------------------------------------------------------------------------
// The landing ladder (the owning modules' public contract writes)
// ---------------------------------------------------------------------------

interface LandedRecord {
  incumbentId: string;
  aurumId: string;
  aurumKind: 'conversation' | 'person' | 'observation';
  updatedAt: string | null;
}

/** Observations landing helper (raw evidence / kit kinds / sync updates). */
async function landObservation(
  ctx: TenantContext,
  migration: MigrationRow,
  input: {
    kind: string;
    payload: Record<string, unknown>;
    observedAt: string;
  },
): Promise<Observation> {
  return await recordObservation(ctx, {
    kind: input.kind,
    payload: input.payload,
    observedAt: input.observedAt,
    source: { kind: 'external', label: migration.system_display_name },
    channel: MIGRATION_CHANNEL,
    lineage: { method: 'connector', extractor: null },
    permissions: { visibility: 'tenant' },
    confidence: {
      value: IMPORT_CONFIDENCE.value,
      method: IMPORT_CONFIDENCE.method,
      basis: IMPORT_CONFIDENCE.basis,
    },
  });
}

function observedAtOf(updatedAt: string | null): string {
  return updatedAt !== null && !Number.isNaN(Date.parse(updatedAt))
    ? new Date(updatedAt).toISOString()
    : now().toISOString();
}

function naturalKeyOf(parsed: { fullName: string; email: string | null }): string {
  const email = parsed.email ?? '';
  return email.length > 0 ? `email:${email.toLowerCase()}` : `name:${parsed.fullName.toLowerCase()}`;
}

function provenanceOf(
  record: Record<string, unknown>,
  resolution: KindResolution,
): Record<string, unknown> {
  if (resolution.resolution === 'person') {
    const parsed = parsePersonRecord(record);
    if (parsed !== null) {
      return {
        attributes: {
          fullName: parsed.fullName,
          email: parsed.email,
          naturalKey: naturalKeyOf(parsed),
        },
      };
    }
  }
  return { attributes: { incumbentRecordShape: Object.keys(record).sort() } };
}

/**
 * Lands ONE unmapped incumbent record through the owning module's
 * public contract write, following the deterministic ladder. Returns
 * the landing, or an AMBIGUITY outcome (never merged — the W095
 * discipline) carrying the raw-evidence landing of the ambiguous
 * record itself.
 */
async function landIncumbentRecord(
  ctx: TenantContext,
  migration: MigrationRow,
  record: Record<string, unknown>,
  resolution: KindResolution,
  entityKind: string,
): Promise<
  | { landed: LandedRecord }
  | {
      ambiguous: {
        candidates: { incumbentId: string; aurumId: string | null }[];
        basis: 'ambiguous-candidates';
        evidenceObservationId: string;
      };
    }
> {
  const validated = validateIncumbentRecord(record);
  const incumbentId = validated.incumbentId;
  const observedAt = observedAtOf(validated.updatedAt);

  if (resolution.resolution === 'conversation') {
    const parsed = parseConversationRecord(record);
    if (parsed !== null) {
      // A real conversation thread: one conversation row + one message
      // per turn (the incumbent turn id is the providerMessageId —
      // redelivery dedupes; the sender's clock is the turn's sentAt).
      const conversation = await createConversation(ctx, { title: parsed.subject });
      for (const turn of parsed.turns) {
        await recordMessage(ctx, {
          conversationId: conversation.id,
          direction: turn.direction,
          actor: { kind: 'external', label: turn.actorLabel ?? migration.system_display_name },
          channel: parsed.channel as ChannelProvider,
          payload: turn.payload,
          sentAt: turn.sentAt,
          providerMessageId: turn.turnId,
        });
      }
      return {
        landed: {
          incumbentId,
          aurumId: conversation.id,
          aurumKind: 'conversation',
          updatedAt: conversation.createdAt,
        },
      };
    }
  }

  if (resolution.resolution === 'person') {
    const parsed = parsePersonRecord(record);
    if (parsed !== null) {
      // The ambiguity guard (the W095 discipline): another incumbent
      // record of this migration already mapped onto the same natural
      // key — the mapping is AMBIGUOUS. The record is never merged into
      // the existing person and never guessed: it lands as raw evidence
      // with the candidates surfaced.
      const existing = await getDb().query<MappingRow>(
        `SELECT * FROM migration_identity_mappings
           WHERE tenant_id = $1 AND migration_id = $2 AND incumbent_kind = 'person'
             AND provenance->'attributes'->>'naturalKey' = $3`,
        [ctx.tenantId, migration.id, naturalKeyOf(parsed)],
      );
      const clash = existing.rows[0];
      if (clash !== undefined) {
        const observation = await landObservation(ctx, migration, {
          kind: RAW_EVIDENCE_OBSERVATION_KIND,
          payload: { incumbentKind: 'person', record, reason: 'ambiguous-identity' },
          observedAt,
        });
        return {
          ambiguous: {
            candidates: [
              { incumbentId: clash.incumbent_id, aurumId: clash.aurum_id },
              { incumbentId, aurumId: observation.id },
            ],
            basis: 'ambiguous-candidates',
            evidenceObservationId: observation.id,
          },
        };
      }
      const person = await createPerson(ctx, { fullName: parsed.fullName, email: parsed.email });
      return {
        landed: { incumbentId, aurumId: person.id, aurumKind: 'person', updatedAt: person.createdAt },
      };
    }
  }

  if (resolution.resolution === 'kit-kind') {
    const observation = await landObservation(ctx, migration, {
      kind: `${KIT_EVIDENCE_OBSERVATION_KIND_PREFIX}${resolution.kitKey}.${resolution.kitEntity}`,
      payload: { kitKey: resolution.kitKey, kitEntity: resolution.kitEntity, record },
      observedAt,
    });
    return {
      landed: { incumbentId, aurumId: observation.id, aurumKind: 'observation', updatedAt: observation.recordedAt },
    };
  }

  // Raw evidence: the incumbent kind preserved verbatim — never guessed.
  const observation = await landObservation(ctx, migration, {
    kind: RAW_EVIDENCE_OBSERVATION_KIND,
    payload: { incumbentKind: entityKind, record },
    observedAt,
  });
  return {
    landed: { incumbentId, aurumId: observation.id, aurumKind: 'observation', updatedAt: observation.recordedAt },
  };
}

/** Finds the mapping of one incumbent record, if any (the dedupe FIRST). */
async function findMapping(
  ctx: TenantContext,
  migrationId: string,
  incumbentKind: string,
  incumbentId: string,
): Promise<MappingRow | null> {
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM migration_identity_mappings
       WHERE tenant_id = $1 AND migration_id = $2 AND incumbent_kind = $3 AND incumbent_id = $4`,
    [ctx.tenantId, migrationId, incumbentKind, incumbentId],
  );
  return rows.rows[0] ?? null;
}

/** Records the verified identity mapping of one landed record. */
async function insertVerifiedMapping(
  ctx: TenantContext,
  migration: MigrationRow,
  input: {
    incumbentId: string;
    incumbentKind: string;
    landed: LandedRecord;
    incumbentVersion: Record<string, unknown>;
    aurumVersion: Record<string, unknown>;
    matchBasis: 'import-created' | 'sync-created';
    provenance: Record<string, unknown>;
    batchNo: number;
  },
): Promise<MappingRow> {
  const at = now();
  const id = newId();
  await getDb().query(
    `INSERT INTO migration_identity_mappings
       (id, tenant_id, migration_id, incumbent_id, incumbent_kind, aurum_id, aurum_kind,
        current_aurum_id, verification_state, match_basis, candidates, provenance,
        last_incumbent_checksum, last_aurum_checksum, last_incumbent_form, mapped_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6, 'verified', $8, '[]'::jsonb, $9, $10, $11, $12, $13, $13)`,
    [
      id,
      ctx.tenantId,
      migration.id,
      input.incumbentId,
      input.incumbentKind,
      input.landed.aurumId,
      input.landed.aurumKind,
      input.matchBasis,
      JSON.stringify({ ...input.provenance, batchNo: input.batchNo }),
      checksumOf(input.incumbentVersion),
      checksumOf(input.aurumVersion),
      JSON.stringify(input.incumbentVersion),
      at,
    ],
  );
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  return rows.rows[0]!;
}

/** Records an AMBIGUOUS mapping (never merged — the W095 discipline). */
async function recordAmbiguousMapping(
  ctx: TenantContext,
  migration: MigrationRow,
  input: {
    incumbentId: string;
    incumbentKind: string;
    candidates: { incumbentId: string; aurumId: string | null }[];
    basis: 'ambiguous-candidates' | 'conflicting-attributes';
    provenance: Record<string, unknown>;
    batchNo: number;
  },
): Promise<MappingRow> {
  const at = now();
  const id = newId();
  await getDb().query(
    `INSERT INTO migration_identity_mappings
       (id, tenant_id, migration_id, incumbent_id, incumbent_kind, aurum_id, aurum_kind,
        current_aurum_id, verification_state, match_basis, candidates, provenance,
        last_incumbent_checksum, last_aurum_checksum, last_incumbent_form, mapped_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, 'unverified-external', $6, $7, $8, NULL, NULL, NULL, $9, $9)
     ON CONFLICT (tenant_id, migration_id, incumbent_kind, incumbent_id) DO NOTHING`,
    [
      id,
      ctx.tenantId,
      migration.id,
      input.incumbentId,
      input.incumbentKind,
      input.basis,
      JSON.stringify(input.candidates),
      JSON.stringify({ ...input.provenance, batchNo: input.batchNo }),
      at,
    ],
  );
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM migration_identity_mappings
       WHERE tenant_id = $1 AND migration_id = $2 AND incumbent_kind = $3 AND incumbent_id = $4`,
    [ctx.tenantId, migration.id, input.incumbentKind, input.incumbentId],
  );
  return rows.rows[0]!;
}

/** Updates a mapping's sync checkpoints after a converged pass. */
async function updateMappingCheckpoints(
  ctx: TenantContext,
  mapping: MappingRow,
  incumbentVersion: Record<string, unknown>,
  aurumVersion: Record<string, unknown>,
): Promise<void> {
  await getDb().query(
    `UPDATE migration_identity_mappings SET
        last_incumbent_checksum = $3, last_aurum_checksum = $4, last_incumbent_form = $5, updated_at = $6
      WHERE tenant_id = $1 AND id = $2`,
    [
      ctx.tenantId,
      mapping.id,
      checksumOf(incumbentVersion),
      checksumOf(aurumVersion),
      JSON.stringify(incumbentVersion),
      now(),
    ],
  );
}

/** Points a mapping's current Aurum view at a superseding observation. */
async function supersedeCurrentView(
  ctx: TenantContext,
  mapping: MappingRow,
  observationId: string,
): Promise<void> {
  await getDb().query(
    `UPDATE migration_identity_mappings SET current_aurum_id = $3, updated_at = $4
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, mapping.id, observationId, now()],
  );
}

async function reloadMapping(ctx: TenantContext, mappingId: string): Promise<MappingRow> {
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, mappingId],
  );
  return rows.rows[0]!;
}

function safeForm(form: unknown): unknown {
  return isPlainObject(form) ? form : null;
}

// ---------------------------------------------------------------------------
// STAGE — the incumbent enters through the REAL W081/W082 seams
// ---------------------------------------------------------------------------

export async function stageMigration(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationDetail> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateStageMigrationInput(input);

  // The incumbent system is a REAL W081 inventory record; the staged
  // capability keys must exist on its LIVE surface.
  const system = (await getSystem(ctx, { systemId: valid.systemId })) as InventorySystem;
  const readCapability = system.capabilities.find(
    (capability) => capability.key === valid.readCapabilityKey && capability.mode === 'read',
  );
  if (readCapability === undefined) {
    throw new MigrationContinuityError(
      'invalid_input',
      `'readCapabilityKey' '${valid.readCapabilityKey}' is not a read capability of the inventory system '${system.displayName}'`,
    );
  }
  if (valid.writeCapabilityKey !== null) {
    const writeCapability = system.capabilities.find(
      (capability) => capability.key === valid.writeCapabilityKey && capability.mode === 'write',
    );
    if (writeCapability === undefined) {
      throw new MigrationContinuityError(
        'invalid_input',
        `'writeCapabilityKey' '${valid.writeCapabilityKey}' is not a write capability of the inventory system '${system.displayName}'`,
      );
    }
  }

  // The broker connection is a REAL W082 connection and must be live.
  const connection = await getConnection(ctx, { connectionId: valid.connectionId });
  if (connection.status !== 'connected') {
    throw new MigrationContinuityError(
      'connection_not_active',
      `the broker connection '${valid.connectionId}' is '${connection.status}' — a migration stages against a connected incumbent only`,
    );
  }

  // Idempotent staging (the house pattern).
  if (valid.idempotencyKey !== null) {
    const existing = await getDb().query<{ migration_id: string }>(
      `SELECT migration_id FROM migration_idempotency WHERE tenant_id = $1 AND idempotency_key = $2`,
      [ctx.tenantId, valid.idempotencyKey],
    );
    if (existing.rows[0] !== undefined) {
      return getMigration(ctx, { migrationId: existing.rows[0]!.migration_id });
    }
  }

  const id = newId();
  const at = now();
  await getDb().transaction(async (tx) => {
    await tx.query(
      `INSERT INTO migration_runs
         (id, tenant_id, task_context, system_id, system_key, system_display_name, connection_id,
          read_capability_key, write_capability_key, state, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'staged', $10, $11, $11)`,
      [
        id,
        ctx.tenantId,
        JSON.stringify({
          description: valid.taskContext.description,
          requestedFor: valid.taskContext.requestedFor,
        }),
        valid.systemId,
        system.systemKey,
        system.displayName,
        valid.connectionId,
        valid.readCapabilityKey,
        valid.writeCapabilityKey,
        ctx.principalId,
        at,
      ],
    );
    let batchNo = 0;
    for (const batch of valid.batches as ValidatedBatchPlan[]) {
      batchNo += 1;
      await tx.query(
        `INSERT INTO migration_import_manifests
           (id, tenant_id, migration_id, batch_no, target, entity_kind, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned')`,
        [newId(), ctx.tenantId, id, batchNo, batch.target, batch.entityKind],
      );
    }
    await appendTransition(tx, ctx, id, 'forward', null, 'staged', 'the migration was staged', {
      systemId: valid.systemId,
      systemKey: system.systemKey,
      connectionId: valid.connectionId,
      batches: valid.batches.map((batch) => ({ target: batch.target, entityKind: batch.entityKind })),
    });
    await recordEvent(
      tx,
      ctx,
      id,
      'staged',
      clampDetail(`${valid.batches.length} batch(es) drafted against ${system.displayName}`),
    );
    if (valid.idempotencyKey !== null) {
      await tx.query(
        `INSERT INTO migration_idempotency (id, tenant_id, migration_id, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), ctx.tenantId, id, valid.idempotencyKey, at],
      );
    }
  });

  return getMigration(ctx, { migrationId: id });
}

// ---------------------------------------------------------------------------
// IMPORT — history lands through the REAL contracts
// ---------------------------------------------------------------------------

export async function runImport(ctx: TenantContext, input: unknown): Promise<MigrationDetail> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateMigrationTarget(input, 'runImport input');
  const db = getDb();
  const migration = requireState(await loadMigrationRow(ctx, valid.migrationId), ['staged'], 'runImport');
  const transport = requireTransport();
  const connection = await loadActiveConnection(ctx, migration);

  const manifests = await db.query<ManifestRow>(
    `SELECT * FROM migration_import_manifests
       WHERE tenant_id = $1 AND migration_id = $2 ORDER BY batch_no`,
    [ctx.tenantId, migration.id],
  );

  let totalLanded = 0;
  let totalExpected = 0;
  const failures: string[] = [];

  for (const manifest of manifests.rows) {
    const records = await readIncumbentCollection(
      ctx,
      migration,
      transport,
      connection,
      manifest.target,
      `migration-continuity:${migration.id}:import:${manifest.batch_no}`,
    );
    const resolution = await resolveEntityKind(ctx, manifest.entity_kind);
    const landedRecords: ImportManifest['landedRecords'] = [];
    const landedVersions: Record<string, unknown>[] = [];
    const contractWrite =
      resolution.resolution === 'conversation'
        ? CONTRACT_WRITES.conversation
        : resolution.resolution === 'person'
          ? CONTRACT_WRITES.person
          : CONTRACT_WRITES.observation;

    let batchFailure: string | null = null;
    for (const record of records) {
      try {
        const validated = validateIncumbentRecord(record);
        // The mapping is the dedupe — checked BEFORE any landing, so a
        // re-run replays the original rows and never duplicates.
        const existing = await findMapping(ctx, migration.id, manifest.entity_kind, validated.incumbentId);
        if (existing !== null && existing.verification_state === 'verified' && existing.aurum_id !== null) {
          landedRecords.push({
            incumbentId: validated.incumbentId,
            aurumId: existing.aurum_id,
            aurumKind: (existing.aurum_kind ?? 'observation') as 'conversation' | 'person' | 'observation',
          });
          landedVersions.push({
            incumbentId: validated.incumbentId,
            aurumId: existing.aurum_id,
            replayed: true,
          });
          continue;
        }
        const outcome = await landIncumbentRecord(ctx, migration, record, resolution, manifest.entity_kind);
        if ('ambiguous' in outcome) {
          // The W095 discipline: ambiguous NEVER merges — the mapping
          // stays unverified-external with the candidates surfaced; the
          // record itself landed as raw evidence.
          await recordAmbiguousMapping(ctx, migration, {
            incumbentId: validated.incumbentId,
            incumbentKind: manifest.entity_kind,
            candidates: outcome.ambiguous.candidates,
            basis: outcome.ambiguous.basis,
            provenance: { attributes: { naturalKeyDetected: true } },
            batchNo: manifest.batch_no,
          });
          landedRecords.push({
            incumbentId: validated.incumbentId,
            aurumId: outcome.ambiguous.evidenceObservationId,
            aurumKind: 'observation',
          });
          landedVersions.push({
            incumbentId: validated.incumbentId,
            aurumId: outcome.ambiguous.evidenceObservationId,
            ambiguous: true,
          });
          continue;
        }
        const incumbentVersion = canonicalIncumbentVersion(record, resolution);
        const mapping = await insertVerifiedMapping(ctx, migration, {
          incumbentId: validated.incumbentId,
          incumbentKind: manifest.entity_kind,
          landed: outcome.landed,
          incumbentVersion,
          aurumVersion: incumbentVersion, // refined immediately by the read-back
          matchBasis: 'import-created',
          provenance: provenanceOf(record, resolution),
          batchNo: manifest.batch_no,
        });
        landedRecords.push({
          incumbentId: validated.incumbentId,
          aurumId: outcome.landed.aurumId,
          aurumKind: outcome.landed.aurumKind,
        });
        // Read the landed row back through the owning contract — the
        // manifest's landed checksum is over what Aurum HOLDS.
        const aurumView = await canonicalAurumVersion(ctx, mapping);
        landedVersions.push({
          incumbentId: validated.incumbentId,
          aurumId: outcome.landed.aurumId,
          version: aurumView.version,
        });
        await updateMappingCheckpoints(ctx, mapping, incumbentVersion, aurumView.version);
      } catch (error) {
        if (error instanceof MigrationContinuityError) throw error;
        batchFailure = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    const expected = records.length;
    const landed = landedRecords.length;
    totalExpected += expected;
    totalLanded += landed;
    const ok = batchFailure === null && landed === expected;
    if (!ok) {
      failures.push(
        `batch ${manifest.batch_no} (${manifest.entity_kind}): expected ${expected}, landed ${landed}` +
          (batchFailure === null ? '' : ` — ${batchFailure}`),
      );
    }
    await db.query(
      `UPDATE migration_import_manifests SET
          resolution = $3, kit_key = $4, kit_entity = $5, contract_write = $6,
          expected_count = $7, landed_count = $8,
          source_checksum = $9, landed_checksum = $10, landed_records = $11,
          status = $12, detail = $13, imported_at = $14
        WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        manifest.id,
        resolution.resolution,
        resolution.kitKey,
        resolution.kitEntity,
        contractWrite,
        expected,
        landed,
        checksumOf(records),
        checksumOf(landedVersions),
        JSON.stringify(landedRecords),
        ok ? 'ok' : 'mismatch',
        ok ? null : clampDetail(failures[failures.length - 1] ?? 'landing mismatch', 2000),
        now(),
      ],
    );
  }

  if (failures.length > 0) {
    await recordEvent(db, ctx, migration.id, 'import-mismatch', clampDetail(failures.join('; ')));
    throw new MigrationContinuityError(
      'import_integrity_mismatch',
      `the import landed ${totalLanded} of ${totalExpected} records — no silent data loss: ${failures.join('; ')}`,
    );
  }

  await db.transaction(async (tx) => {
    await transitionMigrationState(
      tx,
      ctx,
      migration.id,
      'staged',
      'imported',
      'forward',
      'the incumbent history landed through the owning contracts',
      { manifests: manifests.rows.length, recordsLanded: totalLanded },
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'imported',
      clampDetail(`${totalLanded} record(s) landed through ${manifests.rows.length} manifest batch(es)`),
    );
  });

  return getMigration(ctx, { migrationId: migration.id });
}

// ---------------------------------------------------------------------------
// DUAL RUN — start, sync, compare
// ---------------------------------------------------------------------------

export async function startDualRun(ctx: TenantContext, input: unknown): Promise<MigrationDetail> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateMigrationTarget(input, 'startDualRun input');
  const migration = requireState(
    await loadMigrationRow(ctx, valid.migrationId),
    ['imported'],
    'startDualRun',
  );
  const mappings = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM migration_identity_mappings WHERE tenant_id = $1 AND migration_id = $2`,
    [ctx.tenantId, migration.id],
  );
  await getDb().transaction(async (tx) => {
    await transitionMigrationState(
      tx,
      ctx,
      migration.id,
      'imported',
      'dual-running',
      'forward',
      'the incumbent and Aurum now run in parallel — the incumbent remains the authority of record',
      { mappings: Number(mappings.rows[0]?.count ?? 0) },
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'dual-run-started',
      clampDetail(`${mappings.rows[0]?.count ?? 0} mapped record(s) under incumbent authority`),
    );
  });
  return getMigration(ctx, { migrationId: migration.id });
}

/**
 * ONE dual-run sync pass: pull the incumbent collections through the
 * transport, land new records, detect both-sides-touched conflicts
 * (recorded, never auto-resolved), and back-write Aurum-side changes
 * where the incumbent accepts them.
 */
export async function runSyncPass(ctx: TenantContext, input: unknown): Promise<SyncRun> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateMigrationTarget(input, 'runSyncPass input');
  const db = getDb();
  const migration = requireState(
    await loadMigrationRow(ctx, valid.migrationId),
    ['dual-running', 'retiring-incumbent'],
    'runSyncPass',
  );
  const transport = requireTransport();
  const connection = await loadActiveConnection(ctx, migration);

  const sequenceRows = await db.query<{ max: number | null }>(
    `SELECT MAX(sequence) AS max FROM migration_sync_runs WHERE tenant_id = $1 AND migration_id = $2`,
    [ctx.tenantId, migration.id],
  );
  const sequence = (sequenceRows.rows[0]?.max ?? 0) + 1;
  const syncRunId = newId();
  // The pass starts 'running' (a hard-killed worker leaves exactly this
  // row — the honest in-flight trace; the W080 discipline); it closes as
  // 'completed' with its finished_at when the pass ends.
  await db.query(
    `INSERT INTO migration_sync_runs
       (id, tenant_id, migration_id, sequence, status, started_at)
     VALUES ($1, $2, $3, $4, 'running', $5)`,
    [syncRunId, ctx.tenantId, migration.id, sequence, now()],
  );

  let recordsRead = 0;
  let recordsLanded = 0;
  let backWritesAttempted = 0;
  let backWritesAccepted = 0;
  let backWritesRefused = 0;
  let backWritesFailed = 0;
  let backWritesBlocked = 0;
  let conflictsDetected = 0;

  const manifests = await db.query<ManifestRow>(
    `SELECT * FROM migration_import_manifests
       WHERE tenant_id = $1 AND migration_id = $2 AND status = 'ok' ORDER BY batch_no`,
    [ctx.tenantId, migration.id],
  );

  // The incumbent's CURRENT collections, per kind.
  const incumbentRecords = new Map<string, Map<string, Record<string, unknown>>>();
  for (const manifest of manifests.rows) {
    const records = await readIncumbentCollection(
      ctx,
      migration,
      transport,
      connection,
      manifest.target,
      `migration-continuity:${migration.id}:sync:${sequence}:${manifest.batch_no}`,
    );
    let byId = incumbentRecords.get(manifest.entity_kind);
    if (byId === undefined) {
      byId = new Map();
      incumbentRecords.set(manifest.entity_kind, byId);
    }
    for (const record of records) {
      const validated = validateIncumbentRecord(record);
      byId.set(validated.incumbentId, record);
    }
    recordsRead += records.length;
  }

  // PHASE A — NEW incumbent records land through the ladder.
  for (const [entityKind, byId] of incumbentRecords) {
    const resolution = await resolveEntityKind(ctx, entityKind);
    for (const [incumbentId, record] of byId) {
      const existing = await findMapping(ctx, migration.id, entityKind, incumbentId);
      if (existing !== null) continue; // PHASE B handles mapped records
      const outcome = await landIncumbentRecord(ctx, migration, record, resolution, entityKind);
      const incumbentVersion = canonicalIncumbentVersion(record, resolution);
      if ('ambiguous' in outcome) {
        await recordAmbiguousMapping(ctx, migration, {
          incumbentId,
          incumbentKind: entityKind,
          candidates: outcome.ambiguous.candidates,
          basis: outcome.ambiguous.basis,
          provenance: { attributes: { naturalKeyDetected: true } },
          batchNo: 0,
        });
        continue;
      }
      const mapping = await insertVerifiedMapping(ctx, migration, {
        incumbentId,
        incumbentKind: entityKind,
        landed: outcome.landed,
        incumbentVersion,
        aurumVersion: incumbentVersion,
        matchBasis: 'sync-created',
        provenance: provenanceOf(record, resolution),
        batchNo: 0,
      });
      const aurumView = await canonicalAurumVersion(ctx, mapping);
      await updateMappingCheckpoints(ctx, mapping, incumbentVersion, aurumView.version);
      recordsLanded += 1;
    }
  }

  // PHASE B — per mapped record: conflict detection, landing, back-write.
  const mappings = await db.query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE tenant_id = $1 AND migration_id = $2`,
    [ctx.tenantId, migration.id],
  );
  for (const mapping of mappings.rows) {
    // Ambiguous mappings never landed — they stay incumbent-only and
    // surface through the comparison report, never as sync conflicts.
    if (mapping.verification_state !== 'verified' || mapping.aurum_id === null) continue;

    const byId = incumbentRecords.get(mapping.incumbent_kind);
    const record = byId?.get(mapping.incumbent_id) ?? null;
    const resolution = await resolveEntityKind(ctx, mapping.incumbent_kind);

    // DELETION incumbent-side: the record is gone from the collection.
    if (record === null) {
      const aurumView = await canonicalAurumVersion(ctx, mapping);
      const aurChanged =
        mapping.last_aurum_checksum === null ||
        checksumOf(aurumView.version) !== mapping.last_aurum_checksum;
      if (aurChanged && mapping.last_aurum_checksum !== null) {
        conflictsDetected += 1;
        await recordConflict(ctx, migration, {
          mapping,
          taxonomy: 'delete-vs-update',
          incumbentVersion: null,
          aurumVersion: aurumView.version,
          incumbentUpdatedAt: null,
          aurumUpdatedAt: aurumView.updatedAt,
          syncRunId,
          provenance: {
            incumbent: { found: false, collection: 'absent from the incumbent collection' },
            aurum: {
              currentAurumId: mapping.current_aurum_id ?? mapping.aurum_id,
              changedSinceLastPass: true,
            },
          },
        });
      }
      continue;
    }

    const incumbentVersion = canonicalIncumbentVersion(record, resolution);
    const aurumView = await canonicalAurumVersion(ctx, mapping);
    const incChanged =
      mapping.last_incumbent_checksum === null ||
      checksumOf(incumbentVersion) !== mapping.last_incumbent_checksum;
    const aurChanged =
      mapping.last_aurum_checksum === null ||
      checksumOf(aurumView.version) !== mapping.last_aurum_checksum;
    const versionsDiverge = checksumOf(incumbentVersion) !== checksumOf(aurumView.version);

    // BOTH sides touched and the versions diverge: CONCURRENT UPDATE —
    // recorded with both versions, never auto-resolved.
    if (incChanged && aurChanged && versionsDiverge) {
      conflictsDetected += 1;
      const reconciliation = reconcileOperation(
        aurumView.version,
        incumbentVersion,
        safeForm(mapping.last_incumbent_form),
      );
      await recordConflict(ctx, migration, {
        mapping,
        taxonomy: 'concurrent-update',
        incumbentVersion,
        aurumVersion: aurumView.version,
        incumbentUpdatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : null,
        aurumUpdatedAt: aurumView.updatedAt,
        syncRunId,
        provenance: {
          incumbent: { collectionRead: true, changedSinceLastPass: true },
          aurum: {
            currentAurumId: mapping.current_aurum_id ?? mapping.aurum_id,
            changedSinceLastPass: true,
          },
        },
        reconciliation,
      });
      continue; // nothing lands, nothing back-writes — the conflict is the outcome
    }

    // Only the incumbent advanced: land its new version into Aurum.
    if (incChanged && !aurChanged) {
      await landIncumbentAdvance(ctx, migration, mapping, resolution, record, incumbentVersion);
      const refreshed = await reloadMapping(ctx, mapping.id);
      const refreshedView = await canonicalAurumVersion(ctx, refreshed);
      await updateMappingCheckpoints(ctx, refreshed, incumbentVersion, refreshedView.version);
      continue;
    }

    // Only Aurum advanced (live Aurum activity during dual-run): back-write.
    if (!incChanged && aurChanged) {
      if (migration.write_capability_key === null) {
        // The incumbent accepts no back-writes: the divergence is
        // surfaced (the run + the comparison report carry it).
        backWritesBlocked += 1;
        await recordEvent(
          db,
          ctx,
          migration.id,
          'back-write-blocked',
          clampDetail(
            `record '${mapping.incumbent_id}' advanced in Aurum but the incumbent accepts no back-writes`,
          ),
        );
      } else {
        const taskContext = readTaskContext(migration);
        const invocation = await invokeCapability(ctx, {
          connectionId: migration.connection_id,
          capabilityKey: migration.write_capability_key,
          taskContext: {
            description: taskContext.description,
            requestedFor: taskContext.requestedFor,
          },
        });
        if (invocation.outcome === 'denied') {
          backWritesBlocked += 1;
          await recordEvent(
            db,
            ctx,
            migration.id,
            'back-write-blocked',
            clampDetail(
              `the W083 gate denied '${migration.write_capability_key}' for record '${mapping.incumbent_id}' — the divergence stays surfaced`,
            ),
          );
        } else {
          backWritesAttempted += 1;
          const receipt = await transport.execute({
            connectionId: migration.connection_id,
            credentialRef: connection.credentialRef ?? '',
            systemKey: migration.system_key,
            capabilityKey: migration.write_capability_key,
            target: mapping.incumbent_id,
            payload: aurumView.version,
            idempotencyKey: `migration-continuity:${migration.id}:sync:${sequence}:${mapping.incumbent_id}`,
          });
          if (receipt.status === 'accepted') {
            backWritesAccepted += 1;
            await updateMappingCheckpoints(ctx, mapping, aurumView.version, aurumView.version);
          } else if (receipt.status === 'rejected') {
            backWritesRefused += 1;
            conflictsDetected += 1;
            await recordConflict(ctx, migration, {
              mapping,
              taxonomy: 'back-write-refused',
              incumbentVersion,
              aurumVersion: aurumView.version,
              incumbentUpdatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : null,
              aurumUpdatedAt: aurumView.updatedAt,
              syncRunId,
              provenance: {
                incumbent: { refusedReceipt: receipt.receiptId, detail: receipt.detail },
                aurum: { currentAurumId: mapping.current_aurum_id ?? mapping.aurum_id },
              },
              reconciliation: reconcileOperation(
                aurumView.version,
                incumbentVersion,
                safeForm(mapping.last_incumbent_form),
              ),
            });
          } else {
            backWritesFailed += 1; // transient — the next pass retries
          }
        }
      }
      continue;
    }

    // In sync — nothing moved, or both sides moved and CONVERGED (the
    // post-conflict adoption case): refresh the checkpoints so the
    // baseline tracks the converged state.
    await updateMappingCheckpoints(ctx, mapping, incumbentVersion, aurumView.version);
  }

  await db.query(
    `UPDATE migration_sync_runs SET
        records_read = $3, records_landed = $4, back_writes_attempted = $5, back_writes_accepted = $6,
        back_writes_refused = $7, back_writes_failed = $8, back_writes_blocked = $9,
        conflicts_detected = $10, status = 'completed', finished_at = $11
      WHERE tenant_id = $1 AND id = $2`,
    [
      ctx.tenantId,
      syncRunId,
      recordsRead,
      recordsLanded,
      backWritesAttempted,
      backWritesAccepted,
      backWritesRefused,
      backWritesFailed,
      backWritesBlocked,
      conflictsDetected,
      now(),
    ],
  );
  await recordEvent(
    db,
    ctx,
    migration.id,
    'sync-completed',
    clampDetail(
      `pass ${sequence}: ${recordsRead} read, ${recordsLanded} landed, ${backWritesAccepted} back-write(s) accepted, ${conflictsDetected} conflict(s)`,
    ),
  );

  const rows = await db.query<SyncRunRow>(
    `SELECT * FROM migration_sync_runs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, syncRunId],
  );
  return mapSyncRun(rows.rows[0]!);
}

/**
 * Lands the incumbent's advanced version into Aurum: new conversation
 * turns land as real messages (providerMessageId dedupe); the advanced
 * version ALSO lands as a sync-update OBSERVATION that supersedes the
 * mapping's current view (corrections are new observations — lock 12).
 */
async function landIncumbentAdvance(
  ctx: TenantContext,
  migration: MigrationRow,
  mapping: MappingRow,
  resolution: KindResolution,
  record: Record<string, unknown>,
  incumbentVersion: Record<string, unknown>,
): Promise<void> {
  const validated = validateIncumbentRecord(record);
  const observedAt = observedAtOf(validated.updatedAt);

  if (resolution.resolution === 'conversation' && mapping.aurum_kind === 'conversation' && mapping.aurum_id !== null) {
    const parsed = parseConversationRecord(record);
    if (parsed !== null) {
      const messages = (await listMessages(ctx, {
        conversationId: mapping.aurum_id,
        limit: 500,
      })) as Message[];
      const known = new Set(messages.map((message) => message.providerMessageId ?? message.id));
      for (const turn of parsed.turns) {
        if (known.has(turn.turnId)) continue; // the turn already landed
        await recordMessage(ctx, {
          conversationId: mapping.aurum_id,
          direction: turn.direction,
          actor: { kind: 'external', label: turn.actorLabel ?? migration.system_display_name },
          channel: parsed.channel as ChannelProvider,
          payload: turn.payload,
          sentAt: turn.sentAt,
          providerMessageId: turn.turnId,
        });
      }
    }
  }

  // The sync-update observation: the durable evidence of the
  // incumbent's advanced version — and the mapping's new current view.
  const observation = await landObservation(ctx, migration, {
    kind: SYNC_UPDATE_OBSERVATION_KIND,
    payload: {
      incumbentKind: mapping.incumbent_kind,
      record,
      supersedes: mapping.current_aurum_id ?? mapping.aurum_id,
      canonicalVersion: incumbentVersion,
    },
    observedAt,
  });
  await supersedeCurrentView(ctx, mapping, observation.id);
}

async function recordConflict(
  ctx: TenantContext,
  migration: MigrationRow,
  input: {
    mapping: MappingRow;
    taxonomy: MigrationConflictTaxonomy;
    incumbentVersion: Record<string, unknown> | null;
    aurumVersion: Record<string, unknown>;
    incumbentUpdatedAt: string | null;
    aurumUpdatedAt: string | null;
    syncRunId: string;
    provenance: Record<string, unknown>;
    reconciliation?: OperationReconciliation;
  },
): Promise<void> {
  await getDb().query(
    `INSERT INTO migration_conflicts
       (id, tenant_id, migration_id, entity_kind, incumbent_id, aurum_id, taxonomy,
        incumbent_version, aurum_version, incumbent_updated_at, aurum_updated_at,
        provenance, reconciliation, resolution, status, detected_in_sync_run, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'none', 'open', $14, $15)`,
    [
      newId(),
      ctx.tenantId,
      migration.id,
      input.mapping.incumbent_kind,
      input.mapping.incumbent_id,
      input.mapping.current_aurum_id ?? input.mapping.aurum_id,
      input.taxonomy,
      input.incumbentVersion === null ? null : JSON.stringify(input.incumbentVersion),
      JSON.stringify(input.aurumVersion),
      input.incumbentUpdatedAt === null ? null : new Date(input.incumbentUpdatedAt),
      input.aurumUpdatedAt === null ? null : new Date(input.aurumUpdatedAt),
      JSON.stringify(input.provenance),
      input.reconciliation === undefined ? null : JSON.stringify(input.reconciliation),
      input.syncRunId,
      now(),
    ],
  );
  await recordEvent(
    getDb(),
    ctx,
    migration.id,
    'conflict-detected',
    clampDetail(
      `${input.taxonomy} on '${input.mapping.incumbent_id}' (${input.mapping.incumbent_kind}) — both versions recorded, never auto-resolved`,
    ),
  );
}

// ---------------------------------------------------------------------------
// COMPARE — the reconcile-based report (the retirement decision's input)
// ---------------------------------------------------------------------------

export async function compareMigration(ctx: TenantContext, input: unknown): Promise<ComparisonReport> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateCompareMigrationInput(input);
  const db = getDb();
  const migration = requireState(
    await loadMigrationRow(ctx, valid.migrationId),
    ['dual-running', 'retiring-incumbent'],
    'compareMigration',
  );
  const transport = requireTransport();
  const connection = await loadActiveConnection(ctx, migration);

  // The incumbent's CURRENT view of the kind (a fresh, gated read).
  const manifests = await db.query<ManifestRow>(
    `SELECT * FROM migration_import_manifests
       WHERE tenant_id = $1 AND migration_id = $2 AND entity_kind = $3 AND status = 'ok'`,
    [ctx.tenantId, migration.id, valid.entityKind],
  );
  const incumbentRecords = new Map<string, Record<string, unknown>>();
  for (const manifest of manifests.rows) {
    const records = await readIncumbentCollection(
      ctx,
      migration,
      transport,
      connection,
      manifest.target,
      `migration-continuity:${migration.id}:compare:${manifest.batch_no}`,
    );
    for (const record of records) {
      const validated = validateIncumbentRecord(record);
      incumbentRecords.set(validated.incumbentId, record);
    }
  }

  const resolution = await resolveEntityKind(ctx, valid.entityKind);
  const mappings = await db.query<MappingRow>(
    `SELECT * FROM migration_identity_mappings
       WHERE tenant_id = $1 AND migration_id = $2 AND incumbent_kind = $3`,
    [ctx.tenantId, migration.id, valid.entityKind],
  );

  const outcomes: ComparisonOutcomeRow[] = [];
  const seenIncumbentIds = new Set<string>();

  for (const mapping of mappings.rows) {
    const record = incumbentRecords.get(mapping.incumbent_id) ?? null;
    seenIncumbentIds.add(mapping.incumbent_id);

    if (mapping.verification_state !== 'verified' || mapping.aurum_id === null) {
      // An ambiguous mapping: the incumbent record stays incumbent-only
      // (it was never merged into an Aurum record).
      outcomes.push({
        incumbentId: mapping.incumbent_id,
        aurumId: null,
        outcome: 'incumbent-only',
        reconciliation: null,
      });
      continue;
    }
    const aurumView = await canonicalAurumVersion(ctx, mapping);
    if (record === null) {
      // The incumbent deleted it; Aurum still holds the copy.
      outcomes.push({
        incumbentId: mapping.incumbent_id,
        aurumId: mapping.current_aurum_id ?? mapping.aurum_id,
        outcome: 'aurum-only',
        reconciliation: null,
      });
      continue;
    }
    // Both sides hold the logical record: the W084 reconciliation,
    // VERBATIM — the Aurum view is the expectation, the incumbent's
    // current state the observed post-state, and the last-synced
    // incumbent form the pre-state.
    const incumbentVersion = canonicalIncumbentVersion(record, resolution);
    const reconciliation = reconcileOperation(
      aurumView.version,
      incumbentVersion,
      safeForm(mapping.last_incumbent_form),
    );
    outcomes.push({
      incumbentId: mapping.incumbent_id,
      aurumId: mapping.current_aurum_id ?? mapping.aurum_id,
      outcome: reconciliation.matched ? 'matched' : 'diverged',
      reconciliation: reconciliation as unknown as Record<string, unknown>,
    });
  }

  // Incumbent records with NO mapping at all (never landed).
  for (const incumbentId of incumbentRecords.keys()) {
    if (!seenIncumbentIds.has(incumbentId)) {
      outcomes.push({ incumbentId, aurumId: null, outcome: 'incumbent-only', reconciliation: null });
    }
  }

  const matchedCount = outcomes.filter((row) => row.outcome === 'matched').length;
  const divergedCount = outcomes.filter((row) => row.outcome === 'diverged').length;
  const incumbentOnlyCount = outcomes.filter((row) => row.outcome === 'incumbent-only').length;
  const aurumOnlyCount = outcomes.filter((row) => row.outcome === 'aurum-only').length;
  const clean = divergedCount === 0 && incumbentOnlyCount === 0 && aurumOnlyCount === 0;
  const id = newId();
  await db.query(
    `INSERT INTO migration_comparison_reports
       (id, tenant_id, migration_id, entity_kind, matched_count, diverged_count,
        incumbent_only_count, aurum_only_count, clean, outcomes, compared_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      ctx.tenantId,
      migration.id,
      valid.entityKind,
      matchedCount,
      divergedCount,
      incumbentOnlyCount,
      aurumOnlyCount,
      clean,
      JSON.stringify(outcomes),
      now(),
    ],
  );
  await recordEvent(
    db,
    ctx,
    migration.id,
    'comparison-recorded',
    clampDetail(
      `${valid.entityKind}: ${matchedCount} matched, ${divergedCount} diverged, ${incumbentOnlyCount} incumbent-only, ${aurumOnlyCount} aurum-only (reconcileOperation-based)`,
    ),
  );
  const rows = await db.query<ReportRow>(
    `SELECT * FROM migration_comparison_reports WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  return mapReport(rows.rows[0]!);
}

// ---------------------------------------------------------------------------
// RETIREMENT — progressive, per entity kind, gated on clean comparisons
// ---------------------------------------------------------------------------

async function latestReportFor(
  ctx: TenantContext,
  migrationId: string,
  entityKind: string,
): Promise<ReportRow | null> {
  const rows = await getDb().query<ReportRow>(
    `SELECT * FROM migration_comparison_reports
       WHERE tenant_id = $1 AND migration_id = $2 AND entity_kind = $3
       ORDER BY compared_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, migrationId, entityKind],
  );
  return rows.rows[0] ?? null;
}

async function latestWindowFor(
  ctx: TenantContext,
  migrationId: string,
  entityKind: string,
): Promise<WindowRow | null> {
  const rows = await getDb().query<WindowRow>(
    `SELECT * FROM migration_retirement_windows
       WHERE tenant_id = $1 AND migration_id = $2 AND entity_kind = $3
       ORDER BY sequence DESC LIMIT 1`,
    [ctx.tenantId, migrationId, entityKind],
  );
  return rows.rows[0] ?? null;
}

async function openConflictCount(
  ctx: TenantContext,
  migrationId: string,
  entityKind: string,
): Promise<number> {
  const rows = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM migration_conflicts
       WHERE tenant_id = $1 AND migration_id = $2 AND entity_kind = $3 AND status = 'open'`,
    [ctx.tenantId, migrationId, entityKind],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

/** The retirement gate: an EMPTY conflict queue AND a clean comparison. */
async function assertRetirementGates(
  ctx: TenantContext,
  migrationId: string,
  entityKind: string,
): Promise<ReportRow> {
  const openConflicts = await openConflictCount(ctx, migrationId, entityKind);
  if (openConflicts > 0) {
    throw new MigrationContinuityError(
      'retirement_conflicts_open',
      `the entity kind '${entityKind}' cannot retire: ${openConflicts} conflict(s) are still open`,
    );
  }
  const report = await latestReportFor(ctx, migrationId, entityKind);
  if (report === null || !report.clean) {
    const detail =
      report === null
        ? 'no comparison report exists for the kind yet'
        : `the latest report is not clean (${report.diverged_count} diverged, ${report.incumbent_only_count} incumbent-only, ${report.aurum_only_count} aurum-only)`;
    throw new MigrationContinuityError(
      'retirement_not_clean',
      `the entity kind '${entityKind}' cannot retire: ${detail}`,
    );
  }
  return report;
}

export async function openRetirementWindow(
  ctx: TenantContext,
  input: unknown,
): Promise<RetirementWindow> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateRetirementKindInput(input);
  const db = getDb();
  const migration = requireState(
    await loadMigrationRow(ctx, valid.migrationId),
    ['dual-running', 'retiring-incumbent'],
    'openRetirementWindow',
  );
  const report = await assertRetirementGates(ctx, migration.id, valid.entityKind);

  const latest = await latestWindowFor(ctx, migration.id, valid.entityKind);
  if (latest !== null && latest.status === 'open') {
    throw new MigrationContinuityError(
      'window_not_open',
      `the entity kind '${valid.entityKind}' already holds an open retirement window`,
    );
  }
  const sequence = (latest?.sequence ?? 0) + 1;
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO migration_retirement_windows
         (id, tenant_id, migration_id, entity_kind, sequence, status, closed_with_report_id, opened_at, opened_by)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
      [id, ctx.tenantId, migration.id, valid.entityKind, sequence, report.id, now(), ctx.principalId],
    );
    if (migration.state === 'dual-running') {
      await transitionMigrationState(
        tx,
        ctx,
        migration.id,
        'dual-running',
        'retiring-incumbent',
        'forward',
        `the retirement window for '${valid.entityKind}' opened (comparison clean, conflict queue empty)`,
        { entityKind: valid.entityKind, sequence, comparisonReportId: report.id },
      );
    }
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'retirement-window-opened',
      clampDetail(`${valid.entityKind} window ${sequence} opened on clean report ${report.id}`),
    );
  });
  const rows = await db.query<WindowRow>(
    `SELECT * FROM migration_retirement_windows WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  return mapWindow(rows.rows[0]!);
}

export async function completeRetirement(
  ctx: TenantContext,
  input: unknown,
): Promise<{ window: RetirementWindow; migration: Migration }> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateRetirementKindInput(input);
  const db = getDb();
  const migration = requireState(
    await loadMigrationRow(ctx, valid.migrationId),
    ['retiring-incumbent'],
    'completeRetirement',
  );
  const latest = await latestWindowFor(ctx, migration.id, valid.entityKind);
  if (latest === null || latest.status !== 'open') {
    throw new MigrationContinuityError(
      'window_not_open',
      `the entity kind '${valid.entityKind}' holds no open retirement window`,
    );
  }
  // The window may have gone stale — the gates re-check honestly.
  const report = await assertRetirementGates(ctx, migration.id, valid.entityKind);

  await db.transaction(async (tx) => {
    const updated = await tx.query<WindowRow>(
      `UPDATE migration_retirement_windows SET status = 'retired', retired_at = $3, closed_with_report_id = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'open' RETURNING *`,
      [ctx.tenantId, latest.id, now(), report.id],
    );
    if (updated.rows[0] === undefined) {
      throw new MigrationContinuityError(
        'window_not_open',
        `the entity kind '${valid.entityKind}' holds no open retirement window`,
      );
    }
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'kind-retired',
      clampDetail(`${valid.entityKind} retired (window ${latest.sequence})`),
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'authority-transferred',
      clampDetail(
        `authority for '${valid.entityKind}' transferred to Aurum — the incumbent is no longer the authority of record for the kind`,
      ),
    );
    // The migration retires when EVERY migrated kind's latest window is
    // retired (progressive retirement: conversations first, then ...).
    const kinds = await tx.query<{ entity_kind: string }>(
      `SELECT DISTINCT incumbent_kind AS entity_kind FROM migration_identity_mappings
          WHERE tenant_id = $1 AND migration_id = $2
        UNION SELECT DISTINCT entity_kind FROM migration_import_manifests
          WHERE tenant_id = $1 AND migration_id = $2 AND status = 'ok'`,
      [ctx.tenantId, migration.id],
    );
    const notRetired = await tx.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM (
         SELECT k.entity_kind,
                (SELECT w.status FROM migration_retirement_windows w
                  WHERE w.tenant_id = $1 AND w.migration_id = $2
                    AND w.entity_kind = k.entity_kind
                  ORDER BY w.sequence DESC LIMIT 1) AS latest_status
           FROM (
             SELECT DISTINCT incumbent_kind AS entity_kind FROM migration_identity_mappings
                WHERE tenant_id = $1 AND migration_id = $2
             UNION SELECT DISTINCT entity_kind FROM migration_import_manifests
                WHERE tenant_id = $1 AND migration_id = $2 AND status = 'ok'
           ) k
       ) latest WHERE latest.latest_status IS DISTINCT FROM 'retired'`,
      [ctx.tenantId, migration.id],
    );
    if (kinds.rows.length > 0 && Number(notRetired.rows[0]?.count ?? 1) === 0) {
      await transitionMigrationState(
        tx,
        ctx,
        migration.id,
        'retiring-incumbent',
        'retired',
        'forward',
        'every migrated entity kind retired its incumbent authority',
        { kinds: kinds.rows.map((row) => row.entity_kind) },
      );
      await recordEvent(tx, ctx, migration.id, 'retired', 'the incumbent is fully retired for this migration');
    }
  });

  const windowRows = await db.query<WindowRow>(
    `SELECT * FROM migration_retirement_windows WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, latest.id],
  );
  const migrationRows = await db.query<MigrationRow>(
    `SELECT * FROM migration_runs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, migration.id],
  );
  return { window: mapWindow(windowRows.rows[0]!), migration: mapMigration(migrationRows.rows[0]!) };
}

// ---------------------------------------------------------------------------
// ROLLBACK — reversible from any state, evidence retained
// ---------------------------------------------------------------------------

export async function rollbackMigration(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationDetail> {
  assertMigrationContinuityTenantContext(ctx);
  requireAdminister(ctx, 'rolling a migration back');
  const valid = validateRollbackMigrationInput(input);
  const db = getDb();
  const migration = await loadMigrationRow(ctx, valid.migrationId);

  const target = rollbackTargetOf(migration.state);
  if (target === null || !canTransitionMigration(migration.state, target)) {
    throw new MigrationContinuityError(
      'nothing_to_rollback',
      `migration '${migration.id}' is at its initial state '${migration.state}' — there is no transition to reverse`,
    );
  }

  const evidence: Record<string, unknown> = { from: migration.state, to: target };
  await db.transaction(async (tx) => {
    if (migration.state === 'retiring-incumbent') {
      // Open windows roll back: incumbent authority is restored for
      // those kinds, the trail retained.
      const rolled = await tx.query<WindowRow>(
        `UPDATE migration_retirement_windows SET status = 'rolled-back'
           WHERE tenant_id = $1 AND migration_id = $2 AND status = 'open' RETURNING *`,
        [ctx.tenantId, migration.id],
      );
      evidence['windowsRolledBack'] = rolled.rows.map((row) => ({
        entityKind: row.entity_kind,
        sequence: row.sequence,
      }));
    }
    if (migration.state === 'retired') {
      // The most recently retired window RE-OPENS as a new row —
      // incumbent authority restored for that kind, trail retained.
      const lastRetired = await tx.query<WindowRow>(
        `SELECT * FROM migration_retirement_windows
           WHERE tenant_id = $1 AND migration_id = $2 AND status = 'retired'
           ORDER BY retired_at DESC, sequence DESC LIMIT 1`,
        [ctx.tenantId, migration.id],
      );
      const window = lastRetired.rows[0];
      if (window !== undefined) {
        await tx.query(
          `INSERT INTO migration_retirement_windows
             (id, tenant_id, migration_id, entity_kind, sequence, status, closed_with_report_id, opened_at, opened_by)
           VALUES ($1, $2, $3, $4, $5, 'open', NULL, $6, $7)`,
          [
            newId(),
            ctx.tenantId,
            migration.id,
            window.entity_kind,
            window.sequence + 1,
            now(),
            ctx.principalId,
          ],
        );
        evidence['reopenedWindow'] = { entityKind: window.entity_kind, sequence: window.sequence + 1 };
      }
    }
    await transitionMigrationState(
      tx,
      ctx,
      migration.id,
      migration.state,
      target,
      'rollback',
      valid.reason,
      evidence,
    );
    await recordEvent(
      tx,
      ctx,
      migration.id,
      'rollback',
      clampDetail(`${migration.state} -> ${target}: ${valid.reason}`),
    );
  });

  return getMigration(ctx, { migrationId: migration.id });
}

// ---------------------------------------------------------------------------
// THE TRUST OPERATIONS (claim-gated, never automatic)
// ---------------------------------------------------------------------------

export async function resolveMappingAmbiguity(
  ctx: TenantContext,
  input: unknown,
): Promise<IdentityMapping> {
  assertMigrationContinuityTenantContext(ctx);
  requireAdminister(ctx, 'resolving an identity-mapping ambiguity');
  const valid = validateResolveMappingAmbiguityInput(input);
  const db = getDb();
  const rows = await db.query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.mappingId],
  );
  const mapping = rows.rows[0];
  if (mapping === undefined) {
    throw new MigrationContinuityError(
      'mapping_not_found',
      `no identity mapping '${valid.mappingId}' exists in this tenant`,
    );
  }
  if (mapping.verification_state !== 'unverified-external') {
    throw new MigrationContinuityError(
      'mapping_not_ambiguous',
      `the mapping '${valid.mappingId}' is '${mapping.verification_state}' — only an ambiguous mapping can be resolved`,
    );
  }
  // The chosen Aurum record must be a REAL row of the kind's owning
  // surface (the deterministic ladder decides which contract reads it).
  const resolution = await resolveEntityKind(ctx, mapping.incumbent_kind);
  const resolvedKind =
    resolution.resolution === 'conversation' || resolution.resolution === 'person'
      ? resolution.resolution
      : 'observation';
  if (resolvedKind === 'person') {
    await getPerson(ctx, valid.aurumId);
  } else if (resolvedKind === 'conversation') {
    await getConversation(ctx, valid.aurumId);
  } else {
    await getObservation(ctx, valid.aurumId);
  }
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_identity_mappings SET
          aurum_id = $3, aurum_kind = $4, current_aurum_id = $3, verification_state = 'verified',
          match_basis = 'human-resolution',
          provenance = provenance || $5::jsonb, updated_at = $6
        WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        valid.mappingId,
        valid.aurumId,
        resolvedKind,
        JSON.stringify({
          resolvedBy: ctx.principalId,
          resolutionNote: valid.note,
          resolvedAt: now().toISOString(),
        }),
        now(),
      ],
    );
    await recordEvent(
      tx,
      ctx,
      mapping.migration_id,
      'mapping-ambiguity-resolved',
      clampDetail(
        `mapping '${valid.mappingId}' resolved to Aurum record '${valid.aurumId}' by a human decision`,
      ),
    );
  });
  // The resolution establishes the Aurum baseline: the next sync pass
  // lands the incumbent's version as an advance (never as a conflict —
  // the human decision IS the reconciliation of the two sides).
  const resolved = await reloadMapping(ctx, valid.mappingId);
  const aurumView = await canonicalAurumVersion(ctx, resolved);
  await getDb().query(
    `UPDATE migration_identity_mappings SET last_aurum_checksum = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.mappingId, checksumOf(aurumView.version), now()],
  );
  const refreshed = await db.query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.mappingId],
  );
  return mapMapping(refreshed.rows[0]!);
}

export async function resolveConflict(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationConflict> {
  assertMigrationContinuityTenantContext(ctx);
  requireAdminister(ctx, 'resolving a conflict');
  const valid = validateResolveConflictInput(input);
  const db = getDb();
  const rows = await db.query<ConflictRow>(
    `SELECT * FROM migration_conflicts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.conflictId],
  );
  const conflict = rows.rows[0];
  if (conflict === undefined) {
    throw new MigrationContinuityError(
      'conflict_not_found',
      `no conflict '${valid.conflictId}' exists in this tenant`,
    );
  }
  if (conflict.status !== 'open') {
    throw new MigrationContinuityError(
      'conflict_not_open',
      `the conflict '${valid.conflictId}' is already resolved`,
    );
  }
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE migration_conflicts SET
          status = 'resolved', resolution = $3, resolution_note = $4, resolved_by = $5, resolved_at = $6
        WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
      [ctx.tenantId, valid.conflictId, valid.resolution, valid.note, ctx.principalId, now()],
    );
    await recordEvent(
      tx,
      ctx,
      conflict.migration_id,
      'conflict-resolved',
      clampDetail(
        `conflict '${valid.conflictId}' resolved for '${valid.resolution}' by a human decision`,
      ),
    );
  });
  const refreshed = await db.query<ConflictRow>(
    `SELECT * FROM migration_conflicts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.conflictId],
  );
  return mapConflict(refreshed.rows[0]!);
}

// ---------------------------------------------------------------------------
// THE INTEGRITY PROBE (no silent data loss — re-derived, hard failure)
// ---------------------------------------------------------------------------

export async function verifyImportIntegrity(
  ctx: TenantContext,
  input: unknown,
): Promise<ImportIntegrityReport> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateMigrationTarget(input, 'verifyImportIntegrity input');
  const db = getDb();
  const migration = await loadMigrationRow(ctx, valid.migrationId);
  const manifests = await db.query<ManifestRow>(
    `SELECT * FROM migration_import_manifests
       WHERE tenant_id = $1 AND migration_id = $2 AND status <> 'planned' ORDER BY batch_no`,
    [ctx.tenantId, migration.id],
  );
  const failures: ImportIntegrityReport['failures'] = [];
  let landedRecordsChecked = 0;

  for (const manifest of manifests.rows) {
    const landedRecords = Array.isArray(manifest.landed_records)
      ? (manifest.landed_records as ImportManifest['landedRecords'])
      : [];
    if (landedRecords.length !== manifest.landed_count) {
      failures.push({
        manifestId: manifest.id,
        batchNo: manifest.batch_no,
        failure: `the manifest counts ${manifest.landed_count} landed records but its landing ledger holds ${landedRecords.length}`,
      });
      continue;
    }
    let rechecked = 0;
    for (const landed of landedRecords) {
      landedRecordsChecked += 1;
      rechecked += 1;
      try {
        if (landed.aurumKind === 'conversation') {
          await getConversation(ctx, landed.aurumId);
          await listMessages(ctx, { conversationId: landed.aurumId, limit: 500 });
        } else if (landed.aurumKind === 'person') {
          await getPerson(ctx, landed.aurumId);
        } else {
          await getObservation(ctx, landed.aurumId);
        }
      } catch (error) {
        failures.push({
          manifestId: manifest.id,
          batchNo: manifest.batch_no,
          failure: `the landed record '${landed.incumbentId}' (${landed.aurumId}) is no longer readable through the owning contract: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    // The identity map must still hold every landed record's mapping —
    // a vanished mapping is data loss, surfaced.
    const mapped = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM migration_identity_mappings
          WHERE tenant_id = $1 AND migration_id = $2 AND incumbent_kind = $3`,
      [ctx.tenantId, migration.id, manifest.entity_kind],
    );
    if (Number(mapped.rows[0]?.count ?? 0) < rechecked - failures.length) {
      failures.push({
        manifestId: manifest.id,
        batchNo: manifest.batch_no,
        failure: `the identity map holds fewer mappings than the manifest landed for '${manifest.entity_kind}' — records went missing`,
      });
    }
  }

  const report: ImportIntegrityReport = {
    migrationId: migration.id,
    manifestsChecked: manifests.rows.length,
    landedRecordsChecked,
    ok: failures.length === 0,
    failures,
  };
  if (!report.ok) {
    throw new MigrationContinuityError(
      'import_integrity_mismatch',
      `the import manifests disagree with the landed rows — no silent data loss: ${failures
        .map((failure) => failure.failure)
        .join('; ')}`,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// THE READS
// ---------------------------------------------------------------------------

export async function getMigration(ctx: TenantContext, input: unknown): Promise<MigrationDetail> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateGetMigrationQuery(input);
  const row = await loadMigrationRow(ctx, valid.migrationId);
  const manifests = await getDb().query<ManifestRow>(
    `SELECT * FROM migration_import_manifests
       WHERE tenant_id = $1 AND migration_id = $2 ORDER BY batch_no`,
    [ctx.tenantId, row.id],
  );
  return {
    migration: mapMigration(row),
    batches: manifests.rows.map(mapManifest),
  };
}

export async function listMigrations(ctx: TenantContext, input: unknown): Promise<Migration[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListMigrationsQuery(input);
  const rows = await getDb().query<MigrationRow>(
    `SELECT * FROM migration_runs
       WHERE tenant_id = $1 ${valid.state === null ? '' : 'AND state = $2'}
       ORDER BY created_at DESC, id DESC LIMIT ${valid.limit}`,
    valid.state === null ? [ctx.tenantId] : [ctx.tenantId, valid.state],
  );
  return rows.rows.map(mapMigration);
}

export async function getMigrationStatus(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationStatusResult> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateGetMigrationQuery(input);
  const db = getDb();
  const row = await loadMigrationRow(ctx, valid.migrationId);

  const kinds = await db.query<{ entity_kind: string }>(
    `SELECT DISTINCT incumbent_kind AS entity_kind FROM migration_identity_mappings
        WHERE tenant_id = $1 AND migration_id = $2
      UNION SELECT DISTINCT entity_kind FROM migration_import_manifests
        WHERE tenant_id = $1 AND migration_id = $2 AND status = 'ok'`,
    [ctx.tenantId, row.id],
  );
  const authorityByKind: MigrationStatusResult['authorityByKind'] = [];
  const latestComparisons: MigrationStatusResult['latestComparisons'] = [];
  for (const kind of kinds.rows) {
    const window = await latestWindowFor(ctx, row.id, kind.entity_kind);
    const authority = authorityForKind({
      state: row.state,
      latestWindowStatus: window?.status ?? null,
    });
    authorityByKind.push({
      entityKind: kind.entity_kind,
      authority,
      since: authority === 'aurum' ? (window?.retired_at?.toISOString() ?? null) : null,
    });
    const report = await latestReportFor(ctx, row.id, kind.entity_kind);
    if (report !== null) {
      latestComparisons.push({
        entityKind: kind.entity_kind,
        clean: report.clean,
        matchedCount: report.matched_count,
        divergedCount: report.diverged_count,
        incumbentOnlyCount: report.incumbent_only_count,
        aurumOnlyCount: report.aurum_only_count,
        comparedAt: report.compared_at.toISOString(),
      });
    }
  }
  const openConflicts = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM migration_conflicts
       WHERE tenant_id = $1 AND migration_id = $2 AND status = 'open'`,
    [ctx.tenantId, row.id],
  );
  const windows = await db.query<WindowRow>(
    `SELECT * FROM migration_retirement_windows
       WHERE tenant_id = $1 AND migration_id = $2 ORDER BY entity_kind, sequence`,
    [ctx.tenantId, row.id],
  );
  return {
    migration: mapMigration(row),
    authorityByKind,
    openConflicts: Number(openConflicts.rows[0]?.count ?? 0),
    latestComparisons,
    retirementWindows: windows.rows.map(mapWindow),
  };
}

export async function authorityOf(ctx: TenantContext, input: unknown): Promise<AuthorityOfResult> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateCompareMigrationInput(input);
  const row = await loadMigrationRow(ctx, valid.migrationId);
  const window = await latestWindowFor(ctx, row.id, valid.entityKind);
  const authority = authorityForKind({
    state: row.state,
    latestWindowStatus: window?.status ?? null,
  });
  return {
    migrationId: row.id,
    entityKind: valid.entityKind,
    authority,
    since:
      authority === 'aurum'
        ? (window?.retired_at?.toISOString() ?? row.updated_at.toISOString())
        : null,
    basis: {
      state: row.state,
      latestWindowStatus: window?.status ?? null,
      latestWindowSequence: window?.sequence ?? null,
    },
  };
}

export async function listMigrationTransitions(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationTransition[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListTransitionsQuery(input);
  await loadMigrationRow(ctx, valid.migrationId);
  const rows = await getDb().query<TransitionRow>(
    `SELECT * FROM migration_transitions
       WHERE tenant_id = $1 AND migration_id = $2 ORDER BY position LIMIT ${valid.limit}`,
    [ctx.tenantId, valid.migrationId],
  );
  return rows.rows.map(mapTransition);
}

export async function listImportManifests(
  ctx: TenantContext,
  input: unknown,
): Promise<ImportManifest[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListManifestsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.migrationId !== null) {
    params.push(valid.migrationId);
    conditions.push(`migration_id = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  const rows = await getDb().query<ManifestRow>(
    `SELECT * FROM migration_import_manifests WHERE ${conditions.join(' AND ')}
       ORDER BY migration_id, batch_no LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapManifest);
}

export async function listIdentityMappings(
  ctx: TenantContext,
  input: unknown,
): Promise<IdentityMapping[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListMappingsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.migrationId !== null) {
    params.push(valid.migrationId);
    conditions.push(`migration_id = $${params.length}`);
  }
  if (valid.state !== null) {
    params.push(valid.state);
    conditions.push(`verification_state = $${params.length}`);
  }
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE ${conditions.join(' AND ')}
       ORDER BY mapped_at, id LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapMapping);
}

export async function getIdentityMapping(
  ctx: TenantContext,
  input: unknown,
): Promise<IdentityMapping> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateGetByIdQuery(input, 'mappingId');
  const rows = await getDb().query<MappingRow>(
    `SELECT * FROM migration_identity_mappings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.id],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new MigrationContinuityError(
      'mapping_not_found',
      `no identity mapping '${valid.id}' exists in this tenant`,
    );
  }
  return mapMapping(row);
}

export async function listSyncRuns(ctx: TenantContext, input: unknown): Promise<SyncRun[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListSyncRunsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.migrationId !== null) {
    params.push(valid.migrationId);
    conditions.push(`migration_id = $${params.length}`);
  }
  const rows = await getDb().query<SyncRunRow>(
    `SELECT * FROM migration_sync_runs WHERE ${conditions.join(' AND ')}
       ORDER BY sequence LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapSyncRun);
}

export async function listConflicts(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationConflict[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListConflictsQuery(input);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.migrationId !== null) {
    params.push(valid.migrationId);
    conditions.push(`migration_id = $${params.length}`);
  }
  if (valid.entityKind !== null) {
    params.push(valid.entityKind);
    conditions.push(`entity_kind = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  const rows = await getDb().query<ConflictRow>(
    `SELECT * FROM migration_conflicts WHERE ${conditions.join(' AND ')}
       ORDER BY detected_at, id LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapConflict);
}

export async function getConflict(ctx: TenantContext, input: unknown): Promise<MigrationConflict> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateGetByIdQuery(input, 'conflictId');
  const rows = await getDb().query<ConflictRow>(
    `SELECT * FROM migration_conflicts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.id],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new MigrationContinuityError(
      'conflict_not_found',
      `no conflict '${valid.id}' exists in this tenant`,
    );
  }
  return mapConflict(row);
}

export async function listComparisonReports(
  ctx: TenantContext,
  input: unknown,
): Promise<ComparisonReport[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListReportsQuery(input, 'entityKind');
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.migrationId !== null) {
    params.push(valid.migrationId);
    conditions.push(`migration_id = $${params.length}`);
  }
  if (valid.entityKind !== null) {
    params.push(valid.entityKind);
    conditions.push(`entity_kind = $${params.length}`);
  }
  const rows = await getDb().query<ReportRow>(
    `SELECT * FROM migration_comparison_reports WHERE ${conditions.join(' AND ')}
       ORDER BY compared_at, id LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapReport);
}

export async function listRetirementWindows(
  ctx: TenantContext,
  input: unknown,
): Promise<RetirementWindow[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListReportsQuery(input, 'entityKind');
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.migrationId !== null) {
    params.push(valid.migrationId);
    conditions.push(`migration_id = $${params.length}`);
  }
  if (valid.entityKind !== null) {
    params.push(valid.entityKind);
    conditions.push(`entity_kind = $${params.length}`);
  }
  const rows = await getDb().query<WindowRow>(
    `SELECT * FROM migration_retirement_windows WHERE ${conditions.join(' AND ')}
       ORDER BY entity_kind, sequence LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapWindow);
}

export async function listMigrationEvents(
  ctx: TenantContext,
  input: unknown,
): Promise<MigrationEvent[]> {
  assertMigrationContinuityTenantContext(ctx);
  const valid = validateListEventsQuery(input);
  await loadMigrationRow(ctx, valid.migrationId);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM migration_events
       WHERE tenant_id = $1 AND migration_id = $2
       ORDER BY recorded_at DESC, position DESC LIMIT ${valid.limit}`,
    [ctx.tenantId, valid.migrationId],
  );
  return rows.rows.map(mapEvent);
}
