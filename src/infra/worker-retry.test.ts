// Unit tests for the worker's delivery semantics under contract faults
// (W069): retry escalation for TRANSIENT failures, immediate
// dead-lettering for DETERMINISTIC rejections, conflict and suspension
// mapping. The W013 contract is mocked at the module seam so failures
// can be injected deterministically; the real-contract behavior is
// covered by worker.test.ts and the real-provider suites.
//
// Retry policy under test: AURUM_WORKER_MAX_ATTEMPTS=2 — one original
// delivery plus one retry, then the dead-letter queue.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
process.env.AURUM_WORKER_MAX_ATTEMPTS = '2';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contractMock = vi.hoisted(() => {
  class CognitionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'CognitionError';
    }
  }
  const LOOP_STAGES = [
    'observation',
    'evidence-memory',
    'world-update',
    'epistemic-evaluation',
    'goal-evaluation',
    'unknown-mission-evaluation',
    'knowledge-acquisition',
    'model-update',
    'risk-opportunity-capability-analysis',
    'recommendation-ask-proposal-action',
    'outcome',
    'learning',
  ] as const;
  return {
    CognitionError,
    LOOP_STAGES,
    MAX_STAGE_INPUT_BYTES: 65_536,
    isLoopStage: (value: unknown) =>
      typeof value === 'string' && (LOOP_STAGES as readonly string[]).includes(value),
    isUuid: (value: unknown) =>
      typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
    runNextStage: vi.fn(),
  };
});
vi.mock('@/modules/cognition/contract', () => contractMock);

import { closeQueue, getQueue } from '@/infra/queue';
import { newId } from '@/infra/ids';
import { processNextCognitionJob } from '@/infra/worker';
import type { CognitionStageJob } from '@/infra/worker';

const EXECUTION_ID = '11111111-2222-3333-4444-555555555555';

