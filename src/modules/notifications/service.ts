// Implementation of the notifications module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`notification_not_found` / `policy_not_found`), no
// existence leak.
//
// W031 acceptance — "policy-controlled urgent/digest/escalation
// notification delivery with retries, dedupe, acknowledgment and audit" —
// is carried by these deliberate properties, all tested:
//   1. POLICY-CONTROLLED: the resolved policy (kind row → tenant default →
//      built-in floor) is snapshotted onto every notification at creation;
//      later policy edits never rewrite what governs a recorded
//      notification. Delivery CLASS (urgent/digest/escalation), retry
//      budget, backoff, dedupe window, digest window, acknowledgment
//      requirement and escalation configuration all come from that
//      snapshot;
//   2. AUTHORITY-GATED (W009): every delivery — original, digest or
//      escalation — is authorized through the actions module's matrix
//      under 'notification-delivery' at the ASK level, with a STABLE
//      idempotency key per (notification, target): allowed → deliver,
//      approval_required → the notification waits and every pump re-checks
//      the same request (a human approval between pumps unlocks delivery;
//      gate history is never duplicated), forbidden → the notification is
//      'blocked' and never sent;
//   3. DELIVERED THROUGH W030: sending goes through the channels contract
//      (sendOutbound), so every accepted delivery is a canonical channel
//      message with an immutable transcript turn (W029). Transient
//      transport outcomes retry within the policy budget; the provider's
//      explicit rejection fails the notification without burning retries;
//   4. RETRIES ARE LEASED: a claim UPDATE (status + next_attempt_at guard)
//      makes one pump the single writer of an attempt; the lease doubles
//      as the retry schedule. Delivery is therefore at-least-once — a
//      crash between send and record re-sends on the next pass — which is
//      the honest semantics for notification delivery;
//   5. DEDUPE IS AUDITED, NOT SILENT: a duplicate within the window is
//      recorded as a `suppressed` notification pointing at the live
//      original — never delivered, never lost;
//   6. ESCALATION DEMANDS ACKNOWLEDGMENT: escalation-class notifications
//      that pass their unacknowledged deadline escalate to the policy's
//      fallback recipient exactly once; acknowledgment (first-wins,
//      append-only) stops the escalation;
//   7. EVERYTHING IS AUDITABLE: one append-only attempt row per
//      gate-evaluated delivery attempt, an append-only first-wins
//      acknowledgment, and a substantive record that is immutable history
//      at the storage level (triggers) — the chain "notification → policy
//      snapshot → authority decision → delivery attempts → outcome →
//      acknowledgment/escalation" is reconstructable (ARCHITECTURE.md §24).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  type ActionRequest,
} from '@/modules/actions/contract';
import { ChannelsError, sendOutbound, type ChannelProvider } from '@/modules/channels/contract';
import { NotificationsError } from './errors';
import {
  classifyDeliveryError,
  composeDigestMessage,
  composeEscalationMessage,
  deliveryGateKey,
  escalationGateKey,
  isDigestCycleDue,
  MAX_DIGEST_MEMBERS,
  NOTIFICATION_ACTION_KIND,
  NOTIFICATION_AUTHORITY_LEVEL,
  recipientLabel,
  resolveNotificationPolicy as resolvePolicySnapshot,
} from './policy';
import {
  assertNotificationsTenantContext,
  canAdministerNotificationPolicies,
  validateAcknowledgeNotificationInput,
  validateCreateNotificationInput,
  validateEscalateUnacknowledgedQuery,
  validateFlushDigestsQuery,
  validateGetNotificationAcknowledgmentQuery,
  validateGetNotificationQuery,
  validateListNotificationAttemptsQuery,
  validateListNotificationPoliciesQuery,
  validateListNotificationsQuery,
  validatePolicySubjectQuery,
  validateRetryDueQuery,
  validateSetNotificationPolicyInput,
  type ValidatedPolicyInput,
} from './validation';
import type {
  DigestSummary,
  EscalationRecipient,
  EscalationSummary,
  Notification,
  NotificationAcknowledgment,
  NotificationAttempt,
  NotificationAttemptKind,
  NotificationAttemptOutcome,
  NotificationPolicy,
  NotificationRecipient,
  NotificationStatus,
  ResolvedNotificationPolicy,
  RetrySummary,
  SetNotificationPolicyInput,
  CreateNotificationInput,
  AcknowledgeNotificationInput,
  GetNotificationQuery,
  ListNotificationAttemptsQuery,
  ListNotificationPoliciesQuery,
  ListNotificationsQuery,
  PolicySubjectQuery,
  RetryDueQuery,
  FlushDigestsQuery,
  EscalateUnacknowledgedQuery,
  GetNotificationAcknowledgmentQuery,
} from './types';

// ---------------------------------------------------------------------------
// Rows + mapping
// ---------------------------------------------------------------------------

