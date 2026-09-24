// Unit tests for the provider-sdk lifecycle contract (W089): the canonical
// transition table, the append-only tracker, illegal dispatches, and the
// failure→event / failure→health mapping (§9 failure isolation).

import { describe, expect, it } from 'vitest';
import {
  applyFailureToHealth,
  applySuccessToHealth,
  canTransitionProviderLifecycle,
  isProviderLifecycleEvent,
  isProviderLifecycleState,
  isRetirable,
  ProviderLifecycleTracker,
  PROVIDER_LIFECYCLE_EVENTS,
  PROVIDER_LIFECYCLE_TRANSITIONS,
  providerLifecycleTransitionError,
  suggestedLifecycleEventForFailure,
} from '../contract';
import { canonicalFailure } from '../contract';
import { ProviderSdkError } from '../errors';

const DESCRIPTOR = { gateway: 'example-gateway', provider: 'alpha' } as const;
const AT = new Date('2026-09-23T12:00:00.000Z');

describe('provider-sdk lifecycle — canonical transition table', () => {
  it('exposes exactly the mandated lifecycle', () => {
    expect(Object.keys(PROVIDER_LIFECYCLE_TRANSITIONS).sort()).toEqual([
      'active',
      'configured',
      'degraded',
      'discovered',
      'registered',
      'retired',
      'verified',
    ]);
  });

  it('allows exactly the canonical forward/backward edges', () => {
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.registered).toEqual(['discovered', 'retired']);
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.discovered).toEqual(['configured', 'retired']);
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.configured).toEqual(['verified', 'retired']);
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.verified).toEqual(['active', 'retired']);
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.active).toEqual(['degraded', 'retired']);
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.degraded).toEqual(['active', 'retired']);
    expect(PROVIDER_LIFECYCLE_TRANSITIONS.retired).toEqual([]);
  });

  it('derives the event table consistently with the transition table', () => {
    for (const [event, edge] of Object.entries(PROVIDER_LIFECYCLE_EVENTS)) {
      expect(isProviderLifecycleEvent(event)).toBe(true);
      expect(canTransitionProviderLifecycle(edge.from, edge.to)).toBe(true);
    }
    expect(isProviderLifecycleEvent('retire')).toBe(true);
    expect(isProviderLifecycleEvent('explode')).toBe(false);
    expect(isProviderLifecycleEvent(null)).toBe(false);
  });

  it('recognizes and rejects lifecycle states', () => {
    for (const state of Object.keys(PROVIDER_LIFECYCLE_TRANSITIONS)) {
      expect(isProviderLifecycleState(state)).toBe(true);
    }
    expect(isProviderLifecycleState('installed')).toBe(false);
    expect(isProviderLifecycleState(42)).toBe(false);
  });

  it('reports illegal transitions with the legal targets in the message', () => {
    expect(providerLifecycleTransitionError('registered', 'discovered')).toBeNull();
    expect(providerLifecycleTransitionError('degraded', 'active')).toBeNull();
    const error = providerLifecycleTransitionError('active', 'discovered');
    expect(error).toBeInstanceOf(ProviderSdkError);
    expect(error!.code).toBe('illegal_lifecycle_transition');
    expect(error!.message).toContain('active → discovered');
    expect(error!.message).toContain('degraded, retired');
  });

  it('retire is legal from every non-retired state and terminal afterwards', () => {
    for (const state of Object.keys(PROVIDER_LIFECYCLE_TRANSITIONS) as Array<
      keyof typeof PROVIDER_LIFECYCLE_TRANSITIONS
    >) {
      expect(isRetirable(state)).toBe(state !== 'retired');
    }
  });
});

