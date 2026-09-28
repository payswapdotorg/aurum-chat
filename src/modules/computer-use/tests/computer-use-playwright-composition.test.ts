// Integration tests of the REAL Playwright browser driver adapter (W110)
// composed through the EXISTING W093 lifecycle — the full service
// machinery (frozen plan, creation-time allowlist validation, disposable
// sessions, dispatch-time allowlist re-check, evidence ledger,
// W084 reconciliation, mismatch attention unknowns, failure bundles,
// resume from the durable checkpoint) against the embedded PostgreSQL
// (PGlite, `:memory:`), with the adapter's vendor seam injected with the
// deterministic Playwright-surface double (tests/playwright-fake.ts —
// NO real browser, NO network here; the REAL-browser execution through
// this same lifecycle is recorded under docs/productization-evidence/).
//
// This suite proves the W110 acceptance end-to-end at the composition
// level:
//
//   * a real-adapter-shaped driver carries a governed login task to a
//     fully VERIFIED completion with per-step evidence (screenshots,
//     redacted traces, receipts) — through the UNCHANGED service loop;
//   * credentials stay isolated and opaque (full SQL sweep);
//   * the allowlist is enforced at every existing point (creation,
//     dispatch — and the driver-side copy is proven in the vendor-shape
//     suite);
//   * a transient driver-level failure parks the task resumable and a
//     FRESH session resumes from the checkpoint (verified steps never
//     re-executed — exactly-once at the vendor layer);
//   * an observed-state divergence ends the task 'mismatched' with the
//     existing evidence shape (W084 diff + attention unknown + bundle).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as observationsContract from '@/modules/observations/contract';
import * as computerUse from '../contract';
import { createPlaywrightBrowserDriver, type PlaywrightBrowserDriver } from '../adapters/playwright-driver';
import {
  fakeLauncher,
  fakeVendorPortalSite,
  MemoryArtifactStore,
  MemoryProfileStore,
  staticCredentialSource,
  type FakeSite,
} from './playwright-fake';

const {
  createBrowserTask,
  startBrowserTask,
  resumeBrowserTask,
  getBrowserFailureEvidence,
  listBrowserTaskEvents,
  setBrowserDriver,
  browserProfileKey,
} = computerUse;

const { getObservation } = observationsContract;

