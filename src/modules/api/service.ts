// Implementation of the api module's own domain operations (see
// contract.ts): API-key management, webhook subscriptions, webhook
// deliveries/fanout/dispatch, and the per-operation audit append.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) or, where the value must be known before the
// insert (the delivery envelope embeds its own delivery id), by the
// sanctioned `newId()` helper; timestamps come from the injectable clock
// and are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record, no existence leak.
//
// W038 non-negotiables implemented here:
//   * NO RAW PERSISTENCE (lock 31): the module touches ONLY its own api_*
//     tables; every domain read/write goes through the owning module's
//     contract (organizations for membership, events for the audit trail
//     and fanout sources).
//   * TENANT-SCOPED + PERMISSION-CHECKED + AUDITED (lock 32 / ADR-0005):
//     keys resolve exactly one tenant, membership is re-verified per
//     request, capability scopes gate every route, and every authenticated
//     operation appends an immutable `api.operation` event through the
//     events contract (actor = the key's principal, source = 'api').
//   * CREDENTIAL DISCIPLINE: only sha-256 key hashes are persisted (the
//     identity challenge-code precedent); webhook signing secrets live
//     behind opaque `secret_ref`s (the sources/channels precedent), never
//     in domain tables.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { appendEvent, getEvent, type Event } from '@/modules/events/contract';
import { getTenantMembership } from '@/modules/organizations/contract';
import { ApiError } from './errors';
import { isApiScope, isApiKeyAuthorityClaim, parseAuthorityGrant, parseScopeGrant, type ApiScope } from './scopes';
import type {
  ApiKey,
  ApiKeyIssuance,
  CreateApiKeyInput,
  CreateWebhookSubscriptionInput,
  DispatchWebhookDeliveriesResult,
  FanoutEventResult,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryDetail,
  WebhookDeliveryStatus,
  WebhookDispatchOutcome,
  WebhookSubscription,
  WebhookTransport,
  WebhookTransportReceipt,
} from './types';
import { API_VERSION } from './types';
import {
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  MAX_WEBHOOK_MAX_ATTEMPTS,
  backoffSecondsForAttempt,
  classifyWebhookReceipt,
  eventTypeMatches,
  parseEventTypePatterns,
  validateWebhookUrl,
} from './webhook';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

/** Raw api keys look like `aurum_<43 base64url chars>` (32 random bytes). */
const API_KEY_PATTERN = /^aurum_[A-Za-z0-9_-]{43}$/;

export const API_KEY_PREFIX = 'aurum_';

/** The immutable audit classification of one public-API operation. */
export const API_AUDIT_EVENT_TYPE = 'api.operation';

/** The synthetic event type of a webhook test ping. */
export const WEBHOOK_TEST_EVENT_TYPE = 'webhook.test';

