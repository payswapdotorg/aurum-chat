// Typed errors of the suppliers module. Consumers catch `SuppliersError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`supplier_not_found` / `supplier_version_not_found` /
// `scorecard_not_found` / `scorecard_version_not_found`) — the existence of
// another tenant's supplier registry must never leak (ADR-0001). This
// includes versions and scorecards: a version of a foreign-tenant record
// reads the same as a missing one, and assessing a foreign-tenant supplier
// id reads the same as a missing supplier.

export type SuppliersErrorCode =
  | 'invalid_context'
  | 'invalid_supplier_input'
  | 'invalid_scorecard_input'
  | 'invalid_query'
  // A lifecycle change was not surgical, a retired supplier was handed
  // anything but a reactivation, or an assessment was recorded against a
  // retired supplier (the goals module's transition discipline).
  | 'invalid_transition'
  | 'supplier_not_found'
  | 'supplier_version_not_found'
  | 'scorecard_not_found'
  | 'scorecard_version_not_found'
  // Two different principals raced to register the same supplier name;
  // the loser re-reads and revises the winner's record (the capabilities
  // module's name-conflict discipline — the name is the immutable graph key).
  | 'supplier_name_conflict'
  // A version-append race on a supplier or scorecard (optimistic pointer
  // guard); the loser re-reads and retries (history is never rewritten).
  | 'supplier_conflict'
  // Two different principals raced to record the first scorecard of one
  // supplier, or a concurrent revision moved a scorecard forward
  // mid-transaction; the loser re-reads and retries.
  | 'scorecard_conflict'
  // The derived intelligence view could not be computed because a sibling
  // contract read failed after inputs were validated — a genuine
  // infrastructure failure, never a validation retry loop (the attention
  // module's failure posture).
  | 'analysis_failed';

export class SuppliersError extends Error {
  constructor(
    public readonly code: SuppliersErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SuppliersError';
  }
}
