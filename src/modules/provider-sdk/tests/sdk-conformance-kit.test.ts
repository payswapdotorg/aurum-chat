// Self-test of the provider-sdk conformance test kit (W089): proves the kit
// itself works by building example adapters PURELY from the template
// (createProviderAdapterDefinition + canonical types — the "a third adapter
// should be creatable from the kit alone" property), running the generated
// checks directly, and verifying the kit CATCHES non-conformance.

import { describe, expect, it } from 'vitest';
import {
  buildHotSwapEvidence,
  collectAdapterConformanceChecks,
  createProviderAdapterDefinition,
  defineAdapterConformanceSuite,
  type AdapterConformanceSubject,
  type ConformanceCheck,
  type ConformanceFramework,
} from '../contract';

// ---------------------------------------------------------------------------
// Example adapters built purely from the kit (no gateway module involved)
// ---------------------------------------------------------------------------

const alpha = createProviderAdapterDefinition({
  gateway: 'example-gateway',
  provider: 'alpha',
  capabilities: ['greet', 'echo'],
  classifyError: (error) => {
    if (error instanceof Error && error.message === 'ALPHA_AUTH') return 'auth_failure';
    return null;
  },
});

const beta = createProviderAdapterDefinition({
  gateway: 'example-gateway',
  provider: 'beta',
  capabilities: ['greet'],
});

function evidenceFor(subject: 'alpha' | 'beta'): ReturnType<typeof buildHotSwapEvidence> {
  // A peer swap: whichever provider is under test appears as one target.
  const a = { provider: 'alpha', target: 'v1', resultKind: 'completed' as const };
  const b = { provider: 'beta', target: 'v2', resultKind: 'completed' as const };
  return buildHotSwapEvidence({
    gateway: 'example-gateway',
    capability: 'greet',
    providerA: subject === 'alpha' ? a : b,
    providerB: subject === 'alpha' ? b : a,
    outcome: 'equivalent',
    evidenceId: '0192f0a1-0000-7000-8000-0000000000aa',
    executedAt: '2026-09-23T12:00:00.000Z',
    requestDigest: 'a'.repeat(64),
  });
}

const alphaSubject: AdapterConformanceSubject = {
  definition: alpha,
  gateway: 'example-gateway',
  errorSpecimens: [
    { description: 'provider auth rejection', error: new Error('ALPHA_AUTH'), expectedCategory: 'auth_failure' },
    { description: 'throttle response', error: { status: 429 }, expectedCategory: 'rate_limited', expectedRetryable: true },
    { description: 'connection refused', error: { code: 'ECONNREFUSED' }, expectedCategory: 'provider_unavailable' },
  ],
  expectedCapabilities: ['echo', 'greet'],
  hotSwapEvidence: () => evidenceFor('alpha'),
};

const betaSubject: AdapterConformanceSubject = {
  definition: beta,
  gateway: 'example-gateway',
  errorSpecimens: [
    { description: 'timeout', error: new Error('request timed out'), expectedCategory: 'timeout' },
  ],
  expectedCapabilities: ['greet'],
  hotSwapEvidence: () => evidenceFor('beta'),
};

