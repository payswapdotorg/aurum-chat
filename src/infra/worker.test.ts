// Integration tests for the worker core (W069) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port and the memory
// queue backend — the full execution seam with REAL module contracts:
//
//   * REAL QUEUE/WORKER EXECUTION: one job = ONE bounded canonical stage
//     advanced through the frozen W013 contract; the step and lifecycle
//     state are PERSISTED by the contract (the worker writes no domain
//     state — it is never the source of truth).
//   * QUEUED EXECUTION RESUMES: a queued job picks the execution up from
//     its persisted position (completedStages) and advances exactly one
//     stage; the batch runner drains until idle.
//   * DUPLICATE DELIVERY IS IDEMPOTENT: re-delivering a consumed job
//     fails `stage_mismatch` and is ACKNOWLEDGED as a duplicate — no new
//     step, no retry storm; stale jobs for terminal executions fail
//     `invalid_transition` and are acknowledged the same way.
//   * FAILED DELIVERY handling: deterministic contract rejections go
//     straight to the dead-letter queue; invalid envelopes are
//     dead-lettered without retry.
//   * APPROVAL SUSPENSION SURVIVES RESTARTS: a gated action suspends the
//     execution (`awaiting_approval`, persisted); the human decision
//     lands through the actions contract BETWEEN worker jobs; a NEW job
//     for the suspended stage resumes the execution and the cycle
//     completes — the worker holds no state of its own, so "restart" is
//     just the next job.
//   * OBSERVABILITY: the counters registry and queue depth bookkeeping
//     behave (the /api/worker and /api/health surfaces expose them).
//
// Retry escalation to exhaustion (transient errors) needs contract
// fault injection and lives in worker-retry.test.ts; the real-server
// variants (real PostgreSQL / real Redis) live in
// worker-realproviders.test.ts.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { closeQueue, getQueue } from '@/infra/queue';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  decideApproval,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  enqueueCognitionStage,
  getWorkerMetrics,
  processNextCognitionJob,
  resetWorkerMetrics,
  runWorkerBatch,
  workerQueueDepth,
} from '@/infra/worker';
import type { JobOutcome } from '@/infra/worker';
import {
  getExecution,
  startExecution,
} from '@/modules/cognition/contract';
import type { LoopStage } from '@/modules/cognition/contract';
import { runMigrations } from '../../scripts/migrate';

const tenant = newId();

function member(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [] };
}
function admin(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}
function approver(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

/** Minimal per-stage payloads (the W013 bounded-reasoning seam defaults). */
const STAGE_INPUTS: Partial<Record<LoopStage, Record<string, unknown>>> = {
  observation: {
    record: [
      {
        kind: 'channel.message',
        payload: { text: 'churn spiked 12% in Q3' },
        observedAt: new Date().toISOString(),
        source: { kind: 'source', label: 'slack' },
        channel: 'slack',
        confidence: { value: 0.8, method: 'test' },
      },
    ],
  },
  'evidence-memory': {},
  'world-update': { update: null },
  'epistemic-evaluation': { claims: [] },
  'goal-evaluation': { relatedGoalIds: [] },
  'unknown-mission-evaluation': { unknowns: [], missions: [] },
  'knowledge-acquisition': { missionId: null },
  'model-update': { belief: null },
  'risk-opportunity-capability-analysis': { findings: [] },
  'recommendation-ask-proposal-action': { action: null },
  outcome: { summary: 'worker-driven cycle concluded' },
  learning: { knowledge: null },
};

/** Enqueue + process exactly one stage job through the seam. */
async function pumpStage(ctx: TenantContext, executionId: string, stage: LoopStage): Promise<JobOutcome> {
  await enqueueCognitionStage(ctx, { executionId, stage, input: STAGE_INPUTS[stage] ?? {} });
  const outcome = await processNextCognitionJob();
  expect(outcome.status).not.toBe('idle');
  return outcome;
}

let executionId: string;
let driver: TenantContext;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeQueue();
  await closeDb();
});

beforeEach(() => {
  resetWorkerMetrics();
});