interface PolicyRow extends DbRow {
  id: string;
  tenant_id: string;
  notification_kind: string | null;
  delivery_class: string;
  max_attempts: number;
  retry_backoff_seconds: number;
  dedupe_window_seconds: number;
  digest_window_seconds: number;
  require_acknowledgment: boolean;
  escalation_after_seconds: number | null;
  escalation_recipient: unknown;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface NotificationRow extends DbRow {
  id: string;
  tenant_id: string;
  notification_kind: string;
  recipient_provider: string;
  recipient_account_id: string;
  recipient_display_name: string | null;
  connection_id: string | null;
  subject: string;
  body: string;
  data: unknown;
  dedupe_key: string | null;
  deduped_of_id: string | null;
  correlation_id: string | null;
  created_by: string;
  created_at: Date | string;
  policy_source: string;
  delivery_class: string;
  max_attempts: number;
  retry_backoff_seconds: number;
  dedupe_window_seconds: number;
  digest_window_seconds: number;
  require_acknowledgment: boolean;
  escalation_after_seconds: number | null;
  escalation_recipient: unknown;
  status: string;
  attempts_count: number;
  escalation_attempts_count: number;
  next_attempt_at: Date | string | null;
  delivered_at: Date | string | null;
  escalated_at: Date | string | null;
  acknowledged_at: Date | string | null;
  action_request_id: string | null;
  escalation_action_request_id: string | null;
  updated_at: Date | string;
}

interface AttemptRow extends DbRow {
  id: string;
  tenant_id: string;
  notification_id: string;
  attempt_no: number;
  attempt_kind: string;
  target: string;
  provider: string;
  provider_account_id: string;
  display_name: string | null;
  outcome: string;
  gate_status: string;
  provider_message_id: string | null;
  detail: string | null;
  attempted_at: Date | string;
}

interface AckRow extends DbRow {
  id: string;
  tenant_id: string;
  notification_id: string;
  acknowledged_by: string;
  note: string | null;
  acknowledged_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapEscalationRecipient(value: unknown): EscalationRecipient | null {
  if (value === null || value === undefined) return null;
  const raw = value as { provider: string; providerAccountId: string; displayName?: string | null };
  return {
    provider: raw.provider as ChannelProvider, // CHECK-constrained at write time
    providerAccountId: raw.providerAccountId,
    displayName: raw.displayName ?? null,
  };
}

/**
 * Canonical JSON of a channel party: a null display name is OMITTED (the
 * storage-level shape CHECK treats an explicit JSON-null display name as
 * absent, but the canonical form simply leaves the key out).
 */
function serializeRecipient(recipient: NotificationRecipient | EscalationRecipient): string {
  const displayName = recipient.displayName ?? null;
  return displayName === null
    ? JSON.stringify({ provider: recipient.provider, providerAccountId: recipient.providerAccountId })
    : JSON.stringify({
        provider: recipient.provider,
        providerAccountId: recipient.providerAccountId,
        displayName,
      });
}

function mapPolicy(row: PolicyRow): NotificationPolicy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    notificationKind: row.notification_kind,
    deliveryClass: row.delivery_class as NotificationPolicy['deliveryClass'], // CHECK-constrained
    maxAttempts: row.max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    dedupeWindowSeconds: row.dedupe_window_seconds,
    digestWindowSeconds: row.digest_window_seconds,
    requireAcknowledgment: row.require_acknowledgment,
    escalationAfterSeconds: row.escalation_after_seconds,
    escalationRecipient: mapEscalationRecipient(row.escalation_recipient),
    note: row.note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    notificationKind: row.notification_kind,
    recipient: {
      provider: row.recipient_provider as NotificationRecipient['provider'], // CHECK-constrained
      providerAccountId: row.recipient_account_id,
      displayName: row.recipient_display_name,
    },
    connectionId: row.connection_id,
    subject: row.subject,
    body: row.body,
    data: row.data,
    dedupeKey: row.dedupe_key,
    dedupedOfId: row.deduped_of_id,
    correlationId: row.correlation_id,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    policySource: row.policy_source as Notification['policySource'], // CHECK-constrained
    deliveryClass: row.delivery_class as Notification['deliveryClass'], // CHECK-constrained
    maxAttempts: row.max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    dedupeWindowSeconds: row.dedupe_window_seconds,
    digestWindowSeconds: row.digest_window_seconds,
    requireAcknowledgment: row.require_acknowledgment,
    escalationAfterSeconds: row.escalation_after_seconds,
    escalationRecipient: mapEscalationRecipient(row.escalation_recipient),
    status: row.status as NotificationStatus, // CHECK-constrained
    attemptsCount: row.attempts_count,
    escalationAttemptsCount: row.escalation_attempts_count,
    nextAttemptAt: toIsoOrNull(row.next_attempt_at),
    deliveredAt: toIsoOrNull(row.delivered_at),
    escalatedAt: toIsoOrNull(row.escalated_at),
    acknowledgedAt: toIsoOrNull(row.acknowledged_at),
    actionRequestId: row.action_request_id,
    escalationActionRequestId: row.escalation_action_request_id,
    updatedAt: toIso(row.updated_at),
  };
}

function mapAttempt(row: AttemptRow): NotificationAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    notificationId: row.notification_id,
    attemptNo: row.attempt_no,
    attemptKind: row.attempt_kind as NotificationAttemptKind, // CHECK-constrained
    target: row.target as NotificationAttempt['target'], // CHECK-constrained
    recipient: {
      provider: row.provider as NotificationRecipient['provider'], // CHECK-constrained
      providerAccountId: row.provider_account_id,
      displayName: row.display_name,
    },
    outcome: row.outcome as NotificationAttemptOutcome, // CHECK-constrained
    gateStatus: row.gate_status as NotificationAttempt['gateStatus'], // CHECK-constrained
    providerMessageId: row.provider_message_id,
    detail: row.detail,
    attemptedAt: toIso(row.attempted_at),
  };
}

function mapAck(row: AckRow): NotificationAcknowledgment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    notificationId: row.notification_id,
    acknowledgedBy: row.acknowledged_by,
    note: row.note,
    acknowledgedAt: toIso(row.acknowledged_at),
  };
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Statuses of a live notification that still carry its information out. */
const DEDUPE_LIVE_STATUSES = "('pending','delivered','escalating','escalated','escalation_failed')";

function recipientOf(row: NotificationRow): NotificationRecipient {
  return {
    provider: row.recipient_provider as ChannelProvider, // CHECK-constrained
    providerAccountId: row.recipient_account_id,
    displayName: row.recipient_display_name,
  };
}