/** Run every check of a subject; returns the checks that threw. */
async function runChecks(subject: AdapterConformanceSubject): Promise<ConformanceCheck[]> {
  const failures: ConformanceCheck[] = [];
  for (const check of collectAdapterConformanceChecks(subject)) {
    try {
      await check.run();
    } catch {
      failures.push(check);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// The kit passes conforming adapters
// ---------------------------------------------------------------------------

describe('provider-sdk conformance kit — conforming adapters pass every check', () => {
  it('generates the full check families', () => {
    const ids = collectAdapterConformanceChecks(alphaSubject).map((check) => check.id);
    expect(ids).toContain('definition/shape');
    expect(ids).toContain('definition/gateway');
    expect(ids).toContain('capabilities/well-formed');
    expect(ids).toContain('capabilities/deterministic');
    expect(ids).toContain('capabilities/expected');
    expect(ids).toContain('lifecycle/canonical-flow');
    expect(ids).toContain('lifecycle/illegal-transitions');
    expect(ids).toContain('lifecycle/retire-terminal');
    expect(ids.filter((id) => id.startsWith('normalization/specimen-'))).toHaveLength(3);
    expect(ids).toContain('normalization/unknown-fallback');
    expect(ids).toContain('normalization/semantics-table');
    expect(ids).toContain('hot-swap/evidence');
  });

  it('passes the fully-specified alpha adapter (third adapter from the kit alone)', async () => {
    expect(await runChecks(alphaSubject)).toEqual([]);
  });

  it('passes the minimal beta adapter (conformance scales down gracefully)', async () => {
    expect(await runChecks(betaSubject)).toEqual([]);
  });

  it('suite factory registers one describe with one test per check', () => {
    const registered: Array<{ name: string; tests: string[] }> = [];
    let current: string[] | null = null;
    const framework: ConformanceFramework = {
      describe: (name, fn) => {
        const tests: string[] = [];
        registered.push({ name, tests });
        current = tests;
        fn();
        current = null;
      },
      it: (name, _fn) => {
        current!.push(name);
      },
    };
    defineAdapterConformanceSuite(alphaSubject, framework);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe('provider-sdk conformance — example-gateway/alpha');
    expect(registered[0]!.tests.length).toBe(collectAdapterConformanceChecks(alphaSubject).length);
    expect(registered[0]!.tests[0]).toContain('example-gateway/alpha');
  });
});

// ---------------------------------------------------------------------------
// The kit catches non-conformance
// ---------------------------------------------------------------------------

describe('provider-sdk conformance kit — non-conformance is caught', () => {
  it('catches a wrong sdk tag / stale version', async () => {
    const stale = {
      ...alphaSubject,
      definition: { ...alpha, sdk: 'not-the-definition' as never, sdkVersion: '0.0.1' },
    };
    const failures = await runChecks(stale);
    expect(failures.map((c) => c.id)).toContain('definition/shape');
  });

  it('catches a gateway mismatch', async () => {
    const wrongGateway = { ...alphaSubject, gateway: 'some-other-gateway' };
    const failures = await runChecks(wrongGateway);
    expect(failures.map((c) => c.id)).toContain('definition/gateway');
  });

  it('catches capability declarations that miss the gateway expectation', async () => {
    const wrongCapabilities = { ...alphaSubject, expectedCapabilities: ['greet'] };
    const failures = await runChecks(wrongCapabilities);
    expect(failures.map((c) => c.id)).toContain('capabilities/expected');
  });

  it('catches a misclassified error specimen', async () => {
    const misclassified: AdapterConformanceSubject = {
      ...alphaSubject,
      errorSpecimens: [
        { description: 'claims timeout but is auth', error: new Error('ALPHA_AUTH'), expectedCategory: 'timeout' },
      ],
    };
    const failures = await runChecks(misclassified);
    expect(failures.map((c) => c.id)).toContain('normalization/specimen-1');
  });

  it('catches a crashing mapError', async () => {
    const crashing = {
      ...alphaSubject,
      definition: { ...alpha, mapError: () => { throw new Error('boom'); } },
    };
    const failures = await runChecks(crashing);
    expect(failures.map((c) => c.id)).toContain('normalization/specimen-1');
    expect(failures.map((c) => c.id)).toContain('normalization/unknown-fallback');
  });

  it('catches non-deterministic capability reporting', async () => {
    let flip = false;
    const flaky = {
      ...alphaSubject,
      definition: {
        ...alpha,
        describeCapabilities: () => {
          flip = !flip;
          return flip
            ? { sdk: 'provider-capability-set' as const, gateway: 'example-gateway', provider: 'alpha', capabilities: ['greet', 'echo'] }
            : { sdk: 'provider-capability-set' as const, gateway: 'example-gateway', provider: 'alpha', capabilities: ['greet'] };
        },
      },
    };
    const failures = await runChecks(flaky);
    expect(failures.map((c) => c.id)).toContain('capabilities/deterministic');
    expect(failures.map((c) => c.id)).toContain('capabilities/expected');
  });

  it('catches invalid hot-swap evidence', async () => {
    const badEvidence = {
      ...alphaSubject,
      hotSwapEvidence: () =>
        buildHotSwapEvidence({
          gateway: 'example-gateway',
          capability: 'greet',
          providerA: { provider: 'alpha', target: 'v1', resultKind: 'completed' },
          providerB: { provider: 'beta', target: 'v2', resultKind: 'completed' },
          outcome: 'equivalent',
          evidenceId: 'x',
          executedAt: '2026-09-23T12:00:00.000Z',
          requestDigest: 'a'.repeat(64),
        }),
    };
    // This evidence is valid — swap in a tampered copy to prove detection.
    const tampered = {
      ...badEvidence,
      hotSwapEvidence: () => ({ ...badEvidence.hotSwapEvidence!(), outcome: 'probably-fine' as never }),
    };
    const failures = await runChecks(tampered);
    expect(failures.map((c) => c.id)).toContain('hot-swap/evidence');
    // A swap that does not involve the provider under test must also fail.
    const notInvolved = {
      ...alphaSubject,
      hotSwapEvidence: () =>
        buildHotSwapEvidence({
          gateway: 'example-gateway',
          capability: 'greet',
          providerA: { provider: 'beta', target: 'v1', resultKind: 'completed' },
          providerB: { provider: 'gamma', target: 'v2', resultKind: 'completed' },
          outcome: 'equivalent',
          evidenceId: 'y',
          executedAt: '2026-09-23T12:00:00.000Z',
          requestDigest: 'b'.repeat(64),
        }),
    };
    const failures2 = await runChecks(notInvolved);
    expect(failures2.map((c) => c.id)).toContain('hot-swap/evidence');
  });

  it('catches an illegal custom lifecycle flow', async () => {
    const impossible = { ...alphaSubject, lifecycleFlow: ['activate', 'verify'] as const };
    const failures = await runChecks(impossible);
    expect(failures.map((c) => c.id)).toContain('lifecycle/canonical-flow');
  });
});

// ---------------------------------------------------------------------------
// The template factory itself
// ---------------------------------------------------------------------------

describe('provider-sdk conformance kit — the definition factory rejects malformed descriptors', () => {
  it('rejects bad keys and capability lists', () => {
    expect(() => createProviderAdapterDefinition({ gateway: '', provider: 'x', capabilities: ['a'] })).toThrowError(
      /gateway/,
    );
    expect(() => createProviderAdapterDefinition({ gateway: 'llm', provider: 'Not_Kebab', capabilities: ['a'] })).toThrowError(
      /kebab/,
    );
    expect(() => createProviderAdapterDefinition({ gateway: 'llm', provider: 'x', capabilities: [] })).toThrowError(
      /at least one capability/,
    );
    expect(() => createProviderAdapterDefinition({ gateway: 'llm', provider: 'x', capabilities: ['a', 'a'] })).toThrowError(
      /duplicate/,
    );
    expect(() => createProviderAdapterDefinition({ gateway: 'llm', provider: 'x', capabilities: [''] })).toThrowError(
      /non-empty/,
    );
    expect(() => createProviderAdapterDefinition({ gateway: 'llm', provider: 'x', capabilities: ['a'] })).not.toThrow();
  });

  it('stamps the current SDK version and freezes the capability set', () => {
    const definition = createProviderAdapterDefinition({ gateway: 'g', provider: 'p', capabilities: ['a', 'b'] });
    expect(definition.sdk).toBe('provider-adapter-definition');
    expect(definition.sdkVersion).toBe('1.0.0');
    const set = definition.describeCapabilities();
    expect(set.capabilities).toEqual(['a', 'b']);
    // The same frozen object every call → determinism by construction.
    expect(definition.describeCapabilities()).toBe(set);
  });

  it('never selects providers (no selection surface on the definition)', () => {
    const definition = createProviderAdapterDefinition({ gateway: 'g', provider: 'p', capabilities: ['a'] });
    const keys = Object.keys(definition);
    expect(keys).not.toContain('select');
    expect(keys).not.toContain('route');
    expect(keys).not.toContain('choose');
    expect(keys.sort()).toEqual(['describeCapabilities', 'gateway', 'mapError', 'provider', 'sdk', 'sdkVersion']);
  });
});
