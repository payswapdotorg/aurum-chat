// Pure policy/routing/cost logic of the cellular module (W087 — Cellular
// Reachability and Communication Fallback). No database, no context, no
// time source — everything here is a total, deterministic function of
// its arguments (the actions/notifications module discipline): the same
// tenant policy state and the same inputs always yield the same
// resolution, routing and cost answers. No LLM, randomness or hidden
// state participates (ARCHITECTURE.md §2 — application-owned behavior).
//
// Contents:
//  * the provider/leg/status vocabularies (mirrored by the CHECK
//    constraints in migrations 001–005);
//  * the BUILT-IN DEFAULT policy — the deterministic floor for tenants
//    that configured no rows (voice fallback FORBIDDEN — a voice call is
//    intrusive and costs more, so the tenant opts in; 3 SMS attempts,
//    60s backoff, 4-segment SMS budget, modest cost rates, USD, and a
//    lifetime cost cap per reach);
//  * resolveCellularPolicy — kind row → tenant-default row → built-in
//    (the actions/notifications resolution discipline);
//  * the ROUTING decision — when the SMS leg is terminally failed, does
//    the request fall back to a voice call? A pure function of the
//    policy snapshot (the work item's "falls back to voice when policy
//    permits");
//  * the COST model — SMS segment estimate, per-attempt cost, the
//    lifetime cap check (integer minor units + ISO currency,
//    IMPLEMENTATION-STACK §8);
//  * the W009 authority-gate vocabulary: the action kind a recipient
//    classification is gated under ('employee-messaging' vs
//    'external-communication', both CANONICAL_ACTION_KINDS of the actions
//    matrix — ARCHITECTURE.md §20: "The authority matrix applies
//    uniformly to employee messaging … external communications"), the ASK
//    level (an outbound communication to a human), and the stable
//    idempotency key that makes gate checks replay-safe (the
//    notifications module's discipline).

import type { AuthorityLevel } from '@/modules/actions/contract';
import type {
  CellularPolicy,
  CellularPolicySource,
  CellularProvider,
  CellularReachKind,
  CellularRecipientKind,
  CellularReachStatus,
  CellularVoiceFallbackMode,
  ResolvedCellularPolicy,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the SQL CHECK constraints)
// ---------------------------------------------------------------------------

/** The canonical telecom providers (W087 "multiple telecom adapters"). */
export const CELLULAR_PROVIDERS = ['twilio', 'telnyx'] as const;

export function isCellularProvider(value: unknown): value is CellularProvider {
  return (
    typeof value === 'string' && (CELLULAR_PROVIDERS as readonly string[]).includes(value)
  );
}

/** The two cellular legs one reach request can take. */
export const CELLULAR_LEGS = ['sms', 'voice'] as const;

/** The voice-fallback modes (the routing policy). */
export const CELLULAR_VOICE_FALLBACK_MODES = ['forbidden', 'on_sms_failure'] as const;

export function isCellularVoiceFallbackMode(
  value: unknown,
): value is CellularVoiceFallbackMode {
  return (
    typeof value === 'string' &&
    (CELLULAR_VOICE_FALLBACK_MODES as readonly string[]).includes(value)
  );
}

/** The outcome kinds (the policy key). */
export const CELLULAR_REACH_KINDS = ['tell', 'ask'] as const;

export function isCellularReachKind(value: unknown): value is CellularReachKind {
  return (
    typeof value === 'string' && (CELLULAR_REACH_KINDS as readonly string[]).includes(value)
  );
}

/** The honest recipient classifications (drives the authority-gate kind). */
export const CELLULAR_RECIPIENT_KINDS = [
  'verified_employee',
  'verified_person',
  'unverified_identity',
  'unknown_number',
] as const;

/** The reach-request lifecycle (current delivery state). */
export const CELLULAR_REACH_STATUSES = [
  'pending',
  'awaiting_approval',
  'blocked',
  'sent',
  'delivered',
  'replied',
  'voice_fallback',
  'failed',
] as const;

export function isCellularReachStatus(value: unknown): value is CellularReachStatus {
  return (
    typeof value === 'string' &&
    (CELLULAR_REACH_STATUSES as readonly string[]).includes(value)
  );
}