function freshTenant(): string {
  return newId();
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

// Fake credentials are assembled from fragments at runtime (never a
// realistic full token literal in source).
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w110-compose/` + `${label}/` + 'ref';
}
const SECRET_VALUE = ['w110-compose-', 'materialized-', 'secret-fragment'].join('');

const LOGIN_URL = 'https://vendor.example/login';
const APP_URL = 'https://vendor.example/app';
const ALLOWLIST = {
  urlGlobs: ['https://vendor.example/*'],
  verbs: ['goto', 'type', 'click', 'read', 'submit'] as const,
};

/** The governed login-flow plan (all five verbs exercised). */
function loginFlowSteps() {
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
      expectation: { url: APP_URL, title: 'Dashboard', heading: 'Dashboard' },
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

interface Harness {
  site: FakeSite;
  driver: PlaywrightBrowserDriver;
  artifacts: MemoryArtifactStore;
  profiles: MemoryProfileStore;
}

function newHarness(): Harness {
  const site = fakeVendorPortalSite();
  const artifacts = new MemoryArtifactStore();
  const profiles = new MemoryProfileStore();
  const credentialRef = fakeCredentialRef('vendor-portal');
  const driver = createPlaywrightBrowserDriver({
    launcher: fakeLauncher(site),
    credentials: staticCredentialSource({
      [credentialRef]: { username: 'w110-compose-user', password: SECRET_VALUE },
    }),
    artifacts,
    profiles,
  });
  setBrowserDriver(driver);
  return { site, driver, artifacts, profiles };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setBrowserDriver(null);
  await closeDb();
});

let harness: Harness;
let harnessCredentialRef: string;

beforeEach(() => {
  harnessCredentialRef = fakeCredentialRef('vendor-portal');
  harness = newHarness();
  // Re-wire with this test's credential ref (the source maps ref → values).
  const driver = createPlaywrightBrowserDriver({
    launcher: fakeLauncher(harness.site),
    credentials: staticCredentialSource({
      [harnessCredentialRef]: { username: 'w110-compose-user', password: SECRET_VALUE },
    }),
    artifacts: harness.artifacts,
    profiles: harness.profiles,
  });
  harness.driver = driver;
  setBrowserDriver(driver);
});

async function createLoginTask(tenantId: string, credentialRef: string) {
  const created = await createBrowserTask(member(tenantId), {
    taskContext: {
      description: 'Accept the Q3 price list in the vendor portal',
      requestedFor: 'Q3 procurement',
    },
    allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
    steps: loginFlowSteps(),
    credentialRef,
  });
  expect(created.created).toBe(true);
  return created;
}

// ---------------------------------------------------------------------------

describe('W110 — the real Playwright adapter through the existing W093 lifecycle', () => {
  it('carries a governed login task to a fully verified completion with per-step evidence (all five verbs)', async () => {
    const tenantId = freshTenant();
    const { task } = await createLoginTask(tenantId, harnessCredentialRef);

    const detail = await startBrowserTask(member(tenantId), { taskId: task.id });
    expect(detail.task.status).toBe('completed');
    expect(detail.task.mismatchCount).toBe(0);
    expect(detail.steps).toHaveLength(6);
    for (const step of detail.steps) {
      expect(step.state).toBe('verified');
      expect(step.observedStateObservationId).not.toBeNull();
      expect(step.observedState).not.toBeNull();
      expect(step.screenshotRef).toMatch(/^computer-use-playwright:\/\/screenshot\/[0-9a-f]{16}$/);
      expect(step.actionTrace).not.toBeNull();
      expect(step.receiptStatus).toBe('accepted');
      expect(step.receiptId).toMatch(/^playwright-rcpt-\d{4}$/);
      expect(step.sessionId).not.toBeNull();
    }
    // The observed state is the adapter's canonical page shape.
    expect(detail.steps[0]!.observedState).toEqual({
      found: true,
      state: {
        url: LOGIN_URL,
        title: 'Vendor portal',
        heading: 'Sign in',
        '#username': '',
        '#password': '<redacted password input>',
        '#submit': '',
      },
    });
    // The click step's observed state PROVES the click's effect.
    expect(
      (detail.steps[5]!.observedState!.state as Record<string, unknown>)['[name="tick"]'],
    ).toBe('refreshed');
    // One disposable session, completed, on the isolated profile key.
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({
      status: 'completed',
      sequence: 1,
      stepsExecuted: 6,
      profileKey: browserProfileKey(tenantId, task.id),
    });
    // Every step reached the vendor layer exactly once.
    for (const step of loginFlowSteps()) {
      expect(harness.driver.browserExecutions.get(step.key)).toBe(1);
    }
    // The observed-state evidence is readable through the W004 contract.
    const observation = await getObservation(
      member(tenantId),
      detail.steps[0]!.observedStateObservationId!,
    );
    expect(observation.kind).toBe('computer-use.observed-state');
    expect(observation.channel).toBe('computer-use');
    expect((observation.payload as { stepKey: string }).stepKey).toBe('open-login');
    expect((observation.payload as { screenshotRef: string }).screenshotRef).toBe(
      detail.steps[0]!.screenshotRef,
    );
    // The audit feed is ordered and complete (the unchanged W093 shape).
    const events = await listBrowserTaskEvents(member(tenantId), { taskId: task.id, limit: 500 });
    const kinds = events.map((event) => event.event).reverse();
    expect(kinds).toEqual([
      'created',
      'started',
      ...Array.from({ length: 6 }, () => ['step-executed', 'step-verified']).flat(),
      'completed',
    ]);
    // The failure bundle of a clean task is null.
    expect(await getBrowserFailureEvidence(member(tenantId), { taskId: task.id })).toBeNull();
  });

  it('session credentials stay isolated and opaque: materialized inside the profile, never persisted anywhere', async () => {
    const tenantId = freshTenant();
    const { task } = await createLoginTask(tenantId, harnessCredentialRef);

    const detail = await startBrowserTask(member(tenantId), { taskId: task.id });
    expect(detail.task.status).toBe('completed');

    // The task row carries ONLY the opaque reference.
    expect(detail.task.credentialRef).toBe(harnessCredentialRef);

    // The driver received the isolated per-(tenant,task) profile key and
    // materialized the reference INSIDE it.
    const profileKey = browserProfileKey(tenantId, task.id);
    expect(harness.driver.sessionStarts).toHaveLength(1);
    expect(harness.driver.sessionStarts[0]).toMatchObject({
      profileKey,
      credentialRef: harnessCredentialRef,
    });
    expect(harness.driver.materializedRefs.get(profileKey)).toBe(harnessCredentialRef);
    expect(harness.driver.typedSecretFields.get(profileKey)).toEqual(new Set(['password']));
    // The materialized value exists driver-side…
    expect(harness.driver.materializedValueOf(profileKey, 'password')).toBe(SECRET_VALUE);

    // …and NEVER persisted: a full sweep over every module table (all
    // columns, jsonb included) plus the module's observations finds no
    // trace of the materialized value.
    const sweep = await getDb().query<{ table_name: string; bad: string }>(`
      SELECT 'browser_tasks' AS table_name, count(*)::text AS bad FROM browser_tasks WHERE to_jsonb(browser_tasks)::text LIKE '%${'w110-compose-materialized'}%'
      UNION ALL SELECT 'browser_task_steps', count(*)::text FROM browser_task_steps WHERE to_jsonb(browser_task_steps)::text LIKE '%${'w110-compose-materialized'}%'
      UNION ALL SELECT 'browser_sessions', count(*)::text FROM browser_sessions WHERE to_jsonb(browser_sessions)::text LIKE '%${'w110-compose-materialized'}%'
      UNION ALL SELECT 'browser_task_events', count(*)::text FROM browser_task_events WHERE to_jsonb(browser_task_events)::text LIKE '%${'w110-compose-materialized'}%'
      UNION ALL SELECT 'browser_task_idempotency', count(*)::text FROM browser_task_idempotency WHERE to_jsonb(browser_task_idempotency)::text LIKE '%${'w110-compose-materialized'}%'
      UNION ALL SELECT 'observations', count(*)::text FROM observations WHERE tenant_id = $1 AND to_jsonb(observations)::text LIKE '%${'w110-compose-materialized'}%'
    `, [tenantId]);
    expect(sweep.rows.map((row) => `${row.table_name}=${row.bad}`)).toEqual([
      'browser_tasks=0',
      'browser_task_steps=0',
      'browser_sessions=0',
      'browser_task_events=0',
      'browser_task_idempotency=0',
      'observations=0',
    ]);
    // The password step's persisted observed state carries the marker.
    const passwordStep = detail.steps.find((step) => step.key === 'type-password')!;
    expect(
      (passwordStep.observedState!.state as Record<string, unknown>)['#password'],
    ).toBe(`<redacted secret field 'password'>`);
    expect(JSON.stringify(passwordStep.actionTrace)).not.toContain('w110-compose-materialized');
  });

  it('a transient driver-level failure parks the task resumable; a FRESH session resumes from the checkpoint (verified steps never re-executed)', async () => {
    const tenantId = freshTenant();
    const { task } = await createLoginTask(tenantId, harnessCredentialRef);

    // The dashboard navigation fails ONCE at the network level: the
    // login submit's redirect navigation to the app page dies (a real
    // transient the retry in a fresh session can survive).
    harness.site.netFailuresOnce.add(APP_URL);

    const failed = await startBrowserTask(member(tenantId), { taskId: task.id });
    // Steps 1-3 verified; the submit step (whose form redirect navigates
    // to the app page) failed transiently.
    expect(failed.task.status).toBe('failed');
    expect(failed.steps.filter((step) => step.state === 'verified')).toHaveLength(3);
    const submitStep = failed.steps.find((step) => step.key === 'submit-login')!;
    expect(submitStep.state).toBe('failed');
    expect(submitStep.receiptStatus).toBe('failed');
    expect(submitStep.receiptDetail).toContain('transient — a fresh session may succeed');
    expect(failed.sessions).toHaveLength(1);
    expect(failed.sessions[0]!.status).toBe('failed');

    // The failure bundle carries the actionable evidence.
    const bundle = await getBrowserFailureEvidence(member(tenantId), { taskId: task.id });
    expect(bundle!.failureKind).toBe('step-failed');
    expect(bundle!.step!.key).toBe('submit-login');
    expect(bundle!.step!.receiptDetail).toContain('transient');

    // RESUME: a fresh session continues from the checkpoint.
    const dispatchesBefore = harness.driver.performRequests.length;
    const resumed = await resumeBrowserTask(member(tenantId), { taskId: task.id });
    expect(resumed.task.status).toBe('completed');
    expect(resumed.steps.every((step) => step.state === 'verified')).toBe(true);
    expect(resumed.sessions).toHaveLength(2);
    expect(resumed.sessions[1]).toMatchObject({ status: 'completed', sequence: 2, stepsExecuted: 3 });

    // Verified steps were NEVER re-dispatched: only the failed submit
    // step and the not-yet-reached read/click steps crossed the port again.
    const newDispatches = harness.driver.performRequests.slice(dispatchesBefore);
    expect(newDispatches.map((request) => request.stepKey)).toEqual([
      'submit-login',
      'read-dashboard',
      'refresh',
    ]);
    // And at the vendor layer: every step executed exactly once in total.
    for (const step of loginFlowSteps()) {
      expect(harness.driver.browserExecutions.get(step.key)).toBe(1);
    }
  });

  it('the service-side allowlist blocks a corrupted step with the decision as evidence — the driver NEVER sees it (defense in depth)', async () => {
    const tenantId = freshTenant();
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the portal' },
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
      steps: [
        {
          key: 'open',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
      ],
      credentialRef: null,
    });
    // Corrupt the frozen plan directly at the storage layer (the only
    // way a non-conforming step can exist — creation validates the plan).
    await getDb().query(
      `UPDATE browser_task_steps SET action = jsonb_set(action, '{url}', '"https://evil.example/steal"')
         WHERE tenant_id = $1 AND task_id = $2 AND step_key = 'open'`,
      [tenantId, created.task.id],
    );

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('aborted');
    expect(detail.task.abortReason).toContain('blocked by the governed allowlist');
    expect(detail.steps[0]!.state).toBe('blocked');
    expect(detail.steps[0]!.allowlistDecision).toMatchObject({ allowed: false });
    // The driver NEVER saw the blocked action.
    expect(harness.driver.performRequests).toHaveLength(0);
    const bundle = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(bundle!.failureKind).toBe('blocked');
  });

  it('an observed-state divergence ends the task mismatched with the EXISTING evidence shape (W084 diff + attention unknown + bundle)', async () => {
    const tenantId = freshTenant();
    // The plan promises a dashboard that is not what the site serves.
    const created = await createBrowserTask(member(tenantId), {
      taskContext: { description: 'Open the vendor dashboard' },
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
      steps: [
        {
          key: 'open-login',
          action: { verb: 'goto', url: LOGIN_URL },
          expectation: { url: LOGIN_URL, title: 'Vendor portal' },
        },
        {
          key: 'submit-login',
          action: { verb: 'submit', url: LOGIN_URL, selector: '#submit' },
          // The divergence: the plan expects a title the page never has.
          expectation: { url: APP_URL, title: 'Totally different page' },
        },
      ],
      credentialRef: null,
    });

    const detail = await startBrowserTask(member(tenantId), { taskId: created.task.id });
    expect(detail.task.status).toBe('mismatched');
    expect(detail.task.mismatchCount).toBe(1);
    const mismatched = detail.steps.find((step) => step.key === 'submit-login')!;
    expect(mismatched.state).toBe('mismatched');
    expect(mismatched.mismatchEvidenceObservationId).not.toBeNull();
    expect(mismatched.mismatchUnknownId).not.toBeNull();
    // The step's evidence still landed (executed + accepted + observed).
    expect(mismatched.receiptStatus).toBe('accepted');
    expect(mismatched.screenshotRef).toMatch(/^computer-use-playwright:\/\//);
    expect(mismatched.observedState).not.toBeNull();

    // The mismatch evidence observation carries the W084 diff.
    const mismatchObservation = await getObservation(
      member(tenantId),
      mismatched.mismatchEvidenceObservationId!,
    );
    expect(mismatchObservation.kind).toBe('computer-use.verification-mismatch');
    const payload = mismatchObservation.payload as {
      mismatches: Array<{ path: string; expected: unknown; actual: unknown }>;
      reason: string;
    };
    expect(payload.mismatches).toEqual([
      { path: 'title', expected: 'Totally different page', actual: 'Dashboard' },
    ]);
    expect(payload.reason).toContain("step 'submit-login'");

    // The failure bundle recomputes the same diff (reconciliation is a computation).
    const bundle = await getBrowserFailureEvidence(member(tenantId), {
      taskId: created.task.id,
    });
    expect(bundle!.failureKind).toBe('mismatch');
    expect(bundle!.step!.mismatches).toEqual([
      { path: 'title', expected: 'Totally different page', actual: 'Dashboard' },
    ]);
    expect(bundle!.step!.screenshotRef).not.toBeNull();
  });
});
