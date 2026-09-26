// Unit tests for the computer-use module's PURE logic (no database, no
// clock, no network): validation/normalization, the allowlist glob
// matcher, the W084-aligned verification language, and the deterministic
// browser driver double's own semantics (the fixture's contract).

import { describe, expect, it } from 'vitest';
import {
  allowlistDecisionFor,
  validateAction,
  validateAllowlist,
  validateCreateBrowserTaskInput,
  validateStepInput,
} from '../validation';
import {
  buildBrowserMismatchReason,
  describeVerification,
  globToRegExp,
  urlMatchesGlob,
} from '../verify';
import {
  createScriptedBrowserDriver,
  type ScriptedBrowserDriver,
} from '../double';
import { ComputerUseError } from '../errors';
import { reconcileOperation, type BrowserVerb } from '../contract';

// ---------------------------------------------------------------------------
// The allowlist (governed automation's surface)
// ---------------------------------------------------------------------------

describe('the governed allowlist', () => {
  it('accepts a well-formed URL-glob + verb-subset surface', () => {
    const valid = validateAllowlist(
      { urlGlobs: ['https://vendor.example.com/app/*'], verbs: ['goto', 'type', 'read'] },
      'allowlist',
    );
    expect(valid.urlGlobs).toEqual(['https://vendor.example.com/app/*']);
    expect(valid.verbs).toEqual(['goto', 'type', 'read']);
  });

  it('refuses an empty glob set, an empty verb set, unknown verbs, duplicates and non-URL globs', () => {
    const cases: unknown[] = [
      { urlGlobs: [], verbs: ['goto'] },
      { urlGlobs: ['https://a.example/'], verbs: [] },
      { urlGlobs: ['https://a.example/'], verbs: ['goto', 'goto'] },
      { urlGlobs: ['https://a.example/'], verbs: ['goto', 'evaluate'] },
      { urlGlobs: ['https://a.example/', 'https://a.example/'], verbs: ['goto'] },
      { urlGlobs: ['not-a-url'], verbs: ['goto'] },
      { urlGlobs: ['https://a.example/ with space'], verbs: ['goto'] },
      { urlGlobs: ['file:///etc/passwd'], verbs: ['goto'] },
    ];
    for (const input of cases) {
      expect(() => validateAllowlist(input, 'allowlist')).toThrow(ComputerUseError);
    }
  });

  it('the glob matcher: * spans path segments, everything else is literal', () => {
    expect(urlMatchesGlob('https://a.example/app/x/y', 'https://a.example/app/*')).toBe(true);
    expect(urlMatchesGlob('https://a.example/app', 'https://a.example/app/*')).toBe(false);
    expect(urlMatchesGlob('https://a.example/app', 'https://a.example/app')).toBe(true);
    expect(urlMatchesGlob('https://b.example/app', 'https://a.example/*')).toBe(false);
    expect(urlMatchesGlob('https://a.example.evil/app', 'https://a.example/*')).toBe(false);
    // The compiled glob is anchored on both ends (no partial matches).
    const compiled = globToRegExp('https://a.example/app/*');
    expect(compiled.test('xhttps://a.example/app/y')).toBe(false);
    expect(compiled.test('https://a.example/app/y/z')).toBe(true);
    expect(compiled.test('https://a.example/app')).toBe(false);
  });

  it('the decision is the same computation everywhere (allowed and refused shapes)', () => {
    const allowlist = {
      urlGlobs: ['https://vendor.example/*'],
      verbs: ['goto', 'read'] as BrowserVerb[],
    };
    const allowed = allowlistDecisionFor(allowlist, {
      verb: 'goto',
      url: 'https://vendor.example/login',
    });
    expect(allowed).toMatchObject({
      allowed: true,
      matchedGlob: 'https://vendor.example/*',
      verb: 'goto',
    });
    const urlRefused = allowlistDecisionFor(allowlist, {
      verb: 'goto',
      url: 'https://other.example/login',
    });
    expect(urlRefused.allowed).toBe(false);
    expect(urlRefused.reason).toContain('matches no allowlist glob');
    const verbRefused = allowlistDecisionFor(allowlist, {
      verb: 'click',
      url: 'https://vendor.example/login',
    });
    expect(verbRefused.allowed).toBe(false);
    expect(verbRefused.reason).toContain("the verb 'click' is not permitted");
  });
});

