// W078 × W079 — the seeded-demo journey checks' production inapplicability.
//
// The W079 release-certification extension of the driver: on a target
// that reports itself as the PRODUCTION environment, the seeded demo
// journey checks must SKIP with a precise reason (the demo harness
// refuses to seed any production runtime — a hard release gate requires
// demo credentials OFF there), while every other journey-layer check
// runs exactly as before. On a NON-production target the original
// behavior is unchanged: the seeded checks run and FAIL honestly when
// the demo world is missing.
//
// The proof runs the REAL driver over an injectable fetch that serves a
// canned, contract-shaped "production" target (the driver's HTTP client
// is the only seam it needs — everything else is the production code
// path under test).

import { describe, expect, it } from 'vitest';
import { runDeploymentSmoke } from '../contract';
import type { SmokeReport } from '../contract';

const BASE = 'https://prod.example.test';

/** The canned green production health body (docs/DEPLOYMENT.md §7). */
const GREEN_HEALTH = {
  status: 'ok',
  checkedAt: '2026-09-23T00:00:00.000Z',
  environment: { environment: 'production', hostedOnVercel: true, commercial: false },
  components: {
    db: { backend: 'postgres', ok: true, migrations: 91, error: null },
    queue: { backend: 'redis' },
    cache: { backend: 'redis' },
    lock: { backend: 'redis' },
    email: { backend: 'resend' },
    blob: { backend: 'vercel-blob' },
  },
  guardrails: {
    workerMaxAttempts: 5,
    workerBatchLimit: 10,
    workerPollIntervalMs: 2000,
    emailDailyLimit: 100,
    blobMaxBytes: 8388608,
    dbPoolMax: 5,
  },
  readiness: { refusals: [], warnings: [] },
  worker: { jobsEnqueued: 0, jobsProcessed: 0, jobsDuplicate: 0, jobsNotFound: 0 },
};

/** One canned fetch response. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const SESSION_COOKIE = 'aurum_session=stub-session-value; Path=/; HttpOnly; SameSite=Lax';

interface FetchLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * The canned production target: everything the full-profile driver
 * touches, answered contract-shaped. `environment` controls the health
 * environment label (production vs preview).
 */
