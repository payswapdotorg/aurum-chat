// Typed errors of the attention module. Consumers catch `AttentionError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing or
// unreadable reference (`invalid_reference` for goals/executions,
// `invalid_evidence` for observations/claims, `candidate_not_found` for
// candidates): the existence of another tenant's goals, executions,
// evidence or discoveries must never leak (ADR-0001), including through
// the materialization paths.
//
// Error propagation across module boundaries (documented for consumers):
//  * a goal that is missing, cross-tenant or unreadable through the goals
//    contract is uniformly `invalid_reference` — never `goal_not_active`
//    (that code asserts an IN-TENANT goal whose current version is
//    archived, which is not an existence fact to protect);
//  * a cognitive execution that is missing or cross-tenant through the
//    cognition contract is uniformly `invalid_reference`;
//  * observations that are missing, cross-tenant or principal-restricted
//    are uniformly `invalid_evidence` (the epistemics module's
//    `invalid_evidence` policy, applied to this module's evidence basis);
//  * claims that are missing or cross-tenant through the epistemics
//    contract are uniformly `invalid_evidence`;
//  * during MATERIALIZATION the epistemics and missions contracts are
//    driven with pre-validated inputs; any rejection there is an internal
//    invariant violation surfaced as `materialization_failed` (nothing is
//    silently swallowed, and the candidate stays 'material' — retryable).

export type AttentionErrorCode =
  | 'invalid_context'
  | 'invalid_discovery_input'
  | 'invalid_policy_input'
  | 'invalid_query'
  | 'invalid_reference'
  | 'invalid_evidence'
  | 'goal_not_active'
  | 'candidate_conflict'
  | 'candidate_not_found'
  | 'candidate_not_material'
  | 'candidate_already_materialized'
  | 'materialization_failed'
  | 'forbidden';

export class AttentionError extends Error {
  constructor(
    public readonly code: AttentionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttentionError';
  }
}
