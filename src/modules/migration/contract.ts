// ============================================================================
// migration — the ONLY public surface of the migration module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W094 — Migration and Dual-Run Continuity:
// "Import history, preserve identifiers, synchronize during migration,
//  compare legacy/Aurum results, support rollback and progressive
//  retirement."
// Acceptance: "customer can run incumbent and Aurum in parallel;
// conflicts are surfaced; rollback is possible; no silent data loss or
// duplicate authority."
//
//   THE MIGRATION LIFECYCLE (claim-gated creation)
//     createMigration — freeze the incumbent relationship: the W081
//        Tool & System Inventory system (its read capability must be on
//        the live surface), the CONNECTED W082 broker connection the
//        reads ride (the opaque credentialRef discipline — loaded live,
//        passed straight through, never stored), and the optional W092
//        vertical-kit binding (an active installation + a declared
//        integration — the industry-shaped incumbent surface whose
//        schema hints drive the transform). One LIVE migration per
//        incumbent system; an identical live migration replays
//        idempotently.
//
//   THE STAGED IMPORT ROUNDS (snapshot → transform → staged → review →
//   commit — each phase an explicit, bounded, tenant-scoped call)
//     captureSnapshot — read the incumbent's current (or changed-since)
//        records through the wired incumbent reader port; every record
//        lands as an EVIDENCE-shaped row carrying its full provenance
//        (source system, external id, match key, round, snapshot
//        reference). A full round re-baselines; a delta round reads what
//        changed since the last COMMITTED round (an abandoned round
//        never becomes a delta base — its window is re-read; no silent
//        data loss). One open round at a time.
//     transformImportRound — the deterministic validation pass: records
//        become staged, with the kit's schema-hint findings SURFACED as
//        per-record issues (never dropped, never rewritten).
//     reviewImportRound — the human gate (claim 'migration:review') that
//        must pass before anything links.
//     commitImportRound — link the identifiers (claim
//        'migration:administer'): the external↔Aurum map is established
//        per record; collisions surface EXPLICIT conflict records
//        (cross-system collisions and ambiguous multi-entity matches are
//        never auto-merged — the W095 rule applied to migration); each
//        staged record is optionally re-read through the wired
//        VERIFICATION TRANSPORT (the W084/W088 composition) and any
//        divergence is surfaced on the round and in the audit, never
//        silently fixed.
//     abandonImportRound — the explicit dead end (the records stay as
//        evidence; the window is re-read by the next round).
//
//   IDENTIFIER PRESERVATION + CONFLICT RESOLUTION
//     resolveExternalId — the live map lookup (per source system;
//        sequestered migrations' entries are excluded, retired ones stay
//        live — identifiers are preserved forever).
//     listIdentifierMappings / listCurrentImportedStates — the dual-run
//        views (provenance-tagged imported state, never authority).
//     resolveIdentityConflict — the explicit human identity decision
//        (claim 'migration:administer'): the chosen Aurum entity links
//        the conflicted external id; the decision is audited.
//
//   THE DUAL-RUN COMPARISON (import + compare — never a second action
//   pipeline)
//     runComparisonRound — evaluate the same question against
//        incumbent-imported state and native Aurum state (through the
//        wired native-state reader port): one structured entry per
//        entity (agreements, divergences with enumerated value
//        mismatches and one-sided fields, native-missing,
//        incumbent-deleted, incumbent-missing) plus deterministic
//        reasons. The comparison semantics are the W084 reconciliation's
//        own (compare.ts reuses reconcileOperation through this
//        dependency's contract — one comparison model, no fork).
//        Divergences are surfaced, never reconciled silently. The module
//        exposes NO write path to the incumbent: dual-run writes a
//        customer configures ride the EXISTING deep-action path (W084).
//
//   THE RETIREMENT CHECKPOINTS (progressive, evidence-linked, auditable)
//     advanceToCompareClean — dual-running → compare-clean, requiring a
//        completed comparison round with ZERO divergences (its id is
//        frozen on the migration as the evidence link).
//     advanceToIncumbentReadOnly — compare-clean → incumbent-read-only
//        (the operator's assertion, justified by the frozen evidence).
//     retireIncumbent — incumbent-read-only → incumbent-retired
//        (terminal; re-checks that the LATEST comparison round is still
//        clean). The identifier map stays live after retirement.
//
//   ROLLBACK (sequestration — quarantine, never deletion)
//     sequesterMigration — claim-gated rollback: the migration's
//        committed imports are logically quarantined — retained for
//        audit, EXCLUDED from live queries (derived from the migration's
//        status; the rows are untouched), open rounds force-abandoned.
//        Native Aurum data is never touched (the module owns only its
//        own tables and holds no write path into any other module);
//        evidence is never deleted.
//
//   THE READS
//     getMigration / listMigrations / getImportRound / listImportRounds /
//     listImportedRecords (includeSequestered = the audit view) /
//     listIdentifierMappings / getIdentityConflict /
//     listIdentityConflicts / getComparisonRound / listComparisonRounds /
//     listMigrationEvents — every surface tenant-scoped.
//
//   THE PORTS (infrastructure wiring, not domain state)
//     setMigrationIncumbentReader / getMigrationIncumbentReader — the
//        import path's read-only seam. Nothing wired by default:
//        captureSnapshot fails explicitly (`reader_unavailable`) rather
//        than faking a snapshot. The shipped FIXTURE INCUMBENT
//        (fixture-incumbent.ts — versioned snapshots, deterministic
//        churn, seeded divergences) is the deterministic double; REAL
//        incumbent readers are environment-dependent adapters.
//     setMigrationNativeReader / getMigrationNativeReader — the
//        comparison's Aurum side; nothing wired by default
//        (`native_reader_unavailable`).
//     setMigrationVerificationTransport / getMigrationVerificationTransport
//        — the W084/W088 composition: any DeepActionTransport (the
//        deep-actions contract's own port — edge-backed for private/
//        on-prem incumbents via the edge-connector's factory,
//        broker-backed for SaaS) verifies staged records at commit. Only
//        its INSPECT side is ever invoked — Aurum never writes back to
//        the incumbent through this module.
//
// There is deliberately NO operation that queries the incumbent as
// authority, writes incumbent state into another module's tables, or
// un-sequesters a migration: the incumbent exists here only as
// provenance-tagged imported records and the identifier map (no
// duplicate authority), and rollback's quarantine is terminal — a fresh
// migration for the same system is the roll-forward path (its map
// entries are minted fresh; the sequestered ones remain as audit).
//
// PROVIDER ISOLATION (lock 16): everything exported below is
// provider-neutral BY CONSTRUCTION. The incumbent appears only as the
// W081 plain-language system descriptor and the OPAQUE broker-connection
// id (W082); the only incumbent-minted values on this surface are OPAQUE
// strings (external record ids, snapshot references). Credential VALUES
// never appear here (the W082 discipline: the opaque credentialRef
// passes straight through to the wired reader / verification transport).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's migrations,
// rounds, records, map entries, conflicts, comparison reports or events
// are indistinguishable from missing (`migration_not_found` /
// `round_not_found` / `conflict_not_found` / `comparison_not_found`) —
// no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W094 ← W081, W082, W084, W088,
// W092): this module imports ONLY module contracts —
// integration-intelligence (the W081 inventory surface),
// connection-broker (the W082 connection records + credentialRef
// discipline), deep-actions (the W084 reconciliation semantics reused by
// the comparison + the DeepActionTransport port the verification path
// composes) and vertical-kits (the W092 kit installations and manifests
// the binding validates against). The Edge Connector (W088) is composed
// at the transport seam: any edge-minted DeepActionTransport plugs into
// setMigrationVerificationTransport — the module's tests exercise that
// composition with the edge-connector contract's own deterministic
// doubles (no live incumbent system in the suite).
// ============================================================================

