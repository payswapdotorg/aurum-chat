// The canonical provider-adapter lifecycle machine (W089): one shared,
// provider-agnostic state machine every gateway adopts for its adapters.
//
//   registered → discovered → configured → verified → active ⇄ degraded → retired
//
// The table below is the SINGLE source of truth for legal transitions; the
// tracker enforces it and keeps an append-only history. Purity rules: no
// database, no network, no provider SDKs; timestamps are caller-supplied
// with the injectable infra clock as the default (IMPLEMENTATION-STACK §8).
//
// Health is a separate axis (ProviderHealthStatus) derived from canonical
// failures via the error-normalization semantics (see normalization.ts) —
// this file only maps failures to lifecycle EVENTS; it never classifies
// provider errors itself.

import { now } from '@/infra/clock';
import { ProviderSdkError } from './errors';
import type {
  CanonicalProviderFailure,
  ProviderLifecycleEvent,
  ProviderLifecycleState,
  ProviderLifecycleTransition,
  ProviderHealthStatus,
} from './types';

// ---------------------------------------------------------------------------
// The canonical transition table
// ---------------------------------------------------------------------------

/**
 * Legal state transitions (derived from the canonical event table). Keyed by
 * source state; the listed states are the only legal targets.
 */
export const PROVIDER_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ProviderLifecycleState, readonly ProviderLifecycleState[]>
> = {
  registered: ['discovered', 'retired'],
  discovered: ['configured', 'retired'],
  configured: ['verified', 'retired'],
  verified: ['active', 'retired'],
  active: ['degraded', 'retired'],
  degraded: ['active', 'retired'],
  retired: [],
};

/** Which event drives which transition (the canonical verb per edge). */
export const PROVIDER_LIFECYCLE_EVENTS: Readonly<
  Record<Exclude<ProviderLifecycleEvent, 'retire'>, { readonly from: ProviderLifecycleState; readonly to: ProviderLifecycleState }>
> = {
  discover: { from: 'registered', to: 'discovered' },
  configure: { from: 'discovered', to: 'configured' },
  verify: { from: 'configured', to: 'verified' },
  activate: { from: 'verified', to: 'active' },
  degrade: { from: 'active', to: 'degraded' },
  recover: { from: 'degraded', to: 'active' },
};

/** `retire` is legal from every non-retired state. */
export function isRetirable(state: ProviderLifecycleState): boolean {
  return state !== 'retired';
}

export function isProviderLifecycleState(value: unknown): value is ProviderLifecycleState {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_LIFECYCLE_TRANSITIONS, value)
  );
}

export function isProviderLifecycleEvent(value: unknown): value is ProviderLifecycleEvent {
  return (
    typeof value === 'string' &&
    (value === 'retire' || Object.prototype.hasOwnProperty.call(PROVIDER_LIFECYCLE_EVENTS, value))
  );
}

