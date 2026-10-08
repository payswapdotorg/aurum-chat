// ============================================================================
// agent-exchange — the ONLY public surface of the agent-exchange module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W136 — Agent Exchange + Execution Plan + Cross-Agent Relay
// (spec/work-items/WORK-ITEM-CATALOG.md §W136):
// "Make Aurum a governed interface to specialist execution agents.
//  Persist a durable orchestration projection linking goal, tasks, agent
//  organization, handoffs, approvals, execution runs, results and
//  outcomes."
//
//   The projection's spine (the execution plan):
//   createExecutionPlan — append ONE plan atomically: the goal link
//      (W008, validated ACTIVE at write time, current version
//      snapshotted), the optional conditioning links (W134 fingerprint,
//      validated goal-matched; W134 info-strategy, validated readable;
//      W135 org-lab recommendation, validated readable AND goal-matched —
//      the organization evidence; W023 agent team, validated ACTIVE),
//      the task decomposition (1..64 keyed records with an ACYCLIC
//      dependency graph — validation.ts's exported taskGraphProblem is
//      the single deterministic legality definition) and the agent
//      organization's member references (the org-lab §5 comparison
//      set). Member references are governed at write time: agent-body
//      refs readable+active (W133), tenant-agent refs readable+active
//      (W021), marketplace package refs visible+INSTALLABLE (W028 —
//      acceptance law 1: platform approval is mandatory before a
//      package may join an organization), and every member's recruitment
//      provenance, when cited, a readable AND APPROVED agent-recruitment
//      proposal (W022 — acceptance law 1: recruitment uses Agent
//      Recruitment, never an exchange-invented path). Tasks and members
//      are IMMUTABLE from creation; only the plan's one-way lifecycle
//      moves.
//   completeExecutionPlan / abandonExecutionPlan — the one-way
//      active → completed | abandoned transitions (required retained
//      note/reason, exact-once stamps, staleness re-check under the row
//      lock — a racing transition that committed first owns the terminal
//      state).
//
//   The cross-agent relay (acceptance law 2 — context routing is
//   minimal and evidence-linked):
//   recordHandoff — append ONE immutable relay record: which MINIMAL
//      context traveled from which organization member to which other
//      for which task. The context package is STRUCTURALLY minimal: at
//      most one ContextFingerprint reference (validated readable,
//      goal-matched to the plan's goal, and equal to the plan's own
//      fingerprint when the plan carries one) plus explicit evidence
//      references. Handoffs serve ACTIVE plans only.
//
//   The governed approvals (the authority system decides, the exchange
//   records):
//   recordApproval — append ONE immutable approval record linking the
//      plan (or one of its tasks) to a REAL actions-module request
//      (W009) whose status is TERMINAL: the frozen decision snapshot
//      (status approved/rejected, kind, level, requester, decidedAt) is
//      consumed VERBATIM. A still-pending request refuses with
//      `approval_not_decided` — this surface never decides, anticipates
//      or rewords an authority outcome. A recorded REJECTION is exactly
//      as retainable as an approval (the house evidence law).
//
//   The execution runs (acceptance law 3 — progress/results return
//   through normalized agent contracts):
//   recordExecutionRun — append ONE immutable observation linking a
//      plan task to a REAL agents-module execution (W021, validated
//      readable): the run freezes the execution's normalized status,
//      result summary, cost, attempt count and completion time at
//      record time (a live execution records PROGRESS; a terminal one
//      records the RESULT — both arrive through the same normalized
//      contract), plus the minimal context routed to the agent and the
//      optional outcome link (a readable OPEN learning-module outcome —
//      the commitment BEFORE realization, the W054 prediction-hygiene
//      discipline). Assignee governance: when the task's member slot
//      names a tenant-agent, the referenced execution must belong to
//      THAT agent. Runs serve ACTIVE plans only.
//
// NO SECOND EXECUTION AUTHORITY (acceptance law 4, structural): no
// operation on this surface submits, dispatches, retries or cancels an
// execution, installs a package, recruits an agent or decides an
// approval. Every cross-module import the service makes is a READ
// (existence, state, snapshot); every mutation touches only this
// module's tables; handoffs, approvals and runs are append-only
// evidence (storage triggers reject UPDATE/DELETE/TRUNCATE). The agents
// module (W021) stays the one execution authority; W137 owns execution
// environments; W141 certifies the end-to-end journey.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's plans,
// handoffs, approvals and runs are indistinguishable from missing ones
// — no existence leak.
// ============================================================================

