// The HTTP worker execution seam's handling logic (W069). Tested
// directly without booting Next.js (the same discipline the tower and
// product APIs follow); route.ts is a thin NextResponse adapter over
// these handlers.
//
// See route.ts for the full seam contract (auth, push/pull modes,
// sweep). Handlers return `{ status, body }` envelopes only.

import { envString } from '@/infra/config';
import { assertProductionReadiness, resolveDeploymentProfile } from '@/infra/deployment';
import {
  getWorkerMetrics,
  processCognitionJob,
  runWorkerBatch,
  validateCognitionJob,
  workerQueueDepth,
} from '@/infra/worker';
import type { JobOutcome } from '@/infra/worker';

const MAX_PUSHED_JOBS = 50;

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

function providedToken(request: Request): string | null {
  const header = request.headers.get('x-worker-token');
  if (header !== null && header.trim() !== '') return header.trim();
  const authorization = request.headers.get('authorization');
  if (authorization !== null && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    return token === '' ? null : token;
  }
  return null;
}

/**
 * Token gate: WORKER_TOKEN or CRON_SECRET. When neither is configured
 * the seam stays open ONLY outside production (fail-closed in prod).
 */
function authorize(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const profile = resolveDeploymentProfile();
  const workerToken = envString('WORKER_TOKEN');
  const cronSecret = envString('CRON_SECRET');
  const token = providedToken(request);
  if (workerToken === undefined && cronSecret === undefined) {
    const refusals = assertProductionReadiness(profile).filter((note) => note.level === 'refusal');
    if (refusals.length > 0 || profile.environment === 'production') {
      return {
        ok: false,
        status: 503,
        error: 'worker seam not configured: set WORKER_TOKEN before serving this environment',
      };
    }
    return { ok: true };
  }
  if (token === null) {
    return {
      ok: false,
      status: 401,
      error: 'worker token required (Authorization: Bearer or x-worker-token)',
    };
  }
  if (token !== workerToken && token !== cronSecret) {
    return { ok: false, status: 401, error: 'invalid worker token' };
  }
  return { ok: true };
}

async function readJsonBody(request: Request): Promise<{ jobs?: unknown }> {
  try {
    const text = await request.text();
    if (text.trim() === '') return {};
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as { jobs?: unknown };
  } catch {
    return {};
  }
}

const IDLE_OUTCOME: JobOutcome = {
  status: 'idle',
  executionId: null,
  attempt: null,
  executionState: null,
  completedStages: null,
  correlationId: null,
  detail: 'queue empty',
};

/** POST /api/worker — process one bounded batch (push or pull mode). */
export async function handleWorkerPost(request: Request): Promise<HandlerResult> {
  const auth = authorize(request);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }
  const profile = resolveDeploymentProfile();
  const body = await readJsonBody(request);

  if (Array.isArray(body.jobs)) {
    // Push mode: each supplied job runs through the identical core path
    // (the shape a platform queue consumer delivers).
    const jobs = body.jobs.slice(0, MAX_PUSHED_JOBS);
    const outcomes: JobOutcome[] = [];
    for (const raw of jobs) {
      const validated = validateCognitionJob(raw);
      if ('error' in validated) {
        outcomes.push({
          status: 'dead_letter',
          executionId: null,
          attempt: null,
          executionState: null,
          completedStages: null,
          correlationId: null,
          detail: `invalid job envelope: ${validated.error}`,
        });
        continue;
      }
      outcomes.push(await processCognitionJob(validated.job));
    }
    return {
      status: 200,
      body: {
        ok: true,
        mode: 'push',
        environment: profile.environment,
        processed: outcomes.length,
        outcomes,
        metrics: getWorkerMetrics(),
        queueDepth: await workerQueueDepth(),
      },
    };
  }

  // Pull mode: drain one guarded batch from the queue port.
  const requestedLimit = Number.parseInt(new URL(request.url).searchParams.get('limit') ?? '', 10);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, profile.guardrails.workerBatchLimit)
      : profile.guardrails.workerBatchLimit;
  const batch = await runWorkerBatch(limit);
  return {
    status: 200,
    body: {
      ok: true,
      mode: 'pull',
      environment: profile.environment,
      processed: batch.processed,
      outcomes: batch.outcomes.length === 0 ? [IDLE_OUTCOME] : batch.outcomes,
      metrics: getWorkerMetrics(),
      queueDepth: batch.queueDepth,
    },
  };
}

/** GET /api/worker — observability snapshot; ?sweep=1 drains one batch first. */
export async function handleWorkerGet(request: Request): Promise<HandlerResult> {
  const auth = authorize(request);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }
  const profile = resolveDeploymentProfile();
  const sweep = new URL(request.url).searchParams.get('sweep');
  let sweepResult: { processed: number; outcomes: JobOutcome[] } | null = null;
  if (sweep === '1' || sweep === 'true') {
    const batch = await runWorkerBatch(profile.guardrails.workerBatchLimit);
    sweepResult = { processed: batch.processed, outcomes: batch.outcomes };
  }
  return {
    status: 200,
    body: {
      ok: true,
      seam: 'worker',
      environment: profile.environment,
      dogfood: profile.dogfood,
      backends: profile.backends,
      guardrails: profile.guardrails,
      metrics: getWorkerMetrics(),
      queueDepth: await workerQueueDepth(),
      ...(sweepResult === null ? {} : { sweep: sweepResult }),
    },
  };
}
