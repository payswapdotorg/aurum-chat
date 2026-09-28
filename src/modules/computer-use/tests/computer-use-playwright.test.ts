// Unit tests of the REAL Playwright browser driver adapter (W110) — the
// vendor-shape layer: the adapter's own semantics (the driver-side
// allowlist copy, credential isolation + redaction, idempotency, the
// driver-level outcome mapping, canonical result shapes) verified
// against the INJECTED DETERMINISTIC FAKE of the Playwright surface the
// adapter drives (tests/playwright-fake.ts) — NO real browser, NO
// network (the fixtures/doubles doctrine; the real-browser execution
// itself is recorded under docs/productization-evidence/W110/).

delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { describe, expect, it } from 'vitest';
import {
  canonicalSelectorKey,
  createPlaywrightBrowserDriver,
  type PlaywrightBrowserDriver,
} from '../adapters/playwright-driver';
import type { BrowserActionResult, BrowserAllowlist, BrowserVerb } from '../contract';
import {
  fakeField,
  fakeLauncher,
  fakeVendorPortalSite,
  MemoryArtifactStore,
  MemoryProfileStore,
  staticCredentialSource,
} from './playwright-fake';

// ---------------------------------------------------------------------------
// The shared fixture
// ---------------------------------------------------------------------------

const LOGIN_URL = 'https://vendor.example/login';
const APP_URL = 'https://vendor.example/app';
const ALLOWLIST: BrowserAllowlist = {
  urlGlobs: ['https://vendor.example/*'],
  verbs: ['goto', 'type', 'click', 'read', 'submit'] as BrowserVerb[],
};
const PROFILE_KEY = 'computer-use:tenant:T1:task:K1';
const CREDENTIAL_REF = ['secret-store://', 'w110-unit/', 'vendor'].join('');
const SECRET_VALUE = ['w110-unit-', 'materialized-', 'secret-fragment'].join('');

interface Fixture {
  driver: PlaywrightBrowserDriver;
  artifacts: MemoryArtifactStore;
  profiles: MemoryProfileStore;
  sessionKey: string;
}

async function fixture(options: { withCredentials?: boolean } = {}): Promise<Fixture> {
  const site = fakeVendorPortalSite();
  const artifacts = new MemoryArtifactStore();
  const profiles = new MemoryProfileStore();
  const withCredentials = options.withCredentials !== false;
  const driver = createPlaywrightBrowserDriver({
    launcher: fakeLauncher(site),
    credentials: staticCredentialSource(
      withCredentials
        ? { [CREDENTIAL_REF]: { username: 'w110-unit-user', password: SECRET_VALUE } }
        : {},
    ),
    artifacts,
    profiles,
  });
  const started = await driver.startSession({
    taskId: 'task-1',
    profileKey: PROFILE_KEY,
    credentialRef: withCredentials ? CREDENTIAL_REF : null,
    allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
  });
  return { driver, artifacts, profiles, sessionKey: started.sessionKey };
}

