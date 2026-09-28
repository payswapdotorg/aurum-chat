// W110 — THE REAL-BROWSER EVIDENCE RUN.
//
// This script executes REAL browser tasks (Playwright/chromium, the
// repository's already-reviewed browser runtime) through the EXISTING
// W093 computer-use lifecycle — frozen plan, creation-time allowlist
// validation, disposable isolated sessions, dispatch-time allowlist
// re-check, driver-side allowlist copy, evidence ledger observations,
// W084 reconciliation before any step counts, mismatch attention
// unknowns, failure bundles, and resume from the durable checkpoint —
// against a TINY LOCAL HTTP FIXTURE SITE (a real localhost server, not
// a data: page), and records everything it observed as evidence in this
// directory (report.json + artifacts/*.png|html).
//
// WHAT THIS RUN PROVES (the W110 acceptance, one real task per clause):
//
//   1. HAPPY PATH — a governed login flow (goto → type literal → type
//      OPAQUE credential field → submit → goto → read → click) runs on
//      real chromium to a fully VERIFIED completion: every step's
//      observed page state (real DOM) matches its frozen expectation,
//      with per-step screenshot + DOM-snapshot evidence and redacted
//      action traces.
//
//   2. TRANSIENT FAILURE + RESUME — the fixture server DROPS the socket
//      on the first /app navigation: the step fails transiently
//      (receipt 'failed'), the task parks resumable, and a FRESH
//      disposable session resumes from the checkpoint — the four
//      verified steps are NEVER re-executed (exactly-once at the
//      browser), and the resumed session continues on the SAME isolated
//      profile (the login cookie persisted through the profile store —
//      real browser continuity).
//
//   3. WRONG CREDENTIALS → MISMATCH — a second opaque reference carries
//      wrong credentials: the submit executes, the server bounces to
//      the sign-in-failed page, and the observed state DIVERGES from
//      the frozen expectation — the task ends 'mismatched' (terminal)
//      with the EXISTING evidence shape: W084 StateMismatch diff,
//      mismatch evidence observation, attention unknown, and the
//      failure bundle. Nothing unverified is ever treated as a result.
//
//   4. SECRETS STAY OPAQUE — the credential VALUES live only in the
//      environment (BROWSER_CREDENTIALS) and inside the driver's
//      isolated profile: a full SQL sweep over every module table (plus
//      the module's observations) and a byte-level sweep over EVERY
//      produced evidence artifact find ZERO traces of them (the
//      observed states carry redaction markers; the DOM snapshots do
//      not serialize typed input values — proven by the sweep, not by
//      trust).
//
// HOW TO RE-RUN (from the repository root, with the playwright browsers
// installed — `npx playwright install chromium` if needed):
//
//   ./node_modules/.bin/tsx docs/productization-evidence/W110/run-real-browser-task.ts
//
// The run is DETERMINISTIC in its outcomes (the fixture site is
// in-process; the transient fault is armed explicitly); screenshot
// bytes naturally differ per run (they hash differently — the report
// pins each artifact's sha256 so the committed evidence is verifiable).
//
// This file is EVIDENCE INFRASTRUCTURE, not a test: the repository's
// test suites stay on the deterministic double (the fixtures/doubles
// doctrine); this run is the one-time real-browser leg recorded under
// docs/productization-evidence/W110/ (see DELIVERY.md).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../scripts/migrate';
import {
  browserProfileKey,
  createBrowserTask,
  ensureBrowserDriverWired,
  getBrowserDriver,
  getBrowserFailureEvidence,
  listBrowserTaskEvents,
  resumeBrowserTask,
  setBrowserDriver,
  startBrowserTask,
  type BrowserTaskDetail,
  type PlaywrightBrowserDriver,
} from '@/modules/computer-use/contract';

// ---------------------------------------------------------------------------
// The run's own configuration (all through the ENVIRONMENT — the only
// credential channel; the fragments keep no realistic literal in source)
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const ARTIFACT_DIR = path.join(HERE, 'artifacts');
const PROFILE_DIR = path.join(REPO_ROOT, '.data', 'w110-evidence-profiles');

