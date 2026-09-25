// Pure supervision-policy logic of the agent-supervision module (W098).
// No database, no context, no time — everything here is a total,
// deterministic function of its arguments (the actions module's
// matrix.ts / agents module's policy.ts discipline), which is exactly
// what "durable agent health, review schedules, budgets, waiting
// states, recovery and resumptions independent of worker lifetime"
// demands: the same durable inputs always yield the same supervision
// decision, no matter WHICH worker evaluates them — that is the
// acceptance property, and it lives here where it is unit-testable.
//
// Three concerns:
//
//  1. LIFECYCLE — the supervision status vocabulary, its waiting and
//     terminal partitions, and the legal target status of each review
//     outcome (the review is the authority that moves an actor OUT of
//     the review waiting state; only the W024 decision settles a
//     termination proposal).
//
//  2. ADMISSION — the deterministic supervision admission check over
//     the durable record (status, ceiling, budget): the exact function
//     every worker — fresh or old — applies to supervised work. Budget
//     arithmetic (remaining, exhaustion) is defined once here.
//
//  3. SCHEDULES — review-schedule arithmetic: the next-due cursor from
//     a completed review, and the due predicate. Pure date math over
//     epoch milliseconds (the clock is injected by the service).

import type { AgentPermissionScope } from '@/modules/agents/contract';
import type {
  AgentSupervisionStatus,
  SupervisionReviewOutcome,
} from './types';

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

/** The supervision lifecycle states (mirrored by migrations/001 CHECK). */
export const SUPERVISION_STATUSES = [
  'active',
  'waiting_review',
  'paused_budget',
  'suspended',
  'waiting_termination',
  'terminated',
] as const;

export type SupervisionStatusWord = (typeof SUPERVISION_STATUSES)[number];

export function isSupervisionStatus(value: unknown): value is SupervisionStatusWord {
  return (
    typeof value === 'string' &&
    (SUPERVISION_STATUSES as readonly string[]).includes(value)
  );
}

/** The waiting states — the actor waits on an external authority. */
export const SUPERVISION_WAITING = [
  'waiting_review',
  'paused_budget',
  'suspended',
  'waiting_termination',
] as const;

/** The terminal supervision states — history from then on. */
export const SUPERVISION_TERMINAL = ['terminated'] as const;

export function isWaitingSupervisionStatus(status: AgentSupervisionStatus): boolean {
  return (SUPERVISION_WAITING as readonly string[]).includes(status);
}

export function isTerminalSupervisionStatus(status: AgentSupervisionStatus): boolean {
  return (SUPERVISION_TERMINAL as readonly string[]).includes(status);
}

/** The health observation states (mirrored by migrations/001 CHECK). */
export const SUPERVISION_HEALTH_STATES = [
  'unknown',
  'healthy',
  'degraded',
  'unhealthy',
] as const;

export type SupervisionHealthWord = (typeof SUPERVISION_HEALTH_STATES)[number];

export function isSupervisionHealthState(value: unknown): value is SupervisionHealthWord {
  return (
    typeof value === 'string' &&
    (SUPERVISION_HEALTH_STATES as readonly string[]).includes(value)
  );
}

/** The review outcomes (mirrored by migrations/003 CHECK). */
export const SUPERVISION_REVIEW_OUTCOMES = [
  'continue',
  'adjust',
  'suspend',
  'terminate_proposal',
] as const;

export type SupervisionReviewOutcomeWord =
  (typeof SUPERVISION_REVIEW_OUTCOMES)[number];

