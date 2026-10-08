// Public domain types of the agent-exchange module (W136 — Agent
// Exchange + Execution Plan + Cross-Agent Relay).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md §W136):
// "Make Aurum a governed interface to specialist execution agents.
//  Persist a durable orchestration projection linking goal, tasks, agent
//  organization, handoffs, approvals, execution runs, results and
//  outcomes."
// Acceptance: "recruitment uses Marketplace/Agent Recruitment; context
// routing is minimal and evidence-linked; progress/results return
// through normalized agent contracts; no second execution authority."
//
// WHAT THIS MODULE IS: the durable ORCHESTRATION PROJECTION — the
// exchange where Aurum's company intelligence loop meets the specialist
// execution agents that do the vertical work (ARCHITECTURE.md §1:
// "Customer support, project management, construction supervision,
// collections, sales operations, procurement operations, compliance
// execution and similar jobs belong to specialist agents, agent teams
// and software extensions recruited or installed under policy"). Every
// record here is a PROJECTION: a link, a snapshot or an observation.
// Nothing here executes anything.
//
// THE PROJECTION'S SPINE — the execution plan:
//   goal (W008, validated ACTIVE, version snapshotted) →
//   tasks (the decomposition: keyed, titled, dependency-ordered,
//          assignee-slotted records) →
//   agent organization (the W135/W023 seam: an org-lab recommendation
//          link and/or an agent-teams link, plus per-member references
//          with GOVERNED recruitment provenance) →
//   handoffs (the cross-agent relay: append-only records of what
//          context traveled between which members) →
//   approvals (governed: the W009 authority system decides, the
//          exchange records the frozen decision) →
//   execution runs (append-only observations linking plan tasks to the
//          agents module's REAL W021 executions, with the normalized
//          result/cost/progress snapshot and the outcome link).
//
// THE FOUR ACCEPTANCE LAWS, encoded structurally:
//   1. RECRUITMENT USES MARKETPLACE/AGENT RECRUITMENT — an organization
//      member that was recruited carries a reference to a REAL
//      agent-recruitment proposal (W022), validated readable AND
//      approved at write time; marketplace package members reference
//      REAL marketplace packages (W028), validated visible AND
//      INSTALLABLE (lock 26/27 — platform approval before install).
//      The exchange never recruits, installs or publishes anything.
//   2. CONTEXT ROUTING IS MINIMAL AND EVIDENCE-LINKED — the ONLY
//      context a handoff or a run may carry is a ContextPackage: at
//      most one context-fingerprint reference (W134, validated readable
//      and goal-matched) plus explicit evidence references. Never the
//      company model, never free-floating context blobs.
//   3. PROGRESS/RESULTS RETURN THROUGH NORMALIZED AGENT CONTRACTS — a
//      run references a REAL agents-module execution (W021) by id and
//      freezes its normalized status/summary/cost at record time; the
//      canonical result stays owned by the agents module (§16
//      "normalized result/evidence/cost/outcome").
//   4. NO SECOND EXECUTION AUTHORITY — no type or operation here
//      submits, dispatches, retries or cancels an execution. Every
//      cross-module import on the write path is a READ (existence,
//      state, snapshot); every mutation touches only this module's
//      tables. The agents module (W021) stays the one execution
//      authority; W137 owns execution environments.
//
// Append-only where the house evidence law demands (§24 "Audit records
// are append-only from the domain perspective"): handoffs, approvals and
// run records are immutable the moment they land (storage triggers
// reject UPDATE/DELETE/TRUNCATE). The plan pointer and its task/member
// content are immutable from creation — only the one-way
// active → completed/abandoned lifecycle moves.
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's plans, handoffs, approvals and runs are
// indistinguishable from missing ones (uniform not-found, no existence
// leak).

import type { AgentExecutionStatus } from '@/modules/agents/contract';
import type { OrgNodeKind } from '@/modules/org-lab/contract';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The kinds of actor an execution plan's organization may be composed of
 * — the org-lab §5 comparison set, owned there and consumed here as the
 * single frozen vocabulary (W136 composes W135; it never redefines it).
 */
export type ExchangeMemberKind = OrgNodeKind;

/** The plan lifecycle: one-way active → completed | abandoned. */
export type ExecutionPlanStatus = 'active' | 'completed' | 'abandoned';

// ---------------------------------------------------------------------------
// The minimal context package (acceptance law 2)
// ---------------------------------------------------------------------------

/**
 * THE ONLY context a relayed handoff or a recorded run may carry: at
 * most one ContextFingerprint reference (W134 — the derived, typed,
 * goal-matched context projection) plus explicit evidence references.
 * "Minimal and evidence-linked" is a STRUCTURAL property: there is no
 * field here through which a company model, a conversation history or
 * an unbounded context blob could travel.
 */
export interface ContextPackage {
  /** The context fingerprint the routing was conditioned on (validated goal-matched at write time). */
  fingerprintId: string | null;
  /** Explicit evidence references (opaque; ≤ MAX_EVIDENCE_REFS). */
  evidenceRefs: string[];
  note: string | null;
}

