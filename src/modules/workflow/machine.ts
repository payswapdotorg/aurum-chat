// Pure run/step state-machine logic (W080) — no clock, no database, no
// side effects; unit-tested directly and shared by the service and the
// engine so both halves of the module agree on ONE transition table.
//
// The vocabularies mirror the storage CHECK constraints
// (migrations/001): the database is the authority, this module is the
// type-level mirror (the house pattern: TS unions + CHECK constraints,
// IMPLEMENTATION-STACK §8).
//
// Retry/backoff/idempotency derivations follow the W021 agent-gateway
// discipline: explicit attempt counters, exponential backoff off the
// base, and stable effect keys so retries and crash recoveries remain
// idempotent.

import type {
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowStepStatus,
  WorkflowStepResult,
  WorkflowTriggerKind,
  WorkflowWaitKind,
  WorkflowStepAttemptOutcome,
} from './types';
import { WorkflowStepError } from './errors';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'running',
  'waiting',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
] as const;

export const STEP_STATUSES: readonly WorkflowStepStatus[] = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const WAIT_KINDS: readonly WorkflowWaitKind[] = [
  'timer',
  'approval',
  'employee_response',
] as const;

export const TRIGGER_KINDS: readonly WorkflowTriggerKind[] = [
  'manual',
  'event',
  'schedule',
] as const;

export const ATTEMPT_OUTCOMES: readonly WorkflowStepAttemptOutcome[] = [
  'completed',
  'checkpoint',
  'wait',
  'failed',
  'abandoned',
] as const;

export function isRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}

export function isStepStatus(value: unknown): value is WorkflowStepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value);
}

export function isWaitKind(value: unknown): value is WorkflowWaitKind {
  return typeof value === 'string' && (WAIT_KINDS as readonly string[]).includes(value);
}

export function isTriggerKind(value: unknown): value is WorkflowTriggerKind {
  return typeof value === 'string' && (TRIGGER_KINDS as readonly string[]).includes(value);
}

export function isAttemptOutcome(value: unknown): value is WorkflowStepAttemptOutcome {
  return typeof value === 'string' && (ATTEMPT_OUTCOMES as readonly string[]).includes(value);
}

