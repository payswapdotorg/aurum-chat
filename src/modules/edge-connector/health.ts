// Pure health/staleness logic of the edge-connector module (W088:
// "health/version reporting … a silent edge is 'stale', honestly
// rendered"). No database, no clock, no network — the caller feeds the
// observed timestamps.
//
// The honest-rendering discipline: a silent edge is NEVER guessed healthy
// and never hidden. An edge that has never heartbeat-ed is as stale as
// one whose last heartbeat fell outside the window; the only healthy
// verdict is a seen-one-within-the-window one. Allowlist drift (the last
// REPORTED digest differing from the RECORDED one) is surfaced as a
// boolean flag, never silently trusted — the edge-side allowlist
// re-check remains the real enforcement (defense in depth).

import type { EdgeHealthView, EdgeResolvedHealth } from './types';

/**
 * How long an edge may stay silent before it renders 'stale' (default:
 * 120s — four missed 30s heartbeats). Wiring may override per view.
 */
export const DEFAULT_STALE_AFTER_MS = 120_000;

/** The default claim lease: how long a claimed job is held before reclaim. */
export const DEFAULT_LEASE_MS = 120_000;

function toMs(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

/**
 * The resolved health of one edge: 'healthy' when it was seen within the
 * staleness window; 'stale' when it was not — including when it has
 * never been seen at all (lastSeenAt null).
 */
export function resolveEdgeHealth(input: {
  lastSeenAt: Date | string | null;
  now: Date | string;
  staleAfterMs?: number;
}): EdgeResolvedHealth {
  if (input.lastSeenAt === null) return 'stale';
  const window = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return toMs(input.lastSeenAt) + window >= toMs(input.now) ? 'healthy' : 'stale';
}

/**
 * True when the last REPORTED allowlist digest differs from the RECORDED
 * one — the edge's local allowlist has drifted from the gateway's
 * record. Never true when nothing was reported yet (no data, no claim).
 */
export function resolveAllowlistDrift(
  recordedDigest: string | null,
  reportedDigest: string | null,
): boolean {
  if (reportedDigest === null) return false;
  return recordedDigest !== reportedDigest;
}

/**
 * Assembles the honest health view of one edge from its recorded and
 * reported columns. Pure: the caller feeds observed values; nothing is
 * guessed, nothing is hidden.
 */
export function resolveEdgeHealthView(input: {
  lastSeenAt: Date | string | null;
  reportedVersion: string | null;
  reportedAllowlistDigest: string | null;
  recordedAllowlistDigest: string;
  now: Date | string;
  staleAfterMs?: number;
}): EdgeHealthView {
  return {
    status: resolveEdgeHealth({
      lastSeenAt: input.lastSeenAt,
      now: input.now,
      staleAfterMs: input.staleAfterMs,
    }),
    lastSeenAt:
      input.lastSeenAt === null
        ? null
        : (input.lastSeenAt instanceof Date
            ? input.lastSeenAt
            : new Date(input.lastSeenAt)
          ).toISOString(),
    reportedVersion: input.reportedVersion,
    reportedAllowlistDigest: input.reportedAllowlistDigest,
    allowlistDrift: resolveAllowlistDrift(
      input.recordedAllowlistDigest,
      input.reportedAllowlistDigest,
    ),
  };
}