/** Input shape of `ContextPackage`. */
export interface ContextPackageInput {
  fingerprintId?: string | null;
  evidenceRefs?: string[];
  note?: string | null;
}

// ---------------------------------------------------------------------------
// The agent organization (the member references with governed recruitment)
// ---------------------------------------------------------------------------

/**
 * One member of the plan's agent organization: a role slot that may be
 * filled by any §5 actor kind. References are OPAQUE after write-time
 * validation except where a composed contract owns the verification
 * point (the org-lab precedent): agent-body refs validate readable +
 * active (W133), tenant-agent refs validate readable + active (W021),
 * marketplace package refs validate visible + INSTALLABLE (W028 —
 * acceptance law 1); human capabilities and external specialists stay
 * opaque (their registries own them).
 *
 * `recruitmentProposalId` is the governed-recruitment provenance: when a
 * member joined the organization through a REAL recruitment decision,
 * this references the agent-recruitment proposal (W022) that was
 * approved to acquire it — validated readable AND approved at write
 * time (acceptance law 1: the exchange never invents its own
 * recruitment path).
 */
export interface ExchangeMember {
  /** Unique within the plan (slug grammar — deterministic referencing). */
  memberKey: string;
  kind: ExchangeMemberKind;
  /** The role this member fills in the organization (1..128 chars). */
  role: string;
  /** Registry reference; required for agent-body, tenant-agent and marketplace kinds. */
  ref: string | null;
  /** Human-readable label for the referenced actor. */
  label: string | null;
  /** The approved agent-recruitment proposal that acquired this member, when one exists. */
  recruitmentProposalId: string | null;
}

/** Input shape of `ExchangeMember`. */
export interface ExchangeMemberInput {
  memberKey: string;
  kind: ExchangeMemberKind;
  role: string;
  ref?: string | null;
  label?: string | null;
  recruitmentProposalId?: string | null;
}

// ---------------------------------------------------------------------------
// The task decomposition
// ---------------------------------------------------------------------------

/**
 * One task of the plan's decomposition: a keyed, dependency-ordered
 * record. Task CONTENT is immutable from creation (a changed
 * decomposition is a NEW plan — the house "changed proposal" law);
 * progress is recorded through runs and handoffs, never by rewriting
 * the task.
 */
export interface PlanTask {
  taskId: string;
  /** Unique within the plan (slug grammar). */
  taskKey: string;
  title: string;
  detail: string | null;
  /** Other task keys this task depends on (acyclic, within the plan). */
  dependsOn: string[];
  /** The organization member slot responsible for this task, when assigned. */
  assigneeMemberKey: string | null;
  /** Deterministic order within the plan (input order). */
  position: number;
}

/** Input shape of `PlanTask`. */
export interface PlanTaskInput {
  taskKey: string;
  title: string;
  detail?: string | null;
  dependsOn?: string[];
  assigneeMemberKey?: string | null;
}

// ---------------------------------------------------------------------------
// The execution plan (the projection's spine)
// ---------------------------------------------------------------------------

/**
 * The durable orchestration projection linking one goal to its task
 * decomposition, its agent organization and everything that happened
 * while executing it. Links (all validated at write time, opaque after):
 * goal → goals (W008, ACTIVE); fingerprint → context (W134, goal-
 * matched); strategy → info-strategy (W134); recommendation → org-lab
 * (W135 §11, goal-matched — the organization evidence); team →
 * agent-teams (W023, ACTIVE).
 */
export interface ExecutionPlan {
  id: string;
  tenantId: string;
  goalId: string;
  /** The goal's current version at creation (§11-style revision pinning). */
  goalVersion: number;
  fingerprintId: string | null;
  strategyId: string | null;
  recommendationId: string | null;
  teamId: string | null;
  /** What this plan is executing toward (1..2000 chars). */
  objective: string;
  status: ExecutionPlanStatus;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
  /** The retained lifecycle note (the completion note or abandonment reason). */
  lifecycleNote: string | null;
  /** The decomposition, in deterministic position order. */
  tasks: PlanTask[];
  /** The agent organization's member references, keyed by memberKey. */
  members: ExchangeMember[];
}

/** Input shape of `createExecutionPlan`. */
export interface CreateExecutionPlanInput {
  goalId: string;
  fingerprintId?: string | null;
  strategyId?: string | null;
  recommendationId?: string | null;
  teamId?: string | null;
  objective: string;
  /** 1..64 task records (distinct keys, acyclic dependencies). */
  tasks: PlanTaskInput[];
  /** 0..32 organization member references. */
  members?: ExchangeMemberInput[];
  note?: string | null;
}

/** Input shape of `completeExecutionPlan` (the one-way terminal transition). */
export interface CompleteExecutionPlanInput {
  planId: string;
  /** Required completion note (1..2000 chars), retained. */
  note: string;
}

/** Input shape of `abandonExecutionPlan` (the one-way terminal transition). */
export interface AbandonExecutionPlanInput {
  planId: string;
  /** Required reason (1..512 chars), retained. */
  reason: string;
}