function assertApiTenantContext(ctx: TenantContext): void {
  if (!isUuid(ctx?.tenantId)) {
    throw new ApiError('invalid_context', 'TenantContext.tenantId must be a uuid');
  }
  if (!isUuid(ctx?.principalId)) {
    throw new ApiError('invalid_context', 'TenantContext.principalId must be a uuid');
  }
  if (!Array.isArray(ctx?.authority)) {
    throw new ApiError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Key administration is administer-grade (the house claim-gate style —
 * 'llm:administer', 'agents:administer'): minting/revoking credentials is
 * the api module's highest-value target, so the CONTRACT requires the
 * 'api:administer' authority claim. Over HTTP this is a fail-closed double
 * gate: the route's 'api:administer' SCOPE and the key's 'api:administer'
 * authority claim must BOTH be present.
 */
function requireApiAdminister(ctx: TenantContext): void {
  if (!ctx.authority.includes('api:administer')) {
    throw new ApiError(
      'missing_scope',
      "managing api keys requires the 'api:administer' authority claim",
    );
  }
}

/**
 * Re-verify (through the organizations contract) that `principalId` is a
 * member of the context tenant. A key whose principal lost membership is
 * dead immediately — membership is never cached in the key.
 */
export async function requirePrincipalMembership(
  ctx: TenantContext,
  principalId: string,
): Promise<void> {
  try {
    await getTenantMembership(ctx, { principalId });
  } catch {
    throw new ApiError(
      'principal_not_member',
      `principal '${principalId}' is not a member of this tenant`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface ApiKeyRow extends DbRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  label: string;
  key_hash: string;
  scopes: string[];
  authority: string[];
  status: string;
  created_at: Date | string;
  created_by: string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
}

export type { ApiKeyRow };

export function mapApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    label: row.label,
    scopes: (row.scopes ?? []).filter(isApiScope),
    authority: (row.authority ?? []).filter(isApiKeyAuthorityClaim),
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at === null ? null : toIso(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    revokedBy: row.revoked_by,
  };
}

interface SubscriptionRow extends DbRow {
  id: string;
  tenant_id: string;
  label: string;
  url: string;
  event_types: string[];
  secret_ref: string | null;
  max_attempts: number | string;
  status: string;
  created_at: Date | string;
  created_by: string;
  deactivated_at: Date | string | null;
  deactivated_by: string | null;
}

function mapSubscription(row: SubscriptionRow): WebhookSubscription {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    url: row.url,
    eventTypes: [...(row.event_types ?? [])],
    secretRef: row.secret_ref,
    maxAttempts: toInt(row.max_attempts),
    status: row.status === 'deactivated' ? 'deactivated' : 'active',
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    deactivatedAt: row.deactivated_at === null ? null : toIso(row.deactivated_at),
    deactivatedBy: row.deactivated_by,
  };
}

interface DeliveryRow extends DbRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  delivery_kind: string;
  event_id: string | null;
  event_type: string;
  body: string;
  status: string;
  attempts: number | string;
  max_attempts: number | string;
  next_attempt_at: Date | string;
  last_status_code: number | null;
  last_error: string | null;
  created_at: Date | string;
  delivered_at: Date | string | null;
  finalized_at: Date | string | null;
  redelivery_of: string | null;
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    kind: row.delivery_kind === 'test' ? 'test' : 'event',
    eventId: row.event_id,
    eventType: row.event_type,
    body: row.body,
    status: row.status === 'delivered' ? 'delivered' : row.status === 'failed' ? 'failed' : 'pending',
    attempts: toInt(row.attempts),
    maxAttempts: toInt(row.max_attempts),
    nextAttemptAt: toIso(row.next_attempt_at),
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: toIso(row.created_at),
    deliveredAt: row.delivered_at === null ? null : toIso(row.delivered_at),
    finalizedAt: row.finalized_at === null ? null : toIso(row.finalized_at),
    redeliveryOf: row.redelivery_of,
  };
}

interface AttemptRow extends DbRow {
  id: string;
  tenant_id: string;
  delivery_id: string;
  attempt_no: number | string;
  outcome: string;
  status_code: number | null;
  error: string | null;
  latency_ms: number | null;
  started_at: Date | string;
  finished_at: Date | string;
}

function mapAttempt(row: AttemptRow): WebhookDeliveryAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    deliveryId: row.delivery_id,
    attemptNo: toInt(row.attempt_no),
    outcome:
      row.outcome === 'succeeded'
        ? 'succeeded'
        : row.outcome === 'terminal_failure'
          ? 'terminal_failure'
          : 'transient_failure',
    statusCode: row.status_code,
    error: row.error,
    latencyMs: row.latency_ms === null ? null : toInt(row.latency_ms),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  };
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Mint one tenant-scoped API key. The raw key is returned EXACTLY ONCE;
 * only its sha-256 hash is persisted. The grantee principal must be a
 * member of the tenant (verified through the organizations contract).
 */
