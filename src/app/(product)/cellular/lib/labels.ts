// Cellular reachability surface (W104 — J18) — the pure label/format layer.
//
// Everything here is a total function over the cellular module's CONTRACT
// vocabulary (reach statuses, failure codes, attempt statuses, voice
// fallback modes, policy sources, providers): the human copy the pages
// and the tests share, so the vocabularies can never drift (the /ai,
// learning and developer labels discipline). Color never carries meaning
// alone — every status maps to a tone AND a label; the pill component
// pairs them.
//
// THE HONESTY LAW of this surface: no transport is wired by default in
// this environment, so deliveries fail explicitly with
// `provider_unavailable` — a RETRYABLE state the module records on the
// reach and its attempts. The words below report that state exactly as
// the module reports it; nothing here fakes a delivery.

import type { PillTone } from '../../lib/states';
import { CELLULAR_ATTEMPT_STATUSES } from '@/modules/cellular/contract';
import type {
  CellularPolicySource,
  CellularReachStatus,
  CellularVoiceFallbackMode,
} from '@/modules/cellular/contract';

/** The attempt-status vocabulary (derived from the contract's list; test-locked). */
export type AttemptStatus = (typeof CELLULAR_ATTEMPT_STATUSES)[number];

// CLIENT-SAFETY (the shell's navigation.ts discipline): pure functions +
// type-only contract imports — nothing server-only can leak into a
// client bundle through this module.

/** Compact date+time: "Sep 24, 09:00" — falls back to the raw string. */
export function dateTimeLabel(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString('en', { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString(
    'en',
    { hour: '2-digit', minute: '2-digit', hour12: false },
  )}`;
}

/** Provider key → user-facing vendor name. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case 'twilio':
      return 'Twilio';
    case 'telnyx':
      return 'Telnyx';
    default:
      return provider;
  }
}

export function reachStatusLabel(status: CellularReachStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'blocked':
      return 'Blocked';
    case 'sent':
      return 'Sent';
    case 'delivered':
      return 'Delivered';
    case 'replied':
      return 'Replied';
    case 'voice_fallback':
      return 'Voice fallback in flight';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

export function reachStatusTone(status: CellularReachStatus): PillTone {
  switch (status) {
    case 'delivered':
    case 'replied':
      return 'positive';
    case 'sent':
      return 'info';
    case 'awaiting_approval':
      return 'warning';
    case 'voice_fallback':
      return 'warning';
    case 'blocked':
      return 'error';
    case 'failed':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * The failure codes in user words. `provider_unavailable` is THE
 * environment limit this surface reports honestly: retryable, never a
 * faked delivery (the module's own classification, mirrored verbatim).
 */
export function failureCodeLabel(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case 'provider_unavailable':
      return 'provider unavailable (retryable)';
    case 'sms_rejected':
      return 'carrier rejected the message';
    case 'voice_no_answer':
      return 'voice call not answered';
    case 'cost_cap_exceeded':
      return 'cost cap reached';
    case 'no_sms_segments':
      return 'message too long for the policy';
    default:
      return code.replaceAll('_', ' ');
  }
}

export function attemptStatusLabel(status: AttemptStatus): string {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'delivered':
      return 'Delivered';
    case 'undelivered':
      return 'Undelivered';
    case 'rejected':
      return 'Rejected';
    case 'failed':
      return 'Failed (no leg placed)';
    case 'answered':
      return 'Answered';
    case 'no_answer':
      return 'Not answered';
    case 'completed':
      return 'Completed';
    default:
      return status;
  }
}

export function attemptStatusTone(status: AttemptStatus): PillTone {
  switch (status) {
    case 'delivered':
    case 'answered':
    case 'completed':
      return 'positive';
    case 'sent':
      return 'info';
    case 'undelivered':
    case 'rejected':
    case 'failed':
    case 'no_answer':
      return 'error';
    default:
      return 'warning';
  }
}

export function voiceFallbackLabel(mode: CellularVoiceFallbackMode): string {
  switch (mode) {
    case 'forbidden':
      return 'voice fallback forbidden (the floor)';
    case 'on_sms_failure':
      return 'voice when SMS fails';
    default:
      return mode;
  }
}

export function policySourceLabel(source: CellularPolicySource): string {
  switch (source) {
    case 'kind':
      return 'a reach-kind policy row';
    case 'tenant-default':
      return 'the tenant-wide default policy';
    case 'built-in':
      return 'the built-in floor (no tenant policy)';
    default:
      return source;
  }
}

/** Minor units → a readable money string ("5.00 USD" or "free"). */
export function minorUnitsLabel(minor: number, currency: string): string {
  if (minor === 0) return 'free';
  const whole = Math.trunc(minor / 100);
  const rest = (minor % 100).toString().padStart(2, '0');
  return `${whole}.${rest} ${currency}`;
}

/**
 * The standing environment-honesty note (J18's mandatory proof: "the
 * environment limit, recorded as the module reports it"). Unit-pinned so
 * the words are the product.
 */
export const CELLULAR_TRANSPORT_NOTE =
  'Sending is not connected yet in this environment: every delivery attempt reports a clear failure — a retryable state recorded on the reach and on each attempt. This surface reports that state exactly as recorded; it never fakes a delivery.';

/** What the reach feed is, in plain words. */
export const REACH_FEED_NOTE =
  'Every row is a durable request to reach one person by SMS (voice escalation only where policy permits): the message, the authority gate that governs it, the policy snapshot that decided cost and retries, and the delivery state. Blocked requests never re-leave; failed requests reopen as a new cycle when retried.';
