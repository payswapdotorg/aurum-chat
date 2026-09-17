// Pure escalation/staleness logic of the environment module (no database,
// no clock): the deterministic derivations that let a watch demand
// attention — severity ranking, escalation-policy resolution, the signal
// floor decision, the staleness schedule and the episode-dedupe predicate.
// Exposed on the contract so downstream modules (W015 opportunity engine,
// W033 control tower) and unit tests can reuse the single definitions (the
// detection.ts / classification.ts precedent of processes/freshness).
//
// The freshness classification itself comes from the freshness module's
// PURE classifiers (W006, exported on its contract): current/aging/stale
// against stale-after thresholds, strict `>` at the boundary. This module
// only derives the ESCALATION layer on top of that classification.

import type {
  WatchEscalationPolicy,
  WatchSeverity,
  ResolvedEscalationPolicy,
} from './types';

/** Total order over severities: low < medium < high < critical. */
const SEVERITY_ORDER: readonly WatchSeverity[] = ['low', 'medium', 'high', 'critical'];

/** Rank of one severity (0 = low … 3 = critical); -1 when unknown. */
export function severityRank(severity: WatchSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** True when `severity` is at or above `floor` (the signal arm's test). */
export function severityMeetsFloor(severity: WatchSeverity, floor: WatchSeverity): boolean {
  return severityRank(severity) >= severityRank(floor);
}

/** The severities at/above `minimum`, ascending — SQL IN-lists for filtered listings. */
export function severitiesAtOrAbove(minimum: WatchSeverity): WatchSeverity[] {
  const rank = severityRank(minimum);
  return SEVERITY_ORDER.filter((severity) => severityRank(severity) >= rank);
}

/**
 * Resolve the escalation policy governing one watch entry: the entry's own
 * full-snapshot override when present, else the watchlist's default. Null
 * inputs (no default either — impossible through the service, which
 * requires a watchlist policy) surface as null for totalness.
 */
export function resolveEscalationPolicy(
  entryOverride: WatchEscalationPolicy | null,
  watchlistDefault: WatchEscalationPolicy | null,
): ResolvedEscalationPolicy | null {
  if (entryOverride !== null) return { policy: entryOverride, source: 'entry' };
  if (watchlistDefault !== null) return { policy: watchlistDefault, source: 'watchlist' };
  return null;
}

/** The staleness-escalation schedule of one armed watch (pure math). */
export interface StalenessSchedule {
  /** The instant the watch became/will become stale: latestObservedAt + staleAfterSeconds. */
  staleSince: Date;
  /** The instant the escalation is due: staleSince + staleGraceSeconds. */
  escalateAt: Date;
}

/**
 * The staleness schedule of one watch: when its evidence goes stale
 * (latestObservedAt + staleAfterSeconds — the strict boundary the freshness
 * classifier applies: at exactly staleAfterSeconds the watch is NOT yet
 * stale) and when a staleness escalation is due (that boundary plus the
 * policy's grace period).
 *
 * Due-ness is strict the same way the classifier is: the escalation is due
 * strictly AFTER `escalateAt` (age > staleAfter + grace), matching
 * classifyFreshness's `age > staleAfterSeconds` convention.
 */
export function stalenessSchedule(
  latestObservedAt: string,
  staleAfterSeconds: number,
  staleGraceSeconds: number,
): StalenessSchedule {
  const observedMs = Date.parse(latestObservedAt);
  const staleSinceMs = observedMs + staleAfterSeconds * 1000;
  return {
    staleSince: new Date(staleSinceMs),
    escalateAt: new Date(staleSinceMs + staleGraceSeconds * 1000),
  };
}

/**
 * True when the escalation `dueAt` instant has passed at `asOf` — strict:
 * exactly at the instant the escalation is not yet due (the classifier's
 * boundary convention, applied to the grace period).
 */
export function stalenessDue(asOf: string | Date, dueAt: string | Date): boolean {
  const asOfMs = asOf instanceof Date ? asOf.getTime() : Date.parse(asOf);
  const dueMs = dueAt instanceof Date ? dueAt.getTime() : Date.parse(dueAt);
  return asOfMs > dueMs;
}

/**
 * Episode dedupe for the staleness arm: a stale escalation recorded at or
 * after `staleSince` necessarily belongs to THIS staleness episode (any
 * earlier episode's escalation predates the newest evidence, which predates
 * the stale boundary). New evidence re-anchors the episode and re-arms the
 * pump; one escalation per episode, ever.
 */
export function isStaleEpisodeEscalated(
  latestStaleEscalationRecordedAt: string | null,
  staleSince: string | Date,
): boolean {
  if (latestStaleEscalationRecordedAt === null) return false;
  const recordedMs = Date.parse(latestStaleEscalationRecordedAt);
  const staleSinceMs = staleSince instanceof Date ? staleSince.getTime() : Date.parse(staleSince);
  return recordedMs >= staleSinceMs;
}

/**
 * Deterministic summary line of one staleness escalation (recorded on the
 * escalation row; reconstructable without any policy lookup).
 */
export function staleEscalationSummary(
  latestObservedAt: string,
  staleAfterSeconds: number,
  staleGraceSeconds: number,
): string {
  return (
    `watch evidence stale since ${latestObservedAt} ` +
    `(stale after ${staleAfterSeconds}s, grace ${staleGraceSeconds}s) with no fresher signal`
  );
}

/**
 * Deterministic summary line of one signal escalation: the signal's note
 * when the recorder supplied one, else a generated line.
 */
export function signalEscalationSummary(
  severity: WatchSeverity,
  note: string | null,
  observationId: string,
): string {
  if (note !== null && note !== '') return note;
  return `signal at severity '${severity}' (observation ${observationId}) met the escalation floor`;
}