function job(overrides: Partial<CognitionStageJob> = {}): CognitionStageJob {
  return {
    kind: 'cognition-stage',
    executionId: EXECUTION_ID,
    stage: 'observation',
    tenantId: newId(),
    principalId: newId(),
    authority: [],
    input: {},
    attempt: 1,
    enqueuedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function drain(): Promise<void> {
  while ((await getQueue().dequeue('cognition')) !== null) {
    /* discard */
  }
  while ((await getQueue().dequeue('cognition-dead')) !== null) {
    /* discard */
  }
}

beforeEach(() => {
  contractMock.runNextStage.mockReset();
});

afterEach(async () => {
  await drain();
});

afterAll(async () => {
  delete process.env.AURUM_WORKER_MAX_ATTEMPTS;
  await closeQueue();
});

describe('transient failure retry (fail-safe default for unknown errors)', () => {
  it('re-enqueues with attempt+1, then dead-letters when attempts are exhausted', async () => {
    contractMock.runNextStage.mockRejectedValue(new Error('connection reset by peer'));

    // Attempt 1: transient → retry scheduled.
    await getQueue().enqueue('cognition', job());
    const first = await processNextCognitionJob();
    expect(first.status).toBe('retry_scheduled');
    expect(first.attempt).toBe(1);
    expect(first.detail).toContain('attempt 1/2');
    expect(await getQueue().depth('cognition')).toBe(1);

    // The re-enqueued job carries attempt=2.
    const retried = (await getQueue().dequeue('cognition')) as CognitionStageJob;
    expect(retried.attempt).toBe(2);
    expect(retried.executionId).toBe(EXECUTION_ID);

    // Attempt 2 (= max): exhausted → dead-letter, nothing re-enqueued.
    await getQueue().enqueue('cognition', retried);
    const second = await processNextCognitionJob();
    expect(second.status).toBe('dead_letter');
    expect(second.detail).toContain('all 2 attempt');
    expect(await getQueue().depth('cognition')).toBe(0);
    const dead = (await getQueue().dequeue('cognition-dead')) as CognitionStageJob & {
      reason?: string;
    };
    expect(dead.executionId).toBe(EXECUTION_ID);
    expect(dead.attempt).toBe(2);
    expect(dead.reason).toContain('connection reset');
  });

  it('one successful retry heals the delivery', async () => {
    contractMock.runNextStage
      .mockRejectedValueOnce(new Error('db restarting'))
      .mockResolvedValueOnce({
        state: 'running',
        completedStages: 3,
        correlationId: 'corr-1',
      });

    await getQueue().enqueue('cognition', job());
    const first = await processNextCognitionJob();
    expect(first.status).toBe('retry_scheduled');

    const retried = (await getQueue().dequeue('cognition')) as CognitionStageJob;
    await getQueue().enqueue('cognition', retried);
    const second = await processNextCognitionJob();
    expect(second.status).toBe('processed');
    expect(second.completedStages).toBe(3);
    expect(second.correlationId).toBe('corr-1');
  });
});

describe('deterministic contract rejections dead-letter immediately', () => {
  it.each(['invalid_stage_input', 'invalid_reference', 'observation_rejected', 'stage_write_rejected', 'invalid_context'])(
    'code %s never re-enqueues',
    async (code) => {
      contractMock.runNextStage.mockRejectedValue(
        new contractMock.CognitionError(code, 'rejected'),
      );
      await getQueue().enqueue('cognition', job());
      const outcome = await processNextCognitionJob();
      expect(outcome.status).toBe('dead_letter');
      expect(outcome.detail).toContain(code);
      expect(await getQueue().depth('cognition')).toBe(0);
      expect(await getQueue().depth('cognition-dead')).toBe(1);
      await getQueue().dequeue('cognition-dead');
    },
  );
});

describe('idempotent / benign dispositions', () => {
  it('stage_mismatch (already advanced) is acknowledged as a duplicate', async () => {
    contractMock.runNextStage.mockRejectedValue(
      new contractMock.CognitionError('stage_mismatch', 'stage already advanced'),
    );
    await getQueue().enqueue('cognition', job());
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('duplicate');
    expect(await getQueue().depth('cognition')).toBe(0);
    expect(await getQueue().depth('cognition-dead')).toBe(0);
  });

  it('invalid_transition (terminal execution) is acknowledged as a stale duplicate', async () => {
    contractMock.runNextStage.mockRejectedValue(
      new contractMock.CognitionError('invalid_transition', 'execution is completed'),
    );
    await getQueue().enqueue('cognition', job());
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('duplicate');
    expect(outcome.detail).toContain('terminal');
  });

  it('execution_conflict (concurrent pump won) is acknowledged, not retried', async () => {
    contractMock.runNextStage.mockRejectedValue(
      new contractMock.CognitionError('execution_conflict', 'another pump advanced the stage'),
    );
    await getQueue().enqueue('cognition', job());
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('conflict');
    expect(await getQueue().depth('cognition')).toBe(0);
  });

  it('execution_not_found is consumed and never retried', async () => {
    contractMock.runNextStage.mockRejectedValue(
      new contractMock.CognitionError('execution_not_found', 'unknown execution'),
    );
    await getQueue().enqueue('cognition', job());
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('not_found');
    expect(await getQueue().depth('cognition')).toBe(0);
  });

  it('a suspended trace (awaiting_approval / awaiting_input) consumes the job', async () => {
    for (const state of ['awaiting_approval', 'awaiting_input'] as const) {
      contractMock.runNextStage.mockResolvedValueOnce({
        state,
        completedStages: 9,
        correlationId: 'corr-2',
      });
      await getQueue().enqueue('cognition', job());
      const outcome = await processNextCognitionJob();
      expect(outcome.status).toBe('suspended');
      expect(outcome.executionState).toBe(state);
      expect(outcome.completedStages).toBe(9);
      expect(outcome.detail).toContain('resume with a new job');
      // Nothing re-enqueued — the suspension IS the persisted state.
      expect(await getQueue().depth('cognition')).toBe(0);
    }
  });

  it('an empty queue reports idle', async () => {
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('idle');
    expect(outcome.detail).toBe('queue empty');
  });
});
