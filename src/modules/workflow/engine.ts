// THE DEFAULT WORKFLOW ENGINE (W080) — the in-repo, PostgreSQL-backed
// implementation of the Aurum-owned workflow port.
//
// WHY AN ENGINE "INSTANCE" IS SAFE TO LOSE: the engine object itself
// holds ONLY code (executor bindings + options). Every fact a run needs
// to continue — position, invocation counters, waits, checkpoints,
// outputs, errors, the run's serialized tenant context, each step's
// frozen retry/lease policy — is a row in PostgreSQL. Constructing a
// NEW engine against the same database and pumping therefore resumes
// in-flight runs correctly (the W080 acceptance property; tested by
// constructing a fresh engine mid-run). No workflow state is held only
// in worker memory (ARCHITECTURE-LOCK: PostgreSQL is domain truth).
//
// THE PUMP advances exactly ONE durable unit of work per call, in this
// priority order (deterministic — tests rely on it):
//   1. finalize a `cancelling` run whose current step holds no live
//      lease (cooperative cancellation);
//   2. release one satisfied wait (timer due → signal arrived →
//      approval decided) and re-invoke its executor with the wait
//      outcome;
//   3. claim one claimable step (fresh, retry-backoff elapsed, or an
//      unclaimed/expired-lease continuation) and invoke its executor.
//
// EVERY transition is guarded (optimistic concurrency — the W013
// runNextStage / W021 attempt-slot discipline):
//   * claiming sets the step to `running` with a live lease and bumps
//     the invocation counter — a racing pump's guarded UPDATE hits 0
//     rows and reports `conflict` without side effects;
//   * persisting an outcome guards `status = 'running' AND
//     invocation_count = <the invocation this pump drove>` — an
//     invocation whose claim was recovered by another pump (lease
//     expiry) or whose run was cancelled mid-flight is DISCARDED
//     cleanly (its evidence row belongs to the winner's `abandoned`
//     marker);
//   * a lease that expired without an outcome is recovered on a later
//     pump: the stale invocation gets an append-only `abandoned`
//     evidence row and the step is re-invoked WITH its persisted
//     checkpoint — long-running cognition loses nothing, and the
//     step's STABLE idempotency key (`wf:<runId>:<stepNumber>`) makes
//     the re-execution's external effects exactly-once for executors
//     that honor the key (the W080 idempotency contract).
//
// APPROVAL WAITS integrate the actions module's approval decisions
// through its contract (W009 — no forked semantics): materializing an
// approval wait routes the executor's proposal through `authorizeAction`
// with the stable key `wf:<runId>:<stepNumber>:approval` under the
// run's ORIGINAL durable context, and the pump releases the wait when
// `getActionRequest` reports the request decided (approved or
// rejected). Worker death between materialization and decision loses
// nothing: the request and the wait are both durable rows.
//
// TENANT SCOPING: every SQL statement is scoped by the pump context's
// tenant; the engine reconstructs the run's ORIGINAL explicit context
// (run_principal / run_authority — the worker.ts job-envelope
// discipline) for contract calls and executor invocations.

import { now } from '@/infra/clock';
import { getDb, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  getActionRequest,
  isAuthorityLevel,
} from '@/modules/actions/contract';
import { WorkflowStepError } from './errors';
import {
  approvalIdempotencyKey,
  classifyStepResult,
  retryBackoffSeconds,
  stepIdempotencyKey,
  type ClassifiedStepResult,
  type ClassifiedWaitSpec,
} from './machine';
import type { StepRow } from './service';
import {
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
  type RunRow,
} from './service';
import type {
  WorkflowEngineOptions,
  WorkflowEnginePort,
  WorkflowPumpOutcome,
} from './port';
import type {
  WorkflowExecutorBindings,
  WorkflowStepInvocation,
  WorkflowWaitOutcome,
} from './types';
import { assertWorkflowTenantContext } from './validation';

const DEFAULT_CANDIDATE_SCAN_LIMIT = 8;
const APPROVAL_SCAN_LIMIT = 20;

/** Internal sentinel: a guarded transition lost its race. */
class ClaimConflict extends Error {}

