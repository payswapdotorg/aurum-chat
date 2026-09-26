// Integration tests for the computer-use module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W093
// acceptance end-to-end:
//
// "browser task is disposable and resumable; session credentials are
//  isolated; observed state is verified before being treated as a
//  result; failure produces actionable evidence."
//
//  * THE GOVERNED HAPPY PATH — a login-flow task (goto → type username →
//    type a credential FIELD → goto the app) runs against the
//    deterministic scripted driver: every step's observed state is
//    recorded as immutable evidence with its screenshot reference and
//    redacted action trace, verified against the expected shape, and the
//    task ends 'completed' with nothing unverified;
//
//  * CREDENTIAL ISOLATION — the task carries only the OPAQUE reference;
//    the profile key is per (tenant, task); the driver materialized the
//    reference INSIDE the isolated profile and typed the field there;
//    and a full SQL sweep over every module table (plus the module's
//    observations) proves the materialized VALUE never persisted
//    anywhere;
//
//  * DISPOSABLE AND RESUMABLE — a transient driver failure parks the
//    task 'failed' and a fresh session RESUMES from the checkpoint
//    (verified steps never re-executed — exactly-once at the driver); a
//    driver CRASH (worker death) parks 'suspended' with the session
//    'interrupted' and resumes the same way;
//
//  * VERIFIED BEFORE RESULT — an accepted action whose observed state
//    diverges is 'mismatched', never verified: the W084-shape diff is
//    recorded as mismatch evidence plus an attention unknown, the task
//    ends 'mismatched' (terminal), and the failure bundle carries the
//    diff; the stale-page divergence (accepted but nothing moved) is
//    flagged;
//
//  * GOVERNED AUTOMATION — the service-side allowlist blocks a
//    corrupted step (defense in depth) with the decision as evidence
//    and the driver never sees it; a permanent driver refusal aborts
//    with the receipt as evidence; the driver-side allowlist copy is
//    proven in the unit suite;
//
//  * PROVIDER OBJECTS NEVER CROSS — a driver returning a provider
//    receipt object, or an accepted action without its observed state,
//    is rejected loudly and the run parks resumable;
//
//  * THE EDGE BROWSER ADAPTER BINDING — the W088 approved-browser-adapter
//    double binds to the BrowserDriver port through a thin test-local
//    shape adapter (receipt taxonomy verbatim, {found, state} verbatim,
//    opaque secret reference passing straight through) and carries a
//    governed task to completion — the contract-level alignment the
//    work order requires, with NO edge internals imported by the module;
//
//  * STATE DISCIPLINE — wrong-phase calls, unknown tasks, missing
//    driver, idempotent create replay, per-status listings;
//
//  * TENANT ISOLATION — two tenants, zero leakage (compact; the W044
//    sweep carries the full proof);
//
//  * STORAGE DISCIPLINE — the events ledger is append-only
//    (UPDATE/DELETE/TRUNCATE refused at the storage level).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as observationsContract from '@/modules/observations/contract';
import * as epistemicsContract from '@/modules/epistemics/contract';
import { createBrowserDouble } from '@/modules/edge-connector/contract';
import type {
  EdgeAdapterRequest,
  EdgeAdapterResult,
  EdgeConnectivityAdapter,
} from '@/modules/edge-connector/contract';
import { ComputerUseError } from '../errors';
import * as computerUse from '../contract';
import {
  createScriptedBrowserDriver,
  type ScriptedBrowserDriver,
} from '../double';
import type {
  BrowserAllowlist,
  BrowserDriver,
  BrowserStepInput,
  BrowserTaskDetail,
} from '../contract';

const {
  createBrowserTask,
  startBrowserTask,
  resumeBrowserTask,
  getBrowserTask,
  listBrowserTasks,
  listBrowserTaskEvents,
  getBrowserFailureEvidence,
  setBrowserDriver,
  browserProfileKey,
} = computerUse;

const { getObservation } = observationsContract;
const { getUnknown } = epistemicsContract;

