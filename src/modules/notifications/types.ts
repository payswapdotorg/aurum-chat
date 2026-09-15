// Public domain types of the notifications module (W031 — Notifications).
//
// W031 owns policy-controlled notification delivery:
//
//  1. NOTIFICATION POLICIES (tenant-scoped management controls, keyed by
//     notification kind with a tenant-wide default row and a built-in
//     floor): the delivery class (urgent / digest / escalation), the retry
//     budget and backoff, the dedupe window, the digest window, the
//     acknowledgment requirement and — for the escalation class — the
//     escalation deadline and fallback recipient.
//
//  2. NOTIFICATIONS: one immutable substantive record per notification,
//     carrying the RESOLVED POLICY SNAPSHOT that governs it (later policy
//     edits never rewrite what governed a recorded notification), plus the
//     forward-only lifecycle state (pending → delivered/failed/blocked;
//     delivered → escalating → escalated/escalation_failed; suppressed =
//     dedupe duplicate). Delivery goes through the channels contract
//     (W030) and is gated by the actions authority matrix (W009).
//
//  3. ATTEMPTS + ACKNOWLEDGMENTS: append-only audit — every gate-evaluated
//     delivery attempt (initial/retry/digest/escalation) with its outcome,
//     and the first-wins acknowledgment of a delivered notification.
//
// Everything here is provider-neutral by construction (lock 16): a
// recipient is a canonical channel party (provider key + opaque account
// id), never a provider object. The acting principal is the TenantContext
// principal (opaque string, per the actions/freshness precedent).

import type { ChannelProvider } from '@/modules/channels/contract';

export type { ChannelProvider };

// ---------------------------------------------------------------------------
// Delivery classes and lifecycle
// ---------------------------------------------------------------------------

/**
 * How a notification kind is delivered (W031):
 *  * 'urgent'     — immediately, with policy-bounded retries on transient
 *                   failure;
 *  * 'digest'     — accumulated per (kind, recipient); one combined
 *                   message is delivered per digest window;
 *  * 'escalation' — immediately, demanding acknowledgment; if the deadline
 *                   passes unacknowledged, the notification escalates to
 *                   the policy's fallback recipient.
 */
export type NotificationDeliveryClass = 'urgent' | 'digest' | 'escalation';

/**
 * The forward-only lifecycle of a notification (see migrations/002 for
 * the state-shape invariants the database itself enforces).
 */
export type NotificationStatus =
  | 'pending'
  | 'delivered'
  | 'escalating'
  | 'escalated'
  | 'failed'
  | 'blocked'
  | 'suppressed'
  | 'escalation_failed';

/** Where a policy resolution came from (the resolution trail). */
export type NotificationPolicySource = 'kind' | 'tenant-default' | 'built-in';

// ---------------------------------------------------------------------------
// Recipients (canonical channel parties — provider-neutral, ADR-0015)
// ---------------------------------------------------------------------------

/** The recipient a notification is delivered to. */
export interface NotificationRecipient {
  provider: ChannelProvider;
  /** Canonical, adapter-normalized account id (opaque string). */
  providerAccountId: string;
  displayName?: string | null;
}

/**
 * The fallback recipient an escalation-class notification escalates to.
 * Same canonical shape as the primary recipient.
 */
export type EscalationRecipient = NotificationRecipient;

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped notification policy row. `notificationKind` null is the
 * tenant-wide default governing every kind without its own row.
 *
 * Policies are management controls, not evidence: legitimately updatable,
 * with change history belonging to audit (W046).
 */