async function findNotificationRow(
  ctx: TenantContext,
  notificationId: string,
): Promise<NotificationRow | null> {
  const rows = await getDb().query<NotificationRow>(
    `SELECT * FROM notifications WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, notificationId],
  );
  return rows.rows[0] ?? null;
}

/**
 * The W009 authority gate every delivery passes through. The idempotency
 * key is stable per (notification, target), so the request is authorized
 * ONCE and replayed ever after — re-checks return the request's CURRENT
 * status, which is exactly how a human approval between pumps unlocks a
 * gated notification without duplicating gate history.
 */
async function authorizeDeliveryGate(
  ctx: TenantContext,
  input: {
    idempotencyKey: string;
    notificationId: string;
    kind: string;
    subject: string;
    deliveryClass: string;
    purpose: 'delivery' | 'escalation';
    target: NotificationRecipient;
    escalationTarget?: EscalationRecipient | null;
  },
): Promise<ActionRequest> {
  const escalationTarget = input.escalationTarget ?? null;
  let justification: string;
  if (input.purpose === 'delivery') {
    justification = `deliver '${input.kind}' notification to ${recipientLabel(input.target.provider, input.target.providerAccountId)}`;
  } else if (escalationTarget === null) {
    // Unreachable: the escalation path always passes its fallback target.
    throw new Error(
      'escalation gate authorization requires an escalation target (internal invariant violation)',
    );
  } else {
    justification = `escalate unacknowledged '${input.kind}' notification to ${recipientLabel(escalationTarget.provider, escalationTarget.providerAccountId)}`;
  }
  try {
    return await authorizeAction(ctx, {
      actionKind: NOTIFICATION_ACTION_KIND,
      authorityLevel: NOTIFICATION_AUTHORITY_LEVEL,
      payload: {
        notificationId: input.notificationId,
        kind: input.kind,
        subject: input.subject,
        deliveryClass: input.deliveryClass,
        purpose: input.purpose,
        recipient: {
          provider: input.target.provider,
          providerAccountId: input.target.providerAccountId,
        },
        ...(escalationTarget === null
          ? {}
          : {
              escalationRecipient: {
                provider: escalationTarget.provider,
                providerAccountId: escalationTarget.providerAccountId,
              },
            }),
      },
      justification,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      // Our gate inputs are pre-validated; a rejection here contradicts
      // the actions contract — stay loud rather than silently undelivered.
      throw new Error(
        `the authority gate rejected a pre-validated notification authorization (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Persist the first gate-request id (one-way NULL → value). */
async function recordGateRequest(
  db: Queryable,
  ctx: TenantContext,
  notificationId: string,
  column: 'action_request_id' | 'escalation_action_request_id',
  requestId: string,
  at: Date,
): Promise<void> {
  await db.query(
    `UPDATE notifications SET ${column} = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND ${column} IS NULL`,
    [ctx.tenantId, notificationId, requestId, at],
  );
}

/** Append one attempt row (the append-only delivery audit). */
async function recordAttempt(
  db: Queryable,
  ctx: TenantContext,
  row: NotificationRow,
  input: {
    attemptKind: NotificationAttemptKind;
    target: 'recipient' | 'escalation';
    recipient: NotificationRecipient;
    outcome: NotificationAttemptOutcome;
    gateStatus: 'approved' | 'rejected';
    providerMessageId: string | null;
    detail: string | null;
  },
  at: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_attempts (
       tenant_id, notification_id, attempt_no, attempt_kind, target,
       provider, provider_account_id, display_name,
       outcome, gate_status, provider_message_id, detail, attempted_at
     ) VALUES ($1, $2,
       (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM notification_attempts
          WHERE tenant_id = $1 AND notification_id = $2),
       $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      ctx.tenantId,
      row.id,
      input.attemptKind,
      input.target,
      input.recipient.provider,
      input.recipient.providerAccountId,
      input.recipient.displayName ?? null,
      input.outcome,
      input.gateStatus,
      input.providerMessageId,
      input.detail,
      at,
    ],
  );
}

/** One send through the channels contract; classifies channels rejections. */
async function sendThroughChannel(
  ctx: TenantContext,
  input: {
    provider: ChannelProvider;
    providerAccountId: string;
    displayName: string | null;
    connectionId: string | null;
    subject: string;
    text: string;
  },
): Promise<
  | { delivered: true; providerMessageId: string | null }
  | { delivered: false; retryable: boolean; detail: string }
> {
  try {
    const result = await sendOutbound(ctx, {
      provider: input.provider,
      connectionId: input.connectionId,
      to: {
        providerAccountId: input.providerAccountId,
        displayName: input.displayName,
      },
      content: { text: input.text, attachments: [] },
      subject: input.subject,
    });
    return { delivered: true, providerMessageId: result.receipt.providerMessageId };
  } catch (error) {
    if (error instanceof ChannelsError) {
      const kind = classifyDeliveryError(error);
      return { delivered: false, retryable: kind === 'transient', detail: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

async function lookupPolicyRow(
  ctx: TenantContext,
  notificationKind: string | null,
): Promise<PolicyRow | null> {
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM notification_policies
       WHERE tenant_id = $1 AND notification_kind IS NOT DISTINCT FROM $2`,
    [ctx.tenantId, notificationKind],
  );
  return rows.rows[0] ?? null;
}

async function resolvePolicy(
  ctx: TenantContext,
  notificationKind: string,
): Promise<ResolvedNotificationPolicy> {
  const kindRow = await lookupPolicyRow(ctx, notificationKind);
  const defaultRow = kindRow !== null ? null : await lookupPolicyRow(ctx, null);
  return resolvePolicySnapshot(
    notificationKind,
    kindRow === null ? null : mapPolicy(kindRow),
    defaultRow === null ? null : mapPolicy(defaultRow),
  );
}

export async function setNotificationPolicy(
  ctx: TenantContext,
  input: SetNotificationPolicyInput,
): Promise<NotificationPolicy> {
  assertNotificationsTenantContext(ctx);
  // Notification policies control the delivery behavior of consequential
  // outbound communications (and their acknowledgment/escalation): only
  // holders of the administer claim may tighten or relax them
  // (authorization before input parsing — unauthorized callers learn
  // nothing about shapes).
  if (!canAdministerNotificationPolicies(ctx.authority)) {
    throw new NotificationsError(
      'forbidden',
      `this operation requires the 'notifications:administer' authority claim`,
    );
  }
  const valid: ValidatedPolicyInput = validateSetNotificationPolicyInput(input);
  const timestamp = now();
  const escalationRecipient =
    valid.escalationRecipient === null ? null : serializeRecipient(valid.escalationRecipient);

  return getDb().transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM notification_policies
         WHERE tenant_id = $1 AND notification_kind IS NOT DISTINCT FROM $2`,
      [ctx.tenantId, valid.notificationKind],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<PolicyRow>(
        `UPDATE notification_policies SET
           delivery_class = $3, max_attempts = $4, retry_backoff_seconds = $5,
           dedupe_window_seconds = $6, digest_window_seconds = $7,
           require_acknowledgment = $8, escalation_after_seconds = $9,
           escalation_recipient = $10::jsonb, note = $11, updated_at = $12
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          existingId,
          valid.deliveryClass,
          valid.maxAttempts,
          valid.retryBackoffSeconds,
          valid.dedupeWindowSeconds,
          valid.digestWindowSeconds,
          valid.requireAcknowledgment,
          valid.escalationAfterSeconds,
          escalationRecipient,
          valid.note,
          timestamp,
        ],
      );
      return mapPolicy(updated.rows[0]!);
    }
    let inserted;
    try {
      inserted = await tx.query<PolicyRow>(
        `INSERT INTO notification_policies (
           tenant_id, notification_kind, delivery_class, max_attempts,
           retry_backoff_seconds, dedupe_window_seconds, digest_window_seconds,
           require_acknowledgment, escalation_after_seconds, escalation_recipient,
           note, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $12)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.notificationKind,
          valid.deliveryClass,
          valid.maxAttempts,
          valid.retryBackoffSeconds,
          valid.dedupeWindowSeconds,
          valid.digestWindowSeconds,
          valid.requireAcknowledgment,
          valid.escalationAfterSeconds,
          escalationRecipient,
          valid.note,
          timestamp,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'notification_policies')) {
        throw new NotificationsError(
          'policy_conflict',
          'a notification policy for this kind was created concurrently; retry the set operation',
        );
      }
      throw error;
    }
    return mapPolicy(inserted.rows[0]!);
  });
}

export async function getNotificationPolicy(
  ctx: TenantContext,
  query: PolicySubjectQuery,
): Promise<NotificationPolicy> {
  assertNotificationsTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  const row = await lookupPolicyRow(ctx, valid.notificationKind);
  if (row === null) {
    throw new NotificationsError(
      'policy_not_found',
      `no notification policy for kind '${valid.notificationKind ?? 'default'}' exists in this tenant`,
    );
  }
  return mapPolicy(row);
}

export async function resolveNotificationPolicy(
  ctx: TenantContext,
  query: PolicySubjectQuery,
): Promise<ResolvedNotificationPolicy> {
  assertNotificationsTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  // Resolution needs a concrete kind to resolve FOR; the default row is
  // the fallback inside the resolution, never its subject.
  if (valid.notificationKind === null) {
    throw new NotificationsError(
      'invalid_policy_query',
      'query.notificationKind is required for resolution — resolution falls back to the tenant default, it cannot address the default row itself',
    );
  }
  return resolvePolicy(ctx, valid.notificationKind);
}

export async function listNotificationPolicies(
  ctx: TenantContext,
  query: ListNotificationPoliciesQuery,
): Promise<NotificationPolicy[]> {
  assertNotificationsTenantContext(ctx);
  const valid = validateListNotificationPoliciesQuery(query);
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM notification_policies
       WHERE tenant_id = $1
       ORDER BY notification_kind ASC NULLS FIRST, id ASC
       LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map(mapPolicy);
}

// ---------------------------------------------------------------------------
// createNotification
// ---------------------------------------------------------------------------

const NOTIFICATION_INSERT_SQL = `INSERT INTO notifications (
     tenant_id, notification_kind, recipient_provider, recipient_account_id,
     recipient_display_name, connection_id, subject, body, data,
     dedupe_key, deduped_of_id, correlation_id, created_by, created_at,
     policy_source, delivery_class, max_attempts, retry_backoff_seconds,
     dedupe_window_seconds, digest_window_seconds, require_acknowledgment,
     escalation_after_seconds, escalation_recipient, status,
     attempts_count, escalation_attempts_count, next_attempt_at,
     delivered_at, escalated_at, acknowledged_at, action_request_id,
     escalation_action_request_id, updated_at
   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24,
             0, 0, NULL, NULL, NULL, NULL, NULL, NULL, $14)
   RETURNING *`;

function notificationInsertParams(
  ctx: TenantContext,
  valid: ReturnType<typeof validateCreateNotificationInput>,
  resolved: ResolvedNotificationPolicy,
  dedupedOfId: string | null,
  at: Date,
): unknown[] {
  return [
    ctx.tenantId,
    valid.kind,
    valid.recipient.provider,
    valid.recipient.providerAccountId,
    valid.recipient.displayName,
    valid.connectionId,
    valid.subject,
    valid.body,
    valid.data === null ? null : JSON.stringify(valid.data),
    valid.dedupeKey,
    dedupedOfId,
    valid.correlationId,
    ctx.principalId,
    at,
    resolved.source,
    resolved.deliveryClass,
    resolved.maxAttempts,
    resolved.retryBackoffSeconds,
    resolved.dedupeWindowSeconds,
    resolved.digestWindowSeconds,
    resolved.requireAcknowledgment,
    resolved.escalationAfterSeconds,
    resolved.escalationRecipient === null ? null : serializeRecipient(resolved.escalationRecipient),
  ];
}

export async function createNotification(
  ctx: TenantContext,
  input: CreateNotificationInput,
): Promise<{ notification: Notification; deduped: boolean }> {
  assertNotificationsTenantContext(ctx);
  const valid = validateCreateNotificationInput(input);
  const resolved = await resolvePolicy(ctx, valid.kind);
  const at = now();
  const db = getDb();

  // Dedupe: a LIVE notification with the same (kind, recipient, key)
  // created within the resolved policy's window suppresses this create —
  // recorded for audit, never delivered. The window is the policy as
  // currently resolved (rate-limit semantics); failed/blocked/suppressed
  // originals never suppress — the information did not reach the
  // recipient, so a new cycle may deliver it.
  if (valid.dedupeKey !== null && resolved.dedupeWindowSeconds > 0) {
    const cutoff = new Date(at.getTime() - resolved.dedupeWindowSeconds * 1_000);
    const live = await db.query<NotificationRow>(
      `SELECT * FROM notifications
         WHERE tenant_id = $1 AND notification_kind = $2
           AND recipient_provider = $3 AND recipient_account_id = $4
           AND dedupe_key = $5
           AND status IN ${DEDUPE_LIVE_STATUSES}
           AND created_at > $6
         ORDER BY created_at DESC
         LIMIT 1`,
      [
        ctx.tenantId,
        valid.kind,
        valid.recipient.provider,
        valid.recipient.providerAccountId,
        valid.dedupeKey,
        cutoff,
      ],
    );
    const original = live.rows[0];
    if (original !== undefined) {
      const inserted = await db.query<NotificationRow>(
        NOTIFICATION_INSERT_SQL,
        [...notificationInsertParams(ctx, valid, resolved, original.id, at), 'suppressed'],
      );
      return { notification: mapNotification(inserted.rows[0]!), deduped: true };
    }
  }

  const inserted = await db.query<NotificationRow>(
    NOTIFICATION_INSERT_SQL,
    [...notificationInsertParams(ctx, valid, resolved, null, at), 'pending'],
  );
  const row = inserted.rows[0]!;

  // Urgent and escalation classes deliver immediately; digest class
  // accumulates until its window closes (flushDueDigests).
  if (resolved.deliveryClass !== 'digest') {
    await attemptOriginalDelivery(ctx, row, 'initial');
  }

  const fresh = await findNotificationRow(ctx, row.id);
  return { notification: mapNotification(fresh ?? row), deduped: false };
}

// ---------------------------------------------------------------------------
// Delivery attempts (original recipient)
// ---------------------------------------------------------------------------

/**
 * Attempt one delivery of a pending notification to its original
 * recipient: authority gate → claim (lease) → send → record. Returns the
 * outcome for pump summaries. The claim's guarded UPDATE makes exactly
 * one pump the writer of an attempt; a lost claim is a silent skip.
 */
async function attemptOriginalDelivery(
  ctx: TenantContext,
  row: NotificationRow,
  attemptKind: 'initial' | 'retry',
): Promise<'delivered' | 'failed' | 'blocked' | 'waiting'> {
  const recipient = recipientOf(row);

  const request = await authorizeDeliveryGate(ctx, {
    idempotencyKey: deliveryGateKey(row.id),
    notificationId: row.id,
    kind: row.notification_kind,
    subject: row.subject,
    deliveryClass: row.delivery_class,
    purpose: 'delivery',
    target: recipient,
  });
  const at = now();
  const db = getDb();
  await recordGateRequest(db, ctx, row.id, 'action_request_id', request.id, at);

  if (request.status === 'pending') {
    return 'waiting'; // the gate holds the notification until decided
  }
  if (request.status === 'rejected') {
    const blocked = await db.query<NotificationRow>(
      `UPDATE notifications SET status = 'blocked', next_attempt_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
      [ctx.tenantId, row.id, at],
    );
    if (blocked.rows[0] === undefined) return 'waiting'; // someone else moved it
    await recordAttempt(
      db,
      ctx,
      row,
      {
        attemptKind,
        target: 'recipient',
        recipient,
        outcome: 'blocked',
        gateStatus: 'rejected',
        providerMessageId: null,
        detail: `authority gate rejected ${NOTIFICATION_AUTHORITY_LEVEL} of '${NOTIFICATION_ACTION_KIND}' (action request ${request.id})`,
      },
      at,
    );
    return 'blocked';
  }

  // Claim the attempt slot: the lease (now + backoff) is both the mutex
  // and, on transient failure, the retry schedule.
  const lease = new Date(at.getTime() + row.retry_backoff_seconds * 1_000);
  const claimed = await db.query<NotificationRow>(
    `UPDATE notifications SET next_attempt_at = $3, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
       RETURNING *`,
    [ctx.tenantId, row.id, lease, at],
  );
  const claimedRow = claimed.rows[0];
  if (claimedRow === undefined) return 'waiting'; // a concurrent pump owns it

  const result = await sendThroughChannel(ctx, {
    provider: recipient.provider,
    providerAccountId: recipient.providerAccountId,
    displayName: recipient.displayName ?? null,
    connectionId: claimedRow.connection_id,
    subject: claimedRow.subject,
    text: claimedRow.body,
  });

  if (result.delivered) {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE notifications
           SET status = 'delivered', delivered_at = COALESCE(delivered_at, $3),
               attempts_count = attempts_count + 1, next_attempt_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [ctx.tenantId, row.id, at],
      );
      await recordAttempt(
        tx,
        ctx,
        claimedRow,
        {
          attemptKind,
          target: 'recipient',
          recipient,
          outcome: 'delivered',
          gateStatus: 'approved',
          providerMessageId: result.providerMessageId,
          detail: null,
        },
        at,
      );
    });
    return 'delivered';
  }

  // A permanent rejection fails immediately — the retry budget only
  // bounds transient failures.
  const terminal = !result.retryable || claimedRow.attempts_count + 1 >= claimedRow.max_attempts;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE notifications
         SET attempts_count = attempts_count + 1,
             status = CASE WHEN $3 THEN 'failed' ELSE status END,
             next_attempt_at = CASE WHEN $3 THEN NULL ELSE next_attempt_at END,
             updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, row.id, terminal, at],
    );
    await recordAttempt(
      tx,
      ctx,
      claimedRow,
      {
        attemptKind,
        target: 'recipient',
        recipient,
        outcome: result.retryable ? 'transient_failure' : 'permanent_failure',
        gateStatus: 'approved',
        providerMessageId: null,
        detail: result.detail,
      },
      at,
    );
  });
  return result.retryable && !terminal ? 'waiting' : 'failed';
}

// ---------------------------------------------------------------------------
// Escalation delivery
// ---------------------------------------------------------------------------

/**
 * Attempt the escalation delivery of an `escalating` notification to the
 * policy's fallback recipient: authority gate → claim → send → record.
 * Acknowledged notifications are never escalated (the claim guard
 * requires acknowledged_at IS NULL).
 */
async function attemptEscalationDelivery(
  ctx: TenantContext,
  row: NotificationRow,
): Promise<'escalated' | 'escalation_failed' | 'waiting'> {
  const escalationRecipient = mapEscalationRecipient(row.escalation_recipient);
  if (escalationRecipient === null) {
    // Unreachable: the snapshot CHECK requires an escalation recipient for
    // the escalation class. Stay loud rather than silently unescalated.
    throw new Error(
      'escalation-class notification is missing its escalation recipient (internal invariant violation)',
    );
  }
  const originalRecipient = recipientOf(row);

  const request = await authorizeDeliveryGate(ctx, {
    idempotencyKey: escalationGateKey(row.id),
    notificationId: row.id,
    kind: row.notification_kind,
    subject: row.subject,
    deliveryClass: row.delivery_class,
    purpose: 'escalation',
    target: originalRecipient,
    escalationTarget: escalationRecipient,
  });
  const at = now();
  const db = getDb();
  await recordGateRequest(db, ctx, row.id, 'escalation_action_request_id', request.id, at);

  if (request.status === 'pending') {
    // Re-check cadence lease so the pump does not hot-loop on a gated
    // escalation.
    const lease = new Date(at.getTime() + row.retry_backoff_seconds * 1_000);
    await db.query(
      `UPDATE notifications SET next_attempt_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'escalating'
           AND (next_attempt_at IS NULL OR next_attempt_at <= $4)`,
      [ctx.tenantId, row.id, lease, at],
    );
    return 'waiting';
  }
  if (request.status === 'rejected') {
    const failed = await db.query<NotificationRow>(
      `UPDATE notifications SET status = 'escalation_failed', next_attempt_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'escalating'
         RETURNING *`,
      [ctx.tenantId, row.id, at],
    );
    if (failed.rows[0] === undefined) return 'waiting';
    await recordAttempt(
      db,
      ctx,
      row,
      {
        attemptKind: 'escalation',
        target: 'escalation',
        recipient: escalationRecipient,
        outcome: 'blocked',
        gateStatus: 'rejected',
        providerMessageId: null,
        detail: `authority gate rejected ${NOTIFICATION_AUTHORITY_LEVEL} of '${NOTIFICATION_ACTION_KIND}' for the escalation (action request ${request.id})`,
      },
      at,
    );
    return 'escalation_failed';
  }

  const lease = new Date(at.getTime() + row.retry_backoff_seconds * 1_000);
  const claimed = await db.query<NotificationRow>(
    `UPDATE notifications SET next_attempt_at = $3, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'escalating'
         AND acknowledged_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
       RETURNING *`,
    [ctx.tenantId, row.id, lease, at],
  );
  const claimedRow = claimed.rows[0];
  if (claimedRow === undefined) return 'waiting'; // concurrent pump or acknowledged meanwhile

  const message = composeEscalationMessage(
    claimedRow.subject,
    claimedRow.body,
    recipientLabel(claimedRow.recipient_provider, claimedRow.recipient_account_id),
    toIso(claimedRow.delivered_at ?? at),
    claimedRow.escalation_after_seconds ?? 0,
  );
  // The stored connection belongs to the ORIGINAL recipient's provider;
  // only reuse it when the escalation target is on the same provider,
  // otherwise let the channels contract auto-select.
  const connectionId =
    escalationRecipient.provider === claimedRow.recipient_provider
      ? claimedRow.connection_id
      : null;

  const result = await sendThroughChannel(ctx, {
    provider: escalationRecipient.provider,
    providerAccountId: escalationRecipient.providerAccountId,
    displayName: escalationRecipient.displayName ?? null,
    connectionId,
    subject: message.subject,
    text: message.text,
  });

  if (result.delivered) {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE notifications
           SET status = 'escalated', escalated_at = $3,
               escalation_attempts_count = escalation_attempts_count + 1,
               next_attempt_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'escalating'`,
        [ctx.tenantId, row.id, at],
      );
      await recordAttempt(
        tx,
        ctx,
        claimedRow,
        {
          attemptKind: 'escalation',
          target: 'escalation',
          recipient: escalationRecipient,
          outcome: 'delivered',
          gateStatus: 'approved',
          providerMessageId: result.providerMessageId,
          detail: null,
        },
        at,
      );
    });
    return 'escalated';
  }

  // A permanent rejection fails the escalation immediately — the retry
  // budget only bounds transient failures.
  const terminal =
    !result.retryable || claimedRow.escalation_attempts_count + 1 >= claimedRow.max_attempts;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE notifications
         SET escalation_attempts_count = escalation_attempts_count + 1,
             status = CASE WHEN $3 THEN 'escalation_failed' ELSE status END,
             next_attempt_at = CASE WHEN $3 THEN NULL ELSE next_attempt_at END,
             updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, row.id, terminal, at],
    );
    await recordAttempt(
      tx,
      ctx,
      claimedRow,
      {
        attemptKind: 'escalation',
        target: 'escalation',
        recipient: escalationRecipient,
        outcome: result.retryable ? 'transient_failure' : 'permanent_failure',
        gateStatus: 'approved',
        providerMessageId: null,
        detail: result.detail,
      },
      at,
    );
  });
  return result.retryable && !terminal ? 'waiting' : 'escalation_failed';
}