// ---------------------------------------------------------------------------
// The cross-agent relay (handoffs)
// ---------------------------------------------------------------------------

/**
 * One handoff — the cross-agent relay record: what MINIMAL context
 * traveled from one organization member to another for one task, when.
 * Append-only evidence (§24): the relay history is never rewritten.
 */
export interface RelayHandoff {
  id: string;
  tenantId: string;
  planId: string;
  taskKey: string;
  fromMemberKey: string;
  toMemberKey: string;
  /** The minimal, evidence-linked context that traveled (acceptance law 2). */
  context: ContextPackage;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordHandoff`. */
export interface RecordHandoffInput {
  planId: string;
  taskKey: string;
  fromMemberKey: string;
  toMemberKey: string;
  context?: ContextPackageInput;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// The governed approvals (the W009 authority system decides)
// ---------------------------------------------------------------------------

/**
 * The frozen authority decision an approval record carries — consumed
 * VERBATIM from the actions module's append-only request state at
 * record time (the exchange never decides, re-derives or rewords an
 * authority outcome; it records that the authority system decided).
 */
export interface ApprovalDecisionSnapshot {
  actionRequestId: string;
  actionKind: string;
  authorityLevel: string;
  /** The request's terminal status at snapshot time. */
  status: 'approved' | 'rejected';
  requestedBy: string;
  requestedAt: string;
  decidedAt: string;
}

/**
 * One approval record — governed evidence linking a plan (and
 * optionally one of its tasks) to a REAL actions-module decision
 * (W009). The action request must be terminal at record time: the
 * authority system has already decided (approved or rejected — a
 * rejection is retained evidence, exactly like an approval). Append-only.
 */
export interface PlanApproval {
  id: string;
  tenantId: string;
  planId: string;
  /** The task the approval governs, when task-scoped; null when plan-scoped. */
  taskKey: string | null;
  decision: ApprovalDecisionSnapshot;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordApproval`. */
export interface RecordApprovalInput {
  planId: string;
  taskKey?: string | null;
  /** The actions-module action request whose terminal decision is being recorded. */
  actionRequestId: string;
}

// ---------------------------------------------------------------------------
// The execution runs (progress/results through normalized contracts)
// ---------------------------------------------------------------------------

/**
 * One execution run — an append-only observation linking one plan task
 * to one REAL agents-module execution (W021). The run freezes the
 * execution's normalized state at record time: status, result summary,
 * cost and attempt count (a live execution records PROGRESS; a terminal
 * one records the RESULT — both arrive through the same normalized
 * agent contract, acceptance law 3). The canonical result payload
 * stays owned by the agents module; the exchange holds the reference
 * and the frozen summary only.
 *
 * `outcomeId` is the results-to-outcome link: a REAL learning-module
 * outcome (W040) validated readable and OPEN at record time (the
 * commitment BEFORE realization — the W054 prediction-hygiene
 * discipline inherited from org-lab).
 */
export interface ExecutionRun {
  id: string;
  tenantId: string;
  planId: string;
  taskKey: string;
  /** The agents-module agent that executed (denormalized from the execution at record time). */
  agentId: string;
  /** The agents-module execution this run observes (W021, validated readable). */
  agentExecutionId: string;
  /** The minimal, evidence-linked context routed to the agent for this run. */
  context: ContextPackage;
  /** The execution's status frozen at record time (W021 vocabulary, verbatim). */
  executionStatus: AgentExecutionStatus;
  /** The execution's normalized result summary frozen at record time (null while unreported). */
  resultSummary: string | null;
  /** The execution's accumulated cost at record time, integer minor units. */
  costMinor: number;
  /** Dispatch attempts performed at record time. */
  attemptsCount: number;
  /** The execution's terminal time at record time (null while live). */
  executionCompletedAt: string | null;
  /** The linked learning-module outcome (W040), when the run commits to one. */
  outcomeId: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordExecutionRun`. */
export interface RecordExecutionRunInput {
  planId: string;
  taskKey: string;
  /** The REAL agents-module execution this run observes. */
  agentExecutionId: string;
  context?: ContextPackageInput;
  outcomeId?: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Query shape of `getExecutionPlan`. */
export interface GetExecutionPlanQuery {
  planId: string;
}

/** Query shape of `listExecutionPlans`. All filters AND-combined. */
export interface ListExecutionPlansQuery {
  goalId?: string;
  status?: ExecutionPlanStatus;
  recommendationId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listExecutionRuns`. */
export interface ListExecutionRunsQuery {
  planId: string;
  taskKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listHandoffs`. */
export interface ListHandoffsQuery {
  planId: string;
  taskKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listApprovals`. */
export interface ListApprovalsQuery {
  planId: string;
  taskKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** `listExecutionPlans` summary row (deep-link with `getExecutionPlan`). */
export interface ExecutionPlanSummary {
  id: string;
  tenantId: string;
  goalId: string;
  goalVersion: number;
  fingerprintId: string | null;
  recommendationId: string | null;
  teamId: string | null;
  status: ExecutionPlanStatus;
  taskCount: number;
  memberCount: number;
  objective: string;
  createdAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
}
