// Worker core: the provider-neutral cognition job execution seam (W069).
//
// IMPLEMENTATION-STACK §5 charters exactly this seam: "Long-running
// cognition (W013+): `scripts/worker.ts` process consuming `infra/queue`
// jobs; jobs are resumable, traceable execution records (lock 36)." The
// product-surface plan (§7 "Worker deployment requirement") requires the
// seam be drivable BOTH as a long-running process AND over HTTP (a
// serverless host has no resident process), so the executable core lives
// here — one shared implementation — behind two thin entrypoints:
//
//   * `scripts/worker.ts`  — the resident process (dev, self-hosted,
//     Profile B): polls the queue port, drains bounded batches.
//   * `/api/worker`        — the HTTP execution seam (Vercel): the same
//     `runWorkerBatch` core behind token auth, driven by cron sweeps,
//     manual triggers or a platform queue consumer.
//
// WHAT A JOB IS: one job = ONE bounded canonical stage of ONE cognitive
// execution (lock 36: "asynchronous, resumable and traceable"). The job
// envelope carries a serialized TenantContext (explicit context — never
// ambient; the enqueueing side decides which principal drives the pump)
// plus the stage input composed at enqueue time. The worker performs NO
// reasoning: order, gates, persistence and traceability stay inside the
// W013 contract (`runNextStage`), which remains the ONLY writer of
// execution state — the worker never becomes a source of domain truth.
//
// IDEMPOTENCY (plan §7: "duplicate delivery is idempotent"): the
// execution's own persisted state is the idempotency authority. The
// queue port is at-least-once, so a redelivered job whose stage already
// advanced fails with `stage_mismatch` and is ACKNOWLEDGED as a duplicate
// (no side effect, no retry); a job for a terminal execution fails with
// `invalid_transition` and is likewise acknowledged. Exactly-once
// bookkeeping is deliberately NOT reinvented on top of Redis.
//
// RETRY (plan §7: "a failed delivery is retried"): errors the W013
// contract classifies as deterministic (bad input, unreadable references,
// rejected writes) dead-letter immediately — retrying cannot change their
// outcome. Anything else (database, network, provider blips) is retried
// by re-enqueueing with attempt+1 up to the deployment guardrail, then
// dead-lettered to `cognition-dead` for operator inspection.
//
// SUSPENSION (plan §7: "approval/input suspensions survive worker
// restarts"): when a stage suspends the execution (`awaiting_approval` /
// `awaiting_input`) the job is CONSUMED — the suspension is persisted
// domain state. A human decision (actions contract) or an acquisition
// outcome releases it; the next job for the same stage resumes the
// execution from its persisted position, in this process or any other.
//
// Placement note: this file lives in src/infra (not a domain module) as
// execution infrastructure per lock 36 — it invents no domain concepts
// and writes no domain state; its single domain touchpoint is the frozen
// cognition CONTRACT, imported exactly the way IMPLEMENTATION-STACK §5
// assigns to the worker process. The architecture gate's rules are
// unchanged: domain modules import no drivers; nothing here is imported
// by domain modules.

import { getQueue } from './queue';
import { now } from './clock';
import { resolveDeploymentProfile } from './deployment';
import { CognitionError, LOOP_STAGES, MAX_STAGE_INPUT_BYTES, isLoopStage, isUuid, runNextStage } from '@/modules/cognition/contract';
import type { AdvanceExecutionInput } from '@/modules/cognition/contract';
import type { CognitiveExecutionTrace, ExecutionState, LoopStage } from '@/modules/cognition/contract';

/** Queue serving cognition stage jobs (redis-backed key: aurum:queue:cognition). */
export const WORKER_QUEUE = 'cognition';
/** Where exhausted/unprocessable jobs land for operator inspection. */
export const WORKER_DEAD_LETTER_QUEUE = 'cognition-dead';

/**
 * One queued cognition stage delivery. `input` is the stage payload
 * WITHOUT `executionId`/`stage` (the reconstruction is
 * `{ executionId, stage, ...input }`); it must stay within the W013 stage
 * input size cap.
 */