export interface NotificationPolicy {
  id: string;
  tenantId: string;
  notificationKind: string | null;
  deliveryClass: NotificationDeliveryClass;
  /** Delivery attempts budget per notification (original recipient). */
  maxAttempts: number;
  /** Fixed delay between delivery attempts. */
  retryBackoffSeconds: number;
  /** 0 disables dedupe; otherwise duplicates within the window suppress. */
  dedupeWindowSeconds: number;
  /** Digest window for digest-class notifications. */
  digestWindowSeconds: number;
  /** Whether delivered notifications of this kind may be acknowledged. */
  requireAcknowledgment: boolean;
  /** Unacknowledged deadline (escalation class only; null otherwise). */
  escalationAfterSeconds: number | null;
  /** Fallback recipient (escalation class only; null otherwise). */
  escalationRecipient: EscalationRecipient | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `setNotificationPolicy` (upsert by kind key). */
export interface SetNotificationPolicyInput {
  /** null/omitted addresses the tenant-wide default row. */
  notificationKind?: string | null;
  deliveryClass?: NotificationDeliveryClass;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  dedupeWindowSeconds?: number;
  digestWindowSeconds?: number;
  requireAcknowledgment?: boolean;
  escalationAfterSeconds?: number | null;
  escalationRecipient?: EscalationRecipient | null;
  note?: string | null;
}

/**
 * The effective rules for one notification kind: what decided
 * (`notificationKind`, `source`, `policy`) plus the resolved field values
 * (the built-in floor's values when no tenant row decided, so a resolved
 * policy is always directly usable).
 */
export interface ResolvedNotificationPolicy {
  notificationKind: string;
  source: NotificationPolicySource;
  /** The policy row that decided, or null when the built-in floor did. */
  policy: NotificationPolicy | null;
  deliveryClass: NotificationDeliveryClass;
  maxAttempts: number;
  retryBackoffSeconds: number;
  dedupeWindowSeconds: number;
  digestWindowSeconds: number;
  requireAcknowledgment: boolean;
  escalationAfterSeconds: number | null;
  escalationRecipient: EscalationRecipient | null;
}

/** Query shape of `getNotificationPolicy` (exact key; null = the default row). */
export interface PolicySubjectQuery {
  notificationKind?: string | null;
}

/** Query shape of `listNotificationPolicies`. */
export interface ListNotificationPoliciesQuery {
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Input shape of `createNotification`. */
export interface CreateNotificationInput {
  /** Canonical kind slug; the resolved policy governs delivery. */
  kind: string;
  recipient: NotificationRecipient;
  /** Headline (1..200 chars). */
  subject: string;
  /** Detail (1..4096 chars). */
  body: string;
  /** Optional structured payload (plain JSON, ≤ 64 KiB). */
  data?: unknown;
  /**
   * Emitter-supplied dedupe key: creating another notification with the
   * same (kind, recipient, key) within the policy's dedupe window
   * records a `suppressed` duplicate instead of delivering again.
   */
  dedupeKey?: string | null;
  /** Optional opaque correlation reference (execution, event, …). */
  correlationId?: string | null;
  /** Optional explicit sending connection (channels contract rules). */
  connectionId?: string | null;
}

/** Result of `createNotification`. */
export interface CreateNotificationResult {
  notification: Notification;
  /** true when the dedupe window suppressed this create as a duplicate. */
  deduped: boolean;
}

/**
 * One notification: the immutable substantive record plus its lifecycle
 * state. `policySource` + the resolved snapshot fields
 * (`deliveryClass` … `escalationRecipient`) are the policy EXACTLY as it
 * governed this notification at creation.
 */
export interface Notification {
  id: string;
  tenantId: string;
  notificationKind: string;
  recipient: NotificationRecipient;
  connectionId: string | null;
  subject: string;
  body: string;
  data: unknown;
  dedupeKey: string | null;
  /** The live notification this duplicate was suppressed against. */
  dedupedOfId: string | null;
  correlationId: string | null;
  createdBy: string;
  createdAt: string;
  policySource: NotificationPolicySource;
  deliveryClass: NotificationDeliveryClass;
  maxAttempts: number;
  retryBackoffSeconds: number;
  dedupeWindowSeconds: number;
  digestWindowSeconds: number;
  requireAcknowledgment: boolean;
  escalationAfterSeconds: number | null;
  escalationRecipient: EscalationRecipient | null;
  status: NotificationStatus;
  /** Delivery attempts made against the original recipient. */
  attemptsCount: number;
  /** Delivery attempts made against the escalation recipient. */
  escalationAttemptsCount: number;
  /** ISO 8601 — when the next attempt may run; null = immediately eligible. */
  nextAttemptAt: string | null;
  /** ISO 8601 — first successful delivery; null exactly while never delivered. */
  deliveredAt: string | null;
  /** ISO 8601 — when the escalation message was delivered; null unless escalated. */
  escalatedAt: string | null;
  /** ISO 8601 — derived acknowledgment marker; the ack row is the truth. */
  acknowledgedAt: string | null;
  /** The authority-gate action request covering the original delivery. */
  actionRequestId: string | null;
  /** The authority-gate action request covering the escalation delivery. */
  escalationActionRequestId: string | null;
  updatedAt: string;
}

/** Query shape of `getNotification`. */
export interface GetNotificationQuery {
  notificationId: string;
}

/** Query shape of `listNotifications`. */
export interface ListNotificationsQuery {
  notificationKind?: string;
  status?: NotificationStatus;
  deliveryClass?: NotificationDeliveryClass;
  provider?: ChannelProvider;
  recipientAccountId?: string;
  dedupeKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listNotificationAttempts`. */
export interface ListNotificationAttemptsQuery {
  notificationId: string;
}

// ---------------------------------------------------------------------------
// Delivery attempts (append-only audit)
// ---------------------------------------------------------------------------

/** What triggered an attempt row. */
export type NotificationAttemptKind = 'initial' | 'retry' | 'digest' | 'escalation';

/** Which delivery target an attempt was aimed at. */
export type NotificationAttemptTarget = 'recipient' | 'escalation';

/** The outcome of one gate-evaluated delivery attempt. */
export type NotificationAttemptOutcome =
  | 'delivered'
  | 'transient_failure'
  | 'permanent_failure'
  | 'blocked';

/**
 * One append-only audit row per gate-evaluated delivery attempt: what was
 * attempted, against whom, what the authority gate decided, what the
 * provider transport reported.
 */
export interface NotificationAttempt {
  id: string;
  tenantId: string;
  notificationId: string;
  /** 1-based sequence position within the notification's attempt audit. */
  attemptNo: number;
  attemptKind: NotificationAttemptKind;
  target: NotificationAttemptTarget;
  /** The party this attempt was delivered to (recipient or escalation). */
  recipient: NotificationRecipient;
  outcome: NotificationAttemptOutcome;
  /** The authority-gate decision covering this attempt. */
  gateStatus: 'approved' | 'rejected';
  /** The provider's own message id for an accepted send, when returned. */
  providerMessageId: string | null;
  detail: string | null;
  attemptedAt: string;
}

// ---------------------------------------------------------------------------
// Acknowledgments (first-wins, append-only)
// ---------------------------------------------------------------------------

/** Input shape of `acknowledgeNotification`. */
export interface AcknowledgeNotificationInput {
  notificationId: string;
  note?: string | null;
}

/** The single acknowledgment of a delivered notification. */
export interface NotificationAcknowledgment {
  id: string;
  tenantId: string;
  notificationId: string;
  /** The principal that acknowledged (TenantContext principal). */
  acknowledgedBy: string;
  note: string | null;
  acknowledgedAt: string;
}

/** Query shape of `getNotificationAcknowledgment`. */
export interface GetNotificationAcknowledgmentQuery {
  notificationId: string;
}

// ---------------------------------------------------------------------------
// Due-processing pumps (explicit worker entrypoints)
// ---------------------------------------------------------------------------

/** Query shape of `retryDueNotifications` (limit counts notifications). */
export interface RetryDueQuery {
  /** 1..100, default 20. */
  limit?: number;
}

/** Query shape of `flushDueDigests` (limit counts digest groups). */
export interface FlushDigestsQuery {
  /** 1..50, default 10. */
  limit?: number;
}

/** Query shape of `escalateUnacknowledged` (limit counts notifications). */
export interface EscalateUnacknowledgedQuery {
  /** 1..100, default 20. */
  limit?: number;
}

/** What one `retryDueNotifications` pass did. */
export interface RetrySummary {
  /** Notifications examined for original-recipient delivery. */
  processed: number;
  /** Escalation deliveries examined (escalating notifications). */
  escalationsProcessed: number;
  delivered: number;
  failed: number;
  blocked: number;
  /** Still waiting (authority gate pending or retry lease not yet due). */
  waiting: number;
  escalated: number;
  escalationFailed: number;
}

/** What one `flushDueDigests` pass did. */
export interface DigestSummary {
  /** Digest groups flushed. */
  groups: number;
  /** Digest messages actually delivered. */
  delivered: number;
  /** Member notifications that reached `delivered`. */
  membersDelivered: number;
  /** Members whose flush attempt failed transiently (retry scheduled). */
  membersWaiting: number;
  /** Members that exhausted their budget or were permanently rejected. */
  membersFailed: number;
  /** Members blocked by the authority gate. */
  membersBlocked: number;
  /** Members still gated (waiting for approval) — stay pending. */
  membersGated: number;
}

/** What one `escalateUnacknowledged` pass did. */
export interface EscalationSummary {
  /** Due unacknowledged notifications moved to `escalating`. */
  escalatedCandidates: number;
  /** Escalation messages delivered (status → `escalated`). */
  escalated: number;
  /** Escalation deliveries that could not complete (→ `escalation_failed`). */
  escalationFailed: number;
  /** Escalations still waiting on the authority gate. */
  waiting: number;
}