// ---------------------------------------------------------------------------
// The canonical action envelope (per-verb shape rules)
// ---------------------------------------------------------------------------

describe('the canonical action envelope', () => {
  it('accepts each well-formed verb shape', () => {
    expect(
      validateAction({ verb: 'goto', url: 'https://a.example/' }, 'action'),
    ).toMatchObject({ verb: 'goto', url: 'https://a.example/', selector: null, value: null, secretField: null });
    expect(
      validateAction(
        { verb: 'click', url: 'https://a.example/', selector: '#submit' },
        'action',
      ),
    ).toMatchObject({ verb: 'click', selector: '#submit' });
    expect(
      validateAction(
        { verb: 'type', url: 'https://a.example/', selector: '#q', value: 'hello' },
        'action',
      ),
    ).toMatchObject({ verb: 'type', value: 'hello', secretField: null });
    expect(
      validateAction(
        { verb: 'type', url: 'https://a.example/', selector: '#pw', secretField: 'password' },
        'action',
      ),
    ).toMatchObject({ verb: 'type', value: null, secretField: 'password' });
  });

  it('refuses the ungoverned shapes (no free-form driving by construction)', () => {
    const cases: unknown[] = [
      { verb: 'evaluate', url: 'https://a.example/' }, // not a governed verb
      { verb: 'goto', url: 'not-a-url' }, // not an absolute URL
      { verb: 'goto', url: 'https://a.example/', selector: '#x' }, // goto selects nothing
      { verb: 'click', url: 'https://a.example/' }, // click needs a selector
      { verb: 'click', url: 'https://a.example/', value: 'x' }, // only type carries a value
      { verb: 'type', url: 'https://a.example/', selector: '#q' }, // type needs value OR secretField
      {
        verb: 'type',
        url: 'https://a.example/',
        selector: '#q',
        value: 'x',
        secretField: 'password',
      }, // literal and secret are mutually exclusive
      { verb: 'submit', url: 'https://a.example/', secretField: 'password' },
    ];
    for (const input of cases) {
      expect(() => validateAction(input, 'action')).toThrow(ComputerUseError);
    }
  });

  it('a step needs a non-empty expectation — an unverifiable step is not governed', () => {
    expect(() =>
      validateStepInput(
        {
          key: 'open',
          action: { verb: 'goto', url: 'https://a.example/' },
          expectation: {},
        },
        'step',
      ),
    ).toThrow(/unverifiable step is not a governed step/);
  });
});

// ---------------------------------------------------------------------------
// createBrowserTask validation (the plan is allowlist-conformant at creation)
// ---------------------------------------------------------------------------

describe('createBrowserTask validation', () => {
  const base = {
    taskContext: { description: 'File the vendor invoice' },
    allowlist: { urlGlobs: ['https://vendor.example/*'], verbs: ['goto', 'type', 'read'] },
    steps: [
      {
        key: 'open-login',
        action: { verb: 'goto', url: 'https://vendor.example/login' },
        expectation: { title: 'Vendor portal' },
      },
    ],
  };

  it('accepts a conformant plan', () => {
    const valid = validateCreateBrowserTaskInput(base);
    expect(valid.steps).toHaveLength(1);
    expect(valid.credentialRef).toBeNull();
  });

  it('refuses a plan whose steps violate the allowlist — governed automation starts at planning time', () => {
    expect(() =>
      validateCreateBrowserTaskInput({
        ...base,
        steps: [
          ...base.steps,
          {
            key: 'open-competitor',
            action: { verb: 'goto', url: 'https://competitor.example/pricing' },
            expectation: { title: 'Pricing' },
          },
        ],
      }),
    ).toThrow(/violates the allowlist/);
  });

  it('refuses a secret-field step without a credential reference', () => {
    expect(() =>
      validateCreateBrowserTaskInput({
        ...base,
        steps: [
          {
            key: 'type-password',
            action: {
              verb: 'type',
              url: 'https://vendor.example/login',
              selector: '#password',
              secretField: 'password',
            },
            expectation: { url: 'https://vendor.example/login' },
          },
        ],
      }),
    ).toThrow(/credentialRef.*is required/);
  });

  it('refuses more than the step budget', () => {
    expect(() =>
      validateCreateBrowserTaskInput({
        ...base,
        steps: Array.from({ length: 33 }, (_, index) => ({
          key: `step-${index}`,
          action: { verb: 'read', url: 'https://vendor.example/x', selector: '#a' },
          expectation: { ok: true },
        })),
      }),
    ).toThrow(/step budget/);
  });

  it('refuses unknown keys, duplicate step keys and empty plans', () => {
    expect(() => validateCreateBrowserTaskInput({ ...base, extra: 1 })).toThrow(
      /unknown field/,
    );
    expect(() =>
      validateCreateBrowserTaskInput({
        ...base,
        steps: [...base.steps, { ...base.steps[0] }],
      }),
    ).toThrow(/duplicate step key/);
    expect(() => validateCreateBrowserTaskInput({ ...base, steps: [] })).toThrow(
      /at least one thing/,
    );
  });
});

