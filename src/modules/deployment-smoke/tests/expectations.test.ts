// Unit tests for the W078 expectation model: the pure evaluators over
// synthetic observed bodies. The production-refusal fixtures are the
// EXACT shapes the live hosted dogfood returned on 2026-09-22 (captured
// from https://aurum-chat-livid.vercel.app/api/health and /api/worker)
// so the fail-closed honesty the deployment exhibits today is itself a
// tested contract.

import { describe, expect, it } from 'vitest';
import type { SmokeHttpResponse } from '../http';
import {
  anonymousGateReasons,
  anonymousSessionReasons,
  approvalCardReasons,
  approvalDecidedReasons,
  authenticatedRootReasons,
  chatGatedNoCompanyReasons,
  chatStateReasons,
  chatTurnReasons,
  companyCreatedReasons,
  healthContractReasons,
  healthGreenReasons,
  healthHonestRefusalReasons,
  observeHealth,
  observeWorkerPush,
  observeWorkerSnapshot,
  observabilitySurfacesAgreeReasons,
  pageRendersReasons,
  quickSignInReasons,
  retryPolicySurfaceReasons,
  sessionIssuedReasons,
  sessionNoCompanyReasons,
  workerAuthFailClosedReasons,
  workerMetricsAdvancedReasons,
  workerOutcomeReasons,
  workerSnapshotReasons,
} from '../expectations';

function response(init: Partial<SmokeHttpResponse>): SmokeHttpResponse {
  return {
    url: 'https://dogfood.test/',
    status: 200,
    headers: {},
    text: '',
    body: null,
    location: null,
    setCookies: [],
    error: null,
    ...init,
  };
}