function perform(
  f: Fixture,
  overrides: Partial<{
    stepKey: string;
    idempotencyKey: string;
    verb: BrowserVerb;
    url: string;
    selector: string | null;
    value: string | null;
    secretField: string | null;
  }> = {},
): Promise<BrowserActionResult> {
  return f.driver.performAction({
    sessionKey: f.sessionKey,
    taskId: 'task-1',
    stepKey: overrides.stepKey ?? 'step-1',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    action: {
      verb: overrides.verb ?? 'goto',
      url: overrides.url ?? LOGIN_URL,
      selector: overrides.selector ?? null,
      value: overrides.value ?? null,
      secretField: overrides.secretField ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// The adapter's own semantics (the vendor-shape layer)
// ---------------------------------------------------------------------------

describe('the real Playwright browser driver adapter (injected deterministic vendor double)', () => {
  it('satisfies the port: an opaque session key, canonical plain-JSON results, observed state, screenshot and trace', async () => {
    const f = await fixture();
    expect(f.sessionKey).toMatch(/^playwright-session-\d{4}$/);

    const result = await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    expect(result.receipt).toEqual({
      status: 'accepted',
      receiptId: expect.stringMatching(/^playwright-rcpt-\d{4}$/),
      detail: null,
    });
    expect(result.observedState).toEqual({
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
    expect(result.screenshotRef).toMatch(/^computer-use-playwright:\/\/screenshot\/[0-9a-f]{16}$/);
    expect(result.actionTrace).toMatchObject({
      verb: 'goto',
      url: LOGIN_URL,
      selector: null,
      typed: null,
      navigated: { from: 'about:blank', to: LOGIN_URL },
      screenshot: { ref: result.screenshotRef, sha256: expect.any(String), bytes: expect.any(Number) },
      domSnapshot: { ref: expect.any(String), sha256: expect.any(String), bytes: expect.any(Number) },
    });
    // The artifact bytes ARE in the store, and the sha256 in the trace proves them.
    expect(result.screenshotRef).not.toBeNull();
    const shotRef: string = result.screenshotRef!;
    const shot = f.artifacts.records.find((record) => record.ref === shotRef);
    expect(shot).toBeDefined();
    expect(shot!.bytes).toBe(f.artifacts.blobs.get(shotRef)!.byteLength);
    // Provider objects never cross: the result is plain JSON end-to-end.
    const roundTrip = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTrip).toEqual(result);
    expect(Object.getPrototypeOf(result.receipt)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.observedState)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.actionTrace)).toBe(Object.prototype);
  });

  it('the driver-side allowlist copy refuses non-conforming URLs permanently (twice-checked, no bypass)', async () => {
    const f = await fixture();
    const blocked = await perform(f, {
      stepKey: 'evil',
      idempotencyKey: 'k-evil',
      verb: 'goto',
      url: 'https://evil.example/steal',
    });
    expect(blocked.receipt).toMatchObject({ status: 'rejected' });
    expect(blocked.receipt.detail).toContain('blocked by the driver-side allowlist copy');
    expect(blocked.receipt.detail).toContain('matches none of');
    expect(blocked.observedState).toBeNull();
    // The vendor layer NEVER saw it: no navigation was attempted.
    expect(f.driver.performRequests).toHaveLength(1);
    expect(f.driver.browserExecutions.size).toBe(0);
  });

  it('the driver-side allowlist copy refuses verbs the session copy does not permit', async () => {
    const f = await fixture();
    const restricted = await f.driver.startSession({
      taskId: 'task-1',
      profileKey: PROFILE_KEY,
      credentialRef: null,
      allowlist: { urlGlobs: ['https://vendor.example/*'], verbs: ['goto', 'read'] },
    });
    const refused = await f.driver.performAction({
      sessionKey: restricted.sessionKey,
      taskId: 'task-1',
      stepKey: 'forbidden-click',
      idempotencyKey: 'k-forbidden-click',
      action: { verb: 'click', url: LOGIN_URL, selector: '#submit' },
    });
    expect(refused.receipt).toMatchObject({ status: 'rejected' });
    expect(refused.receipt.detail).toContain(
      "blocked by the driver-side allowlist copy: the verb 'click' is not permitted",
    );
  });

  it('typing a secret materializes it INSIDE the profile, fills the page, and observes only the redaction marker', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    const typed = await perform(f, {
      stepKey: 'pw',
      idempotencyKey: 'k-pw',
      verb: 'type',
      selector: '#password',
      secretField: 'password',
    });
    expect(typed.receipt.status).toBe('accepted');
    // The trace records the FIELD, redacted — never the value.
    expect(typed.actionTrace).toMatchObject({
      typed: { kind: 'secret-field', field: 'password', redacted: true },
    });
    // The observed state carries the redaction marker (the double's format).
    expect((typed.observedState!.state as Record<string, unknown>)['#password']).toBe(
      `<redacted secret field 'password'>`,
    );
    // The materialized value exists ONLY inside the profile (driver-side)…
    expect(f.driver.materializedValueOf(PROFILE_KEY, 'password')).toBe(SECRET_VALUE);
    expect(f.driver.typedSecretFields.get(PROFILE_KEY)).toEqual(new Set(['password']));
    // …and nothing the adapter returned ever echoes it:
    expect(JSON.stringify(typed)).not.toContain(SECRET_VALUE);
  });

  it('an unresolvable credential field is a PERMANENT refusal (the double semantics verbatim)', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    const unresolved = await perform(f, {
      stepKey: 'token',
      idempotencyKey: 'k-token',
      verb: 'type',
      selector: '#username',
      secretField: 'apiToken',
    });
    expect(unresolved.receipt).toMatchObject({ status: 'rejected' });
    expect(unresolved.receipt.detail).toContain(
      "the credential field 'apiToken' was not materialized in the isolated profile",
    );
  });

  it('a literal typed into a password-type input is never echoed back (redaction independent of secret typing)', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    const typed = await perform(f, {
      stepKey: 'pin',
      idempotencyKey: 'k-pin',
      verb: 'type',
      selector: '#password',
      value: 'plain-literal-pin-value',
    });
    expect(typed.receipt.status).toBe('accepted');
    expect(typed.actionTrace).toMatchObject({ typed: { kind: 'literal', length: 23 } });
    expect((typed.observedState!.state as Record<string, unknown>)['#password']).toBe(
      '<redacted password input>',
    );
    expect(JSON.stringify(typed)).not.toContain('plain-literal-pin-value');
  });

  it('honoring idempotency: an accepted action replays its memoized result without touching the browser again', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    const first = await perform(f, {
      stepKey: 'user',
      idempotencyKey: 'k-user',
      verb: 'type',
      selector: '#username',
      value: 'ops@acme.example',
    });
    const replay = await perform(f, {
      stepKey: 'user',
      idempotencyKey: 'k-user',
      verb: 'type',
      selector: '#username',
      value: 'ops@acme.example',
    });
    expect(replay).toBe(first); // the very same memoized result object
    expect(f.driver.browserExecutions.get('user')).toBe(1); // exactly-once at the vendor layer
  });

  it('driver-level outcome mapping: a network failure is TRANSIENT (receipt failed, resumable)', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    // An unseeded URL behaves exactly like a dead network (net error).
    const transient = await perform(f, {
      stepKey: 'app',
      idempotencyKey: 'k-app',
      verb: 'goto',
      url: 'https://vendor.example/unreachable',
    });
    expect(transient.receipt).toMatchObject({ status: 'failed' });
    expect(transient.receipt.detail).toContain('transient — a fresh session may succeed');
    expect(transient.observedState).toBeNull();
    // A transient failure is not memoized — a retry may succeed.
    const retried = await perform(f, {
      stepKey: 'app',
      idempotencyKey: 'k-app-2',
      verb: 'goto',
      url: LOGIN_URL,
    });
    expect(retried.receipt.status).toBe('accepted');
  });

  it('strict-mode violation: an ambiguous selector is a PERMANENT refusal (the plan is defective, not the network)', async () => {
    // Built directly: a site whose login page carries two fields sharing
    // one name — fill() then resolves to two elements.
    const site = fakeVendorPortalSite();
    site.pages.get(LOGIN_URL)!.fields.push(fakeField('[name="shared"]'));
    site.pages.get(LOGIN_URL)!.fields.push(fakeField('[name="shared"]'));
    const artifacts = new MemoryArtifactStore();
    const driver = createPlaywrightBrowserDriver({
      launcher: fakeLauncher(site),
      credentials: staticCredentialSource({}),
      artifacts,
      profiles: new MemoryProfileStore(),
    });
    const started = await driver.startSession({
      taskId: 'task-1',
      profileKey: PROFILE_KEY,
      credentialRef: null,
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
    });
    await driver.performAction({
      sessionKey: started.sessionKey,
      taskId: 'task-1',
      stepKey: 'open',
      idempotencyKey: 'k-open',
      action: { verb: 'goto', url: LOGIN_URL },
    });
    const ambiguous = await driver.performAction({
      sessionKey: started.sessionKey,
      taskId: 'task-1',
      stepKey: 'shared',
      idempotencyKey: 'k-shared',
      action: { verb: 'type', url: LOGIN_URL, selector: '[name="shared"]', value: 'x' },
    });
    expect(ambiguous.receipt).toMatchObject({ status: 'rejected' });
    expect(ambiguous.receipt.detail).toContain("the plan's selector is ambiguous");
  });

  it('submit drives the form: the collected form is submitted, the navigation lands, the target page is observed', async () => {
    const site = fakeVendorPortalSite();
    const artifacts = new MemoryArtifactStore();
    const driver = createPlaywrightBrowserDriver({
      launcher: fakeLauncher(site),
      credentials: staticCredentialSource({}),
      artifacts,
      profiles: new MemoryProfileStore(),
    });
    const started = await driver.startSession({
      taskId: 'task-1',
      profileKey: PROFILE_KEY,
      credentialRef: null,
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
    });
    const call = (
      stepKey: string,
      idempotencyKey: string,
      action: Parameters<typeof driver.performAction>[0]['action'],
    ) =>
      driver.performAction({
        sessionKey: started.sessionKey,
        taskId: 'task-1',
        stepKey,
        idempotencyKey,
        action,
      });
    await call('open', 'k-open', { verb: 'goto', url: LOGIN_URL });
    await call('user', 'k-user', { verb: 'type', url: LOGIN_URL, selector: '#username', value: 'ops@acme.example' });
    await call('pw', 'k-pw', { verb: 'type', url: LOGIN_URL, selector: '#password', secretField: 'password' });
    const submitted = await call('go', 'k-go', { verb: 'submit', url: LOGIN_URL, selector: '#submit' });
    expect(submitted.receipt.status).toBe('accepted');
    expect(submitted.observedState).toMatchObject({
      found: true,
      state: { url: APP_URL, title: 'Dashboard', '[name="loggedIn"]': 'true' },
    });
    // The fake site recorded the submit — WITHOUT the password field
    // (the fake's form collection skips password-type inputs).
    expect(site.submits).toHaveLength(1);
    expect(site.submits[0]!.target).toBe(APP_URL);
    expect(site.submits[0]!.form['#username']).toBe('ops@acme.example');
    expect(Object.keys(site.submits[0]!.form)).not.toContain('#password');
  });

  it('a click applies the site effect and the observed state proves it (verified observed state, not trust)', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    await perform(f, { stepKey: 'go', idempotencyKey: 'k-go', verb: 'submit', selector: '#submit' });
    const clicked = await perform(f, {
      stepKey: 'refresh',
      idempotencyKey: 'k-refresh',
      verb: 'click',
      url: APP_URL,
      selector: '#refresh',
    });
    expect(clicked.receipt.status).toBe('accepted');
    expect((clicked.observedState!.state as Record<string, unknown>)['[name="tick"]']).toBe(
      'refreshed',
    );
  });

  it('non-goto verbs navigate to the action URL first when the page differs (navigated is recorded)', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    const typed = await perform(f, {
      stepKey: 'app-field',
      idempotencyKey: 'k-app-field',
      verb: 'type',
      url: APP_URL,
      selector: '[name="tick"]',
      value: 'typed-on-app',
    });
    expect(typed.receipt.status).toBe('accepted');
    expect(typed.actionTrace).toMatchObject({
      navigated: { from: LOGIN_URL, to: APP_URL },
    });
    expect((typed.observedState!.state as Record<string, unknown>)['[name="tick"]']).toBe(
      'typed-on-app',
    );
  });

  it('a closed session refuses further actions and the profile continuity is persisted (disposable sessions)', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    await f.driver.endSession({ sessionKey: f.sessionKey, reason: 'completed', detail: null });
    await expect(perform(f, { stepKey: 'after', idempotencyKey: 'k-after' })).rejects.toThrow(
      /is not live/,
    );
    // The profile continuity was persisted for the next fresh session.
    expect(f.profiles.states.has(PROFILE_KEY)).toBe(true);
  });

  it('profile continuity + isolation: a fresh session on the SAME profile materializes its own reference; another profile stays clean', async () => {
    const f = await fixture();
    await perform(f, { stepKey: 'open', idempotencyKey: 'k-open' });
    await f.driver.endSession({ sessionKey: f.sessionKey, reason: 'completed', detail: null });
    const persisted = f.profiles.states.get(PROFILE_KEY);
    expect(persisted).toBeDefined();

    const resumed = await f.driver.startSession({
      taskId: 'task-1',
      profileKey: PROFILE_KEY,
      credentialRef: CREDENTIAL_REF,
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
    });
    const other = await f.driver.startSession({
      taskId: 'task-2',
      profileKey: 'computer-use:tenant:T1:task:K2',
      credentialRef: null,
      allowlist: { urlGlobs: [...ALLOWLIST.urlGlobs], verbs: [...ALLOWLIST.verbs] },
    });
    expect(resumed.sessionKey).not.toBe(f.sessionKey);
    expect(other.sessionKey).not.toBe(resumed.sessionKey);
    // Credential materialization is per-profile and isolated.
    expect(f.driver.materializedValueOf(PROFILE_KEY, 'password')).toBe(SECRET_VALUE);
    expect(f.driver.materializedValueOf('computer-use:tenant:T1:task:K2', 'password')).toBeUndefined();
  });

  it('canonicalSelectorKey normalizes plan selector spellings to the observation keys', () => {
    expect(canonicalSelectorKey('#username')).toBe('#username');
    expect(canonicalSelectorKey('[name=username]')).toBe('[name="username"]');
    expect(canonicalSelectorKey('[name="username"]')).toBe('[name="username"]');
    expect(canonicalSelectorKey("[name='username']")).toBe('[name="username"]');
    expect(canonicalSelectorKey('input[name="username"]')).toBe('input[name="username"]');
  });
});
