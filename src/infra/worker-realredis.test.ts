// REAL Redis queue integration (W069 — acceptance: "real queue/worker
// execution"). Activates ONLY when AURUM_TEST_REDIS_URL is provided (a
// real server, e.g. local redis or Upstash); skipped otherwise. In CI
// this runs against the redis:7 service container — the same ioredis
// backend (REDIS_URL) that Upstash speaks in production.
//
// The queue port's singleton is LAZY (REDIS_URL is read at first use),
// so the redis backend is selected in beforeAll — before the first
// getQueue() call — and the aurum queue keys are flushed around the run
// for deterministic depths.
//
// Proves on the REAL server:
//   * enqueue/dequeue round-trip and depth bookkeeping (LLEN) through
//     the queue port's redis backend;
//   * the worker seam drains jobs carried by real redis: two executions
//     interleaved, one bounded stage per job, persisted cognition steps
//     (embedded PostgreSQL), duplicate-delivery idempotency and the
//     dead-letter queue — i.e. "real queue/worker execution" end to end.

const realRedisUrl = process.env.AURUM_TEST_REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { closeDb, getDb } from '@/infra/db';
import { closeQueue, getQueue } from '@/infra/queue';
import { newId } from '@/infra/ids';
import { runMigrations } from '../../scripts/migrate';
import {
  enqueueCognitionStage,
  processNextCognitionJob,
  runWorkerBatch,
  workerQueueDepth,
} from '@/infra/worker';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, startExecution } from '@/modules/cognition/contract';

const tenant = newId();

function member(): TenantContext {
  return { tenantId: tenant, principalId: newId(), authority: [] };
}

function observationInput(text: string): Record<string, unknown> {
  return {
    record: [
      {
        kind: 'channel.message',
        payload: { text },
        observedAt: new Date().toISOString(),
        source: { kind: 'source', label: 'slack' },
        channel: 'slack',
        confidence: { value: 0.8, method: 'test' },
      },
    ],
  };
}

describe.skipIf(realRedisUrl === undefined)('worker seam against a REAL Redis server', () => {
  let cleaner: Redis;

  beforeAll(async () => {
    // Embedded PostgreSQL for the domain writes; REAL redis for the queue.
    process.env.AURUM_DB = 'embedded';
    process.env.AURUM_DB_MEMORY = '1';
    delete process.env.DATABASE_URL;
    // Selected before the first getQueue() call (the singleton is lazy).
    process.env.REDIS_URL = realRedisUrl;

    cleaner = new Redis(realRedisUrl!);
    await cleaner.del('aurum:queue:cognition', 'aurum:queue:cognition-dead');

    await runMigrations(getDb());
  });

  afterAll(async () => {
    await closeQueue();
    await cleaner.del('aurum:queue:cognition', 'aurum:queue:cognition-dead');
    await cleaner.quit();
    await closeDb();
    delete process.env.REDIS_URL;
  });

  it('round-trips messages through the redis backend with depth bookkeeping', async () => {
    const queue = getQueue();
    await queue.enqueue('depth-check', { hello: 'world' });
    await queue.enqueue('depth-check', { again: true });
    expect(await queue.depth('depth-check')).toBe(2);
    expect(await queue.dequeue('depth-check')).toEqual({ hello: 'world' });
    expect(await queue.depth('depth-check')).toBe(1);
    expect(await queue.dequeue('depth-check')).toEqual({ again: true });
    expect(await queue.depth('depth-check')).toBe(0);
    expect(await queue.dequeue('depth-check')).toBeNull();
  });

  it('drives cognition stages carried by real redis (interleaved executions, duplicates, dead-letter)', async () => {
    const ctx = member();
    const first = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'real-redis-a' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 real Redis evidence (a)',
    });
    const second = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'real-redis-b' },
      focus: { topics: ['pricing'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 real Redis evidence (b)',
    });

    // Interleave two executions' stage jobs on the real queue.
    await enqueueCognitionStage(ctx, {
      executionId: first.id,
      stage: 'observation',
      input: observationInput('real-redis churn signal'),
    });
    await enqueueCognitionStage(ctx, {
      executionId: second.id,
      stage: 'observation',
      input: observationInput('real-redis pricing signal'),
    });
    // A duplicate of the first job — at-least-once delivery redelivery.
    await enqueueCognitionStage(ctx, {
      executionId: first.id,
      stage: 'observation',
      input: observationInput('real-redis churn signal'),
    });
    // A deterministic-invalid job for the first execution.
    await enqueueCognitionStage(ctx, {
      executionId: first.id,
      stage: 'evidence-memory',
      input: {},
    });
    expect(await workerQueueDepth()).toBe(4);

    const batch = await runWorkerBatch(10);
    expect(batch.processed).toBe(4);
    expect(batch.outcomes.map((outcome) => outcome.status)).toEqual([
      'processed',
      'processed',
      'duplicate',
      'processed',
    ]);
    expect(batch.queueDepth).toBe(0);

    // Both executions hold exactly ONE persisted step each; the
    // duplicate added nothing and the evidence-memory job advanced the
    // first execution to stage 2.
    const firstTrace = await getExecution(ctx, { executionId: first.id });
    const secondTrace = await getExecution(ctx, { executionId: second.id });
    expect(firstTrace.steps).toHaveLength(2);
    expect(firstTrace.steps[0]!.stage).toBe('observation');
    expect(firstTrace.steps[1]!.stage).toBe('evidence-memory');
    expect(secondTrace.steps).toHaveLength(1);

    // The queue is truly empty on the real server.
    expect(await processNextCognitionJob()).toMatchObject({ status: 'idle' });
  });

  it('dead-letters invalid envelopes on the real server', async () => {
    await getQueue().enqueue('cognition', { kind: 'garbage' });
    const outcome = await processNextCognitionJob();
    expect(outcome.status).toBe('dead_letter');
    expect(await getQueue().depth('cognition-dead')).toBe(1);
    const dead = (await getQueue().dequeue('cognition-dead')) as { raw?: unknown };
    expect(dead.raw).toEqual({ kind: 'garbage' });
  });
});
