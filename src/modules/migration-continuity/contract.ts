// ============================================================================
// migration-continuity — the ONLY public surface of the
// migration-continuity module (IMPLEMENTATION-STACK §2; cross-module
// imports of anything else are architecture violations detected by
// scripts/check-architecture.ts).
//
// W094 — Migration and Dual-Run Continuity:
// "Import history, preserve identifiers, synchronize during migration,
//  compare legacy/Aurum results, support rollback and progressive
//  retirement."
// Acceptance: "customer can run incumbent and Aurum in parallel;
// conflicts are surfaced; rollback is possible; no silent data loss
// or duplicate authority."
//
//   THE LIFECYCLE (each phase an explicit, bounded, tenant-scoped call;
//   every transition recorded and REVERSIBLE):
//     stageMigration        — the incumbent enters through the REAL
//        seams: the W081 inventory system (validated live: the staged
//        capability keys must exist on its surface) and the W082 broker
//        connection (must be 'connected'); the import plan's batch
//        targets + entity kinds draft the manifests. Idempotent by
//        caller key.
//     runImport             — history lands through the REAL contracts:
//        every batch is read through the W084 deep-action transport
//        port (W083-gated) and landed through the OWNING modules'
//        public writes (conversations.createConversation/recordMessage,
//        people.createPerson, observations.recordObservation — kit-
//        declared kinds map onto installed W092 kits, unmapped kinds
//        stay raw evidence, never guessed). Each manifest records
//        counts in/out, content checksums (of what was read AND of what
//        landed, read back through the contracts), the contract write
//        and the per-record landing ledger; a count mismatch is a HARD
//        failure (`import_integrity_mismatch`).
//     startDualRun          — incumbent and Aurum run in parallel; the
//        INCUMBENT remains the authority of record.
//     runSyncPass           — one dual-run sync pass: incumbent
//        collections pulled through the transport, new records landed,
//        the same logical record touched on BOTH sides recorded as a
//        CONFLICT (both versions, timestamps, provenance, the
//        machine-readable taxonomy, the W084 reconciliation diff —
//        NEVER auto-resolved), and Aurum-side advances back-written
//        where the incumbent accepts them (W083-gated; a refused
//        back-write is itself a surfaced conflict).
//     compareMigration      — the legacy-vs-Aurum comparison per entity
//        kind, built ON the W084 reconcileOperation (expectations vs
//        verified observations — no second evidence model): durable
//        per-kind report rows (matched / diverged / incumbent-only /
//        aurum-only) the retirement decision reads.
//     openRetirementWindow / completeRetirement — progressive
//        retirement PER ENTITY KIND: a kind retires only when its
//        latest comparison report is clean AND its conflict queue is
//        empty; authority transfers to Aurum exactly at the completed
//        window (the "no duplicate authority" invariant).
//     rollbackMigration     — reverse the last transition from ANY
//        state (claim-gated): restores the previous state's authority
//        surface (open windows roll back; a retired window re-opens as
//        a NEW row) and RETAINS the full evidence trail.
//
//   THE READS
//     getMigration / listMigrations / getMigrationStatus (the derived
//     per-kind authority map) / authorityOf — the reads
//     listMigrationTransitions — the append-only transition ledger
//        (forward AND rollback, each with machine-readable evidence)
//     listImportManifests / verifyImportIntegrity — the manifests and
//        the integrity probe (manifest-vs-landed re-derivation: counts
//        AND per-record readability through the owning contracts; any
//        disagreement is the hard `import_integrity_mismatch`)
//     listIdentityMappings / getIdentityMapping — the durable
//        cross-system identity map (incumbent id <-> Aurum id) with
//        provenance and verification state
//     listSyncRuns / listConflicts / getConflict / listComparisonReports
//        / listRetirementWindows / listMigrationEvents — the sync,
//        conflict, comparison, retirement and audit feeds.
//
//   THE TRUST OPERATIONS (claim-gated, never automatic)
//     resolveMappingAmbiguity — the human decision that one AMBIGUOUS
//        incumbent record IS a chosen Aurum record (the W095
//        resolveUnifiedAmbiguity precedent: ambiguous mappings stay
//        `unverified-external` and NEVER merge silently).
//     resolveConflict — the human decision of which side wins a
//        surfaced conflict; the decision is RECORDED, never applied
//        automatically to either system's data.
//     rollbackMigration — a consequential authority restoration; gated
//        on 'migration-continuity:administer' and audited like every
//        other transition.
//
//   THE DETERMINISTIC INCUMBENT DOUBLE (test-side — the fixtures/
//   doubles doctrine; the W096 ScriptedDeepActionTransport pattern)
//     createScriptedIncumbent — an in-memory incumbent system of
//   record behind the W084 transport port: collection targets served
//   as {records} states, idempotency-honoring back-writes with OPAQUE
//   receipts, scriptable refusal/transient failure, and scripted
//   evolution (upsert/mutate/delete between passes). NO live network.
//
// There is deliberately NO operation that auto-resolves a conflict,
// auto-merges an ambiguous identity, erases a transition, an event, a
// manifest or a comparison report, or transfers authority outside a
// completed retirement window: conflicts and ambiguities are
// first-class surfaced outcomes, history is immutable, and authority
// moves only through the recorded lifecycle (lock 14 mirrored).
//
// PROVIDER ISOLATION (lock 16): everything exported below is
// provider-neutral BY CONSTRUCTION. The incumbent appears only as the
// W081 system id + plain-language descriptors, the OPAQUE W082
// broker-connection id and opaque incumbent record ids/targets; the
// only incumbent-minted values on this surface are OPAQUE strings
// (back-write receipt ids in conflict provenance). Credential VALUES
// never appear here — the opaque credentialRef is re-read from the
// broker connection each pass and passes straight through to the
// transport (the W082 discipline).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's migrations,
// manifests, mappings, sync runs, conflicts, reports, windows or
// events are indistinguishable from missing (`migration_not_found` /
// `mapping_not_found` / `conflict_not_found`) — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W094 ← W081, W082, W084,
// W088, W092): this module imports ONLY module contracts —
// integration-intelligence (the incumbent's inventory surface),
// connection-broker (the broker connection the migration rides),
// deep-actions (the DeepActionTransport port + the reconcileOperation
// discipline, re-used VERBATIM), capability-grants (the W083 gate
// every incumbent read and back-write invokes), vertical-kits (the
// installed kits' declared entity kinds), conversations / people /
// observations (the owning modules whose public writes land imported
// history), identity (the canonical channel vocabulary conversation
// records must carry) and unified-identity (the W095 verification
// semantics the identity-mapping states re-use). On-prem incumbents
// are reached by wiring `createEdgeDeepActionTransport` (W088) into
// the deep-actions transport port — the SAME adapters, never a fork.
// ============================================================================

