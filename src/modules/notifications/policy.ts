// Pure policy/delivery logic of the notifications module (W031 —
// Notifications). No database, no context, no time source — everything
// here is a total, deterministic function of its arguments (the same
// discipline as the actions module's matrix.ts): the same policy state
// and the same inputs always yield the same resolution, composition,
// classification and timing answers. No LLM, randomness or hidden state
// participates (ARCHITECTURE.md §2 — application-owned behavior).
//
// Contents:
//  * the delivery-class / status vocabularies (mirrored by the CHECK
//    constraints in migrations/001 and /002);
//  * the BUILT-IN DEFAULT policy — the deterministic floor for tenants
//    that configured no rows (urgent delivery, 3 attempts, 60s backoff,
//    300s dedupe window, 3600s digest window, no acknowledgment, no
//    escalation);
//  * resolveNotificationPolicy — kind row → tenant-default row → built-in
//    (the actions/freshness resolution discipline);
//  * composeDigestMessage / composeEscalationMessage — the canonical
//    message composers, bounded so the channels contract's own content
//    limits can never be exceeded;
//  * classifyDeliveryError — which channels-module outcomes are transient
//    (retryable) and which are permanent;
//  * the W009 authority-gate vocabulary: the action kind/level every
//    notification delivery is authorized under, and the stable
//    idempotency keys that make gate checks replay-safe;
//  * the timing predicates (dedupe window, digest cycle, escalation
//    deadline) with exact boundary semantics.

import type { AuthorityLevel } from '@/modules/actions/contract';
import { ChannelsError } from '@/modules/channels/contract';
import type {
  NotificationDeliveryClass,
  NotificationPolicy,
  NotificationStatus,
  ResolvedNotificationPolicy,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the SQL CHECK constraints)
// ---------------------------------------------------------------------------

/** The three policy-controlled delivery classes (W031). */
export const NOTIFICATION_DELIVERY_CLASSES = ['urgent', 'digest', 'escalation'] as const;

export function isNotificationDeliveryClass(value: unknown): value is NotificationDeliveryClass {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_DELIVERY_CLASSES as readonly string[]).includes(value)
  );
}

/** The forward-only notification lifecycle states. */
export const NOTIFICATION_STATUSES = [
  'pending',
  'delivered',
  'escalating',
  'escalated',
  'failed',
  'blocked',
  'suppressed',
  'escalation_failed',
] as const;

export function isNotificationStatus(value: unknown): value is NotificationStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The built-in default policy (the deterministic floor)
// ---------------------------------------------------------------------------

/**
 * The built-in default: urgent delivery with a modest retry budget, a
 * five-minute dedupe window, a one-hour digest window, no acknowledgment
 * requirement and no escalation. Tenants tighten or relax every field per
 * kind through setNotificationPolicy; the floor never silently overrides
 * tenant policy (the actions module's built-in matrix discipline).
 */
export const BUILT_IN_DEFAULT_POLICY = {
  deliveryClass: 'urgent',
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  dedupeWindowSeconds: 300,
  digestWindowSeconds: 3600,
  requireAcknowledgment: false,
  escalationAfterSeconds: null,
  escalationRecipient: null,
} as const;

/** A fresh copy of the built-in default policy fields. */
export function builtInDefaultPolicy(): Omit<ResolvedNotificationPolicy, 'notificationKind' | 'source' | 'policy'> {
  return {
    deliveryClass: BUILT_IN_DEFAULT_POLICY.deliveryClass,
    maxAttempts: BUILT_IN_DEFAULT_POLICY.maxAttempts,
    retryBackoffSeconds: BUILT_IN_DEFAULT_POLICY.retryBackoffSeconds,
    dedupeWindowSeconds: BUILT_IN_DEFAULT_POLICY.dedupeWindowSeconds,
    digestWindowSeconds: BUILT_IN_DEFAULT_POLICY.digestWindowSeconds,
    requireAcknowledgment: BUILT_IN_DEFAULT_POLICY.requireAcknowledgment,
    escalationAfterSeconds: BUILT_IN_DEFAULT_POLICY.escalationAfterSeconds,
    escalationRecipient: BUILT_IN_DEFAULT_POLICY.escalationRecipient,
  };
}

/**
 * Resolve the effective policy for one notification kind: the kind's row
 * first, then the tenant-wide default row, then the built-in default
 * (deterministic, total — every kind resolves). `policy` is null exactly
 * when the built-in floor decided.
 */