const GREEN_HEALTH_BODY = {
  status: 'ok',
  checkedAt: '2026-09-22T17:00:00.000Z',
  environment: {
    environment: 'preview',
    hostedOnVercel: false,
    commercial: false,
    dogfoodNotice: 'internal/non-commercial dogfood while the free tier is used (plan §7)',
  },
  components: {
    db: { backend: 'embedded', ok: true, migrations: 149, error: null },
    queue: { backend: 'memory' },
    cache: { backend: 'memory' },
    lock: { backend: 'memory' },
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
  worker: {
    jobsEnqueued: 1,
    jobsProcessed: 1,
    jobsSuspended: 0,
    jobsDuplicate: 1,
    jobsConflict: 0,
    jobsNotFound: 1,
    jobsRetried: 0,
    jobsDeadLettered: 0,
    idlePolls: 0,
    batches: 2,
    lastActivityAt: '2026-09-22T17:00:01.000Z',
  },
  processUptimeSeconds: 12,
};

/** The exact honest-refusal body the live production dogfood serves today. */
const PRODUCTION_REFUSAL_BODY = {
  status: 'error',
  checkedAt: '2026-09-22T17:02:39.945Z',
  environment: {
    environment: 'production',
    hostedOnVercel: true,
    commercial: false,
    dogfoodNotice: 'internal/non-commercial dogfood while the free tier is used (plan §7)',
  },
  components: {
    db: {
      backend: 'embedded',
      ok: false,
      migrations: null,
      error: "ENOENT: no such file or directory, mkdir '.data'",
    },
    queue: { backend: 'memory' },
    cache: { backend: 'memory' },
    lock: { backend: 'memory' },
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
  readiness: {
    refusals: [
      'production requires the external PostgreSQL backend (DATABASE_URL) — the embedded PGlite runtime is dev/test only (lock 35: PostgreSQL is authoritative domain state)',
    ],
    warnings: [
      'no redis seam is configured (REDIS_URL for the redis protocol, or UPSTASH_REDIS_REST_URL/TOKEN / KV_REST_API_URL/TOKEN for redis-over-HTTP) — queue/cache/lock run on the in-process memory backend; queue jobs cannot survive restarts or span instances (legal while Redis is never domain truth, but not durable)',
    ],
  },
  worker: {
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
  },
  processUptimeSeconds: 1,
};

describe('health evaluators', () => {
  it('accepts a green health body with the full contract shape', () => {
    const observed = observeHealth(
      response({ status: 200, body: GREEN_HEALTH_BODY, headers: { 'cache-control': 'no-store' } }),
    );
    expect(healthContractReasons(observed)).toEqual([]);
    expect(healthGreenReasons(observed)).toEqual([]);
    expect(healthHonestRefusalReasons(observed)).not.toEqual([]);
    expect(observed.environment).toBe('preview');
    expect(observed.migrations).toBe(149);
  });

  it('accepts the live production refusal body as the honest fail-closed state', () => {
    const observed = observeHealth(
      response({ status: 503, body: PRODUCTION_REFUSAL_BODY, headers: { 'cache-control': 'no-store' } }),
    );
    expect(healthContractReasons(observed)).toEqual([]);
    expect(healthHonestRefusalReasons(observed)).toEqual([]);
    expect(observed.status).toBe('error');
    expect(observed.environment).toBe('production');
    expect(observed.dbBackend).toBe('embedded');
    expect(observed.refusals[0]).toContain('DATABASE_URL');
    // Green is impossible in this state — and the reasons must say why.
    const green = healthGreenReasons(observed);
    expect(green.some((reason) => reason.includes("'error'"))).toBe(true);
    expect(green.some((reason) => reason.includes('does not answer'))).toBe(true);
  });

  it('flags a health body that silently serves while refusing', () => {
    const body = { ...(PRODUCTION_REFUSAL_BODY as Record<string, unknown>) };
    const observed = observeHealth(response({ status: 200, body }));
    // status 'error' with HTTP 200 violates the contract.
    expect(healthContractReasons(observed).some((r) => r.includes('503'))).toBe(true);
  });

  it('flags missing no-store cache control and missing counters', () => {
    const observed = observeHealth(
      response({ status: 200, body: { status: 'ok' }, headers: { 'cache-control': 'public' } }),
    );
    const reasons = healthContractReasons(observed);
    expect(reasons.some((reason) => reason.includes('no-store'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('environment label'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('worker metrics'))).toBe(true);
  });

  it('flags an unreachable target precisely', () => {
    const observed = observeHealth(response({ status: 0, error: 'getaddrinfo ENOTFOUND' }));
    expect(healthContractReasons(observed)).toEqual([
      'the target is unreachable (getaddrinfo ENOTFOUND)',
    ]);
  });

  it('surfaces the retry policy from the guardrails', () => {
    const observed = observeHealth(
      response({ status: 200, body: GREEN_HEALTH_BODY, headers: { 'cache-control': 'no-store' } }),
    );
    expect(retryPolicySurfaceReasons(observed.guardrails)).toEqual([]);
    expect(retryPolicySurfaceReasons({ workerMaxAttempts: null, workerBatchLimit: null, workerPollIntervalMs: null })).toHaveLength(3);
  });
});

describe('worker seam evaluators', () => {
  const snapshotBody = {
    ok: true,
    seam: 'worker',
    environment: 'preview',
    dogfood: true,
    backends: { db: 'embedded', queue: 'memory' },
    guardrails: GREEN_HEALTH_BODY.guardrails,
    metrics: GREEN_HEALTH_BODY.worker,
    queueDepth: 0,
  };

  it('accepts a full observability snapshot', () => {
    const observed = observeWorkerSnapshot(response({ status: 200, body: snapshotBody }));
    expect(workerSnapshotReasons(observed)).toEqual([]);
    expect(observed.queueDepth).toBe(0);
    expect(observed.metrics.jobsDuplicate).toBe(1);
  });

  it('flags an incomplete snapshot', () => {
    const observed = observeWorkerSnapshot(response({ status: 200, body: { ok: true } }));
    expect(workerSnapshotReasons(observed).length).toBeGreaterThan(5);
  });

  it('evaluates push-mode dispositions (duplicate / dead-letter / not-found / idle)', () => {
    const duplicate = observeWorkerPush(
      response({
        status: 200,
        body: {
          ok: true,
          mode: 'push',
          processed: 1,
          outcomes: [
            {
              status: 'duplicate',
              detail:
                'stale job acknowledged — execution 00000000-0000-0000-0000-000000000000 is terminal (…)',
            },
          ],
          queueDepth: 0,
        },
      }),
    );
    expect(workerOutcomeReasons(duplicate, { status: 'duplicate' })).toEqual([]);

    const invalid = observeWorkerPush(
      response({
        status: 200,
        body: {
          ok: true,
          mode: 'push',
          processed: 1,
          outcomes: [{ status: 'dead_letter', detail: 'invalid job envelope: job kind must be …' }],
          queueDepth: 0,
        },
      }),
    );
    expect(
      workerOutcomeReasons(invalid, { status: 'dead_letter', detailIncludes: 'invalid job envelope' }),
    ).toEqual([]);

    const wrongStatus = observeWorkerPush(
      response({ status: 200, body: { mode: 'push', outcomes: [{ status: 'processed', detail: 'x' }] } }),
    );
    expect(workerOutcomeReasons(wrongStatus, { status: 'duplicate' })).toEqual([
      "expected outcome 'duplicate' (got 'processed')",
    ]);

    const idle = observeWorkerPush(
      response({
        status: 200,
        body: { ok: true, mode: 'pull', processed: 0, outcomes: [{ status: 'idle', detail: 'queue empty' }], queueDepth: 0 },
      }),
    );
    expect(workerOutcomeReasons(idle, { status: 'idle', mode: 'pull' })).toEqual([]);
  });

  it('requires the metrics counters to advance after observed dispositions', () => {
    const observed = observeWorkerSnapshot(response({ status: 200, body: snapshotBody }));
    expect(workerMetricsAdvancedReasons(observed, { duplicate: true, notFound: true })).toEqual([]);
    const stale = observeWorkerSnapshot(
      response({ status: 200, body: { ...snapshotBody, metrics: { ...snapshotBody.metrics, jobsDuplicate: 0, batches: 0, lastActivityAt: null } } }),
    );
    expect(workerMetricsAdvancedReasons(stale, { duplicate: true, notFound: true })).toHaveLength(3);
  });

  it('requires the two observability surfaces to agree on the counters', () => {
    const health = observeHealth(
      response({ status: 200, body: GREEN_HEALTH_BODY, headers: { 'cache-control': 'no-store' } }),
    );
    const snapshot = observeWorkerSnapshot(response({ status: 200, body: snapshotBody }));
    expect(observabilitySurfacesAgreeReasons(health, snapshot)).toEqual([]);
    const diverged = observeWorkerSnapshot(
      response({ status: 200, body: { ...snapshotBody, metrics: { ...snapshotBody.metrics, jobsNotFound: 7 } } }),
    );
    expect(
      observabilitySurfacesAgreeReasons(health, diverged).some((reason) =>
        reason.includes('not-found'),
      ),
    ).toBe(true);
  });

  it('requires the seam to refuse unauthenticated and bad-token calls', () => {
    const ok = workerAuthFailClosedReasons(
      response({ status: 401, body: { ok: false, error: 'worker token required (Authorization: Bearer or x-worker-token)' } }),
      response({ status: 401, body: { ok: false, error: 'invalid worker token' } }),
    );
    expect(ok).toEqual([]);
    const open = workerAuthFailClosedReasons(
      response({ status: 200, body: { ok: true } }),
      response({ status: 200, body: { ok: true } }),
    );
    expect(open).toHaveLength(2);
  });
});

describe('routing evaluators', () => {
  it('accepts the middleware gate shape (307 → /signin?next=…)', () => {
    expect(
      anonymousGateReasons(response({ status: 307, location: 'https://x.test/signin?next=%2F' }), '/'),
    ).toEqual([]);
    expect(
      anonymousGateReasons(response({ status: 307, location: 'https://x.test/signin?next=%2Fchat' }), '/chat'),
    ).toEqual([]);
  });

  it('flags a wrong return path or a soft 200', () => {
    expect(
      anonymousGateReasons(response({ status: 200, text: 'hello' }), '/chat'),
    ).toEqual(['expected a 307/308 redirect (got 200)']);
    expect(
      anonymousGateReasons(response({ status: 307, location: 'https://x.test/signin?next=%2F' }), '/chat'),
    ).toEqual(["expected next=/chat (got '/')"]);
  });

  it('accepts the authenticated root routing to /chat', () => {
    expect(authenticatedRootReasons(response({ status: 307, location: 'https://x.test/chat' }))).toEqual([]);
    expect(authenticatedRootReasons(response({ status: 307, location: 'https://x.test/today' }))).toEqual([
      "expected the redirect target /chat (got 'https://x.test/today')",
    ]);
  });

  it('checks that pages render real HTML', () => {
    expect(
      pageRendersReasons(
        response({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text: '<!DOCTYPE html><html lang="en">Aurum</html>' }),
        { contains: 'Aurum' },
      ),
    ).toEqual([]);
    const reasons = pageRendersReasons(response({ status: 500, text: 'oops' }));
    expect(reasons).toContain('expected HTTP 200 (got 500)');
  });
});

describe('authentication evaluators', () => {
  it('accepts a session issuance with the hardened cookie', () => {
    expect(
      sessionIssuedReasons(
        response({
          status: 200,
          body: { session: { principal: { id: 'p1', email: 'a@b.test', displayName: 'A' }, company: null } },
          setCookies: ['aurum_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure'],
        }),
      ),
    ).toEqual([]);
  });

  it('flags a missing principal, cookie or cookie flags', () => {
    expect(sessionIssuedReasons(response({ status: 200, body: { session: {} } }))).toContain(
      'the session principal is absent',
    );
    expect(
      sessionIssuedReasons(
        response({
          status: 200,
          body: { session: { principal: { id: 'p1' } } },
          setCookies: ['aurum_session=tok; Path=/'],
        }),
      ),
    ).toContain('the session cookie is missing its HttpOnly/SameSite/Path flags');
  });

  it('accepts the pre-onboarding no-company state', () => {
    expect(
      sessionNoCompanyReasons(response({ status: 200, body: { status: 'no-company', company: null, companies: [] } })),
    ).toEqual([]);
    expect(
      sessionNoCompanyReasons(response({ status: 200, body: { status: 'authenticated', company: { tenantId: 't1' } } })),
    ).toEqual(["expected session status 'no-company' (got 'authenticated')", 'company should be null before onboarding']);
  });

  it('accepts company creation and captures the tenant', () => {
    const outcome = companyCreatedReasons(
      response({
        status: 200,
        body: { tenant: { id: 't1', name: 'W078 Smoke Roasters' }, session: { company: { tenantId: 't1' } } },
      }),
    );
    expect(outcome.reasons).toEqual([]);
    expect(outcome.tenantId).toBe('t1');
  });

  it('requires the honest 401 after sign-out', () => {
    expect(anonymousSessionReasons(response({ status: 401 }))).toEqual([]);
    expect(anonymousSessionReasons(response({ status: 200 }))).toEqual([
      'expected HTTP 401 after sign-out (got 200)',
    ]);
  });

  it('requires the chat gate for company-less sessions', () => {
    expect(
      chatGatedNoCompanyReasons(response({ status: 409, body: { error: 'no_active_company', message: '…' } })),
    ).toEqual([]);
    expect(chatGatedNoCompanyReasons(response({ status: 200, body: {} }))).toEqual([
      'expected HTTP 409 before onboarding (got 200)',
    ]);
  });

  it('evaluates quick-sign-in availability per runtime family', () => {
    expect(
      quickSignInReasons(response({ status: 404, body: { error: 'not_available', message: '…' } }), 'off'),
    ).toEqual([]);
    expect(quickSignInReasons(response({ status: 200, body: {} }), 'off')).toEqual([
      'expected HTTP 404 not_available in this runtime (got 200)',
    ]);
    expect(quickSignInReasons(response({ status: 404 }), 'on')).toEqual([
      'quick sign-in should be available in a development runtime',
    ]);
  });
});

describe('chat evaluators', () => {
  it('accepts a composer turn and captures the execution references', () => {
    const outcome = chatTurnReasons(
      response({
        status: 200,
        body: {
          chat: 'turn',
          tenantId: 't1',
          conversationId: 'c1',
          executionId: 'e1',
          inbound: { id: 'm1', side: 'member' },
          reply: { id: 'm2', side: 'aurum', answer: { cards: [], executionId: 'e1' } },
        },
      }),
    );
    expect(outcome.reasons).toEqual([]);
    expect(outcome.conversationId).toBe('c1');
    expect(outcome.executionId).toBe('e1');
  });

  it('flags a turn without the durable execution id', () => {
    const outcome = chatTurnReasons(
      response({ status: 200, body: { inbound: { id: 'm1' }, reply: { id: 'm2' }, conversationId: 'c1' } }),
    );
    expect(outcome.reasons).toContain(
      'the turn carries no cognition execution id (durable execution unproven)',
    );
  });

  it('finds the seeded conversation and validates the thread', () => {
    const list = chatStateReasons(
      response({
        status: 200,
        body: { view: { conversations: [{ id: 'c-seed', title: 'Wholesale freshness — Aurum', messageCount: 4 }], thread: null } },
      }),
      { expectTitle: 'Wholesale freshness — Aurum' },
    );
    expect(list.reasons).toEqual([]);
    expect(list.conversationId).toBe('c-seed');

    const thread = chatStateReasons(
      response({
        status: 200,
        body: { view: { conversations: [], thread: { id: 'c-seed', messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }] } } },
      }),
      { expectThreadMessages: 4 },
    );
    expect(thread.reasons).toEqual([]);
  });

  it('flags a missing seeded conversation and a thin thread', () => {
    const missing = chatStateReasons(
      response({ status: 200, body: { view: { conversations: [{ id: 'x', title: 'Other' }] } } }),
      { expectTitle: 'Wholesale freshness — Aurum' },
    );
    expect(missing.reasons).toEqual(["the seeded conversation 'Wholesale freshness — Aurum' is not in the list"]);
    const thin = chatStateReasons(
      response({ status: 200, body: { view: { conversations: [], thread: { messages: [{ id: 'm1' }] } } } }),
      { expectThreadMessages: 4 },
    );
    expect(thin.reasons).toEqual(['the thread has 1 messages (expected >= 4)']);
  });

  it('extracts the pending approval card from an attention turn', () => {
    const outcome = approvalCardReasons(
      response({
        status: 200,
        body: {
          reply: {
            answer: {
              cards: [
                { kind: 'goal', id: 'g1', decision: null },
                { kind: 'approval', id: 'r1', decision: { requestId: 'r1', status: 'pending' } },
              ],
            },
          },
        },
      }),
    );
    expect(outcome.reasons).toEqual([]);
    expect(outcome.requestId).toBe('r1');

    const none = approvalCardReasons(
      response({ status: 200, body: { reply: { answer: { cards: [{ kind: 'goal', id: 'g1' }] } } } }),
    );
    expect(none.reasons).toEqual(['the reply carries no pending approval card']);
  });

  it('validates the inline decision and the timeline refresh', () => {
    const decide = response({ status: 200, body: { chat: 'approval-decision', requestId: 'r1', status: 'approved' } });
    const state = response({
      status: 200,
      body: {
        view: {
          thread: {
            messages: [
              { answer: { cards: [{ kind: 'approval', decision: { requestId: 'r1', status: 'approved' } }] } },
            ],
          },
        },
      },
    });
    expect(approvalDecidedReasons(decide, state, 'r1')).toEqual([]);

    const staleState = response({
      status: 200,
      body: { view: { thread: { messages: [{ answer: { cards: [{ kind: 'approval', decision: { requestId: 'r1', status: 'pending' } }] } }] } } },
    });
    expect(approvalDecidedReasons(decide, staleState, 'r1')).toEqual([
      "the timeline still shows the decision as 'pending'",
    ]);
  });
});