export {
  // The projection's spine
  createExecutionPlan,
  completeExecutionPlan,
  abandonExecutionPlan,
  // The cross-agent relay
  recordHandoff,
  // The governed approvals
  recordApproval,
  // The execution runs
  recordExecutionRun,
  // Reads
  getExecutionPlan,
  listExecutionPlans,
  listExecutionRuns,
  listHandoffs,
  listApprovals,
} from './service';

export { AgentExchangeError } from './errors';
export type { AgentExchangeErrorCode } from './errors';

// Guards + vocabularies + limits (pure; unit-testable without a database).
export {
  AGENT_EXECUTION_STATUSES,
  DEFAULT_LIST_LIMIT,
  EXECUTION_PLAN_STATUSES,
  EXECUTION_PLAN_TERMINAL_STATUSES,
  EXCHANGE_MEMBER_KINDS,
  MAX_CONTEXT_NOTE_CHARS,
  MAX_DEPENDS_ON,
  MAX_EVIDENCE_REF_CHARS,
  MAX_EVIDENCE_REFS,
  MAX_KEY_CHARS,
  MAX_LABEL_CHARS,
  MAX_LIST_LIMIT,
  MAX_MEMBERS,
  MAX_NOTE_CHARS,
  MAX_OBJECTIVE_CHARS,
  MAX_REASON_CHARS,
  MAX_REF_CHARS,
  MAX_TASKS,
  MAX_TASK_DETAIL_CHARS,
  MAX_TASK_TITLE_CHARS,
  MIN_TASKS,
  REF_REQUIRED_MEMBER_KINDS,
  assertAgentExchangeTenantContext,
  isExecutionPlanStatus,
  isExchangeMemberKind,
  isRefRequiredMemberKind,
  isTerminalExecutionPlanStatus,
  isUuid,
  taskGraphProblem,
  validateAbandonExecutionPlanInput,
  validateCompleteExecutionPlanInput,
  validateCreateExecutionPlanInput,
  validateGetExecutionPlanQuery,
  validateListApprovalsQuery,
  validateListExecutionPlansQuery,
  validateListExecutionRunsQuery,
  validateListHandoffsQuery,
  validateRecordApprovalInput,
  validateRecordExecutionRunInput,
  validateRecordHandoffInput,
} from './validation';
export type {
  TaskGraphInput,
  ValidatedAbandonExecutionPlanInput,
  ValidatedCompleteExecutionPlanInput,
  ValidatedContextPackage,
  ValidatedCreateExecutionPlanInput,
  ValidatedGetExecutionPlanQuery,
  ValidatedListExecutionPlansQuery,
  ValidatedMember,
  ValidatedPlanScopedListQuery,
  ValidatedRecordApprovalInput,
  ValidatedRecordExecutionRunInput,
  ValidatedRecordHandoffInput,
  ValidatedTask,
} from './validation';

// The domain vocabularies (types.ts is their single home; the frozen
// status/member-kind arrays are re-exported above through validation.ts).
export type {
  AbandonExecutionPlanInput,
  ApprovalDecisionSnapshot,
  CompleteExecutionPlanInput,
  ContextPackage,
  ContextPackageInput,
  CreateExecutionPlanInput,
  ExecutionPlan,
  ExecutionPlanStatus,
  ExecutionPlanSummary,
  ExecutionRun,
  ExchangeMember,
  ExchangeMemberInput,
  ExchangeMemberKind,
  GetExecutionPlanQuery,
  ListApprovalsQuery,
  ListExecutionPlansQuery,
  ListExecutionRunsQuery,
  ListHandoffsQuery,
  PlanApproval,
  PlanTask,
  PlanTaskInput,
  RecordApprovalInput,
  RecordExecutionRunInput,
  RecordHandoffInput,
  RelayHandoff,
} from './types';

// The frozen cross-module vocabularies this surface speaks, re-exported
// TYPE-ONLY through their owning contracts (the single legal
// cross-module imports, enforced by the architecture gate) so consumers
// never need to know where each union was frozen.
export type { AgentExecutionStatus } from '@/modules/agents/contract';
export type { OrgNodeKind } from '@/modules/org-lab/contract';
