// Typed errors of the attention module. Consumers catch `AttentionError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`run_not_found` / `candidate_not_found`) — the existence of
// another tenant's discovery runs must never leak (ADR-0001), on reads
// AND on writes: reading or deep-linking a foreign-tenant run or
// candidate id is reported as not-found, never as a permission error.
// The validated cross-module references are uniform for the same reason:
// missing, malformed and foreign-tenant goal ids are `invalid_goal_ref`;
// claim and belief ids are `invalid_evidence_ref`; the originating
// cognitive execution is `invalid_origin_ref`. No existence leaks.

export type AttentionErrorCode =
  | 'invalid_context'
  | 'invalid_run_input'
  | 'invalid_reading'
  | 'invalid_proposal'
  | 'invalid_query'
  | 'invalid_goal_ref'
  | 'invalid_evidence_ref'
  | 'invalid_origin_ref'
  | 'discovery_conflict'
  | 'promotion_failed'
  | 'run_not_found'
  | 'candidate_not_found';

export class AttentionError extends Error {
  constructor(
    public readonly code: AttentionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttentionError';
  }
}
