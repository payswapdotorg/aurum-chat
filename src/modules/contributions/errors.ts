// Typed errors of the contributions module. Consumers catch
// `ContributionsError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`contribution_not_found` / `validation_not_found`) — the
// existence of another tenant's contributions must never leak
// (ADR-0001), on reads AND on writes: validating or measuring a
// foreign-tenant contribution id is reported as `contribution_not_found`,
// never as a transition error. The two validated cross-module references
// (the acquisition plan and the learning outcome) are uniformly
// `invalid_plan_ref` / `invalid_outcome_ref` for the same reason:
// missing, malformed and foreign-tenant ids are indistinguishable.

export type ContributionsErrorCode =
  | 'invalid_context'
  | 'invalid_contribution_input'
  | 'invalid_validation_input'
  | 'invalid_impact_input'
  | 'invalid_query'
  | 'invalid_plan_ref'
  | 'plan_unanswered'
  | 'invalid_outcome_ref'
  | 'impact_requires_validation'
  | 'contribution_conflict'
  | 'impact_conflict'
  | 'contribution_not_found'
  | 'validation_not_found';

export class ContributionsError extends Error {
  constructor(
    public readonly code: ContributionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContributionsError';
  }
}