export {
  // the migration lifecycle
  createMigration,
  // the staged import rounds
  captureSnapshot,
  transformImportRound,
  reviewImportRound,
  commitImportRound,
  abandonImportRound,
  // identifier preservation + conflict resolution
  resolveExternalId,
  resolveIdentityConflict,
  // the dual-run comparison
  runComparisonRound,
  // the retirement checkpoints
  advanceToCompareClean,
  advanceToIncumbentReadOnly,
  retireIncumbent,
  // rollback (sequestration)
  sequesterMigration,
  // the reads
  getMigration,
  listMigrations,
  getImportRound,
  listImportRounds,
  listImportedRecords,
  listIdentifierMappings,
  getIdentityConflict,
  listIdentityConflicts,
  getComparisonRound,
  listComparisonRounds,
  listMigrationEvents,
  listCurrentImportedStates,
  // the port wiring (infrastructure, not domain state)
  setMigrationIncumbentReader,
  getMigrationIncumbentReader,
  setMigrationNativeReader,
  getMigrationNativeReader,
  setMigrationVerificationTransport,
  getMigrationVerificationTransport,
} from './service';

export { MigrationError } from './errors';
export type { MigrationErrorCode } from './errors';

// Module-owned constants (the authority claims).
export { MIGRATION_AUTHORITY_ADMINISTER, MIGRATION_AUTHORITY_REVIEW } from './service';

// The deterministic incumbent + native doubles (the W082 adapter /
// computer-use scripted-driver precedent: first-party doubles are
// exported through the contract; NO live incumbent system in the suite).
export {
  FixtureIncumbent,
  FixtureNativeStore,
} from './fixture-incumbent';
export type {
  FixtureChurn,
  FixtureIncumbentEntity,
  FixtureNativeDivergence,
} from './fixture-incumbent';

