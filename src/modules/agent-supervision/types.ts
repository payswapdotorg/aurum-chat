// Public domain types of the agent-supervision module (W098 — Persistent
// Agent Supervision and Recovery).
//
// W098 owns the SUPERVISION layer of the agent workforce (work item:
// "Prove durable agent health, review schedules, budgets, waiting
// states, recovery and resumptions independent of worker lifetime";
// acceptance: "worker/process failure does not terminate organizational
// actor state; review and lifecycle controls remain authoritative;
// budget and permissions survive resume").
//
// ARCHITECTURE.md §15 (frozen): "Agents are organizational actors with
// role, capabilities, permissions, contract, objectives, budget,
// expected outcomes, performance metrics, cost, owner and review
// schedule." The W021 gateway owns DEFINITIONS and EXECUTIONS; W022–W024
// own recruitment, teams and evaluation/termination. What none of them
// owns is the actor's ongoing EMPLOYMENT state — the owner, the review
// cadence, the budget envelope and its spend, the health observation,
// and the waiting states that pause the actor pending management
// action. That is this module, and every fact of it lives in
// PostgreSQL (lock 35), so none of it is held only in worker memory
// (lock 36; the W080 acceptance property, applied to supervision).
//
// The durable concepts:
//
//  * AgentSupervisionRecord — ONE persistent supervision record per
//    (tenant, agent): owner principal, health observation, review
//    schedule (cadence + next-due cursor), budget envelope and
//    ledgered spend, supervision permission ceiling, and the
//    supervision lifecycle including its WAITING STATES. The record is
//    live state: its identity columns never move; its control columns
//    move only through this module's audited operations (a storage
//    trigger enforces the partition — migrations/001).
//
//  * AgentSupervisionReview — the append-only record of one completed
//    review: outcome (continue/adjust/suspend/terminate_proposal),
//    rationale, optional cited W024 evaluation, and — for a termination
//    proposal — the REQUIRED W024 lifecycle decision link. Supervision
//    never terminates an agent itself (lock 21 mirrored at the actor
//    level): a terminate_proposal moves the actor into the
//    `waiting_termination` waiting state and defers to the W024
//    decision trail, which is where the §20-gated authority lives.
//
//  * AgentSupervisionBudgetEntry — the append-only, exactly-once-per-
//    attempt spend ledger. Every agent-execution attempt (W021
//    evidence) is ledgered at most once under its UNIQUE attempt key,
//    so a crashed, restarted or duplicated supervisor can neither
//    double-count nor lose spend. The ledger is the single source of
//    `budgetSpentMinor` truth.
//
//  * AgentSupervisorSession — the durable worker-lifetime ledger. A
//    supervisor (a worker process) begins a session with a lease,
//    heartbeats it, and ends it; a session whose lease expired is
//    RECOVERED by the next session (recorded durably). Sessions carry
//    no supervision truth — they are the observable evidence that
//    supervision outlives any single worker.
//
//  * AgentSupervisionEvent — the append-only supervision audit trail
//    (status transitions, health observations, budget grants and
//    consumption, review firing and completion, session lifecycle).
//    Storage triggers forbid UPDATE/DELETE/TRUNCATE outright (§24).
//
// Waiting states (the heart of "waiting states ... independent of
// worker lifetime"): `waiting_review` (a review came due and management
// must complete it), `paused_budget` (the envelope is exhausted and
// management must grant), `suspended` (management suspension; live
// supervised work is cancelled through the gateway's public contract),
// and `waiting_termination` (a termination proposal is deferring to the
// W024 decision). Each is recoverable through its authority: the
// review, the budget grant, the resume control, and the W024 decision
// settlement respectively.
//
// Budgets follow the house convention (IMPLEMENTATION-STACK §8):
// integer minor units, USD. A null envelope is unlimited (no
// exhaustion transitions); a set envelope is enforced at admission
// (new supervised work is refused once ledgered spend reaches it) and
// by the pump (the `paused_budget` waiting state fires on exhaustion).
// In-flight work may overshoot the envelope — the ledger records the
// true sum faithfully and `budgetRemainingMinor` clamps at zero.

import type { AgentPermissionScope } from '@/modules/agents/contract';

