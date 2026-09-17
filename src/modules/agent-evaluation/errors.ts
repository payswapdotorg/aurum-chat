// Typed errors of the agent-evaluation module (W024 — Agent Evaluation
// and Termination). Consumers catch `AgentEvaluationError` and branch on
// `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`evaluation_not_found` / `decision_not_found`, and
// `agent_not_found` surfaced from the agents contract's uniform
// discipline) — the existence of another tenant's evaluations, options or
// decisions must never leak (ADR-0001).
//
// `forbidden` is the claim-gate failure of the lifecycle decisions:
// recording a RETAIN / MODIFY / TERMINATE decision for the tenant's agent
// workforce requires the agents module's 'agents:administer' authority
// claim (the W021 management discipline — a plain member may measure,
// but only management decides).
//
// `invalid_replacement_option` is the evidence-link failure of a
// termination decision that names a replacement option not belonging to
// its own evaluation — the decision basis must be the measured evidence
// it cites, never a foreign option.
//
// A refused termination is NOT an error: a decision the authority matrix
// forbids or a human rejects is RECORDED as a terminal `refused`
// decision (evidence, §24) and returned to the caller — exactly like a
// gated decision, which is recorded as `awaiting_approval` and returned.

export type AgentEvaluationErrorCode =
  | 'invalid_context'
  | 'invalid_evaluation_input'
  | 'invalid_decision_input'
  | 'invalid_query'
  | 'forbidden'
  | 'agent_not_found'
  | 'evaluation_not_found'
  | 'decision_not_found'
  | 'invalid_replacement_option'
  | 'invalid_transition';

export class AgentEvaluationError extends Error {
  constructor(
    public readonly code: AgentEvaluationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentEvaluationError';
  }
}
