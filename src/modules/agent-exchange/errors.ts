// Typed errors of the agent-exchange module. Consumers catch
// `AgentExchangeError` and branch on `code`; messages are for
// humans/logs, never for control flow — the same discipline every
// module applies.
//
// Error vocabulary (32 codes):
//   invalid_context       — a caller forgot/malformed the explicit
//                           TenantContext (ADR-0001: the context is
//                           asserted, never ambient);
//   invalid_plan_input    — malformed createExecutionPlan input (task
//                           shapes, dependency graph, member shapes,
//                           per-kind ref rules, bounds);
//   invalid_query         — malformed get/list query (validation);
//   invalid_transition_input — malformed complete/abandon input;
//   invalid_handoff_input — malformed recordHandoff input;
//   invalid_approval_input — malformed recordApproval input;
//   invalid_run_input     — malformed recordExecutionRun input;
//   plan_not_found        — uniform not-found for a missing OR foreign
//                           plan id (ADR-0001: cross-tenant access is
//                           indistinguishable from missing — no
//                           existence leak);
//   plan_already_terminal — completing/abandoning a plan whose lifecycle
//                           already ended (the transition is one-way,
//                           terminal);
//   plan_not_active       — recording a handoff or run against a plan
//                           that is completed/abandoned (relay and
//                           execution observations serve in-flight
//                           coordination only);
//   task_not_found        — a referenced task key does not exist in the
//                           plan;
//   member_not_found      — a referenced member key does not exist in
//                           the plan's organization;
//   goal_not_found        — the goal is missing, foreign or not ACTIVE
//                           (mapped from the goals contract);
//   fingerprint_not_found — a context fingerprint is missing or foreign
//                           (mapped from the context contract);
//   fingerprint_goal_mismatch — a routed fingerprint was derived for a
//                           DIFFERENT goal — routing goal G's work on
//                           goal H's context is incoherent;
//   fingerprint_plan_mismatch — a routed fingerprint is goal-matched
//                           but differs from the fingerprint the plan
//                           itself is conditioned on (coherence law);
//   strategy_not_found    — the info-strategy link is missing or
//                           foreign (mapped from the info-strategy
//                           contract);
//   recommendation_not_found — the org-lab recommendation link is
//                           missing or foreign (mapped from the org-lab
//                           contract);
//   recommendation_goal_mismatch — the recommendation is readable but
//                           was recorded for a DIFFERENT goal than the
//                           plan executes;
//   team_not_found        — the agent-team link is missing, foreign or
//                           not ACTIVE (mapped from the agent-teams
//                           contract);
//   body_ref_not_found    — an agent-body member references a body that
//                           is missing or foreign (mapped from the
//                           agent-body contract's uniform not-found);
//   body_ref_inactive     — an agent-body member references a retired
//                           body (a fresh organization references live
//                           bodies);
//   agent_ref_not_found   — a tenant-agent member references an agent
//                           that is missing or foreign (mapped from the
//                           agents contract);
//   agent_ref_inactive    — a tenant-agent member references a disabled
//                           agent;
//   marketplace_ref_not_found — a marketplace package member references
//                           a package that is not visible to this
//                           tenant or not INSTALLABLE — uniform, no
//                           existence leak (lock 26/27: publication and
//                           installation gating are the marketplace's
//                           authority, and a non-installable package is
//                           exactly as unusable as a missing one);
//   recruitment_ref_not_found — a member's recruitment provenance
//                           references a proposal that is missing or
//                           foreign (mapped from the agent-recruitment
//                           contract);
//   recruitment_not_approved — a member's recruitment provenance is
//                           readable but NOT approved — the exchange
//                           records organizations formed through real
//                           approved acquisitions only;
//   execution_not_found   — a run references an agents-module execution
//                           that is missing or foreign (mapped from the
//                           agents contract);
//   execution_agent_mismatch — a run references an execution belonging
//                           to a DIFFERENT agent than the task's
//                           assignee slot names (assignee governance:
//                           runs serve the organization the plan
//                           declared, not arbitrary agents);
//   approval_not_found    — an approval references an actions-module
//                           request that is missing or foreign (mapped
//                           from the actions contract);
//   approval_not_decided  — an approval references an action request
//                           that is still PENDING — the authority
//                           system has not decided yet, and the
//                           exchange records decisions only;
//   invalid_outcome_ref   — a run's outcome link is missing, foreign or
//                           not OPEN at record time (uniform, no
//                           existence leak).

export type AgentExchangeErrorCode =
  | 'invalid_context'
  | 'invalid_plan_input'
  | 'invalid_query'
  | 'invalid_transition_input'
  | 'invalid_handoff_input'
  | 'invalid_approval_input'
  | 'invalid_run_input'
  | 'plan_not_found'
  | 'plan_already_terminal'
  | 'plan_not_active'
  | 'task_not_found'
  | 'member_not_found'
  | 'goal_not_found'
  | 'fingerprint_not_found'
  | 'fingerprint_goal_mismatch'
  | 'fingerprint_plan_mismatch'
  | 'strategy_not_found'
  | 'recommendation_not_found'
  | 'recommendation_goal_mismatch'
  | 'team_not_found'
  | 'body_ref_not_found'
  | 'body_ref_inactive'
  | 'agent_ref_not_found'
  | 'agent_ref_inactive'
  | 'marketplace_ref_not_found'
  | 'recruitment_ref_not_found'
  | 'recruitment_not_approved'
  | 'execution_not_found'
  | 'execution_agent_mismatch'
  | 'approval_not_found'
  | 'approval_not_decided'
  | 'invalid_outcome_ref';

export class AgentExchangeError extends Error {
  constructor(
    public readonly code: AgentExchangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentExchangeError';
  }
}