// A FRESH tenant per test so counts stay deterministic.
function freshTenant(): string {
  return newId();
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

// Fake credentials are assembled from fragments at runtime (never a
// realistic full token literal in source).
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w093/` + `${label}/` + 'ref';
}

async function expectError(
  code: ComputerUseError['code'],
  fn: () => Promise<unknown>,
): Promise<ComputerUseError> {
  try {
    await fn();
    throw new Error(`expected ComputerUseError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof ComputerUseError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

// ---------------------------------------------------------------------------
// The governed login-flow fixture (the happy path's plan)
// ---------------------------------------------------------------------------

const LOGIN_URL = 'https://vendor.example/login';
const APP_URL = 'https://vendor.example/app';
const ALLOWLIST: BrowserAllowlist = {
  urlGlobs: ['https://vendor.example/*'],
  verbs: ['goto', 'type', 'read', 'click'],
};

function loginFlowSteps(): BrowserStepInput[] {
  return [
    {
      key: 'open-login',
      action: { verb: 'goto', url: LOGIN_URL },
      expectation: { url: LOGIN_URL, title: 'Vendor portal', heading: 'Sign in' },
    },
    {
      key: 'type-username',
      action: { verb: 'type', url: LOGIN_URL, selector: '#username', value: 'ops@acme.example' },
      expectation: { url: LOGIN_URL, '#username': 'ops@acme.example' },
    },
    {
      key: 'type-password',
      action: {
        verb: 'type',
        url: LOGIN_URL,
        selector: '#password',
        secretField: 'password',
      },
      expectation: { url: LOGIN_URL, '#username': 'ops@acme.example' },
    },
    {
      key: 'open-app',
      action: { verb: 'goto', url: APP_URL },
      expectation: { url: APP_URL, title: 'Dashboard', loggedIn: true },
    },
  ];
}

function seededDriver(): ScriptedBrowserDriver {
  return createScriptedBrowserDriver({
    pages: {
      [LOGIN_URL]: { title: 'Vendor portal', fields: { heading: 'Sign in' } },
      [APP_URL]: { title: 'Dashboard', fields: { loggedIn: true } },
    },
  });
}

async function createLoginTask(
  tenantId: string,
  credentialRef: string,
): Promise<BrowserTaskDetail> {
  const created = await createBrowserTask(member(tenantId), {
    taskContext: {
      description: 'Accept the Q3 price list in the vendor portal',
      requestedFor: 'Q3 procurement',
    },
    allowlist: ALLOWLIST,
    steps: loginFlowSteps(),
    credentialRef,
  });
  expect(created.created).toBe(true);
  return { task: created.task, steps: created.steps, sessions: [] };
}

const BASE_TIME = Date.parse('2026-09-26T12:00:00Z');
let clockMs = BASE_TIME;
let driver: ScriptedBrowserDriver;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setBrowserDriver(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  driver = seededDriver();
  setBrowserDriver(driver);
});

// ---------------------------------------------------------------------------
// The governed happy path + credential isolation
// ---------------------------------------------------------------------------