export interface CognitionStageJob {
  kind: 'cognition-stage';
  executionId: string;
  stage: LoopStage;
  tenantId: string;
  principalId: string;
  authority: string[];
  input: Record<string, unknown>;
  /** 1-based delivery attempt (retry = attempt + 1). */
  attempt: number;
  /** ISO 8601 enqueue timestamp. */
  enqueuedAt: string;
}

/** The disposition of one processed job (or an idle poll). */
export type JobOutcomeStatus =
  | 'idle' // queue empty at this poll
  | 'processed' // one bounded stage advanced and persisted
  | 'suspended' // stage ran; execution awaits human input/approval
  | 'duplicate' // idempotent no-op — the execution already moved on
  | 'conflict' // a concurrent pump won this stage; nothing to do
  | 'not_found' // execution unknown in this tenant; never retried
  | 'retry_scheduled' // transient failure; re-enqueued with attempt+1
  | 'dead_letter'; // non-retryable failure, or attempts exhausted

export interface JobOutcome {
  status: JobOutcomeStatus;
  executionId: string | null;
  attempt: number | null;
  /** Post-job execution state, when the contract returned a trace. */
  executionState: ExecutionState | null;
  completedStages: number | null;
  /** §25 correlation id of the execution, when known. */
  correlationId: string | null;
  detail: string;
}

/** Counters for worker observability (surfaced by /api/health and /api/worker). */
export interface WorkerMetrics {
  jobsEnqueued: number;
  jobsProcessed: number;
  jobsSuspended: number;
  jobsDuplicate: number;
  jobsConflict: number;
  jobsNotFound: number;
  jobsRetried: number;
  jobsDeadLettered: number;
  idlePolls: number;
  batches: number;
  lastActivityAt: string | null;
}

interface WorkerGlobal {
  __aurumWorkerMetrics?: WorkerMetrics;
}
const workerGlobal = globalThis as unknown as WorkerGlobal;

function metrics(): WorkerMetrics {
  workerGlobal.__aurumWorkerMetrics ??= {
    jobsEnqueued: 0,
    jobsProcessed: 0,
    jobsSuspended: 0,
    jobsDuplicate: 0,
    jobsConflict: 0,
    jobsNotFound: 0,
    jobsRetried: 0,
    jobsDeadLettered: 0,
    idlePolls: 0,
    batches: 0,
    lastActivityAt: null,
  };
  return workerGlobal.__aurumWorkerMetrics;
}

/** Snapshot of the worker counters (process-local; free-tier observability). */
export function getWorkerMetrics(): WorkerMetrics {
  return { ...metrics() };
}

/** Reset the counters (tests). */
export function resetWorkerMetrics(): void {
  workerGlobal.__aurumWorkerMetrics = undefined;
}

/** One structured log line — the worker's whole observability trail. */
function logWorkerEvent(event: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: now().toISOString(),
      component: 'aurum-worker',
      ...event,
    }),
  );
}

/**
 * Validate a raw dequeued value as a cognition stage job. Returns the job
 * or an error string (pure — unit-tested directly).
 */
