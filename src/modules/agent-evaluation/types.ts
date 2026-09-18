// Public domain types of the agent-evaluation module (W024 — Agent
// Evaluation and Termination).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W024):
// "Measure outcome, cost, quality, utilization, security and replacement
//  options; lifecycle changes follow policy."
//
// ARCHITECTURE.md §15 (frozen): "Agents are organizational actors with
// role, capabilities, permissions, contract, objectives, budget, expected
// outcomes, performance metrics, cost, owner and review schedule." and
// "Agent lifecycle: PROPOSED → APPROVAL → RECRUITED → ACTIVE → EVALUATED
// → RETAIN / MODIFY / TERMINATE." W024 owns the EVALUATED tail of that
// lifecycle: the measurement of an ACTIVE agent's actual performance and
// the RETAIN / MODIFY / TERMINATE decisions that follow from it.
//
// Two record families carry the work item, kept deliberately distinct:
//
//  1. EVALUATIONS (`AgentEvaluation`) — the MEASUREMENT half. An
//     evaluation is a tenant-scoped, append-only EVIDENCE snapshot of ONE
//     agent's measured performance across the six dimensions the work
//     item names verbatim — outcome, cost, quality, utilization, security
//     and replacement options — computed from authoritative module state
//     through their public contracts (never their tables):
//       * outcome   — the learning module's outcomes tied to this agent
//                     (subject kind 'agent', W040): open/settled/
//                     abandoned counts, met/exceeded/missed assessments
//                     and the arithmetic expected-versus-realized sums;
//       * cost      — the agents module's executions and attempts (W021):
//                     integer-minor-unit cost totals, per-succeeded cost
//                     and normalized token/operation usage;
//       * quality   — terminal-outcome distribution, success rate, the
//                     deterministic failure-classification counts and
//                     measured dispatch latency;
//       * utilization — submissions, dispatches, distinct submitting
//                     principals, distinct active days and the derived
//                     submission intensity over the measured window;
//       * security  — the granted-versus-requested permission analysis
//                     (over-granted scopes), authority-matrix refusals,
//                     approval-gated submissions and human rejections,
//                     plus the deterministic findings list;
//       * replacement options — the caller-supplied alternatives (retain,
//                     modify, train, reassign, hire, automate, recruit,
//                     install, eliminate) assessed on the same dimensions
//                     (summary, integer-minor-unit estimated cost + ISO
//                     currency, weeks to impact), each with the
//                     deterministic cost comparison against the agent's
//                     MEASURED window cost.
//     An evaluation is derived intelligence, never authoritative business
//     state (lock 34 mirrored): what it measured and when is frozen
//     evidence (§24), but it decides nothing by itself.
//
//  2. LIFECYCLE DECISIONS (`AgentLifecycleDecision`) — the POLICY half:
//     "lifecycle changes follow policy" (§15; lock 23: "Agent recruitment
//     and termination obey policy/approval"; §20: the authority matrix
//     "applies uniformly to ... agent recruitment, agent termination ...").
//     A decision always follows from a measured evaluation (the required
//     `evaluationId` link — no decision without evidence) and always
//     requires the agents module's 'agents:administer' claim (managing
//     the agent workforce is a management action, the W021 discipline).
//     Beyond that the three changes route by their consequentiality:
//       * RETAIN  — the status quo stands. A recorded decision (evidence
//         only); nothing changes anywhere, so nothing further gates it.
//       * MODIFY  — the agent's contract will be changed. The decision is
//         recorded with the required `modificationSummary`; the mutation
//         itself is applied by management through the agents module's
//         claim-gated `updateAgent` (W021's own management-control
//         policy) — this module records WHY, evidence-linked.
//       * TERMINATE — the consequential §20 action. The decision is
//         submitted through the W009 authority matrix: kind
//         'agent-termination' (a CANONICAL_ACTION_KIND) at level EXECUTE,
//         because what is approved is the removal of an organizational
//         actor, not an advisory measurement. Under the built-in default
//         matrix EXECUTE is approval-gated, so out of the box no agent is
//         ever terminated without an explicit human decision; a tenant
//         may explicitly allow (a recorded POLICY approval) or forbid (a
//         terminal POLICY rejection) through setAuthorityPolicy.
//
// Termination lifecycle (the agents module's pump discipline — lock 36):
//
//   decideAgentLifecycle('terminate')
//     ├─ matrix allows            → 'approved'   (policy decision, not yet applied)
//     ├─ matrix approval_required → 'awaiting_approval' (a human decides)
//     └─ matrix forbids           → 'refused'    (terminal, evidence)
//   settleAgentLifecycleDecision()
//     ├─ still pending            → no-op (returned unchanged)
//     ├─ human rejected           → 'refused'    (terminal, evidence)
//     ├─ approved (policy/human)  → 'approved' → apply → 'applied' (terminal)
//
//   Applying a termination disables the agent definition through the
//   agents module's public contract (`updateAgent` status 'disabled' —
//   the only definition-level "off" state W021 exposes; the evaluation
//   layer owns the organizational TERMINATED semantics and its policy
//   evidence). Applying is idempotent and retryable.
//
// Tenancy (ADR-0001): every record is tenant-scoped; a foreign tenant's
// agent, evaluation, replacement option or decision is indistinguishable
// from a missing one (`agent_not_found` via the agents contract,
// `evaluation_not_found`, `decision_not_found`) — no existence leak.

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the migrations' CHECK constraints)
// ---------------------------------------------------------------------------

