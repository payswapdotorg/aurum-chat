// ============================================================================
// agent-supervision — the ONLY public surface of the agent-supervision
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W098 — Persistent Agent Supervision and Recovery:
// "Prove durable agent health, review schedules, budgets, waiting
//  states, recovery and resumptions independent of worker lifetime."
// Acceptance: "worker/process failure does not terminate organizational
// actor state; review and lifecycle controls remain authoritative;
// budget and permissions survive resume."
//
// THE MODULE owns the SUPERVISION layer of the agent workforce — the
// organizational actor's ongoing EMPLOYMENT state that §15 names
// ("owner ... review schedule ... budget") and that no earlier work
// item owns: W021 owns definitions/executions, W022–W024 own
// recruitment/teams/evaluation. Every fact here is a PostgreSQL row
// (lock 35), so a worker's death terminates NOTHING: a fresh
// supervisor reads the same durable state and continues (lock 36 —
// the W080 acceptance property, applied to supervision).
//
//   Registration and controls (claim-gated 'agents:administer' — the
//   W021 claim discipline, reused verbatim so one claim administers
//   the whole actor lifecycle):
//   registerSupervisedAgent — idempotently place ONE agent under
//      supervision: owner, review cadence, health cadence, budget
//      envelope and permission ceiling (defaulting to the agent's
//      CURRENT W021 grant, snapshotted through the agents contract).
//      Re-registering reports created:false — the first registration
//      stands (the registerAgent discipline).
//   updateSupervision — the mutable management controls (owner,
//      cadences, ceiling). A cadence change re-arms the schedule.
//   grantSupervisionBudget — append-only-evidenced budget grant; it
//      is ALSO the recovery authority of the paused_budget waiting
//      state (the grant resumes the actor).
//   suspendSupervision / resumeSupervision — the management
//      suspension waiting state. Suspension is recorded FIRST
//      (authoritative), and its enforcement — cancelling the actor's
//      LIVE supervised executions through the agents module's public
//      cancelAgentExecution — is a bounded, crash-recoverable pump
//      unit, so a worker death mid-enforcement loses nothing.
//
//   Work admission (where budget and permissions BITE):
//   submitSupervisedExecution — admission against the CURRENT durable
//      supervision contract: the actor must be active (each waiting
//      state refuses with its recovery authority), the requested
//      scopes must fit the supervision ceiling, and the budget must
//      not be exhausted. The admitted submission then flows through
//      the W021 gateway UNCHANGED (grant check, W009 authority gate,
//      idempotency), stamped with the supervision causation identity
//      `agent-supervision:<id>` so supervised work stays attributable
//      and enforceable. A refused admission records NOTHING (the W021
//      permission_not_granted discipline).
//
//   Reviews (the review authority):
//   The pump fires due reviews (active → waiting_review, exactly
//   once — a guarded transition). completeSupervisionReview settles
//   them: continue / adjust (controls + budget applied atomically) /
//   suspend / terminate_proposal. A terminate_proposal MUST cite a
//   W024 agent lifecycle decision (change 'terminate', same agent)
//   and moves the actor to waiting_termination — supervision NEVER
//   terminates (lock 21 mirrored at the actor level): the pump
//   settles from the W024 decision's authoritative status (applied →
//   terminated, refused → back to active with a fresh cadence).
//   getSupervisionReviewContext composes the reviewer's evidence —
//   the agent summary (W021), team memberships (W023) and the latest
//   measured evaluation (W024) — through public contracts only.
//
//   Health (durable, evidence-derived):
//   observeSupervisedAgentHealth — computes the actor's health from
//   the agents module's execution evidence (bounded window, pure
//   deterministic assessment — 'unknown' is first-class when no
//   evidence exists) and records it durably. Any worker, fresh or
//   old, computes the same health from the same evidence.
//
//   Budgets (exactly-once accounting):
//   The pump ledgers W021 dispatch attempts into an append-only
//   spend ledger under a UNIQUE (tenant, attempt) key — a crashed,
//   restarted or duplicated supervisor can neither double-count nor
//   lose spend. listSupervisionBudgetEntries exposes the ledger;
//   exhaustion fires the paused_budget waiting state.
//
//   Supervisor sessions (the durable worker-lifetime ledger):
//   beginSupervisorSession / heartbeatSupervisorSession /
//   endSupervisorSession — a session is a lease row: it carries NO
//   supervision truth, it OBSERVES worker lifetime. A session whose
//   lease expired is recovered by the next session, durably (the
//   dead row is marked 'lease_expired_recovered' with the recovering
//   session id, and a 'session_recovered' event lands in the
//   append-only trail). The pump optionally runs UNDER a session
//   (attribution): a dead session's id is refused with
//   `session_not_live` — the fresh worker recovers by beginning its
//   own session.
//
//   The pump (the worker seam — the W080 discipline):
//   pumpSupervision advances EXACTLY ONE bounded durable unit per
//   call, in a fixed priority order (settle waiting_termination →
//   enforce suspension/termination on live work → fire a due review
//   → ledger one attempt → fire budget exhaustion → refresh stale
//   health). Every transition is a guarded optimistic UPDATE — a
//   racing or restarted pump changes nothing ('idle').
//
// There is deliberately NO operation to erase supervision records,
// reviews, events, budget entries or sessions, and no way to rewrite
// a recorded review, a ledgered cost or a recovered session: the
// supervision trail is append-only evidence (PostgreSQL triggers
// enforce it — see migrations/). Terminal 'terminated' is the end of
// the lifecycle; a new actor is a new agent under W022's recruitment
// policy.
//
// Tenancy (ADR-0001): every operation takes an explicit
// TenantContext and is tenant-scoped at the SQL layer; another
// tenant's supervision records, reviews, events, budget entries and
// sessions are indistinguishable from missing ones — no existence
// leak.
//
// Dependency posture (WORK-ITEM-CATALOG W098 ← W080, W021, W023,
// W024; all four verified present at the reviewed base): this module
// imports ONLY module contracts — agents (W021: agent validation,
// execution submission/cancellation, execution and attempt evidence
// for health and the budget ledger), agent-teams (W023: team
// memberships in the review context), agent-evaluation (W024: the
// latest evaluation in the review context; the authoritative
// lifecycle decision a termination proposal defers to). W080's
// durable-pump discipline — bounded unit, guarded transition, lease
// recovery, exactly-once materialization — is consumed SEMANTICALLY
// (the same posture the agents module took toward cognition W013):
// supervision schedules its own durable state machines and starts no
// workflow runs, so no workflow contract import is needed.
// ============================================================================

