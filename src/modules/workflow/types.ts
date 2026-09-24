// Public domain types of the workflow module (W080 — Durable Agent
// Runtime Adapter).
//
// W080 abstracts durable orchestration behind an Aurum-owned workflow
// port (see port.ts). The default engine is an in-repo implementation
// that persists ALL workflow state in PostgreSQL; an external
// orchestration provider (Temporal-class) is a future adapter behind
// the same port, never a domain dependency (handoff §14 "Keep
// orchestration behind an Aurum workflow port"; lock 35: PostgreSQL is
// authoritative domain state).
//
// The three durable concepts:
//
//  * WorkflowDefinition — a versioned, tenant-scoped orchestration
//    PROGRAM: an ordered list of step specifications (retry policy,
//    lease/timeout policy) plus the event types that start runs. The
//    definition is DATA; the step EXECUTORS are code bindings injected
//    into an engine instance at construction (see
//    WorkflowExecutorBindings). Definitions are immutable once recorded
//    — re-registering with different content appends the next version;
//    existing runs keep the version they were started under, so run
//    history reconstructs against the exact program that produced it.
//
//  * WorkflowRun / WorkflowRunStep — the durable STATE MACHINE. A run
//    advances one step at a time; every step's position, invocation
//    counter, wait, checkpoint, output and error live in PostgreSQL
//    (lock 36: long-running cognition and execution are asynchronous,
//    resumable and traceable). A fresh engine constructed against the
//    same database resumes in-flight runs from exactly this state — no
//    workflow state is held only in worker memory (W080 acceptance).
//
//  * Waits and signals — the durable suspension surface: timer waits
//    (resume at a persisted instant), human-approval waits (integrated
//    with the actions module's approval decisions through its
//    contract), and employee-response waits (released by durable
//    signals delivered by events or explicit resume calls).
//
// Types stay provider-neutral and tenant-scoped. Timestamps are ISO
// 8601 strings in contracts (timestamptz in storage). Idempotency keys
// follow the W021/W034 vocabulary: emitter-supplied dedupe keys, first
// write wins, capped in length by the agents module's shared constant.

// ---------------------------------------------------------------------------
// Status vocabularies
// ---------------------------------------------------------------------------

/**
 * The run lifecycle (mirrors the cognition execution states, generalized):
 * `pending` (recorded, no step claimed yet) → `running` (a step is being
 * executed or is claimable) → `waiting` (the current step suspended on a
 * durable wait) → terminal `succeeded` / `failed`; `cancelling` /
 * `cancelled` is the cooperative cancellation path (requested durably,
 * finalized by the pump once no live executor holds the run).
 */
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed';

/** Statuses a run may legally be cancelled from. */
export const CANCELLABLE_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'running',
  'waiting',
] as const;

export const RUN_TERMINAL_STATUSES: readonly WorkflowRunStatus[] = [
  'cancelled',
  'succeeded',
  'failed',
] as const;

/**
 * The step lifecycle within a run: `pending` (not yet invoked, or waiting
 * out a retry backoff), `running` (claimed by a pump invocation — the
 * lease column says whether the claim is live), `waiting` (suspended on a
 * durable wait), terminal `succeeded` / `failed` / `cancelled`.
 */
export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** What a suspended step is waiting on (exactly one at a time). */
export type WorkflowWaitKind = 'timer' | 'approval' | 'employee_response';

/** How the run was started. */
export type WorkflowTriggerKind = 'manual' | 'event' | 'schedule';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** Retry/lease policy of one step (durable — part of the definition spec). */
export interface WorkflowStepSpec {
  /** Unique step key within the definition (referenced by executor bindings). */
  key: string;
  /** Optional human-readable step title. */
  title?: string | null;
  /**
   * Maximum failed attempts before the step (and therefore the run) fails
   * terminally. Waits and checkpoints never consume attempts. Default 3.
   */
  maxAttempts?: number;
  /**
   * Base backoff in seconds for transient failures; the n-th retry waits
   * `retryBackoffSeconds * 2^(n-1)` (capped at 1 day). Default 30.
   */
  retryBackoffSeconds?: number;
  /**
   * Lease duration in seconds: how long one executor invocation may hold
   * the step's claim before a restarted/redeployed worker is allowed to
   * recover it. Long-running steps must checkpoint (yield) or heartbeat.
   * Default 3600 (1 hour).
   */
  leaseSeconds?: number;
}

