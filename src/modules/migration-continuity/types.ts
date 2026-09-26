// Public domain types of the migration-continuity module (W094 —
// Migration and Dual-Run Continuity).
//
// W094 owns the migration LIFECYCLE and its records — nothing else:
//
//   "Import history, preserve identifiers, synchronize during migration,
//    compare legacy/Aurum results, support rollback and progressive
//    retirement."
//   Acceptance: "customer can run incumbent and Aurum in parallel;
//    conflicts are surfaced; rollback is possible; no silent data loss
//    or duplicate authority."
//
// Imported conversations / evidence / people become REAL rows in the
// owning modules' tables through their public contract writes
// (conversations.recordMessage, people.createPerson,
// observations.recordObservation); this module owns ONLY the migration
// records — the mapping, manifests, sync state, conflicts and
// comparisons below. Imported incumbent records map onto kit-declared
// entity kinds where a vertical kit is installed (W092); unmapped kinds
// stay raw evidence, never guessed semantics.
//
// The incumbent is reached through the REAL seams, never a private
// channel: it enters through the W081 discovery > recommendation >
// approval > connection chain, its broker connection is the W082
// connection (health + lifecycle read through the broker contract),
// every incumbent read and back-write executes through the W084
// DeepActionTransport port behind the W083 capability gate, and the
// legacy-vs-Aurum comparison REUSES the W084 reconcileOperation
// discipline verbatim (the W093 computer-use precedent — no second
// evidence model).
//
// Identifier preservation re-uses the unified-identity (W095)
// verification semantics: a mapping is `verified` or stays
// `unverified-external`; AMBIGUOUS mappings (multiple candidates or
// conflicting attributes) are NEVER auto-merged — they are surfaced for
// human resolution exactly like a W095 ambiguity.
//
// PROVIDER ISOLATION (lock 16): everything here is provider-neutral BY
// CONSTRUCTION. The incumbent appears only as the W081 inventory system
// id / plain-language descriptors, the OPAQUE W082 broker-connection id
// and opaque incumbent record ids/targets; the only incumbent-minted
// values on this surface are OPAQUE strings (receipt ids). Credential
// VALUES never appear here (the W082 discipline: the opaque
// credentialRef is re-read from the connection and passed straight
// through to the transport).

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/**
 * The migration lifecycle — a machine-readable state, not a batch job:
 *   * `staged`             — import planned, manifests drafted;
 *   * `imported`           — history landed through the real contracts;
 *   * `dual-running`       — incumbent and Aurum both live; sync and
 *                            comparison active; the INCUMBENT remains
 *                            the authority of record;
 *   * `retiring-incumbent` — progressive retirement windows open
 *                            (per entity kind);
 *   * `retired`            — every migrated kind's window completed;
 *                            Aurum holds authority.
 * Every transition is recorded as an evidence row and is REVERSIBLE
 * (rollback restores the previous state's authority surface and retains
 * the evidence trail).
 */
export type MigrationState =
  | 'staged'
  | 'imported'
  | 'dual-running'
  | 'retiring-incumbent'
  | 'retired';

/** Whether a lifecycle transition row moves the migration forward or back. */
export type MigrationTransitionKind = 'forward' | 'rollback';

/**
 * How one imported batch's entity kind was resolved onto Aurum's real
 * owning surfaces (the deterministic ladder — never guessed):
 *   * `conversation`  — landed as real conversation rows through the
 *     conversations contract (recordMessage per turn; the incumbent
 *     record must carry a canonical channel, direction, sender clock);
 *   * `person`        — landed as a real person row through the people
 *     contract (createPerson);
 *   * `kit-kind`      — a vertical kit installed for this tenant
 *     declares the entity kind (W092 manifest dataSchemaHints); the
 *     record lands as immutable evidence carrying the kit-declared kind;
 *   * `raw-evidence`  — no owning surface declares the kind: the record
 *     stays raw evidence (an observation with the incumbent kind
 *     preserved verbatim) — semantics are never guessed.
 */
export type MigrationEntityResolution =
  | 'conversation'
  | 'person'
  | 'kit-kind'
  | 'raw-evidence';

/** The import-integrity verdict of one manifest row. */
export type ImportManifestStatus = 'planned' | 'ok' | 'mismatch';

