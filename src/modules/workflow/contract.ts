// ============================================================================
// workflow — the ONLY public surface of the workflow module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W080 — Durable Agent Runtime Adapter:
// "Abstract durable orchestration behind an Aurum-owned workflow port.
//  Support event triggers, schedules, waits, retries, human approvals,
//  resumptions, idempotency, cancellation and long-running cognition.
//  Orchestration providers must be replaceable without domain changes."
//
// THE PORT (port.ts — re-exported here) is the Aurum-owned orchestration
// boundary the handoff mandates (§14 technology policy: "Keep
// orchestration behind an Aurum workflow port"). The default engine
// (engine.ts) is the in-repo implementation persisting ALL workflow
// state in PostgreSQL through the db port; a Temporal/Inngest-class
// provider is a future ADAPTER implementing the same interface — domain
// code never changes when the engine is swapped.
//
//   registerWorkflow / getWorkflowDefinition / listWorkflowDefinitions
//      — the versioned orchestration program (append-only version rows;
//      runs freeze their version). Re-registering identical content is a
//      no-op; changed content appends the next version.
//   startRun — record one run (idempotent by caller key: first write
//      wins, replay returns the original run).
//   cancelRun — cooperative cancellation, recorded in run state; a live
//      executor is finalized by the pump once it stops holding the run.
//   resumeRun — deliver an external employee-response signal (durable,
//      released by the pump).
//   dispatchEvent — the durable event trigger: one transaction appends
//      the event, starts runs for every subscribed active definition and
//      delivers signals to matching employee-response waits; idempotent
//      by emitter key (replay reports no new materialization). A domain
//      event reference (events module) is validated readable through
//      that module's contract before it may anchor a trigger.
//   createSchedule / listSchedules / setScheduleActive /
//   evaluateSchedules — cron-style schedules (UTC) evaluated by the
//      worker loop; each fired occurrence is ledgered UNIQUE, so
//      restarted or duplicate sweeps fire it exactly once.
//   pump — the worker seam: advance exactly ONE durable unit of work
//      (bounded, guarded, tenant-scoped). A fresh engine constructed
//      against the same database resumes in-flight runs correctly —
//      kill/restart survival is the module's acceptance property.
//   getRun / listRuns / listRunSteps / listRunStepAttempts / getEvent
//      — the trace surface (lock 36: asynchronous, resumable AND
//      traceable).
//
// There is deliberately NO operation to erase runs, steps, attempts,
// events, firings or definition versions: durable workflow history is
// append-only evidence (PostgreSQL triggers enforce it — see
// migrations/). Terminal runs are the end of their lifecycle; a new need
// is a new run. Learning never rewrites orchestration history.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's definitions,
// runs, steps, events and schedules are indistinguishable from missing
// ones (`definition_not_found` / `run_not_found` / `schedule_not_found`
// / `event_not_found` — no existence leak).
//
// Dependency posture (WORK-ITEM-CATALOG W080 ← W013, W021, W034): this
// module imports ONLY module contracts — actions (W009's approval
// decisions, the approval-wait integration surface the W013 pump
// already uses), events (W003's immutable envelope, the validated
// domain-event trigger reference) and agents (the W021/W034 idempotency
// vocabulary). The W013 pump discipline (bounded unit, guarded advance,
// persisted-state-as-idempotency-authority) and the W021 attempt-row
// discipline (explicit attempt counters, append-only evidence) are
// consumed SEMANTICALLY — the workflow engine is their generalization;
// hosts compose cognition executions as workflow step executors.
// ============================================================================

// The engine (the default PostgreSQL-backed port implementation).
export { createWorkflowEngine } from './engine';

// The port itself — the seam an orchestration provider implements.
export type {
  WorkflowEngineOptions,
  WorkflowEnginePort,
  WorkflowPumpOutcome,
  WorkflowPumpStatus,
} from './port';

