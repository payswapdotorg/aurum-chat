// THE WORKFLOW PORT (W080 — the Aurum-owned orchestration boundary).
//
// FINAL-TECH-LEAD-HANDOFF-POST-S002 §14 (technology policy): "Keep
// orchestration behind an Aurum workflow port. Current
// deployment-compatible infrastructure may be used while
// Inngest/Trigger.dev/Temporal remain replaceable candidates."
// IMPLEMENTATION-STACK (post-S002 addendum): "Durable workflow execution
// is accessed through an application-owned workflow port … alternative
// durable workflow engines remain replaceable adapters."
//
// Everything a domain surface may do with durable orchestration goes
// through `WorkflowEnginePort`. The default implementation is the
// in-repo PostgreSQL engine (engine.ts — `createWorkflowEngine`), which
// persists ALL workflow state through the db port. A future
// Temporal/Inngest/Trigger.dev-class provider is a NEW adapter
// implementing this interface; domain code and the app surface never
// change when the engine is swapped (GOVERNANCE.md provider-swap
// evidence: domain semantics and persisted authoritative state remain
// unchanged).
//
// The port's halves:
//
//  * The MANAGEMENT surface — registerWorkflow / startRun / cancelRun /
//    resumeRun / dispatchEvent / schedules / queries: synchronous,
//    tenant-scoped operations like any module contract.
//
//  * The WORKER SEAM — pump: advances EXACTLY ONE durable unit of work
//    per call (finalize a cancellation, release a satisfied wait and
//    re-invoke its executor, or claim and invoke one claimable step).
//    One call is bounded: at most one executor invocation runs inside
//    it, and every transition it persists is guarded so a concurrent or
//    restarted pump loses cleanly ('conflict' / 'idle'). A host worker
//    loop calls pump repeatedly — the resident `scripts/worker.ts`
//    pattern — and a fresh engine instance constructed against the same
//    database resumes in-flight runs correctly (the W080 acceptance
//    property: no workflow state is held only in worker memory).
//
// Executor bindings are CODE injected at engine construction: the host
// composition root knows its definitions and their step executors; the
// engine resolves `bindings[definitionKey][stepKey]`. Bindings are never
// durable state — losing them loses no run progress, only the ability
// to make new progress until a host with the bindings restarts.

import type { TenantContext } from '@/infra/tenant';
import type {
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
  WorkflowRunStep,
  WorkflowSchedule,
  WorkflowStepAttempt,
} from './types';

/** The disposition of one pump call (the worker.ts JobOutcome discipline). */
export type WorkflowPumpStatus =
  | 'idle' // nothing durable to advance for this tenant
  | 'processed' // one executor invocation ran; its outcome persisted
  | 'suspended' // the invocation suspended on a durable wait
  | 'retried' // the invocation failed transiently; a retry is scheduled
  | 'failed' // the invocation failed terminally; the run failed
  | 'cancelled' // a cancelling run was finalized (no executor ran)
  | 'conflict'; // a racing pump (or a mid-flight cancellation) won; this pump's work was discarded

export interface WorkflowPumpOutcome {
  status: WorkflowPumpStatus;
  /** The run advanced (null only on idle). */
  runId: string | null;
  /** The step the invocation belonged to, when one ran. */
  stepNumber: number | null;
  /** Post-pump run status, when a run was involved. */
  runStatus: WorkflowRun['status'] | null;
  /** True when the invocation recovered an expired lease (a dead worker). */
  recovered: boolean;
  detail: string;
}

/**
 * The application-owned durable orchestration port. The default engine
 * (engine.ts) implements it over PostgreSQL; any future orchestration
 * provider implements the same interface without domain changes.
 */
export interface WorkflowEnginePort {
  // -- Definitions --------------------------------------------------------
  registerWorkflow(ctx: TenantContext, input: RegisterWorkflowInput): Promise<WorkflowDefinition>;
  getWorkflowDefinition(
    ctx: TenantContext,
    query: GetWorkflowDefinitionQuery,
  ): Promise<WorkflowDefinition>;
  listWorkflowDefinitions(
    ctx: TenantContext,
    query: ListWorkflowDefinitionsQuery,
  ): Promise<WorkflowDefinition[]>;

  // -- Runs ---------------------------------------------------------------
  startRun(ctx: TenantContext, input: StartRunInput): Promise<WorkflowRun>;
  cancelRun(ctx: TenantContext, input: CancelRunInput): Promise<WorkflowRun>;
  resumeRun(ctx: TenantContext, input: ResumeRunInput): Promise<WorkflowRun>;
  getRun(ctx: TenantContext, query: GetRunQuery): Promise<WorkflowRun>;
  listRuns(ctx: TenantContext, query: ListRunsQuery): Promise<WorkflowRun[]>;
  listRunSteps(ctx: TenantContext, query: ListRunStepsQuery): Promise<WorkflowRunStep[]>;
  listRunStepAttempts(
    ctx: TenantContext,
    query: ListRunStepAttemptsQuery,
  ): Promise<WorkflowStepAttempt[]>;

  // -- Event triggers -----------------------------------------------------
  dispatchEvent(
    ctx: TenantContext,
    input: DispatchWorkflowEventInput,
  ): Promise<WorkflowEventDispatch>;
  getEvent(ctx: TenantContext, query: GetWorkflowEventQuery): Promise<WorkflowEvent>;

  // -- Schedules ----------------------------------------------------------
  createSchedule(ctx: TenantContext, input: CreateScheduleInput): Promise<WorkflowSchedule>;
  listSchedules(ctx: TenantContext, query: ListSchedulesQuery): Promise<WorkflowSchedule[]>;
  setScheduleActive(ctx: TenantContext, input: SetScheduleActiveInput): Promise<WorkflowSchedule>;
  evaluateSchedules(ctx: TenantContext): Promise<ScheduleEvaluationResult>;

  // -- The worker seam ----------------------------------------------------
  /** Advance exactly ONE durable unit of work for the ctx's tenant. */
  pump(ctx: TenantContext): Promise<WorkflowPumpOutcome>;
}

/** Options for the default engine constructor. */
export interface WorkflowEngineOptions {
  /**
   * How many candidate runs one pump call may consider before
   * declaring idle (bounded work; default 8).
   */
  candidateScanLimit?: number;
}

export type { WorkflowExecutorBindings };
