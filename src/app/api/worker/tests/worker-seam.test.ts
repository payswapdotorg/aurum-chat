// Integration tests for the HTTP worker execution seam (W069): the
// handleWorkerPost/handleWorkerGet handlers in src/app/api/worker/lib.ts,
// driven directly without booting Next.js (the repo's API-testing
// discipline). Real contracts against the embedded PostgreSQL + the
// memory queue:
//
//   * AUTH GUARDRAILS: tokenless operation is a development/preview
//     affordance only — production refuses fail-closed (503) when
//     WORKER_TOKEN is unset; wrong/missing tokens are 401 in every
//     environment; CRON_SECRET authenticates like the worker token
//     (Vercel cron deliveries).
//   * PULL MODE: POST with no body drains one guarded batch — real jobs
//     advance real executions through the W013 contract.
//   * PUSH MODE: POST with `{ jobs: [...] }` processes pushed deliveries
//     through the identical core path (invalid envelopes dead-letter).
//   * GET: observability snapshot; ?sweep=1 drains one batch first.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { closeQueue } from '@/infra/queue';
import { newId } from '@/infra/ids';
import { enqueueCognitionStage, resetWorkerMetrics } from '@/infra/worker';
import { handleWorkerGet, handleWorkerPost } from '../lib';
import { getExecution, startExecution } from '@/modules/cognition/contract';
import { runMigrations } from '../../../../../scripts/migrate';

const tenant = newId();
const member = () => ({ tenantId: tenant, principalId: newId(), authority: [] });

const WORKER_TOKEN_VALUE = ['worker', '-test', '-token'].join('');

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

function post(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://aurum.test/api/worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function get(path = '', headers: Record<string, string> = {}): Request {
  return new Request(`https://aurum.test/api/worker${path}`, { headers });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeQueue();
  await closeDb();
});

beforeEach(async () => {
  delete process.env.WORKER_TOKEN;
  delete process.env.CRON_SECRET;
  delete process.env.DEPLOYMENT_ENV;
  delete process.env.VERCEL_ENV;
  // Vitest runs with NODE_ENV=test; pin it type-safely against outer
  // environments so the profile resolution below stays deterministic.
  Object.assign(process.env, { NODE_ENV: 'test' });
  // Fresh memory queue + counters per test (residue from a previous
  // test's undrained jobs must never leak into the next assertion).
  await closeQueue();
  resetWorkerMetrics();
});

afterEach(() => {
  delete process.env.WORKER_TOKEN;
  delete process.env.CRON_SECRET;
  delete process.env.DEPLOYMENT_ENV;
  delete process.env.VERCEL_ENV;
});

describe('worker seam auth guardrails', () => {
  it('tokenless operation works in development (local exercise)', async () => {
    const result = await handleWorkerPost(post());
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe('pull');
  });

  it('production REFUSES a tokenless seam (fail closed)', async () => {
    process.env.DEPLOYMENT_ENV = 'production';
    const result = await handleWorkerPost(post());
    expect(result.status).toBe(503);
    expect(result.body.error).toContain('WORKER_TOKEN');
  });

  it('production REFUSES a tokenless GET too', async () => {
    process.env.DEPLOYMENT_ENV = 'production';
    const result = await handleWorkerGet(get());
    expect(result.status).toBe(503);
  });

  it('a missing token is 401 whenever tokens are configured', async () => {
    process.env.WORKER_TOKEN = WORKER_TOKEN_VALUE;
    const missing = await handleWorkerPost(post());
    expect(missing.status).toBe(401);
    expect(missing.body.error).toContain('worker token required');
  });

  it('a wrong token is 401; the right token passes (header or bearer)', async () => {
    process.env.WORKER_TOKEN = WORKER_TOKEN_VALUE;
    const wrong = await handleWorkerPost(post(undefined, { 'x-worker-token': 'nope' }));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid worker token');

    const viaHeader = await handleWorkerPost(post(undefined, { 'x-worker-token': WORKER_TOKEN_VALUE }));
    expect(viaHeader.status).toBe(200);
    const viaBearer = await handleWorkerPost(
      post(undefined, { authorization: `Bearer ${WORKER_TOKEN_VALUE}` }),
    );
    expect(viaBearer.status).toBe(200);
  });

  it('CRON_SECRET authenticates cron deliveries like the worker token', async () => {
    process.env.CRON_SECRET = 'cron-secret-value';
    const sweep = await handleWorkerGet(get('?sweep=1', { authorization: 'Bearer cron-secret-value' }));
    expect(sweep.status).toBe(200);
    const rejected = await handleWorkerGet(get('?sweep=1', { authorization: 'Bearer wrong' }));
    expect(rejected.status).toBe(401);
  });
});