/** The failure codes of a terminally failed request. */
export const CELLULAR_FAILURE_CODES = [
  'sms_rejected',
  'sms_attempts_exhausted',
  'cost_cap_exceeded',
  'voice_not_permitted',
  'voice_no_answer',
  'voice_failed',
  'provider_unavailable',
] as const;

/** The attempt lifecycle states. */
export const CELLULAR_ATTEMPT_STATUSES = [
  'sent',
  'delivered',
  'undelivered',
  'rejected',
  'failed',
  'answered',
  'no_answer',
  'completed',
] as const;

/** The connection lifecycle. */
export const CELLULAR_CONNECTION_STATUSES = ['active', 'disabled'] as const;

/** The policy resolution sources. */
export const CELLULAR_POLICY_SOURCES = ['kind', 'tenant-default', 'built-in'] as const;

// ---------------------------------------------------------------------------
// The built-in default policy (the deterministic floor)
// ---------------------------------------------------------------------------

/**
 * The built-in default: voice fallback is FORBIDDEN (a voice call is
 * intrusive and costs more — the tenant opts in per the work item's
 * "when policy permits"), a modest SMS retry budget with 60s backoff, a
 * four-segment SMS budget, modest per-segment/per-minute cost estimates
 * in USD, and a lifetime cost cap per reach request. Tenants tighten or
 * relax every field per kind through setCellularPolicy; the floor never
 * silently overrides tenant policy (the actions/notifications discipline).
 */
export const BUILT_IN_DEFAULT_POLICY = {
  voiceFallback: 'forbidden' as CellularVoiceFallbackMode,
  smsMaxAttempts: 3,
  retryBackoffSeconds: 60,
  maxSmsSegments: 4,
  smsSegmentCostMinor: 5,
  voicePerMinuteCostMinor: 150,
  currency: 'USD',
  maxCostPerReachMinor: 1000,
} as const;

// ---------------------------------------------------------------------------
// Policy resolution (kind row → tenant-default row → built-in)
// ---------------------------------------------------------------------------

interface PolicyLikeRow {
  reachKind: CellularReachKind | null;
  voiceFallback: CellularVoiceFallbackMode;
  smsMaxAttempts: number;
  retryBackoffSeconds: number;
  maxSmsSegments: number;
  smsSegmentCostMinor: number;
  voicePerMinuteCostMinor: number;
  currency: string;
  maxCostPerReachMinor: number;
}

/**
 * Resolve the effective policy for one reach kind from the tenant's rows.
 * Pure: given the same rows and kind, the same resolution comes back.
 */
export function resolveCellularPolicyRows(
  reachKind: CellularReachKind,
  rows: PolicyLikeRow[],
): { source: CellularPolicySource; policy: CellularPolicy | null; resolved: ResolvedCellularPolicy } {
  const kindRow = rows.find((row) => row.reachKind === reachKind) ?? null;
  const defaultRow = rows.find((row) => row.reachKind === null) ?? null;
  const deciding = kindRow ?? defaultRow;
  const source: CellularPolicySource = kindRow !== null ? 'kind' : defaultRow !== null ? 'tenant-default' : 'built-in';
  const base = deciding ?? {
    reachKind: null,
    voiceFallback: BUILT_IN_DEFAULT_POLICY.voiceFallback,
    smsMaxAttempts: BUILT_IN_DEFAULT_POLICY.smsMaxAttempts,
    retryBackoffSeconds: BUILT_IN_DEFAULT_POLICY.retryBackoffSeconds,
    maxSmsSegments: BUILT_IN_DEFAULT_POLICY.maxSmsSegments,
    smsSegmentCostMinor: BUILT_IN_DEFAULT_POLICY.smsSegmentCostMinor,
    voicePerMinuteCostMinor: BUILT_IN_DEFAULT_POLICY.voicePerMinuteCostMinor,
    currency: BUILT_IN_DEFAULT_POLICY.currency,
    maxCostPerReachMinor: BUILT_IN_DEFAULT_POLICY.maxCostPerReachMinor,
  };
  return {
    source,
    policy: (deciding as CellularPolicy | null) ?? null,
    resolved: {
      reachKind,
      source,
      policy: deciding as CellularPolicy | null,
      voiceFallback: base.voiceFallback,
      smsMaxAttempts: base.smsMaxAttempts,
      retryBackoffSeconds: base.retryBackoffSeconds,
      maxSmsSegments: base.maxSmsSegments,
      smsSegmentCostMinor: base.smsSegmentCostMinor,
      voicePerMinuteCostMinor: base.voicePerMinuteCostMinor,
      currency: base.currency,
      maxCostPerReachMinor: base.maxCostPerReachMinor,
    },
  };
}