// ---------------------------------------------------------------------------
// Supervision lifecycle vocabulary
// ---------------------------------------------------------------------------

/**
 * The supervision lifecycle of one organizational actor:
 *  * `active`              — supervised and admitting work;
 *  * `waiting_review`      — WAITING: a review came due; the owner must
 *    complete it through `completeSupervisionReview`;
 *  * `paused_budget`       — WAITING: the budget envelope is exhausted;
 *    management must `grantSupervisionBudget`;
 *  * `suspended`           — WAITING: management suspension; live
 *    supervised executions are cancelled through the agents contract
 *    and `resumeSupervision` recovers;
 *  * `waiting_termination` — WAITING: a review proposed termination
 *    citing a W024 lifecycle decision; the pump settles from that
 *    decision's authoritative status;
 *  * `terminated`          — TERMINAL: the cited W024 termination was
 *    applied (the actor's employment state is history from then on).
 */
export type AgentSupervisionStatus =
  | 'active'
  | 'waiting_review'
  | 'paused_budget'
  | 'suspended'
  | 'waiting_termination'
  | 'terminated';

/** The states that wait on an external authority (management or W024). */
export const SUPERVISION_WAITING_STATUSES: readonly AgentSupervisionStatus[] = [
  'waiting_review',
  'paused_budget',
  'suspended',
  'waiting_termination',
] as const;

/** The terminal supervision state (history from then on). */
export const SUPERVISION_TERMINAL_STATUSES: readonly AgentSupervisionStatus[] = [
  'terminated',
] as const;

/**
 * The durable health assessment of one organizational actor, computed
 * from the agents module's execution evidence (never caller-supplied).
 * `unknown` is first-class (lock 7): an actor with no executions in the
 * observation window is not "healthy" — its health is UNKNOWN.
 */
export type AgentHealthState = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

// ---------------------------------------------------------------------------
// The supervision record
// ---------------------------------------------------------------------------

/**
 * The persistent supervision record of ONE agent — the actor's ongoing
 * employment state (§15's "owner ... review schedule ... budget"),
 * durable in PostgreSQL so it survives any worker's lifetime (W098
 * acceptance).
 *
 *  * `ownerPrincipal` — the accountable supervisor (management control,
 *    mutable through `updateSupervision`).
 *  * `permittedScopes` — the supervision permission CEILING: supervised
 *    work may only request scopes within it (intersected with the W021
 *    grant, which the gateway itself enforces). The ceiling is a
 *    supervision control, deliberately independent from the agent's
 *    own grant so management can narrow an actor's operating scope
 *    without touching its definition.
 *  * `reviewIntervalSeconds` / `nextReviewAt` / `lastReviewAt` /
 *    `reviewCount` — the durable review schedule. The pump fires due
 *    reviews (active → waiting_review) as guarded, exactly-once
 *    transitions; each completed review re-arms the cadence.
 *  * `budgetMinor` / `budgetSpentMinor` / `budgetRemainingMinor` — the
 *    envelope, the ledgered spend and the derived remainder (null
 *    envelope = unlimited).
 *  * `healthState` / `healthDetail` / `healthObservedAt` — the latest
 *    durable health observation (evidence-derived).
 *  * `terminationDecisionId` — the cited W024 lifecycle decision while
 *    waiting on (or settled by) a termination proposal.
 */
export interface AgentSupervisionRecord {
  id: string;
  tenantId: string;
  agentId: string;
  ownerPrincipal: string;
  status: AgentSupervisionStatus;
  healthState: AgentHealthState;
  healthDetail: string | null;
  /** ISO 8601 — when the latest health observation landed; null = never. */
  healthObservedAt: string | null;
  /** Review cadence, 60..31_536_000 seconds. */
  reviewIntervalSeconds: number;
  /** Health observation cadence, 60..2_592_000 seconds. */
  healthIntervalSeconds: number;
  /** ISO 8601 — the durable review-schedule cursor. */
  nextReviewAt: string;
  lastReviewAt: string | null;
  reviewCount: number;
  /** Budget envelope in integer minor units; null = unlimited. */
  budgetMinor: number | null;
  /** Ledgered spend in integer minor units (append-only budget entries). */
  budgetSpentMinor: number;
  /** max(0, budgetMinor − budgetSpentMinor); null when unlimited. */
  budgetRemainingMinor: number | null;
  /** The supervision permission ceiling (1..6 closed-vocabulary scopes). */
  permittedScopes: AgentPermissionScope[];
  /** The W024 lifecycle decision a termination proposal cited (waiting_termination/terminated). */
  terminationDecisionId: string | null;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on control/state changes only. */
  updatedAt: string;
}