/** Is the transition legal per the canonical table? */
export function canTransitionProviderLifecycle(
  from: ProviderLifecycleState,
  to: ProviderLifecycleState,
): boolean {
  return PROVIDER_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** The canonical transition error (or null when legal). */
export function providerLifecycleTransitionError(
  from: ProviderLifecycleState,
  to: ProviderLifecycleState,
): ProviderSdkError | null {
  if (canTransitionProviderLifecycle(from, to)) return null;
  const legal = PROVIDER_LIFECYCLE_TRANSITIONS[from];
  const legalText = legal.length === 0 ? 'nowhere (terminal)' : legal.join(', ');
  return new ProviderSdkError(
    'illegal_lifecycle_transition',
    `illegal provider lifecycle transition ${from} → ${to} (legal targets from ${from}: ${legalText})`,
  );
}

// ---------------------------------------------------------------------------
// The lifecycle tracker
// ---------------------------------------------------------------------------

export interface ProviderLifecycleDispatchOptions {
  /** Timestamp of the transition; defaults to the infra clock. */
  readonly at?: Date;
  /** Why the transition happened (operator note or machine reason). */
  readonly reason?: string | null;
}

export interface ProviderLifecycleDescriptor {
  readonly gateway: string;
  readonly provider: string;
}

/**
 * In-memory lifecycle tracker for one provider adapter instance. The owning
 * gateway mints one per (provider instance) and persists transitions through
 * its own tables if it needs durable lifecycle state (the llm module's
 * append-only availability events are the precedent); the tracker itself is
 * pure and deterministic — the history is append-only and immutable.
 */
export class ProviderLifecycleTracker {
  private readonly transitions: ProviderLifecycleTransition[] = [];

  constructor(
    private readonly descriptor: ProviderLifecycleDescriptor,
    private state: ProviderLifecycleState = 'registered',
  ) {
    if (!isProviderLifecycleState(state)) {
      throw new ProviderSdkError('illegal_lifecycle_transition', `unknown lifecycle state '${String(state)}'`);
    }
  }

  /** The current lifecycle state. */
  get current(): ProviderLifecycleState {
    return this.state;
  }

  get lifecycleDescriptor(): ProviderLifecycleDescriptor {
    return this.descriptor;
  }

  /** True once retired (terminal — nothing further can be dispatched). */
  get isRetired(): boolean {
    return this.state === 'retired';
  }

  /** The append-only transition history (birth entry first). */
  history(): readonly ProviderLifecycleTransition[] {
    return this.transitions.slice();
  }

  /** Can this event be dispatched in the current state? */
  canDispatch(event: ProviderLifecycleEvent): boolean {
    const target = this.targetStateFor(event);
    return target !== null;
  }

  /**
   * Dispatch one lifecycle event. The event table is authoritative: a
   * non-retire event is legal ONLY from its declared origin state (e.g.
   * 'recover' only from 'degraded', 'activate' only from 'verified'), and
   * 'retire' from any non-retired state. Throws
   * ProviderSdkError('illegal_lifecycle_transition') on an illegal dispatch
   * and leaves the tracker untouched (state and history unchanged).
   */
  dispatch(
    event: ProviderLifecycleEvent,
    options: ProviderLifecycleDispatchOptions = {},
  ): ProviderLifecycleTransition {
    const next = this.targetStateFor(event);
    if (next === null) {
      const legal = PROVIDER_LIFECYCLE_TRANSITIONS[this.state];
      const legalText = legal.length === 0 ? 'nowhere (terminal)' : legal.join(', ');
      throw new ProviderSdkError(
        'illegal_lifecycle_transition',
        `illegal provider lifecycle event '${event}' in state '${this.state}' of ${this.descriptor.gateway}/${this.descriptor.provider} (legal targets from ${this.state}: ${legalText})`,
      );
    }
    const transition: ProviderLifecycleTransition = {
      from: this.state,
      to: next,
      event,
      at: (options.at ?? now()).toISOString(),
      reason: options.reason ?? null,
    };
    this.transitions.push(transition);
    this.state = next;
    return transition;
  }

  /** The state an event leads to from the CURRENT state, or null when illegal here. */
  private targetStateFor(event: ProviderLifecycleEvent): ProviderLifecycleState | null {
    if (event === 'retire') return isRetirable(this.state) ? 'retired' : null;
    const edge = PROVIDER_LIFECYCLE_EVENTS[event];
    if (edge === undefined) return null;
    // The event table is authoritative: the declared origin must match.
    if (edge.from !== this.state) return null;
    return canTransitionProviderLifecycle(this.state, edge.to) ? edge.to : null;
  }
}

// ---------------------------------------------------------------------------
// Failure → lifecycle/health mapping (§9 failure isolation)
// ---------------------------------------------------------------------------

/**
 * The lifecycle event a canonical failure suggests while the provider is
 * `active`: transient failures degrade (automatic recovery is expected);
 * operator-recovery failures also degrade (a human decides whether to
 * retire); none-recovery failures (caller errors, unsupported capability,
 * cancellation) are NOT provider outages and suggest no transition.
 */
export function suggestedLifecycleEventForFailure(
  failure: CanonicalProviderFailure,
): ProviderLifecycleEvent | null {
  if (failure.recovery === 'none') return null;
  return 'degrade';
}

/** Apply one canonical failure to a health status (pure; see CanonicalHealthImpact). */
export function applyFailureToHealth(
  current: ProviderHealthStatus,
  failure: CanonicalProviderFailure,
): ProviderHealthStatus {
  switch (failure.healthImpact) {
    case 'none':
      return current;
    case 'degrade':
      return current === 'unavailable' ? 'unavailable' : 'degraded';
    case 'unavailable':
      return 'unavailable';
  }
}

/** A successful interaction (or a passing health probe) restores full health. */
export function applySuccessToHealth(_current: ProviderHealthStatus): ProviderHealthStatus {
  return 'healthy';
}