/**
 * The lifecycle changes W024 owns (ARCHITECTURE.md §15, frozen): the
 * EVALUATED tail "RETAIN / MODIFY / TERMINATE".
 */
export type AgentLifecycleChange = 'retain' | 'modify' | 'terminate';

/**
 * The lifecycle states of a termination decision (the retain/modify
 * decisions are recorded in one step and terminal from birth):
 *  * `awaiting_approval` — the W009 authority matrix gated the
 *    termination behind a human decision (live — lock 36);
 *  * `approved`          — the matrix allowed it (policy auto-approval);
 *    the termination is authorized but not yet applied (live);
 *  * `applied`           — the termination was applied (the agent
 *    definition disabled through the agents contract); terminal;
 *  * `refused`           — the matrix forbade it, or a human rejected
 *    the gated request; terminal, recorded as evidence;
 *  * `recorded`          — a retain/modify decision: evidence, terminal.
 */
export type AgentDecisionStatus =
  | 'recorded'
  | 'awaiting_approval'
  | 'approved'
  | 'applied'
  | 'refused';

/**
 * The replacement-option kinds an evaluation may compare — the
 * termination-side mirror of the acquisition alternatives
 * (ARCHITECTURE.md §13 solution options; the W022 recruitment
 * alternatives train/reassign/hire/automate/recruit/install) plus the
 * three W024-native postures: keep the agent as it is (`retain`), change
 * the agent's contract (`modify`) or retire the capability outright
 * (`eliminate` — the work is no longer needed, no replacement).
 */
export type AgentReplacementKind =
  | 'retain'
  | 'modify'
  | 'train'
  | 'reassign'
  | 'hire'
  | 'automate'
  | 'recruit'
  | 'install'
  | 'eliminate';

/**
 * The deterministic cost comparison of one replacement option against
 * the agent's MEASURED window cost (integer minor units, same currency):
 *  * `lower_cost`   — the option's estimated cost is strictly below the
 *    measured cost;
 *  * `equal_cost`   — exactly equal;
 *  * `higher_cost`  — strictly above;
 *  * `unknown`      — the option carries no estimate or nothing was
 *    measured to compare against (honest over silent).
 */
export type ReplacementCostComparison =
  | 'lower_cost'
  | 'equal_cost'
  | 'higher_cost'
  | 'unknown';

/**
 * The deterministic security findings an evaluation may report. Findings
 * are computed, never caller-supplied:
 *  * `over_granted_scope`   — a permission scope the agent holds but no
 *    measured execution ever requested (least-privilege signal);
 *  * `execute_scope_granted`— the agent holds the highest §20 scope;
 *  * `policy_refusals_present` — the authority matrix forbade at least
 *    one measured submission;
 *  * `approval_rejections_present` — a human rejected at least one
 *    gated submission.
 */
