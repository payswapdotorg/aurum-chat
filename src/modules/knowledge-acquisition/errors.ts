// Typed errors of the knowledge-acquisition module. Consumers catch
// `KnowledgeAcquisitionError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`mission_not_found` / `plan_not_found`) — the existence of
// another tenant's missions or planner decisions must never leak
// (ADR-0001), on reads AND on writes: planning against a foreign-tenant
// mission id is reported as `mission_not_found`, never as a state error,
// and person candidates that do not resolve to a readable person record
// in this tenant are excluded from selection with the uniform reason
// `person_unresolvable` (missing, malformed and foreign ids are
// indistinguishable there too).

export type KnowledgeAcquisitionErrorCode =
  | 'invalid_context'
  | 'invalid_plan_input'
  | 'invalid_outcome_input'
  | 'invalid_query'
  | 'mission_not_found'
  | 'mission_not_active'
  | 'plan_not_found'
  | 'outcome_conflict'
  | 'invalid_evidence';

export class KnowledgeAcquisitionError extends Error {
  constructor(
    public readonly code: KnowledgeAcquisitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeAcquisitionError';
  }
}
