// Typed errors of the learning module. Consumers catch `LearningError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`outcome_not_found` / `measurement_not_found` /
// `assertion_not_found` / `learning_update_not_found`) — the existence of
// another tenant's outcomes must never leak (ADR-0001), on reads AND on
// writes: measuring, settling or abandoning a foreign-tenant outcome id is
// reported as `outcome_not_found`, never as a transition error. The one
// validated cross-module reference (the originating cognitive execution)
// is uniformly `invalid_origin_ref` for the same reason: missing,
// malformed and foreign-tenant execution ids are indistinguishable.
//
// W053 (CompanyModel, ADR-0016) adds the same discipline for the Company
// Model: a learning update's outcome link is uniformly `invalid_outcome_ref`
// (missing, malformed and foreign-tenant outcome ids are indistinguishable),
// and a concurrent writer on the same assertion chain or model version loses
// cleanly with `update_conflict` (the W040 `outcome_conflict` pattern).

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
  // W053 — CompanyModel (ADR-0016)
  | 'invalid_update_input'
  | 'invalid_rank_input'
  | 'invalid_outcome_ref'
  | 'update_conflict'
  | 'assertion_not_found'
  | 'learning_update_not_found';

export class LearningError extends Error {
  constructor(
    public readonly code: LearningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LearningError';
  }
}