/** The joined run+step shape the pump works on. */
interface PumpTarget {
  run: RunRow;
  step: StepRow;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// ---------------------------------------------------------------------------
// Engine construction
// ---------------------------------------------------------------------------

/**
 * Construct the DEFAULT durable workflow engine (PostgreSQL-backed — all
 * state through the db port). `bindings` maps definition key → step key
 * → executor; they are CODE, never durable state. Swap the engine by
 * implementing `WorkflowEnginePort` elsewhere — domain surfaces are
 * unaffected (W080 provider independence).
 */
export function createWorkflowEngine(
  bindings: WorkflowExecutorBindings,
  options: WorkflowEngineOptions = {},
): WorkflowEnginePort {
  const scanLimit = options.candidateScanLimit ?? DEFAULT_CANDIDATE_SCAN_LIMIT;
  return {
    registerWorkflow,
    getWorkflowDefinition,
    listWorkflowDefinitions,
    startRun,
    cancelRun,
    resumeRun,
    getRun,
    listRuns,
    listRunSteps,
    listRunStepAttempts,
    dispatchEvent: dispatchWorkflowEvent,
    getEvent: getWorkflowEvent,
    createSchedule,
    listSchedules,
    setScheduleActive,
    evaluateSchedules,
    pump: (ctx: TenantContext) => pump(ctx, bindings, scanLimit),
  };
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

/** The step columns the pump's joined queries select (aliased to avoid run/step collisions). */
const PUMP_STEP_COLUMNS = `
              s.id AS step_id, s.step_number, s.step_key, s.status AS step_status,
              s.invocation_count, s.attempt_count, s.max_attempts, s.retry_backoff_seconds,
              s.lease_seconds, s.wait_kind, s.wait_resume_at, s.wait_action_request_id,
              s.wait_event_type, s.wait_note, s.checkpoint, s.output, s.error_code AS step_error_code,
              s.error_detail AS step_error_detail, s.retry_not_before, s.lease_expires_at,
              s.started_at AS step_started_at, s.finished_at AS step_finished_at,
              s.updated_at AS step_updated_at`;

/** A run row joined with its current step's columns (see PUMP_STEP_COLUMNS). */
interface PumpJoinedRow extends RunRow {
  step_id: string;
  step_number: number;
  step_key: string;
  step_status: StepRow['status'];
  invocation_count: number;
  attempt_count: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  lease_seconds: number;
  wait_kind: StepRow['wait_kind'];
  wait_resume_at: Date | string | null;
  wait_action_request_id: string | null;
  wait_event_type: string | null;
  wait_note: string | null;
  checkpoint: unknown;
  output: unknown;
  step_error_code: string | null;
  step_error_detail: string | null;
  retry_not_before: Date | string | null;
  lease_expires_at: Date | string | null;
  step_started_at: Date | string | null;
  step_finished_at: Date | string | null;
  step_updated_at: Date | string;
}

async function pump(
  ctx: TenantContext,
  bindings: WorkflowExecutorBindings,
  scanLimit: number,
): Promise<WorkflowPumpOutcome> {
  assertWorkflowTenantContext(ctx);
  const db = getDb();

  // 1. Finalize cooperative cancellations (no live executor may hold).
  const finalized = await finalizeCancellations(ctx);
  if (finalized !== null) return finalized;

  // 2a. Timer waits that are due.
  const timerTarget = (
    await db.query<PumpJoinedRow>(
      `SELECT r.*, ${PUMP_STEP_COLUMNS}
         FROM workflow_runs r
         JOIN workflow_run_steps s
           ON s.run_id = r.id AND s.tenant_id = r.tenant_id AND s.step_number = r.current_step
        WHERE r.tenant_id = $1 AND r.status = 'waiting' AND s.status = 'waiting'
          AND s.wait_kind = 'timer' AND s.wait_resume_at <= $2
        ORDER BY s.wait_resume_at ASC, s.id ASC
        LIMIT 1`,
      [ctx.tenantId, now()],
    )
  ).rows[0];
  if (timerTarget !== undefined) {
    const resumeAt = toIso(timerTarget.wait_resume_at)!;
    return invokeClaimed(
      ctx,
      bindings,
      targetOf(timerTarget),
      { kind: 'timer', resumeAt },
    );
  }

  // 2b. Employee-response waits with an unconsumed durable signal.
  const signalTarget = (
    await db.query<
      PumpJoinedRow & {
        signal_id: string;
        signal_payload: unknown;
        signal_note: string | null;
        signal_event_type: string | null;
      }
    >(
      `SELECT r.*, ${PUMP_STEP_COLUMNS},
              sig.id AS signal_id, sig.payload AS signal_payload, sig.note AS signal_note,
              e.event_type AS signal_event_type
         FROM workflow_run_steps s
         JOIN workflow_runs r
           ON r.id = s.run_id AND r.tenant_id = s.tenant_id AND r.status = 'waiting'
         JOIN workflow_run_signals sig
           ON sig.run_id = s.run_id AND sig.tenant_id = s.tenant_id AND sig.consumed_at IS NULL
         LEFT JOIN workflow_events e
           ON e.id = sig.event_id AND e.tenant_id = sig.tenant_id
        WHERE s.tenant_id = $1 AND s.status = 'waiting' AND s.wait_kind = 'employee_response'
        ORDER BY sig.delivered_at ASC, sig.id ASC
        LIMIT 1`,
      [ctx.tenantId],
    )
  ).rows[0];
  if (signalTarget !== undefined) {
    return invokeClaimed(
      ctx,
      bindings,
      targetOf(signalTarget),
      {
        kind: 'employee_response',
        payload: signalTarget.signal_payload,
        note: signalTarget.signal_note,
        eventType: signalTarget.signal_event_type,
      },
      { signalId: signalTarget.signal_id },
    );
  }

  // 2c. Approval waits whose action request was decided (bounded scan).
  const approvalRows = (
    await db.query<PumpJoinedRow>(
      `SELECT r.*, ${PUMP_STEP_COLUMNS}
         FROM workflow_runs r
         JOIN workflow_run_steps s
           ON s.run_id = r.id AND s.tenant_id = r.tenant_id AND s.step_number = r.current_step
        WHERE r.tenant_id = $1 AND r.status = 'waiting' AND s.status = 'waiting'
          AND s.wait_kind = 'approval'
        ORDER BY s.updated_at ASC, s.id ASC
        LIMIT $2`,
      [ctx.tenantId, APPROVAL_SCAN_LIMIT],
    )
  ).rows;
  for (const candidate of approvalRows) {
    const target = targetOf(candidate);
    const runCtx = runContextOf(target.run);
    let request;
    try {
      request = await getActionRequest(runCtx, { requestId: candidate.wait_action_request_id! });
    } catch (error) {
      if (error instanceof ActionsError) {
        // The request is no longer readable in this tenant — a data
        // integrity break. Fail the step deterministically.
        return failStepDeterministically(
          ctx,
          target,
          'approval_request_missing',
          `approval wait references an unreadable action request (${error.code})`,
        );
      }
      throw error;
    }
    if (request.status === 'approved' || request.status === 'rejected') {
      return invokeClaimed(
        ctx,
        bindings,
        target,
        {
          kind: 'approval',
          decision: request.status,
          requestId: request.id,
          note: null,
        },
      );
    }
    // Still pending — keep scanning.
  }

  // 3. Claim one claimable step.
  const candidates = (
    await db.query<PumpJoinedRow>(
      `SELECT r.*, ${PUMP_STEP_COLUMNS}
         FROM workflow_runs r
         JOIN workflow_run_steps s
           ON s.run_id = r.id AND s.tenant_id = s.tenant_id
          AND s.step_number = CASE WHEN r.current_step = 0 THEN 1 ELSE r.current_step END
        WHERE r.tenant_id = $1 AND r.status IN ('pending', 'running')
          AND (
            (s.status = 'pending' AND (s.retry_not_before IS NULL OR s.retry_not_before <= $2))
            OR (s.status = 'running' AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= $2))
          )
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT $3`,
      [ctx.tenantId, now(), scanLimit],
    )
  ).rows;
  for (const candidate of candidates) {
    const result = await claimAndInvoke(ctx, bindings, targetOf(candidate));
    if (result !== null) return result;
    // The claim lost its race — try the next candidate.
  }

  return {
    status: 'idle',
    runId: null,
    stepNumber: null,
    runStatus: null,
    recovered: false,
    detail: 'nothing durable to advance for this tenant',
  };
}

// ---------------------------------------------------------------------------
// Row plumbing (joined queries flatten run and step columns)
// ---------------------------------------------------------------------------

/** Split a joined pump row into the run row + step row pair. */
function targetOf(joined: PumpJoinedRow): PumpTarget {
  const run: RunRow = {
    id: joined.id,
    tenant_id: joined.tenant_id,
    definition_id: joined.definition_id,
    definition_key: joined.definition_key,
    definition_version: joined.definition_version,
    idempotency_key: joined.idempotency_key,
    status: joined.status,
    current_step: joined.current_step,
    total_steps: joined.total_steps,
    trigger_kind: joined.trigger_kind,
    trigger_event_id: joined.trigger_event_id,
    trigger_schedule_id: joined.trigger_schedule_id,
    trigger_reference: joined.trigger_reference,
    input: joined.input,
    result: joined.result,
    error_code: null,
    error_detail: null,
    cancel_requested_at: joined.cancel_requested_at,
    cancel_reason: joined.cancel_reason,
    cancelled_by: joined.cancelled_by,
    run_principal: joined.run_principal,
    run_authority: joined.run_authority,
    created_by: joined.created_by,
    created_at: joined.created_at,
    updated_at: joined.updated_at,
    started_at: joined.started_at,
    finished_at: joined.finished_at,
  };
  const step: StepRow = {
    id: joined.step_id,
    tenant_id: joined.tenant_id,
    run_id: joined.id,
    step_number: joined.step_number,
    step_key: joined.step_key,
    status: joined.step_status,
    invocation_count: joined.invocation_count,
    attempt_count: joined.attempt_count,
    max_attempts: joined.max_attempts,
    retry_backoff_seconds: joined.retry_backoff_seconds,
    lease_seconds: joined.lease_seconds,
    wait_kind: joined.wait_kind,
    wait_resume_at: joined.wait_resume_at,
    wait_action_request_id: joined.wait_action_request_id,
    wait_event_type: joined.wait_event_type,
    wait_note: joined.wait_note,
    checkpoint: joined.checkpoint,
    output: joined.output,
    error_code: joined.step_error_code,
    error_detail: joined.step_error_detail,
    retry_not_before: joined.retry_not_before,
    lease_expires_at: joined.lease_expires_at,
    started_at: joined.step_started_at,
    finished_at: joined.step_finished_at,
    updated_at: joined.step_updated_at,
  };
  return { run, step };
}

/** The run's ORIGINAL durable context (explicit — never ambient). */
function runContextOf(run: RunRow): TenantContext {
  return {
    tenantId: run.tenant_id,
    principalId: run.run_principal,
    authority: run.run_authority ?? [],
  };
}

// ---------------------------------------------------------------------------
// Unit 1 — finalize cooperative cancellations
// ---------------------------------------------------------------------------

async function finalizeCancellations(ctx: TenantContext): Promise<WorkflowPumpOutcome | null> {
  const db = getDb();
  const rows = (
    await db.query<RunRow>(
      `SELECT * FROM workflow_runs WHERE tenant_id = $1 AND status = 'cancelling'
        ORDER BY updated_at ASC, id ASC LIMIT 5`,
      [ctx.tenantId],
    )
  ).rows;
  const at = now();
  for (const run of rows) {
    // A live executor may still hold the current step — cooperative:
    // finalize only once the step holds no live claim.
    const currentStep = (
      await db.query<StepRow>(
        `SELECT * FROM workflow_run_steps WHERE tenant_id = $1 AND run_id = $2 AND step_number = $3`,
        [ctx.tenantId, run.id, run.current_step],
      )
    ).rows[0];
    const liveLease =
      currentStep !== undefined &&
      currentStep.status === 'running' &&
      currentStep.lease_expires_at !== null &&
      new Date(currentStep.lease_expires_at).getTime() > at.getTime();
    if (liveLease) continue;
    const finalized = await db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE workflow_runs
           SET status = 'cancelled', finished_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'cancelling'
         RETURNING id`,
        [ctx.tenantId, run.id, at],
      );
      if ((updated.rowCount ?? 0) === 0) return null;
      await tx.query(
        `UPDATE workflow_run_steps
           SET status = 'cancelled', wait_kind = NULL, wait_resume_at = NULL,
               wait_action_request_id = NULL, wait_event_type = NULL, wait_note = NULL,
               lease_expires_at = NULL, retry_not_before = NULL,
               finished_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND run_id = $2 AND status IN ('pending', 'running', 'waiting')`,
        [ctx.tenantId, run.id, at],
      );
      return run.id;
    });
    if (finalized !== null) {
      return {
        status: 'cancelled',
        runId: finalized,
        stepNumber: run.current_step,
        runStatus: 'cancelled',
        recovered: false,
        detail: `run ${finalized} finalized as cancelled ('${run.cancel_reason ?? ''}')`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Units 2 & 3 — claim + invoke + persist
// ---------------------------------------------------------------------------

/**
 * Release a satisfied wait: consume the signal (if any), claim the
 * suspended step for re-invocation, run the executor, persist.
 * Returns null when the claim lost its race (the pump tries the next
 * unit).
 */
async function invokeClaimed(
  ctx: TenantContext,
  bindings: WorkflowExecutorBindings,
  target: PumpTarget,
  waitOutcome: WorkflowWaitOutcome,
  consume?: { signalId: string },
): Promise<WorkflowPumpOutcome> {
  const db = getDb();
  const at = now();
  try {
    const claim = await db.transaction(async (tx) => {
      if (consume !== undefined) {
        await tx.query(
          `UPDATE workflow_run_signals SET consumed_at = $3 WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL`,
          [ctx.tenantId, consume.signalId, at],
        );
      }
      const claimed = await tx.query<StepRow>(
        `UPDATE workflow_run_steps
           SET status = 'running', invocation_count = invocation_count + 1,
               wait_kind = NULL, wait_resume_at = NULL, wait_action_request_id = NULL,
               wait_event_type = NULL, wait_note = NULL,
               lease_expires_at = $3::timestamptz + lease_seconds * interval '1 second',
               started_at = COALESCE(started_at, $3), updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'waiting'
         RETURNING *`,
        [ctx.tenantId, target.step.id, at],
      );
      const step = claimed.rows[0];
      if (step === undefined) throw new ClaimConflict('wait was released by a concurrent pump');
      const runUpdate = await tx.query(
        `UPDATE workflow_runs SET status = 'running', updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'waiting'`,
        [ctx.tenantId, target.run.id, at],
      );
      if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run left the waiting state');
      return { step, claimedAt: at };
    });
    return runExecutorAndPersist(
      ctx,
      bindings,
      { run: target.run, step: claim.step },
      waitOutcome,
      claim.claimedAt,
      false,
    );
  } catch (error) {
    if (error instanceof ClaimConflict) {
      return conflictOutcome(target, false, error.message);
    }
    throw error;
  }
}

/**
 * Claim one claimable step (fresh, backoff-elapsed retry, or unclaimed /
 * expired-lease continuation) and invoke its executor. Returns null when
 * the claim lost its race.
 */
async function claimAndInvoke(
  ctx: TenantContext,
  bindings: WorkflowExecutorBindings,
  target: PumpTarget,
): Promise<WorkflowPumpOutcome | null> {
  const db = getDb();
  const at = now();
  const stepBefore = target.step;
  let recovered = false;
  try {
    const claim = await db.transaction(async (tx) => {
      const claimed = await tx.query<StepRow>(
        `UPDATE workflow_run_steps
           SET status = 'running', invocation_count = invocation_count + 1,
               retry_not_before = NULL,
               lease_expires_at = $3::timestamptz + lease_seconds * interval '1 second',
               started_at = COALESCE(started_at, $3), updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'running')
           AND (
             (status = 'pending' AND (retry_not_before IS NULL OR retry_not_before <= $3))
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= $3))
           )
         RETURNING *`,
        [ctx.tenantId, stepBefore.id, at],
      );
      const step = claimed.rows[0];
      if (step === undefined) throw new ClaimConflict('step was claimed by a concurrent pump');
      // A previously-invoked running step is either a clean checkpoint
      // continuation (its invocation RECORDED an outcome row) or a dead
      // worker (no outcome row). Only the latter is a recovery: mark the
      // lost invocation on the append-only evidence trail.
      if (stepBefore.status === 'running' && stepBefore.invocation_count > 0) {
        const evidence = await tx.query(
          `SELECT 1 FROM workflow_step_attempts
            WHERE tenant_id = $1 AND run_id = $2 AND step_number = $3 AND invocation = $4
            LIMIT 1`,
          [ctx.tenantId, step.run_id, step.step_number, stepBefore.invocation_count],
        );
        if (evidence.rows.length === 0) {
          await tx.query(
            `INSERT INTO workflow_step_attempts (
               tenant_id, run_id, step_number, invocation, outcome, started_at, finished_at, recorded_by
             ) VALUES ($1, $2, $3, $4, 'abandoned', $5, $5, $6)
             ON CONFLICT (tenant_id, run_id, step_number, invocation) DO NOTHING`,
            [ctx.tenantId, step.run_id, step.step_number, stepBefore.invocation_count, at, ctx.principalId],
          );
          recovered = true;
        }
      }
      const runUpdate = await tx.query(
        `UPDATE workflow_runs
           SET status = 'running', started_at = COALESCE(started_at, $3),
               current_step = $4, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'running')
           AND (current_step = 0 OR current_step = $4)`,
        [ctx.tenantId, target.run.id, at, step.step_number],
      );
      if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run is no longer claimable');
      return { step, claimedAt: at };
    });
    return await runExecutorAndPersist(
      ctx,
      bindings,
      { run: target.run, step: claim.step },
      null,
      claim.claimedAt,
      recovered,
    );
  } catch (error) {
    if (error instanceof ClaimConflict) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Executor invocation + outcome persistence
// ---------------------------------------------------------------------------

async function runExecutorAndPersist(
  ctx: TenantContext,
  bindings: WorkflowExecutorBindings,
  target: PumpTarget,
  waitOutcome: WorkflowWaitOutcome | null,
  claimedAt: Date,
  recovered: boolean,
): Promise<WorkflowPumpOutcome> {
  const { run, step } = target;
  const invocationNumber = step.invocation_count;
  const idempotencyKey = stepIdempotencyKey(run.id, step.step_number);
  const executor = bindings[run.definition_key]?.[step.step_key];

  let result;
  if (executor === undefined) {
    // A definition/registration mismatch is deterministic — retrying
    // cannot produce the missing binding.
    return failStepDeterministically(
      ctx,
      target,
      'executor_missing',
      `no executor bound for definition '${run.definition_key}' step '${step.step_key}'`,
    );
  }

  const invocation: WorkflowStepInvocation = {
    tenantId: run.tenant_id,
    definitionKey: run.definition_key,
    definitionVersion: run.definition_version,
    runId: run.id,
    stepNumber: step.step_number,
    stepKey: step.step_key,
    input: run.input,
    checkpoint: step.checkpoint ?? null,
    wait: waitOutcome,
    invocation: invocationNumber,
    attempt: step.attempt_count,
    idempotencyKey,
    cancelled: async () => {
      const status = (
        await getDb().query<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE tenant_id = $1 AND id = $2`,
          [run.tenant_id, run.id],
        )
      ).rows[0];
      return status === undefined || status.status !== 'running';
    },
    heartbeat: async () => {
      const beaten = await getDb().query(
        `UPDATE workflow_run_steps
           SET lease_expires_at = $3::timestamptz + lease_seconds * interval '1 second', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND invocation_count = $4`,
        [run.tenant_id, step.id, now(), invocationNumber],
      );
      if ((beaten.rowCount ?? 0) === 0) {
        throw new Error(
          `workflow step lease lost (run ${run.id} step ${step.step_number} invocation ${invocationNumber}) — recovered by another pump or cancelled`,
        );
      }
    },
  };

  try {
    result = await executor(invocation);
  } catch (error) {
    return persistFailure(ctx, target, invocationNumber, claimedAt, error, recovered);
  }

  const classified = classifyStepResult(result);
  if (classified === null) {
    return persistFailure(
      ctx,
      target,
      invocationNumber,
      claimedAt,
      new WorkflowStepError(
        'invalid_executor_result',
        `executor for step '${step.step_key}' returned a malformed result`,
      ),
      recovered,
    );
  }

  switch (classified.type) {
    case 'done':
      return persistDone(ctx, target, invocationNumber, claimedAt, classified.output, recovered);
    case 'checkpoint':
      return persistCheckpoint(
        ctx,
        target,
        invocationNumber,
        claimedAt,
        classified.progress,
        classified.resumeInSeconds,
        recovered,
      );
    case 'wait':
      return persistWait(ctx, target, invocationNumber, claimedAt, classified.wait, recovered);
  }
}