export {
  // Registration and controls
  registerSupervisedAgent,
  updateSupervision,
  grantSupervisionBudget,
  resumeSupervision,
  suspendSupervision,
  // Reads
  getSupervision,
  listSupervisions,
  // Work admission
  submitSupervisedExecution,
  // Reviews
  completeSupervisionReview,
  getSupervisionReview,
  getSupervisionReviewContext,
  listSupervisionReviews,
  // Events and budget ledger
  listSupervisionBudgetEntries,
  listSupervisionEvents,
  // Health
  observeSupervisedAgentHealth,
  // Supervisor sessions (worker-lifetime ledger)
  beginSupervisorSession,
  endSupervisorSession,
  getSupervisorSession,
  heartbeatSupervisorSession,
  listSupervisorSessions,
  // The worker seam
  pumpSupervision,
} from './service';

// Pure vocabulary and supervision policy (no TenantContext needed).
export {
  AGENTS_AUTHORITY_ADMINISTER,
  SUPERVISION_HEALTH_STATES,
  SUPERVISION_REVIEW_OUTCOMES,
  SUPERVISION_STATUSES,
  SUPERVISION_TERMINAL,
  SUPERVISION_WAITING,
  WAITING_STATE_RECOVERY,
  budgetRemainingMinor,
  canAdministerSupervision,
  isBudgetExhausted,
  isHealthObservationDue,
  isReviewDue,
  isSupervisionHealthState,
  isSupervisionReviewOutcome,
  isSupervisionStatus,
  isSupervisedExecution,
  isTerminalSupervisionStatus,
  isWaitingSupervisionStatus,
  missingCeilingScope,
  nextReviewAfterCompletion,
  statusAfterReview,
  supervisionCausationKey,
  supervisionIdOfCausation,
} from './policy';
export type {
  SupervisionHealthWord,
  SupervisionReviewOutcomeWord,
  SupervisionStatusWord,
} from './policy';

