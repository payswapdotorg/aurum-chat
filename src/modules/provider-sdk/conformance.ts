// The reusable adapter conformance test kit (W089): a framework-agnostic
// check engine any gateway adapter imports to prove conformance with the
// provider-sdk contract, plus a thin suite factory for vitest-style test
// frameworks.
//
// The kit holds 100% of the conformance logic; an adapter's test file only
// supplies the SUBJECT (its definition, error specimens, expected
// capabilities and an optional hot-swap evidence emitter) and ~4 lines of
// test-framework glue:
//
//   import { describe, it } from 'vitest';
//   import { defineAdapterConformanceSuite } from '@/modules/provider-sdk/contract';
//   defineAdapterConformanceSuite(subject, { describe, it });
//
// Covered conformance families (handoff §6 W089):
//   * lifecycle transitions (canonical flow, illegal dispatches, retire terminal);
//   * health/capability reporting (well-formed, deterministic, gateway-expected);
//   * error normalization (specimens → canonical categories, unknown fallback,
//     semantics-table consistency, health mapping);
//   * hot-swap evidence emission (canonical format, differing targets, digest).
//
// The kit NEVER selects providers and never inspects provider wire formats —
// it only proves the adapter's CANONICAL behavior. A third adapter should be
// creatable from this kit alone (proven in this module's own tests with
// example adapters).

import { ProviderSdkError } from './errors';
import {
  applyFailureToHealth,
  canTransitionProviderLifecycle,
  ProviderLifecycleTracker,
} from './lifecycle';
import {
  CANONICAL_FAILURE_SEMANTICS,
  canonicalFailure,
  isCanonicalErrorCategory,
} from './normalization';
import {
  buildHotSwapEvidence,
  validateHotSwapEvidenceRecord,
} from './evidence';
import type {
  CanonicalErrorCategory,
  ProviderAdapterDefinition,
  ProviderLifecycleEvent,
  ProviderLifecycleState,
  HotSwapEvidenceRecord,
} from './types';
import { PROVIDER_ADAPTER_SDK_VERSION } from './types';

// ---------------------------------------------------------------------------
// The subject
// ---------------------------------------------------------------------------

/** One provider-native failure specimen the adapter must normalize canonically. */
export interface AdapterErrorSpecimen {
  /** Human title for the generated check. */
  readonly description: string;
  /** The provider-native error value (any thrown shape). */
  readonly error: unknown;
  readonly expectedCategory: CanonicalErrorCategory;
  /** Optionally also assert the derived retryable flag. */
  readonly expectedRetryable?: boolean;
}

/**
 * The conformance subject: everything the kit needs to prove ONE adapter
 * conforms. `definition` is required; the rest refine the proof.
 */
export interface AdapterConformanceSubject {
  readonly definition: ProviderAdapterDefinition;
  /** The gateway this adapter serves (checked against the definition). */
  readonly gateway?: string;
  /** Provider-native failure specimens (at least one is expected for a real adapter). */
  readonly errorSpecimens?: readonly AdapterErrorSpecimen[];
  /** The capabilities the owning gateway expects this provider to serve. */
  readonly expectedCapabilities?: readonly string[] | null;
  /**
   * Emits one canonical hot-swap evidence record proving THIS provider can
   * replace a peer without domain changes (usually built from the owning
   * gateway's own verification flow).
   */
  readonly hotSwapEvidence?:
    | (() => Promise<HotSwapEvidenceRecord> | HotSwapEvidenceRecord)
    | null;
  /**
   * Override the canonical lifecycle flow (defaults to the full canonical
   * flow discover → configure → verify → activate → degrade → recover → retire).
   */
  readonly lifecycleFlow?: readonly ProviderLifecycleEvent[] | null;
}

// ---------------------------------------------------------------------------
// The check engine (framework-agnostic)
// ---------------------------------------------------------------------------

export interface ConformanceCheck {
  /** Stable check identity (e.g. 'lifecycle/canonical-flow'). */
  readonly id: string;
  /** Human-readable test title. */
  readonly title: string;
  /** Throws on failure (any test framework treats that as a failure). */
  readonly run: () => void | Promise<void>;
}