/**
 * The verification state of one cross-system identity mapping — the
 * W095 (unified-identity) semantics, re-used verbatim for migration
 * identifier preservation: `verified`, or `unverified-external` when the
 * mapping is ambiguous (multiple candidates / conflicting attributes).
 * AMBIGUOUS mappings are NEVER auto-merged.
 */
export type IdentityMappingState = 'verified' | 'unverified-external';

/** Why a mapping holds its verification state (machine-readable). */
export type IdentityMatchBasis =
  | 'import-created' // a fresh Aurum row was created for the incumbent record
  | 'sync-created' // a sync pass created the mapping for a new incumbent record
  | 'ambiguous-candidates' // multiple candidate organizational records — never merged
  | 'conflicting-attributes' // one candidate whose attributes disagree — never merged
  | 'human-resolution'; // an administrator resolved an ambiguity explicitly

/** The outcome of one dual-run sync pass ('running' = in flight / worker death). */
export type SyncRunStatus = 'running' | 'completed' | 'failed';

/**
 * The machine-readable conflict taxonomy of dual-run divergence — a
 * conflict is RECORDED with both versions, never auto-resolved:
 *   * `concurrent-update`  — the same logical record was touched on
 *     both sides since the last pass and the versions diverge;
 *   * `delete-vs-update`   — the incumbent deleted the record while
 *     Aurum's side advanced;
 *   * `back-write-refused` — the incumbent permanently refused an
 *     Aurum back-write (receipt 'rejected').
 */
export type MigrationConflictTaxonomy =
  | 'concurrent-update'
  | 'delete-vs-update'
  | 'back-write-refused';

/** The resolution state of a conflict row (humans resolve; the module never does). */
export type MigrationConflictStatus = 'open' | 'resolved';

/**
 * The progressive-retirement window of one entity kind: `open` while
 * the kind is being retired, `retired` when authority transferred to
 * Aurum, `rolled-back` when a rollback closed it without retirement
 * (incumbent authority restored). Rollback from `retired` re-opens the
 * window as a NEW row (the trail is retained).
 */
export type RetirementWindowStatus = 'open' | 'retired' | 'rolled-back';

/**
 * Which system is the authority of record for one entity kind — the
 * "no duplicate authority" invariant: exactly one at a time, and the
 * migration records say which.
 */
export type MigrationAuthority = 'incumbent' | 'aurum';

// ---------------------------------------------------------------------------
// The concrete task context (the W083/W084 shape, replayed onto gates)
// ---------------------------------------------------------------------------

/** The human-readable what-and-why of the migration, frozen at staging. */
export interface MigrationTaskContext {
  /** What the migration is, in plain organizational language (1..2000 chars). */
  description: string;
  /** Optional plain-language link to what the migration is for. */
  requestedFor?: string | null;
}

/** One drafted import batch of the staged plan. */
export interface ImportBatchPlan {
  /**
   * The OPAQUE incumbent export/collection target the batch reads
   * through the deep-action transport (e.g. an export path/segment).
   */
  target: string;
  /** The incumbent's own entity-kind label for the batch's records. */
  entityKind: string;
}

// ---------------------------------------------------------------------------
// Persisted records (all tenant-scoped)
// ---------------------------------------------------------------------------