function cannedTarget(environment: 'production' | 'preview'): {
  fetchImpl: typeof fetch;
  log: FetchLog[];
} {
  const log: FetchLog[] = [];
  // the one-process worker metrics registry (health and the seam read the same numbers)
  const workerRegistry = {
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
    lastActivityAt: null as string | null,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headerRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headerRecord[key.toLowerCase()] = String(value);
    }
    const body = typeof init?.body === 'string' ? init.body : null;
    log.push({ method, url, headers: headerRecord, body });

    const urlObject = new URL(url);
    const path = urlObject.pathname + urlObject.search;
    const workerToken = headerRecord['x-worker-token'] ?? null;

    // routing gates (anonymous → /signin)
    if (path === '/' && method === 'GET') {
      const authed = (headerRecord['cookie'] ?? '').includes('aurum_session=stub-session-value');
      if (authed) {
        return new Response(null, { status: 307, headers: { location: '/chat' } });
      }
      return new Response(null, { status: 307, headers: { location: '/signin?next=%2F' } });
    }
    if (path === '/chat' && method === 'GET') {
      return new Response(null, { status: 307, headers: { location: '/signin?next=%2Fchat' } });
    }
    if (path === '/onboarding' && method === 'GET') {
      return new Response(null, { status: 307, headers: { location: '/signin?next=%2Fonboarding' } });
    }
    if (path === '/signin' && method === 'GET') {
      return new Response('<html><body>Aurum</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    // health (the worker registry is the same one-process registry the seam reads)
    if (path === '/api/health') {
      return new Response(
        JSON.stringify({
          ...GREEN_HEALTH,
          environment: { ...GREEN_HEALTH.environment, environment },
          worker: { ...workerRegistry },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      );
    }

    // worker seam
    if (path === '/api/worker' && method === 'GET') {
      if (workerToken !== 'the-worker-token') {
        return jsonResponse(
          { error: 'worker_token_required', message: 'the worker seam requires the x-worker-token header' },
          401,
        );
      }
      return jsonResponse({
        ok: true,
        environment,
        queueDepth: 0,
        metrics: { ...workerRegistry },
      });
    }
    if (path === '/api/worker' && method === 'POST') {
      if (workerToken !== 'the-worker-token') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      const jobs = body === null ? [] : (JSON.parse(body).jobs ?? []);
      workerRegistry.batches += 1;
      workerRegistry.lastActivityAt = '2026-09-23T00:00:01Z';
      if (jobs.length === 0) {
        workerRegistry.idlePolls += 1;
        return jsonResponse({
          ok: true,
          mode: 'push',
          environment,
          processed: 0,
          outcomes: [{ status: 'idle' }],
        });
      }
      const kind = jobs[0]?.kind ?? null;
      if (kind !== 'cognition-stage') {
        workerRegistry.jobsDeadLettered += 1;
        return jsonResponse({
          ok: true,
          mode: 'push',
          environment,
          processed: 1,
          outcomes: [
            { status: 'dead_letter', executionId: null, detail: 'invalid job envelope: unknown kind' },
          ],
        });
      }
      if (jobs[0]?.executionId !== 'exec-1') {
        workerRegistry.jobsNotFound += 1;
        return jsonResponse({
          ok: true,
          mode: 'push',
          environment,
          processed: 1,
          outcomes: [{ status: 'not_found', executionId: 'urn:uuid:unknown' }],
        });
      }
      workerRegistry.jobsDuplicate += 1;
      return jsonResponse({
        ok: true,
        mode: 'push',
        environment,
        processed: 1,
        outcomes: [{ status: 'duplicate', executionId: 'exec-1', detail: 'stale job acknowledged' }],
      });
    }

    // auth + chat journey layer
    if (path === '/api/auth/sign-up' && method === 'POST') {
      return jsonResponse(
        {
          session: { principal: { id: 'principal-1' }, company: null, expiresAt: '2099-01-01T00:00:00Z' },
        },
        200,
        { 'set-cookie': SESSION_COOKIE },
      );
    }
    if (path === '/api/auth/sign-in' && method === 'POST') {
      // The canned production target has no demo persona — honest 401.
      return jsonResponse({ error: 'invalid_credentials', message: 'email or password is incorrect' }, 401);
    }
    if (path === '/api/auth/session' && method === 'GET') {
      const signedOut = log.some((entry) => entry.url.includes('/api/auth/sign-out'));
      const authed =
        !signedOut && (headerRecord['cookie'] ?? '').includes('aurum_session=stub-session-value');
      if (!authed) return jsonResponse({ error: 'unauthenticated' }, 401);
      const afterCompany = log.some((entry) => entry.url.includes('/api/auth/onboarding/company'));
      if (!afterCompany) {
        // the pre-onboarding session view
        return jsonResponse({
          status: 'no-company',
          session: { principal: { id: 'principal-1' } },
          company: null,
        });
      }
      return jsonResponse({
        status: 'authenticated',
        principal: { id: 'principal-1' },
        company: { tenantId: 'tenant-1', authority: ['owner'] },
      });
    }
    if (path === '/api/auth/onboarding/company' && method === 'POST') {
      return jsonResponse({
        tenant: { id: 'tenant-1' },
        session: { company: { id: 'company-1', tenantId: 'tenant-1' } },
      });
    }
    if (path === '/api/auth/sign-out' && method === 'POST') {
      return jsonResponse({ ok: true }, 200, { 'set-cookie': 'aurum_session=; Path=/; HttpOnly; SameSite=Lax' });
    }
    if (path.startsWith('/api/product/chat/state') && method === 'GET') {
      const conversation = urlObject.searchParams.get('conversationId');
      const afterCompany = log.some((entry) => entry.url.includes('/api/auth/onboarding/company'));
      if (!afterCompany) {
        // the pre-onboarding gate: honest 409 no_active_company
        return jsonResponse({ error: 'no_active_company', message: 'select a company first' }, 409);
      }
      if (conversation === null) {
        return jsonResponse({
          chat: 'state',
          tenantId: 'tenant-1',
          view: { generatedAt: '2026-09-23T00:00:00Z', conversations: [], thread: null },
        });
      }
      return jsonResponse({
        chat: 'state',
        tenantId: 'tenant-1',
        view: {
          generatedAt: '2026-09-23T00:00:00Z',
          conversations: [],
          thread: { id: conversation, messages: [{ id: 'm1' }, { id: 'm2' }] },
        },
      });
    }
    if (path === '/api/product/chat/messages' && method === 'POST') {
      return jsonResponse({
        chat: 'turn',
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        executionId: 'exec-1',
        inbound: { id: 'in-1' },
        reply: { id: 're-1' },
      });
    }

    if (path === '/api/auth/quick-sign-in' && method === 'POST') {
      // the production runtime: the quick-access panel is OFF (G1)
      return jsonResponse(
        { error: 'not_available', message: 'quick sign-in is not available in this runtime' },
        404,
      );
    }
    return jsonResponse({ error: 'not-found', path }, 404);
  };
  return { fetchImpl, log };
}

function resultOf(report: SmokeReport, id: string) {
  return report.results.find((entry) => entry.id === id);
}

describe('W078 driver × W079 — seeded demo checks on production targets', () => {
  it('skips the seeded demo checks with a precise reason when the target is production', async () => {
    const { fetchImpl } = cannedTarget('production');
    const report = await runDeploymentSmoke({
      target: BASE,
      profile: 'full',
      expectedEnvironment: 'production',
      workerToken: 'the-worker-token',
      expectQuickSignIn: 'off',
      repoRoot: null,
      fetchImpl,
      runId: 'prodtest',
    });

    for (const id of [
      'seeded.persona-signin',
      'seeded.conversation-list',
      'seeded.thread',
      'seeded.attention-turn',
      'seeded.approval-decided',
    ]) {
      const result = resultOf(report, id);
      expect(result, `${id} is recorded`).toBeDefined();
      expect(result?.status, `${id} skips on production`).toBe('skipped');
      expect(result?.detail).toContain('inapplicable on the production environment');
      expect(result?.detail).toContain('demo harness never seeds a production runtime');
    }

    // Every other journey-layer check still ran and passed against the
    // canned production target: the production path is NOT weakened.
    for (const id of [
      'auth.signup',
      'auth.session-no-company',
      'auth.chat-gated-pre-onboarding',
      'auth.onboarding-company',
      'auth.signout',
      'routing.root-authenticated-chat',
      'chat.state-fresh',
      'chat.turn',
      'chat.thread-persists',
      'worker.duplicate-acknowledged',
      'worker.dead-letter-invalid',
      'worker.not-found-consumed',
      'worker.idle-pull',
      'observability.metrics-advance',
      'observability.surfaces-agree',
    ]) {
      const result = resultOf(report, id);
      expect(result, `${id} is recorded`).toBeDefined();
      expect(result?.status, `${id} still runs on production`).toBe('pass');
    }
    expect(report.summary.failed).toBe(0);
    expect(report.summary.blocked).toBe(0);
  }, 30_000);

  it('still attempts the seeded persona sign-in (and fails honestly) on non-production targets', async () => {
    const { fetchImpl, log } = cannedTarget('preview');
    const report = await runDeploymentSmoke({
      target: BASE,
      profile: 'full',
      expectedEnvironment: 'preview',
      workerToken: 'the-worker-token',
      repoRoot: null,
      fetchImpl,
      runId: 'prevtest',
    });

    const signIn = resultOf(report, 'seeded.persona-signin');
    expect(signIn?.status, 'a preview target without the demo world fails honestly').toBe('fail');
    expect(signIn?.detail).toContain('401');
    // The persona sign-in request was actually attempted.
    expect(
      log.some(
        (entry) =>
          entry.method === 'POST' &&
          entry.url.includes('/api/auth/sign-in') &&
          (entry.body ?? '').includes('.demo'),
      ),
      'the driver attempted the seeded persona sign-in on the non-production target',
    ).toBe(true);
  }, 30_000);
});
