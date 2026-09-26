// Public domain types of the migration module (W094 — Migration and
// Dual-Run Continuity).
//
// W094 owns the continuity half of leaving an incumbent system:
//
//   "Import history, preserve identifiers, synchronize during migration,
//    compare legacy/Aurum results, support rollback and progressive
//    retirement."
//   Acceptance: "customer can run incumbent and Aurum in parallel;
//   conflicts are surfaced; rollback is possible; no silent data loss or
//   duplicate authority."
//
// The canonical chains map onto forward-only state:
//
//   IMPORT ROUND   snapshot → transform → staged → review → commit
//                  (abandoned = the explicit dead end; an abandoned round
//                   never becomes a delta base, so its window is re-read)
//
//   RETIREMENT     dual-running → compare-clean → incumbent-read-only →
//                  incumbent-retired, each checkpoint an explicit,
//                  auditable transition carrying the evidence link that
//                  justifies it (the clean comparison round).
//
//   ROLLBACK       sequestered — a migration's committed imports are
//                  logically quarantined: retained for audit, excluded
//                  from live queries. Native Aurum data is never touched
//                  and evidence is never deleted.
//
// EVERY IMPORTED RECORD IS EVIDENCE (the W004 discipline expressed in
// module-owned storage): full provenance (source system, external id,
// match key, round, snapshot reference), immutable payload/provenance at
// the storage level (trigger), per-round rows (a delta round's records
// are NEW rows — the previous round's rows never mutate), and surfaced
// issues (the transform flags, it never drops).
//
// NO DUPLICATE AUTHORITY: the incumbent exists in Aurum ONLY as these
// provenance-tagged imported records plus the external↔Aurum identifier
// map. The module exposes no write path to the incumbent (the incumbent
// reader port is read-only; the verification transport's execute side is
// never invoked — tested with a canary), and no path that would make the
// incumbent a second truth store: every surface is a read of
// provenance-tagged imports or a lifecycle transition, never a live
// incumbent query-by-authority.
//
// PROVIDER ISOLATION (lock 16): everything here is provider-neutral BY
// CONSTRUCTION. The incumbent appears only as the W081 inventory
// system's plain-language descriptor and the OPAQUE broker-connection id
// (W082); the only incumbent-minted values on this surface are OPAQUE
// strings (external record ids, snapshot references). Credential VALUES
// never appear here — the opaque credentialRef is loaded live through
// the connection-broker contract and passes straight through to the
// wired reader / verification transport (the W082 discipline).

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/**
 * The forward-only status of a migration — the progressive-retirement
 * checkpoint chain plus the rollback terminal:
 *   * 'dual-running'        — the initial state: incumbent and Aurum run
 *     in parallel; full and delta import rounds and comparison rounds
 *     are live;
 *   * 'compare-clean'       — a comparison round completed with zero
 *     divergences (the evidence link is frozen on the migration);
 *   * 'incumbent-read-only' — the operator asserted the incumbent is now
 *     read-only (final catch-up deltas and comparisons may still run);
 *   * 'incumbent-retired'   — terminal: the incumbent is retired; Aurum
 *     is the sole system. The identifier map stays live (identifiers
 *     remain preserved for historical references).
 *   * 'sequestered'         — terminal ROLLBACK: the migration's
 *     committed imports are logically quarantined (retained for audit,
 *     excluded from live queries). Never deletes evidence; never touches
 *     native Aurum data.
 */
export type MigrationStatus =
  | 'dual-running'
  | 'compare-clean'
  | 'incumbent-read-only'
  | 'incumbent-retired'
  | 'sequestered';

/** Terminal statuses (the end of a migration's lifecycle). */
export const MIGRATION_TERMINAL_STATUSES: readonly MigrationStatus[] = [
  'incumbent-retired',
  'sequestered',
] as const;

/** The statuses a migration may take new import/comparison rounds in. */
export const MIGRATION_LIVE_STATUSES: readonly MigrationStatus[] = [
  'dual-running',
  'compare-clean',
  'incumbent-read-only',
] as const;

/** The kind of one import round: a full snapshot or a delta window. */
export type ImportRoundKind = 'full' | 'delta';

/**
 * The forward-only status of one import round — the staged lifecycle
 * snapshot → transform → staged → review → commit, plus the explicit
 * dead end ('abandoned'; an abandoned round never becomes a delta base,
 * so its window is re-read by the next round — no silent data loss).
 */
export type ImportRoundStatus =
  | 'snapshotted'
  | 'staged'
  | 'reviewed'
  | 'committed'
  | 'abandoned';

