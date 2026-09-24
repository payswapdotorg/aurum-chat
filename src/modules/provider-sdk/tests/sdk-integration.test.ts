// Integration test for the provider-sdk (W089): ONE template produces TWO
// conforming providers for a representative (example) gateway, exercised
// end to end — full lifecycle, capability discovery, failure-driven
// degradation and recovery through canonical error normalization, hot-swap
// evidence emission, and retirement — with the conformance kit green for
// both providers. This is the in-module acceptance demonstration; the
// repository-level proof is the llm gateway's openai + anthropic adapters
// (see src/modules/llm/tests/llm-adapter-sdk-conformance.test.ts).
//
// The example gateway is deliberately provider-neutral: the "wire
// transport" is a table of scripted outcomes, and provider selection is a
// CALLER decision (the SDK never picks providers — asserted here).

import { describe, expect, it } from 'vitest';
import {
  applyFailureToHealth,
  applySuccessToHealth,
  buildHotSwapEvidence,
  collectAdapterConformanceChecks,
  createProviderAdapterDefinition,
  normalizeProviderError,
  ProviderLifecycleTracker,
  suggestedLifecycleEventForFailure,
  validateHotSwapEvidenceRecord,
  type AdapterConformanceSubject,
  type CanonicalErrorCategory,
} from '../contract';

// ---------------------------------------------------------------------------
// The template applied twice: two example providers of one gateway
// ---------------------------------------------------------------------------

/** Provider-native error shapes (what the wire layer throws). */
class ProviderWireError extends Error {
  constructor(
    readonly wireCode: string,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderWireError';
  }
}

/** The shared classifier both example adapters reuse (per-gateway, not per-provider). */
function classifyExampleGatewayError(error: unknown): CanonicalErrorCategory | null {
  if (error instanceof ProviderWireError) {
    switch (error.wireCode) {
      case 'BAD_KEY': return 'auth_failure';
      case 'NO_SCOPE': return 'permission_denied';
      case 'TOO_FAST': return 'rate_limited';
      case 'UPSTREAM_DOWN': return 'provider_unavailable';
      case 'CANT_DO_THAT': return 'unsupported_capability';
      default: return null;
    }
  }
  return null;
}

const alphaAdapter = createProviderAdapterDefinition({
  gateway: 'example-gateway',
  provider: 'alpha',
  capabilities: ['greet', 'echo'],
  classifyError: classifyExampleGatewayError,
});

const betaAdapter = createProviderAdapterDefinition({
  gateway: 'example-gateway',
  provider: 'beta',
  capabilities: ['greet', 'echo'],
  classifyError: classifyExampleGatewayError,
});

// Two materially different providers of one gateway, both built from the
// same template.

/** A scripted "transport": per-provider outcomes for canonical requests. */
type ScriptedOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'fail'; error: unknown };

class ExampleGatewayRuntime {
  private readonly scripts = new Map<string, ScriptedOutcome[]>();
  readonly interactions: Array<{ provider: string; request: unknown }> = [];

  script(provider: string, outcomes: ScriptedOutcome[]): void {
    this.scripts.set(provider, [...outcomes]);
  }

  /** The gateway executes a canonical request through ONE provider (caller-selected). */
  execute(provider: string, request: unknown): { text: string } | { failure: ReturnType<typeof normalizeProviderError> } {
    this.interactions.push({ provider, request });
    const queue = this.scripts.get(provider);
    const outcome: ScriptedOutcome =
      queue !== undefined && queue.length > 0 ? queue.shift()! : { kind: 'ok', text: 'default ok' };
    if (outcome.kind === 'fail') {
      const definition = provider === 'alpha' ? alphaAdapter : betaAdapter;
      return { failure: definition.mapError(outcome.error) };
    }
    return { text: outcome.text };
  }
}

// ---------------------------------------------------------------------------
// The end-to-end acceptance walkthrough
// ---------------------------------------------------------------------------

