// Typed errors of the agent-supervision module (W098 — Persistent
// Agent Supervision and Recovery). Consumers catch
// `AgentSupervisionError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`supervision_not_found` / `review_not_found` /
// `session_not_found`) — the existence of another tenant's supervision
// records, reviews or sessions must never leak (ADR-0001), the uniform
// not-found discipline every module applies.
//
// `forbidden` is the authorization failure of the claim-gated
// management controls (register/update/grant/suspend/resume/review):
// supervising the agent workforce is a management action — the W021
// `agents:administer` claim discipline, reused verbatim so one claim
// administers the whole actor lifecycle.
//
// The admission failures are the module's enforcement heart:
//  * `not_active` — the actor sits in a waiting state (or is
//    terminated), so no NEW supervised work is admitted; the message
//    names the waiting state and its recovery authority;
//  * `scope_not_permitted` — the request exceeds the supervision
//    permission ceiling (checked before anything reaches the gateway);
//  * `budget_exhausted` — ledgered spend has reached the envelope.
//
// `review_not_due` keeps the review discipline strict: reviews complete
// from the `waiting_review` waiting state only. `invalid_decision_link`
// guards the W024 termination-proposal linkage (a cited decision must
// exist, be a termination, and belong to the same agent).
//
// `session_not_live` is the dead-worker discipline: an expired or ended
// supervisor session may not drive work — the caller recovers by
// beginning a fresh session (which durably records the recovery).

export type AgentSupervisionErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'forbidden'
  | 'supervision_not_found'
  | 'agent_not_found'
  | 'not_active'
  | 'scope_not_permitted'
  | 'budget_exhausted'
  | 'unlimited_budget'
  | 'review_not_due'
  | 'invalid_decision_link'
  | 'invalid_evaluation_link'
  | 'invalid_transition'
  | 'review_not_found'
  | 'session_not_found'
  | 'session_not_live';

export class AgentSupervisionError extends Error {
  constructor(
    public readonly code: AgentSupervisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSupervisionError';
  }
}
