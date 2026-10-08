// ============================================================================
// context — public contract surface.
//
// Cross-module imports must target exactly '@/modules/context/contract'.
//
// The W124b TL-frozen stage exported the shared ContextFingerprint type
// vocabulary (unchanged below, exports intact). W134 extends this surface
// additively with the operational fingerprint derivation API:
//
//   deriveFingerprint — derive + persist ONE ContextFingerprint for a
//      goal (validated ACTIVE through the goals contract), a task
//      descriptor and the OBSERVABLE context input. Every dimension is
//      optional: absent dimensions are stored ABSENT, never faked (the
//      null-signal law — the fingerprint records what is known).
//   getFingerprint / listFingerprints — tenant-scoped reads of the
//      append-only derived history (fingerprints are immutable evidence:
//      re-deriving under changed context appends a new fingerprint).
//
//   summarizeFingerprint / knownDimensionKeys / absentDimensionKeys —
//      the pure summary: a headline composed only from KNOWN dimensions
//      and the known/absent report (the null signal made visible).
//
// W135 (the Contextual Organizational Lab) and every other module import
// ONLY through this file.
// ============================================================================

export type {
  SeasonalContext,
  DurationClass,
  DurationContext,
  StaffingContext,
  WorkloadLevel,
  CapabilityAvailabilityContext,
  EnvironmentContext,
  ConstraintContext,
  EvidenceFreshnessContext,
  ContextFingerprint,
  ContextFingerprintSummary,
} from './types';

export type {
  ContextDimensionKey,
  ContextTask,
  ContextTaskInput,
  ContextObservationsInput,
  DeriveFingerprintInput,
  GetFingerprintQuery,
  ListFingerprintsQuery,
} from './types';

export { CONTEXT_DIMENSIONS } from './types';

export {
  deriveFingerprint,
  getFingerprint,
  listFingerprints,
} from './service';

export { ContextError } from './errors';
export type { ContextErrorCode } from './errors';

export {
  // vocabularies + guards
  DURATION_CLASSES,
  EXPERIENCE_LEVELS,
  RISK_TOLERANCES,
  WORKLOAD_LEVELS,
  isDurationClass,
  isRiskTolerance,
  isUuid,
  isWorkloadLevel,
  // limits
  DEFAULT_LIST_LIMIT,
  MAX_EVIDENCE_REFS,
  MAX_HEADCOUNT,
  MAX_LIST_ITEMS,
  MAX_LIST_LIMIT,
  MAX_TASK_TITLE_CHARS,
} from './validation';

export type {
  ValidatedDerivationInput,
  ValidatedGetFingerprintQuery,
  ValidatedListFingerprintsQuery,
  ValidatedTask,
} from './validation';

// The pure derivation + summary (unit-testable without a database).
export {
  MAX_HEADLINE_CHARS,
  absentDimensionKeys,
  durationHeadlinePhrase,
  knownDimensionKeys,
  staffingHeadlinePhrase,
  summarizeFingerprint,
} from './derivation';
export type { FingerprintDerivationSeed } from './derivation';