/** One migration run — the durable state of the lifecycle. */
export interface Migration {
  id: string;
  tenantId: string;
  taskContext: MigrationTaskContext;
  /** The W081 Tool & System Inventory record of the incumbent system. */
  systemId: string;
  /** The incumbent's canonical W081 system key (plain-language). */
  systemKey: string;
  systemDisplayName: string;
  /** The OPAQUE W082 broker connection the whole migration rides. */
  connectionId: string;
  /** The READ capability every incumbent read invokes (W081/W083 key). */
  readCapabilityKey: string;
  /**
   * The WRITE capability back-writes invoke (W081/W083 key), or null
   * when the incumbent accepts no Aurum back-writes.
   */
  writeCapabilityKey: string | null;
  state: MigrationState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One append-only lifecycle transition (forward or rollback), with evidence. */
export interface MigrationTransition {
  id: string;
  tenantId: string;
  migrationId: string;
  /** Monotonic per-migration position (the ledger order). */
  position: number;
  kind: MigrationTransitionKind;
  /** Null only on the initial `staged` row. */
  fromState: MigrationState | null;
  toState: MigrationState;
  /** Why the transition happened (human-readable, 1..2000 chars). */
  reason: string;
  /** Machine-readable evidence of the transition (counts, windows, receipts). */
  evidence: Record<string, unknown>;
  recordedBy: string;
  recordedAt: string;
}

/**
 * One import batch manifest — the no-silent-data-loss record: entity
 * kind, counts in/out, content checksums, the contract write that
 * landed the batch, and the per-record landing ledger. A mismatch
 * between the manifest and the landed rows is a HARD failure surfaced
 * by this module's own probes.
 */
export interface ImportManifest {
  id: string;
  tenantId: string;
  migrationId: string;
  /** 1-based batch order (frozen at staging). */
  batchNo: number;
  /** The OPAQUE incumbent collection target the batch read. */
  target: string;
  /** The incumbent's own entity-kind label. */
  entityKind: string;
  /** How the kind resolved onto Aurum's real owning surfaces. */
  resolution: MigrationEntityResolution | null;
  /** The installed kit that declared the kind (resolution 'kit-kind' only). */
  kitKey: string | null;
  /** The kit-declared entity (resolution 'kit-kind' only). */
  kitEntity: string | null;
  /** The owning contract write that landed the batch (plain-language). */
  contractWrite: string | null;
  /** Records read from the incumbent through the transport. */
  expectedCount: number;
  /** Records landed through the owning contract writes. */
  landedCount: number;
  /** sha-256 of the canonical JSON of the records as read. */
  sourceChecksum: string | null;
  /** sha-256 of the canonical JSON of the landed rows (read back). */
  landedChecksum: string | null;
  /** The per-record landing ledger: {incumbentId, aurumId, aurumKind}. */
  landedRecords: { incumbentId: string; aurumId: string; aurumKind: string }[];
  status: ImportManifestStatus;
  /** Failure detail (status 'mismatch' only). */
  detail: string | null;
  importedAt: string | null;
}

/**
 * One durable cross-system identity mapping (incumbent id <-> Aurum id)
 * with provenance and a verification state — the W095 discipline:
 * ambiguous mappings stay `unverified-external` and NEVER merge
 * silently.
 */
export interface IdentityMapping {
  id: string;
  tenantId: string;
  migrationId: string;
  /** The incumbent's own record id (opaque string). */
  incumbentId: string;
  /** The incumbent's entity kind for the record. */
  incumbentKind: string;
  /** The Aurum row the record landed as (null while ambiguous/unmerged). */
  aurumId: string | null;
  /** The Aurum row kind: conversation | person | observation. */
  aurumKind: string | null;
  /** The current Aurum view of the logical record (may supersede aurumId's row). */
  currentAurumId: string | null;
  verificationState: IdentityMappingState;
  matchBasis: IdentityMatchBasis;
  /** Candidate organizational records when ambiguous (never auto-merged). */
  candidates: { incumbentId: string; aurumId: string | null }[];
  /** Provenance: {attributes, batchNo, resolvedBy, resolutionNote, ...}. */
  provenance: Record<string, unknown>;
  /** Checkpoint: sha-256 of the canonical incumbent version last synced. */
  lastIncumbentChecksum: string | null;
  /** Checkpoint: sha-256 of the canonical Aurum version last synced. */
  lastAurumChecksum: string | null;
  mappedAt: string;
  updatedAt: string;
}

/** One dual-run sync pass — counts and honest back-write outcomes. */
export interface SyncRun {
  id: string;
  tenantId: string;
  migrationId: string;
  /** 1-based per-migration sequence. */
  sequence: number;
  recordsRead: number;
  recordsLanded: number;
  backWritesAttempted: number;
  backWritesAccepted: number;
  /** Permanent refusals — surfaced as conflict rows. */
  backWritesRefused: number;
  /** Transient failures (receipt 'failed') — retried by the next pass. */
  backWritesFailed: number;
  /** Blocked by the W083 gate or a missing write capability (governance, surfaced). */
  backWritesBlocked: number;
  conflictsDetected: number;
  status: SyncRunStatus;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * One surfaced dual-run conflict — BOTH versions, timestamps and
 * provenance, a machine-readable taxonomy, and the W084 reconciliation
 * diff between the two versions. NEVER auto-resolved: the row stays
 * open until a human resolves it.
 */
export interface MigrationConflict {
  id: string;
  tenantId: string;
  migrationId: string;
  entityKind: string;
  incumbentId: string;
  aurumId: string | null;
  taxonomy: MigrationConflictTaxonomy;
  /** The incumbent's current canonical version (null on delete). */
  incumbentVersion: Record<string, unknown> | null;
  /** Aurum's current canonical version. */
  aurumVersion: Record<string, unknown> | null;
  /** The incumbent's own clock for its version. */
  incumbentUpdatedAt: string | null;
  /** The Aurum row's service clock for its version. */
  aurumUpdatedAt: string | null;
  /** Provenance of both versions: {incumbent: {...}, aurum: {...}}. */
  provenance: Record<string, unknown>;
  /** The W084 reconcileOperation diff (aurum view as expectation vs incumbent). */
  reconciliation: Record<string, unknown> | null;
  resolution: 'none' | 'incumbent' | 'aurum';
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  status: MigrationConflictStatus;
  detectedInSyncRun: string | null;
  detectedAt: string;
}

/** The per-record comparison outcome rows (machine-readable, W084-shaped). */
export interface ComparisonOutcomeRow {
  incumbentId: string;
  aurumId: string | null;
  outcome: 'matched' | 'diverged' | 'incumbent-only' | 'aurum-only';
  /**
   * The W084 reconcileOperation verdict VERBATIM ({matched, mismatches,
   * stateUnchanged}) — null for incumbent-only/aurum-only rows.
   */
  reconciliation: Record<string, unknown> | null;
}

/**
 * One durable comparison report for one entity kind — the retirement
 * decision's input. Built on the W084 reconcileOperation discipline
 * (expectations vs verified observations), never a second model.
 */
export interface ComparisonReport {
  id: string;
  tenantId: string;
  migrationId: string;
  entityKind: string;
  matchedCount: number;
  divergedCount: number;
  incumbentOnlyCount: number;
  aurumOnlyCount: number;
  /** True exactly when nothing diverged and neither side holds orphans. */
  clean: boolean;
  outcomes: ComparisonOutcomeRow[];
  comparedAt: string;
}

/** One progressive-retirement window of one entity kind. */
export interface RetirementWindow {
  id: string;
  tenantId: string;
  migrationId: string;
  entityKind: string;
  /** 1-based per-(migration, kind) sequence — rollback re-opens as a new row. */
  sequence: number;
  status: RetirementWindowStatus;
  /** The comparison report that gated the retirement (or the re-open). */
  closedWithReportId: string | null;
  openedAt: string;
  openedBy: string;
  retiredAt: string | null;
}

/** One append-only lifecycle event of a migration. */
export interface MigrationEvent {
  id: string;
  tenantId: string;
  migrationId: string;
  /** Monotonic per-migration position (deterministic audit order). */
  position: number;
  event: MigrationEventType;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** The append-only lifecycle event vocabulary. */
export type MigrationEventType =
  | 'staged'
  | 'imported'
  | 'import-mismatch'
  | 'dual-run-started'
  | 'sync-completed'
  | 'conflict-detected'
  | 'conflict-resolved'
  | 'back-write-blocked'
  | 'comparison-recorded'
  | 'retirement-window-opened'
  | 'kind-retired'
  | 'authority-transferred'
  | 'rollback'
  | 'retired'
  | 'mapping-ambiguity-resolved';

// ---------------------------------------------------------------------------
// Inputs and queries
// ---------------------------------------------------------------------------

/** Input of `stageMigration`. */
export interface StageMigrationInput {
  /** The W081 inventory record of the incumbent system (tenant-scoped). */
  systemId: string;
  /** The W082 broker connection to the incumbent (must be connected). */
  connectionId: string;
  /** The READ capability incumbent reads invoke (must exist on the W081 surface). */
  readCapabilityKey: string;
  /** The WRITE capability back-writes invoke, or null when the incumbent takes none. */
  writeCapabilityKey?: string | null;
  taskContext: MigrationTaskContext;
  /** 1..32 drafted batches (targets + entity kinds). */
  batches: ImportBatchPlan[];
  /** Caller-supplied dedupe key; a recorded key replays the original migration. */
  idempotencyKey?: string | null;
}

/** The full staged view: the migration and its drafted manifest rows. */
export interface MigrationDetail {
  migration: Migration;
  batches: ImportManifest[];
}

/** Input of `runImport` / `startDualRun` / `runSyncPass`. */
export interface MigrationTargetInput {
  migrationId: string;
}

/** Input of `compareMigration` (one entity kind per report). */
export interface CompareMigrationInput {
  migrationId: string;
  entityKind: string;
}

/** Input of the retirement operations (per entity kind). */
export interface RetirementKindInput {
  migrationId: string;
  entityKind: string;
}

/** Input of `rollbackMigration` (claim-gated — a consequential trust operation). */
export interface RollbackMigrationInput {
  migrationId: string;
  /** Why the rollback happened (1..2000 chars — the evidence row's reason). */
  reason: string;
}

/**
 * Input of `resolveMappingAmbiguity` (claim-gated): the human decision
 * that one ambiguous incumbent record IS a chosen Aurum record. Never
 * performed automatically.
 */
export interface ResolveMappingAmbiguityInput {
  mappingId: string;
  /** The Aurum record the human verified as the same organizational entity. */
  aurumId: string;
  note: string;
}

/**
 * Input of `resolveConflict` (claim-gated): the human decision of which
 * side wins. The decision is RECORDED — neither system's data is
 * rewritten by this module (the owning modules are append-only; the
 * operators act through their own flows).
 */
export interface ResolveConflictInput {
  conflictId: string;
  resolution: 'incumbent' | 'aurum';
  note: string;
}

/** The derived authority answer of `authorityOf`. */
export interface AuthorityOfResult {
  migrationId: string;
  entityKind: string;
  authority: MigrationAuthority;
  /** When the current authority took hold (window retiredAt / migration created). */
  since: string | null;
  /** Machine-readable basis: {state, latestWindowStatus}. */
  basis: Record<string, unknown>;
}

/** The assembled status view of `getMigrationStatus`. */
export interface MigrationStatusResult {
  migration: Migration;
  /** Per entity kind: which system is the authority of record (derived). */
  authorityByKind: { entityKind: string; authority: MigrationAuthority; since: string | null }[];
  openConflicts: number;
  latestComparisons: {
    entityKind: string;
    clean: boolean;
    matchedCount: number;
    divergedCount: number;
    incumbentOnlyCount: number;
    aurumOnlyCount: number;
    comparedAt: string;
  }[];
  retirementWindows: RetirementWindow[];
}

/** The honest integrity report of `verifyImportIntegrity`. */
export interface ImportIntegrityReport {
  migrationId: string;
  manifestsChecked: number;
  landedRecordsChecked: number;
  ok: boolean;
  failures: { manifestId: string; batchNo: number; failure: string }[];
}

/** Query shapes of the reads. */
export interface GetMigrationQuery {
  migrationId: string;
}

export interface ListMigrationsQuery {
  state?: MigrationState;
  limit?: number;
}

export interface ListMigrationTransitionsQuery {
  migrationId: string;
  limit?: number;
}

export interface ListImportManifestsQuery {
  migrationId?: string;
  status?: ImportManifestStatus;
  limit?: number;
}

export interface ListIdentityMappingsQuery {
  migrationId?: string;
  state?: IdentityMappingState;
  limit?: number;
}

export interface GetIdentityMappingQuery {
  mappingId: string;
}

export interface ListSyncRunsQuery {
  migrationId?: string;
  limit?: number;
}

export interface ListConflictsQuery {
  migrationId?: string;
  entityKind?: string;
  status?: MigrationConflictStatus;
  limit?: number;
}

export interface GetConflictQuery {
  conflictId: string;
}

export interface ListComparisonReportsQuery {
  migrationId?: string;
  entityKind?: string;
  limit?: number;
}

export interface ListRetirementWindowsQuery {
  migrationId?: string;
  entityKind?: string;
  limit?: number;
}

export interface ListMigrationEventsQuery {
  migrationId: string;
  limit?: number;
}