// ---------------------------------------------------------------------------
// The verification language (W084 shapes, browser-flavored)
// ---------------------------------------------------------------------------

describe('the verification language', () => {
  it('the module re-uses the deep-actions reconciliation verbatim (no second model)', () => {
    const verdict = reconcileOperation(
      { title: 'Dashboard', balance: 100 },
      { title: 'Dashboard', balance: 90, extra: true },
      null,
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.mismatches).toEqual([
      { path: 'balance', expected: 100, actual: 90 },
    ]);
    expect(verdict.stateUnchanged).toBe(false);
  });

  it('the mismatch reason names the task, the step, the divergent paths and the stale-page flag', () => {
    const reason = buildBrowserMismatchReason({
      taskDescription: 'File the vendor invoice',
      stepKey: 'confirm',
      url: 'https://vendor.example/confirm',
      mismatches: [{ path: 'status', expected: 'confirmed', actual: 'pending' }],
      stateUnchanged: true,
    });
    expect(reason).toContain('File the vendor invoice');
    expect(reason).toContain("step 'confirm'");
    expect(reason).toContain("'status' (expected \"confirmed\", observed \"pending\")");
    expect(reason).toContain('the page never moved');
    expect(describeVerification({ matched: false, mismatches: [{ path: 'status', expected: 1, actual: 2 }], stateUnchanged: false })).toContain(
      'diverged',
    );
  });
});

// ---------------------------------------------------------------------------
// The deterministic driver double (the fixture's own contract)
// ---------------------------------------------------------------------------

