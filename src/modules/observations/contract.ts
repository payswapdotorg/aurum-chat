// ============================================================================
// observations — the ONLY public surface of the observations module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W004 — Observations and Provenance:
// "Record immutable observations with source, channel, timestamp, extraction
//  lineage, permissions and confidence. Verify observation cannot be mutated
//  into authoritative truth."
//
//   recordObservation      — append immutable evidence with full provenance
//      (source, channel, observedAt; recordedAt is service-set). Corrections
//      and contradictions are NEW observations (lock 12), never edits.
//   getObservation         — tenant-scoped read honoring recorded
//      principal-visibility.
//   listObservations        — filtered feed (kind, channel, source, observed
//      window, limit); principal-scoped evidence never leaks into another
//      principal's results.
//   getObservationLineage   — the full extraction lineage: the observation,
//      all ancestor edges and readable ancestors.
//
// There is deliberately NO operation to update, delete, correct, verify,
// promote or otherwise mutate an observation: observations are immutable
// evidence (lock 5) and are never authoritative truth (lock 10) — claims and
// beliefs are the epistemics module's concepts (W007) derived ON TOP of
// observations. The database enforces the same with triggers that reject
// UPDATE/DELETE/TRUNCATE (migrations/001 and /002).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's evidence
// (including a lineage parent) is reported as `observation_not_found` — no
// existence leak.
// ============================================================================

export {
  getObservation,
  getObservationLineage,
  listObservations,
  recordObservation,
} from './service';

export { ObservationsError } from './errors';
export type { ObservationsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  DERIVING_LINEAGE_METHODS,
  LINEAGE_METHODS,
  MAX_LIST_LIMIT,
  MAX_LINEAGE_PARENTS,
  MAX_USAGE_TAGS,
  OBSERVATION_SOURCE_KINDS,
  OBSERVATION_VISIBILITIES,
  isLineageMethod,
  isObservationSourceKind,
  isObservationVisibility,
} from './validation';

export type {
  ValidatedListQuery,
  ValidatedObservationInput,
} from './validation';

export type {
  ExtractorInfo,
  LineageMethod,
  ListObservationsQuery,
  Observation,
  ObservationConfidence,
  ObservationConfidenceInput,
  ObservationLineage,
  ObservationLineageEdge,
  ObservationLineageInput,
  ObservationLineageResult,
  ObservationPermissions,
  ObservationPermissionsInput,
  ObservationSource,
  ObservationSourceKind,
  ObservationVisibility,
  RecordObservationInput,
} from './types';
