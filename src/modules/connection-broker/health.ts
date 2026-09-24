// Pure provider-health logic of the connection-broker module (W082
// acceptance: "provider outages are localized"). No database, no clock, no
// network.
//
// A broker/provider failure NEVER becomes a domain fault: it becomes a
// CanonicalProviderFailure (W089 taxonomy) which maps onto a health state
// for exactly ONE (provider, broker) pair — the llm module's availability
// discipline (its migrations/002 + service precedent) reshaped onto the
// connection gateway. Other providers, other brokers and every other
// connection keep operating (tested), and checkpoints/domain state are
// never touched by an outage.
//
// Cooldown semantics (the llm routing precedent):
//   * AUTOMATIC-recovery failures (rate limits, outages, timeouts) cool
//     down for a bounded window (OUTAGE_COOLDOWN_MS); the sync path fails
//     fast while the window is open (`provider_outage`) instead of
//     hammering the provider.
//   * OPERATOR-recovery failures (auth, permission, quota, drift) cool
//     down indefinitely (NULL horizon) — only a successful interaction, a
//     refresh or an operator override lifts them.
//   * Refresh is deliberately NOT gated: it is the healing path (a valid
//     refresh token survives an access-token auth failure), and a
//     successful refresh records the recovery.

import type { CanonicalProviderFailure, ProviderHealthStatus } from '@/modules/provider-sdk/contract';
import { applyFailureToHealth } from '@/modules/provider-sdk/contract';
import type { ProviderHealth } from './types';

/** Bounded cooldown for automatic-recovery failures (rate limit / outage / timeout). */
export const OUTAGE_COOLDOWN_MS = 60_000;

/** The resolved shape of one health event row (the service maps rows onto this). */
export interface HealthEventLike {
  readonly state: ProviderHealth;
  readonly category: string | null;
  readonly reason: string | null;
  readonly expiresAt: Date | string | null;
  readonly observedAt: Date | string;
}

/** The health state a canonical failure moves a (provider, broker) pair to. */
export function healthForFailure(failure: CanonicalProviderFailure): ProviderHealthStatus {
  return applyFailureToHealth('healthy', failure);
}

/**
 * The cooldown horizon a newly observed failure records: bounded for
 * automatic-recovery failures; indefinite (null) for operator-recovery
 * ones. `none`-impact failures (caller errors) never become events at all.
 */
export function cooldownExpiryFor(
  failure: CanonicalProviderFailure,
  at: Date,
): Date | null {
  if (failure.recovery === 'automatic') {
    return new Date(at.getTime() + OUTAGE_COOLDOWN_MS);
  }
  return null;
}

/** Whether an unresolved health event still cools down at time `at`. */
export function isCoolingDown(event: HealthEventLike, at: Date): boolean {
  if (event.state === 'available') return false;
  if (event.expiresAt === null) return true;
  return toMillis(event.expiresAt) > at.getTime();
}

/** Resolve one health event row to its CURRENT (possibly recovered) state. */
export function resolveHealth(event: HealthEventLike, at: Date): ProviderHealth {
  if (event.state === 'available') return 'available';
  // An expired cooldown means the pair is eligible again — the next
  // interaction re-observes it honestly and a success records the recovery
  // event. This mirrors the llm module's expired-cooldown behavior exactly
  // (an expired unavailable event resolves available).
  if (event.expiresAt !== null && toMillis(event.expiresAt) <= at.getTime()) {
    return 'available';
  }
  return event.state;
}

function toMillis(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}