describe('W093 — the governed happy path', () => {
  it('runs the plan to a fully verified completion with per-step evidence', async () => {
    const tenantId = freshTenant();
    const credentialRef = fakeCredentialRef('vendor-portal');
    const { task } = await createLoginTask(tenantId, credentialRef);

    const detail = await startBrowserTask(member(tenantId), { taskId: task.id });
    expect(detail.task.status).toBe('completed');
    expect(detail.task.mismatchCount).toBe(0);
    expect(detail.steps).toHaveLength(4);
    for (const step of detail.steps) {
      expect(step.state).toBe('verified');
      expect(step.observedStateObservationId).not.toBeNull();
      expect(step.observedState).not.toBeNull();
      expect(step.screenshotRef).toMatch(/^computer-use-screenshot:\/\//);
      expect(step.actionTrace).not.toBeNull();
      expect(step.receiptStatus).toBe('accepted');
      expect(step.receiptId).toMatch(/^browser-rcpt-/);
      expect(step.sessionId).not.toBeNull();
    }
    // One disposable session, completed.
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({
      status: 'completed',
      sequence: 1,
      stepsExecuted: 4,
      profileKey: browserProfileKey(tenantId, task.id),
    });
    // The observed-state evidence is readable through the W004 contract.
    const observation = await getObservation(
      member(tenantId),
      detail.steps[0]!.observedStateObservationId!,
    );
    expect(observation.kind).toBe('computer-use.observed-state');
    expect(observation.channel).toBe('computer-use');
    expect((observation.payload as { stepKey: string }).stepKey).toBe('open-login');
    // The audit feed is ordered and complete.
    const events = await listBrowserTaskEvents(member(tenantId), { taskId: task.id, limit: 500 });
    const kinds = events.map((event) => event.event).reverse();
    expect(kinds).toEqual([
      'created',
      'started',
      'step-executed',
      'step-verified',
      'step-executed',
      'step-verified',
      'step-executed',
      'step-verified',
      'step-executed',
      'step-verified',
      'completed',
    ]);
    // The failure bundle of a clean task is null.
    expect(await getBrowserFailureEvidence(member(tenantId), { taskId: task.id })).toBeNull();
  });

  it('session credentials are isolated: opaque ref in, materialized only inside the per-(tenant,task) profile, never persisted', async () => {
    const tenantId = freshTenant();
    const credentialRef = fakeCredentialRef('vendor-portal');
    const { task } = await createLoginTask(tenantId, credentialRef);

    const detail = await startBrowserTask(member(tenantId), { taskId: task.id });
    expect(detail.task.status).toBe('completed');

    // The task row carries ONLY the opaque reference.
    expect(detail.task.credentialRef).toBe(credentialRef);

    // The driver received the isolated per-(tenant,task) profile key and
    // materialized the reference INSIDE it — once per session start.
    const profileKey = browserProfileKey(tenantId, task.id);
    expect(driver.sessionStarts).toHaveLength(1);
    expect(driver.sessionStarts[0]).toMatchObject({
      profileKey,
      credentialRef,
    });
    expect(driver.materializedRefs.get(profileKey)).toBe(credentialRef);
    // The credential field was typed inside the profile.
    expect(driver.typedSecretFields.get(profileKey)).toEqual(new Set(['password']));
    // The materialized value exists driver-side (the flow really typed it)…
    const materialized = driver.materializedValueOf(profileKey, 'password')!;
    expect(materialized).toContain('materialized-');

    // …and NEVER persisted: a full sweep over every module table (all
    // columns, jsonb included) plus the module's observations finds no
    // trace of the materialized value or the ref's secret fragment.
    const sweep = await getDb().query<{ table_name: string; bad: string }>(`
      SELECT 'browser_tasks' AS table_name, count(*)::text AS bad FROM browser_tasks WHERE to_jsonb(browser_tasks)::text LIKE '%materialized-%'
      UNION ALL SELECT 'browser_task_steps', count(*)::text FROM browser_task_steps WHERE to_jsonb(browser_task_steps)::text LIKE '%materialized-%'
      UNION ALL SELECT 'browser_sessions', count(*)::text FROM browser_sessions WHERE to_jsonb(browser_sessions)::text LIKE '%materialized-%'
      UNION ALL SELECT 'browser_task_events', count(*)::text FROM browser_task_events WHERE to_jsonb(browser_task_events)::text LIKE '%materialized-%'
      UNION ALL SELECT 'browser_task_idempotency', count(*)::text FROM browser_task_idempotency WHERE to_jsonb(browser_task_idempotency)::text LIKE '%materialized-%'
      UNION ALL SELECT 'observations', count(*)::text FROM observations WHERE tenant_id = $1 AND to_jsonb(observations)::text LIKE '%materialized-%'
    `, [tenantId]);
    expect(sweep.rows.map((row) => `${row.table_name}=${row.bad}`)).toEqual([
      'browser_tasks=0',
      'browser_task_steps=0',
      'browser_sessions=0',
      'browser_task_events=0',
      'browser_task_idempotency=0',
      'observations=0',
    ]);
    // The recorded action trace of the secret step names the FIELD,
    // redacted — never the value.
    const secretStep = detail.steps.find((step) => step.key === 'type-password')!;
    expect(secretStep.actionTrace).toMatchObject({
      typed: { kind: 'secret-field', field: 'password', redacted: true },
    });
    expect(JSON.stringify(secretStep.actionTrace)).not.toContain('materialized-');
  });

  it('profiles are per task: two tasks of one tenant never share a profile', async () => {
    const tenantId = freshTenant();
    const first = await createLoginTask(tenantId, fakeCredentialRef('a'));
    const second = await createLoginTask(tenantId, fakeCredentialRef('b'));
    await startBrowserTask(member(tenantId), { taskId: first.task.id });
    await startBrowserTask(member(tenantId), { taskId: second.task.id });
    const profiles = driver.sessionStarts.map((start) => start.profileKey);
    expect(profiles).toHaveLength(2);
    expect(new Set(profiles).size).toBe(2);
    for (const profileKey of profiles) {
      expect(profileKey).toContain(`tenant:${tenantId}:task:`);
    }
  });
});

// ---------------------------------------------------------------------------
// Disposable and resumable
// ---------------------------------------------------------------------------

describe('W093 — disposable and resumable', () => {
  function threeStepPlan(): BrowserStepInput[] {
    return [
      {
        key: 'open',
        action: { verb: 'goto', url: LOGIN_URL },
        expectation: { url: LOGIN_URL, title: 'Vendor portal' },
      },
      {
        key: 'fill',
        action: { verb: 'type', url: LOGIN_URL, selector: '#username', value: 'ops@acme.example' },
        expectation: { '#username': 'ops@acme.example' },
      },
      {
        key: 'enter-app',
        action: { verb: 'goto', url: APP_URL },
        expectation: { url: APP_URL, title: 'Dashboard' },
      },
    ];
  }

  it('a transient driver failure parks the task resumable; a fresh session retries only the open step', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Fill the vendor form' },
      allowlist: ALLOWLIST,
      steps: threeStepPlan(),
    });
    driver.failStepOnceKey('fill');

    const first = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(first.task.status).toBe('failed');
    // The checkpoint: step 1 stands verified; step 2 carries the
    // transient receipt; step 3 was never attempted.
    expect(first.steps.map((step) => [step.key, step.state])).toEqual([
      ['open', 'verified'],
      ['fill', 'failed'],
      ['enter-app', 'pending'],
    ]);
    expect(first.steps[1]!.receiptStatus).toBe('failed');
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({ status: 'failed', sequence: 1 });

    // The failure evidence bundle is actionable.
    const evidence = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(evidence).not.toBeNull();
    expect(evidence!.failureKind).toBe('step-failed');
    expect(evidence!.step!.key).toBe('fill');
    expect(evidence!.step!.receiptStatus).toBe('failed');
    expect(evidence!.reason).toContain('resumable');

    // RESUME: a fresh disposable session continues from the checkpoint.
    const second = await resumeBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(second.task.status).toBe('completed');
    expect(second.steps.map((step) => step.state)).toEqual([
      'verified',
      'verified',
      'verified',
    ]);
    expect(second.sessions).toHaveLength(2);
    expect(second.sessions[1]).toMatchObject({ status: 'completed', sequence: 2 });

    // EXACTLY-ONCE at the driver: 'open' performed exactly once across
    // BOTH sessions; 'fill' performed twice (the failed attempt + the
    // retry), and the retry reuses the SAME idempotency key — a honoring
    // driver never double-executes an accepted action.
    const performedKeys = driver.performRequests.map((request) => request.stepKey);
    expect(performedKeys).toEqual(['open', 'fill', 'fill', 'enter-app']);
    const idempotencyKeys = driver.performRequests.map((request) => request.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(3);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[2]);
    // Step 1's evidence link survives the resume untouched.
    expect(second.steps[0]!.observedStateObservationId).toBe(
      first.steps[0]!.observedStateObservationId,
    );
  });

  it('a driver crash (worker death) suspends the task; the fresh session resumes from the checkpoint', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Fill the vendor form' },
      allowlist: ALLOWLIST,
      steps: threeStepPlan(),
    });
    driver.crashOnStep.add('fill');

    const first = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(first.task.status).toBe('suspended');
    // The step keeps NO verdict (the driver died mid-action); the
    // verified checkpoint stands.
    expect(first.steps.map((step) => step.state)).toEqual([
      'verified',
      'pending',
      'pending',
    ]);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({ status: 'interrupted', sequence: 1 });
    expect(first.sessions[0]!.endReason).toContain('simulated browser worker death');

    // The interruption bundle says exactly what to do next.
    const evidence = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(evidence!.failureKind).toBe('interrupted');
    expect(evidence!.reason).toContain('resumable');

    // Worker death never loses the task: a fresh session resumes and
    // completes, without re-executing the verified step. The crashed
    // attempt and its retry share the SAME idempotency key (the
    // crash-between-accept-and-record discipline).
    driver.crashOnStep.delete('fill');
    const second = await resumeBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(second.task.status).toBe('completed');
    expect(second.sessions.map((session) => [session.sequence, session.status])).toEqual([
      [1, 'interrupted'],
      [2, 'completed'],
    ]);
    const performedKeys = driver.performRequests.map((request) => request.stepKey);
    expect(performedKeys).toEqual(['open', 'fill', 'fill', 'enter-app']);
    const idempotencyKeys = driver.performRequests.map((request) => request.idempotencyKey);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[2]);
  });
});