// The pure deterministic surface (unit-tested; exported for tests and
// downstream surfaces — lock 10: comparison is a computation, not an
// opinion).
export {
  buildDivergenceReason,
  buildIncumbentMissingReason,
  compareEntity,
  detectSchemaHintIssues,
  jsonDeepEqual,
} from './compare';
export type { EntityComparison, KitSchemaHintLike } from './compare';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_LIST_LIMIT,
  IDENTITY_CONFLICT_KINDS,
  IDENTITY_CONFLICT_STATUSES,
  IMPORT_ROUND_KINDS,
  IMPORT_ROUND_STATUSES,
  IMPORTED_RECORD_DISPOSITIONS,
  IMPORTED_RECORD_STATES,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_ENTITY_ID_LENGTH,
  MAX_ENTITY_TYPE_LENGTH,
  MAX_EXTERNAL_ID_LENGTH,
  MAX_KIT_INTEGRATION_KEY_LENGTH,
  MAX_KIT_KEY_LENGTH,
  MAX_KIT_VERSION_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MATCH_KEY_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_ROUND_RECORDS,
  MAX_SNAPSHOT_REF_LENGTH,
  MAX_SYSTEM_KEY_LENGTH,
  MAX_VALUE_BYTES,
  MIGRATION_EVENT_TYPES,
  MIGRATION_STATUSES,
  MIN_SYSTEM_KEY_LENGTH,
  ROUND_VERIFICATIONS,
  assertMigrationTenantContext,
  canonicalizeIncumbentRecord,
  canonicalizeNativeStates,
  canonicalizeSnapshotResult,
  isIdentityConflictKind,
  isIdentityConflictStatus,
  isImportRoundKind,
  isImportRoundStatus,
  isImportedRecordDisposition,
  isImportedRecordState,
  isMigrationEventType,
  isMigrationStatus,
  isRoundVerification,
  isStrictIsoTimestamp,
  isUuid,
} from './validation';

export type {
  ValidatedCaptureSnapshotInput,
  ValidatedCreateInput,
  ValidatedConflictIdQuery,
  ValidatedComparisonIdQuery,
  ValidatedGetQuery,
  ValidatedListComparisonsQuery,
  ValidatedListConflictsQuery,
  ValidatedListCurrentStatesQuery,
  ValidatedListEventsQuery,
  ValidatedListMappingsQuery,
  ValidatedListMigrationsQuery,
  ValidatedListRecordsQuery,
  ValidatedListRoundsQuery,
  ValidatedMigrationIdInput,
  ValidatedNativeStateReadResult,
  ValidatedResolveConflictInput,
  ValidatedResolveExternalIdQuery,
  ValidatedRoundIdInput,
  ValidatedRunComparisonInput,
  ValidatedSequesterInput,
  ValidatedSnapshotResult,
} from './validation';

export type {
  AbandonImportRoundInput,
  CaptureSnapshotInput,
  CaptureSnapshotResult,
  CommitImportRoundInput,
  CommitImportRoundResult,
  ComparisonEntry,
  ComparisonEntryKind,
  ComparisonMismatch,
  ComparisonRound,
  ComparisonStructuralField,
  CreateMigrationInput,
  CreateMigrationResult,
  CurrentImportedState,
  GetComparisonRoundQuery,
  GetIdentityConflictQuery,
  GetImportRoundQuery,
  GetMigrationQuery,
  IdentityConflict,
  IdentityConflictCandidate,
  IdentityConflictKind,
  IdentityConflictStatus,
  IdentifierMapEntry,
  IdentifierMapOrigin,
  ImportRound,
  ImportRoundKind,
  ImportRoundStatus,
  ImportedRecord,
  ImportedRecordDisposition,
  ImportedRecordIssue,
  ImportedRecordState,
  IncumbentRecord,
  IncumbentSnapshotRequest,
  IncumbentSnapshotResult,
  ListComparisonRoundsQuery,
  ListIdentityConflictsQuery,
  ListImportRoundsQuery,
  ListImportedRecordsQuery,
  ListIdentifierMappingsQuery,
  ListMigrationEventsQuery,
  ListMigrationsQuery,
  Migration,
  MigrationEventType,
  MigrationIncumbentReader,
  MigrationKitBindingInput,
  MigrationNativeReader,
  MigrationStatus,
  NativeStateReadRequest,
  NativeStateReadResult,
  ResolveExternalIdQuery,
  ResolveExternalIdResult,
  ResolveIdentityConflictInput,
  RoundVerification,
  RunComparisonRoundInput,
  RunComparisonRoundResult,
  SequesterMigrationInput,
} from './types';
export { MIGRATION_LIVE_STATUSES, MIGRATION_TERMINAL_STATUSES } from './types';