describe('worker execution seam (real contracts, embedded PostgreSQL)', () => {
  it('starts a cycle and advances exactly ONE bounded stage per job', async () => {
    driver = member();
    const execution = await startExecution(driver, {
      trigger: { kind: 'system', label: 'worker-integration' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 worker seam integration',
    });
    executionId = execution.id;
    expect(execution.completedStages).toBe(0);

    const outcome = await pumpStage(driver, executionId, 'observation');
    expect(outcome.status).toBe('processed');
    expect(outcome.executionId).toBe(executionId);
    expect(outcome.executionState).toBe('running');
    expect(outcome.completedStages).toBe(1);
    expect(outcome.correlationId).toBe(execution.correlationId);

    // The step is persisted by the CONTRACT (trace), with the job's
    // serialized principal recorded as the advancer.
    const trace = await getExecution(driver, { executionId });
    expect(trace.completedStages).toBe(1);
    expect(trace.nextStage).toBe('evidence-memory');
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]!.stage).toBe('observation');
    expect(trace.steps[0]!.advancedByPrincipal).toBe(driver.principalId);

    const metrics = getWorkerMetrics();
    expect(metrics.jobsEnqueued).toBe(1);
    expect(metrics.jobsProcessed).toBe(1);
  });

  it('a queued execution resumes from its persisted position', async () => {
    // A "new worker" processes a NEW job for the same execution: the
    // persisted position (completedStages=1) decides what runs next.
    const outcome = await pumpStage(driver, executionId, 'evidence-memory');
    expect(outcome.status).toBe('processed');
    expect(outcome.completedStages).toBe(2);

    const trace = await getExecution(driver, { executionId });
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1]!.stage).toBe('evidence-memory');
  });

  it('duplicate delivery is idempotent — no second step, no retry storm', async () => {
    const before = await getExecution(driver, { executionId });
    // Re-deliver the ALREADY-CONSUMED evidence-memory job (the queue is
    // at-least-once; the persisted execution state is the idempotency
    // authority).
    const duplicate = await pumpStage(driver, executionId, 'evidence-memory');
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.detail).toContain('already advanced');

    const after = await getExecution(driver, { executionId });
    expect(after.steps).toHaveLength(before.steps.length);
    expect(after.completedStages).toBe(before.completedStages);
    expect(getWorkerMetrics().jobsDuplicate).toBe(1);
  });

  it('an unknown execution is consumed, never retried', async () => {
    const stray = newId();
    await enqueueCognitionStage(driver, { executionId: stray, stage: 'outcome', input: STAGE_INPUTS.outcome! });
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('not_found');
    expect(getWorkerMetrics().jobsNotFound).toBe(1);
  });

  it('deterministic rejections dead-letter immediately (no useless retries)', async () => {
    // A real execution, an impossible stage input: the contract rejects
    // deterministically, so the job is dead-lettered, not re-enqueued.
    const bad = await startExecution(driver, {
      trigger: { kind: 'system', label: 'bad-input' },
      focus: { topics: ['x'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'dead-letter path',
    });
    await enqueueCognitionStage(driver, {
      executionId: bad.id,
      stage: 'observation',
      input: { record: [{ not: 'an observation' }] },
    });
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('dead_letter');
    expect(getWorkerMetrics().jobsDeadLettered).toBe(1);
    expect(await getQueue().depth('cognition-dead')).toBe(1);

    // The dead-lettered payload is inspectable for the operator.
    const dead = await getQueue().dequeue('cognition-dead');
    expect(dead).toMatchObject({ kind: 'cognition-stage', executionId: bad.id, attempt: 1 });
  });

  it('invalid job envelopes are dead-lettered without ever reaching the contract', async () => {
    await getQueue().enqueue('cognition', { kind: 'something-else' });
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('dead_letter');
    expect(outcome.detail).toContain('invalid job envelope');
    const dead = await getQueue().dequeue('cognition-dead');
    expect(dead).toMatchObject({ raw: { kind: 'something-else' } });
  });

  it('approval suspension survives between jobs — the human decision resumes the cycle', async () => {
    // Tenant policy: employee messaging requires human approval at ASK.
    await setAuthorityPolicy(admin(), {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
    });

    // Drive stages 3..9 (world-update … risk-opportunity analysis) —
    // one bounded job each.
    const middleStages: LoopStage[] = [
      'world-update',
      'epistemic-evaluation',
      'goal-evaluation',
      'unknown-mission-evaluation',
      'knowledge-acquisition',
      'model-update',
      'risk-opportunity-capability-analysis',
    ];
    for (const stage of middleStages) {
      const outcome = await pumpStage(driver, executionId, stage);
      expect(outcome.status).toBe('processed');
    }
    let trace = await getExecution(driver, { executionId });
    expect(trace.nextStage).toBe('recommendation-ask-proposal-action');

    // The gated proposal SUSPENDS the execution — the job is consumed.
    await enqueueCognitionStage(driver, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      input: {
        action: {
          actionKind: 'employee-messaging',
          authorityLevel: 'ASK',
          payload: { to: 'vp-cs', question: 'Why did churn rise?' },
          justification: 'worker-seam gated proposal',
        },
      },
    });
    const suspended = await processNextCognitionJob();
    expect(suspended.status).toBe('suspended');
    expect(suspended.executionState).toBe('awaiting_approval');

    // The suspension is PERSISTED domain state — a "restarted" worker
    // (any later job, any process) sees exactly this position.
    trace = await getExecution(driver, { executionId });
    expect(trace.state).toBe('awaiting_approval');
    expect(trace.pending.requestId).not.toBeNull();
    expect(getWorkerMetrics().jobsSuspended).toBe(1);

    // The human decision lands BETWEEN jobs (actions contract — a
    // different principal, separation of duties).
    const decided = await decideApproval(approver(), {
      requestId: trace.pending.requestId!,
      decision: 'approve',
      note: 'validated need',
    });
    expect(decided.status).toBe('approved');

    // A NEW job for the suspended stage resumes and completes the gate.
    const resumed = await pumpStage(driver, executionId, 'recommendation-ask-proposal-action');
    expect(resumed.status).toBe('processed');
    expect(resumed.executionState).toBe('running');
    expect(resumed.completedStages).toBe(10);

    // The cycle finishes through the seam: outcome + learning.
    const outcomeStage = await pumpStage(driver, executionId, 'outcome');
    expect(outcomeStage.status).toBe('processed');
    const learning = await pumpStage(driver, executionId, 'learning');
    expect(learning.status).toBe('processed');
    expect(learning.executionState).toBe('completed');
    expect(learning.completedStages).toBe(12);

    trace = await getExecution(driver, { executionId });
    expect(trace.state).toBe('completed');
    expect(trace.outcome).toMatchObject({ kind: 'action-authorized' });
    expect(trace.steps).toHaveLength(12);
  });

  it('stale jobs for a completed execution are acknowledged (terminal, not retried)', async () => {
    const stale = await pumpStage(driver, executionId, 'outcome');
    expect(stale.status).toBe('duplicate');
    expect(stale.detail).toContain('terminal');
  });

  it('runWorkerBatch drains the queue and stops on idle', async () => {
    // Start a fresh execution and enqueue THREE stages without pumping.
    const execution = await startExecution(driver, {
      trigger: { kind: 'system', label: 'batch-drain' },
      focus: { topics: ['batch'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'batch runner',
    });
    await enqueueCognitionStage(driver, { executionId: execution.id, stage: 'observation', input: STAGE_INPUTS.observation! });
    await enqueueCognitionStage(driver, { executionId: execution.id, stage: 'evidence-memory' });
    await enqueueCognitionStage(driver, { executionId: execution.id, stage: 'world-update', input: { update: null } });
    expect(await workerQueueDepth()).toBe(3);

    const batch = await runWorkerBatch(10);
    expect(batch.processed).toBe(3);
    expect(batch.outcomes.map((o) => o.status)).toEqual(['processed', 'processed', 'processed']);
    expect(batch.queueDepth).toBe(0);

    // A second batch on the now-empty queue is an idle no-op.
    const idle = await runWorkerBatch(10);
    expect(idle.processed).toBe(0);
    expect(idle.outcomes).toEqual([]);
    expect(getWorkerMetrics().idlePolls).toBeGreaterThanOrEqual(1);
  });

  it('enqueueCognitionStage validates the job before it ever reaches the queue', async () => {
    await expect(
      enqueueCognitionStage(driver, { executionId: 'not-a-uuid', stage: 'outcome' }),
    ).rejects.toThrow(/uuid/);
    await expect(
      enqueueCognitionStage(driver, { executionId: newId(), stage: 'not-a-stage' as LoopStage }),
    ).rejects.toThrow(/canonical loop stages/);
    expect(await workerQueueDepth()).toBe(0);
  });
});