export async function createApiKey(
  ctx: TenantContext,
  input: CreateApiKeyInput,
): Promise<ApiKeyIssuance> {
  assertApiTenantContext(ctx);
  requireApiAdminister(ctx);
  if (input === null || typeof input !== 'object') {
    throw new ApiError('invalid_input', 'input must be an object');
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length < 1 || label.length > 120) {
    throw new ApiError('invalid_input', 'label must be a trimmed string of 1..120 chars');
  }
  const principalId =
    input.principalId === undefined || input.principalId === null
      ? ctx.principalId
      : input.principalId;
  if (!isUuid(principalId)) {
    throw new ApiError('invalid_input', 'principalId must be a uuid');
  }
  const scopes: ApiScope[] = parseScopeGrant(input.scopes);
  const authority = parseAuthorityGrant(input.authority);

  await requirePrincipalMembership(ctx, principalId);

  const rawKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const inserted = await getDb().query<ApiKeyRow>(
    `INSERT INTO api_keys (tenant_id, principal_id, label, key_hash, scopes, authority, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       RETURNING *`,
    [ctx.tenantId, principalId, label, sha256Hex(rawKey), scopes, authority, ctx.principalId],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('api key insert returned no row (internal invariant violation)');
  }
  return { apiKey: mapApiKey(row), key: rawKey };
}

async function findApiKeyRow(ctx: TenantContext, keyId: string): Promise<ApiKeyRow> {
  if (!isUuid(keyId)) {
    throw new ApiError('api_key_not_found', `api key '${keyId}' does not exist in this tenant`);
  }
  const result = await getDb().query<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, keyId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ApiError('api_key_not_found', `api key '${keyId}' does not exist in this tenant`);
  }
  return row;
}

/** The tenant's keys (never the hashes). */
export async function listApiKeys(ctx: TenantContext): Promise<ApiKey[]> {
  assertApiTenantContext(ctx);
  requireApiAdminister(ctx);
  const result = await getDb().query<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at, id`,
    [ctx.tenantId],
  );
  return result.rows.map((row) => mapApiKey(row));
}

/** Revoke a key (idempotent): active → revoked, with who/when. */
export async function revokeApiKey(ctx: TenantContext, input: { keyId: string }): Promise<ApiKey> {
  assertApiTenantContext(ctx);
  requireApiAdminister(ctx);
  const keyId = input?.keyId;
  if (!isUuid(keyId)) {
    throw new ApiError('api_key_not_found', `api key '${String(keyId)}' does not exist in this tenant`);
  }
  // Ownership resolved before mutating (the organizations precedent).
  const existing = await findApiKeyRow(ctx, keyId);
  if (existing.status === 'revoked') return mapApiKey(existing);
  const updated = await getDb().query<ApiKeyRow>(
    `UPDATE api_keys
       SET status = 'revoked', revoked_at = $3, revoked_by = $4
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
    [ctx.tenantId, keyId, now(), ctx.principalId],
  );
  const row = updated.rows[0] ?? existing; // lost a race → already revoked
  return mapApiKey(row);
}

/**
 * Resolve a presented bearer credential onto its one active key row
 * (module-internal: the kernel's authentication step). Returns null for
 * malformed, unknown and revoked keys — uniformly, so nothing leaks.
 */
export async function verifyApiKey(rawKey: string): Promise<ApiKeyRow | null> {
  if (typeof rawKey !== 'string' || !API_KEY_PATTERN.test(rawKey)) return null;
  const keyHash = sha256Hex(rawKey);
  const result = await getDb().query<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE key_hash = $1`,
    [keyHash],
  );
  const row = result.rows[0];
  if (row === undefined || row.status !== 'active') return null;
  // Constant-time confirmation (the identity module's discipline).
  const actual = Buffer.from(keyHash, 'utf8');
  const expected = Buffer.from(row.key_hash, 'utf8');
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return row;
  return null;
}

/** Best-effort last-used stamp (the kernel calls it after authentication). */
export async function touchApiKey(keyId: string): Promise<void> {
  if (!isUuid(keyId)) return;
  await getDb().query(`UPDATE api_keys SET last_used_at = $2 WHERE id = $1`, [keyId, now()]);
}

// ---------------------------------------------------------------------------
// Webhook transport wiring (module-private; none by default)
// ---------------------------------------------------------------------------

let webhookTransport: WebhookTransport | null = null;

/** Wire (or clear) the webhook delivery transport. */
export function setWebhookTransport(transport: WebhookTransport | null): void {
  webhookTransport = transport;
}

/** The currently wired webhook transport (null when unwired). */
export function getWebhookTransport(): WebhookTransport | null {
  return webhookTransport;
}

function requireTransport(): WebhookTransport {
  if (webhookTransport === null) {
    throw new ApiError(
      'provider_unavailable',
      'no webhook transport is wired — deliveries cannot be dispatched',
    );
  }
  return webhookTransport;
}

// ---------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------

async function findSubscriptionRow(
  db: Queryable,
  ctx: TenantContext,
  subscriptionId: string,
): Promise<SubscriptionRow | null> {
  if (!isUuid(subscriptionId)) return null;
  const result = await db.query<SubscriptionRow>(
    `SELECT * FROM api_webhook_subscriptions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, subscriptionId],
  );
  return result.rows[0] ?? null;
}