export type AgentSecurityFindingCode =
  | 'over_granted_scope'
  | 'execute_scope_granted'
  | 'policy_refusals_present'
  | 'approval_rejections_present';

// ---------------------------------------------------------------------------
// The measured dimensions (computed — never caller-supplied)
// ---------------------------------------------------------------------------

/** The OUTCOME dimension: expected-versus-realized over the agent's tied outcomes (W040). */
export interface AgentOutcomeMetrics {
  /** Outcomes currently tied to this agent (subject kind 'agent'). */
  outcomesTotal: number;
  open: number;
  settled: number;
  abandoned: number;
  /** Assessment counts over settled outcomes. */
  met: number;
  exceeded: number;
  missed: number;
  /**
   * Arithmetic sums over settled outcomes (the learning module's
   * summarizeRealization caveat applies: metrics of different units may
   * be summed arithmetically; comparing across metrics is the reader's
   * interpretation).
   */
  settledExpectedTotal: number;
  settledRealizedTotal: number;
  /** Sum of (realized − expected) over settled outcomes. */
  netVarianceVsExpected: number;
}

/** The COST dimension: measured spend of the agent's executions (W021). */
export interface AgentCostMetrics {
  /** Executions included in the measurement basis. */
  executionsIncluded: number;
  /** True when the basis hit the agents contract's list ceiling (older executions may exist). */
  executionsTruncated: boolean;
  /** Sum of execution cost, integer minor units. */
  totalCostMinor: number;
  /** Always 'USD' (the agents module's canonical currency). */
  costCurrency: 'USD';
  /** Sum of cost over succeeded executions. */
  succeededCostMinor: number;
  /** totalCostMinor ÷ succeeded executions, rounded to whole minor units; null when none succeeded. */
  costPerSucceededMinor: number | null;
  /** Dispatch attempts included (evidence rows exist for each). */
  attemptsIncluded: number;
  /** Usage sums over attempts (null = no attempt reported that unit). */
  inputTokensTotal: number | null;
  outputTokensTotal: number | null;
  operationsTotal: number | null;
}

/** The QUALITY dimension: how well the agent's executions actually land (W021). */
export interface AgentQualityMetrics {
  succeeded: number;
  failed: number;
  refused: number;
  cancelled: number;
  /** Terminal executions included in the basis. */
  terminalCount: number;
  /** succeeded ÷ terminalCount (rounded to 4 decimals); null when nothing terminated yet. */
  successRate: number | null;
  /** Failure-classification counts over attempts (the W021 canonical codes). */
  dispatchFailedAttempts: number;
  dispatchRejectedAttempts: number;
  resultInvalidAttempts: number;
  /** Attempts classified retryable (transient transport failures). */
  retryableAttempts: number;
  /** Mean dispatch latency over attempts, whole ms; null when no attempts. */
  averageLatencyMs: number | null;
}

/** The UTILIZATION dimension: how much the agent is actually used (W021). */
export interface AgentUtilizationMetrics {
  /** Executions submitted in the measured window. */
  submissions: number;
  /** Still-live executions (awaiting_approval / queued). */
  live: number;
  /** Distinct submitting principals. */
  distinctPrincipals: number;
  /** Distinct UTC dates with at least one submission. */
  distinctActiveDays: number;
  /** The measured window (derived — see `AgentEvaluation.window`). */
  windowDays: number;
  /** submissions ÷ windowDays, rounded to 4 decimals. */
  submissionsPerDay: number;
  /** ISO 8601 — earliest submission included; null when none. */
  firstSubmissionAt: string | null;
  /** ISO 8601 — latest submission included; null when none. */
  lastSubmissionAt: string | null;
}

/** One computed security finding (deterministic — never caller-supplied). */
export interface AgentSecurityFinding {
  code: AgentSecurityFindingCode;
  /** What the finding is about (e.g. the over-granted scope name). */
  subject: string | null;
  detail: string;
}

