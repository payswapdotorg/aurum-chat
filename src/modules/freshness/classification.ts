// Pure temporal math of the freshness module (no database, no clock): the
// latency/age derivations and the current/aging/stale classifier that
// together let Aurum say whether its understanding is current, aging or
// stale (ARCHITECTURE.md §11). Exposed on the contract so downstream
// modules (W014 environment watch, W052 source ranking) can classify
// deterministically without a database round-trip.
//
// All inputs are strict ISO 8601 instants as produced by the observations
// contract; both derivations clamp at zero — a source clock running ahead
// of Aurum's clocks produces skew, not negative latency/age.

import type { FreshnessStatus, FreshnessThresholds } from './types';

/**
 * Ingestion latency of one observation: recordedAt − observedAt in seconds
 * (fractional), clamped at 0. This is the W006 "observation latency"
 * derivation the observations module deliberately left to freshness
 * (observedAt is the source clock, recordedAt the service-minted commit
 * time).
 */
export function observationLatencySeconds(observedAt: string, recordedAt: string): number {
  const latency = (Date.parse(recordedAt) - Date.parse(observedAt)) / 1000;
  return Math.max(0, latency);
}

/**
 * Age of evidence observed at `observedAt`, evaluated `asOf`: seconds
 * (fractional), clamped at 0 (future-dated evidence is not negatively
 * aged).
 */
export function evidenceAgeSeconds(observedAt: string, asOf: string): number {
  const age = (Date.parse(asOf) - Date.parse(observedAt)) / 1000;
  return Math.max(0, age);
}

/**
 * Classify evidence/understanding of the given age against stale-after
 * thresholds:
 *
 *   age <= agingAfterSeconds (or staleAfterSeconds without an aging
 *         threshold)           → 'current'
 *   agingAfterSeconds < age
 *         <= staleAfterSeconds → 'aging'
 *   age >  staleAfterSeconds   → 'stale'
 *
 * "Stale-after N seconds" is strict: at exactly N seconds the subject is
 * not yet stale. `null` thresholds (no applicable policy) → 'unknown'.
 * Negative ages are treated as 0 (→ 'current').
 */
export function classifyFreshness(
  thresholds: FreshnessThresholds | null,
  ageSeconds: number,
): FreshnessStatus {
  if (thresholds === null) return 'unknown';
  const age = Math.max(0, ageSeconds);
  if (age > thresholds.staleAfterSeconds) return 'stale';
  const agingAfter = thresholds.agingAfterSeconds ?? null;
  if (agingAfter !== null && age > agingAfter) return 'aging';
  return 'current';
}
