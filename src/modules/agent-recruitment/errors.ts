// Typed errors of the agent-recruitment module (W022 — Agent
// Recruitment). Consumers catch `AgentRecruitmentError` and branch on
// `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`proposal_not_found`) — the existence of another tenant's
// recruitment proposals must never leak (ADR-0001), the same uniform
// not-found discipline the actions/agents/capabilities modules apply.
// The capability link follows the same rule through the capabilities
// contract: another tenant's capability id reads the same as a missing
// one (`capability_not_found`).
//
// `invalid_transition` is the lifecycle discipline: only a `proposed`
// proposal can be submitted or withdrawn, and history never moves
// backwards (the goals/processes transition discipline).
//
// `forbidden` is the authorization failure of `withdrawRecruitmentProposal`:
// a draft may be withdrawn by its author or by an agent-workforce
// administrator (the agents module's 'agents:administer' claim — agent
// recruitment IS agent-workforce management); a plain member cannot
// retire someone else's draft. Submissions are NOT claim-gated — the W009
// authority matrix does the gating there (that is what "approval is
// explicit" means), exactly like `authorizeAction` itself.

export type AgentRecruitmentErrorCode =
  | 'invalid_context'
  | 'invalid_proposal_input'
  | 'invalid_query'
  // A lifecycle move the proposal's state does not permit (submitting or
  // withdrawing a non-draft, withdrawing a submitted proposal).
  | 'invalid_transition'
  // Withdrawal by a principal that is neither the author nor an
  // agent-workforce administrator.
  | 'forbidden'
  // The referenced capability does not exist in this tenant (uniform
  // cross-tenant not-found through the capabilities contract).
  | 'capability_not_found'
  | 'proposal_not_found';

export class AgentRecruitmentError extends Error {
  constructor(
    public readonly code: AgentRecruitmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRecruitmentError';
  }
}