export function isSupervisionReviewOutcome(
  value: unknown,
): value is SupervisionReviewOutcomeWord {
  return (
    typeof value === 'string' &&
    (SUPERVISION_REVIEW_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The supervision status a completed review moves the actor into:
 * continue/adjust → active (cadence re-armed), suspend → suspended
 * (management waiting state), terminate_proposal → waiting_termination
 * (deferred to the cited W024 decision — supervision never terminates).
 */
export function statusAfterReview(
  outcome: SupervisionReviewOutcome,
): AgentSupervisionStatus {
  switch (outcome) {
    case 'continue':
    case 'adjust':
      return 'active';
    case 'suspend':
      return 'suspended';
    case 'terminate_proposal':
      return 'waiting_termination';
  }
}

/** The recovery authority of each waiting state (for messages/docs). */
export const WAITING_STATE_RECOVERY: Readonly<
  Record<Exclude<AgentSupervisionStatus, 'active' | 'terminated'>, string>
> = {
  waiting_review: 'completeSupervisionReview',
  paused_budget: 'grantSupervisionBudget',
  suspended: 'resumeSupervision',
  waiting_termination: 'the cited agent-evaluation lifecycle decision',
};

// ---------------------------------------------------------------------------
// Admission (the deterministic supervision gate over durable state)
// ---------------------------------------------------------------------------

/** The first requested scope the supervision ceiling does not cover, or null. */
export function missingCeilingScope(
  ceiling: readonly AgentPermissionScope[],
  requested: readonly AgentPermissionScope[],
): AgentPermissionScope | null {
  for (const scope of requested) {
    if (!(ceiling as readonly string[]).includes(scope)) return scope;
  }
  return null;
}

/**
 * The budget remaining under an envelope: null when unlimited, else
 * max(0, envelope − spent) — in-flight work may overshoot, the visible
 * remainder clamps at zero.
 */
export function budgetRemainingMinor(
  budgetMinor: number | null,
  budgetSpentMinor: number,
): number | null {
  if (budgetMinor === null) return null;
  return Math.max(0, budgetMinor - budgetSpentMinor);
}

/** True when ledgered spend has reached (or overshot) a finite envelope. */
export function isBudgetExhausted(record: {
  budgetMinor: number | null;
  budgetSpentMinor: number;
}): boolean {
  return record.budgetMinor !== null && record.budgetSpentMinor >= record.budgetMinor;
}

/** True when a health observation is due (never observed, or stale). */
export function isHealthObservationDue(
  record: { healthObservedAt: string | null },
  healthIntervalSeconds: number,
  nowMs: number,
): boolean {
  if (record.healthObservedAt === null) return true;
  return nowMs - Date.parse(record.healthObservedAt) >= healthIntervalSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Review schedules (pure date arithmetic over epoch milliseconds)
// ---------------------------------------------------------------------------

/** The next review-due instant after a completed review (epoch ms). */
export function nextReviewAfterCompletion(
  completedAtMs: number,
  reviewIntervalSeconds: number,
): number {
  return completedAtMs + reviewIntervalSeconds * 1000;
}

/** True when a review is due (the durable cursor has lapsed). */
export function isReviewDue(nextReviewAt: string, nowMs: number): boolean {
  return Date.parse(nextReviewAt) <= nowMs;
}

// ---------------------------------------------------------------------------
// The supervision causation identity (attributable supervised work)
// ---------------------------------------------------------------------------

/**
 * The §25 causation identity stamped on every supervised execution:
 * `agent-supervision:<supervisionId>`. Supervised executions stay
 * attributable to their supervision record (and therefore cancellable
 * by enforcement) without any cross-module foreign key.
 */
export function supervisionCausationKey(supervisionId: string): string {
  return `agent-supervision:${supervisionId}`;
}

/** True iff a W021 execution's causation identity names this supervision record. */
export function isSupervisedExecution(
  causationId: string | null,
  supervisionId: string,
): boolean {
  return causationId === supervisionCausationKey(supervisionId);
}

/** Which supervision record an execution's causation identity names, or null. */
export function supervisionIdOfCausation(causationId: string | null): string | null {
  if (causationId === null) return null;
  const prefix = 'agent-supervision:';
  return causationId.startsWith(prefix) ? causationId.slice(prefix.length) : null;
}

// ---------------------------------------------------------------------------
// Authority (the W021 claim discipline, reused verbatim)
// ---------------------------------------------------------------------------

/** Authority claim that manages the tenant's agent workforce (W021's). */
export const AGENTS_AUTHORITY_ADMINISTER = 'agents:administer';

/** May these authority claims manage supervision (register/grant/suspend/review)? */
export function canAdministerSupervision(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(AGENTS_AUTHORITY_ADMINISTER);
}