/** Input shape of `registerSupervisedAgent` (idempotent per agent). */
export interface RegisterSupervisedAgentInput {
  agentId: string;
  /** The accountable supervisor principal; defaults to the caller. */
  ownerPrincipal?: string | null;
  /** Review cadence in seconds; default 2_592_000 (30 days). */
  reviewIntervalSeconds?: number | null;
  /** Health observation cadence in seconds; default 3600. */
  healthIntervalSeconds?: number | null;
  /** Budget envelope in minor units; null/omitted = unlimited. */
  budgetMinor?: number | null;
  /**
   * The supervision permission ceiling; defaults to the agent's CURRENT
   * W021 grant (snapshotted at registration through the agents contract).
   */
  permittedScopes?: AgentPermissionScope[] | null;
}

export interface RegisterSupervisedAgentResult {
  supervision: AgentSupervisionRecord;
  /** false when supervision for this agent already existed (first write wins). */
  created: boolean;
}

/** Input shape of `updateSupervision` (management controls only). */
export interface UpdateSupervisionInput {
  agentId: string;
  ownerPrincipal?: string | null;
  reviewIntervalSeconds?: number | null;
  healthIntervalSeconds?: number | null;
  permittedScopes?: AgentPermissionScope[] | null;
}

/** Input shape of `grantSupervisionBudget`. */
export interface GrantSupervisionBudgetInput {
  agentId: string;
  /** 1..2^53−1 minor units added to the envelope. */
  additionalMinor: number;
  note?: string | null;
}

/** Input shape of `suspendSupervision` (required reason). */
export interface SuspendSupervisionInput {
  agentId: string;
  reason: string;
}

/** Input shape of `resumeSupervision` (suspended → active). */
export interface ResumeSupervisionInput {
  agentId: string;
  note?: string | null;
}

export interface GetSupervisionQuery {
  agentId: string;
}