function subscriptionNotFound(subscriptionId: string): ApiError {
  return new ApiError(
    'webhook_not_found',
    `webhook subscription '${subscriptionId}' does not exist in this tenant`,
  );
}

/** Subscribe one https endpoint to event-type patterns. */
export async function createWebhookSubscription(
  ctx: TenantContext,
  input: CreateWebhookSubscriptionInput,
): Promise<WebhookSubscription> {
  assertApiTenantContext(ctx);
  if (input === null || typeof input !== 'object') {
    throw new ApiError('invalid_input', 'input must be an object');
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length < 1 || label.length > 120) {
    throw new ApiError('invalid_input', 'label must be a trimmed string of 1..120 chars');
  }
  const url = validateWebhookUrl(input.url);
  const eventTypes = parseEventTypePatterns(input.eventTypes);
  let secretRef: string | null = null;
  if (input.secretRef !== undefined && input.secretRef !== null) {
    if (typeof input.secretRef !== 'string' || input.secretRef.length < 1 || input.secretRef.length > 255) {
      throw new ApiError('invalid_input', 'secretRef must be a string of 1..255 chars');
    }
    secretRef = input.secretRef;
  }
  let maxAttempts = DEFAULT_WEBHOOK_MAX_ATTEMPTS;
  if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
    const value = Math.floor(Number(input.maxAttempts));
    if (!Number.isInteger(value) || value < 1 || value > MAX_WEBHOOK_MAX_ATTEMPTS) {
      throw new ApiError('invalid_input', `maxAttempts must be 1..${MAX_WEBHOOK_MAX_ATTEMPTS}`);
    }
    maxAttempts = value;
  }
  try {
    const inserted = await getDb().query<SubscriptionRow>(
      `INSERT INTO api_webhook_subscriptions
         (tenant_id, label, url, event_types, secret_ref, max_attempts, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       RETURNING *`,
      [ctx.tenantId, label, url, eventTypes, secretRef, maxAttempts, ctx.principalId],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('webhook subscription insert returned no row (internal invariant violation)');
    }
    return mapSubscription(row);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === '23505') {
      throw new ApiError(
        'webhook_conflict',
        'a subscription for this url already exists in this tenant',
      );
    }
    throw error;
  }
}

export async function getWebhookSubscription(
  ctx: TenantContext,
  input: { subscriptionId: string },
): Promise<WebhookSubscription> {
  assertApiTenantContext(ctx);
  const row = await findSubscriptionRow(getDb(), ctx, input?.subscriptionId);
  if (row === null) throw subscriptionNotFound(String(input?.subscriptionId));
  return mapSubscription(row);
}

export async function listWebhookSubscriptions(ctx: TenantContext): Promise<WebhookSubscription[]> {
  assertApiTenantContext(ctx);
  const result = await getDb().query<SubscriptionRow>(
    `SELECT * FROM api_webhook_subscriptions WHERE tenant_id = $1 ORDER BY created_at, id`,
    [ctx.tenantId],
  );
  return result.rows.map((row) => mapSubscription(row));
}