// The management/data operations (also reachable through the port).
export {
  cancelRun,
  createSchedule,
  dispatchWorkflowEvent,
  evaluateSchedules,
  getRun,
  getWorkflowDefinition,
  getWorkflowEvent,
  listRunStepAttempts,
  listRunSteps,
  listRuns,
  listSchedules,
  listWorkflowDefinitions,
  registerWorkflow,
  resumeRun,
  setScheduleActive,
  startRun,
} from './service';

export { WorkflowError, WorkflowStepError } from './errors';
export type { WorkflowErrorCode } from './errors';

// Pure vocabulary / derivations (unit-testable without a database).
export {
  ATTEMPT_OUTCOMES,
  MAX_RETRY_BACKOFF_SECONDS,
  RUN_STATUSES,
  STEP_STATUSES,
  TRIGGER_KINDS,
  WAIT_KINDS,
  approvalIdempotencyKey,
  claimableStepPredicate,
  eventRunIdempotencyKey,
  isAttemptOutcome,
  isDeterministicStepFailure,
  isRunStatus,
  isRunTerminal,
  isStepStatus,
  isTriggerKind,
  isWaitKind,
  retryBackoffSeconds,
  runStatusAfterCancelRequest,
  scheduleRunIdempotencyKey,
  stepIdempotencyKey,
  stepStatusAfterRunCancelled,
} from './machine';
export type { ClassifiedStepResult, ClassifiedWaitSpec } from './machine';
export {
  CRON_HORIZON_YEARS,
  cronMatches,
  cronOccurrencesBetween,
  isValidCron,
  nextCronOccurrence,
  parseCron,
} from './cron';

export {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_SECONDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EVENT_TRIGGERS,
  MAX_EVENT_TYPE_LENGTH,
  MAX_IDEM_KEY_LENGTH,
  MAX_LEASE_SECONDS,
  MAX_LIST_LIMIT,
  MAX_MAX_ATTEMPTS,
  MAX_NOTE_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_REASON_LENGTH,
  MAX_RETRY_BACKOFF_SECONDS as MAX_STEP_RETRY_BACKOFF_SECONDS,
  MAX_SCHEDULE_OCCURRENCES_PER_SWEEP,
  MAX_STEPS,
  MAX_STEP_KEY_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_LEASE_SECONDS,
  isUuid,
} from './validation';

export type {
  ValidatedCancelInput,
  ValidatedCreateScheduleInput,
  ValidatedDefinitionQuery,
  ValidatedDispatchEventInput,
  ValidatedListDefinitionsQuery,
  ValidatedListRunsQuery,
  ValidatedListSchedulesQuery,
  ValidatedRegisterInput,
  ValidatedResumeInput,
  ValidatedRunQuery,
  ValidatedRunStepAttemptsQuery,
  ValidatedRunStepsQuery,
  ValidatedSetScheduleActiveInput,
  ValidatedStartRunInput,
  ValidatedStepSpec,
  ValidatedWorkflowSpec,
} from './validation';

export type {
  CancelRunInput,
  CreateScheduleInput,
  DispatchWorkflowEventInput,
  GetRunQuery,
  GetWorkflowDefinitionQuery,
  GetWorkflowEventQuery,
  ListRunStepAttemptsQuery,
  ListRunStepsQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  ListWorkflowDefinitionsQuery,
  RegisterWorkflowInput,
  ResumeRunInput,
  ScheduleEvaluationResult,
  SetScheduleActiveInput,
  StartRunInput,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowEventDispatch,
  WorkflowExecutorBindings,
  WorkflowRun,
  WorkflowRunSignal,
  WorkflowRunStep,
  WorkflowRunStatus,
  WorkflowSchedule,
  WorkflowStepAttempt,
  WorkflowStepAttemptOutcome,
  WorkflowStepExecutor,
  WorkflowStepInvocation,
  WorkflowStepResult,
  WorkflowStepSpec,
  WorkflowStepStatus,
  WorkflowTriggerKind,
  WorkflowWaitKind,
  WorkflowWaitOutcome,
  WorkflowWaitSpec,
} from './types';

// Runtime vocabulary constants that live with the types they describe.
export { CANCELLABLE_RUN_STATUSES, RUN_TERMINAL_STATUSES } from './types';