export function isRunTerminal(status: WorkflowRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Cancellation transitions
// ---------------------------------------------------------------------------

/**
 * The run's status immediately after a cancellation is REQUESTED:
 * pending/waiting runs (nothing executing right now) cancel outright;
 * a running run enters `cancelling` and is finalized cooperatively by
 * the pump once no live executor holds it. Terminal runs are not
 * cancellable (null).
 */
export function runStatusAfterCancelRequest(
  status: WorkflowRunStatus,
): WorkflowRunStatus | null {
  switch (status) {
    case 'pending':
    case 'waiting':
      return 'cancelled';
    case 'running':
      return 'cancelling';
    default:
      return null;
  }
}

/**
 * A step's status after its run was finalized as cancelled: only
 * non-terminal steps move (terminal step outcomes are history).
 */
export function stepStatusAfterRunCancelled(status: WorkflowStepStatus): WorkflowStepStatus | null {
  switch (status) {
    case 'pending':
    case 'running':
    case 'waiting':
      return 'cancelled';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/** Hard cap on one retry backoff (1 day), mirroring guardrail discipline. */
export const MAX_RETRY_BACKOFF_SECONDS = 86_400;

/**
 * Backoff before the n-th retry: base * 2^(n-1), capped at one day.
 * `failedAttempts` is the attempt counter AFTER the failure (1 = first
 * failure → base seconds).
 */
export function retryBackoffSeconds(baseSeconds: number, failedAttempts: number): number {
  const safeBase = Math.max(0, Math.min(baseSeconds, MAX_RETRY_BACKOFF_SECONDS));
  const safeAttempts = Math.max(1, failedAttempts);
  const raw = safeBase * 2 ** (safeAttempts - 1);
  return Math.min(raw, MAX_RETRY_BACKOFF_SECONDS);
}

/**
 * Does a failed invocation consume the retry budget? A deterministic
 * executor rejection (WorkflowStepError) never retries — retrying cannot
 * change the outcome (the worker.ts dead-letter discipline). Anything
 * else (database, network, provider blips) is transient.
 */
export function isDeterministicStepFailure(error: unknown): boolean {
  return error instanceof WorkflowStepError;
}

// ---------------------------------------------------------------------------
// Idempotency key derivations (stable across retries and recoveries)
// ---------------------------------------------------------------------------

/** Stable per (run, step): retries and crash recoveries share the key. */
export function stepIdempotencyKey(runId: string, stepNumber: number): string {
  return `wf:${runId}:${stepNumber}`;
}

/** Stable per (run, step) approval request routed through the actions gate. */
export function approvalIdempotencyKey(runId: string, stepNumber: number): string {
  return `wf:${runId}:${stepNumber}:approval`;
}

/** Stable per (event, definition): one event never starts a second run. */
export function eventRunIdempotencyKey(eventId: string, definitionId: string): string {
  return `event:${eventId}:${definitionId}`;
}

/** Stable per (schedule, occurrence): a fired occurrence never re-fires. */
export function scheduleRunIdempotencyKey(scheduleId: string, occurrenceMs: number): string {
  return `sched:${scheduleId}:${occurrenceMs}`;
}

// ---------------------------------------------------------------------------
// Executor result classification
// ---------------------------------------------------------------------------

/**
 * Classify an executor's return value into the durable transition the
 * engine must persist. Pure — the engine applies this to whatever an
 * executor returned (typed `unknown`: executors are code, but code can
 * be wrong; the state machine never trusts shape) and fails
 * deterministically on a malformed result.
 */
export type ClassifiedStepResult =
  | { type: 'done'; output: unknown }
  | { type: 'checkpoint'; progress: unknown; resumeInSeconds: number | null }
  | {
      type: 'wait';
      wait:
        | { kind: 'timer'; resumeAt: Date }
        | {
            kind: 'approval';
            actionKind: string;
            authorityLevel: string;
            payload: unknown;
            justification: string | null;
          }
        | { kind: 'employee_response'; note: string | null; resumeOnEvent: string | null }
    };

/** The wait specification of a classified `wait` result. */
export type ClassifiedWaitSpec = Extract<ClassifiedStepResult, { type: 'wait' }>['wait'];

export function classifyStepResult(result: unknown): ClassifiedStepResult | null {
  if (typeof result !== 'object' || result === null) return null;
  const candidate = result as Partial<WorkflowStepResult>;
  if (candidate.type === 'done') {
    return { type: 'done', output: 'output' in candidate ? candidate.output : null };
  }
  if (candidate.type === 'checkpoint') {
    const resume = candidate.resumeInSeconds;
    if (resume !== undefined && (typeof resume !== 'number' || !Number.isFinite(resume) || resume < 0 || resume > 86_400)) {
      return null;
    }
    return {
      type: 'checkpoint',
      progress: 'progress' in candidate ? candidate.progress : null,
      resumeInSeconds: resume ?? null,
    };
  }
  if (candidate.type === 'wait') {
    const wait = candidate.wait;
    if (typeof wait !== 'object' || wait === null) return null;
    const waitCandidate = wait as Record<string, unknown>;
    if (waitCandidate.kind === 'timer') {
      const resumeAt = waitCandidate.resumeAt;
      if (typeof resumeAt !== 'string' || Number.isNaN(Date.parse(resumeAt))) return null;
      return { type: 'wait', wait: { kind: 'timer', resumeAt: new Date(resumeAt) } };
    }
    if (waitCandidate.kind === 'approval') {
      const approval = waitCandidate.approval;
      if (typeof approval !== 'object' || approval === null) return null;
      const approvalCandidate = approval as Record<string, unknown>;
      if (typeof approvalCandidate.actionKind !== 'string' || approvalCandidate.actionKind === '') return null;
      if (typeof approvalCandidate.authorityLevel !== 'string' || approvalCandidate.authorityLevel === '') return null;
      const justification = approvalCandidate.justification;
      return {
        type: 'wait',
        wait: {
          kind: 'approval',
          actionKind: approvalCandidate.actionKind,
          authorityLevel: approvalCandidate.authorityLevel,
          payload: 'payload' in approvalCandidate ? approvalCandidate.payload : null,
          justification: typeof justification === 'string' ? justification : null,
        },
      };
    }
    if (waitCandidate.kind === 'employee_response') {
      const note = waitCandidate.note;
      const resumeOnEvent = waitCandidate.resumeOnEvent;
      if (resumeOnEvent !== undefined && typeof resumeOnEvent !== 'string') return null;
      return {
        type: 'wait',
        wait: {
          kind: 'employee_response',
          note: typeof note === 'string' ? note : null,
          resumeOnEvent: resumeOnEvent ?? null,
        },
      };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step claimability (the pump's runnable predicate, shared with tests)
// ---------------------------------------------------------------------------

/** The live-lease window extension used when claiming a step. */
export function claimableStepPredicate(step: Pick<WorkflowRunStep, 'status' | 'leaseExpiresAt' | 'retryNotBefore'>, at: Date): boolean {
  if (step.status === 'pending') {
    return step.retryNotBefore === null || new Date(step.retryNotBefore).getTime() <= at.getTime();
  }
  if (step.status === 'running') {
    return step.leaseExpiresAt === null || new Date(step.leaseExpiresAt).getTime() <= at.getTime();
  }
  return false;
}
