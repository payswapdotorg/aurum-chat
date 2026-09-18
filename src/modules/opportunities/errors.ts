// Typed errors of the opportunities module. Consumers catch
// `OpportunitiesError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`opportunity_not_found` / `opportunity_version_not_found` /
// `run_not_found` / `candidate_not_found`) — the existence of another
// tenant's opportunity intelligence must never leak (ADR-0001). This
// includes versions, runs and conversion candidates: a version of a
// foreign-tenant opportunity, or a candidate of a foreign-tenant run, reads
// the same as a missing one.
//
// Cross-module reference validation flows through the observations (W004),
// epistemics (W007), goals (W008) and cognition (W013) CONTRACTS. A
// sibling's typed error there is re-labelled into this module's uniform
// `invalid_*` codes (the attention module's documented precedent) so a
// caller only ever branches on one error vocabulary per contract call —
// and so a foreign-tenant evidence/goal/execution reference never leaks
// which module rejected it or why.

export type OpportunitiesErrorCode =
  | 'invalid_context'
  | 'invalid_conversion_input'
  | 'invalid_revision_input'
  | 'invalid_query'
  // An observation or claim cited as evidence is not readable in this
  // tenant to this principal (missing, foreign-tenant or restricted).
  | 'invalid_evidence_ref'
  // An affected-goal reference is not readable in this tenant.
  | 'invalid_goal_ref'
  // The originating cognitive execution link is not readable in this tenant.
  | 'invalid_origin_ref'
  | 'opportunity_not_found'
  | 'opportunity_version_not_found'
  | 'run_not_found'
  | 'candidate_not_found'
  // A version-based optimistic guard or append race failed cleanly; the
  // loser re-reads the opportunity and retries (history is never rewritten).
  | 'opportunity_conflict';

export class OpportunitiesError extends Error {
  constructor(
    public readonly code: OpportunitiesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpportunitiesError';
  }
}
