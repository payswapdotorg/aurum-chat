// ============================================================================
// agent-evaluation — the ONLY public surface of the agent-evaluation
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W024 — Agent Evaluation and Termination:
// "Measure outcome, cost, quality, utilization, security and replacement
//  options; lifecycle changes follow policy."
//
//   The measurement (the first half of the work item):
//   recordAgentEvaluation — freeze ONE append-only evidence snapshot of
//      ONE agent's measured performance across the six dimensions the
//      work item names verbatim. Outcome, cost, quality, utilization
//      and security are COMPUTED from authoritative module state
//      through their public contracts — the agents module's executions
//      and append-only attempt evidence (W021: cost, usage, latency,
//      failure classifications, permission scopes, authority outcomes)
//      and the learning module's outcomes tied to the agent (W040:
//      open/settled/abandoned, met/exceeded/missed, expected-versus-
//      realized) — never from caller input and never from another
//      module's tables. Replacement options are the caller's structured
//      alternatives (retain/modify/train/reassign/hire/automate/
//      recruit/install/eliminate — the §13 solution-option vocabulary
//      mirrored), each assessed on the same dimensions and each with
//      the DETERMINISTIC cost comparison against the measured window
//      cost (measurement.ts). At most one option is `recommended`.
//   getAgentEvaluation / listAgentEvaluations — tenant-scoped reads
//      with the uniform not-found discipline (ADR-0001), newest first,
//      filterable by agent.
//
//   The policy (the second half — §15 "lifecycle changes follow
//   policy", §20/lock 23 "Agent recruitment and termination obey
//   policy/approval"):
//   decideAgentLifecycle — record one RETAIN / MODIFY / TERMINATE
//      decision that ALWAYS follows from a measured evaluation (the
//      required evidence link) and ALWAYS requires the agents module's
//      'agents:administer' claim (managing the agent workforce is a
//      management action, the W021 discipline). Retain/modify decisions
//      are recorded evidence; a modify's actual mutation is applied by
//      management through the agents module's own claim-gated
//      updateAgent. TERMINATE routes through the W009 authority matrix
//      — kind 'agent-termination' (a CANONICAL_ACTION_KIND, §20) at
//      level EXECUTE — so under the built-in default matrix no agent is
//      ever terminated without an explicit human decision; a tenant may
//      explicitly allow or forbid through setAuthorityPolicy. The gate
//      idempotency key is derived from the decision id, so an
//      interrupted submission replays the SAME request on retry.
//   settleAgentLifecycleDecision — the W021 pump precedent (lock 36):
//      resolve a gated termination by reading its linked action request
//      (still pending → returned unchanged; human-rejected → terminal
//      'refused' with the deciding principal from the append-only
//      decision trail; human-approved → apply), then APPLY an approved
//      termination: the agent definition is disabled through the agents
//      module's public contract and the decision moves to its terminal
//      'applied' state. Idempotent and retryable — settling a terminal
//      decision is a read, and an interrupted apply leaves the decision
//      'approved' for the next pump.
//   getAgentLifecycleDecision / listAgentLifecycleDecisions — the
//      decision surface, filtered by agent/change/status.
//
// There is deliberately NO operation to update or delete an evaluation,
// a replacement option or a decision, and NO way to rewrite a measured
// number, a comparison, a gate snapshot or an application trail: the
// measurements are history the moment they are committed, and the
// decisions freeze their substantive content at recording (only the
// lifecycle state moves, and only forward). PostgreSQL itself enforces
// this via migration 001 triggers — not even a future module bypassing
// the service can rewrite recorded evidence (§24; lock 37). An
// evaluation never becomes authoritative business state (lock 34
// mirrored): it is the decision basis, linked by every lifecycle
// decision that cites it.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's agents (read
// through the agents contract), evaluations, replacement options and
// decisions are indistinguishable from missing ones — no existence
// leak.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W021 + W022 + W023
// → W024; MODULE-DEPENDENCY-MAP.md: `actions + llm → agents`): this
// module imports the actions contract (the W009 authority gate — §20
// "applies uniformly" to agent termination), the agents contract (the
// W021 definitions/executions/attempts surface — the measured workforce
// and the termination's applied effect) and the learning contract (the
// W040 outcome-measurement surface — the "measure outcome" half). The
// declared W022 (agent-recruitment) and W023 (agent-teams) dependencies
// are NOT merged into the reviewed base; nothing here depends on them —
// the replacement-option vocabulary mirrors the §13 solution options
// directly from the frozen architecture, and agent-team-level
// evaluation composes on top of this module once W023 lands.
// ============================================================================