const HOST = '127.0.0.1';
const PORT = 3117;
const BASE = `http://${HOST}:${PORT}`;
const LOGIN_URL = `${BASE}/login`;
const WELCOME_URL = `${BASE}/welcome`;
const APP_URL = `${BASE}/app`;
const ALLOWLIST = {
  urlGlobs: [`${BASE}/*`],
  verbs: ['goto', 'type', 'read', 'click', 'submit'] as const,
};

const GOOD_CREDENTIAL_REF = ['secret-store://', 'w110-evidence/', 'vendor-good'].join('');
const BAD_CREDENTIAL_REF = ['secret-store://', 'w110-evidence/', 'vendor-bad'].join('');
const GOOD_PASSWORD = ['w110-evidence-', 'materialized-', 'good-fragment'].join('');
const BAD_PASSWORD = ['w110-evidence-', 'materialized-', 'bad-fragment'].join('');
const SECRET_SWEEP_FRAGMENT = 'w110-evidence-materialized'; // common to both values

process.env.BROWSER_DRIVER = 'playwright';
process.env.BROWSER_HEADLESS = '1';
process.env.BROWSER_ARTIFACT_DIR = ARTIFACT_DIR;
process.env.BROWSER_PROFILE_DIR = PROFILE_DIR;
process.env.BROWSER_CREDENTIALS = JSON.stringify({
  [GOOD_CREDENTIAL_REF]: { username: 'ops@acme.example', password: GOOD_PASSWORD },
  [BAD_CREDENTIAL_REF]: { username: 'ops@acme.example', password: BAD_PASSWORD },
});

// ---------------------------------------------------------------------------
// The tiny local HTTP fixture site (a REAL localhost server)
// ---------------------------------------------------------------------------

let failNextAppRequest = false;

// The run's teardown handles (the failure path must still close the
// server, the browser engine and the database — a failed evidence run
// must never leave the process hanging on live handles).
let activeServer: Server | null = null;
let activeDriver: PlaywrightBrowserDriver | null = null;

function loginPage(error: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vendor portal</title></head><body>
<h1>${error ? 'Sign-in failed' : 'Sign in'}</h1>
<form method="post" action="/login">
<input id="username" name="username" type="text" autocomplete="off">
<input id="password" name="password" type="password" autocomplete="off">
<button id="submit" name="submit" type="submit">Sign in</button>
</form></body></html>`;
}

function welcomePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Welcome</title></head><body>
<h1>Signed in</h1><p>The sign-in succeeded; the session cookie is set.</p>
</body></html>`;
}

function dashboardPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title></head><body>
<h1>Dashboard</h1>
<input type="hidden" name="loggedIn" value="true">
<input type="hidden" name="tick" value="">
<button id="refresh" type="button">Refresh</button>
<script>document.getElementById('refresh').addEventListener('click', function () {
  document.querySelector('input[name=tick]').value = 'refreshed';
});</script>
</body></html>`;
}

function hasSessionCookie(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? '').includes('w110session=ok');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startFixtureServer(): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(loginPage(url.searchParams.get('error') === '1'));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = new URLSearchParams(await readBody(req));
        const username = body.get('username') ?? '';
        const password = body.get('password') ?? '';
        const good = username === 'ops@acme.example' && password === GOOD_PASSWORD;
        if (good) {
          res.writeHead(303, {
            Location: '/welcome',
            'Set-Cookie': 'w110session=ok; Path=/; HttpOnly',
          });
        } else {
          res.writeHead(303, { Location: '/login?error=1' });
        }
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/welcome') {
        if (!hasSessionCookie(req)) {
          res.writeHead(303, { Location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(welcomePage());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/app') {
        if (failNextAppRequest) {
          failNextAppRequest = false;
          // Die MID-RESPONSE: flush the status line and a partial body to
          // the wire FIRST (write's callback), THEN destroy the socket —
          // the browser has a response in flight, so this is a network
          // failure it must surface (an idle-keep-alive destroy before
          // any bytes could be silently retried by the network stack; a
          // destroy before the flush never reaches the wire). Verified
          // against real chromium: one request, no retry, goto rejects.
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.write('<!doctype html><html><head><title>Vendor portal</title>', () => {
            res.socket?.destroy();
          });
          return;
        }
        if (!hasSessionCookie(req)) {
          res.writeHead(303, { Location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboardPage());
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// The evidence records (what the run writes into report.json)
// ---------------------------------------------------------------------------

interface StepRecord {
  key: string;
  position: number;
  verb: string;
  url: string;
  state: string;
  receiptStatus: string | null;
  receiptId: string | null;
  receiptDetail: string | null;
  observedState: unknown;
  screenshotRef: string | null;
  actionTrace: unknown;
  mismatchEvidenceObservationId: string | null;
  mismatchUnknownId: string | null;
}

interface ScenarioRecord {
  name: string;
  description: string;
  taskId: string;
  status: string;
  sessions: Array<{ sequence: number; status: string; stepsExecuted: number; profileKey: string }>;
  events: string[];
  steps: StepRecord[];
  failureBundle: unknown;
  exactlyOnce: Record<string, number>;
}

function stepRecords(detail: BrowserTaskDetail): StepRecord[] {
  return detail.steps.map((step) => ({
    key: step.key,
    position: step.position,
    verb: step.action.verb,
    url: step.action.url,
    state: step.state,
    receiptStatus: step.receiptStatus,
    receiptId: step.receiptId,
    receiptDetail: step.receiptDetail,
    observedState: step.observedState,
    screenshotRef: step.screenshotRef,
    actionTrace: step.actionTrace,
    mismatchEvidenceObservationId: step.mismatchEvidenceObservationId,
    mismatchUnknownId: step.mismatchUnknownId,
  }));
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`EVIDENCE RUN FAILED — ${message}`);
  }
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

// ---------------------------------------------------------------------------
// The governed plans
// ---------------------------------------------------------------------------

function happyFlowSteps() {
  return [
    {
      key: 'open-login',
      action: { verb: 'goto' as const, url: LOGIN_URL },
      expectation: { url: LOGIN_URL, title: 'Vendor portal', heading: 'Sign in' },
    },
    {
      key: 'type-username',
      action: { verb: 'type' as const, url: LOGIN_URL, selector: '#username', value: 'ops@acme.example' },
      expectation: { url: LOGIN_URL, '#username': 'ops@acme.example' },
    },
    {
      key: 'type-password',
      action: { verb: 'type' as const, url: LOGIN_URL, selector: '#password', secretField: 'password' },
      expectation: { url: LOGIN_URL, '#username': 'ops@acme.example' },
    },
    {
      key: 'submit-login',
      action: { verb: 'submit' as const, url: LOGIN_URL, selector: '#submit' },
      expectation: { url: WELCOME_URL, title: 'Welcome', heading: 'Signed in' },
    },
    {
      key: 'goto-app',
      action: { verb: 'goto' as const, url: APP_URL },
      expectation: { url: APP_URL, title: 'Dashboard', heading: 'Dashboard', '[name="loggedIn"]': 'true' },
    },
    {
      key: 'read-dashboard',
      action: { verb: 'read' as const, url: APP_URL, selector: '[name="loggedIn"]' },
      expectation: { url: APP_URL, '[name="loggedIn"]': 'true' },
    },
    {
      key: 'refresh',
      action: { verb: 'click' as const, url: APP_URL, selector: '#refresh' },
      expectation: { url: APP_URL, '[name="tick"]': 'refreshed' },
    },
  ];
}

function resumeFlowSteps() {
  return happyFlowSteps().slice(0, 5); // through goto-app
}

function wrongCredentialsSteps() {
  return happyFlowSteps().slice(0, 4); // through submit-login
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[w110] real-browser evidence run — starting');

  const server = await startFixtureServer();
  activeServer = server;
  console.log(`[w110] fixture server on ${BASE}`);

  await runMigrations(getDb());
  console.log('[w110] embedded PostgreSQL migrated (PGlite :memory:)');

  // THE PRODUCTION WIRING PATH: env-driven, globalThis-guarded, honest.
  const wiring = ensureBrowserDriverWired();
  console.log(`[w110] wiring: driver=${wiring.driver} state=${wiring.state}`);
  assert(wiring.driver === 'playwright' && wiring.state === 'wired', 'the real driver must be wired');
  const driver = getBrowserDriver() as PlaywrightBrowserDriver;
  assert(driver !== null, 'the wired driver must be reachable');
  activeDriver = driver;

  const tenantId = newId(); // a real uuid (the storage layer's tenant discipline)
  const scenarios: ScenarioRecord[] = [];
  /** Per-scenario browser-execution deltas (exactly-once proofs). */
  const executionsBefore = (): Record<string, number> => {
    const snapshot: Record<string, number> = {};
    for (const [key, count] of driver.browserExecutions) snapshot[key] = count;
    return snapshot;
  };
  const executionDelta = (before: Record<string, number>, keys: string[]): Record<string, number> => {
    const delta: Record<string, number> = {};
    for (const key of keys) delta[key] = (driver.browserExecutions.get(key) ?? 0) - (before[key] ?? 0);
    return delta;
  };

  // --- Scenario 1: the governed happy path on real chromium ----------------
  {
    const executions = executionsBefore();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: {
        description: 'W110 evidence — accept the Q3 price list in the vendor portal (real chromium)',
        requestedFor: 'Q3 procurement',
      },
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
      steps: happyFlowSteps(),
      credentialRef: GOOD_CREDENTIAL_REF,
    });
    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    assert(detail.task.status === 'completed', `scenario 1 must complete (got ${detail.task.status})`);
    assert(detail.steps.every((step) => step.state === 'verified'), 'every step must be verified');
    assert(detail.steps.every((step) => step.screenshotRef !== null), 'every step carries a screenshot');
    const events = await listBrowserTaskEvents(member(tenantId), { taskId: created.task.id, limit: 500 });
    scenarios.push({
      name: 'happy-path',
      description: 'governed login flow (5 verbs) on real chromium → fully verified completion',
      taskId: created.task.id,
      status: detail.task.status,
      sessions: detail.sessions.map((session) => ({
        sequence: session.sequence,
        status: session.status,
        stepsExecuted: session.stepsExecuted,
        profileKey: session.profileKey,
      })),
      events: events.map((event) => event.event).reverse(),
      steps: stepRecords(detail),
      failureBundle: null,
      exactlyOnce: executionDelta(executions, happyFlowSteps().map((step) => step.key)),
    });
    console.log(`[w110] scenario 1 (happy path): completed, ${detail.steps.length} steps verified`);
  }

  // --- Scenario 2: transient failure + resume from the checkpoint ----------
  {
    const executions = executionsBefore();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: {
        description: 'W110 evidence — the transient /app outage and the resumable checkpoint (real chromium)',
        requestedFor: 'Q3 procurement',
      },
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
      steps: resumeFlowSteps(),
      credentialRef: GOOD_CREDENTIAL_REF,
    });
    const dispatchesBeforeFirstRun = driver.performRequests.length;

    failNextAppRequest = true; // ARM the transient: the next /app response dies mid-wire
    const failed = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    assert(failed.task.status === 'failed', `scenario 2 must park 'failed' (got ${failed.task.status})`);
    const failedStep = failed.steps.find((step) => step.key === 'goto-app')!;
    assert(failedStep.state === 'failed', 'the goto-app step must be the transient failure');
    assert(
      failedStep.receiptDetail !== null && failedStep.receiptDetail.includes('transient'),
      'the receipt must say transient',
    );
    assert(
      failed.steps.filter((step) => step.state === 'verified').length === 4,
      'the four login steps must be the verified checkpoint',
    );
    const failureBundle = await getBrowserFailureEvidence(member(tenantId), { taskId: created.task.id });
    assert(
      failureBundle !== null && failureBundle.failureKind === 'step-failed',
      'the failure bundle must be step-failed',
    );

    // RESUME: a fresh disposable session from the durable checkpoint.
    const dispatchesBeforeResume = driver.performRequests.length;
    const resumed = await resumeBrowserTask(member(tenantId), { taskId: created.task.id });
    assert(
      resumed.task.status === 'completed',
      `scenario 2 resume must complete (got ${resumed.task.status})`,
    );
    assert(resumed.steps.every((step) => step.state === 'verified'), 'every step must be verified after resume');
    assert(resumed.sessions.length === 2, 'the resume must mint a second session');
    const firstRunDispatches = driver.performRequests.slice(dispatchesBeforeFirstRun, dispatchesBeforeResume);
    assert(
      firstRunDispatches.length === 5,
      `the first run must dispatch all 5 steps once (got ${firstRunDispatches.map((r) => r.stepKey).join(', ')})`,
    );
    const resumeDispatches = driver.performRequests.slice(dispatchesBeforeResume);
    const checkpointKeys = ['open-login', 'type-username', 'type-password', 'submit-login'];
    assert(
      resumeDispatches.every((request) => !checkpointKeys.includes(request.stepKey)),
      `verified steps must never be re-dispatched on resume (got ${resumeDispatches.map((r) => r.stepKey).join(', ')})`,
    );
    assert(
      resumeDispatches.filter((request) => request.stepKey === 'goto-app').length === 1,
      'the failed step must be retried exactly once in the fresh session',
    );
    const events = await listBrowserTaskEvents(member(tenantId), { taskId: created.task.id, limit: 500 });
    scenarios.push({
      name: 'transient-failure-resume',
      description:
        'the fixture drops the /app socket once → transient receipt → fresh session resumes from the checkpoint (verified steps never re-executed)',
      taskId: created.task.id,
      status: resumed.task.status,
      sessions: resumed.sessions.map((session) => ({
        sequence: session.sequence,
        status: session.status,
        stepsExecuted: session.stepsExecuted,
        profileKey: session.profileKey,
      })),
      events: events.map((event) => event.event).reverse(),
      steps: stepRecords(resumed),
      failureBundle,
      exactlyOnce: executionDelta(executions, resumeFlowSteps().map((step) => step.key)),
    });
    console.log(
      `[w110] scenario 2 (transient + resume): failed → resumed → completed (${resumed.sessions[1]!.stepsExecuted} step(s) in session 2)`,
    );
  }

  // --- Scenario 3: wrong credentials → mismatch (existing evidence shape) --
  {
    const executions = executionsBefore();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: {
        description: 'W110 evidence — wrong credentials diverge the observed state (real chromium)',
        requestedFor: 'Q3 procurement',
      },
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
      steps: wrongCredentialsSteps(),
      credentialRef: BAD_CREDENTIAL_REF,
    });
    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    assert(
      detail.task.status === 'mismatched',
      `scenario 3 must end 'mismatched' (got ${detail.task.status})`,
    );
    const mismatched = detail.steps.find((step) => step.key === 'submit-login')!;
    assert(mismatched.state === 'mismatched', 'the submit step must be the divergence');
    assert(mismatched.mismatchEvidenceObservationId !== null, 'the mismatch evidence observation must exist');
    assert(mismatched.mismatchUnknownId !== null, 'the attention unknown must exist');
    const failureBundle = await getBrowserFailureEvidence(member(tenantId), { taskId: created.task.id });
    assert(
      failureBundle !== null && failureBundle.failureKind === 'mismatch',
      'the failure bundle must be a mismatch',
    );
    assert(failureBundle!.step !== null && failureBundle!.step!.mismatches.length > 0, 'the W084 diff must be non-empty');
    const events = await listBrowserTaskEvents(member(tenantId), { taskId: created.task.id, limit: 500 });
    scenarios.push({
      name: 'wrong-credentials-mismatch',
      description:
        'wrong credentials → the submit lands on the sign-in-failed page → observed state diverges → terminal mismatch with the existing evidence shape',
      taskId: created.task.id,
      status: detail.task.status,
      sessions: detail.sessions.map((session) => ({
        sequence: session.sequence,
        status: session.status,
        stepsExecuted: session.stepsExecuted,
        profileKey: session.profileKey,
      })),
      events: events.map((event) => event.event).reverse(),
      steps: stepRecords(detail),
      failureBundle,
      exactlyOnce: executionDelta(executions, wrongCredentialsSteps().map((step) => step.key)),
    });
    console.log('[w110] scenario 3 (wrong credentials): mismatched (terminal), diff recorded');
  }

  // --- The secrets sweep (SQL + artifact bytes) ------------------------------
  const sweep = await getDb().query<{ table_name: string; bad: string }>(`
    SELECT 'browser_tasks' AS table_name, count(*)::text AS bad FROM browser_tasks WHERE to_jsonb(browser_tasks)::text LIKE '%${SECRET_SWEEP_FRAGMENT}%'
    UNION ALL SELECT 'browser_task_steps', count(*)::text FROM browser_task_steps WHERE to_jsonb(browser_task_steps)::text LIKE '%${SECRET_SWEEP_FRAGMENT}%'
    UNION ALL SELECT 'browser_sessions', count(*)::text FROM browser_sessions WHERE to_jsonb(browser_sessions)::text LIKE '%${SECRET_SWEEP_FRAGMENT}%'
    UNION ALL SELECT 'browser_task_events', count(*)::text FROM browser_task_events WHERE to_jsonb(browser_task_events)::text LIKE '%${SECRET_SWEEP_FRAGMENT}%'
    UNION ALL SELECT 'browser_task_idempotency', count(*)::text FROM browser_task_idempotency WHERE to_jsonb(browser_task_idempotency)::text LIKE '%${SECRET_SWEEP_FRAGMENT}%'
    UNION ALL SELECT 'observations', count(*)::text FROM observations WHERE tenant_id = $1 AND to_jsonb(observations)::text LIKE '%${SECRET_SWEEP_FRAGMENT}%'
  `, [tenantId]);
  for (const row of sweep.rows) {
    assert(row.bad === '0', `secret sweep: ${row.table_name} leaked ${row.bad} row(s)`);
  }
  console.log('[w110] secrets sweep (SQL): 0 hits across every module table + observations');

  const artifactFiles = (await readdir(ARTIFACT_DIR)).sort();
  const artifactInventory: Array<{ file: string; bytes: number; sha256: string; secretHit: boolean }> = [];
  for (const file of artifactFiles) {
    const bytes = await readFile(path.join(ARTIFACT_DIR, file));
    const text = bytes.toString('utf8');
    artifactInventory.push({
      file,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      secretHit: text.includes(SECRET_SWEEP_FRAGMENT),
    });
  }
  assert(
    artifactInventory.every((entry) => !entry.secretHit),
    'secrets sweep (artifacts): no evidence artifact may contain a secret fragment',
  );
  assert(
    artifactInventory.some((entry) => entry.file.endsWith('.png')) &&
      artifactInventory.some((entry) => entry.file.endsWith('.html')),
    'the evidence must contain real screenshots AND DOM snapshots',
  );
  console.log(
    `[w110] secrets sweep (artifacts): 0 hits across ${artifactInventory.length} evidence files (${artifactInventory.filter((e) => e.file.endsWith('.png')).length} PNG, ${artifactInventory.filter((e) => e.file.endsWith('.html')).length} HTML)`,
  );

  // --- The report ------------------------------------------------------------
  const report = {
    workItem: 'W110',
    title: 'Real Browser / Computer-Use Driver Composition — real-run evidence',
    executedAt: new Date().toISOString(),
    environment: {
      tenantId,
      engine: driver.engineVersion(),
      headless: true,
      fixtureServer: BASE,
      wiringReport: wiring,
      profileKeyPrefix: 'computer-use:tenant:<tenantId>:task:<taskId>',
      scenario1ProfileKey: browserProfileKey(tenantId, scenarios[0]!.taskId),
    },
    scenarios,
    sweeps: {
      sql: {
        fragment: `${SECRET_SWEEP_FRAGMENT}…`,
        tables: sweep.rows.map((row) => ({ table: row.table_name, hits: row.bad })),
        result: 'clean — zero hits',
      },
      artifacts: {
        files: artifactInventory.length,
        secretHits: artifactInventory.filter((entry) => entry.secretHit).length,
        result: 'clean — zero hits',
      },
    },
    artifactInventory,
  };
  await writeFile(path.join(HERE, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('[w110] report written: docs/productization-evidence/W110/report.json');

  // --- honest teardown --------------------------------------------------------
  await driver.close();
  setBrowserDriver(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  console.log('[w110] EVIDENCE RUN COMPLETE — all assertions held');
}

main().catch(async (error: unknown) => {
  console.error('[w110] EVIDENCE RUN FAILED:', error);
  // Honest teardown on the failure path too (best effort, bounded).
  try {
    await activeDriver?.close();
  } catch {
    /* already dying */
  }
  setBrowserDriver(null);
  await new Promise<void>((resolve) => {
    if (activeServer === null) {
      resolve();
      return;
    }
    activeServer.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
  try {
    await closeDb();
  } catch {
    /* already closed */
  }
  process.exitCode = 1;
});