function assertThat(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

const CANONICAL_LIFECYCLE_FLOW: readonly ProviderLifecycleEvent[] = [
  'discover',
  'configure',
  'verify',
  'activate',
  'degrade',
  'recover',
  'retire',
];

/**
 * Collect every conformance check for one subject. Pure: builds the list
 * without running anything; the caller (or the suite factory below)
 * executes the checks.
 */
export function collectAdapterConformanceChecks(subject: AdapterConformanceSubject): ConformanceCheck[] {
  const { definition } = subject;
  const checks: ConformanceCheck[] = [];
  const label = `${definition.gateway}/${definition.provider}`;

  // --- definition shape -----------------------------------------------------

  checks.push({
    id: 'definition/shape',
    title: `definition ${label} carries the canonical adapter-definition shape and targets the current SDK version`,
    run: () => {
      assertThat(definition.sdk === 'provider-adapter-definition', `definition.sdk must be 'provider-adapter-definition' (got ${JSON.stringify(definition.sdk)})`);
      assertEqual(definition.sdkVersion, PROVIDER_ADAPTER_SDK_VERSION, 'definition.sdkVersion must equal PROVIDER_ADAPTER_SDK_VERSION');
      assertThat(typeof definition.gateway === 'string' && definition.gateway.trim() !== '' && definition.gateway.length <= 64, 'definition.gateway must be a non-empty string of at most 64 characters');
      assertThat(typeof definition.provider === 'string' && definition.provider.trim() !== '' && definition.provider.length <= 64, 'definition.provider must be a non-empty string of at most 64 characters');
      assertThat(typeof definition.describeCapabilities === 'function', 'definition.describeCapabilities must be a function');
      assertThat(typeof definition.mapError === 'function', 'definition.mapError must be a function');
    },
  });

  if (subject.gateway !== undefined) {
    checks.push({
      id: 'definition/gateway',
      title: `definition ${label} declares the owning gateway '${subject.gateway}'`,
      run: () => {
        assertEqual(definition.gateway, subject.gateway, 'definition.gateway must match the owning gateway');
      },
    });
  }

  // --- capability reporting ---------------------------------------------------

  checks.push({
    id: 'capabilities/well-formed',
    title: `provider ${label} reports a well-formed canonical capability set`,
    run: () => {
      const set = definition.describeCapabilities();
      assertThat(set.sdk === 'provider-capability-set', "capability set .sdk must be 'provider-capability-set'");
      assertEqual(set.gateway, definition.gateway, 'capability set .gateway must match the definition');
      assertEqual(set.provider, definition.provider, 'capability set .provider must match the definition');
      assertThat(
        Array.isArray(set.capabilities) && set.capabilities.length > 0,
        'capability set must declare at least one capability',
      );
      const seen = new Set<string>();
      for (const capability of set.capabilities) {
        assertThat(typeof capability === 'string' && capability.trim() !== '', `capabilities must be non-empty strings (got ${JSON.stringify(capability)})`);
        assertThat(!seen.has(capability), `capabilities must be unique (duplicate '${capability}')`);
        seen.add(capability);
      }
    },
  });

  checks.push({
    id: 'capabilities/deterministic',
    title: `provider ${label} reports its capability set deterministically`,
    run: () => {
      assertThat(
        JSON.stringify(definition.describeCapabilities()) === JSON.stringify(definition.describeCapabilities()),
        'describeCapabilities() must be deterministic (two calls must agree)',
      );
    },
  });

  if (subject.expectedCapabilities !== undefined && subject.expectedCapabilities !== null) {
    checks.push({
      id: 'capabilities/expected',
      title: `provider ${label} serves exactly the capabilities the owning gateway expects`,
      run: () => {
        const actual = [...definition.describeCapabilities().capabilities].sort();
        const expected = [...subject.expectedCapabilities!].sort();
        assertEqual(JSON.stringify(actual), JSON.stringify(expected), `capability set must equal the gateway expectation ${JSON.stringify(expected)}`);
      },
    });
  }

  // --- lifecycle ---------------------------------------------------------------

  const flow = subject.lifecycleFlow ?? CANONICAL_LIFECYCLE_FLOW;
  checks.push({
    id: 'lifecycle/canonical-flow',
    title: `provider ${label} walks the canonical lifecycle (registered → … → retired) with an append-only history`,
    run: () => {
      const tracker = new ProviderLifecycleTracker({ gateway: definition.gateway, provider: definition.provider });
      assertEqual(tracker.current, 'registered', 'a new tracker starts at registered');
      let expectedFrom: ProviderLifecycleState = 'registered';
      for (const event of flow) {
        const transition = tracker.dispatch(event, { at: new Date('2026-09-23T00:00:00.000Z'), reason: `conformance:${event}` });
        assertEqual(transition.from, expectedFrom, `transition('${event}').from must be ${expectedFrom}`);
        assertEqual(transition.to, tracker.current, `transition('${event}').to must match the tracker state`);
        assertEqual(transition.event, event, `transition('${event}').event must be recorded`);
        expectedFrom = tracker.current;
      }
      const history = tracker.history();
      assertEqual(history.length, flow.length, 'history length must equal the number of dispatched events');
    },
  });

  checks.push({
    id: 'lifecycle/illegal-transitions',
    title: `provider ${label} lifecycle rejects illegal dispatches without state or history changes`,
    run: () => {
      const illegal: ReadonlyArray<readonly [ProviderLifecycleState, ProviderLifecycleEvent]> = [
        ['registered', 'configure'],
        ['registered', 'activate'],
        ['discovered', 'discover'],
        ['configured', 'degrade'],
        ['verified', 'recover'],
        ['active', 'verify'],
        ['degraded', 'activate'],
      ];
      for (const [state, event] of illegal) {
        const tracker = new ProviderLifecycleTracker({ gateway: definition.gateway, provider: definition.provider }, state);
        let threw = false;
        try {
          tracker.dispatch(event);
        } catch (error) {
          threw = error instanceof ProviderSdkError && error.code === 'illegal_lifecycle_transition';
        }
        assertThat(threw, `dispatch('${event}') from '${state}' must throw ProviderSdkError('illegal_lifecycle_transition')`);
        assertEqual(tracker.current, state, 'an illegal dispatch must leave the state unchanged');
        assertEqual(tracker.history().length, 0, 'an illegal dispatch must not append history');
      }
      // Sanity of the canonical table itself.
      assertThat(!canTransitionProviderLifecycle('retired', 'active'), "retired → active must be illegal (retired is terminal)");
    },
  });

  checks.push({
    id: 'lifecycle/retire-terminal',
    title: `provider ${label} lifecycle treats retired as terminal (any state may retire)`,
    run: () => {
      for (const state of ['registered', 'discovered', 'configured', 'verified', 'active', 'degraded'] as const) {
        const tracker = new ProviderLifecycleTracker({ gateway: definition.gateway, provider: definition.provider }, state);
        tracker.dispatch('retire', { reason: 'conformance:retire' });
        assertEqual(tracker.current, 'retired', `retire must be legal from '${state}'`);
        assertEqual(tracker.isRetired, true, `isRetired must be true after retiring from '${state}'`);
        for (const event of ['discover', 'configure', 'verify', 'activate', 'degrade', 'recover', 'retire'] as const) {
          let threw = false;
          try {
            tracker.dispatch(event);
          } catch {
            threw = true;
          }
          assertThat(threw, `dispatch('${event}') on a retired tracker must throw`);
        }
      }
    },
  });

  // --- error normalization -------------------------------------------------------

  const specimens = subject.errorSpecimens ?? [];
  specimens.forEach((specimen, index) => {
    checks.push({
      id: `normalization/specimen-${index + 1}`,
      title: `provider ${label} normalizes '${specimen.description}' to '${specimen.expectedCategory}'`,
      run: () => {
        const failure = definition.mapError(specimen.error);
        assertEqual(failure.category, specimen.expectedCategory, `mapError() category for '${specimen.description}'`);
        const semantics = CANONICAL_FAILURE_SEMANTICS[specimen.expectedCategory];
        assertEqual(failure.retryable, semantics.retryable, `mapError() retryable for '${specimen.description}'`);
        assertEqual(failure.recovery, semantics.recovery, `mapError() recovery for '${specimen.description}'`);
        assertEqual(failure.healthImpact, semantics.healthImpact, `mapError() healthImpact for '${specimen.description}'`);
        assertEqual(failure.gateway, definition.gateway, `mapError() gateway for '${specimen.description}'`);
        assertEqual(failure.provider, definition.provider, `mapError() provider for '${specimen.description}'`);
        if (specimen.expectedRetryable !== undefined) {
          assertEqual(failure.retryable, specimen.expectedRetryable, `mapError() explicit expectedRetryable for '${specimen.description}'`);
        }
        assertThat(typeof failure.detail === 'string' && failure.detail !== '', `mapError() detail for '${specimen.description}' must be non-empty`);
        assertThat(failure.detail.length <= 500, `mapError() detail for '${specimen.description}' must be bounded (≤500 chars)`);
      },
    });
  });

  checks.push({
    id: 'normalization/unknown-fallback',
    title: `provider ${label} maps unrecognized failures to 'unknown_failure' (never a crash, never a fake success)`,
    run: () => {
      for (const garbage of [new Error('a completely novel provider hiccup'), 'string error', { weird: true }, null]) {
        const failure = definition.mapError(garbage);
        assertEqual(failure.category, 'unknown_failure', `mapError(${JSON.stringify(String(garbage ?? 'null'))}) must normalize to 'unknown_failure'`);
        assertEqual(failure.retryable, false, 'unknown_failure must not be retryable');
        assertEqual(failure.recovery, 'operator', 'unknown_failure must require operator recovery');
        assertEqual(failure.healthImpact, 'unavailable', 'unknown_failure must make the provider unavailable');
      }
    },
  });

  checks.push({
    id: 'normalization/semantics-table',
    title: `provider ${label} error normalization is consistent with the canonical semantics table`,
    run: () => {
      for (const category of Object.keys(CANONICAL_FAILURE_SEMANTICS) as CanonicalErrorCategory[]) {
        assertThat(isCanonicalErrorCategory(category), `'${category}' must be a canonical category`);
        const failure = canonicalFailure(category, {
          gateway: definition.gateway,
          provider: definition.provider,
          detail: `semantics check for ${category}`,
        });
        const semantics = CANONICAL_FAILURE_SEMANTICS[category];
        assertEqual(failure.retryable, semantics.retryable, `canonicalFailure('${category}').retryable`);
        assertEqual(failure.recovery, semantics.recovery, `canonicalFailure('${category}').recovery`);
        assertEqual(failure.healthImpact, semantics.healthImpact, `canonicalFailure('${category}').healthImpact`);
        // Health mapping must agree with the table's health impact.
        const health = applyFailureToHealth('healthy', failure);
        const expectedHealth =
          semantics.healthImpact === 'none'
            ? 'healthy'
            : semantics.healthImpact === 'degrade'
              ? 'degraded'
              : 'unavailable';
        assertEqual(health, expectedHealth, `applyFailureToHealth('healthy', '${category}')`);
      }
    },
  });

  // --- hot-swap evidence -----------------------------------------------------------

  if (subject.hotSwapEvidence !== undefined && subject.hotSwapEvidence !== null) {
    checks.push({
      id: 'hot-swap/evidence',
      title: `provider ${label} emits canonical hot-swap evidence (differing providers, digest, structural comparison)`,
      run: async () => {
        const record = await subject.hotSwapEvidence!();
        const issues = validateHotSwapEvidenceRecord(record);
        assertThat(issues.length === 0, `emitted hot-swap evidence must be valid (issues: ${issues.join('; ')})`);
        assertEqual(record.gateway, definition.gateway, 'evidence .gateway must match the owning gateway');
        assertThat(
          record.providerA.provider === definition.provider || record.providerB.provider === definition.provider,
          'evidence must involve this provider as one of the two swap targets',
        );
        assertThat(record.providerA.provider !== record.providerB.provider, 'the two swap targets must be different providers');
        assertThat(/^[0-9a-f]{64}$/.test(record.requestDigest), 'evidence .requestDigest must be a SHA-256 hex digest');
        assertThat(
          record.outcome === 'equivalent' || record.outcome === 'completed-divergent' || record.outcome === 'failed',
          'evidence .outcome must be in the canonical vocabulary',
        );
        // Rebuilding from the same inputs must be deterministic.
        const rebuilt = buildHotSwapEvidence({
          gateway: record.gateway,
          capability: record.capability,
          providerA: record.providerA,
          providerB: record.providerB,
          outcome: record.outcome,
          evidenceId: record.evidenceId,
          executedAt: record.executedAt,
          note: record.note,
          requestDigest: record.requestDigest,
        });
        assertEqual(JSON.stringify(rebuilt), JSON.stringify(record), 'buildHotSwapEvidence must be deterministic for the same inputs');
      },
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The suite factory (thin vitest-style glue)
// ---------------------------------------------------------------------------

/** The minimal test-framework surface the suite factory needs (vitest-compatible). */
export interface ConformanceFramework {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
}

/**
 * Register the full conformance suite for one subject with a vitest-style
 * framework: one describe block, one test per check. Framework-agnostic —
 * any runner with describe/it works.
 */
export function defineAdapterConformanceSuite(
  subject: AdapterConformanceSubject,
  framework: ConformanceFramework,
): void {
  const { definition } = subject;
  framework.describe(
    `provider-sdk conformance — ${definition.gateway}/${definition.provider}`,
    () => {
      for (const check of collectAdapterConformanceChecks(subject)) {
        framework.it(check.title, check.run);
      }
    },
  );
}