// ---------------------------------------------------------------------------
// Due-processing pumps
// ---------------------------------------------------------------------------

export async function retryDueNotifications(
  ctx: TenantContext,
  query: RetryDueQuery,
): Promise<RetrySummary> {
  assertNotificationsTenantContext(ctx);
  const valid = validateRetryDueQuery(query);
  const at = now();
  const summary: RetrySummary = {
    processed: 0,
    escalationsProcessed: 0,
    delivered: 0,
    failed: 0,
    blocked: 0,
    waiting: 0,
    escalated: 0,
    escalationFailed: 0,
  };

  const due = await getDb().query<NotificationRow>(
    `SELECT * FROM notifications
       WHERE tenant_id = $1 AND status = 'pending' AND delivery_class <> 'digest'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
    [ctx.tenantId, at, valid.limit],
  );
  for (const row of due.rows) {
    summary.processed += 1;
    const outcome = await attemptOriginalDelivery(
      ctx,
      row,
      row.attempts_count === 0 ? 'initial' : 'retry',
    );
    if (outcome === 'delivered') summary.delivered += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else if (outcome === 'blocked') summary.blocked += 1;
    else summary.waiting += 1;
  }

  const dueEscalations = await getDb().query<NotificationRow>(
    `SELECT * FROM notifications
       WHERE tenant_id = $1 AND status = 'escalating'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
       ORDER BY delivered_at ASC, id ASC
       LIMIT $3`,
    [ctx.tenantId, at, valid.limit],
  );
  for (const row of dueEscalations.rows) {
    summary.escalationsProcessed += 1;
    const outcome = await attemptEscalationDelivery(ctx, row);
    if (outcome === 'escalated') summary.escalated += 1;
    else if (outcome === 'escalation_failed') summary.escalationFailed += 1;
    else summary.waiting += 1;
  }

  return summary;
}

export async function flushDueDigests(
  ctx: TenantContext,
  query: FlushDigestsQuery,
): Promise<DigestSummary> {
  assertNotificationsTenantContext(ctx);
  const valid = validateFlushDigestsQuery(query);
  const at = now();
  const db = getDb();
  const summary: DigestSummary = {
    groups: 0,
    delivered: 0,
    membersDelivered: 0,
    membersWaiting: 0,
    membersFailed: 0,
    membersBlocked: 0,
    membersGated: 0,
  };

  // The head of each (kind, recipient) digest cycle is its OLDEST pending
  // member; the cycle is due when the head's age reaches its snapshotted
  // digest window AND the head's retry lease has expired (a failed flush
  // backs off before re-flushing).
  const heads = await db.query<NotificationRow>(
    `SELECT DISTINCT ON (notification_kind, recipient_provider, recipient_account_id) *
       FROM notifications
       WHERE tenant_id = $1 AND delivery_class = 'digest' AND status = 'pending'
       ORDER BY notification_kind, recipient_provider, recipient_account_id, created_at ASC, id ASC
       LIMIT 500`,
    [ctx.tenantId],
  );
  const dueHeads = heads.rows.filter(
    (head) =>
      (head.next_attempt_at === null ||
        new Date(head.next_attempt_at).getTime() <= at.getTime()) &&
      isDigestCycleDue(head.created_at, head.digest_window_seconds, at),
  );

  for (const head of dueHeads.slice(0, valid.limit)) {
    const members = await db.query<NotificationRow>(
      `SELECT * FROM notifications
         WHERE tenant_id = $1 AND delivery_class = 'digest' AND status = 'pending'
           AND notification_kind = $2
           AND recipient_provider = $3 AND recipient_account_id = $4
         ORDER BY created_at ASC, id ASC
         LIMIT $5`,
      [
        ctx.tenantId,
        head.notification_kind,
        head.recipient_provider,
        head.recipient_account_id,
        MAX_DIGEST_MEMBERS,
      ],
    );
    if (members.rows.length === 0) continue;
    summary.groups += 1;

    // Gate every member; partition by the gate's current decision.
    const approved: NotificationRow[] = [];
    const gated: NotificationRow[] = [];
    const blocked: NotificationRow[] = [];
    for (const member of members.rows) {
      const request = await authorizeDeliveryGate(ctx, {
        idempotencyKey: deliveryGateKey(member.id),
        notificationId: member.id,
        kind: member.notification_kind,
        subject: member.subject,
        deliveryClass: member.delivery_class,
        purpose: 'delivery',
        target: recipientOf(member),
      });
      await recordGateRequest(db, ctx, member.id, 'action_request_id', request.id, at);
      if (request.status === 'approved') approved.push(member);
      else if (request.status === 'pending') gated.push(member);
      else blocked.push(member);
    }
    summary.membersGated += gated.length;

    for (const row of blocked) {
      const moved = await db.query<NotificationRow>(
        `UPDATE notifications SET status = 'blocked', next_attempt_at = NULL, updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
           RETURNING *`,
        [ctx.tenantId, row.id, at],
      );
      if (moved.rows[0] === undefined) continue;
      await recordAttempt(
        db,
        ctx,
        row,
        {
          attemptKind: 'digest',
          target: 'recipient',
          recipient: recipientOf(row),
          outcome: 'blocked',
          gateStatus: 'rejected',
          providerMessageId: null,
          detail: `authority gate rejected ${NOTIFICATION_AUTHORITY_LEVEL} of '${NOTIFICATION_ACTION_KIND}' (action request ${row.action_request_id ?? 'unknown'})`,
        },
        at,
      );
      summary.membersBlocked += 1;
    }

    if (approved.length === 0) continue;

    // Claim the approved members (lease = backoff); a lost claim drops
    // the member from this batch without counting it.
    const lease = new Date(at.getTime() + head.retry_backoff_seconds * 1_000);
    const claimed: NotificationRow[] = [];
    for (const row of approved) {
      const claim = await db.query<NotificationRow>(
        `UPDATE notifications SET next_attempt_at = $3, updated_at = $3
           WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
           RETURNING *`,
        [ctx.tenantId, row.id, lease, at],
      );
      if (claim.rows[0] !== undefined) claimed.push(claim.rows[0]);
    }
    if (claimed.length === 0) continue;

    // The oldest claimed member's sending connection is the batch's
    // (deterministic; members of a cycle share kind + recipient).
    const batchConnection = claimed[0]!.connection_id;
    const message = composeDigestMessage(
      head.notification_kind,
      claimed.map((member) => ({
        subject: member.subject,
        body: member.body,
        createdAt: toIso(member.created_at),
      })),
    );
    const result = await sendThroughChannel(ctx, {
      provider: head.recipient_provider as ChannelProvider,
      providerAccountId: head.recipient_account_id,
      displayName: head.recipient_display_name,
      connectionId: batchConnection,
      subject: message.subject,
      text: message.text,
    });

    if (result.delivered) {
      summary.delivered += 1;
      for (const member of claimed) {
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE notifications
               SET status = 'delivered', delivered_at = COALESCE(delivered_at, $3),
                   attempts_count = attempts_count + 1, next_attempt_at = NULL, updated_at = $3
             WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
            [ctx.tenantId, member.id, at],
          );
          await recordAttempt(
            tx,
            ctx,
            member,
            {
              attemptKind: 'digest',
              target: 'recipient',
              recipient: recipientOf(member),
              outcome: 'delivered',
              gateStatus: 'approved',
              providerMessageId: result.providerMessageId,
              detail: null,
            },
            at,
          );
        });
        summary.membersDelivered += 1;
      }
      continue;
    }

    for (const member of claimed) {
      // A permanent rejection fails the members immediately — the retry
      // budget only bounds transient failures.
      const terminal = !result.retryable || member.attempts_count + 1 >= member.max_attempts;
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE notifications
             SET attempts_count = attempts_count + 1,
                 status = CASE WHEN $3 THEN 'failed' ELSE status END,
                 next_attempt_at = CASE WHEN $3 THEN NULL ELSE next_attempt_at END,
                 updated_at = $4
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, member.id, terminal, at],
        );
        await recordAttempt(
          tx,
          ctx,
          member,
          {
            attemptKind: 'digest',
            target: 'recipient',
            recipient: recipientOf(member),
            outcome: result.retryable ? 'transient_failure' : 'permanent_failure',
            gateStatus: 'approved',
            providerMessageId: null,
            detail: result.detail,
          },
          at,
        );
      });
      if (result.retryable && !terminal) summary.membersWaiting += 1;
      else summary.membersFailed += 1;
    }
  }

  return summary;
}

export async function escalateUnacknowledged(
  ctx: TenantContext,
  query: EscalateUnacknowledgedQuery,
): Promise<EscalationSummary> {
  assertNotificationsTenantContext(ctx);
  const valid = validateEscalateUnacknowledgedQuery(query);
  const at = now();
  const summary: EscalationSummary = {
    escalatedCandidates: 0,
    escalated: 0,
    escalationFailed: 0,
    waiting: 0,
  };

  const candidates = await getDb().query<NotificationRow>(
    `SELECT * FROM notifications
       WHERE tenant_id = $1 AND delivery_class = 'escalation' AND status = 'delivered'
         AND acknowledged_at IS NULL AND escalated_at IS NULL
         AND delivered_at + escalation_after_seconds * interval '1 second' <= $2::timestamptz
       ORDER BY delivered_at ASC, id ASC
       LIMIT $3`,
    [ctx.tenantId, at, valid.limit],
  );

  for (const candidate of candidates.rows) {
    // First-wins transition into the escalation cycle.
    const moved = await getDb().query<NotificationRow>(
      `UPDATE notifications SET status = 'escalating', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'delivered' AND acknowledged_at IS NULL
         RETURNING *`,
      [ctx.tenantId, candidate.id, at],
    );
    if (moved.rows[0] === undefined) continue; // acknowledged or escalated meanwhile
    summary.escalatedCandidates += 1;

    const outcome = await attemptEscalationDelivery(ctx, moved.rows[0]!);
    if (outcome === 'escalated') summary.escalated += 1;
    else if (outcome === 'escalation_failed') summary.escalationFailed += 1;
    else summary.waiting += 1;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getNotification(
  ctx: TenantContext,
  query: GetNotificationQuery,
): Promise<Notification> {
  assertNotificationsTenantContext(ctx);
  const valid = validateGetNotificationQuery(query);
  const row = await findNotificationRow(ctx, valid.notificationId);
  if (row === null) {
    throw new NotificationsError(
      'notification_not_found',
      `no notification '${valid.notificationId}' exists in this tenant`,
    );
  }
  return mapNotification(row);
}

export async function listNotifications(
  ctx: TenantContext,
  query: ListNotificationsQuery,
): Promise<Notification[]> {
  assertNotificationsTenantContext(ctx);
  const valid = validateListNotificationsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.notificationKind !== null) add('notification_kind = $#', valid.notificationKind);
  if (valid.status !== null) add('status = $#', valid.status);
  if (valid.deliveryClass !== null) add('delivery_class = $#', valid.deliveryClass);
  if (valid.provider !== null) add('recipient_provider = $#', valid.provider);
  if (valid.recipientAccountId !== null) add('recipient_account_id = $#', valid.recipientAccountId);
  if (valid.dedupeKey !== null) add('dedupe_key = $#', valid.dedupeKey);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<NotificationRow>(
    `SELECT * FROM notifications WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapNotification);
}