// -- outcome: done ---------------------------------------------------------

async function persistDone(
  ctx: TenantContext,
  target: PumpTarget,
  invocationNumber: number,
  claimedAt: Date,
  output: unknown,
  recovered: boolean,
): Promise<WorkflowPumpOutcome> {
  const { run, step } = target;
  const db = getDb();
  const at = now();
  const isLastStep = step.step_number >= run.total_steps;
  try {
    const runStatus = await db.transaction(async (tx) => {
      const stepUpdate = await tx.query(
        `UPDATE workflow_run_steps
           SET status = 'succeeded', output = $4::jsonb, finished_at = $3,
               lease_expires_at = NULL, retry_not_before = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND invocation_count = $5`,
        [ctx.tenantId, step.id, at, JSON.stringify(output ?? null), invocationNumber],
      );
      if ((stepUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('invocation claim was lost');
      await insertAttemptEvidence(tx, ctx, target, invocationNumber, claimedAt, {
        outcome: 'completed',
      });
      if (isLastStep) {
        const runUpdate = await tx.query(
          `UPDATE workflow_runs
             SET status = 'succeeded', result = $4::jsonb, finished_at = $3, updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
          [ctx.tenantId, run.id, at, JSON.stringify(output ?? null)],
        );
        if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run left the running state');
        return 'succeeded' as const;
      }
      const runUpdate = await tx.query(
        `UPDATE workflow_runs
           SET current_step = $4, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
        [ctx.tenantId, run.id, at, step.step_number + 1],
      );
      if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run left the running state');
      return 'running' as const;
    });
    return {
      status: 'processed',
      runId: run.id,
      stepNumber: step.step_number,
      runStatus,
      recovered,
      detail:
        runStatus === 'succeeded'
          ? `step ${step.step_number} ('${step.step_key}') completed the run`
          : `step ${step.step_number} ('${step.step_key}') done — next step ${step.step_number + 1} claimable`,
    };
  } catch (error) {
    if (error instanceof ClaimConflict) return conflictOutcome(target, recovered, error.message);
    throw error;
  }
}

// -- outcome: checkpoint ---------------------------------------------------

async function persistCheckpoint(
  ctx: TenantContext,
  target: PumpTarget,
  invocationNumber: number,
  claimedAt: Date,
  progress: unknown,
  resumeInSeconds: number | null,
  recovered: boolean,
): Promise<WorkflowPumpOutcome> {
  const { run, step } = target;
  const db = getDb();
  const at = now();
  try {
    await db.transaction(async (tx) => {
      // resumeInSeconds doubles as the continuation gate: the lease
      // column is the claimability boundary for a running-but-unclaimed
      // step (NULL = claimable on the next pump).
      const stepUpdate = await tx.query(
        `UPDATE workflow_run_steps
           SET checkpoint = $4::jsonb,
               lease_expires_at = $5,
               updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND invocation_count = $6`,
        [
          ctx.tenantId,
          step.id,
          at,
          JSON.stringify(progress ?? null),
          resumeInSeconds === null
            ? null
            : new Date(at.getTime() + resumeInSeconds * 1000),
          invocationNumber,
        ],
      );
      if ((stepUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('invocation claim was lost');
      await insertAttemptEvidence(tx, ctx, target, invocationNumber, claimedAt, {
        outcome: 'checkpoint',
        checkpoint: progress,
      });
      await tx.query(
        `UPDATE workflow_runs SET updated_at = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
        [ctx.tenantId, run.id, at],
      );
    });
    return {
      status: 'processed',
      runId: run.id,
      stepNumber: step.step_number,
      runStatus: 'running',
      recovered,
      detail: `step ${step.step_number} ('${step.step_key}') checkpointed durable progress${
        resumeInSeconds === null ? '' : ` (continuation in ${resumeInSeconds}s)`
      }`,
    };
  } catch (error) {
    if (error instanceof ClaimConflict) return conflictOutcome(target, recovered, error.message);
    throw error;
  }
}

// -- outcome: wait ---------------------------------------------------------

async function persistWait(
  ctx: TenantContext,
  target: PumpTarget,
  invocationNumber: number,
  claimedAt: Date,
  waitSpec: ClassifiedWaitSpec,
  recovered: boolean,
): Promise<WorkflowPumpOutcome> {
  const { run, step } = target;
  const db = getDb();
  const at = now();

  // Approval waits route through the actions module's gate under the
  // run's ORIGINAL durable context — the W009 authority matrix decides,
  // never this module (no forked semantics).
  let actionRequestId: string | null = null;
  if (waitSpec.kind === 'approval') {
    if (!isAuthorityLevel(waitSpec.authorityLevel)) {
      return failStepDeterministically(
        ctx,
        target,
        'invalid_authority_level',
        `executor proposed an unknown authority level '${waitSpec.authorityLevel}'`,
      );
    }
    const runCtx = runContextOf(run);
    try {
      const request = await authorizeAction(runCtx, {
        actionKind: waitSpec.actionKind,
        authorityLevel: waitSpec.authorityLevel,
        payload: waitSpec.payload ?? {},
        justification: waitSpec.justification,
        idempotencyKey: approvalIdempotencyKey(run.id, step.step_number),
      });
      actionRequestId = request.id;
    } catch (error) {
      if (error instanceof ActionsError) {
        return failStepDeterministically(
          ctx,
          target,
          'approval_request_rejected',
          `the authority gate rejected the approval request (${error.code}: ${error.message})`,
        );
      }
      throw error;
    }
  }

  try {
    await db.transaction(async (tx) => {
      const stepUpdate = await tx.query(
        `UPDATE workflow_run_steps
           SET status = 'waiting', wait_kind = $4, wait_resume_at = $5,
               wait_action_request_id = $6, wait_event_type = $7, wait_note = $8,
               lease_expires_at = NULL, retry_not_before = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND invocation_count = $9`,
        [
          ctx.tenantId,
          step.id,
          at,
          waitSpec.kind,
          waitSpec.kind === 'timer' ? waitSpec.resumeAt : null,
          waitSpec.kind === 'approval' ? actionRequestId : null,
          waitSpec.kind === 'employee_response' ? waitSpec.resumeOnEvent : null,
          waitSpec.kind === 'employee_response' ? waitSpec.note : null,
          invocationNumber,
        ],
      );
      if ((stepUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('invocation claim was lost');
      await insertAttemptEvidence(tx, ctx, target, invocationNumber, claimedAt, {
        outcome: 'wait',
        waitKind: waitSpec.kind,
      });
      const runUpdate = await tx.query(
        `UPDATE workflow_runs SET status = 'waiting', updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
        [ctx.tenantId, run.id, at],
      );
      if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run left the running state');
    });
    return {
      status: 'suspended',
      runId: run.id,
      stepNumber: step.step_number,
      runStatus: 'waiting',
      recovered,
      detail: `step ${step.step_number} ('${step.step_key}') suspended on a ${waitSpec.kind} wait`,
    };
  } catch (error) {
    if (error instanceof ClaimConflict) return conflictOutcome(target, recovered, error.message);
    throw error;
  }
}

// -- outcome: failure ------------------------------------------------------

async function persistFailure(
  ctx: TenantContext,
  target: PumpTarget,
  invocationNumber: number,
  claimedAt: Date,
  error: unknown,
  recovered: boolean,
): Promise<WorkflowPumpOutcome> {
  const { run, step } = target;
  const deterministic = error instanceof WorkflowStepError;
  const errorCode = deterministic
    ? (error as WorkflowStepError).code
    : 'transient_failure';
  const errorDetail = error instanceof Error ? error.message : 'unknown error';
  const newAttemptCount = step.attempt_count + 1;
  const mayRetry = !deterministic && newAttemptCount <= step.max_attempts;
  const db = getDb();
  const at = now();

  try {
    const runStatus = await db.transaction(async (tx) => {
      if (mayRetry) {
        // Transient failure within budget: schedule the retry (explicit
        // attempt counter + exponential backoff). The checkpoint SURVIVES
        // — a blip must not erase durable progress. The failure detail
        // lives on the append-only attempt evidence row (a pending step
        // carries no error columns — see the storage CHECK shapes).
        const backoff = retryBackoffSeconds(step.retry_backoff_seconds, newAttemptCount);
        const stepUpdate = await tx.query(
          `UPDATE workflow_run_steps
             SET status = 'pending', attempt_count = $5,
                 retry_not_before = $6, lease_expires_at = NULL, updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND invocation_count = $4`,
          [
            ctx.tenantId,
            step.id,
            at,
            invocationNumber,
            newAttemptCount,
            new Date(at.getTime() + backoff * 1000),
          ],
        );
        if ((stepUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('invocation claim was lost');
        await insertAttemptEvidence(tx, ctx, target, invocationNumber, claimedAt, {
          outcome: 'failed',
          errorCode,
          errorDetail,
        });
        await tx.query(
          `UPDATE workflow_runs SET updated_at = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
          [ctx.tenantId, run.id, at],
        );
        return 'running' as const;
      }
      const stepUpdate = await tx.query(
        `UPDATE workflow_run_steps
           SET status = 'failed', attempt_count = $5, error_code = $6, error_detail = $7,
               finished_at = $3, lease_expires_at = NULL, retry_not_before = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND invocation_count = $4`,
        [ctx.tenantId, step.id, at, invocationNumber, newAttemptCount, errorCode, errorDetail],
      );
      if ((stepUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('invocation claim was lost');
      await insertAttemptEvidence(tx, ctx, target, invocationNumber, claimedAt, {
        outcome: 'failed',
        errorCode,
        errorDetail,
      });
      const runUpdate = await tx.query(
        `UPDATE workflow_runs
           SET status = 'failed', error_code = $4, error_detail = $5, finished_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
        [ctx.tenantId, run.id, at, errorCode, errorDetail],
      );
      if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run left the running state');
      return 'failed' as const;
    });
    if (mayRetry) {
      return {
        status: 'retried',
        runId: run.id,
        stepNumber: step.step_number,
        runStatus,
        recovered,
        detail: `step ${step.step_number} ('${step.step_key}') failed transiently (attempt ${newAttemptCount}/${step.max_attempts}) — retry scheduled`,
      };
    }
    return {
      status: 'failed',
      runId: run.id,
      stepNumber: step.step_number,
      runStatus,
      recovered,
      detail: `step ${step.step_number} ('${step.step_key}') failed terminally (${errorCode}: ${errorDetail})`,
    };
  } catch (error) {
    if (error instanceof ClaimConflict) return conflictOutcome(target, recovered, error.message);
    throw error;
  }
}

/** Deterministic step failure without an invocation context (approval-scan path). */
async function failStepDeterministically(
  ctx: TenantContext,
  target: PumpTarget,
  errorCode: string,
  errorDetail: string,
): Promise<WorkflowPumpOutcome> {
  const { run, step } = target;
  const db = getDb();
  const at = now();
  try {
    await db.transaction(async (tx) => {
      const stepUpdate = await tx.query(
        `UPDATE workflow_run_steps
           SET status = 'failed', error_code = $4, error_detail = $5,
               finished_at = $3, lease_expires_at = NULL, retry_not_before = NULL,
               wait_kind = NULL, wait_resume_at = NULL, wait_action_request_id = NULL,
               wait_event_type = NULL, wait_note = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status IN ('running', 'waiting')`,
        [ctx.tenantId, step.id, at, errorCode, errorDetail],
      );
      if ((stepUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('step left the claimable state');
      const runUpdate = await tx.query(
        `UPDATE workflow_runs
           SET status = 'failed', error_code = $4, error_detail = $5, finished_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status IN ('running', 'waiting')`,
        [ctx.tenantId, run.id, at, errorCode, errorDetail],
      );
      if ((runUpdate.rowCount ?? 0) === 0) throw new ClaimConflict('run left the claimable state');
    });
    return {
      status: 'failed',
      runId: run.id,
      stepNumber: step.step_number,
      runStatus: 'failed',
      recovered: false,
      detail: `step ${step.step_number} ('${step.step_key}') failed deterministically (${errorCode}: ${errorDetail})`,
    };
  } catch (error) {
    if (error instanceof ClaimConflict) return conflictOutcome(target, false, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface AttemptEvidenceFields {
  outcome: 'completed' | 'checkpoint' | 'wait' | 'failed' | 'abandoned';
  waitKind?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  checkpoint?: unknown;
}

async function insertAttemptEvidence(
  tx: Queryable,
  ctx: TenantContext,
  target: PumpTarget,
  invocationNumber: number,
  claimedAt: Date,
  fields: AttemptEvidenceFields,
): Promise<void> {
  await tx.query(
    `INSERT INTO workflow_step_attempts (
       tenant_id, run_id, step_number, invocation, outcome, wait_kind,
       error_code, error_detail, checkpoint, started_at, finished_at, recorded_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
     ON CONFLICT (tenant_id, run_id, step_number, invocation) DO NOTHING`,
    [
      ctx.tenantId,
      target.run.id,
      target.step.step_number,
      invocationNumber,
      fields.outcome,
      fields.waitKind ?? null,
      fields.errorCode ?? null,
      fields.errorDetail ?? null,
      JSON.stringify(fields.checkpoint ?? null),
      claimedAt,
      now(),
      ctx.principalId,
    ],
  );
}

function conflictOutcome(
  target: PumpTarget,
  recovered: boolean,
  reason: string,
): WorkflowPumpOutcome {
  return {
    status: 'conflict',
    runId: target.run.id,
    stepNumber: target.step.step_number,
    runStatus: null,
    recovered,
    detail: `guarded transition lost its race on run ${target.run.id} step ${target.step.step_number} — ${reason}`,
  };
}

export { runContextOf };