export {
  // The measurement
  getAgentEvaluation,
  listAgentEvaluations,
  recordAgentEvaluation,
  // The policy
  decideAgentLifecycle,
  getAgentLifecycleDecision,
  listAgentLifecycleDecisions,
  settleAgentLifecycleDecision,
} from './service';

// Module-owned constants.
export {
  AGENT_TERMINATION_KIND,
  AGENT_TERMINATION_LEVEL,
} from './service';

export { AgentEvaluationError } from './errors';
export type { AgentEvaluationErrorCode } from './errors';

// Pure vocabulary and lifecycle routing (no TenantContext needed).
export {
  AGENT_DECISION_STATUSES,
  AGENT_DECISION_TERMINAL_STATUSES,
  AGENT_LIFECYCLE_CHANGES,
  AGENT_REPLACEMENT_KINDS,
  AGENT_TERMINATION_ACTION_KIND,
  AGENT_TERMINATION_AUTHORITY_LEVEL,
  AGENTS_AUTHORITY_ADMINISTER,
  canDecideAgentLifecycle,
  isAgentDecisionStatus,
  isAgentLifecycleChange,
  isAgentReplacementKind,
  isMatrixGated,
  isTerminalDecisionStatus,
  statusForGateOutcome,
} from './policy';

export type {
  AgentDecisionStatusWord,
  AgentLifecycleChangeWord,
  AgentReplacementKindWord,
  GateOutcome,
} from './policy';

// The deterministic measurement core — the single definitions of the
// six measured dimensions (pure functions over contract data; exported
// for verification and downstream learning surfaces, W054/W055).
export {
  compareReplacementCost,
  computeCostMetrics,
  computeOutcomeMetrics,
  computeQualityMetrics,
  computeSecurityMetrics,
  computeUtilizationMetrics,
  deriveWindow,
} from './measurement';

export {
  DEFAULT_LIST_LIMIT,
  MAX_COST_MINOR,
  MAX_LIST_LIMIT,
  MAX_MODIFICATION_SUMMARY_CHARS,
  MAX_NOTE_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_REPLACEMENT_OPTIONS,
  MAX_SUMMARY_CHARS,
  MAX_WEEKS,
  isUuid,
} from './validation';

export type {
  ValidatedDecideInput,
  ValidatedGetDecisionQuery,
  ValidatedGetEvaluationQuery,
  ValidatedListDecisionsQuery,
  ValidatedListEvaluationsQuery,
  ValidatedOption,
  ValidatedRecordEvaluationInput,
  ValidatedSettleInput,
} from './validation';

export type {
  AgentCostMetrics,
  AgentDecisionStatus,
  AgentEvaluation,
  AgentEvaluationBasis,
  AgentLifecycleChange,
  AgentLifecycleDecision,
  AgentOutcomeMetrics,
  AgentQualityMetrics,
  AgentReplacementKind,
  AgentSecurityFinding,
  AgentSecurityFindingCode,
  AgentSecurityMetrics,
  AgentUtilizationMetrics,
  DecideAgentLifecycleInput,
  DecisionPolicySnapshot,
  GetAgentEvaluationQuery,
  GetAgentLifecycleDecisionQuery,
  ListAgentEvaluationsQuery,
  ListAgentLifecycleDecisionsQuery,
  RecordAgentEvaluationInput,
  ReplacementCostComparison,
  ReplacementOption,
  ReplacementOptionInput,
  SettleAgentLifecycleDecisionInput,
} from './types';
