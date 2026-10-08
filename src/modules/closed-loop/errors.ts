// Typed errors of the closed-loop module. Consumers catch
// `ClosedLoopError` and branch on `code`; messages are for
// humans/logs, never for control flow — the same discipline every
// module applies.
//
// Error vocabulary (20 codes):
//   invalid_context        — a caller forgot/malformed the explicit
//                            TenantContext (ADR-0001: the context is
//                            asserted, never ambient);
//   invalid_cycle_input    — malformed recordLoopCycle input (goal id,
//                            predicted score, deviation arrays, note
//                            bounds);
//   invalid_deviation_input — malformed reality/knowledge deviation
//                            input (class-specific shape: a reality
//                            deviation needs expected/observed; a
//                            knowledge deviation needs severity and
//                            must NOT carry expected/observed);
//   invalid_signal_input   — malformed applyRankingSignal input
//                            (target seam/direction/magnitude/basis);
//   invalid_close_input    — malformed closeLoopCycle input;
//   invalid_query          — malformed get/list/trajectory/summary
//                            query;
//   cycle_not_found        — uniform not-found for a missing OR foreign
//                            loop cycle (ADR-0001: cross-tenant access
//                            is indistinguishable from missing — no
//                            existence leak);
//   cycle_not_open         — applying a ranking signal to a closed
//                            cycle (signals are derived from a live
//                            cycle's evidence);
//   cycle_already_closed   — closing an already-closed cycle (the
//                            lifecycle is one-way, terminal);
//   goal_not_found         — the subject goal is missing, foreign or
//                            malformed (mapped from the goals
//                            contract, uniform);
//   goal_not_active        — the subject goal is archived (the loop
//                            runs against current direction only);
//   run_not_found          — a cited execution run does not resolve on
//                            the plan (mapped from the agent-exchange
//                            contract);
//   lease_not_found        — a cited fabric lease is missing or
//                            foreign (mapped from the execution-fabric
//                            contract);
//   gap_not_found          — a cited coverage gap does not resolve on
//                            its snapshot (mapped from the coverage
//                            contract);
//   learning_update_not_found — a cited CompanyModel learning update is
//                            missing or foreign (mapped from the
//                            learning contract);
//   strategy_not_found     — a signal's info-strategy target is
//                            missing, foreign or retired (mapped from
//                            the info-strategy contract);
//   strategy_goal_mismatch — a signal's info-strategy target belongs
//                            to a DIFFERENT goal than the cited cycle;
//   candidate_not_found    — a signal's org-lab candidate target is
//                            missing or foreign (mapped from the
//                            org-lab contract);
//   recommendation_not_found — a cited org-lab calibration outcome
//                            (recommendation) is missing or foreign;
//   policy_mutation_refused — THE POLICY-AUTHORITY REFUSAL (typed,
//                            test-locked): a signal input that tries to
//                            address a policy/settings/authority
//                            surface instead of one of the three
//                            ranking input channels. The loop can never
//                            mutate policy — this code is the explicit,
//                            reviewable boundary of that law.

export type ClosedLoopErrorCode =
  | 'invalid_context'
  | 'invalid_cycle_input'
  | 'invalid_deviation_input'
  | 'invalid_signal_input'
  | 'invalid_close_input'
  | 'invalid_query'
  | 'cycle_not_found'
  | 'cycle_not_open'
  | 'cycle_already_closed'
  | 'goal_not_found'
  | 'goal_not_active'
  | 'run_not_found'
  | 'lease_not_found'
  | 'gap_not_found'
  | 'learning_update_not_found'
  | 'strategy_not_found'
  | 'strategy_goal_mismatch'
  | 'candidate_not_found'
  | 'recommendation_not_found'
  | 'policy_mutation_refused';

/** The module's typed error. */
export class ClosedLoopError extends Error {
  readonly code: ClosedLoopErrorCode;

  constructor(code: ClosedLoopErrorCode, message: string) {
    super(message);
    this.name = 'ClosedLoopError';
    this.code = code;
  }
}
