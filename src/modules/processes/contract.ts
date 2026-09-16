// ============================================================================
// processes — the ONLY public surface of the processes module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W016 — Process Intelligence:
// "Reconstruct processes from events/observations; detect bottlenecks,
//  duplication, handoffs, manual effort and errors."
//
//   reconstructProcess  — derive how work actually occurs from the
//      immutable evidence (events W003 + observations W004, read through
//      their contracts) and append the result as a full-snapshot process
//      VERSION: steps (activity frequencies + actor breakdown), edges (the
//      directly-follows flow graph with wait times), variants (observed
//      sequences) and stats. An existing name appends the next version; a
//      new name creates the process identity at version 1. Every version
//      also persists its DETERMINISTIC findings — bottlenecks,
//      duplication, handoffs (ping-pong actor patterns), manual effort and
//      errors — each citing the exact event/observation evidence that
//      justifies it. The automation module (W018) consumes these findings
//      through THIS contract (lock 19; `processes + capabilities →
//      automation`).
//   getProcess          — the current view (identity + current version's
//      scope/stats/options + finding counts + audit summary).
//   listProcesses       — current views, filtered (exact name, name
//      search), ordered by name.
//   getProcessVersion   — one full reconstruction snapshot (deep link).
//   listProcessVersions — a process's reconstruction history, ascending.
//   listProcessFindings — a version's findings (default: the current
//      version), filtered by kind and minimum confidence, in the canonical
//      kind-then-subject order.
//   getProcessFinding   — one finding, deep-linked by id.
//
// There is deliberately NO operation to update or delete a version, a
// finding or a process, and NO operation to write findings directly:
// reconstructions and findings are derived from immutable evidence and are
// append-only — PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on
// process_versions and process_findings (and DELETE/TRUNCATE on processes)
// via migration 001 triggers. There is also no employee-assessment
// operation: findings describe how work flows, never how a person performs
// (workforce intelligence W019 owns assessments, with alternative
// explanations).
//
// Cross-module integration: evidence is read ONLY through the events and
// observations contracts (listEvents / listObservations) — never their
// tables — mirroring how freshness (W006) consumes observations and
// missions (W011) consume epistemics. The world entity reference is an
// opaque forward reference (the missions module's affected-goals
// precedent): the world module (W005) owns declared process entities; this
// module owns the observed flow.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's process
// intelligence (including versions and findings) is reported as
// `process_not_found` / `process_version_not_found` / `finding_not_found`
// — no existence leak.
// ============================================================================

export {
  getProcess,
  getProcessFinding,
  getProcessVersion,
  listProcessFindings,
  listProcesses,
  listProcessVersions,
  reconstructProcess,
} from './service';

export { ProcessesError } from './errors';
export type { ProcessesErrorCode } from './errors';

export {
  DEFAULT_ERROR_ACTIVITY_SUFFIXES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MANUAL_SHARE_THRESHOLD,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MIN_EDGE_INSTANCES,
  MAX_ACTIVITY_TYPES,
  MAX_CASE_KEY_CANDIDATES,
  MAX_ERROR_ACTIVITY_TYPES,
  MAX_FINDING_EVIDENCE_REFS,
  MAX_FINDINGS_PER_VERSION,
  MAX_LIST_LIMIT,
  MAX_MAX_EVENTS,
  MAX_MIN_EDGE_INSTANCES,
  MAX_NAME_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_SEARCH_LENGTH,
  PROCESS_CHANGE_KINDS,
  PROCESS_FINDING_KINDS,
  PROCESS_PARTY_KINDS,
  escapeLike,
  isProcessFindingKind,
  isProcessPartyKind,
  isUuid,
} from './validation';

export type {
  ValidatedFindingsQuery,
  ValidatedFindingQuery,
  ValidatedHistoryQuery,
  ValidatedListQuery,
  ValidatedParty,
  ValidatedReconstructionInput,
  ValidatedVersionQuery,
} from './validation';

export {
  FINDING_KIND_RANK,
  isErrorActivity,
} from './detection';
export type { DetectedFinding, DetectionResult } from './detection';

export {
  MAX_MODEL_ACTIVITY_TYPES,
  MAX_MODEL_EDGES,
  MAX_VARIANTS_STORED,
  actorKeyOf,
  occurrenceCompare,
  reconstructProcessModel,
} from './reconstruction';
export type {
  ActivityOccurrence,
  EvidenceKind,
  ReconstructedModel,
} from './reconstruction';

export type {
  ActivityActorKind,
  GetProcessFindingQuery,
  GetProcessVersionQuery,
  ListProcessFindingsQuery,
  ListProcessesQuery,
  ListProcessVersionsQuery,
  Process,
  ProcessChangeKind,
  ProcessEdge,
  ProcessFinding,
  ProcessFindingCounts,
  ProcessFindingKind,
  ProcessParty,
  ProcessPartyInput,
  ProcessPartyKind,
  ProcessScope,
  ProcessScopeInput,
  ProcessStats,
  ProcessStep,
  ProcessVariant,
  ProcessVersion,
  ReconstructProcessInput,
  ReconstructionOptions,
  ReconstructionOptionsInput,
} from './types';