/** Deactivate a subscription (idempotent): no further fanout targets it. */
export async function deactivateWebhookSubscription(
  ctx: TenantContext,
  input: { subscriptionId: string },
): Promise<WebhookSubscription> {
  assertApiTenantContext(ctx);
  const subscriptionId = input?.subscriptionId;
  const existing = await findSubscriptionRow(getDb(), ctx, subscriptionId);
  if (existing === null) throw subscriptionNotFound(String(subscriptionId));
  if (existing.status === 'deactivated') return mapSubscription(existing);
  const updated = await getDb().query<SubscriptionRow>(
    `UPDATE api_webhook_subscriptions
       SET status = 'deactivated', deactivated_at = $3, deactivated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
    [ctx.tenantId, existing.id, now(), ctx.principalId],
  );
  const row = updated.rows[0] ?? existing; // lost a race → already deactivated
  return mapSubscription(row);
}

// ---------------------------------------------------------------------------
// Webhook deliveries: fanout, test, reads, redelivery, dispatch
// ---------------------------------------------------------------------------

/**
 * The frozen delivery envelope — the exact bytes POSTed on every attempt
 * (byte-stable across retries, so HMAC verification stays valid).
 */
function buildDeliveryBody(input: {
  deliveryId: string;
  subscriptionId: string;
  eventType: string;
  eventId: string | null;
  occurredAt: string | null;
  payload: unknown;
  test: boolean;
}): string {
  return JSON.stringify({
    id: input.deliveryId,
    version: 1,
    eventType: input.eventType,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    subscriptionId: input.subscriptionId,
    payload: input.payload,
    ...(input.test ? { test: true } : {}),
  });
}

async function listActiveSubscriptionRows(ctx: TenantContext): Promise<SubscriptionRow[]> {
  const result = await getDb().query<SubscriptionRow>(
    `SELECT * FROM api_webhook_subscriptions WHERE tenant_id = $1 AND status = 'active'`,
    [ctx.tenantId],
  );
  return result.rows;
}

/**
 * Enqueue one delivery per ACTIVE subscription whose patterns match the
 * event's type. Idempotent per (subscription, event): the partial unique
 * index collapses concurrent fanouts of the same event.
 */
export async function enqueueDeliveriesForEvent(
  ctx: TenantContext,
  event: Event,
): Promise<FanoutEventResult> {
  const subscriptions = await listActiveSubscriptionRows(ctx);
  const matched = subscriptions.filter((row) =>
    row.event_types.some((pattern) => eventTypeMatches(pattern, event.type)),
  );
  const enqueued: string[] = [];
  for (const subscription of matched) {
    const deliveryId = newId();
    const body = buildDeliveryBody({
      deliveryId,
      subscriptionId: subscription.id,
      eventType: event.type,
      eventId: event.id,
      occurredAt: event.occurredAt,
      payload: event.payload,
      test: false,
    });
    const inserted = await getDb().query<{ id: string }>(
      `INSERT INTO api_webhook_deliveries
         (id, tenant_id, subscription_id, delivery_kind, event_id, event_type, body,
          status, attempts, max_attempts, next_attempt_at)
       VALUES ($1, $2, $3, 'event', $4, $5, $6, 'pending', 0, $7, $8)
       ON CONFLICT (subscription_id, event_id)
         WHERE event_id IS NOT NULL AND redelivery_of IS NULL
         DO NOTHING
       RETURNING id`,
      [
        deliveryId,
        ctx.tenantId,
        subscription.id,
        event.id,
        event.type,
        body,
        toInt(subscription.max_attempts),
        now(),
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) enqueued.push(row.id);
  }
  return { eventId: event.id, matched: matched.length, enqueued };
}

/**
 * Explicitly fan out one recorded tenant event to matching subscriptions
 * (the event is read through the events contract — no raw persistence).
 */
export async function fanoutEvent(
  ctx: TenantContext,
  input: { eventId: string },
): Promise<FanoutEventResult> {
  assertApiTenantContext(ctx);
  if (!isUuid(input?.eventId)) {
    throw new ApiError('invalid_input', 'eventId must be a uuid');
  }
  const event = await getEvent(ctx, input.eventId); // event_not_found propagates
  return enqueueDeliveriesForEvent(ctx, event);
}

/** Enqueue a synthetic test ping for one subscription. */
export async function sendWebhookTest(
  ctx: TenantContext,
  input: { subscriptionId: string },
): Promise<WebhookDelivery> {
  assertApiTenantContext(ctx);
  const subscriptionId = input?.subscriptionId;
  const subscription = await findSubscriptionRow(getDb(), ctx, subscriptionId);
  if (subscription === null) throw subscriptionNotFound(String(subscriptionId));
  if (subscription.status !== 'active') {
    throw new ApiError('webhook_conflict', 'subscription is deactivated');
  }
  const deliveryId = newId();
  const occurredAt = now().toISOString();
  const body = buildDeliveryBody({
    deliveryId,
    subscriptionId: subscription.id,
    eventType: WEBHOOK_TEST_EVENT_TYPE,
    eventId: null,
    occurredAt,
    payload: { test: true, sentAt: occurredAt },
    test: true,
  });
  const inserted = await getDb().query<DeliveryRow>(
    `INSERT INTO api_webhook_deliveries
       (id, tenant_id, subscription_id, delivery_kind, event_id, event_type, body,
        status, attempts, max_attempts, next_attempt_at)
     VALUES ($1, $2, $3, 'test', NULL, $4, $5, 'pending', 0, $6, $7)
     RETURNING *`,
    [deliveryId, ctx.tenantId, subscription.id, WEBHOOK_TEST_EVENT_TYPE, body, toInt(subscription.max_attempts), now()],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('webhook delivery insert returned no row (internal invariant violation)');
  }
  return mapDelivery(row);
}

async function findDeliveryRow(
  db: Queryable,
  ctx: TenantContext,
  deliveryId: string,
): Promise<DeliveryRow | null> {
  if (!isUuid(deliveryId)) return null;
  const result = await db.query<DeliveryRow>(
    `SELECT * FROM api_webhook_deliveries WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, deliveryId],
  );
  return result.rows[0] ?? null;
}

