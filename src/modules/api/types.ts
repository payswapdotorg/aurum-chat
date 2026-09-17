// Domain types of the api module (W038 — Public API).
//
// These types are the module's data vocabulary: the framework-neutral
// request/response model the Next.js route handlers translate HTTP into
// (IMPLEMENTATION-STACK §5: "thin adapters that authenticate, scope tenant,
// delegate to module contracts, audit"), the API keys that authenticate
// machine callers, and the webhook subscriptions/deliveries that make the
// API an event surface. Persistence shape (snake_case rows) is private to
// the service; contract consumers only ever see the camelCase entities
// below.
//
// VERSIONING (the work item's first word): the public surface lives under
// `/api/v1` — the version is part of the URL space, so a future v2 can be
// mounted beside v1 without touching v1 clients. `API_VERSION` /
// `API_BASE_PATH` are the single source of that truth; every response also
// carries the `x-aurum-api-version` header and webhook envelopes embed
// `version: 1`.

import type { ApiScope } from './scopes';

/** The public version this module serves. */
export const API_VERSION = 'v1' as const;

/** The URL prefix every public API request lives under. */
export const API_BASE_PATH = `/api/${API_VERSION}` as const;

/**
 * One inbound public-API request, already stripped of HTTP framing.
 * `path` is the full request path (`/api/v1/goals/…`); `headers` keys are
 * lowercased; `query` holds the parsed query parameters; `body` is the
 * parsed JSON body (undefined when absent or unparseable).
 */
export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** One outbound public-API response, before HTTP framing. */
export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// API keys — the machine-caller credentials
// ---------------------------------------------------------------------------

export type ApiKeyStatus = 'active' | 'revoked';

/**
 * A tenant-scoped API key. The credential itself never appears here (or
 * anywhere persisted): only its sha-256 hash is stored (the identity
 * module's challenge-code precedent), and the raw key is returned exactly
 * once, at issuance.
 */