describe('worker seam POST — pull mode (real contracts)', () => {
  it('drains one guarded batch and advances a real execution', async () => {
    const ctx = member();
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'seam-pull' },
      focus: { topics: ['seam'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 seam pull mode',
    });
    await enqueueCognitionStage(ctx, {
      executionId: execution.id,
      stage: 'observation',
      input: observationInput('seam pull mode signal'),
    });

    const result = await handleWorkerPost(post());
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe('pull');
    expect(result.body.processed).toBe(1);
    const outcomes = result.body.outcomes as Array<{ status: string; completedStages: number | null }>;
    expect(outcomes[0]!.status).toBe('processed');
    expect(outcomes[0]!.completedStages).toBe(1);

    const trace = await getExecution(ctx, { executionId: execution.id });
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]!.stage).toBe('observation');
  });

  it('an empty queue answers idle (not an error)', async () => {
    const result = await handleWorkerPost(post());
    expect(result.status).toBe(200);
    expect(result.body.processed).toBe(0);
    const outcomes = result.body.outcomes as Array<{ status: string }>;
    expect(outcomes[0]!.status).toBe('idle');
  });

  it('respects the batch limit query parameter within the guardrail', async () => {
    const ctx = member();
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'seam-limit' },
      focus: { topics: ['seam'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 seam limit',
    });
    await enqueueCognitionStage(ctx, { executionId: execution.id, stage: 'observation', input: observationInput('a') });
    await enqueueCognitionStage(ctx, { executionId: execution.id, stage: 'evidence-memory' });

    const limited = await handleWorkerPost(
      new Request('https://aurum.test/api/worker?limit=1', { method: 'POST' }),
    );
    expect(limited.status).toBe(200);
    expect(limited.body.processed).toBe(1);
    expect(limited.body.queueDepth).toBe(1);
  });
});

describe('worker seam POST — push mode (platform queue deliveries)', () => {
  it('processes pushed jobs through the identical core path', async () => {
    const ctx = member();
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'seam-push' },
      focus: { topics: ['seam'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 seam push mode',
    });
    const job = {
      kind: 'cognition-stage',
      executionId: execution.id,
      stage: 'observation',
      tenantId: ctx.tenantId,
      principalId: ctx.principalId,
      authority: ctx.authority,
      input: observationInput('seam push mode signal'),
      attempt: 1,
      enqueuedAt: new Date().toISOString(),
    };
    const result = await handleWorkerPost(post({ jobs: [job, { kind: 'garbage' }] }));
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe('push');
    expect(result.body.processed).toBe(2);
    const outcomes = result.body.outcomes as Array<{ status: string; detail: string }>;
    expect(outcomes[0]!.status).toBe('processed');
    expect(outcomes[1]!.status).toBe('dead_letter');
    expect(outcomes[1]!.detail).toContain('invalid job envelope');

    const trace = await getExecution(ctx, { executionId: execution.id });
    expect(trace.steps).toHaveLength(1);
  });
});

describe('worker seam GET — observability snapshot', () => {
  it('reports profile, metrics and queue depth without tenant content', async () => {
    await enqueueCognitionStage(member(), {
      executionId: newId(),
      stage: 'outcome',
      input: { summary: 'x' },
    });
    const result = await handleWorkerGet(get());
    expect(result.status).toBe(200);
    const body = result.body as {
      seam: string;
      environment: string;
      dogfood: boolean;
      backends: Record<string, string>;
      guardrails: Record<string, number>;
      metrics: Record<string, number>;
      queueDepth: number;
    };
    expect(body.seam).toBe('worker');
    expect(body.environment).toBe('development');
    expect(body.dogfood).toBe(true);
    expect(body.backends.db).toBe('embedded');
    expect(body.backends.queue).toBe('memory');
    expect(body.guardrails.workerMaxAttempts).toBe(5);
    expect(body.queueDepth).toBe(1);

    // The snapshot is deployment shape + counters ONLY.
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('principalId');
    expect(serialized).not.toContain('authority');
  });

  it('?sweep=1 drains one batch before answering', async () => {
    const ctx = member();
    const execution = await startExecution(ctx, {
      trigger: { kind: 'system', label: 'seam-sweep' },
      focus: { topics: ['seam'], entities: [] },
      actor: { kind: 'system', label: 'aurum-worker' },
      rationale: 'W069 seam sweep',
    });
    await enqueueCognitionStage(ctx, {
      executionId: execution.id,
      stage: 'observation',
      input: observationInput('seam sweep signal'),
    });
    const result = await handleWorkerGet(get('?sweep=1'));
    expect(result.status).toBe(200);
    const sweep = (result.body as { sweep?: { processed: number } }).sweep;
    expect(sweep!.processed).toBe(1);
    expect((result.body as { queueDepth: number }).queueDepth).toBe(0);
  });
});