/** The forward-only state of one imported record (mirrors its round). */
export type ImportedRecordState = 'snapshotted' | 'staged' | 'committed' | 'abandoned';

/**
 * The commit disposition of one imported record — how the record was
 * linked into the external↔Aurum identifier map:
 *   * 'new'        — no prior claim; a fresh Aurum entity was minted;
 *   * 'update'     — the external id was already mapped (a delta-round
 *     update of the same incumbent entity);
 *   * 'matched'    — matched by natural key to a prior claim of the SAME
 *     source system (a re-issued external id; the Aurum entity keeps its
 *     identity — identifiers preserved);
 *   * 'conflicted' — a collision was surfaced (cross-system or ambiguous)
 *     and NOT auto-merged; the record carries an open identity conflict
 *     and no Aurum link until a human resolves it;
 *   * 'resolved'   — a formerly conflicted record whose conflict was
 *     resolved by an explicit human decision;
 *   * 'tombstone'  — the incumbent reported the record deleted; the map
 *     entry (if any) is preserved, the current imported state is
 *     tombstoned.
 */
export type ImportedRecordDisposition =
  | 'new'
  | 'update'
  | 'matched'
  | 'conflicted'
  | 'resolved'
  | 'tombstone';

/**
 * The commit-time verification outcome of a round — the W084/W088
 * composition: each staged record is re-read through the wired
 * deep-action transport (edge-backed for private/on-prem incumbents) and
 * compared with the staged payload. 'not-wired' is the honest state when
 * no transport is wired (never a fake success).
 */
export type RoundVerification = 'not-wired' | 'verified' | 'divergent';

/** How an identifier-map entry was established. */
export type IdentifierMapOrigin = 'import' | 'conflict-resolution';

/**
 * The kind of one identity conflict — the W095 ambiguous-match rule
 * applied to migration (collisions are explicit conflict records, never
 * auto-merged):
 *   * 'cross-system-collision' — another external system's map entries
 *     already claim this record's natural key (two external systems for
 *     the same entity; never auto-merged across systems);
 *   * 'ambiguous-match' — the claims span two or more Aurum entities
 *     (ambiguous; a human decides).
 */
export type IdentityConflictKind = 'cross-system-collision' | 'ambiguous-match';

/** The state of one identity conflict. */
export type IdentityConflictStatus = 'open' | 'resolved';

/**
 * The kind of one comparison entry — the structured dual-run verdict for
 * one entity:
 *   * 'agreement'        — both sides agree on every compared field;
 *   * 'divergence'       — at least one compared field diverges (value
 *     mismatches and/or one-sided fields — enumerated, never merged);
 *   * 'native-missing'   — mapped and imported, but Aurum has no native
 *     state for the entity;
 *   * 'incumbent-deleted'— the incumbent reported the entity deleted,
 *     but Aurum's native state still holds it;
 *   * 'incumbent-missing'— Aurum holds a native state the incumbent
 *     never imported (a native-only entity — surfaced, not hidden).
 */
export type ComparisonEntryKind =
  | 'agreement'
  | 'divergence'
  | 'native-missing'
  | 'incumbent-deleted'
  | 'incumbent-missing';

/** The append-only lifecycle event vocabulary. */
export type MigrationEventType =
  | 'created'
  | 'snapshot-captured'
  | 'transformed'
  | 'reviewed'
  | 'committed'
  | 'round-abandoned'
  | 'identity-conflict-raised'
  | 'identity-conflict-resolved'
  | 'comparison-completed'
  | 'compare-clean-checkpoint'
  | 'incumbent-read-only-checkpoint'
  | 'incumbent-retired'
  | 'sequestered'
  | 'verification-divergence';

// ---------------------------------------------------------------------------
// The incumbent reader port (the import path's provider-neutral seam)
// ---------------------------------------------------------------------------

/**
 * One canonical incumbent record — the reader's normalized answer (the
 * deep-actions transport-canonicalization discipline: plain JSON only; a
 * provider object cannot cross).
 */
export interface IncumbentRecord {
  /** The incumbent's opaque external record id (1..200 chars). */
  externalId: string;
  /**
   * The natural match key — the stable real-world identity the
   * external↔Aurum map resolves by (e.g. a customer number). Null when
   * the incumbent exposes none (the record always mints a fresh entity).
   */
  matchKey: string | null;
  /**
   * The incumbent's record-type discriminator (e.g. 'ledger-account') —
   * matched against a bound vertical kit's schema-hint entities by the
   * transform. Null when the incumbent exposes none.
   */
  entityType: string | null;
  /** The canonical payload (plain JSON object, ≤ 256 KiB; null = tombstone). */
  payload: Record<string, unknown> | null;
  /**
   * When the incumbent reports this record deleted (a tombstone) —
   * strict ISO 8601. A tombstone carries no payload.
   */
  deletedAt: string | null;
}