/** The SECURITY dimension: permission posture and authority interactions (W021 + W009 via W021 evidence). */
export interface AgentSecurityMetrics {
  /** The granted permission scopes at evaluation time (decision-time snapshot). */
  grantedPermissions: string[];
  /** How often each scope was requested by measured executions (requested-within-grant only). */
  requestedScopeCounts: Record<string, number>;
  /** Granted scopes no measured execution ever requested (sorted). */
  overGrantedScopes: string[];
  /** Submissions the authority matrix gated behind human approval. */
  approvalGated: number;
  /** Submissions the matrix forbade (terminal 'refused', execution_forbidden). */
  policyRefusals: number;
  /** Gated submissions a human rejected (terminal 'refused', approval_rejected). */
  approvalRejections: number;
  /** The deterministic findings list (may be empty — an honest clean bill). */
  findings: AgentSecurityFinding[];
}

/** The measurement-basis metadata (what the evaluation actually saw). */
export interface AgentEvaluationBasis {
  /** Executions included (the agents contract returns the most recent first). */
  executionsIncluded: number;
  attemptsIncluded: number;
  /** Learning outcomes included. */
  outcomesIncluded: number;
  /** True when the executions basis hit the agents contract's list ceiling. */
  executionsTruncated: boolean;
  /** True when the outcomes basis hit the learning contract's list ceiling. */
  outcomesTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Replacement options (the compared alternatives)
// ---------------------------------------------------------------------------

/** Input shape of one replacement option (assessed on the same dimensions). */
export interface ReplacementOptionInput {
  kind: AgentReplacementKind;
  /** What this option concretely proposes (1..2000 chars, required). */
  summary: string;
  note?: string | null;
  /** Estimated cost over a period comparable to the measured window; integer minor units. */
  estimatedCostMinor?: number | null;
  /** ISO 4217 code; defaults to 'USD' (the measured currency). */
  estimatedCostCurrency?: string | null;
  /** Time to impact in weeks. */
  estimatedWeeks?: number | null;
  /** At most one option per evaluation may carry this flag. */
  recommended?: boolean;
}

/** One recorded replacement option (computed fields added by the service). */
export interface ReplacementOption {
  id: string;
  tenantId: string;
  evaluationId: string;
  kind: AgentReplacementKind;
  summary: string;
  note: string | null;
  estimatedCostMinor: number | null;
  estimatedCostCurrency: string | null;
  estimatedWeeks: number | null;
  recommended: boolean;
  /** estimatedCostMinor − measured totalCostMinor; null when unknown. */
  costDeltaMinor: number | null;
  /** The deterministic comparison against the measured cost. */
  costComparison: ReplacementCostComparison;
}

// ---------------------------------------------------------------------------
// The evaluation (measurement — append-only evidence)
// ---------------------------------------------------------------------------

/**
 * One agent evaluation: the measured six-dimension snapshot plus the
 * compared replacement options. Immutable from birth (storage triggers
 * reject UPDATE/DELETE on both tables) — a later measurement is a NEW
 * evaluation; what was measured and when is §24 decision evidence.
 */
export interface AgentEvaluation {
  id: string;
  tenantId: string;
  /** The evaluated agent (opaque uuid; the agents module stays the verification point). */
  agentId: string;
  /** Decision-time agent snapshot (what was evaluated). */
  agent: {
    slug: string;
    role: string;
    provider: string;
    status: string;
    permissions: string[];
  };
  /** The measured window: earliest → latest included submission; the evaluation instant when none. */
  windowFrom: string;
  windowTo: string;
  outcome: AgentOutcomeMetrics;
  cost: AgentCostMetrics;
  quality: AgentQualityMetrics;
  utilization: AgentUtilizationMetrics;
  security: AgentSecurityMetrics;
  basis: AgentEvaluationBasis;
  /** The compared replacement options (1..9, distinct kinds). */
  replacementOptions: ReplacementOption[];
  /** The authenticated TenantContext principal that recorded the evaluation. */
  recordedBy: string;
  /** ISO 8601 — when the measurement was committed (service clock). */
  recordedAt: string;
}

/** Input shape of `recordAgentEvaluation` (all measurements are computed, never supplied). */
export interface RecordAgentEvaluationInput {
  agentId: string;
  /** 1..9 replacement options with DISTINCT kinds (the work item measures replacement options). */
  replacementOptions: ReplacementOptionInput[];
}

/** Query shape of `listAgentEvaluations`. */
export interface ListAgentEvaluationsQuery {
  agentId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getAgentEvaluation`. */
export interface GetAgentEvaluationQuery {
  evaluationId: string;
}

// ---------------------------------------------------------------------------
// The lifecycle decision (policy)
// ---------------------------------------------------------------------------

/** The frozen W009 gate snapshot a termination decision carries from submission time. */
export interface DecisionPolicySnapshot {
  /** The linked action request (kind 'agent-termination', level EXECUTE). */
  actionRequestId: string;
  /** The matrix outcome at submission: allowed / approval_required / forbidden. */
  policyOutcome: 'allowed' | 'approval_required' | 'forbidden';
  /** Which policy row decided: kind / tenant-default / built-in. */
  policyResolvedVia: 'kind' | 'tenant-default' | 'built-in';
  /** The principal that submitted the decision to the gate. */
  submittedBy: string;
  /** ISO 8601 — when the submission landed. */
  submittedAt: string;
  /** 'policy' when the matrix decided on its own; 'principal' when a human did. */
  decidedBy: 'policy' | 'principal' | null;
  /** The deciding human principal; null on policy decisions and while pending. */
  decidedByPrincipal: string | null;
  /** ISO 8601 — when the decision landed; null while pending. */
  decidedAt: string | null;
}

/**
 * One agent lifecycle decision (the RETAIN / MODIFY / TERMINATE tail of
 * §15). The substantive content (agent, evaluation link, change,
 * rationale, modification summary, replacement option) is immutable
 * history the moment it is recorded; only the lifecycle state ever
 * moves, and only forward.
 */
export interface AgentLifecycleDecision {
  id: string;
  tenantId: string;
  agentId: string;
  /** Agent slug at decision time (decision-time snapshot). */
  agentSlug: string;
  /** The measured evaluation this decision follows from (required — no decision without evidence). */
  evaluationId: string;
  change: AgentLifecycleChange;
  /** Why (1..2000 chars, required). */
  rationale: string;
  note: string | null;
  /** Required iff change = 'modify': what will be changed (applied via the agents module by management). */
  modificationSummary: string | null;
  /** Optional, terminate only: the chosen replacement option of the linked evaluation. */
  replacementOptionId: string | null;
  status: AgentDecisionStatus;
  /** The frozen W009 gate link; present exactly on terminate decisions. */
  policy: DecisionPolicySnapshot | null;
  /** ISO 8601 — when the termination was applied; null unless status = 'applied'. */
  appliedAt: string | null;
  /** The principal that applied the termination (the settle caller). */
  appliedByPrincipal: string | null;
  /** The authenticated TenantContext principal that recorded the decision. */
  recordedBy: string;
  /** ISO 8601 — when the decision was recorded. */
  recordedAt: string;
  /** ISO 8601 — last lifecycle move (equals recordedAt until then). */
  updatedAt: string;
}

/** Input shape of `decideAgentLifecycle`. */
export interface DecideAgentLifecycleInput {
  /** The measured evaluation the decision follows from (must reference the same agent). */
  evaluationId: string;
  change: AgentLifecycleChange;
  /** Why (1..2000 chars, required — terminal decisions record their why). */
  rationale: string;
  note?: string | null;
  /** Required iff change = 'modify': what will be changed. */
  modificationSummary?: string | null;
  /** Optional, terminate only: the chosen replacement option of the linked evaluation. */
  replacementOptionId?: string | null;
}

/** Input shape of `settleAgentLifecycleDecision` (the pump — resolves and applies). */
export interface SettleAgentLifecycleDecisionInput {
  decisionId: string;
}

/** Query shape of `getAgentLifecycleDecision`. */
export interface GetAgentLifecycleDecisionQuery {
  decisionId: string;
}

/** Query shape of `listAgentLifecycleDecisions`. */
export interface ListAgentLifecycleDecisionsQuery {
  agentId?: string;
  change?: AgentLifecycleChange;
  status?: AgentDecisionStatus;
  /** 1..500, default 50. */
  limit?: number;
}