export {
  // the lifecycle
  stageMigration,
  runImport,
  startDualRun,
  runSyncPass,
  compareMigration,
  openRetirementWindow,
  completeRetirement,
  rollbackMigration,
  // the trust operations (claim-gated, never automatic)
  resolveMappingAmbiguity,
  resolveConflict,
  // the reads
  getMigration,
  listMigrations,
  getMigrationStatus,
  authorityOf,
  listMigrationTransitions,
  listImportManifests,
  verifyImportIntegrity,
  listIdentityMappings,
  getIdentityMapping,
  listSyncRuns,
  listConflicts,
  getConflict,
  listComparisonReports,
  listRetirementWindows,
  listMigrationEvents,
  // module-owned constants (the authority claim, the observation kinds)
  MIGRATION_CONTINUITY_AUTHORITY_ADMINISTER,
  RAW_EVIDENCE_OBSERVATION_KIND,
  KIT_EVIDENCE_OBSERVATION_KIND_PREFIX,
  SYNC_UPDATE_OBSERVATION_KIND,
} from './service';

export { MigrationContinuityError } from './errors';
export type { MigrationContinuityErrorCode } from './errors';

// The W084 reconciliation, re-used VERBATIM — the module's comparison
// IS the deep-actions reconciliation applied to incumbent-vs-Aurum
// versions (no second evidence model; exported for tests and
// downstream surfaces exactly as deep-actions and computer-use export
// their pure helpers).
export {
  reconcileOperation,
  type OperationReconciliation,
  type StateMismatch,
} from '@/modules/deep-actions/contract';