export async function listNotificationAttempts(
  ctx: TenantContext,
  query: ListNotificationAttemptsQuery,
): Promise<NotificationAttempt[]> {
  assertNotificationsTenantContext(ctx);
  const valid = validateListNotificationAttemptsQuery(query);
  // The notification must exist in this tenant — its audit trail is
  // tenant-scoped with it (cross-tenant: uniform not-found, no leak).
  const notification = await findNotificationRow(ctx, valid.notificationId);
  if (notification === null) {
    throw new NotificationsError(
      'notification_not_found',
      `no notification '${valid.notificationId}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<AttemptRow>(
    `SELECT * FROM notification_attempts
       WHERE tenant_id = $1 AND notification_id = $2
       ORDER BY attempt_no ASC, id ASC`,
    [ctx.tenantId, valid.notificationId],
  );
  return rows.rows.map(mapAttempt);
}

// ---------------------------------------------------------------------------
// Acknowledgments
// ---------------------------------------------------------------------------

export async function acknowledgeNotification(
  ctx: TenantContext,
  input: AcknowledgeNotificationInput,
): Promise<NotificationAcknowledgment> {
  assertNotificationsTenantContext(ctx);
  const valid = validateAcknowledgeNotificationInput(input);
  const row = await findNotificationRow(ctx, valid.notificationId);
  if (row === null) {
    throw new NotificationsError(
      'notification_not_found',
      `no notification '${valid.notificationId}' exists in this tenant`,
    );
  }
  if (!row.require_acknowledgment) {
    throw new NotificationsError(
      'acknowledgment_not_required',
      `notifications of kind '${row.notification_kind}' do not require acknowledgment (policy snapshot)`,
    );
  }
  if (row.delivered_at === null) {
    throw new NotificationsError(
      'notification_not_acknowledgeable',
      `notification '${valid.notificationId}' has not been delivered — only a delivered notification can be acknowledged (status '${row.status}')`,
    );
  }

  const at = now();
  return getDb().transaction(async (tx) => {
    // First acknowledgment wins (storage-level UNIQUE); a lost race is
    // reported as already acknowledged.
    const inserted = await tx.query<AckRow>(
      `INSERT INTO notification_acknowledgments (
         tenant_id, notification_id, acknowledged_by, note, acknowledged_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, notification_id) DO NOTHING
       RETURNING *`,
      [ctx.tenantId, valid.notificationId, ctx.principalId, valid.note, at],
    );
    const ack = inserted.rows[0];
    if (ack === undefined) {
      throw new NotificationsError(
        'already_acknowledged',
        `notification '${valid.notificationId}' has already been acknowledged — the first acknowledgment stands`,
      );
    }
    await tx.query(
      `UPDATE notifications SET acknowledged_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND acknowledged_at IS NULL`,
      [ctx.tenantId, valid.notificationId, at],
    );
    return mapAck(ack);
  });
}

export async function getNotificationAcknowledgment(
  ctx: TenantContext,
  query: GetNotificationAcknowledgmentQuery,
): Promise<NotificationAcknowledgment | null> {
  assertNotificationsTenantContext(ctx);
  const valid = validateGetNotificationAcknowledgmentQuery(query);
  const notification = await findNotificationRow(ctx, valid.notificationId);
  if (notification === null) {
    throw new NotificationsError(
      'notification_not_found',
      `no notification '${valid.notificationId}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<AckRow>(
    `SELECT * FROM notification_acknowledgments
       WHERE tenant_id = $1 AND notification_id = $2`,
    [ctx.tenantId, valid.notificationId],
  );
  return rows.rows[0] === undefined ? null : mapAck(rows.rows[0]);
}