// ---------------------------------------------------------------------------
// Verified before result
// ---------------------------------------------------------------------------

describe('W093 — observed state is verified before being treated as a result', () => {
  it('an accepted action whose observed state diverges is mismatched — evidence and attention, never a result', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Accept the price list' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: APP_URL },
          expectation: { url: APP_URL, title: 'Dashboard' },
        },
        {
          key: 'confirm',
          action: { verb: 'click', url: APP_URL, selector: '#accept' },
          // The expected shape the page must land in…
          expectation: { status: 'confirmed', acceptedBy: 'ops@acme.example' },
        },
        {
          key: 'after',
          action: { verb: 'read', url: APP_URL, selector: '#status' },
          expectation: { status: 'confirmed' },
        },
      ],
    });
    // …and the scripted divergence: the page says 'pending'.
    driver.divergeSteps.set('confirm', { status: 'pending' });

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('mismatched');
    expect(detail.task.mismatchCount).toBe(1);
    // The diverging step is 'mismatched' — NOT verified; the plan never
    // advanced past it (the third step was never attempted).
    expect(detail.steps.map((step) => [step.key, step.state])).toEqual([
      ['open', 'verified'],
      ['confirm', 'mismatched'],
      ['after', 'pending'],
    ]);
    const mismatched = detail.steps[1]!;
    expect(mismatched.receiptStatus).toBe('accepted'); // the action WAS accepted…
    expect(mismatched.verifiedAt).toBeNull(); // …but never verified

    // The mismatch evidence observation carries the W084-shape diff
    // (absence is JSON-encoded as null).
    const evidenceObservation = await getObservation(
      member(tenantId),
      mismatched.mismatchEvidenceObservationId!,
    );
    expect(evidenceObservation.kind).toBe('computer-use.verification-mismatch');
    expect((evidenceObservation.payload as { mismatches: unknown[] }).mismatches).toEqual([
      { path: 'status', expected: 'confirmed', actual: 'pending' },
      { path: 'acceptedBy', expected: 'ops@acme.example', actual: null },
    ]);
    // The attention unknown (lock 7) is linked and readable.
    const unknown = await getUnknown(member(tenantId), { unknownId: mismatched.mismatchUnknownId! });
    expect(unknown.status).toBe('open');
    expect(unknown.question).toContain("step 'confirm'");
    expect(unknown.relatedObservationIds).toHaveLength(2);

    // The failure bundle recomputes the SAME diff from stored state.
    const bundle = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(bundle!.failureKind).toBe('mismatch');
    expect(bundle!.step!.mismatches).toEqual([
      { path: 'status', expected: 'confirmed', actual: 'pending' },
      { path: 'acceptedBy', expected: 'ops@acme.example', actual: null },
    ]);
    expect(bundle!.step!.screenshotRef).toMatch(/^computer-use-screenshot:\/\//);
    expect(bundle!.reason).toContain("'status'");

    // 'mismatched' is terminal: a changed plan is a NEW task.
    await expectError('task_not_pending_phase', () =>
      resumeBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
  });

  it('the stale-page divergence: accepted, nothing moved, flagged in the evidence', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Accept the price list' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: APP_URL },
          expectation: { url: APP_URL, title: 'Dashboard' },
        },
        {
          key: 'confirm',
          action: { verb: 'click', url: APP_URL, selector: '#accept' },
          expectation: { url: APP_URL, title: 'Dashboard', status: 'confirmed' },
        },
      ],
    });
    driver.staleStateOnStep.add('confirm');

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('mismatched');
    const bundle = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(bundle!.failureKind).toBe('mismatch');
    expect(bundle!.step!.stateUnchanged).toBe(true);
    expect(bundle!.reason).toContain('the page never moved');
  });

  it('an unseeded page (found:false) cannot match an expectation — divergence evidence', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the void' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'void',
          action: { verb: 'goto', url: 'https://vendor.example/void' },
          expectation: { title: 'Something' },
        },
      ],
    });
    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('mismatched');
    expect(detail.steps[0]!.observedState).toEqual({ found: false, state: null });
  });
});