export function resolveNotificationPolicy(
  notificationKind: string,
  kindRow: NotificationPolicy | null,
  defaultRow: NotificationPolicy | null,
): ResolvedNotificationPolicy {
  const decided = kindRow ?? defaultRow;
  if (decided === null) {
    return { notificationKind, source: 'built-in', policy: null, ...builtInDefaultPolicy() };
  }
  return {
    notificationKind,
    source: kindRow !== null ? 'kind' : 'tenant-default',
    policy: decided,
    deliveryClass: decided.deliveryClass,
    maxAttempts: decided.maxAttempts,
    retryBackoffSeconds: decided.retryBackoffSeconds,
    dedupeWindowSeconds: decided.dedupeWindowSeconds,
    digestWindowSeconds: decided.digestWindowSeconds,
    requireAcknowledgment: decided.requireAcknowledgment,
    escalationAfterSeconds: decided.escalationAfterSeconds,
    escalationRecipient: decided.escalationRecipient,
  };
}

// ---------------------------------------------------------------------------
// The W009 authority-gate vocabulary
// ---------------------------------------------------------------------------

/**
 * The canonical action kind every notification delivery is authorized
 * under (W009's open kind namespace — W031 registers its kind by using
 * it, exactly like future modules do). A notification delivered to a
 * human over a channel is an outbound communication; ARCHITECTURE.md §20
 * applies the authority matrix uniformly to those.
 */
export const NOTIFICATION_ACTION_KIND = 'notification-delivery';

/**
 * The authority level notification delivery is evaluated at: a
 * notification requests a human's attention (and, when policy demands it,
 * an acknowledgment) — that is the ASK level of §20, not EXECUTE. Under
 * the built-in matrix ASK is allowed, so notifications flow by default;
 * a tenant that wants every outbound notification gated behind a human
 * approval puts ASK into the approval (or forbidden) levels for
 * 'notification-delivery' — policy-controlled delivery at the authority
 * layer, complementing the notification policy layer.
 */
export const NOTIFICATION_AUTHORITY_LEVEL: AuthorityLevel = 'ASK';

/** Authority claim that manages the tenant's notification policies. */
export const NOTIFICATIONS_AUTHORITY_ADMINISTER = 'notifications:administer';

/**
 * The stable idempotency key of a notification's original-delivery gate
 * request: the gate is authorized once and REPLAYED thereafter — every
 * later attempt re-checks the same request, so a human approval between
 * pumps unlocks delivery without ever duplicating gate history (the
 * actions module's first-write-wins replay semantics).
 */
export function deliveryGateKey(notificationId: string): string {
  return `notification-delivery:${notificationId}`;
}

/** The stable idempotency key of a notification's escalation gate request. */
export function escalationGateKey(notificationId: string): string {
  return `notification-escalation:${notificationId}`;
}

// ---------------------------------------------------------------------------
// Delivery-error classification (W030 transport outcomes)
// ---------------------------------------------------------------------------

/**
 * Channels-module error codes that are TRANSIENT: the delivery may
 * succeed on retry (transport hiccup, or sending-endpoint configuration
 * the tenant can still fix — no active connection yet, an ambiguous
 * connection set, a disabled connection).
 */
const TRANSIENT_CHANNEL_CODES: ReadonlySet<string> = new Set([
  'provider_unavailable',
  'delivery_failed',
  'connection_not_found',
  'connection_ambiguous',
  'connection_disabled',
]);

/**
 * Classify a channels-module rejection: 'transient' failures retry within
 * the policy budget; everything else — the provider's explicit
 * `delivery_rejected` (bad recipient, provider policy) as well as any
 * code indicating a malformed call, which cannot happen through this
 * module's pre-validated path — is 'permanent' and fails the
 * notification immediately without burning the retry budget.
 */
export function classifyDeliveryError(error: ChannelsError): 'transient' | 'permanent' {
  return TRANSIENT_CHANNEL_CODES.has(error.code) ? 'transient' : 'permanent';
}

// ---------------------------------------------------------------------------
// Message composition (canonical, bounded)
// ---------------------------------------------------------------------------

/** Maximum member notifications combined into one digest message. */
export const MAX_DIGEST_MEMBERS = 16;

/** Per-member body excerpt length inside a digest message. */
export const DIGEST_EXCERPT_LENGTH = 240;

/**
 * The channels contract accepts message texts up to 16,384 characters;
 * digest composition is bounded well under it (header + 16 × (timestamp +
 * subject + excerpt + separators) ≈ 8k) so a composed digest can never be
 * rejected for size.
 */
export const MAX_COMPOSED_TEXT_LENGTH = 16_384;

