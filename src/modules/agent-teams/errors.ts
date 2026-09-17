// Typed errors of the agent-teams module (W023 — Agent Teams).
// Consumers catch `AgentTeamsError` and branch on `code`; messages are
// for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`team_not_found`) — the existence of another tenant's teams,
// versions or outcomes must never leak (ADR-0001), the uniform
// not-found discipline the actions, agents, llm and missions modules
// apply.
//
// `forbidden` is the authorization failure of the claim-gated writes
// (create/revise/activate/dissolve): a plain tenant member must not be
// able to mint or re-shape organizational actors — the same claim-gate
// discipline the agents module applies to agent definitions (the claim
// is the workforce's 'agents:administer').
//
// `forbidden_by_policy` is the authority-matrix refusal of a lifecycle
// transition (activation/dissolution): the W009 gate REJECTED the
// request — recorded by the actions module as evidence — and the team
// stands unchanged (lock 23: recruitment and termination obey
// policy/approval).
//
// `invalid_agent_ref` / `invalid_objective_ref` are cross-reference
// failures: a roster member that is not readable through the agents
// contract, or an outcome naming an objective the team's CURRENT
// version does not carry.

export type AgentTeamsErrorCode =
  | 'invalid_context'
  | 'invalid_team_input'
  | 'invalid_query'
  | 'forbidden'
  | 'team_not_found'
  | 'invalid_agent_ref'
  | 'member_agent_inactive'
  | 'invalid_objective_ref'
  | 'invalid_transition'
  | 'forbidden_by_policy'
  | 'team_conflict';

export class AgentTeamsError extends Error {
  constructor(
    public readonly code: AgentTeamsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentTeamsError';
  }
}