export function validateCognitionJob(raw: unknown): { job: CognitionStageJob } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'job must be a JSON object' };
  }
  const candidate = raw as Partial<CognitionStageJob>;
  if (candidate.kind !== 'cognition-stage') {
    return { error: `job kind must be 'cognition-stage'` };
  }
  if (!isUuid(candidate.executionId)) {
    return { error: 'job executionId must be a uuid' };
  }
  if (typeof candidate.stage !== 'string' || !isLoopStage(candidate.stage)) {
    return {
      error: `job stage must be one of the canonical loop stages (${LOOP_STAGES.join(', ')})`,
    };
  }
  if (
    typeof candidate.tenantId !== 'string' ||
    candidate.tenantId.trim().length === 0 ||
    candidate.tenantId.length > 128
  ) {
    return { error: 'job tenantId must be a non-empty string (≤128 chars)' };
  }
  if (
    typeof candidate.principalId !== 'string' ||
    candidate.principalId.trim().length === 0 ||
    candidate.principalId.length > 128
  ) {
    return { error: 'job principalId must be a non-empty string (≤128 chars)' };
  }
  if (!Array.isArray(candidate.authority) || candidate.authority.some((c) => typeof c !== 'string')) {
    return { error: 'job authority must be an array of claim strings' };
  }
  if (
    typeof candidate.input !== 'object' ||
    candidate.input === null ||
    Array.isArray(candidate.input)
  ) {
    return { error: 'job input must be an object (the stage payload)' };
  }
  const serialized = JSON.stringify(candidate.input);
  if (serialized.length > MAX_STAGE_INPUT_BYTES) {
    return { error: `job input exceeds the stage input cap (${MAX_STAGE_INPUT_BYTES} bytes)` };
  }
  const attempt = candidate.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > 50) {
    return { error: 'job attempt must be an integer in 1..50' };
  }
  if (typeof candidate.enqueuedAt !== 'string' || Number.isNaN(Date.parse(candidate.enqueuedAt))) {
    return { error: 'job enqueuedAt must be an ISO 8601 timestamp' };
  }
  return {
    job: {
      kind: 'cognition-stage',
      executionId: candidate.executionId,
      stage: candidate.stage,
      tenantId: candidate.tenantId,
      principalId: candidate.principalId,
      authority: candidate.authority as string[],
      input: candidate.input,
      attempt,
      enqueuedAt: candidate.enqueuedAt,
    },
  };
}

/** Enqueue input: what the pumping side supplies for one stage. */
export interface EnqueueStageInput {
  executionId: string;
  stage: LoopStage;
  /** Stage payload WITHOUT executionId/stage keys. */
  input?: Record<string, unknown>;
}

/**
 * Enqueue one cognition stage job. The TenantContext is serialized into
 * the job (explicit context per the tenancy rule — the worker recreates
 * it verbatim; no ambient state). Attempt starts at 1.
 */
export async function enqueueCognitionStage(
  ctx: { tenantId: string; principalId: string; authority: string[] },
  input: EnqueueStageInput,
): Promise<CognitionStageJob> {
  const job: CognitionStageJob = {
    kind: 'cognition-stage',
    executionId: input.executionId,
    stage: input.stage,
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
    authority: ctx.authority,
    input: input.input ?? {},
    attempt: 1,
    enqueuedAt: now().toISOString(),
  };
  const validated = validateCognitionJob(job);
  if ('error' in validated) {
    throw new Error(`invalid cognition stage job: ${validated.error}`);
  }
  await getQueue().enqueue(WORKER_QUEUE, job);
  metrics().jobsEnqueued += 1;
  logWorkerEvent({ event: 'enqueued', executionId: job.executionId, stage: job.stage, attempt: 1 });
  return job;
}

function outcome(partial: Omit<JobOutcome, 'detail'> & { detail: string }): JobOutcome {
  return { ...partial };
}

/**
 * Execute ONE dequeued job against the W013 contract and map its result
 * to a delivery disposition (ack / retry / dead-letter). Pure decision
 * logic around the single contract call; no other domain access.
 */
