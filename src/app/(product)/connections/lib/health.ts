// Connection & Integration Hub (W059) — connection health, source freshness
// and delivery-state derivations.
//
// HEALTH IS DERIVED, NEVER INVENTED: the domain contracts carry no
// "healthCheck" operation, so the hub computes connection health from state
// the contracts DO expose — registration/status, transport wiring,
// authorization-expiry, checkpoint state, the freshness module's canonical
// classification (W006, 'current' | 'aging' | 'stale' | 'unknown') and the
// destination delivery ledger (W037). The hub never fabricates a
// successful "test" — an unwired transport is reported as exactly that.
//
// Everything here is PURE (no I/O, test-controllable `now`) so the
// derivations are unit-testable in isolation from the embedded database.

import type { ChannelConnectionStatus } from '@/modules/channels/contract';
import type { SourceStatus } from '@/modules/sources/contract';
import type { DestinationStatus, DeliveryStatus } from '@/modules/destinations/contract';
import type { FreshnessStatus } from '@/modules/freshness/contract';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Derived health level of one connection (display + summary counts). */
export type HealthLevel = 'ok' | 'attention' | 'degraded' | 'disabled';

/** One derived reason: severity + human sentence. */
export interface HealthReason {
  level: Exclude<HealthLevel, 'ok'> | 'info';
  text: string;
}

export interface Health {
  level: HealthLevel;
  reasons: HealthReason[];
}

/** Degradation ordering for summaries (higher wins). */
const LEVEL_ORDER: Record<HealthLevel, number> = {
  ok: 0,
  attention: 1,
  degraded: 2,
  disabled: 3,
};

/** The worse of two health levels. */
export function worstLevel(a: HealthLevel, b: HealthLevel): HealthLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/** Seconds before an OAuth grant expiry is flagged "expiring soon". */
export const OAUTH_EXPIRING_WITHIN_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Channel health
// ---------------------------------------------------------------------------

export interface ChannelHealthInput {
  status: ChannelConnectionStatus | null;
  /** Whether a delivery transport is wired for the provider (process state). */
  transportWired: boolean;
  /** Newest transcript turn for the provider (ISO 8601), null when none. */
  lastActivityAt: string | null;
  /** Evaluation instant (ISO 8601). */
  now: string;
}

/** Age after which a silent-but-active channel is worth a quiet note. */
export const CHANNEL_QUIET_AFTER_SECONDS = 14 * 24 * 60 * 60;

export function channelHealth(input: ChannelHealthInput): Health {
  if (input.status === null) {
    return { level: 'ok', reasons: [] }; // not connected — card state, not a fault
  }
  if (input.status === 'disabled') {
    return {
      level: 'disabled',
      reasons: [{ level: 'disabled', text: 'Disconnected — the endpoint is disabled and receives nothing.' }],
    };
  }
  const reasons: HealthReason[] = [];
  let level: HealthLevel = 'ok';
  if (!input.transportWired) {
    level = 'degraded';
    reasons.push({
      level: 'degraded',
      text: 'No delivery transport wired — outbound messages and verification codes cannot leave (they fail with provider_unavailable).',
    });
  }
  const age = ageSeconds(input.lastActivityAt, input.now);
  if (age !== null && age > CHANNEL_QUIET_AFTER_SECONDS) {
    level = worstLevel(level, 'attention');
    reasons.push({
      level: 'info',
      text: 'No message turns recorded for this channel recently.',
    });
  }
  if (input.lastActivityAt === null) {
    reasons.push({
      level: 'info',
      text: 'No conversation turns recorded through this channel yet.',
    });
  }
  return { level, reasons };
}

// ---------------------------------------------------------------------------
// Source health (authorization + checkpoint + freshness)
// ---------------------------------------------------------------------------

export interface SourceHealthInput {
  status: SourceStatus | null;
  /** OAuth grant expiry (ISO 8601; null = non-expiring / credentials auth). */
  oauthExpiresAt: string | null;
  /** Current checkpoint cursor state (null = never polled / rewound to start). */
  checkpointUpdatedAt: string | null;
  /** The freshness module's canonical classification for the source. */
  freshness: FreshnessStatus;
  /** Evaluation instant (ISO 8601). */
  now: string;
}

