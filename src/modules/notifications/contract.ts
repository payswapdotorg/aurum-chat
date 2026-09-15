// ============================================================================
// notifications — the ONLY public surface of the notifications module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W031 — Notifications:
// "Implement policy-controlled urgent/digest/escalation notification
//  delivery with retries, dedupe, acknowledgment and audit."
//
// THE POLICIES (tenant-scoped management controls, keyed by notification
// kind with a tenant-wide default row and a built-in floor — the
// actions/freshness resolution discipline):
//   setNotificationPolicy / getNotificationPolicy /
//   resolveNotificationPolicy / listNotificationPolicies — the delivery
//      class (urgent = immediate with retries; digest = accumulated per
//      (kind, recipient) into one combined message per digest window;
//      escalation = immediate, demanding acknowledgment, escalating to a
//      fallback recipient past the unacknowledged deadline), the retry
//      budget and backoff, the dedupe window, the digest window, the
//      acknowledgment requirement, and — for the escalation class — the
//      deadline and fallback recipient. Policy writes require the
//      'notifications:administer' claim. Every notification SNAPSHOTS its
//      resolved policy at creation: later policy edits never rewrite what
//      governs a recorded notification.
//
// THE DELIVERY LIFECYCLE:
//   createNotification — the intake path: resolve policy, snapshot it,
//      dedupe (a live notification with the same (kind, recipient,
//      dedupeKey) inside the window is recorded as a `suppressed`
//      duplicate — audited, never delivered), then deliver immediately
//      for urgent/escalation classes; digest class accumulates.
//   retryDueNotifications / flushDueDigests / escalateUnacknowledged —
//      the explicit due-processing pumps (workers call them on a
//      schedule; nothing in this module owns background time). Retries
//      are leased: one pump writes an attempt at a time, the lease is the
//      retry schedule, and delivery is at-least-once.
//   Every delivery — original, digest or escalation — is authorized
//      through the actions authority matrix (W009) under the canonical
//      kind 'notification-delivery' at the ASK level with a STABLE
//      idempotency key per (notification, target): allowed → deliver;
//      approval_required → the notification waits and pumps re-check the
//      same request (a human approval between pumps unlocks delivery);
//      forbidden → the notification is 'blocked', never sent. Sending
//      itself goes through the channels contract (W030 sendOutbound), so
//      every accepted delivery is a canonical channel message with an
//      immutable transcript turn (W029).
//
// THE ACKNOWLEDGMENT:
//   acknowledgeNotification — first-wins, append-only: exactly one
//      acknowledgment per delivered notification that requires one (the
//      escalation class always does); acknowledgment stops a pending
//      escalation. getNotificationAcknowledgment reads it back (null
//      while unacknowledged).
//
// THE AUDIT (append-only, storage-enforced):
//   listNotificationAttempts — one row per gate-evaluated delivery
//      attempt (initial/retry/digest/escalation): the targeted party, the
//      authority decision covering it, the outcome, the provider's
//      receipt. getNotification / listNotifications — the notification
//      feed with policy snapshots and lifecycle state. There is
//      deliberately NO operation to update or erase a notification's
//      substantive record, attempts or acknowledgments (triggers enforce
//      it) — the chain "notification → policy snapshot → authority
//      decision → attempts → outcome → acknowledgment/escalation" stays
//      reconstructable (ARCHITECTURE.md §24).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's notifications,
// attempts, acknowledgments and policies are indistinguishable from
// missing ones — no existence leak.
//
// Dependency posture (work-item DAG: W009 + W030 → W031): this module
// imports the actions contract (the authority gate) and the channels
// contract (delivery + the canonical provider vocabulary) — nothing
// else. The channels module remains the delivery mechanism, never the
// decision authority; this module is the policy/authority integration
// point the channels contract defers to ("the communication-policy
// decision (W009 authority matrix) happened before this call").
// ============================================================================

export {
  acknowledgeNotification,
  createNotification,
  escalateUnacknowledged,
  flushDueDigests,
  getNotification,
  getNotificationAcknowledgment,
  getNotificationPolicy,
  listNotificationAttempts,
  listNotificationPolicies,
  listNotifications,
  resolveNotificationPolicy,
  retryDueNotifications,
  setNotificationPolicy,
} from './service';

export { NotificationsError } from './errors';
export type { NotificationsErrorCode } from './errors';

export {
  BUILT_IN_DEFAULT_POLICY,
  MAX_COMPOSED_TEXT_LENGTH,
  MAX_DIGEST_MEMBERS,
  DIGEST_EXCERPT_LENGTH,
  NOTIFICATION_ACTION_KIND,
  NOTIFICATION_AUTHORITY_LEVEL,
  NOTIFICATION_DELIVERY_CLASSES,
  NOTIFICATION_STATUSES,
  NOTIFICATIONS_AUTHORITY_ADMINISTER,
  builtInDefaultPolicy,
  classifyDeliveryError,
  composeDigestMessage,
  composeEscalationMessage,
  deliveryGateKey,
  escalationGateKey,
  isDigestCycleDue,
  isDedupeWindowOpen,
  isEscalationDue,
  isNotificationDeliveryClass,
  isNotificationStatus,
  recipientLabel,
  resolveNotificationPolicy as resolveNotificationPolicySnapshot,
} from './policy';

export {
  DEFAULT_DIGEST_GROUP_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_RETRY_LIMIT,
  MAX_BODY_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_DATA_BYTES,
  MAX_DEDUPE_KEY_LENGTH,
  MAX_DIGEST_GROUP_LIMIT,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MAX_ATTEMPTS,
  MAX_NOTE_LENGTH,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_RETRY_LIMIT,
  MAX_SUBJECT_LENGTH,
  MIN_DIGEST_WINDOW_SECONDS,
  MIN_ESCALATION_AFTER_SECONDS,
  MIN_MAX_ATTEMPTS,
  MIN_RETRY_BACKOFF_SECONDS,
  canAdministerNotificationPolicies,
  isNotificationKindSlug,
  isUuid,
} from './validation';

export type {
  ValidatedAcknowledgeInput,
  ValidatedCreateNotificationInput,
  ValidatedPolicyInput,
} from './validation';

export type {
  AcknowledgeNotificationInput,
  CreateNotificationInput,
  CreateNotificationResult,
  DigestSummary,
  EscalateUnacknowledgedQuery,
  EscalationRecipient,
  EscalationSummary,
  FlushDigestsQuery,
  GetNotificationAcknowledgmentQuery,
  GetNotificationQuery,
  ListNotificationAttemptsQuery,
  ListNotificationPoliciesQuery,
  ListNotificationsQuery,
  Notification,
  NotificationAcknowledgment,
  NotificationAttempt,
  NotificationAttemptKind,
  NotificationAttemptOutcome,
  NotificationAttemptTarget,
  NotificationDeliveryClass,
  NotificationPolicy,
  NotificationRecipient,
  NotificationStatus,
  PolicySubjectQuery,
  ResolvedNotificationPolicy,
  RetryDueQuery,
  RetrySummary,
  SetNotificationPolicyInput,
} from './types';

// The canonical channel-provider vocabulary is owned by the identity
// module (W002 — ADR-0015 provider-neutral keys) and re-exported through
// the channels contract; it is re-exported here so this contract is
// self-contained for the recipient shape it requires, exactly like the
// channels and conversations contracts do.
export type { ChannelProvider } from '@/modules/channels/contract';