// ---------------------------------------------------------------------------
// Routing (the voice-fallback decision)
// ---------------------------------------------------------------------------

/**
 * The ROUTING decision (the outcome-oriented core of W087): the SMS leg
 * of a reach request has terminally failed — does the request fall back
 * to a voice call? A pure function of the request's POLICY SNAPSHOT
 * (the snapshot's voice-fallback mode).
 */
export function shouldFallBackToVoice(voiceFallback: CellularVoiceFallbackMode): boolean {
  return voiceFallback === 'on_sms_failure';
}

// ---------------------------------------------------------------------------
// The cost model (integer minor units + ISO currency)
// ---------------------------------------------------------------------------

/** Characters per SMS segment — the policy-level cost approximation. */
export const SMS_SEGMENT_CHARACTERS = 160;

/**
 * The SMS segment estimate of one text: ceil(characters / 160), the
 * policy-level approximation this module uses for cost and length
 * control. The real GSM-7/UCS-2 encoding math is the vendor transport's
 * business at the wire — never a domain concern (lock 16).
 */
export function smsSegmentsOf(text: string): number {
  const characters = Array.from(text).length;
  return Math.max(1, Math.ceil(characters / SMS_SEGMENT_CHARACTERS));
}

/** The estimated cost of one SMS attempt, minor units (rate × segments). */
export function smsAttemptCostMinor(segments: number, smsSegmentCostMinor: number): number {
  return segments * smsSegmentCostMinor;
}

/** The estimated cost of one voice attempt (one-minute estimate), minor units. */
export function voiceAttemptCostMinor(voicePerMinuteCostMinor: number): number {
  return voicePerMinuteCostMinor;
}

/**
 * Does the projected cumulative cost of the next attempt still fit the
 * request's lifetime cap? (maxCostPerReachMinor 0 = uncapped.)
 */
export function fitsCostCap(
  costMinorTotal: number,
  nextAttemptCostMinor: number,
  maxCostPerReachMinor: number,
): boolean {
  if (maxCostPerReachMinor <= 0) return true;
  return costMinorTotal + nextAttemptCostMinor <= maxCostPerReachMinor;
}

// ---------------------------------------------------------------------------
// The W009 authority-gate vocabulary
// ---------------------------------------------------------------------------

/**
 * The action kind a recipient classification is gated under — both are
 * CANONICAL_ACTION_KINDS of the actions matrix (ARCHITECTURE.md §20):
 * reaching a verified EMPLOYEE is employee messaging; reaching anyone
 * else (external contact, unverified identity, raw number) is an
 * external communication.
 */
export function reachActionKindFor(recipientKind: CellularRecipientKind): string {
  return recipientKind === 'verified_employee' ? 'employee-messaging' : 'external-communication';
}

/** The authority level every reach request is gated at (an outbound
 *  communication to a human — the notifications module's ASK discipline). */
export const CELLULAR_REACH_AUTHORITY_LEVEL: AuthorityLevel = 'ASK';

/** The stable idempotency key of a reach request's authority-gate request. */
export function reachGateKey(reachRequestId: string): string {
  return `cellular-reach:${reachRequestId}`;
}

/** The notification kind a terminal reach failure/blocking notifies as. */
export const CELLULAR_FAILURE_NOTIFICATION_KIND = 'cellular-reach-failed';

/** The authority claim that manages the tenant's cellular policies. */
export const CELLULAR_AUTHORITY_ADMINISTER = 'cellular:administer';
