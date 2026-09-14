// Typed errors of the freshness module. Consumers catch `FreshnessError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`temporal_state_not_found` / `policy_not_found`) — the existence
// of another tenant's temporal state or policies must never leak
// (ADR-0001), including through evaluation paths.
//
// Error propagation across the module boundary (documented for consumers):
//  * `recordTemporalRevision` maps unreadable/missing supporting
//    observations to `invalid_provenance` — cross-tenant evidence is
//    indistinguishable from missing evidence;
//  * `evaluateObservationFreshness` / `evaluateSourceFreshness` read
//    THROUGH the observations contract and propagate its `ObservationsError`
//    unchanged (the observation is the subject of the evaluation, not
//    provenance being validated);
//  * `evaluateTemporalStateFreshness` skips supporting evidence the caller
//    may not read (partial view, the observations module's lineage
//    precedent) — it never fails on restricted provenance.

export type FreshnessErrorCode =
  | 'invalid_context'
  | 'invalid_policy_input'
  | 'invalid_revision_input'
  | 'invalid_query'
  | 'invalid_provenance'
  | 'revision_conflict'
  | 'policy_conflict'
  | 'temporal_state_not_found'
  | 'policy_not_found';

export class FreshnessError extends Error {
  constructor(
    public readonly code: FreshnessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FreshnessError';
  }
}
