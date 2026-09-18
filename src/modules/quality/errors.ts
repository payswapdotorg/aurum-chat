// Typed errors of the quality module. Consumers catch `QualityError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`judgment_not_found` / `snapshot_not_found`) — the existence of
// another tenant's judgments or snapshots must never leak (ADR-0001), on
// reads AND on writes. The validated cross-module references (the
// discovery candidate, the acquisition plan, the originating cognitive
// execution) are uniformly `invalid_candidate_ref` / `invalid_plan_ref` /
// `invalid_origin_ref` for the same reason: missing, malformed and
// foreign-tenant ids are indistinguishable.

export type QualityErrorCode =
  | 'invalid_context'
  | 'invalid_judgment_input'
  | 'invalid_snapshot_input'
  | 'invalid_judgment_query'
  | 'invalid_snapshot_query'
  | 'invalid_candidate_ref'
  | 'invalid_plan_ref'
  | 'invalid_origin_ref'
  | 'judgment_not_found'
  | 'snapshot_not_found';

export class QualityError extends Error {
  constructor(
    public readonly code: QualityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QualityError';
  }
}