// ---------------------------------------------------------------------------
// Governed automation: the allowlist, refusals, provider objects
// ---------------------------------------------------------------------------

describe('W093 — governed automation', () => {
  it('the service-side allowlist blocks a non-conforming step with the decision as evidence (defense in depth)', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the portal' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
      ],
    });
    // Corrupt the frozen plan directly at the storage layer: the only
    // way a non-conforming step can exist (creation validates the plan).
    // This is exactly what the dispatch-time check defends against.
    await getDb().query(
      `UPDATE browser_task_steps SET action = jsonb_set(action, '{url}', '"https://evil.example/steal"')
         WHERE tenant_id = $1 AND task_id = $2 AND step_key = 'open'`,
      [tenantId, created.task.id],
    );

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('aborted');
    expect(detail.task.abortReason).toContain('blocked by the governed allowlist');
    const step = detail.steps[0]!;
    expect(step.state).toBe('blocked');
    expect(step.allowlistDecision).toMatchObject({ allowed: false });
    expect((step.allowlistDecision as { reason?: string }).reason).toContain(
      'matches no allowlist glob',
    );
    // The driver NEVER saw the blocked action.
    expect(driver.performRequests).toHaveLength(0);

    // The bundle carries the decision.
    const bundle = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(bundle!.failureKind).toBe('blocked');
    expect(bundle!.step!.allowlistDecision).toMatchObject({ allowed: false });

    // 'aborted' is terminal.
    await expectError('task_not_pending_phase', () =>
      resumeBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
  });

  it('a permanent driver refusal aborts with the receipt as evidence', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the portal' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
      ],
    });
    driver.refuseStep.add('open');

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('aborted');
    expect(detail.steps[0]!.state).toBe('refused');
    expect(detail.steps[0]!.receiptStatus).toBe('rejected');
    expect(detail.steps[0]!.receiptDetail).toContain('refuses this action');
    const bundle = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(bundle!.failureKind).toBe('refused');
    expect(bundle!.step!.receiptStatus).toBe('rejected');
  });

  it('provider objects never cross the boundary — and the run parks resumable, never fakes success', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the portal' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
      ],
    });

    // A driver that returns a provider receipt object (a class instance).
    class ProviderReceipt {
      constructor(public readonly native: string) {}
    }
    const providerDriver: BrowserDriver = {
      async startSession() {
        return { sessionKey: 'provider-session' };
      },
      async performAction() {
        return {
          receipt: new ProviderReceipt('provider-receipt-handle'),
          observedState: { found: true, state: {} },
          screenshotRef: null,
          actionTrace: null,
        } as unknown as computerUse.BrowserActionResult;
      },
      async endSession() {},
    };
    setBrowserDriver(providerDriver);
    const error = await expectError('invalid_driver_result', () =>
      startBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
    expect(error.message).toContain('provider objects never cross the boundary');
    // The run parked resumable — a wiring fix resumes it.
    const parked = await getBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(parked.task.status).toBe('suspended');
    expect(parked.sessions[0]).toMatchObject({ status: 'interrupted' });

    // An ACCEPTED action without its observed state is refused the same
    // way — an unobserved action is never a result.
    const unobservedDriver: BrowserDriver = {
      async startSession() {
        return { sessionKey: 'unobserved-session' };
      },
      async performAction() {
        return {
          receipt: { status: 'accepted', receiptId: 'r-1', detail: null },
          observedState: null,
          screenshotRef: null,
          actionTrace: null,
        };
      },
      async endSession() {},
    };
    setBrowserDriver(unobservedDriver);
    const created2 = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the portal again' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
      ],
    });
    await expectError('invalid_driver_result', () =>
      startBrowserTask(member(tenantId), { taskId: created2.task.id }),
    );

    // The wired scripted driver resumes the parked task to completion.
    setBrowserDriver(driver);
    const resumed = await resumeBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(resumed.task.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// The edge browser adapter binding (contract-level alignment, W088)
// ---------------------------------------------------------------------------

describe('W093 — the edge approved-browser-adapter surface binds to the driver port', () => {
  it('a W088 browser connectivity adapter serves as the fallback driver through a thin shape adapter', async () => {
    const tenantId = freshTenant();
    const credentialRef = fakeCredentialRef('edge-vendor');

    // The W088 double (connectivity 'browser'), seeded with a page state.
    const edgeBrowser: EdgeConnectivityAdapter = createBrowserDouble({
      states: {
        'https://edge-vendor.example/app': { title: 'Edge vendor app' },
      },
    });

    // The thin shape adapter — THE BINDING. The receipt taxonomy is the
    // W084/W088 vocabulary VERBATIM; the observed state is the
    // {found, state} pair VERBATIM; the OPAQUE credential reference
    // passes straight through for LOCAL edge-side resolution.
    const composed: EdgeAdapterRequest[] = [];
    const bound: BrowserDriver = {
      async startSession(request) {
        return { sessionKey: `edge:${request.profileKey}` };
      },
      async performAction(request) {
        const executeRequest: EdgeAdapterRequest = {
          connectivity: 'browser',
          kind: 'execute',
          capabilityKey: 'browser.action',
          target: request.action.url,
          payload: {
            verb: request.action.verb,
            url: request.action.url,
            selector: request.action.selector ?? null,
            value: request.action.value ?? null,
          },
          secretRef: credentialRef,
          secretScopes: [],
        };
        composed.push(executeRequest);
        const executed: EdgeAdapterResult = await edgeBrowser.execute(executeRequest);
        if (executed.receipt.status !== 'accepted') {
          return {
            receipt: executed.receipt,
            observedState: null,
            screenshotRef: null,
            actionTrace: null,
          };
        }
        const inspected = await edgeBrowser.inspect({
          connectivity: 'browser',
          kind: 'inspect',
          capabilityKey: 'browser.action',
          target: request.action.url,
          payload: null,
          secretRef: credentialRef,
          secretScopes: [],
        });
        return {
          receipt: executed.receipt,
          observedState: inspected.state,
          screenshotRef: null,
          actionTrace: {
            verb: request.action.verb,
            url: request.action.url,
            via: 'edge-approved-browser-adapter',
          },
        };
      },
      async endSession() {},
    };
    setBrowserDriver(bound);

    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Read the edge-hosted price page' },
      allowlist: { urlGlobs: ['https://edge-vendor.example/*'], verbs: ['goto', 'type'] },
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: 'https://edge-vendor.example/app' },
          expectation: { title: 'Edge vendor app' },
        },
        {
          key: 'annotate',
          action: {
            verb: 'type',
            url: 'https://edge-vendor.example/app',
            selector: '#note',
            value: 'reviewed',
          },
          expectation: { title: 'Edge vendor app', value: 'reviewed' },
        },
      ],
      credentialRef,
    });

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('completed');
    expect(detail.steps.map((step) => step.state)).toEqual(['verified', 'verified']);
    // The OPAQUE reference rode the edge envelope (W082 discipline),
    // and the connectivity kind is the approved browser surface.
    expect(composed).toHaveLength(2);
    for (const request of composed) {
      expect(request.connectivity).toBe('browser');
      expect(request.secretRef).toBe(credentialRef);
    }
  });
});