describe('provider-sdk lifecycle — the append-only tracker', () => {
  it('walks the full canonical flow and records an immutable history', () => {
    const tracker = new ProviderLifecycleTracker(DESCRIPTOR);
    expect(tracker.current).toBe('registered');
    expect(tracker.isRetired).toBe(false);
    expect(tracker.lifecycleDescriptor).toEqual(DESCRIPTOR);

    tracker.dispatch('discover', { at: AT, reason: 'probe' });
    tracker.dispatch('configure', { at: AT });
    tracker.dispatch('verify', { at: AT, reason: 'conformance suite green' });
    tracker.dispatch('activate', { at: AT });
    expect(tracker.current).toBe('active');

    const degraded = tracker.dispatch('degrade', { at: AT, reason: 'rate limited' });
    expect(degraded).toEqual({
      from: 'active',
      to: 'degraded',
      event: 'degrade',
      at: AT.toISOString(),
      reason: 'rate limited',
    });
    tracker.dispatch('recover', { at: AT });
    expect(tracker.current).toBe('active');

    tracker.dispatch('retire', { at: AT, reason: 'replaced by beta' });
    expect(tracker.current).toBe('retired');
    expect(tracker.isRetired).toBe(true);

    const history = tracker.history();
    expect(history.map((entry) => entry.event)).toEqual([
      'discover',
      'configure',
      'verify',
      'activate',
      'degrade',
      'recover',
      'retire',
    ]);
    expect(history.map((entry) => entry.to)).toEqual([
      'discovered',
      'configured',
      'verified',
      'active',
      'degraded',
      'active',
      'retired',
    ]);
    // The history is a defensive copy — mutating it cannot rewrite the log.
    (history as unknown[]).length = 0;
    expect(tracker.history().length).toBe(7);
  });

  it('rejects illegal dispatches without touching state or history', () => {
    const tracker = new ProviderLifecycleTracker(DESCRIPTOR, 'active');
    for (const event of ['discover', 'configure', 'verify', 'activate', 'recover'] as const) {
      expect(() => tracker.dispatch(event)).toThrowError(ProviderSdkError);
      expect(tracker.current).toBe('active');
      expect(tracker.history()).toEqual([]);
    }
    expect(tracker.canDispatch('degrade')).toBe(true);
    expect(tracker.canDispatch('verify')).toBe(false);
    expect(tracker.canDispatch('retire')).toBe(true);
  });

  it('enforces the event table origin states (an event is legal only where it is defined)', () => {
    // 'recover' is defined degraded → active: legal there, illegal elsewhere.
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'degraded').canDispatch('recover')).toBe(true);
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'active').canDispatch('recover')).toBe(false);
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'verified').canDispatch('recover')).toBe(false);
    // 'activate' is defined verified → active.
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'verified').canDispatch('activate')).toBe(true);
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'configured').canDispatch('activate')).toBe(false);
    // 'degrade' is defined active → degraded.
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'active').canDispatch('degrade')).toBe(true);
    expect(new ProviderLifecycleTracker(DESCRIPTOR, 'degraded').canDispatch('degrade')).toBe(false);
  });

  it('makes retired terminal', () => {
    const tracker = new ProviderLifecycleTracker(DESCRIPTOR, 'degraded');
    tracker.dispatch('retire');
    for (const event of ['discover', 'configure', 'verify', 'activate', 'degrade', 'recover', 'retire'] as const) {
      expect(() => tracker.dispatch(event)).toThrowError(/illegal provider lifecycle/);
      expect(tracker.canDispatch(event)).toBe(false);
    }
  });

  it('defaults the transition timestamp to the injectable clock', () => {
    const before = Date.now();
    const tracker = new ProviderLifecycleTracker(DESCRIPTOR);
    const transition = tracker.dispatch('discover');
    const parsed = Date.parse(transition.at);
    expect(parsed).toBeGreaterThanOrEqual(before - 1);
    expect(Number.isNaN(parsed)).toBe(false);
  });
});

describe('provider-sdk lifecycle — failure → event/health mapping', () => {
  const ctx = { gateway: 'example-gateway', provider: 'alpha' };

  it('suggests degrade for automatic- and operator-recovery failures, nothing for none-recovery', () => {
    expect(suggestedLifecycleEventForFailure(canonicalFailure('rate_limited', { ...ctx, detail: 'x' }))).toBe('degrade');
    expect(suggestedLifecycleEventForFailure(canonicalFailure('timeout', { ...ctx, detail: 'x' }))).toBe('degrade');
    expect(suggestedLifecycleEventForFailure(canonicalFailure('auth_failure', { ...ctx, detail: 'x' }))).toBe('degrade');
    expect(suggestedLifecycleEventForFailure(canonicalFailure('unsupported_capability', { ...ctx, detail: 'x' }))).toBeNull();
    expect(suggestedLifecycleEventForFailure(canonicalFailure('invalid_request', { ...ctx, detail: 'x' }))).toBeNull();
    expect(suggestedLifecycleEventForFailure(canonicalFailure('canceled', { ...ctx, detail: 'x' }))).toBeNull();
  });

  it('maps failures to health per the canonical impact table', () => {
    const rate = canonicalFailure('rate_limited', { ...ctx, detail: 'x' });
    const auth = canonicalFailure('auth_failure', { ...ctx, detail: 'x' });
    const invalid = canonicalFailure('invalid_request', { ...ctx, detail: 'x' });
    const unknown = canonicalFailure('unknown_failure', { ...ctx, detail: 'x' });

    // automatic recovery → degraded (from healthy; unavailable stays unavailable)
    expect(applyFailureToHealth('healthy', rate)).toBe('degraded');
    expect(applyFailureToHealth('degraded', rate)).toBe('degraded');
    expect(applyFailureToHealth('unavailable', rate)).toBe('unavailable');
    // operator recovery → unavailable
    expect(applyFailureToHealth('healthy', auth)).toBe('unavailable');
    expect(applyFailureToHealth('degraded', auth)).toBe('unavailable');
    // none recovery → unchanged (caller/capability-scoped)
    expect(applyFailureToHealth('healthy', invalid)).toBe('healthy');
    expect(applyFailureToHealth('degraded', invalid)).toBe('degraded');
    // unknown is conservative → unavailable (the llm any-failure cooldown precedent)
    expect(applyFailureToHealth('healthy', unknown)).toBe('unavailable');
  });

  it('restores full health on success', () => {
    expect(applySuccessToHealth('healthy')).toBe('healthy');
    expect(applySuccessToHealth('degraded')).toBe('healthy');
    expect(applySuccessToHealth('unavailable')).toBe('healthy');
  });
});
