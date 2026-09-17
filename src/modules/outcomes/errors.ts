// Typed errors of the outcomes module. Consumers catch `OutcomesError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`intervention_not_found`) — the existence of another tenant's
// interventions must never leak (ADR-0001), on reads AND on writes:
// realizing or abandoning a foreign-tenant intervention id is reported as
// `intervention_not_found`, never as a transition error. The one validated
// cross-module reference (the measuring learning outcome) is uniformly
// `invalid_outcome_ref` for the same reason: missing, malformed and
// foreign-tenant outcome ids are indistinguishable.

export type OutcomesErrorCode =
  | 'invalid_context'
  | 'invalid_intervention_input'
  | 'invalid_realization_input'
  | 'invalid_abandonment_input'
  | 'invalid_query'
  | 'invalid_outcome_ref'
  | 'invalid_transition'
  | 'intervention_conflict'
  | 'intervention_not_found';

export class OutcomesError extends Error {
  constructor(
    public readonly code: OutcomesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutcomesError';
  }
}