// ---------------------------------------------------------------------------
// State discipline
// ---------------------------------------------------------------------------

describe('W093 — state discipline', () => {
  it('creation refuses an allowlist-violating plan, a secret step without a reference, and enforces the budget', async () => {
    const tenantId = freshTenant();
    await expectError('invalid_input', () =>
      createBrowserTask(member(tenantId), {
        taskContext: { description: 'Evil plan' },
        allowlist: ALLOWLIST,
        steps: [
          {
            key: 'exfil',
            action: { verb: 'goto', url: 'https://evil.example/steal' },
            expectation: { title: 'Data' },
          },
        ],
      }),
    );
    await expectError('invalid_input', () =>
      createBrowserTask(member(tenantId), {
        taskContext: { description: 'Secret without a ref' },
        allowlist: ALLOWLIST,
        steps: [
          {
            key: 'pw',
            action: {
              verb: 'type',
              url: LOGIN_URL,
              selector: '#password',
              secretField: 'password',
            },
            expectation: { url: LOGIN_URL },
          },
        ],
      }),
    );
    await expectError('invalid_input', () =>
      createBrowserTask(member(tenantId), {
        taskContext: { description: 'Too many steps' },
        allowlist: ALLOWLIST,
        steps: Array.from({ length: 33 }, (_, index) => ({
          key: `s-${index}`,
          action: { verb: 'read' as const, url: APP_URL, selector: '#a' },
          expectation: { ok: true },
        })),
      }),
    );
  });

  it('phase calls out of order, unknown tasks, and a missing driver are loud', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the portal' },
      allowlist: ALLOWLIST,
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
      ],
    });
    // resume before start
    await expectError('task_not_pending_phase', () =>
      resumeBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
    // unknown task — uniformly not-found (no existence leak)
    await expectError('task_not_found', () =>
      getBrowserTask(member(tenantId), { taskId: newId() }),
    );
    await expectError('task_not_found', () =>
      startBrowserTask(member(tenantId), { taskId: newId() }),
    );
    await expectError('task_not_found', () =>
      listBrowserTaskEvents(member(tenantId), { taskId: newId() }),
    );
    // no driver wired
    setBrowserDriver(null);
    await expectError('driver_unavailable', () =>
      startBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
    setBrowserDriver(driver);
    // completed task: start/resume refuse
    const done = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(done.task.status).toBe('completed');
    await expectError('task_not_pending_phase', () =>
      startBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
    await expectError('task_not_pending_phase', () =>
      resumeBrowserTask(member(tenantId), { taskId: created.task.id }),
    );
  });

  it('an idempotent create replays the original task; listings filter per status', async () => {
    const tenantId = freshTenant();
    const ctx = member(tenantId);
    const key = 'w093-replay-1';
    const first = await createBrowserTask(ctx, {
      taskContext: { description: 'Replay me' },
      allowlist: ALLOWLIST,
      steps: loginFlowSteps(),
      credentialRef: fakeCredentialRef('replay'),
      idempotencyKey: key,
    });
    const second = await createBrowserTask(ctx, {
      taskContext: { description: 'Replay me' },
      allowlist: ALLOWLIST,
      steps: loginFlowSteps(),
      credentialRef: fakeCredentialRef('replay'),
      idempotencyKey: key,
    });
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);

    await startBrowserTask(ctx, { taskId: first.task.id });
    const all = await listBrowserTasks(ctx, {});
    expect(all).toHaveLength(1);
    const completed = await listBrowserTasks(ctx, { status: 'completed' });
    expect(completed).toHaveLength(1);
    const draft = await listBrowserTasks(ctx, { status: 'draft' });
    expect(draft).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (compact — the W044 sweep carries the full proof)
// ---------------------------------------------------------------------------

describe('W093 — tenant isolation', () => {
  it("one tenant's tasks, evidence and phases are invisible to the other", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const credentialRef = fakeCredentialRef('iso');
    const { task } = await createLoginTask(tenantA, credentialRef);
    await startBrowserTask(member(tenantA), { taskId: task.id });

    await expectError('task_not_found', () =>
      getBrowserTask(member(tenantB), { taskId: task.id }),
    );
    await expectError('task_not_found', () =>
      startBrowserTask(member(tenantB), { taskId: task.id }),
    );
    await expectError('task_not_found', () =>
      resumeBrowserTask(member(tenantB), { taskId: task.id }),
    );
    await expectError('task_not_found', () =>
      getBrowserFailureEvidence(member(tenantB), { taskId: task.id }),
    );
    await expectError('task_not_found', () =>
      listBrowserTaskEvents(member(tenantB), { taskId: task.id }),
    );
    expect(await listBrowserTasks(member(tenantB), {})).toHaveLength(0);
    expect((await listBrowserTasks(member(tenantA), {}))[0]!.id).toBe(task.id);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('W093 — storage discipline', () => {
  it('the events ledger is append-only (UPDATE/DELETE/TRUNCATE refused at the storage level)', async () => {
    const tenantId = freshTenant();
    const { task } = await createLoginTask(tenantId, fakeCredentialRef('storage'));
    await startBrowserTask(member(tenantId), { taskId: task.id });
    const rows = await getDb().query<{ id: string } & DbRow>(
      `SELECT id FROM browser_task_events WHERE tenant_id = $1 AND task_id = $2 LIMIT 1`,
      [tenantId, task.id],
    );
    const eventId = rows.rows[0]!.id;
    await expect(
      getDb().query(`UPDATE browser_task_events SET detail = 'tampered' WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM browser_task_events WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE browser_task_events`)).rejects.toThrow(/append-only/);
  });
});