// The deterministic health core (pure functions over contract data).
export {
  DEGRADED_FAILURE_RATE,
  MIN_DECIDED_FOR_RATIO,
  STALE_LIVE_AFTER_SECONDS,
  STALE_UNHEALTHY_THRESHOLD,
  UNHEALTHY_FAILURE_RATE,
  UNHEALTHY_MIN_DECIDED,
  assessAgentHealth,
  defaultHealthWindow,
} from './health';
export type { AgentHealthAssessment, AgentHealthEvidence } from './health';

export { AgentSupervisionError } from './errors';
export type { AgentSupervisionErrorCode } from './errors';

export {
  BUDGET_SCAN_EXECUTION_LIMIT,
  DEFAULT_HEALTH_INTERVAL_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_REVIEW_INTERVAL_SECONDS,
  EVIDENCE_SCAN_LIMIT,
  MAX_HEALTH_INTERVAL_SECONDS,
  MAX_LEASE_SECONDS,
  MAX_LIST_LIMIT,
  MAX_MINOR_UNITS,
  MAX_NOTE_CHARS,
  MAX_OWNER_PRINCIPAL_CHARS,
  MAX_PERMISSIONS,
  MAX_RATIONALE_CHARS,
  MAX_REASON_CHARS,
  MAX_REVIEW_INTERVAL_SECONDS,
  MIN_HEALTH_INTERVAL_SECONDS,
  MIN_LEASE_SECONDS,
  MIN_REVIEW_INTERVAL_SECONDS,
  SUPERVISION_EVENT_KINDS,
  isSupervisionEventKind,
  isUuid,
} from './validation';

export type {
  AgentHealthState,
  AgentSupervisionBudgetEntry,
  AgentSupervisionEvent,
  AgentSupervisionEventKind,
  AgentSupervisionRecord,
  AgentSupervisionReview,
  AgentSupervisorSession,
  BeginSupervisorSessionInput,
  CompleteSupervisionReviewInput,
  EndSupervisorSessionInput,
  GetSupervisionQuery,
  GetSupervisionReviewQuery,
  GetSupervisorSessionQuery,
  GrantSupervisionBudgetInput,
  HeartbeatSupervisorSessionInput,
  ListSupervisionBudgetEntriesQuery,
  ListSupervisionEventsQuery,
  ListSupervisionReviewsQuery,
  ListSupervisionsQuery,
  ListSupervisorSessionsQuery,
  RegisterSupervisedAgentInput,
  RegisterSupervisedAgentResult,
  ResumeSupervisionInput,
  SubmitSupervisedExecutionInput,
  SupervisionAgentSummary,
  SupervisionEvaluationSummary,
  SupervisionPumpInput,
  SupervisionPumpOutcome,
  SupervisionPumpStatus,
  SupervisionReviewAdjustments,
  SupervisionReviewContext,
  SupervisionReviewOutcome,
  SupervisionTeamMembership,
  SuspendSupervisionInput,
  UpdateSupervisionInput,
} from './types';
export {
  SUPERVISION_TERMINAL_STATUSES,
  SUPERVISION_WAITING_STATUSES,
} from './types';