function deliveryNotFound(deliveryId: string): ApiError {
  return new ApiError(
    'webhook_delivery_not_found',
    `webhook delivery '${deliveryId}' does not exist in this tenant`,
  );
}

async function listAttemptRows(
  db: Queryable,
  ctx: TenantContext,
  deliveryId: string,
): Promise<AttemptRow[]> {
  const result = await db.query<AttemptRow>(
    `SELECT * FROM api_webhook_delivery_attempts
       WHERE tenant_id = $1 AND delivery_id = $2 ORDER BY attempt_no`,
    [ctx.tenantId, deliveryId],
  );
  return result.rows;
}

/** One delivery plus its append-only attempt trail. */
export async function getWebhookDelivery(
  ctx: TenantContext,
  input: { deliveryId: string },
): Promise<WebhookDeliveryDetail> {
  assertApiTenantContext(ctx);
  const row = await findDeliveryRow(getDb(), ctx, input?.deliveryId);
  if (row === null) throw deliveryNotFound(String(input?.deliveryId));
  const attempts = await listAttemptRows(getDb(), ctx, row.id);
  return { delivery: mapDelivery(row), attempts: attempts.map((attempt) => mapAttempt(attempt)) };
}

/** The tenant's deliveries, newest first (optionally per subscription/status). */
export async function listWebhookDeliveries(
  ctx: TenantContext,
  query: { subscriptionId?: string; status?: string; limit?: number } = {},
): Promise<WebhookDelivery[]> {
  assertApiTenantContext(ctx);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (query.subscriptionId !== undefined && query.subscriptionId !== null) {
    if (!isUuid(query.subscriptionId)) {
      throw new ApiError('invalid_input', 'subscriptionId must be a uuid');
    }
    const subscription = await findSubscriptionRow(getDb(), ctx, query.subscriptionId);
    if (subscription === null) throw subscriptionNotFound(query.subscriptionId);
    params.push(query.subscriptionId);
    conditions.push(`subscription_id = $${params.length}`);
  }
  if (query.status !== undefined && query.status !== null) {
    const status = query.status;
    if (status !== 'pending' && status !== 'delivered' && status !== 'failed') {
      throw new ApiError('invalid_input', "status must be 'pending', 'delivered' or 'failed'");
    }
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  let limit = 50;
  if (query.limit !== undefined && query.limit !== null) {
    const value = Math.floor(Number(query.limit));
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new ApiError('invalid_input', 'limit must be 1..500');
    }
    limit = value;
  }
  params.push(limit);
  const result = await getDb().query<DeliveryRow>(
    `SELECT * FROM api_webhook_deliveries WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => mapDelivery(row));
}

/** Clone a delivery as a fresh pending one (explicit redelivery). */
export async function redeliverWebhookDelivery(
  ctx: TenantContext,
  input: { deliveryId: string },
): Promise<WebhookDelivery> {
  assertApiTenantContext(ctx);
  const source = await findDeliveryRow(getDb(), ctx, input?.deliveryId);
  if (source === null) throw deliveryNotFound(String(input?.deliveryId));
  const subscription = await findSubscriptionRow(getDb(), ctx, source.subscription_id);
  if (subscription === null) throw subscriptionNotFound(source.subscription_id);
  if (subscription.status !== 'active') {
    throw new ApiError('webhook_conflict', 'subscription is deactivated');
  }
  const deliveryId = newId();
  const inserted = await getDb().query<DeliveryRow>(
    `INSERT INTO api_webhook_deliveries
       (id, tenant_id, subscription_id, delivery_kind, event_id, event_type, body,
        status, attempts, max_attempts, next_attempt_at, redelivery_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $9, $10)
     RETURNING *`,
    [
      deliveryId,
      ctx.tenantId,
      subscription.id,
      source.delivery_kind,
      source.event_id,
      source.event_type,
      source.body,
      toInt(subscription.max_attempts),
      now(),
      source.id,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('webhook redelivery insert returned no row (internal invariant violation)');
  }
  return mapDelivery(row);
}

function sanitizeStatusCode(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const code = Math.floor(value);
  return code >= 100 && code <= 599 ? code : null;
}

/**
 * The delivery pump (lock 36 discipline): performs exactly ONE bounded
 * dispatch attempt per due pending delivery, serialized per delivery by an
 * advisory transaction lock (the agents/cognition pump precedent), records
 * append-only attempt evidence, and applies the retry policy — transient
 * failures re-queue with exponential backoff while attempts remain; 2xx
 * delivers; other 4xx fails terminally.
 */
export async function dispatchWebhookDeliveries(
  ctx: TenantContext,
  input: { limit?: number } = {},
): Promise<DispatchWebhookDeliveriesResult> {
  assertApiTenantContext(ctx);
  let limit = 20;
  if (input?.limit !== undefined && input?.limit !== null) {
    const value = Math.floor(Number(input.limit));
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new ApiError('invalid_input', 'limit must be 1..100');
    }
    limit = value;
  }
  const transport = requireTransport();
  const due = await getDb().query<{ id: string }>(
    `SELECT id FROM api_webhook_deliveries
       WHERE tenant_id = $1 AND status = 'pending' AND next_attempt_at <= $2
       ORDER BY created_at, id LIMIT $3`,
    [ctx.tenantId, now(), limit],
  );
  const dispatched: WebhookDispatchOutcome[] = [];
  for (const row of due.rows) {
    dispatched.push(await dispatchOneDelivery(ctx, transport, row.id));
  }
  return { dispatched };
}

async function dispatchOneDelivery(
  ctx: TenantContext,
  transport: WebhookTransport,
  deliveryId: string,
): Promise<WebhookDispatchOutcome> {
  return getDb().transaction(async (tx) => {
    // Serialize pumps per delivery: a racing pump waits here, then observes
    // the moved state and stands down.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `api:webhook-delivery:${ctx.tenantId}:${deliveryId}`,
    ]);
    const delivery = await findDeliveryRow(tx, ctx, deliveryId);
    if (delivery === null || delivery.status !== 'pending') {
      return {
        deliveryId,
        subscriptionId: delivery?.subscription_id ?? '',
        outcome: 'skipped' as const,
        statusCode: null,
        attempts: delivery === null ? 0 : toInt(delivery.attempts),
        nextAttemptAt: null,
      };
    }
    const subscription = await findSubscriptionRow(tx, ctx, delivery.subscription_id);
    if (subscription === null || subscription.status !== 'active') {
      return {
        deliveryId,
        subscriptionId: delivery.subscription_id,
        outcome: 'skipped' as const,
        statusCode: null,
        attempts: toInt(delivery.attempts),
        nextAttemptAt: null,
      };
    }

    const attemptNo = toInt(delivery.attempts) + 1;
    const startedAt = now();
    let receipt: WebhookTransportReceipt;
    try {
      receipt = await transport.deliver({
        subscriptionId: subscription.id,
        deliveryId: delivery.id,
        attemptNo,
        url: subscription.url,
        secretRef: subscription.secret_ref,
        timestamp: startedAt.toISOString(),
        body: delivery.body,
      });
    } catch (error) {
      receipt = {
        ok: false,
        statusCode: null,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Math.max(0, now().getTime() - startedAt.getTime()),
      };
    }
    const finishedAt = now();
    const outcome = classifyWebhookReceipt(receipt);
    const statusCode = sanitizeStatusCode(receipt.statusCode);
    const latencyMs = Math.max(0, Math.floor(Number(receipt.latencyMs) || 0));

    await tx.query(
      `INSERT INTO api_webhook_delivery_attempts
         (tenant_id, delivery_id, attempt_no, outcome, status_code, error, latency_ms,
          started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.tenantId,
        delivery.id,
        attemptNo,
        outcome,
        statusCode,
        receipt.error === undefined || receipt.error === null ? null : String(receipt.error).slice(0, 2000),
        latencyMs,
        startedAt,
        finishedAt,
      ],
    );

    const attemptsExhausted = attemptNo >= toInt(delivery.max_attempts);
    // Terminal failures (subscriber rejection) fail immediately — only
    // transient failures consume the retry budget.
    const nextStatus: WebhookDeliveryStatus =
      outcome === 'succeeded'
        ? 'delivered'
        : outcome === 'terminal_failure' || attemptsExhausted
          ? 'failed'
          : 'pending';
    const backoffSeconds =
      outcome === 'transient_failure' ? backoffSecondsForAttempt(attemptNo) : 0;
    const nextAttemptAt =
      outcome === 'transient_failure'
        ? new Date(finishedAt.getTime() + backoffSeconds * 1000)
        : finishedAt;

    const updated = await tx.query<DeliveryRow>(
      `UPDATE api_webhook_deliveries
         SET attempts = $3, last_status_code = $4, last_error = $5,
             status = $6, next_attempt_at = $7,
             delivered_at = COALESCE($8, delivered_at), finalized_at = COALESCE($9, finalized_at)
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [
        ctx.tenantId,
        delivery.id,
        attemptNo,
        statusCode,
        receipt.error === undefined || receipt.error === null ? null : String(receipt.error).slice(0, 2000),
        nextStatus,
        nextAttemptAt,
        outcome === 'succeeded' ? finishedAt : null,
        nextStatus === 'delivered' || nextStatus === 'failed' ? finishedAt : null,
      ],
    );
    const row = updated.rows[0] ?? delivery;
    return {
      deliveryId,
      subscriptionId: delivery.subscription_id,
      outcome:
        nextStatus === 'delivered' ? ('delivered' as const) : nextStatus === 'failed' ? ('failed' as const) : ('retrying' as const),
      statusCode,
      attempts: toInt(row.attempts),
      nextAttemptAt:
        nextStatus === 'pending' ? toIso(row.next_attempt_at) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Audit (lock 32 / ADR-0005: every operation is audited)
// ---------------------------------------------------------------------------

export interface ApiAuditDetail {
  operation: string;
  method: string;
  path: string;
  status: number;
  keyId: string;
  requestId: string;
}

/**
 * Append the immutable audit event of one public-API operation (type
 * `api.operation`): actor = the key's principal, source = the public api,
 * correlation = the request id, payload = what ran and how it ended. The
 * event itself is what webhook fanout consumes — auditing and the event
 * surface are one and the same discipline.
 */
export async function auditApiOperation(ctx: TenantContext, detail: ApiAuditDetail): Promise<Event> {
  assertApiTenantContext(ctx);
  return appendEvent(ctx, {
    type: API_AUDIT_EVENT_TYPE,
    typeVersion: 1,
    payload: {
      operation: detail.operation,
      method: detail.method,
      path: detail.path,
      status: detail.status,
      keyId: detail.keyId,
      requestId: detail.requestId,
    },
    occurredAt: now().toISOString(),
    actor: { kind: 'person', id: ctx.principalId, label: `api-key:${detail.keyId}` },
    source: { kind: 'api', label: `public-api/${API_VERSION}` },
    correlationId: detail.requestId,
  });
}
