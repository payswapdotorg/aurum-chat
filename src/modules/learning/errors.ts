// Typed errors of the learning module. Consumers catch `LearningError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`outcome_not_found` / `measurement_not_found` /
// `learning_not_found` / `learning_version_not_found`) — the existence of
// another tenant's outcomes, measurements, company learnings or versions
// must never leak (ADR-0001), on reads AND on writes: measuring, settling,
// abandoning, recording feedback for or appending to a foreign-tenant id
// is reported as the same not-found, never as a transition error. The one
// validated cross-module reference (the originating cognitive execution)
// is uniformly `invalid_origin_ref` for the same reason: missing,
// malformed and foreign-tenant execution ids are indistinguishable. The
// outcome link of outcome feedback (W041) follows the same discipline:
// missing/foreign-tenant outcome ids are `outcome_not_found`; an outcome
// that exists but is not settled is `invalid_outcome_ref`.

export type LearningErrorCode =
  | 'invalid_context'
  | 'invalid_outcome_input'
  | 'invalid_measurement_input'
  | 'invalid_settlement_input'
  | 'invalid_abandonment_input'
  | 'invalid_query'
  | 'invalid_origin_ref'
  | 'invalid_transition'
  | 'outcome_conflict'
  | 'outcome_not_found'
  | 'measurement_not_found'
  // W041 — Company Learning (versioned usefulness/preferences)
  | 'invalid_learning_input'
  | 'invalid_outcome_ref'
  | 'learning_not_found'
  | 'learning_version_not_found'
  | 'learning_conflict';

export class LearningError extends Error {
  constructor(
    public readonly code: LearningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LearningError';
  }
}