/** One read of the incumbent's current (or changed-since) record set. */
export interface IncumbentSnapshotRequest {
  /** The W082 broker connection (opaque id). */
  connectionId: string;
  /** Opaque broker credential-store reference — the reader resolves it. */
  credentialRef: string;
  /** The W081 canonical system key of the incumbent. */
  systemKey: string;
  /** The READ capability being exercised (plain-language W081 key). */
  readCapabilityKey: string;
  /**
   * Delta reads: the OPAQUE snapshot reference of the last COMMITTED
   * round — the reader returns what changed since. Null = a full
   * snapshot.
   */
  sinceSnapshotRef: string | null;
  /** Stable dedupe key — `migration:<roundId>`. */
  idempotencyKey: string;
}

/** The reader's canonical answer. */
export interface IncumbentSnapshotResult {
  /**
   * The OPAQUE incumbent-minted reference of the version this snapshot
   * read (the provenance anchor frozen on the round and every record).
   */
  snapshotRef: string;
  /** The changed (or full) record set — ≤ the module's round cap. */
  records: IncumbentRecord[];
}

/**
 * The incumbent reader port — the import path's exit seam (the
 * deep-actions transport-port precedent). NOTHING is wired by default:
 * captureSnapshot fails explicitly with `reader_unavailable` rather than
 * faking a snapshot. The shipped fixture incumbent (fixture-incumbent.ts)
 * is the deterministic double; REAL incumbent readers are
 * environment-dependent adapters (SaaS incumbents compose broker-backed
 * reads, private/on-prem incumbents compose the Edge Connector boundary)
 * — see the delivery report's ENVIRONMENT-DEPENDENT section.
 *
 * THE PORT IS READ-ONLY (no write method exists on it): Aurum never
 * writes back to the incumbent through this module — customer-configured
 * writes ride the existing deep-action path (W084), never this port.
 */
export interface MigrationIncumbentReader {
  readSnapshot(request: IncumbentSnapshotRequest): Promise<IncumbentSnapshotResult>;
}

// ---------------------------------------------------------------------------
// The native-state reader port (the comparison's Aurum-side seam)
// ---------------------------------------------------------------------------

/** One read of the tenant's native Aurum states. */
export interface NativeStateReadRequest {
  /**
   * The Aurum entity ids to read — null asks for the COMPLETE current
   * native state set (so native-only entities surface as
   * 'incumbent-missing' divergences).
   */
  entityIds: string[] | null;
}

/** The reader's canonical answer. */
export interface NativeStateReadResult {
  states: Array<{
    aurumEntityId: string;
    /** The native state (plain JSON object). */
    state: Record<string, unknown>;
  }>;
}

/**
 * The native-state reader port — the comparison round's Aurum side. The
 * migration module does not presume where a tenant's native state lives
 * (world entities, vertical surfaces, ...); the adapter answers with the
 * CURRENT canonical states. NOTHING is wired by default:
 * runComparisonRound fails explicitly with `native_reader_unavailable`
 * rather than faking native state.
 */
export interface MigrationNativeReader {
  readNativeStates(request: NativeStateReadRequest): Promise<NativeStateReadResult>;
}

// ---------------------------------------------------------------------------
// The migration and its lifecycle inputs
// ---------------------------------------------------------------------------

/**
 * The optional W092 vertical-kit binding — the industry-shaped incumbent
 * surface the migration rides. Validated through the vertical-kits
 * contract (the installation must exist and be active; the integration
 * key must be declared by the installed version's manifest); the kit's
 * schema hints drive the transform's per-record issue detection.
 */
export interface MigrationKitBindingInput {
  installationId: string;
  integrationKey: string;
}

/** Input shape of `createMigration`. */
export interface CreateMigrationInput {
  /** The W081 Tool & System Inventory entry for the incumbent system. */
  incumbentSystemId: string;
  /** The W082 broker connection the incumbent reads ride. */
  incumbentConnectionId: string;
  /**
   * The plain-language W081 READ capability the import rounds exercise
   * (must be on the incumbent's live capability surface).
   */
  incumbentReadCapabilityKey: string;
  /** The optional vertical-kit binding (W092). */
  kitBinding?: MigrationKitBindingInput | null;
}

/** Input shape of `captureSnapshot`. */
export interface CaptureSnapshotInput {
  migrationId: string;
  /**
   * The round kind: 'full' re-baselines (reads everything), 'delta'
   * reads what changed since the last COMMITTED round (requires one).
   * Null = automatic (full when no round has committed yet, else delta).
   */
  kind?: ImportRoundKind | null;
}