export function sourceHealth(input: SourceHealthInput): Health {
  if (input.status === null) {
    return { level: 'ok', reasons: [] }; // not connected
  }
  if (input.status === 'disabled') {
    return {
      level: 'disabled',
      reasons: [{ level: 'disabled', text: 'Disconnected — the connector is disabled and no ingestion runs.' }],
    };
  }
  const reasons: HealthReason[] = [];
  let level: HealthLevel = 'ok';

  if (input.oauthExpiresAt !== null) {
    // Positive: the grant is already in the past (lapsed). Negative: seconds left.
    const sinceExpiry = ageSeconds(input.oauthExpiresAt, input.now);
    if (sinceExpiry !== null && sinceExpiry >= 0) {
      level = worstLevel(level, 'degraded');
      reasons.push({
        level: 'degraded',
        text: 'Authorization grant has lapsed — polls fail until the source is re-authorized.',
      });
    } else if (sinceExpiry !== null && -sinceExpiry <= OAUTH_EXPIRING_WITHIN_SECONDS) {
      level = worstLevel(level, 'attention');
      reasons.push({
        level: 'attention',
        text: 'Authorization grant expires soon — re-authorize to keep ingestion running.',
      });
    }
  }

  if (input.checkpointUpdatedAt === null) {
    level = worstLevel(level, 'attention');
    reasons.push({
      level: 'attention',
      text: 'Never polled — no checkpoint recorded yet, so no evidence has been ingested.',
    });
  }

  switch (input.freshness) {
    case 'stale':
      level = worstLevel(level, 'degraded');
      reasons.push({
        level: 'degraded',
        text: 'Evidence stream is stale against the tenant freshness policy.',
      });
      break;
    case 'aging':
      level = worstLevel(level, 'attention');
      reasons.push({
        level: 'attention',
        text: 'Evidence stream is aging against the tenant freshness policy.',
      });
      break;
    case 'unknown':
      reasons.push({
        level: 'info',
        text: 'No freshness policy resolves for this source — classification is unknown (W006).',
      });
      break;
    case 'current':
      break;
  }

  return { level, reasons };
}

// ---------------------------------------------------------------------------
// Destination health (authorization + delivery ledger state)
// ---------------------------------------------------------------------------

export interface DestinationDeliverySummary {
  total: number;
  pending: number;
  delivered: number;
  failed: number;
  rejected: number;
  lastStatus: DeliveryStatus | null;
  lastAt: string | null;
}

export interface DestinationHealthInput {
  status: DestinationStatus | null;
  /** OAuth grant expiry (ISO 8601; null = non-expiring / credentials auth). */
  oauthExpiresAt: string | null;
  deliveries: DestinationDeliverySummary;
  /** Evaluation instant (ISO 8601). */
  now: string;
}

export function destinationHealth(input: DestinationHealthInput): Health {
  if (input.status === null) {
    return { level: 'ok', reasons: [] }; // not connected
  }
  if (input.status === 'disabled') {
    return {
      level: 'disabled',
      reasons: [
        { level: 'disabled', text: 'Disconnected — dispatch and retries are refused for this destination.' },
      ],
    };
  }
  const reasons: HealthReason[] = [];
  let level: HealthLevel = 'ok';

  if (input.oauthExpiresAt !== null) {
    // Positive: the grant is already in the past (lapsed). Negative: seconds left.
    const sinceExpiry = ageSeconds(input.oauthExpiresAt, input.now);
    if (sinceExpiry !== null && sinceExpiry >= 0) {
      level = worstLevel(level, 'degraded');
      reasons.push({
        level: 'degraded',
        text: 'Authorization grant has lapsed — deliveries fail until the destination is re-authorized.',
      });
    } else if (sinceExpiry !== null && -sinceExpiry <= OAUTH_EXPIRING_WITHIN_SECONDS) {
      level = worstLevel(level, 'attention');
      reasons.push({
        level: 'attention',
        text: 'Authorization grant expires soon — re-authorize to keep deliveries flowing.',
      });
    }
  }

  if (input.deliveries.failed > 0) {
    level = worstLevel(level, 'degraded');
    reasons.push({
      level: 'degraded',
      text: `${input.deliveries.failed} delivery${input.deliveries.failed === 1 ? '' : 's'} failed transiently — retry when ready.`,
    });
  }
  if (input.deliveries.lastStatus === 'rejected') {
    level = worstLevel(level, 'degraded');
    reasons.push({
      level: 'degraded',
      text: 'The newest delivery was rejected — the authority gate forbade it or the provider refused it.',
    });
  }
  if (input.deliveries.pending > 0) {
    reasons.push({
      level: 'info',
      text: `${input.deliveries.pending} delivery${input.deliveries.pending === 1 ? '' : 's'} awaiting the authority gate or a wired transport (pending is the normal state under the default export policy).`,
    });
  }
  if (input.deliveries.total === 0) {
    reasons.push({ level: 'info', text: 'No exports dispatched to this destination yet.' });
  }

  return { level, reasons };
}

// ---------------------------------------------------------------------------
// Shared time arithmetic (strict ISO 8601 inputs; null on unparsable)
// ---------------------------------------------------------------------------

/** `since` − `at` in seconds; negative when `at` is in the future; null when unparsable. */
export function ageSeconds(since: string | null, at: string): number | null {
  if (since === null) return null;
  const sinceMs = Date.parse(since);
  const atMs = Date.parse(at);
  if (Number.isNaN(sinceMs) || Number.isNaN(atMs)) return null;
  return Math.round((atMs - sinceMs) / 1000);
}

/** Compact human age ("3m", "2h", "5d", "never"). */
export function humanAge(at: string | null, now: string): string {
  const seconds = ageSeconds(at, now);
  if (seconds === null) return at === null ? 'never' : '—';
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Count items per health level for the section summary. */
export function countByLevel(levels: HealthLevel[]): Record<HealthLevel, number> {
  const counts: Record<HealthLevel, number> = { ok: 0, attention: 0, degraded: 0, disabled: 0 };
  for (const level of levels) counts[level] += 1;
  return counts;
}