export async function processCognitionJob(job: CognitionStageJob): Promise<JobOutcome> {
  const guardrails = resolveDeploymentProfile().guardrails;
  const ctx = { tenantId: job.tenantId, principalId: job.principalId, authority: job.authority };
  const advance = {
    executionId: job.executionId,
    stage: job.stage,
    ...job.input,
  } as unknown as AdvanceExecutionInput;

  try {
    const trace: CognitiveExecutionTrace = await runNextStage(ctx, advance);
    const m = metrics();
    m.lastActivityAt = now().toISOString();
    if (trace.state === 'awaiting_input' || trace.state === 'awaiting_approval') {
      m.jobsSuspended += 1;
      logWorkerEvent({
        event: 'suspended',
        executionId: job.executionId,
        stage: job.stage,
        state: trace.state,
        attempt: job.attempt,
        correlationId: trace.correlationId,
        note: 'suspension is persisted domain state — the next job resumes it',
      });
      return outcome({
        status: 'suspended',
        executionId: job.executionId,
        attempt: job.attempt,
        executionState: trace.state,
        completedStages: trace.completedStages,
        correlationId: trace.correlationId,
        detail: `execution ${job.executionId} is ${trace.state} at stage '${job.stage}' — job consumed, resume with a new job after the human decision`,
      });
    }
    m.jobsProcessed += 1;
    logWorkerEvent({
      event: 'processed',
      executionId: job.executionId,
      stage: job.stage,
      completedStages: trace.completedStages,
      state: trace.state,
      attempt: job.attempt,
      correlationId: trace.correlationId,
    });
    return outcome({
      status: 'processed',
      executionId: job.executionId,
      attempt: job.attempt,
      executionState: trace.state,
      completedStages: trace.completedStages,
      correlationId: trace.correlationId,
      detail: `stage '${job.stage}' advanced — ${trace.completedStages}/12 stages persisted, state '${trace.state}'`,
    });
  } catch (error) {
    const m = metrics();
    m.lastActivityAt = now().toISOString();
    if (error instanceof CognitionError) {
      switch (error.code) {
        case 'stage_mismatch': {
          m.jobsDuplicate += 1;
          logWorkerEvent({
            event: 'duplicate',
            executionId: job.executionId,
            stage: job.stage,
            attempt: job.attempt,
            reason: 'stage already advanced — persisted execution state is the idempotency authority',
          });
          return outcome({
            status: 'duplicate',
            executionId: job.executionId,
            attempt: job.attempt,
            executionState: null,
            completedStages: null,
            correlationId: null,
            detail: `duplicate delivery acknowledged — stage '${job.stage}' already advanced on execution ${job.executionId}`,
          });
        }
        case 'invalid_transition': {
          m.jobsDuplicate += 1;
          logWorkerEvent({
            event: 'duplicate',
            executionId: job.executionId,
            stage: job.stage,
            attempt: job.attempt,
            reason: 'execution is terminal — stale job acknowledged',
          });
          return outcome({
            status: 'duplicate',
            executionId: job.executionId,
            attempt: job.attempt,
            executionState: null,
            completedStages: null,
            correlationId: null,
            detail: `stale job acknowledged — execution ${job.executionId} is terminal (${error.message})`,
          });
        }
        case 'execution_conflict': {
          m.jobsConflict += 1;
          logWorkerEvent({
            event: 'conflict',
            executionId: job.executionId,
            stage: job.stage,
            attempt: job.attempt,
            reason: 'a concurrent pump won this stage',
          });
          return outcome({
            status: 'conflict',
            executionId: job.executionId,
            attempt: job.attempt,
            executionState: null,
            completedStages: null,
            correlationId: null,
            detail: `concurrent pump won stage '${job.stage}' on execution ${job.executionId} — nothing to do`,
          });
        }
        case 'execution_not_found': {
          m.jobsNotFound += 1;
          logWorkerEvent({
            event: 'not_found',
            executionId: job.executionId,
            stage: job.stage,
            attempt: job.attempt,
            reason: 'execution unknown in this tenant',
          });
          return outcome({
            status: 'not_found',
            executionId: job.executionId,
            attempt: job.attempt,
            executionState: null,
            completedStages: null,
            correlationId: null,
            detail: `execution ${job.executionId} is unknown in this tenant — job consumed, never retried`,
          });
        }
        default: {
          // Deterministic contract rejections: retrying cannot change the
          // outcome, so the job goes straight to the dead-letter queue.
          await getQueue().enqueue(WORKER_DEAD_LETTER_QUEUE, { ...job, deadLetteredAt: now().toISOString(), reason: error.message });
          m.jobsDeadLettered += 1;
          logWorkerEvent({
            event: 'dead_letter',
            executionId: job.executionId,
            stage: job.stage,
            attempt: job.attempt,
            reason: `deterministic rejection (${error.code})`,
          });
          return outcome({
            status: 'dead_letter',
            executionId: job.executionId,
            attempt: job.attempt,
            executionState: null,
            completedStages: null,
            correlationId: null,
            detail: `stage '${job.stage}' rejected deterministically (${error.code}: ${error.message}) — dead-lettered`,
          });
        }
      }
    }
    // Unknown/transient error (database, network, provider): retry while
    // attempts remain, else dead-letter.
    if (job.attempt < guardrails.workerMaxAttempts) {
      const retry: CognitionStageJob = {
        ...job,
        attempt: job.attempt + 1,
        enqueuedAt: now().toISOString(),
      };
      await getQueue().enqueue(WORKER_QUEUE, retry);
      m.jobsRetried += 1;
      logWorkerEvent({
        event: 'retry_scheduled',
        executionId: job.executionId,
        stage: job.stage,
        attempt: job.attempt,
        nextAttempt: retry.attempt,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
      return outcome({
        status: 'retry_scheduled',
        executionId: job.executionId,
        attempt: job.attempt,
        executionState: null,
        completedStages: null,
        correlationId: null,
        detail: `transient failure on stage '${job.stage}' (attempt ${job.attempt}/${guardrails.workerMaxAttempts}) — re-enqueued as attempt ${retry.attempt}`,
      });
    }
    await getQueue().enqueue(WORKER_DEAD_LETTER_QUEUE, {
      ...job,
      deadLetteredAt: now().toISOString(),
      reason: error instanceof Error ? error.message : 'unknown error',
    });
    m.jobsDeadLettered += 1;
    logWorkerEvent({
      event: 'dead_letter',
      executionId: job.executionId,
      stage: job.stage,
      attempt: job.attempt,
      reason: 'transient failure exhausted delivery attempts',
    });
    return outcome({
      status: 'dead_letter',
      executionId: job.executionId,
      attempt: job.attempt,
      executionState: null,
      completedStages: null,
      correlationId: null,
      detail: `stage '${job.stage}' failed on all ${job.attempt} attempt(s) — dead-lettered`,
    });
  }
}

/**
 * Dequeue and process ONE job; `idle` when the queue is empty. An invalid
 * envelope is dead-lettered (never retried — it can never become valid).
 */
export async function processNextCognitionJob(): Promise<JobOutcome> {
  const raw = await getQueue().dequeue(WORKER_QUEUE);
  if (raw === null) {
    metrics().idlePolls += 1;
    return outcome({
      status: 'idle',
      executionId: null,
      attempt: null,
      executionState: null,
      completedStages: null,
      correlationId: null,
      detail: 'queue empty',
    });
  }
  const validated = validateCognitionJob(raw);
  if ('error' in validated) {
    await getQueue().enqueue(WORKER_DEAD_LETTER_QUEUE, {
      raw,
      deadLetteredAt: now().toISOString(),
      reason: `invalid job envelope: ${validated.error}`,
    });
    metrics().jobsDeadLettered += 1;
    logWorkerEvent({ event: 'dead_letter', reason: `invalid job envelope: ${validated.error}` });
    return outcome({
      status: 'dead_letter',
      executionId: null,
      attempt: null,
      executionState: null,
      completedStages: null,
      correlationId: null,
      detail: `invalid job envelope dead-lettered: ${validated.error}`,
    });
  }
  return processCognitionJob(validated.job);
}

export interface WorkerBatchResult {
  /** Jobs actually processed in this batch (idle polls excluded). */
  processed: number;
  outcomes: JobOutcome[];
  queueDepth: number;
}

/**
 * Drain up to `limit` jobs (the deployment batch guardrail caps the
 * per-invocation budget). Stops early on an idle poll.
 */
export async function runWorkerBatch(limit: number): Promise<WorkerBatchResult> {
  const guardrails = resolveDeploymentProfile().guardrails;
  const capped = Math.max(1, Math.min(limit, guardrails.workerBatchLimit));
  const outcomes: JobOutcome[] = [];
  for (let i = 0; i < capped; i += 1) {
    const jobOutcome = await processNextCognitionJob();
    if (jobOutcome.status === 'idle') break;
    outcomes.push(jobOutcome);
  }
  metrics().batches += 1;
  return {
    processed: outcomes.length,
    outcomes,
    queueDepth: await getQueue().depth(WORKER_QUEUE),
  };
}

/** Current waiting jobs on the worker queue (observability). */
export async function workerQueueDepth(): Promise<number> {
  return getQueue().depth(WORKER_QUEUE);
}