// The pure lifecycle state machine (usable without a database): the
// canonical states, every legal forward AND rollback transition, and
// the DERIVED authority rule (the "no duplicate authority" invariant).
export {
  MIGRATION_STATES,
  MIGRATION_TRANSITIONS,
  INITIAL_MIGRATION_STATE,
  authorityForKind,
  availableMigrationTransitions,
  canTransitionMigration,
  isDualRunActive,
  isMigrationState,
  rollbackTargetOf,
} from './lifecycle';

// The pure canonical-JSON + checksum surface (the vertical-kits
// digest precedent — the manifests' no-silent-data-loss material).
export { canonicalMigrationJson, checksumOf, isChecksum } from './digest';

// The deterministic incumbent double (the fixture — NO live network;
// the W096/W093 first-party-doubles precedent, exported through the
// contract).
export {
  createScriptedIncumbent,
  type ScriptedIncumbent,
  type ScriptedIncumbentOptions,
  type ScriptedIncumbentRecord,
} from './double';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_LIST_LIMIT,
  IDENTITY_MAPPING_STATES,
  IDENTITY_MATCH_BASES,
  IMPORT_MANIFEST_STATUSES,
  MAX_BATCHES,
  MAX_ENTITY_KIND_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_INCUMBENT_ID_LENGTH,
  MAX_LIST_LIMIT,
  MAX_RECORDS_PER_BATCH,
  MAX_TARGET_LENGTH,
  MAX_VALUE_BYTES,
  MIGRATION_CONFLICT_STATUSES,
  MIGRATION_CONFLICT_TAXONOMIES,
  MIGRATION_EVENT_TYPES,
  MIGRATION_TRANSITION_KINDS,
  REUSED_UNIFIED_IDENTITY_STATUSES,
  RETIREMENT_WINDOW_STATUSES,
  SYNC_RUN_STATUSES,
  assertMigrationContinuityTenantContext,
  isIdentityMappingState,
  isImportManifestStatus,
  isMigrationConflictStatus,
  isMigrationConflictTaxonomy,
  isMigrationEventType,
  isMigrationTransitionKind,
  isRetirementWindowStatus,
  isSyncRunStatus,
  isUuid,
  parseConversationRecord,
  parsePersonRecord,
} from './validation';

export type {
  ValidatedStageInput,
  ValidatedTaskContext,
  ValidatedBatchPlan,
} from './validation';

export type {
  AuthorityOfResult,
  ComparisonOutcomeRow,
  ComparisonReport,
  IdentityMapping,
  IdentityMappingState,
  IdentityMatchBasis,
  ImportBatchPlan,
  ImportIntegrityReport,
  ImportManifest,
  ImportManifestStatus,
  Migration,
  MigrationAuthority,
  MigrationConflict,
  MigrationConflictStatus,
  MigrationConflictTaxonomy,
  MigrationDetail,
  MigrationEntityResolution,
  MigrationEvent,
  MigrationEventType,
  MigrationState,
  MigrationStatusResult,
  MigrationTaskContext,
  MigrationTransition,
  MigrationTransitionKind,
  RetirementWindow,
  RetirementWindowStatus,
  SyncRun,
  SyncRunStatus,
} from './types';
export type {
  CompareMigrationInput,
  GetConflictQuery,
  GetIdentityMappingQuery,
  GetMigrationQuery,
  IdentityMappingState as IdentityMappingStateFilter,
  ImportManifestStatus as ImportManifestStatusFilter,
  ListConflictsQuery,
  ListComparisonReportsQuery,
  ListIdentityMappingsQuery,
  ListImportManifestsQuery,
  ListMigrationEventsQuery,
  ListMigrationTransitionsQuery,
  ListMigrationsQuery,
  ListRetirementWindowsQuery,
  ListSyncRunsQuery,
  MigrationConflictStatus as MigrationConflictStatusFilter,
  MigrationTargetInput,
  ResolveConflictInput,
  ResolveMappingAmbiguityInput,
  RetirementKindInput,
  RollbackMigrationInput,
  StageMigrationInput,
} from './types';
