// W078 — the post-deployment smoke suite's own integration proof: the
// FULL matrix, green, over real HTTP.
//
// WHAT THIS PROVES. The deployment-smoke module's driver is the artifact
// the operator runs against the hosted dogfood (`bun run smoke:dogfood`).
// Before its verdicts can be trusted against a hosted target, this suite
// proves the whole pipeline end-to-end inside the gates: the driver
// speaks REAL HTTP (a node:http server on an ephemeral port) to the REAL
// handler libraries (the exact functions the deployed Next.js routes
// delegate to — IMPLEMENTATION-STACK §5's thin-adapter discipline) and
// the REAL page components (the W070 SSR render machinery), over the
// REAL embedded PostgreSQL carrying the REAL deterministic W068 demo
// world. No route logic is re-implemented: pages render through the
// journey harness, APIs through their handlers. The two pieces of test
// infrastructure — both documented reproductions of the deployed
// behavior — are the middleware-equivalent gate (the cookie check of
// src/middleware.ts) and the Set-Cookie framing of the route adapters.
//
// IMPORT ORDER IS LOAD-BEARING: the journey harness installs the
// next/headers + next/navigation mocks a browser's cookie/navigation
// state requires; every app-code import below is dynamic and happens
// AFTER the harness so the mocks are registered before any module that
// (transitively) reads them.
//
// The run must come out GREEN with zero failures and zero blocked
// checks — the same shape the hosted target produces once the W077 §11
// operator steps (Neon DATABASE_URL; Upstash) are complete.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
// The deployment artifact runs with a configured WORKER_TOKEN; the seam's
// fail-closed auth (401 without/bad token) is part of the matrix.
process.env.WORKER_TOKEN = ['w078', '-smoke', '-seam', '-token'].join('');

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 1) The journey harness FIRST (installs the next/headers mocks).
const { demoWorld, renderRoute, sessionHolder, shutdownWorld } = await import('../journeys/harness');

// 2) The real handler libraries the deployed routes delegate to.
const { handleHealthGet } = await import('../../../src/app/api/health/lib');
const { handleWorkerGet, handleWorkerPost } = await import('../../../src/app/api/worker/lib');
const {
  handleCompanyCreatePost,
  handleQuickSignIn,
  handleSessionGet,
  handleSignIn,
  handleSignOut,
  handleSignUp,
} = await import('../../../src/app/(auth)/lib/api');
const { clearSessionCookieHeader } = await import('../../../src/app/(auth)/lib/cookies');
const {
  handleChatApprovalDecidePost,
  handleChatSendPost,
  handleChatStateGet,
} = await import('../../../src/app/(product)/chat/lib/chat-api');
const { sessionTokenFromCookieHeader } = await import('../../../src/app/lib/session');

// 3) The module under proof.
const { runDeploymentSmoke } = await import('../../../src/modules/deployment-smoke/contract');
type SmokeReport = Awaited<ReturnType<typeof runDeploymentSmoke>>;

const WORKER_TOKEN = process.env.WORKER_TOKEN!;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The middleware-equivalent gate (src/middleware.ts, W058): anonymous
 * non-public page hits are redirected to /signin with a return path.
 * Documented reproduction of the deployed routing contract.
 */
function gateTarget(pathname: string, hasSessionCookie: boolean): string | null {
  const PUBLIC_PREFIXES = ['/signin', '/signup', '/invite'];
  const PUBLIC_EXACT = ['/marketplace'];
  const isPublic =
    PUBLIC_EXACT.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    pathname.startsWith('/marketplace/package/');
  if (isPublic || hasSessionCookie) return null;
  return `/signin?next=${encodeURIComponent(pathname)}`;
}

/** Frame one handler result as a plain HTTP response (the route adapters' job). */
function respond(
  response: ServerResponse,
  result: { status: number; body: Record<string, unknown> },
  headers: Record<string, string> = {},
): void {
  response.writeHead(result.status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(result.body));
}