export interface ListSupervisionsQuery {
  status?: AgentSupervisionStatus;
  healthState?: AgentHealthState;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Supervision-gated work admission (the enforcement seam of budgets,
// permissions and waiting states)
// ---------------------------------------------------------------------------

/**
 * Input shape of `submitSupervisedExecution` — the supervision-gated
 * submission. Admission is evaluated against the CURRENT durable
 * supervision contract (status, ceiling, budget); the admitted
 * submission then flows through the W021 gateway unchanged
 * (`submitAgentExecution`: grant check, W009 authority gate,
 * idempotency), stamped with the supervision causation identity so
 * supervised executions stay attributable and cancellable by
 * supervision enforcement.
 */
export interface SubmitSupervisedExecutionInput {
  agentId: string;
  /** The task — any non-null plain JSON value (the W021 limits apply). */
  task: unknown;
  /** 1..6 permission scopes the execution operates at (must fit the ceiling). */
  requestedPermissions: AgentPermissionScope[];
  /** 1..5, default 3 (the W021 retry policy). */
  maxAttempts?: number | null;
  /** §25 correlation identity (passthrough). */
  correlationId?: string | null;
  /** Emitter dedupe key (passthrough; the W021 first-write-wins replay). */
  idempotencyKey?: string | null;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** The outcome of one completed supervision review. */
export type SupervisionReviewOutcome =
  | 'continue'
  | 'adjust'
  | 'suspend'
  | 'terminate_proposal';

/** The atomic adjustments a review with outcome `adjust` may apply. */
export interface SupervisionReviewAdjustments {
  ownerPrincipal?: string | null;
  reviewIntervalSeconds?: number | null;
  healthIntervalSeconds?: number | null;
  permittedScopes?: AgentPermissionScope[] | null;
  /** Budget added to the envelope by the review (a grant, ledgered as one). */
  budgetAdditionalMinor?: number | null;
}

/**
 * One completed supervision review — append-only evidence. A
 * `terminate_proposal` MUST cite a W024 agent lifecycle decision
 * (change `terminate`, same agent); supervision itself never
 * terminates (the lifecycle control stays with W024's §20-gated
 * decision trail).
 */
export interface AgentSupervisionReview {
  id: string;
  tenantId: string;
  supervisionId: string;
  agentId: string;
  outcome: SupervisionReviewOutcome;
  /** Why (1..2000 chars, required). */
  rationale: string;
  /** Optional cited W024 evaluation (review evidence). */
  evaluationId: string | null;
  /** Required iff outcome = 'terminate_proposal': the cited W024 decision. */
  decisionId: string | null;
  /** The applied adjustments (outcome 'adjust'); null otherwise. */
  adjustments: SupervisionReviewAdjustments | null;
  reviewedBy: string;
  /** ISO 8601 — service clock. */
  reviewedAt: string;
}

/** Input shape of `completeSupervisionReview` (status must be waiting_review). */
export interface CompleteSupervisionReviewInput {
  agentId: string;
  outcome: SupervisionReviewOutcome;
  rationale: string;
  /** Optional cited W024 evaluation (validated readable through its contract). */
  evaluationId?: string | null;
  /** Required iff outcome = 'terminate_proposal': a W024 lifecycle decision. */
  decisionId?: string | null;
  adjustments?: SupervisionReviewAdjustments | null;
}

export interface ListSupervisionReviewsQuery {
  agentId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface GetSupervisionReviewQuery {
  reviewId: string;
}

// ---------------------------------------------------------------------------
// Events (the append-only audit trail)
// ---------------------------------------------------------------------------

/** The supervision event vocabulary (mirrored by the migration CHECK). */
export type AgentSupervisionEventKind =
  | 'registered'
  | 'registration_replayed'
  | 'updated'
  | 'review_due'
  | 'review_completed'
  | 'budget_granted'
  | 'budget_consumed'
  | 'budget_exhausted'
  | 'budget_resumed'
  | 'suspended'
  | 'resumed'
  | 'health_observed'
  | 'termination_proposed'
  | 'termination_applied'
  | 'termination_refused'
  | 'live_work_cancelled'
  | 'session_started'
  | 'session_heartbeat'
  | 'session_ended'
  | 'session_recovered';

/** One append-only supervision event (immutable history, §24). */
export interface AgentSupervisionEvent {
  id: string;
  tenantId: string;
  /** The supervision record (null for session-scoped events). */
  supervisionId: string | null;
  /** The agent (denormalized; null for session-scoped events). */
  agentId: string | null;
  /** The supervisor session that drove the event, when one did. */
  sessionId: string | null;
  kind: AgentSupervisionEventKind;
  detail: string;
  /** Small structured payload (transitions, costs, grants …). */
  data: unknown;
  recordedBy: string;
  /** ISO 8601 — service clock. */
  recordedAt: string;
}

export interface ListSupervisionEventsQuery {
  agentId?: string;
  supervisionId?: string;
  sessionId?: string;
  kind?: AgentSupervisionEventKind;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Budget ledger (append-only, exactly-once per attempt)
// ---------------------------------------------------------------------------

/** One ledgered spend unit — one W021 dispatch attempt, exactly once. */
export interface AgentSupervisionBudgetEntry {
  id: string;
  tenantId: string;
  supervisionId: string;
  agentId: string;
  executionId: string;
  /** The W021 attempt this entry ledgers (UNIQUE per tenant). */
  attemptId: string;
  costMinor: number;
  costCurrency: 'USD';
  recordedBy: string;
  /** ISO 8601 — service clock. */
  recordedAt: string;
}

export interface ListSupervisionBudgetEntriesQuery {
  agentId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Supervisor sessions (the durable worker-lifetime ledger)
// ---------------------------------------------------------------------------

/**
 * One supervisor session — the durable record of ONE worker's
 * supervision lifetime. `beginSupervisorSession` mints a live session
 * with a lease and RECOVERS this tenant's expired live sessions
 * (recorded durably: `end_reason = 'lease_expired_recovered'`, the
 * recovering session id, and a `session_recovered` event). Heartbeats
 * extend the lease; a session is ordinary lease state (live columns
 * only), never supervision truth.
 */
export interface AgentSupervisorSession {
  id: string;
  tenantId: string;
  startedBy: string;
  /** Lease duration in seconds (30..86_400; the W080 lease discipline). */
  leaseSeconds: number;
  /** ISO 8601 — when the session began. */
  startedAt: string;
  /** ISO 8601 — the latest heartbeat; null until the first one. */
  lastHeartbeatAt: string | null;
  /** ISO 8601 — the live lease expiry while the session is live. */
  leaseExpiresAt: string;
  /** ISO 8601 — null while live; set when ended or recovered. */
  endedAt: string | null;
  /** null while live; 'ended' (explicit) or 'lease_expired_recovered'. */
  endReason: 'ended' | 'lease_expired_recovered' | null;
  /** The session that recovered this one (endReason 'lease_expired_recovered'). */
  recoveredBySessionId: string | null;
}

export interface BeginSupervisorSessionInput {
  /** Lease duration in seconds; default 300. */
  leaseSeconds?: number | null;
}

export interface HeartbeatSupervisorSessionInput {
  sessionId: string;
}

export interface EndSupervisorSessionInput {
  sessionId: string;
  reason?: string | null;
}

export interface GetSupervisorSessionQuery {
  sessionId: string;
}

export interface ListSupervisorSessionsQuery {
  /** Filter: live (ended_at IS NULL) or ended sessions; omit for all. */
  live?: boolean | null;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// The pump (the worker seam — the W080 discipline applied to supervision)
// ---------------------------------------------------------------------------

/** The disposition of one supervision pump call. */
export type SupervisionPumpStatus =
  | 'idle' // nothing durable to advance for this agent
  | 'review_due' // a due review fired: active → waiting_review
  | 'budget_consumed' // one W021 attempt was ledgered into the budget
  | 'budget_exhausted' // the envelope is spent: active → paused_budget
  | 'health_observed' // a stale health observation was refreshed
  | 'termination_settled' // waiting_termination settled from the W024 decision
  | 'live_work_cancelled'; // enforcement cancelled one live supervised execution

export interface SupervisionPumpOutcome {
  status: SupervisionPumpStatus;
  agentId: string;
  /** Post-pump supervision status. */
  supervisionStatus: AgentSupervisionStatus;
  detail: string;
}

export interface SupervisionPumpInput {
  agentId: string;
  /**
   * The supervisor session driving this pump call, when one is. It must
   * be LIVE (else `session_not_live` — a dead worker's session may not
   * drive work; the caller recovers by beginning a fresh session).
   */
  sessionId?: string | null;
}

// ---------------------------------------------------------------------------
// The composed review context (read-only composition of W021/W023/W024)
// ---------------------------------------------------------------------------

/** The agent summary a reviewer sees (via the agents contract). */
export interface SupervisionAgentSummary {
  agentId: string;
  slug: string;
  role: string;
  status: 'active' | 'disabled';
  provider: string;
  permissions: AgentPermissionScope[];
}

/** One team membership of the supervised agent (via the agent-teams contract). */
export interface SupervisionTeamMembership {
  teamId: string;
  slug: string;
  status: 'draft' | 'active' | 'dissolved';
  version: number;
  role: string;
}

/** The latest W024 evaluation summary (via the agent-evaluation contract). */
export interface SupervisionEvaluationSummary {
  evaluationId: string;
  recordedAt: string;
  windowFrom: string;
  windowTo: string;
  totalCostMinor: number;
  executionsIncluded: number;
}

/**
 * The composed organizational context a reviewer reads before completing
 * a review: the supervision record, the agent definition summary, the
 * agent's team memberships and the latest measured evaluation — every
 * fact through a public contract, nothing from another module's tables.
 */
export interface SupervisionReviewContext {
  supervision: AgentSupervisionRecord;
  agent: SupervisionAgentSummary;
  teams: SupervisionTeamMembership[];
  latestEvaluation: SupervisionEvaluationSummary | null;
}