/** Input shape of `transformImportRound` / `reviewImportRound`. */
export interface RoundPhaseInput {
  roundId: string;
}

/** Input shape of `commitImportRound` (a round phase). */
export type CommitImportRoundInput = RoundPhaseInput;

/** Input shape of `abandonImportRound` (a round phase). */
export type AbandonImportRoundInput = RoundPhaseInput;

/** Input shape of `resolveExternalId`. */
export interface ResolveExternalIdQuery {
  /** The canonical W081 system key of the source system. */
  sourceSystemKey: string;
  externalId: string;
}

/** Input shape of `resolveIdentityConflict`. */
export interface ResolveIdentityConflictInput {
  conflictId: string;
  /** The Aurum entity the conflicted record's external id resolves to. */
  aurumEntityId: string;
  note?: string | null;
}

/** Input shape of `runComparisonRound`. */
export interface RunComparisonRoundInput {
  migrationId: string;
  /** Optional plain-language note frozen on the report. */
  note?: string | null;
}

/** Input shape of `sequesterMigration`. */
export interface SequesterMigrationInput {
  migrationId: string;
  /** Why the rollback happened (1..2000 chars — the audit's justification). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

/** One migration — the incumbent relationship and its checkpoint chain. */
export interface Migration {
  id: string;
  tenantId: string;
  incumbentSystemId: string;
  incumbentSystemKey: string;
  incumbentSystemDisplayName: string;
  incumbentConnectionId: string;
  incumbentReadCapabilityKey: string;
  kitInstallationId: string | null;
  kitKey: string | null;
  kitVersion: string | null;
  kitIntegrationKey: string | null;
  status: MigrationStatus;
  /** The evidence link of the compare-clean checkpoint (null before it). */
  compareCleanRoundId: string | null;
  readOnlyAt: string | null;
  retiredAt: string | null;
  sequesteredAt: string | null;
  sequesteredBy: string | null;
  sequesterReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One import round. */
export interface ImportRound {
  id: string;
  tenantId: string;
  migrationId: string;
  roundNumber: number;
  kind: ImportRoundKind;
  status: ImportRoundStatus;
  snapshotRef: string;
  sinceSnapshotRef: string | null;
  rawRecordCount: number;
  transformIssueCount: number;
  verification: RoundVerification;
  verifiedCount: number;
  divergentCount: number;
  conflictCount: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  committedAt: string | null;
  abandonedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * One surfaced transform issue of an imported record (the transform
 * flags, it never drops — a record with issues still stages and commits;
 * the issues are the review's material).
 */
export interface ImportedRecordIssue {
  /** Deterministic issue code (e.g. 'schema-hint-type-mismatch'). */
  code: string;
  /** The field or aspect the issue names. */
  field: string | null;
  /** Plain-language detail. */
  detail: string;
}

/** One imported record — full provenance, evidence-shaped. */
export interface ImportedRecord {
  id: string;
  tenantId: string;
  migrationId: string;
  roundId: string;
  position: number;
  sourceSystemKey: string;
  externalId: string;
  matchKey: string | null;
  entityType: string | null;
  snapshotRef: string;
  payload: Record<string, unknown> | null;
  tombstone: boolean;
  issues: ImportedRecordIssue[];
  state: ImportedRecordState;
  disposition: ImportedRecordDisposition | null;
  aurumEntityId: string | null;
  identityConflictId: string | null;
  createdAt: string;
  committedAt: string | null;
}

/** One entry of the external↔Aurum identifier map. */
export interface IdentifierMapEntry {
  id: string;
  tenantId: string;
  migrationId: string;
  sourceSystemKey: string;
  externalId: string;
  matchKey: string | null;
  aurumEntityId: string;
  roundId: string;
  origin: IdentifierMapOrigin;
  createdBy: string;
  createdAt: string;
}

/** One frozen candidate claim of an identity conflict. */
export interface IdentityConflictCandidate {
  sourceSystemKey: string;
  externalId: string;
  aurumEntityId: string;
  migrationId: string;
}

/** One identity conflict — a surfaced collision, never auto-merged. */
export interface IdentityConflict {
  id: string;
  tenantId: string;
  migrationId: string;
  roundId: string;
  recordId: string;
  externalId: string;
  matchKey: string | null;
  kind: IdentityConflictKind;
  candidates: IdentityConflictCandidate[];
  status: IdentityConflictStatus;
  resolutionAurumEntityId: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// The comparison report
// ---------------------------------------------------------------------------

/** One value divergence (the W084 StateMismatch shape, reused verbatim:
 * expected = incumbent-imported, actual = native). */
export interface ComparisonMismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** One structural one-sided field of a divergence. */
export interface ComparisonStructuralField {
  field: string;
  /** The value the present side holds. */
  value: unknown;
}

/** The structured verdict for one compared entity. */
export interface ComparisonEntry {
  id: string;
  tenantId: string;
  comparisonRoundId: string;
  position: number;
  aurumEntityId: string;
  kind: ComparisonEntryKind;
  mismatches: ComparisonMismatch[];
  incumbentOnlyFields: ComparisonStructuralField[];
  nativeOnlyFields: ComparisonStructuralField[];
  /** The deterministic divergence reason (null on agreements). */
  reason: string | null;
}

/** One comparison round — the structured dual-run report. */
export interface ComparisonRound {
  id: string;
  tenantId: string;
  migrationId: string;
  status: 'completed';
  comparedEntityCount: number;
  agreementCount: number;
  divergenceCount: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

/** One append-only lifecycle event. */
export interface MigrationEvent {
  id: string;
  tenantId: string;
  migrationId: string;
  position: number;
  event: MigrationEventType;
  detail: string | null;
  roundId: string | null;
  comparisonRoundId: string | null;
  recordedBy: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// The dual-run current-state view
// ---------------------------------------------------------------------------

/**
 * The current incumbent-imported state of one Aurum entity within a
 * migration — the latest committed record among the entity's map entries
 * (the deterministic dual-run view the comparison evaluates and operators
 * inspect; NOT authority — provenance-tagged imported state only).
 */
export interface CurrentImportedState {
  aurumEntityId: string;
  /** The external id of the latest committed record for the entity. */
  externalId: string;
  /** The latest committed record's payload (null when tombstoned). */
  payload: Record<string, unknown> | null;
  tombstone: boolean;
  /** The round the latest committed record belongs to. */
  roundId: string;
  roundNumber: number;
  recordId: string;
}

// ---------------------------------------------------------------------------
// Query and result shapes
// ---------------------------------------------------------------------------

export interface GetMigrationQuery {
  migrationId: string;
}

export interface ListMigrationsQuery {
  status?: MigrationStatus | null;
  limit?: number;
}

export interface GetImportRoundQuery {
  roundId: string;
}

export interface ListImportRoundsQuery {
  migrationId: string;
  status?: ImportRoundStatus | null;
  limit?: number;
}

export interface ListImportedRecordsQuery {
  migrationId: string;
  roundId?: string | null;
  /** Include sequestered migrations' records (the audit view). */
  includeSequestered?: boolean;
  limit?: number;
}

export interface ListIdentifierMappingsQuery {
  migrationId?: string | null;
  limit?: number;
}

export interface ListIdentityConflictsQuery {
  migrationId?: string | null;
  status?: IdentityConflictStatus | null;
  limit?: number;
}

export interface GetIdentityConflictQuery {
  conflictId: string;
}

export interface GetComparisonRoundQuery {
  comparisonRoundId: string;
}

export interface ListComparisonRoundsQuery {
  migrationId: string;
  limit?: number;
}

export interface ListMigrationEventsQuery {
  migrationId: string;
  limit?: number;
}

export interface ListCurrentImportedStatesQuery {
  migrationId: string;
  /** Include entities whose latest committed record is a tombstone. */
  includeTombstoned?: boolean;
}

/** Result shape of `createMigration`. */
export interface CreateMigrationResult {
  migration: Migration;
  /** false when an identical live migration replayed (idempotent create). */
  created: boolean;
}

/** Result shape of `captureSnapshot`. */
export interface CaptureSnapshotResult {
  round: ImportRound;
  /** The records as staged by the snapshot (evidence-shaped rows). */
  records: ImportedRecord[];
}

/** Result shape of `commitImportRound`. */
export interface CommitImportRoundResult {
  round: ImportRound;
  records: ImportedRecord[];
  /** The identity conflicts this round surfaced (never auto-merged). */
  conflicts: IdentityConflict[];
  /** The map entries this round established. */
  mapEntries: IdentifierMapEntry[];
}

/** Result shape of `runComparisonRound`. */
export interface RunComparisonRoundResult {
  round: ComparisonRound;
  entries: ComparisonEntry[];
}

/** Result shape of `resolveExternalId`. */
export interface ResolveExternalIdResult {
  entry: IdentifierMapEntry;
  /** The current incumbent-imported state of the resolved entity (if any). */
  currentState: CurrentImportedState | null;
}