export interface ApiKey {
  id: string;
  tenantId: string;
  /** The principal the key acts as (TenantContext.principalId). */
  principalId: string;
  label: string;
  /** API capability scopes granted to the key (closed vocabulary). */
  scopes: ApiScope[];
  /** Authority claims the key may pass downstream (closed vocabulary). */
  authority: string[];
  status: ApiKeyStatus;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** Input shape of `createApiKey`. */
export interface CreateApiKeyInput {
  label: string;
  /** Defaults to the acting principal. Must be a member of the tenant. */
  principalId?: string;
  /** 1..n capability scopes from API_SCOPES. */
  scopes: string[];
  /** 0..n authority claims from API_KEY_AUTHORITY_CLAIMS. */
  authority?: string[];
}

/** The one-time issuance result — the raw key appears here exactly once. */
export interface ApiKeyIssuance {
  apiKey: ApiKey;
  key: string;
}

// ---------------------------------------------------------------------------
// Webhook subscriptions — the outbound event surface
// ---------------------------------------------------------------------------

export type WebhookSubscriptionStatus = 'active' | 'deactivated';

/**
 * A tenant's subscription to a delivery endpoint. `eventTypes` are event-type
 * patterns (`goal.revised`, `goal.*`, `*`); `secretRef` is an OPAQUE
 * secret-store reference to the HMAC signing secret — the value itself never
 * reaches any domain table (IMPLEMENTATION-STACK §8, the sources/channels
 * `credential_ref` precedent); the webhook transport resolves it.
 */
export interface WebhookSubscription {
  id: string;
  tenantId: string;
  label: string;
  url: string;
  eventTypes: string[];
  secretRef: string | null;
  maxAttempts: number;
  status: WebhookSubscriptionStatus;
  createdAt: string;
  createdBy: string;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
}

/** Input shape of `createWebhookSubscription`. */
export interface CreateWebhookSubscriptionInput {
  label: string;
  /** https:// required (plain http allowed only for loopback hosts). */
  url: string;
  /** 1..20 event-type patterns; at least one must match for delivery. */
  eventTypes: string[];
  /** Opaque secret-store reference for HMAC signing (optional). */
  secretRef?: string | null;
  /** Delivery attempt budget, 1..10 (default 5). */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Webhook deliveries — the append-evidence outbound queue
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

export type WebhookDeliveryKind = 'event' | 'test';

export type WebhookAttemptOutcome = 'succeeded' | 'transient_failure' | 'terminal_failure';

/**
 * One webhook delivery. `body` is the FROZEN delivery envelope — the exact
 * bytes POSTed on every attempt, so signatures stay verifiable across
 * retries. `eventId` is null exactly on `test` pings. `redeliveryOf` names
 * the delivery an explicit redelivery was cloned from (the fanout unique
 * constraint exempts redeliveries, so history stays append-only).
 */
export interface WebhookDelivery {
  id: string;
  tenantId: string;
  subscriptionId: string;
  kind: WebhookDeliveryKind;
  eventId: string | null;
  eventType: string;
  body: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  finalizedAt: string | null;
  redeliveryOf: string | null;
}

/** One append-only delivery attempt (the evidence trail). */
export interface WebhookDeliveryAttempt {
  id: string;
  tenantId: string;
  deliveryId: string;
  attemptNo: number;
  outcome: WebhookAttemptOutcome;
  statusCode: number | null;
  error: string | null;
  latencyMs: number | null;
  startedAt: string;
  finishedAt: string;
}

/** One delivery plus its append-only attempt trail. */
export interface WebhookDeliveryDetail {
  delivery: WebhookDelivery;
  attempts: WebhookDeliveryAttempt[];
}

// ---------------------------------------------------------------------------
// The webhook transport port (provider-neutral delivery; implementations
// are module-internal wiring — HTTP/SDK code may only live inside
// src/modules/api/. No transport is wired by default; dispatches then fail
// explicitly with `provider_unavailable` (the agents/sources/llm "as
// provider availability permits" discipline).
// ---------------------------------------------------------------------------

/**
 * The provider-neutral request handed to the transport. The transport
 * resolves `secretRef` against the secret store, computes the canonical
 * HMAC signature (`computeWebhookSignature`) over
 * `${timestamp}.${body}` and POSTs `body` to `url` with headers
 * `aurum-webhook-timestamp`, `aurum-webhook-signature`,
 * `aurum-webhook-delivery`, `aurum-webhook-subscription`.
 */
export interface WebhookTransportRequest {
  subscriptionId: string;
  deliveryId: string;
  attemptNo: number;
  url: string;
  secretRef: string | null;
  /** ISO 8601 — when this attempt was signed. */
  timestamp: string;
  /** The exact bytes to deliver (the frozen delivery envelope). */
  body: string;
}

/** The provider-neutral outcome of one delivery attempt. */
export interface WebhookTransportReceipt {
  /** True only for a 2xx response. */
  ok: boolean;
  /** Null when no HTTP response arrived (network error / timeout). */
  statusCode: number | null;
  error?: string | null;
  latencyMs: number;
}

export interface WebhookTransport {
  deliver(request: WebhookTransportRequest): Promise<WebhookTransportReceipt>;
}

/** Per-delivery dispatch outcome of one pump run. */
export interface WebhookDispatchOutcome {
  deliveryId: string;
  subscriptionId: string;
  outcome: 'delivered' | 'retrying' | 'failed' | 'skipped';
  statusCode: number | null;
  attempts: number;
  nextAttemptAt: string | null;
}

/** Result shape of `dispatchWebhookDeliveries`. */
export interface DispatchWebhookDeliveriesResult {
  dispatched: WebhookDispatchOutcome[];
}

/** Result shape of `fanoutEvent` (and the internal auto-fanout). */
export interface FanoutEventResult {
  eventId: string;
  matched: number;
  enqueued: string[];
}

// ---------------------------------------------------------------------------
// Discovery — the versioned self-describing surface manifest
// ---------------------------------------------------------------------------

export interface ApiOperationDescriptor {
  method: string;
  path: string;
  operation: string;
  /** The API scope required to call the operation (null = unauthenticated). */
  scope: string | null;
}

/** `GET /api/v1` — the static, tenant-free capability manifest. */
export interface ApiDiscoveryDocument {
  version: typeof API_VERSION;
  path: typeof API_BASE_PATH;
  scopes: readonly string[];
  authorityClaims: readonly string[];
  operations: ApiOperationDescriptor[];
  webhooks: {
    eventTypes: string;
    signature: string;
    envelope: string;
  };
}
