// W079/W101 — the certification driver's integration proof: one full pass
// over a canned production target with EVERY external seam injected —
// the HTTP probes (fetch), the W078 smoke run (the same driver the
// production code uses, over the canned target), the repo gates and the
// browser matrix (exec). The W079 pass must come out green with the full
// evidence tree written to disk, and the honest-blocked branches (no
// worker token, wrong deployment identity, skipped browser) must stay
// BLOCKED — never silently green. The W101 pass proves the post-S002
// program wiring: the rollback-evidence gate, the W101 evidence root,
// the W101 repository identity and the honest BLOCKED channel folding.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SmokeReport } from '@/modules/deployment-smoke/contract';
import { runCertificationPass } from '../driver';
import type { BrowserRunDigest } from '../types';

const BASE = 'https://prod.cert.test';

/** The green production health body. */
const HEALTH = {
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
  worker: {},
};

const SESSION_COOKIE = 'aurum_session=stub; Path=/; HttpOnly; SameSite=Lax';

/** The canned production HTTP target (G1 probes + the W078 smoke run). */
function cannedFetch(): typeof fetch {
  const metrics = {
    jobsEnqueued: 0, jobsProcessed: 0, jobsSuspended: 0, jobsDuplicate: 0,
    jobsConflict: 0, jobsNotFound: 0, jobsRetried: 0, jobsDeadLettered: 0,
    idlePolls: 0, batches: 0, lastActivityAt: null as string | null,
  };
  let companyCreated = false;
  let signedOut = false;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    const urlObject = new URL(url);
    const pathName = urlObject.pathname;

    if (pathName === '/api/health') {
      return new Response(JSON.stringify({ ...HEALTH, worker: { ...metrics } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    void companyCreated;
    if (pathName === '/api/auth/quick-sign-in') {
      return new Response(JSON.stringify({ error: 'not_available' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (pathName === '/api/worker') {
      const token = headers['x-worker-token'];
      if (token !== 'the-worker-token') {
        return new Response(
          JSON.stringify({ error: 'worker_token_required', message: 'x-worker-token required' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'POST') {
        const jobs = typeof init?.body === 'string' ? (JSON.parse(init.body).jobs ?? []) : [];
        metrics.batches += 1;
        metrics.lastActivityAt = '2026-09-23T00:00:01Z';
        if (jobs.length === 0) {
          metrics.idlePolls += 1;
          return new Response(
            JSON.stringify({
              ok: true, mode: 'push', environment: 'production', processed: 0,
              outcomes: [{ status: 'idle' }], metrics: { ...metrics },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (jobs[0]?.kind !== 'cognition-stage') {
          metrics.jobsDeadLettered += 1;
          return new Response(
            JSON.stringify({
              ok: true, mode: 'push', environment: 'production', processed: 1,
              outcomes: [{ status: 'dead_letter', executionId: null, detail: 'invalid job envelope: unknown kind' }],
              metrics: { ...metrics },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (jobs[0]?.executionId !== 'exec-1') {
          metrics.jobsNotFound += 1;
          return new Response(
            JSON.stringify({
              ok: true, mode: 'push', environment: 'production', processed: 1,
              outcomes: [{ status: 'not_found', executionId: jobs[0]?.executionId }],
              metrics: { ...metrics },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        metrics.jobsDuplicate += 1;
        return new Response(
          JSON.stringify({
            ok: true, mode: 'push', environment: 'production', processed: 1,
            outcomes: [{ status: 'duplicate', executionId: 'exec-1', detail: 'stale job acknowledged' }],
            metrics: { ...metrics },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, environment: 'production', queueDepth: 0, metrics: { ...metrics } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // ---- the W078 full-profile journey layer ----
    if (pathName === '/' && method === 'GET') {
      const authed = (headers['cookie'] ?? '').includes('aurum_session=stub');
      return new Response(null, {
        status: 307,
        headers: { location: authed ? '/chat' : '/signin?next=%2F' },
      });
    }
    if ((pathName === '/chat' || pathName === '/onboarding') && method === 'GET') {
      return new Response(null, { status: 307, headers: { location: `/signin?next=${pathName}` } });
    }
    if (pathName === '/signin' && method === 'GET') {
      return new Response('<html><body>Aurum</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (pathName === '/api/auth/sign-up') {
      return new Response(
        JSON.stringify({ session: { principal: { id: 'p1' }, company: null } }),
        { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': SESSION_COOKIE } },
      );
    }
    if (pathName === '/api/auth/session') {
      const authed = !signedOut && (headers['cookie'] ?? '').includes('aurum_session=stub');
      if (!authed) {
        return new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      }
      if (!companyCreated) {
        return new Response(
          JSON.stringify({ status: 'no-company', principal: { id: 'p1' }, company: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          status: 'authenticated', principal: { id: 'p1' }, company: { tenantId: 't1', authority: ['owner'] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathName === '/api/auth/onboarding/company') {
      companyCreated = true;
      return new Response(
        JSON.stringify({ tenant: { id: 't1' }, session: { company: { id: 'c1', tenantId: 't1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathName === '/api/auth/sign-out') {
      signedOut = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'aurum_session=; Path=/; HttpOnly; SameSite=Lax' },
      });
    }
    if (pathName === '/api/product/chat/state') {
      const conversation = urlObject.searchParams.get('conversationId');
      if (!companyCreated) {
        return new Response(JSON.stringify({ error: 'no_active_company' }), {
          status: 409, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          chat: 'state', tenantId: 't1',
          view: {
            generatedAt: '2026-09-23T00:00:00Z', conversations: [],
            thread: conversation === null ? null : { id: conversation, messages: [{ id: 'm1' }, { id: 'm2' }] },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathName === '/api/product/chat/messages') {
      return new Response(
        JSON.stringify({
          chat: 'turn', tenantId: 't1', conversationId: 'c-1', executionId: 'exec-1',
          inbound: { id: 'in-1' }, reply: { id: 're-1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: 'not-found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** A fully-green 16-test browser digest (J01–J15 desktop + J14 mobile). */
function greenDigest(): BrowserRunDigest {
  const tests: BrowserRunDigest['tests'] = Array.from({ length: 15 }, (_, index) => {
    const id = `J${String(index + 1).padStart(2, '0')}`;
    return {
      testId: `${id.toLowerCase()}-x:desktop`,
      journeyId: id as BrowserRunDigest['tests'][number]['journeyId'],
      context: 'desktop' as const,
      status: 'pass' as const,
      title: `${id} desktop`,
      file: 'tests/browser/production/x.spec.ts',
      durationMs: 500,
      error: null,
    };
  });
  tests.push({
    testId: 'j14-x:mobile', journeyId: 'J14', context: 'mobile', status: 'pass',
    title: 'J14 mobile', file: 'tests/browser/production/x.spec.ts', durationMs: 500, error: null,
  });
  return {
    total: 16, passed: 16, failed: 0, flaky: 0, skipped: 0, tests,
    violations: tests.map((test) => ({ testId: test.testId, violations: 0 })),
    evidence: {
      transcripts: ['transcripts/j01.json'], screenshots: ['screens/j01.png'],
      errorCaptures: ['errors/j01.json'], results: [],
    },
  };
}

/**
 * A fully-green W101 browser digest: 21 desktop tests (J01–J13, J15–J22)
 * + the J14 mobile pair, with the honest BLOCKED channel on the four
 * post-S002 journeys whose mandatory surfaces are absent from the canned
 * deployment (mirroring the real production revision a2db98a).
 */
function greenW101Digest(): BrowserRunDigest {
  const blocked = new Set(['J16', 'J17', 'J18', 'J22']);
  const desktop = [
    ...Array.from({ length: 13 }, (_, index) => `J${String(index + 1).padStart(2, '0')}`),
    'J15', 'J16', 'J17', 'J18', 'J19', 'J20', 'J21', 'J22',
  ];
  const tests: BrowserRunDigest['tests'] = desktop.map((id) => ({
    testId: `${id.toLowerCase()}-x:desktop`,
    journeyId: id as BrowserRunDigest['tests'][number]['journeyId'],
    context: 'desktop' as const,
    status: 'pass' as const,
    title: `${id} desktop`,
    file: 'tests/browser/production/x.spec.ts',
    durationMs: 500,
    error: null,
    ...(blocked.has(id)
      ? {
          blockedReasons: [`the ${id} surface does not exist in the deployed revision`],
          blockedEvidence: { probe: `${id}-absent` },
        }
      : {}),
  }));
  tests.push({
    testId: 'j14-x:mobile', journeyId: 'J14', context: 'mobile', status: 'pass',
    title: 'J14 mobile', file: 'tests/browser/production/x.spec.ts', durationMs: 500, error: null,
  });
  return {
    total: tests.length, passed: tests.length, failed: 0, flaky: 0, skipped: 0, tests,
    violations: tests.map((test) => ({ testId: test.testId, violations: 0 })),
    evidence: {
      transcripts: ['transcripts/j01.json'], screenshots: ['screens/j01.png'],
      errorCaptures: ['errors/j01.json'], results: [],
    },
  };
}

describe('the certification driver — one full pass over a canned production target', () => {
  let evidenceRoot: string;
  let repoRoot: string;

  beforeAll(async () => {
    evidenceRoot = await mkdtemp(path.join(tmpdir(), 'w079-evidence-'));
    repoRoot = await mkdtemp(path.join(tmpdir(), 'w079-repo-'));
  });
  afterAll(async () => {
    await rm(evidenceRoot, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function runPass(options: {
    workerTokenFile?: string | null;
    vercelTokenFile?: string | null;
    expectedDeployment?: { deploymentId: string; commitSha: string; createdAt: string };
    digest?: BrowserRunDigest | null;
    debug?: boolean;
  }): Promise<Awaited<ReturnType<typeof runCertificationPass>>> {
    const fetchImpl = cannedFetch();
    // The Vercel deployment listing (read-only).
    const listingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.vercel.com')) {
        return new Response(
          JSON.stringify({
            deployments: [
              {
                uid: 'dpl_1',
                readyState: 'READY',
                createdAt: 1790136926369,
                meta: { githubCommitSha: 'sha-1' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fetchImpl(input, init);
    };
    const execImpl = async (
      command: string,
      args: string[],
      execOptions: { cwd: string; env: Record<string, string> },
    ) => {
      if (args.includes('playwright.certification.config.ts')) {
        // The fake browser matrix writes its digest where the driver reads it.
        const digest = options.digest === undefined ? greenDigest() : options.digest;
        if (digest !== null) {
          const { writeFile, mkdir } = await import('node:fs/promises');
          await mkdir(execOptions.env.W079_RUN_DIR!, { recursive: true });
          await writeFile(
            path.join(execOptions.env.W079_RUN_DIR!, 'browser-run-digest.json'),
            JSON.stringify(digest),
          );
        }
        return { code: 0, stdout: '16 passed', stderr: '' };
      }
      if (args.includes('rev-parse')) {
        return { code: 0, stdout: 'def456\n', stderr: '' };
      }
      return { code: 0, stdout: `${command} ok`, stderr: '' };
    };
    return await runCertificationPass({
      target: BASE,
      runLabel: 'A',
      expectedDeployment: options.expectedDeployment ?? {
        deploymentId: 'dpl_1',
        commitSha: 'sha-1',
        createdAt: '2026-09-23',
      },
      workerTokenFile: options.workerTokenFile ?? null,
      vercelTokenFile: options.vercelTokenFile ?? null,
      repoRoot,
      evidenceRoot,
      command: 'bun run cert:production -- --run a',
      fetchImpl: listingFetch as typeof fetch,
      execImpl,
    });
  }

  it('produces a fully green run with the complete evidence tree on disk', async () => {
    const workerTokenFile = path.join(evidenceRoot, 'worker-token');
    await (await import('node:fs/promises')).writeFile(workerTokenFile, 'the-worker-token');
    const vercelTokenFile = path.join(evidenceRoot, 'vercel-token');
    await (await import('node:fs/promises')).writeFile(vercelTokenFile, 'the-vercel-token');
    const run = await runPass({ workerTokenFile, vercelTokenFile });


    expect(run.verdict).toBe('CERTIFIED READY');
    expect(run.summary).toEqual({ passed: 15, failed: 0, blocked: 0, flaky: 0, unexpected: 0 });
    expect(run.gates.map((gate) => [gate.id, gate.status])).toEqual([
      ['matrix.consistency', 'pass'],
      ['g1.health', 'pass'],
      ['g1.quick-sign-in-off', 'pass'],
      ['g1.worker-authorization', 'pass'],
      ['g1.deployment-identity', 'pass'],
      ['g3.w078-rerun', 'pass'],
      ['g3.browser-matrix', 'pass'],
    ]);
    expect(run.w078?.summary).toMatchObject({ failed: 0, blocked: 0 });
    expect(run.journeys).toHaveLength(15);

    // The evidence tree: run-result.json, identity, command manifest, report, W078.
    const runDir = path.join(evidenceRoot, 'production-run-a');
    {
      const w078Report = JSON.parse(
        await readFile(path.join(runDir, 'w078', 'smoke-report.json'), 'utf8'),
      ) as SmokeReport;
      console.log('W078 FAILURES:', JSON.stringify(w078Report.results
        .filter((entry) => entry.status === 'fail' || entry.status === 'blocked')
        .map((entry) => [entry.id, entry.detail]), null, 1));
    }
    const runResult = JSON.parse(await readFile(path.join(runDir, 'run-result.json'), 'utf8'));
    expect(runResult.verdict).toBe('CERTIFIED READY');
    const identity = JSON.parse(await readFile(path.join(runDir, 'deployment-identity.json'), 'utf8'));
    expect(identity.deploymentId).toBe('dpl_1');
    expect(identity.hostname).toBe('prod.cert.test');
    const report = await readFile(path.join(runDir, 'run-report.md'), 'utf8');
    expect(report).toContain('Run verdict: **CERTIFIED READY**');
    const w078 = JSON.parse(await readFile(path.join(runDir, 'w078', 'smoke-report.json'), 'utf8'));
    expect(w078.summary.failed).toBe(0);
    expect(w078.summary.blocked).toBe(0);
    // No secret ever lands in the artifacts.
    const commandManifest = await readFile(path.join(runDir, 'command-manifest.json'), 'utf8');
    const allArtifacts = `${runResult}${identity}${report}${commandManifest}`;
    expect(allArtifacts.includes('the-worker-token')).toBe(false);
  }, 30_000);

  it('stays honestly BLOCKED when the worker token is not supplied', async () => {
    const run = await runPass({ workerTokenFile: null });
    const workerGate = run.gates.find((gate) => gate.id === 'g1.worker-authorization')!;
    expect(workerGate.status).toBe('blocked');
    expect(workerGate.detail).toContain('worker seam token was not supplied');
    expect(run.verdict).toBe('BLOCKED');
    expect(run.summary.blocked).toBeGreaterThan(0);
  }, 30_000);

  it('stays honestly BLOCKED when the live deployment is not the expected revision', async () => {
    const workerTokenFile = path.join(evidenceRoot, 'worker-token-2');
    await (await import('node:fs/promises')).writeFile(workerTokenFile, 'the-worker-token');
    const vercelTokenFile = path.join(evidenceRoot, 'vercel-token-2');
    await (await import('node:fs/promises')).writeFile(vercelTokenFile, 'the-vercel-token');
    const run = await runPass({
      workerTokenFile,
      vercelTokenFile,
      expectedDeployment: { deploymentId: 'dpl_OTHER', commitSha: 'sha-OTHER', createdAt: '2026-09-23' },
    });
    const identityGate = run.gates.find((gate) => gate.id === 'g1.deployment-identity')!;
    expect(identityGate.status).toBe('blocked');
    expect(identityGate.detail).toContain('dpl_OTHER');
    expect(run.verdict).toBe('BLOCKED');
  }, 30_000);

  it('is FAILED (not blocked) when the browser matrix reports a failing journey', async () => {
    const workerTokenFile = path.join(evidenceRoot, 'worker-token-3');
    await (await import('node:fs/promises')).writeFile(workerTokenFile, 'the-worker-token');
    const digest = greenDigest();
    digest.tests[1] = { ...digest.tests[1]!, status: 'fail', error: 'the composer never enabled' };
    digest.failed = 1;
    digest.passed = 15;
    const run = await runPass({ workerTokenFile, digest });
    expect(run.verdict).toBe('FAILED');
    const journey = run.journeys.find((entry) => entry.journeyId === 'J02')!;
    expect(journey.status).toBe('fail');
    expect(journey.detail).toContain('the composer never enabled');
  }, 30_000);
});

describe('the certification driver — one W101 pass over a canned production target', () => {
  let w101EvidenceRoot: string;
  let w101RepoRoot: string;

  beforeAll(async () => {
    w101EvidenceRoot = await mkdtemp(path.join(tmpdir(), 'w101-evidence-'));
    w101RepoRoot = await mkdtemp(path.join(tmpdir(), 'w101-repo-'));
    // The repo-side rollback evidence the W101 gate reads: the §12
    // Rollback runbook and the committed W078 operations evidence tree.
    await mkdir(path.join(w101RepoRoot, 'docs'), { recursive: true });
    await writeFile(
      path.join(w101RepoRoot, 'docs', 'DEPLOYMENT.md'),
      '# Deployment\n\n## 12. Rollback\n\nThe rollback runbook…\n',
      'utf8',
    );
    await mkdir(path.join(w101RepoRoot, 'docs', 'productization-evidence', 'W078'), {
      recursive: true,
    });
    await writeFile(
      path.join(w101RepoRoot, 'docs', 'productization-evidence', 'W078', 'W078-OPERATIONS-PROOF.md'),
      '# W078\n',
      'utf8',
    );
  });
  afterAll(async () => {
    await rm(w101EvidenceRoot, { recursive: true, force: true });
    await rm(w101RepoRoot, { recursive: true, force: true });
  });

  it('runs the post-S002 program: the rollback gate, the honest BLOCKED folding and the W101 identity', async () => {
    const workerTokenFile = path.join(w101EvidenceRoot, 'worker-token');
    await writeFile(workerTokenFile, 'the-worker-token');
    const vercelTokenFile = path.join(w101EvidenceRoot, 'vercel-token');
    await writeFile(vercelTokenFile, 'the-vercel-token');
    const fetchImpl = cannedFetch();
    // The Vercel listing with BOTH the current production deployment and
    // the prior READY deployment (the rollback target).
    const listingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.vercel.com')) {
        return new Response(
          JSON.stringify({
            deployments: [
              {
                uid: 'dpl_cur',
                readyState: 'READY',
                createdAt: 1790427172665,
                meta: { githubCommitSha: 'sha-cur' },
              },
              {
                uid: 'dpl_prior',
                readyState: 'READY',
                createdAt: 1790427052878,
                meta: { githubCommitSha: 'sha-prior' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fetchImpl(input, init);
    };
    const execImpl = async (
      command: string,
      args: string[],
      execOptions: { cwd: string; env: Record<string, string> },
    ) => {
      if (args.includes('playwright.certification.config.ts')) {
        const { writeFile: write, mkdir: make } = await import('node:fs/promises');
        await make(execOptions.env.W079_RUN_DIR!, { recursive: true });
        await write(
          path.join(execOptions.env.W079_RUN_DIR!, 'browser-run-digest.json'),
          JSON.stringify(greenW101Digest()),
        );
        return { code: 0, stdout: '22 passed', stderr: '' };
      }
      if (args.includes('rev-parse')) {
        return { code: 0, stdout: 'w101head\n', stderr: '' };
      }
      return { code: 0, stdout: `${command} ok`, stderr: '' };
    };
    const run = await runCertificationPass({
      target: BASE,
      program: 'W101',
      runLabel: 'A',
      expectedDeployment: {
        deploymentId: 'dpl_cur',
        commitSha: 'sha-cur',
        createdAt: '2026-09-26',
      },
      workerTokenFile,
      vercelTokenFile,
      repoRoot: w101RepoRoot,
      evidenceRoot: w101EvidenceRoot,
      command: 'bun run cert:production -- --program w101 --run a',
      repository: { branch: 'work/w101-final-certification', baseCommit: 'a2db98a' },
      fetchImpl: listingFetch as typeof fetch,
      execImpl,
    });

    // The W101 gate set: the rollback-evidence gate sits between the
    // deployment identity and the W078 rerun.
    expect(run.gates.map((gate) => [gate.id, gate.status])).toEqual([
      ['matrix.consistency', 'pass'],
      ['g1.health', 'pass'],
      ['g1.quick-sign-in-off', 'pass'],
      ['g1.worker-authorization', 'pass'],
      ['g1.deployment-identity', 'pass'],
      ['rollback.evidence', 'pass'],
      ['g3.w078-rerun', 'pass'],
      ['g3.browser-matrix', 'pass'],
    ]);
    const rollbackGate = run.gates.find((gate) => gate.id === 'rollback.evidence')!;
    expect(rollbackGate.detail).toContain('dpl_prior');
    expect(rollbackGate.detail).toContain('sha-prior');

    // The honest BLOCKED channel: the four absent-surface journeys fold
    // to blocked; the run verdict is BLOCKED (never green, never failed).
    expect(run.program).toBe('W101');
    expect(run.summary).toEqual({ passed: 18, failed: 0, blocked: 4, flaky: 0, unexpected: 0 });
    expect(run.verdict).toBe('BLOCKED');
    expect(run.journeys).toHaveLength(22);
    const blockedJourneys = run.journeys.filter((journey) => journey.status === 'blocked');
    expect(blockedJourneys.map((journey) => journey.journeyId)).toEqual(['J16', 'J17', 'J18', 'J22']);
    expect(blockedJourneys[0]!.detail).toContain('does not exist in the deployed revision');

    // The W101 repository identity is recorded in the manifest. The canned
    // repo root is not a git repository, so headCommit reads the honest
    // 'unknown' fallback (the real run records the live HEAD).
    expect(run.identity.repository.branch).toBe('work/w101-final-certification');
    expect(run.identity.repository.baseCommit).toBe('a2db98a');
    expect(run.identity.repository.headCommit).toBe('unknown');

    // The evidence tree lands under the W101 evidence root with the
    // program-stamped report; no secret ever lands in the artifacts.
    const runDir = path.join(w101EvidenceRoot, 'production-run-a');
    const runResult = await readFile(path.join(runDir, 'run-result.json'), 'utf8');
    expect(runResult).toContain('"program": "W101"');
    const report = await readFile(path.join(runDir, 'run-report.md'), 'utf8');
    expect(report).toContain('W101 production journey certification — Run A');
    expect(report).toContain('Journey matrix (J01–J22)');
    const identity = await readFile(path.join(runDir, 'deployment-identity.json'), 'utf8');
    expect(`${runResult}${report}${identity}`.includes('the-worker-token')).toBe(false);
  }, 30_000);

  it('the W101 rollback gate is honestly BLOCKED when the repo-side runbook evidence is missing', async () => {
    const bareRepoRoot = await mkdtemp(path.join(tmpdir(), 'w101-bare-'));
    const workerTokenFile = path.join(w101EvidenceRoot, 'worker-token-b');
    await writeFile(workerTokenFile, 'the-worker-token');
    const vercelTokenFile = path.join(w101EvidenceRoot, 'vercel-token-b');
    await writeFile(vercelTokenFile, 'the-vercel-token');
    const fetchImpl = cannedFetch();
    const listingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.vercel.com')) {
        return new Response(
          JSON.stringify({ deployments: [{ uid: 'dpl_cur', readyState: 'READY', createdAt: 1790427172665, meta: { githubCommitSha: 'sha-cur' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fetchImpl(input, init);
    };
    const execImpl = async (
      command: string,
      args: string[],
      execOptions: { cwd: string; env: Record<string, string> },
    ) => {
      if (args.includes('playwright.certification.config.ts')) {
        const { writeFile: write, mkdir: make } = await import('node:fs/promises');
        await make(execOptions.env.W079_RUN_DIR!, { recursive: true });
        await write(
          path.join(execOptions.env.W079_RUN_DIR!, 'browser-run-digest.json'),
          JSON.stringify(greenW101Digest()),
        );
        return { code: 0, stdout: '22 passed', stderr: '' };
      }
      if (args.includes('rev-parse')) {
        return { code: 0, stdout: 'w101head\n', stderr: '' };
      }
      return { code: 0, stdout: `${command} ok`, stderr: '' };
    };
    const run = await runCertificationPass({
      target: BASE,
      program: 'W101',
      runLabel: 'B',
      expectedDeployment: { deploymentId: 'dpl_cur', commitSha: 'sha-cur', createdAt: '2026-09-26' },
      workerTokenFile,
      vercelTokenFile,
      repoRoot: bareRepoRoot,
      evidenceRoot: path.join(bareRepoRoot, 'docs', 'productization-evidence', 'W101'),
      command: 'bun run cert:production -- --program w101 --run b',
      repository: { branch: 'work/w101-final-certification', baseCommit: 'a2db98a' },
      fetchImpl: listingFetch as typeof fetch,
      execImpl,
    });
    const rollbackGate = run.gates.find((gate) => gate.id === 'rollback.evidence')!;
    expect(rollbackGate.status).toBe('blocked');
    expect(rollbackGate.detail).toContain('docs/DEPLOYMENT.md §12');
    expect(rollbackGate.detail).toContain('no prior READY production deployment');
    expect(run.verdict).toBe('BLOCKED');
    await rm(bareRepoRoot, { recursive: true, force: true });
  }, 30_000);
});