describe('W078 deployment smoke — the full matrix over real HTTP', () => {
  let smoke: SmokeReport;
  let server: ReturnType<typeof createServer>;
  let base = '';

  beforeAll(async () => {
    await demoWorld();

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://aurum.w078.test');
      const method = req.method ?? 'GET';
      try {
        // ----- the middleware gate + real page rendering ----------------------
        if (!url.pathname.startsWith('/api/')) {
          const cookieHeader = req.headers.cookie ?? null;
          const token = sessionTokenFromCookieHeader(cookieHeader);
          const gate = gateTarget(url.pathname, token !== null);
          if (gate !== null) {
            res.writeHead(307, { location: gate }).end();
            return;
          }
          // renderRoute reads the persona's token through the harness's
          // sessionHolder; a persona-like view of the request cookie is
          // exactly what a browser presents.
          const persona =
            token === null
              ? null
              : { role: 'manager' as const, displayName: 'W078', email: 'w078@aurum.test', token };
          sessionHolder.token = token;
          const rendered = await renderRoute(url.pathname, persona);
          if (rendered.status === 'redirect' && rendered.redirect !== null) {
            res.writeHead(307, { location: rendered.redirect }).end();
            return;
          }
          if (rendered.status === 'ok' && rendered.html !== null) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(rendered.html);
            return;
          }
          res.writeHead(rendered.status === 'not-found' ? 404 : 500).end();
          return;
        }

        // ----- the API surface: real handlers, real Request objects ------------
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const bodyText = Buffer.concat(chunks).toString('utf8');
        // Forward every incoming header verbatim (cookie, x-worker-token,
        // authorization, content-type) — exactly what the platform router
        // hands the deployed route handler.
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }
        if (bodyText !== '' && headers['content-type'] === undefined) {
          headers['content-type'] = 'application/json';
        }
        const request = new Request(`http://aurum.w078.test${url.pathname}${url.search}`, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
        });

        if (url.pathname === '/api/health') {
          respond(res, await handleHealthGet(), { 'cache-control': 'no-store' });
          return;
        }
        if (url.pathname === '/api/worker') {
          const result = method === 'POST' ? await handleWorkerPost(request) : await handleWorkerGet(request);
          respond(res, result);
          return;
        }
        if (url.pathname === '/api/auth/sign-up') {
          const result = await handleSignUp(request);
          respond(res, result, result.setCookie === undefined ? {} : { 'set-cookie': result.setCookie });
          return;
        }
        if (url.pathname === '/api/auth/sign-in') {
          const result = await handleSignIn(request);
          respond(res, result, result.setCookie === undefined ? {} : { 'set-cookie': result.setCookie });
          return;
        }
        if (url.pathname === '/api/auth/quick-sign-in') {
          const result = await handleQuickSignIn(request);
          respond(res, result, result.setCookie === undefined ? {} : { 'set-cookie': result.setCookie });
          return;
        }
        if (url.pathname === '/api/auth/sign-out') {
          const result = await handleSignOut(request);
          respond(
            res,
            result,
            result.clearCookie === true ? { 'set-cookie': clearSessionCookieHeader() } : {},
          );
          return;
        }
        if (url.pathname === '/api/auth/session') {
          respond(res, await handleSessionGet(request));
          return;
        }
        if (url.pathname === '/api/auth/onboarding/company') {
          const result = await handleCompanyCreatePost(request);
          respond(res, result, result.setCookie === undefined ? {} : { 'set-cookie': result.setCookie });
          return;
        }
        if (url.pathname === '/api/product/chat/state') {
          respond(res, await handleChatStateGet(request));
          return;
        }
        if (url.pathname === '/api/product/chat/messages') {
          respond(res, await handleChatSendPost(request));
          return;
        }
        const approval = /^\/api\/product\/chat\/approvals\/([^/]+)\/decide$/.exec(url.pathname);
        if (approval !== null) {
          respond(res, await handleChatApprovalDecidePost(request, decodeURIComponent(approval[1]!)));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'harness',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await shutdownWorld();
    delete process.env.WORKER_TOKEN;
  });

  it(
    'runs the full W078 matrix green over real HTTP (auth, onboarding, chat, seeded journeys, durable execution, observability, repo surface)',
    async () => {
      smoke = await runDeploymentSmoke({
        target: base,
        profile: 'full',
        expectedEnvironment: 'development',
        workerToken: WORKER_TOKEN,
        expectQuickSignIn: 'on',
        repoRoot: REPO_ROOT,
        label: 'w078-e2e-harness',
        runId: 'e2e',
        timeoutMs: 60_000,
      });

      const bad = smoke.results.filter((result) => result.status === 'fail' || result.status === 'blocked');
      const detail = bad.map((result) => `${result.status.toUpperCase()} ${result.id}: ${result.detail}`).join('\n');
      expect(detail, `the full matrix must be green (0 fail, 0 blocked)\n${detail}`).toBe('');

      // Every layer of the matrix actually executed and passed.
      expect(smoke.summary.passed).toBeGreaterThan(25);
      const ids = new Set(smoke.results.filter((result) => result.status === 'pass').map((result) => result.id));
      for (const id of [
        // hosted layer
        'routing.root-anonymous-gate',
        'routing.chat-anonymous-gate',
        'routing.onboarding-gate',
        'routing.signin-renders',
        'health.contract',
        'health.green',
        'worker.seam-auth-fail-closed',
        'worker.retry-policy-surface',
        'observability.worker-snapshot',
        'env.quick-signin-availability',
        // journey layer
        'auth.signup',
        'auth.session-no-company',
        'auth.chat-gated-pre-onboarding',
        'auth.onboarding-company',
        'auth.signout',
        'routing.root-authenticated-chat',
        'chat.state-fresh',
        'chat.turn',
        'chat.thread-persists',
        'seeded.persona-signin',
        'seeded.conversation-list',
        'seeded.thread',
        'seeded.attention-turn',
        'seeded.approval-decided',
        'worker.duplicate-acknowledged',
        'worker.dead-letter-invalid',
        'worker.not-found-consumed',
        'worker.idle-pull',
        'observability.metrics-advance',
        'observability.surfaces-agree',
        // repo layer
        'release.rollback-runbook',
        'release.known-good-deployment',
        'release.ci-gates',
        'release.deployment-config',
        'browser.suite-registered',
        'env.demo-gate-refuses-production',
        'env.matrix-documented',
      ]) {
        expect(ids.has(id), `check '${id}' must pass in the full-matrix run`).toBe(true);
      }
      expect(smoke.health?.status).toBe('ok');
      expect(smoke.health?.migrations ?? 0).toBeGreaterThan(0);
    },
    240_000,
  );
});