describe('provider-sdk integration — one template, two conforming providers, one gateway', () => {
  it('takes both providers through the full lifecycle with canonical health handling', () => {
    const runtime = new ExampleGatewayRuntime();

    for (const adapter of [alphaAdapter, betaAdapter]) {
      const tracker = new ProviderLifecycleTracker({
        gateway: adapter.gateway,
        provider: adapter.provider,
      });

      // registration (birth) → discovery → configuration → verification → activation
      tracker.dispatch('discover', { reason: 'health/capability probe' });
      const capabilities = adapter.describeCapabilities();
      expect(capabilities.capabilities).toEqual(['greet', 'echo']);
      tracker.dispatch('configure', { reason: 'credentials attached (opaque ref)' });
      tracker.dispatch('verify', { reason: 'conformance suite green + credential check' });
      tracker.dispatch('activate', { reason: 'operator enabled' });
      expect(tracker.current).toBe('active');

      // Serving: success keeps health; transient failure degrades.
      let health = 'healthy' as 'healthy' | 'degraded' | 'unavailable';
      runtime.script(adapter.provider, [
        { kind: 'ok', text: 'hello' },
        { kind: 'fail', error: new ProviderWireError('TOO_FAST', 'slow down', 429, 1_000) },
        { kind: 'ok', text: 'recovered' },
        { kind: 'fail', error: new ProviderWireError('BAD_KEY', 'key expired', 401) },
      ]);

      const first = runtime.execute(adapter.provider, { op: 'greet' });
      expect(first).toEqual({ text: 'hello' });
      health = applySuccessToHealth(health);
      expect(health).toBe('healthy');

      const throttled = runtime.execute(adapter.provider, { op: 'greet' });
      expect('failure' in throttled && throttled.failure.category).toBe('rate_limited');
      if ('failure' in throttled) {
        expect(throttled.failure.retryable).toBe(true);
        expect(throttled.failure.retryAfterMs).toBe(1_000);
        health = applyFailureToHealth(health, throttled.failure);
        expect(health).toBe('degraded');
        // The suggested lifecycle event for a transient failure is degrade.
        expect(suggestedLifecycleEventForFailure(throttled.failure)).toBe('degrade');
        tracker.dispatch('degrade', { reason: throttled.failure.category });
        expect(tracker.current).toBe('degraded');
      }

      const again = runtime.execute(adapter.provider, { op: 'greet' });
      expect(again).toEqual({ text: 'recovered' });
      health = applySuccessToHealth(health);
      expect(health).toBe('healthy');
      tracker.dispatch('recover', { reason: 'successful interaction' });
      expect(tracker.current).toBe('active');

      // An auth failure is operator-recovery: unavailable + degrade event;
      // the provider is NOT trusted to serve until a human intervenes.
      const auth = runtime.execute(adapter.provider, { op: 'greet' });
      expect('failure' in auth && auth.failure.category).toBe('auth_failure');
      if ('failure' in auth) {
        health = applyFailureToHealth(health, auth.failure);
        expect(health).toBe('unavailable');
        tracker.dispatch('degrade', { reason: auth.failure.category });
        expect(tracker.current).toBe('degraded');
      }

      // Retirement is always available and terminal.
      tracker.dispatch('retire', { reason: 'replaced by peer' });
      expect(tracker.current).toBe('retired');
      expect(() => tracker.dispatch('recover')).toThrowError(/illegal/);
    }

    // Every interaction went through the gateway with the SAME canonical
    // request shape — no provider objects anywhere.
    expect(runtime.interactions).toHaveLength(8);
    expect(runtime.interactions.every((i) => typeof i.provider === 'string')).toBe(true);
  });

  it('proves the hot swap: the same canonical request through both providers, canonical evidence', () => {
    const runtime = new ExampleGatewayRuntime();
    const canonicalRequest = { op: 'greet', name: 'Aurum' };

    // Both providers serve the same canonical request — no domain change,
    // no provider-specific branching in the caller.
    runtime.script('alpha', [{ kind: 'ok', text: 'Hello, Aurum!' }]);
    runtime.script('beta', [{ kind: 'ok', text: 'Hello,  Aurum! ' }]);

    const viaAlpha = runtime.execute('alpha', canonicalRequest);
    const viaBeta = runtime.execute('beta', canonicalRequest);
    expect('text' in viaAlpha && 'text' in viaBeta).toBe(true);

    // Deterministic structural comparison (whitespace-normalized) — the
    // llm module's precedent; semantic judgment stays with the caller.
    const textA = 'text' in viaAlpha ? viaAlpha.text : '';
    const textB = 'text' in viaBeta ? viaBeta.text : '';
    const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');
    const outcome = normalize(textA) === normalize(textB) ? 'equivalent' : 'completed-divergent';

    const evidence = buildHotSwapEvidence({
      gateway: 'example-gateway',
      capability: 'greet',
      providerA: { provider: 'alpha', target: 'stable', resultKind: 'completed' },
      providerB: { provider: 'beta', target: 'stable', resultKind: 'completed' },
      outcome,
      evidenceId: 'example-verification-0001',
      executedAt: '2026-09-23T12:00:00.000Z',
      canonicalRequest,
    });
    expect(evidence.outcome).toBe('equivalent');
    expect(validateHotSwapEvidenceRecord(evidence)).toEqual([]);
    expect(evidence.requestDigest).toMatch(/^[0-9a-f]{64}$/);

    // A divergent completion still proves the swap (the swap is about
    // execution through a different provider, not about identical text).
    const divergent = buildHotSwapEvidence({
      gateway: 'example-gateway',
      capability: 'greet',
      providerA: { provider: 'alpha', target: 'stable', resultKind: 'completed' },
      providerB: { provider: 'beta', target: 'stable', resultKind: 'completed' },
      outcome: 'completed-divergent',
      evidenceId: 'example-verification-0002',
      executedAt: '2026-09-23T12:01:00.000Z',
      canonicalRequest,
    });
    expect(validateHotSwapEvidenceRecord(divergent)).toEqual([]);
  });

  it('keeps provider selection outside the SDK (caller decides, failures never become domain failures)', () => {
    const runtime = new ExampleGatewayRuntime();
    runtime.script('alpha', [{ kind: 'fail', error: new ProviderWireError('UPSTREAM_DOWN', 'all workers down', 503) }]);
    runtime.script('beta', [{ kind: 'ok', text: 'served by beta' }]);

    // The CALLER's routing policy (here: a plain ordered preference) picks
    // alpha first; the SDK only reports canonical state.
    const preference = ['alpha', 'beta'];
    let served: { text: string } | null = null;
    for (const provider of preference) {
      const result = runtime.execute(provider, { op: 'greet' });
      if ('text' in result) {
        served = result;
        break;
      }
      // The provider failure became CANONICAL capability/error state — the
      // domain loop continues with the next provider (§9 failure isolation).
      expect(result.failure.category).toBe('provider_unavailable');
      expect(result.failure.recovery).toBe('automatic');
    }
    expect(served).toEqual({ text: 'served by beta' });
  });

  it('ends with both providers green on the full conformance kit', async () => {
    const subjectFor = (adapter: typeof alphaAdapter): AdapterConformanceSubject => ({
      definition: adapter,
      gateway: 'example-gateway',
      errorSpecimens: [
        {
          description: 'wire auth rejection',
          error: new ProviderWireError('BAD_KEY', 'key expired', 401),
          expectedCategory: 'auth_failure',
        },
        {
          description: 'wire throttle',
          error: new ProviderWireError('TOO_FAST', 'slow down', 429, 500),
          expectedCategory: 'rate_limited',
          expectedRetryable: true,
        },
        {
          description: 'wire upstream outage',
          error: new ProviderWireError('UPSTREAM_DOWN', 'down', 503),
          expectedCategory: 'provider_unavailable',
        },
        {
          description: 'unsupported operation',
          error: new ProviderWireError('CANT_DO_THAT', 'no such op'),
          expectedCategory: 'unsupported_capability',
        },
        {
          description: 'unrecognized wire error',
          error: new ProviderWireError('MYSTERY', '???'),
          expectedCategory: 'unknown_failure',
        },
      ],
      expectedCapabilities: ['greet', 'echo'],
      hotSwapEvidence: () =>
        buildHotSwapEvidence({
          gateway: 'example-gateway',
          capability: 'greet',
          providerA: { provider: adapter.provider, target: 'stable', resultKind: 'completed' },
          providerB: {
            provider: adapter.provider === 'alpha' ? 'beta' : 'alpha',
            target: 'stable',
            resultKind: 'completed',
          },
          outcome: 'equivalent',
          evidenceId: `example-${adapter.provider}-swap`,
          executedAt: '2026-09-23T12:00:00.000Z',
          canonicalRequest: { op: 'greet' },
        }),
    });

    for (const adapter of [alphaAdapter, betaAdapter]) {
      const failures: string[] = [];
      for (const check of collectAdapterConformanceChecks(subjectFor(adapter))) {
        try {
          await check.run();
        } catch (error) {
          failures.push(`${check.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      expect(failures).toEqual([]);
    }
  });
});