/**
 * The serialized orchestration program: ordered steps plus the event types
 * that start new runs (domain events delivered through the events module
 * or internal workflow events dispatched via the port).
 */
export interface WorkflowSpec {
  steps: WorkflowStepSpec[];
  /** Event types that start a run of this workflow (exact match). */
  eventTriggers?: string[];
}

/** A registered workflow definition (versioned, tenant-scoped). */
export interface WorkflowDefinition {
  id: string;
  tenantId: string;
  /** Tenant-unique definition key, e.g. `briefing.daily`. */
  key: string;
  /** Version of the recorded spec — bumped on content change, starts at 1. */
  version: number;
  title: string;
  description: string | null;
  spec: WorkflowSpec;
  status: 'active' | 'retired';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `registerWorkflow`. */
export interface RegisterWorkflowInput {
  key: string;
  title: string;
  description?: string | null;
  spec: WorkflowSpec;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The durable execution record of one workflow definition version. */
export interface WorkflowRun {
  id: string;
  tenantId: string;
  definitionId: string;
  definitionKey: string;
  /** The definition version this run executes (frozen at start). */
  definitionVersion: number;
  /** Caller-supplied dedupe key — first write wins, tenant-scoped. */
  idempotencyKey: string | null;
  status: WorkflowRunStatus;
  /** 0 = not yet started; 1..totalSteps = the active step's number. */
  currentStep: number;
  totalSteps: number;
  trigger: WorkflowTriggerKind;
  /** The workflow event that started this run (trigger `event`). */
  triggerEventId: string | null;
  /** The schedule that fired this run (trigger `schedule`). */
  triggerScheduleId: string | null;
  /** Opaque caller reference (e.g. a conversation or mission id). */
  triggerReference: string | null;
  /** The run's input (JSON value; step invocations receive it). */
  input: unknown;
  /** The terminal result (status `succeeded`). */
  result: unknown;
  errorCode: string | null;
  errorDetail: string | null;
  cancelRequestedAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  /**
   * The durable run context: the principal and authority claims that
   * started the run, serialized at startRun so ANY fresh engine instance
   * can pump the run with the original explicit context (no ambient
   * state — the worker.ts job-envelope discipline).
   */
  runPrincipal: string;
  runAuthority: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Input shape of `startRun`. */
export interface StartRunInput {
  definitionKey: string;
  /** The run's input — any plain JSON value (non-null, size-capped). */
  input?: unknown;
  idempotencyKey?: string | null;
  /** Opaque reference recorded on the run (trigger `manual`). */
  triggerReference?: string | null;
}

/** Input shape of `cancelRun` (cooperative cancellation). */
export interface CancelRunInput {
  runId: string;
  reason: string;
}

/** Input shape of `resumeRun` — deliver an external signal (employee response). */
export interface ResumeRunInput {
  runId: string;
  /** The response payload delivered to the waiting step. */
  payload?: unknown;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Steps, waits and attempt evidence
// ---------------------------------------------------------------------------

/** The durable state of one step of one run. */
export interface WorkflowRunStep {
  id: string;
  tenantId: string;
  runId: string;
  /** 1-based position in the definition's step order. */
  stepNumber: number;
  stepKey: string;
  status: WorkflowStepStatus;
  /** Total executor invocations performed for this step (observability). */
  invocationCount: number;
  /** Failed attempts — the retry-policy counter (waits do not consume it). */
  attemptCount: number;
  maxAttempts: number;
  /** Base retry backoff (seconds), frozen from the definition at start. */
  retryBackoffSeconds: number;
  /** Lease duration (seconds), frozen from the definition at start. */
  leaseSeconds: number;
  waitKind: WorkflowWaitKind | null;
  /** Timer wait: when the step becomes resumable. */
  waitResumeAt: string | null;
  /** Approval wait: the actions module's request being decided. */
  waitActionRequestId: string | null;
  /** Employee-response wait: the event type that releases it (optional). */
  waitEventType: string | null;
  waitNote: string | null;
  /** Latest durable checkpoint (long-running cognition progress). */
  checkpoint: unknown;
  output: unknown;
  errorCode: string | null;
  errorDetail: string | null;
  /** Earliest instant a failed step may be re-invoked (retry backoff). */
  retryNotBefore: string | null;
  /** Live claim expiry of the current invocation (null = unclaimed). */
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Outcome kinds recorded on the append-only attempt evidence trail. */
export type WorkflowStepAttemptOutcome =
  | 'completed' // invocation returned `done`
  | 'checkpoint' // invocation yielded durable progress
  | 'wait' // invocation suspended on a wait
  | 'failed' // invocation failed (transient or terminal)
  | 'abandoned'; // invocation's worker died / outcome discarded (lease recovery or cancellation)

/**
 * One executor invocation of one step — the append-only evidence trail
 * (the W021 agent-execution-attempts discipline: what ran, which
 * invocation number, how it ended, with which error or checkpoint).
 */
export interface WorkflowStepAttempt {
  id: string;
  tenantId: string;
  runId: string;
  stepNumber: number;
  /** 1-based invocation number this row records. */
  invocation: number;
  outcome: WorkflowStepAttemptOutcome;
  waitKind: WorkflowWaitKind | null;
  errorCode: string | null;
  errorDetail: string | null;
  /** The checkpoint persisted by this invocation (outcome `checkpoint`). */
  checkpoint: unknown;
  startedAt: string;
  finishedAt: string;
  /** The pump principal that drove the invocation. */
  recordedBy: string;
}

// ---------------------------------------------------------------------------
// Executor seam (code bindings — never durable state)
// ---------------------------------------------------------------------------

/** What released a suspended invocation: handed back to the executor. */
export type WorkflowWaitOutcome =
  | { kind: 'timer'; resumeAt: string }
  | {
      kind: 'approval';
      decision: 'approved' | 'rejected';
      requestId: string;
      note: string | null;
    }
  | {
      kind: 'employee_response';
      payload: unknown;
      note: string | null;
      eventType: string | null;
    };

/** The invocation contract handed to a step executor binding. */
export interface WorkflowStepInvocation {
  tenantId: string;
  definitionKey: string;
  definitionVersion: number;
  runId: string;
  stepNumber: number;
  stepKey: string;
  /** The run's input (recorded at startRun). */
  input: unknown;
  /** The latest durable checkpoint (null on a fresh invocation). */
  checkpoint: unknown;
  /** What released this invocation (null on fresh/continued invocations). */
  wait: WorkflowWaitOutcome | null;
  /** 1-based number of THIS invocation. */
  invocation: number;
  /** Failed attempts before this invocation (the retry counter). */
  attempt: number;
  /**
   * Stable idempotency key for the step's external effects:
   * `wf:<runId>:<stepNumber>` — retries and crash recoveries share it, so
   * an executor honoring the key performs its external effect exactly
   * once per logical step execution (W080 acceptance).
   */
  idempotencyKey: string;
  /**
   * Cooperative cancellation check — reads the run's durable status.
   * Long-running executors should poll this and yield early.
   */
  cancelled(): Promise<boolean>;
  /**
   * Extend the live lease (long-running work without checkpointing).
   * Throws if the run was cancelled or the step lost its claim.
   */
  heartbeat(): Promise<void>;
}

/** What one executor invocation returns. */
export type WorkflowStepResult =
  | { type: 'done'; output?: unknown }
  | {
      /** Yield with durable progress; re-invoked with it later. */
      type: 'checkpoint';
      progress?: unknown;
      /** Delay before the continuation becomes claimable (default: next pump). */
      resumeInSeconds?: number;
    }
  | { type: 'wait'; wait: WorkflowWaitSpec };

/** A wait specification returned by an executor. */
export type WorkflowWaitSpec =
  | { kind: 'timer'; resumeAt: string }
  | {
      /** Human-approval wait — routed through the actions module's gate. */
      kind: 'approval';
      approval: {
        actionKind: string;
        authorityLevel: string;
        payload: unknown;
        justification?: string | null;
      };
    }
  | {
      /** Employee-response wait — released by a durable signal or event. */
      kind: 'employee_response';
      note?: string | null;
      /** Only the matching event type releases the wait (optional filter). */
      resumeOnEvent?: string;
    };

/** One step executor (code, never durable state). */
export type WorkflowStepExecutor = (invocation: WorkflowStepInvocation) => Promise<WorkflowStepResult>;

/** Executor bindings per definition key → step key. */
export interface WorkflowExecutorBindings {
  [definitionKey: string]: { [stepKey: string]: WorkflowStepExecutor };
}

// ---------------------------------------------------------------------------
// Events and signals
// ---------------------------------------------------------------------------

/** A durable orchestration event (the event-trigger substrate). */
export interface WorkflowEvent {
  id: string;
  tenantId: string;
  eventType: string;
  payload: unknown;
  /** The domain event (events module) this trigger references, if any. */
  domainEventId: string | null;
  idempotencyKey: string | null;
  occurredAt: string;
  dispatchedBy: string;
}

/** Input shape of `dispatchWorkflowEvent`. */
export interface DispatchWorkflowEventInput {
  eventType: string;
  payload?: unknown;
  /** Emitter dedupe key — replay returns the original dispatch result. */
  idempotencyKey?: string | null;
  /** An already-recorded domain event (events module) as the trigger. */
  domainEventId?: string | null;
}

/** The result of one event dispatch (runs started, waits signalled). */
export interface WorkflowEventDispatch {
  event: WorkflowEvent;
  /** Runs started by this dispatch (empty on idempotent replay). */
  runsStarted: WorkflowRun[];
  /** Waiting employee-response steps signalled by this dispatch. */
  signalsDelivered: number;
  /** True when an recorded idempotency key replayed the original dispatch. */
  replayed: boolean;
}

/** A durable signal delivered to a waiting run (append-only). */
export interface WorkflowRunSignal {
  id: string;
  tenantId: string;
  runId: string;
  kind: 'event' | 'resume';
  payload: unknown;
  note: string | null;
  /** The workflow event that produced this signal (kind `event`). */
  eventId: string | null;
  deliveredBy: string;
  deliveredAt: string;
  consumedAt: string | null;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** A cron-style schedule that starts runs (evaluated by the worker loop). */
export interface WorkflowSchedule {
  id: string;
  tenantId: string;
  definitionKey: string;
  /** Standard 5-field cron expression, evaluated in UTC. */
  cron: string;
  timezone: 'UTC';
  active: boolean;
  /** The input recorded runs receive. */
  input: unknown;
  /** Latest occurrence already materialized (the evaluation cursor). */
  lastOccurrenceAt: string | null;
  /** Advisory next occurrence (recomputed on evaluation). */
  nextOccurrenceAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `createSchedule`. */
export interface CreateScheduleInput {
  definitionKey: string;
  cron: string;
  input?: unknown;
  active?: boolean;
}

/** The result of one schedule evaluation sweep. */
export interface ScheduleEvaluationResult {
  schedulesEvaluated: number;
  occurrencesFired: number;
  runsStarted: WorkflowRun[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface GetWorkflowDefinitionQuery {
  key: string;
}

export interface ListWorkflowDefinitionsQuery {
  status?: 'active' | 'retired';
  /** 1..500, default 50. */
  limit?: number;
}

export interface GetRunQuery {
  runId: string;
}

export interface ListRunsQuery {
  definitionKey?: string;
  status?: WorkflowRunStatus;
  trigger?: WorkflowTriggerKind;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListRunStepsQuery {
  runId: string;
}

export interface ListRunStepAttemptsQuery {
  runId: string;
  stepNumber?: number;
}

export interface ListSchedulesQuery {
  activeOnly?: boolean;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetScheduleActiveInput {
  scheduleId: string;
  active: boolean;
}

export interface GetWorkflowEventQuery {
  eventId: string;
}