/** One member entry of a digest message. */
export interface DigestMember {
  subject: string;
  body: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** The trailing marker appended when a member's body is excerpted. */
const TRUNCATION_MARKER = '… [truncated]';

function excerpt(body: string): string {
  return body.length <= DIGEST_EXCERPT_LENGTH
    ? body
    : `${body.slice(0, DIGEST_EXCERPT_LENGTH)}${TRUNCATION_MARKER}`;
}

/**
 * Compose the single message a digest flush delivers: a header naming the
 * kind and member count, then one line per member (creation time, subject
 * — excerpt). Excerpts are marked explicitly; nothing is silently
 * dropped. Deterministic in member order (oldest first, by caller).
 */
export function composeDigestMessage(
  notificationKind: string,
  members: readonly DigestMember[],
): { subject: string; text: string } {
  if (members.length === 0) {
    throw new Error('composeDigestMessage requires at least one member (internal invariant violation)');
  }
  if (members.length > MAX_DIGEST_MEMBERS) {
    throw new Error(
      `composeDigestMessage requires at most ${MAX_DIGEST_MEMBERS} members (got ${members.length}) (internal invariant violation)`,
    );
  }
  const subject = `Digest: ${notificationKind} (${members.length} notification${members.length === 1 ? '' : 's'})`;
  const lines = [`Digest of '${notificationKind}' — ${members.length} notification${members.length === 1 ? '' : 's'}:`];
  for (const member of members) {
    lines.push(`• [${member.createdAt}] ${member.subject} — ${excerpt(member.body)}`);
  }
  const text = lines.join('\n');
  if (text.length > MAX_COMPOSED_TEXT_LENGTH || subject.length > 200) {
    throw new Error(
      `composed digest exceeds the delivery bounds (internal invariant violation: text ${text.length}, subject ${subject.length})`,
    );
  }
  return { subject, text };
}

/** Prefix of an escalation message's subject. */
const ESCALATION_SUBJECT_PREFIX = 'Escalation: ';

/**
 * Compose the escalation message delivered to the fallback recipient when
 * an escalation-class notification passes its unacknowledged deadline:
 * the original subject (prefixed and re-bounded) and the original body,
 * followed by an explicit statement of why the escalation fired. The
 * escalation delivery is auditable on its own attempt rows; the message
 * itself carries the reason for the recipient.
 */
export function composeEscalationMessage(
  subject: string,
  body: string,
  recipientLabel: string,
  deliveredAt: string,
  escalationAfterSeconds: number,
): { subject: string; text: string } {
  const boundedSubject = subject.slice(0, 200 - ESCALATION_SUBJECT_PREFIX.length);
  const text =
    `${body}\n\n---\n` +
    `This notification was delivered to ${recipientLabel} at ${deliveredAt} and remains ` +
    `unacknowledged after ${escalationAfterSeconds} seconds; escalating per notification policy.`;
  if (text.length > MAX_COMPOSED_TEXT_LENGTH) {
    throw new Error(
      `composed escalation exceeds the delivery bounds (internal invariant violation: text ${text.length})`,
    );
  }
  return { subject: `${ESCALATION_SUBJECT_PREFIX}${boundedSubject}`, text };
}

/** The canonical label of a recipient inside composed messages. */
export function recipientLabel(provider: string, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

// ---------------------------------------------------------------------------
// Timing predicates (exact boundary semantics)
// ---------------------------------------------------------------------------

function toMs(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

/**
 * Is the dedupe window of a live notification still open at `at`? The
 * window closes the instant `createdAt + windowSeconds` is reached
 * (strictly-open semantics: a duplicate arriving exactly at the boundary
 * starts a new cycle). A zero window disables dedupe entirely.
 */
export function isDedupeWindowOpen(
  originalCreatedAt: Date | string,
  windowSeconds: number,
  at: Date | string,
): boolean {
  if (windowSeconds <= 0) return false;
  return toMs(at) < toMs(originalCreatedAt) + windowSeconds * 1_000;
}

/**
 * Is a digest cycle due at `at`? A cycle is due the instant the oldest
 * pending member's age reaches the digest window (inclusive boundary).
 */
export function isDigestCycleDue(
  oldestMemberCreatedAt: Date | string,
  windowSeconds: number,
  at: Date | string,
): boolean {
  return toMs(at) >= toMs(oldestMemberCreatedAt) + windowSeconds * 1_000;
}

/**
 * Is an escalation due at `at`? Due the instant the time since the first
 * successful delivery reaches the escalation deadline (inclusive
 * boundary) — and only while the notification stays unacknowledged.
 */
export function isEscalationDue(
  deliveredAt: Date | string,
  afterSeconds: number,
  at: Date | string,
): boolean {
  return toMs(at) >= toMs(deliveredAt) + afterSeconds * 1_000;
}

/** When the next delivery attempt may run (fixed policy backoff). */
export function nextRetryAt(from: Date | string, backoffSeconds: number): Date {
  return new Date(toMs(from) + backoffSeconds * 1_000);
}