describe('the scripted browser driver double', () => {
  function driverWithSite(): ScriptedBrowserDriver {
    return createScriptedBrowserDriver({
      pages: {
        'https://vendor.example/login': {
          title: 'Vendor portal',
          fields: { heading: 'Sign in' },
        },
        'https://vendor.example/app': {
          title: 'Dashboard',
          fields: { loggedIn: true },
        },
      },
    });
  }

  const allowlist = {
    urlGlobs: ['https://vendor.example/*'],
    verbs: ['goto', 'type', 'read', 'click'] as BrowserVerb[],
  };

  it('a goto observes the seeded page; an unseeded URL observes found:false', async () => {
    const driver = driverWithSite();
    const session = await driver.startSession({
      taskId: 't-1',
      profileKey: 'p-1',
      credentialRef: null,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    const good = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'open',
      idempotencyKey: 'k1',
      action: { verb: 'goto', url: 'https://vendor.example/login' },
    });
    expect(good.receipt.status).toBe('accepted');
    expect(good.observedState).toEqual({
      found: true,
      state: { url: 'https://vendor.example/login', title: 'Vendor portal', heading: 'Sign in' },
    });
    expect(good.screenshotRef).toMatch(/^computer-use-screenshot:\/\//);

    const missing = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'open-missing',
      idempotencyKey: 'k2',
      action: { verb: 'goto', url: 'https://vendor.example/void' },
    });
    expect(missing.observedState).toEqual({ found: false, state: null });
  });

  it('typing a secret materializes it INSIDE the profile and observes only a redaction', async () => {
    const driver = driverWithSite();
    const credentialRef = ['secret-store://', 'w093-unit/', 'vendor'].join('');
    const session = await driver.startSession({
      taskId: 't-1',
      profileKey: 'computer-use:tenant:T1:task:K1',
      credentialRef,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'open',
      idempotencyKey: 'k1',
      action: { verb: 'goto', url: 'https://vendor.example/login' },
    });
    const typed = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'pw',
      idempotencyKey: 'k2',
      action: {
        verb: 'type',
        url: 'https://vendor.example/login',
        selector: '#password',
        secretField: 'password',
      },
    });
    // The trace records the FIELD, redacted — never the value.
    expect(typed.actionTrace).toMatchObject({
      typed: { kind: 'secret-field', field: 'password', redacted: true },
    });
    expect(JSON.stringify(typed)).not.toContain('materialized-secret');
    // The materialized value exists ONLY inside the profile (fixture proof).
    expect(
      driver.materializedValueOf('computer-use:tenant:T1:task:K1', 'password'),
    ).toContain('materialized-');
    expect(driver.typedSecretFields.get('computer-use:tenant:T1:task:K1')).toEqual(
      new Set(['password']),
    );
  });

  it('profiles are isolated: a second profile materializes its own reference, never the first', async () => {
    const driver = driverWithSite();
    const refA = ['secret-store://', 'w093-unit/', 'a'].join('');
    const refB = ['secret-store://', 'w093-unit/', 'b'].join('');
    const sessionA = await driver.startSession({
      taskId: 'task-a',
      profileKey: 'computer-use:tenant:T1:task:A',
      credentialRef: refA,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    const sessionB = await driver.startSession({
      taskId: 'task-b',
      profileKey: 'computer-use:tenant:T1:task:B',
      credentialRef: refB,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    expect(sessionB.sessionKey).not.toBe(sessionA.sessionKey);
    expect(driver.materializedRefs.get('computer-use:tenant:T1:task:A')).toBe(refA);
    expect(driver.materializedRefs.get('computer-use:tenant:T1:task:B')).toBe(refB);
    expect(
      driver.materializedValueOf('computer-use:tenant:T1:task:A', 'password'),
    ).not.toBe(driver.materializedValueOf('computer-use:tenant:T1:task:B', 'password'));
    // A fresh session on the SAME profile resumes on the profile's page.
    await driver.performAction({
      sessionKey: sessionA.sessionKey,
      taskId: 'task-a',
      stepKey: 'open',
      idempotencyKey: 'k1',
      action: { verb: 'goto', url: 'https://vendor.example/app' },
    });
    const resumed = await driver.startSession({
      taskId: 'task-a',
      profileKey: 'computer-use:tenant:T1:task:A',
      credentialRef: refA,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    const observed = await driver.performAction({
      sessionKey: resumed.sessionKey,
      taskId: 'task-a',
      stepKey: 'read',
      idempotencyKey: 'k2',
      action: { verb: 'read', url: 'https://vendor.example/app', selector: '#a' },
    });
    expect(observed.observedState).toMatchObject({
      found: true,
      state: { url: 'https://vendor.example/app' },
    });
  });

  it('the driver-side allowlist copy refuses non-conforming actions permanently (twice-checked)', async () => {
    const driver = driverWithSite();
    const session = await driver.startSession({
      taskId: 't-1',
      profileKey: 'p-1',
      credentialRef: null,
      allowlist: { urlGlobs: ['https://vendor.example/*'], verbs: ['goto'] },
    });
    const refused = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'blocked-click',
      idempotencyKey: 'k1',
      action: { verb: 'click', url: 'https://vendor.example/login', selector: '#go' },
    });
    expect(refused.receipt).toMatchObject({ status: 'rejected' });
    expect(refused.receipt.detail).toContain('driver-side allowlist');
  });

  it('scriptable failure modes: transient failure, permanent refusal, crash, divergence, stale state', async () => {
    const driver = driverWithSite();
    driver.failStepOnceKey('flaky');
    driver.refuseStep.add('refused');
    driver.crashOnStep.add('crash');
    driver.divergeSteps.set('diverged', { status: 'pending' });
    driver.staleStateOnStep.add('stale');
    const session = await driver.startSession({
      taskId: 't-1',
      profileKey: 'p-1',
      credentialRef: null,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    const open = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'open',
      idempotencyKey: 'k-open',
      action: { verb: 'goto', url: 'https://vendor.example/login' },
    });
    expect(open.receipt.status).toBe('accepted');

    const flaky = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'flaky',
      idempotencyKey: 'k-flaky',
      action: { verb: 'read', url: 'https://vendor.example/login', selector: '#a' },
    });
    expect(flaky.receipt).toMatchObject({ status: 'failed' });
    // A transient failure is NOT memoized — the retry can succeed.
    const retry = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'flaky',
      idempotencyKey: 'k-flaky-2',
      action: { verb: 'read', url: 'https://vendor.example/login', selector: '#a' },
    });
    expect(retry.receipt.status).toBe('accepted');

    const refused = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'refused',
      idempotencyKey: 'k-refused',
      action: { verb: 'read', url: 'https://vendor.example/login', selector: '#a' },
    });
    expect(refused.receipt).toMatchObject({ status: 'rejected' });

    await expect(
      driver.performAction({
        sessionKey: session.sessionKey,
        taskId: 't-1',
        stepKey: 'crash',
        idempotencyKey: 'k-crash',
        action: { verb: 'read', url: 'https://vendor.example/login', selector: '#a' },
      }),
    ).rejects.toThrow(/simulated browser worker death/);
    expect(driver.crashedSteps).toEqual(['crash']);

    const diverged = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'diverged',
      idempotencyKey: 'k-diverged',
      action: { verb: 'read', url: 'https://vendor.example/login', selector: '#a' },
    });
    expect(diverged.observedState).toMatchObject({ state: { status: 'pending' } });

    const beforeStale = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'before-stale',
      idempotencyKey: 'k-before-stale',
      action: { verb: 'goto', url: 'https://vendor.example/app' },
    });
    const stale = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'stale',
      idempotencyKey: 'k-stale',
      action: { verb: 'goto', url: 'https://vendor.example/login' },
    });
    // The stale divergence: the observed state is the PREVIOUS step's.
    expect(stale.observedState).toEqual(beforeStale.observedState);
  });

  it('honoring idempotency: an accepted action replays its result, never a second effect', async () => {
    const driver = driverWithSite();
    const session = await driver.startSession({
      taskId: 't-1',
      profileKey: 'p-1',
      credentialRef: null,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    const first = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'open',
      idempotencyKey: 'same-key',
      action: { verb: 'goto', url: 'https://vendor.example/login' },
    });
    const replay = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'open',
      idempotencyKey: 'same-key',
      action: { verb: 'goto', url: 'https://vendor.example/login' },
    });
    expect(replay).toEqual(first);
    expect(driver.performRequests).toHaveLength(2); // both calls recorded…
    // …but only ONE page mutation happened: the typed field is set once.
    await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'type',
      idempotencyKey: 'k-type',
      action: { verb: 'type', url: 'https://vendor.example/login', selector: '#q', value: 'x' },
    });
    const observed = await driver.performAction({
      sessionKey: session.sessionKey,
      taskId: 't-1',
      stepKey: 'read',
      idempotencyKey: 'k-read',
      action: { verb: 'read', url: 'https://vendor.example/login', selector: '#q' },
    });
    expect((observed.observedState!.state as { '#q': string })['#q']).toBe('x');
  });

  it('a closed session refuses further actions (sessions are disposable)', async () => {
    const driver = driverWithSite();
    const session = await driver.startSession({
      taskId: 't-1',
      profileKey: 'p-1',
      credentialRef: null,
      allowlist: { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] },
    });
    await driver.endSession({ sessionKey: session.sessionKey, reason: 'completed', detail: null });
    await expect(
      driver.performAction({
        sessionKey: session.sessionKey,
        taskId: 't-1',
        stepKey: 'late',
        idempotencyKey: 'k-late',
        action: { verb: 'goto', url: 'https://vendor.example/login' },
      }),
    ).rejects.toThrow(/not live/);
  });
});
