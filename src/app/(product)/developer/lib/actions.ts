// Developer / API / MCP Console (W067) — the action surface.
//
// The /developer surface's WRITE path is a thin, explicit dispatcher over
// the api module's CONTRACT (W038 — the public API domain is the single way
// in, locks 31/32):
//
//   key.create         — mint a tenant-scoped api key (scopes + authority
//                       claims + optional grantee principal); the raw key
//                       is returned EXACTLY ONCE
//   key.revoke         — revoke a key (idempotent; the record and audit
//                       history stay)
//   key.rotate         — ROTATION as an explicit composition of the same
//                       two contract operations: issue a fresh key with the
//                       old key's grant, then revoke the old key. Issue-
//                       then-revoke is the safe order: if the second step
//                       ever fails, the integration keeps working under
//                       the old key and the operator simply retries —
//                       revoke-first could strand an integration with NO
//                       valid credential. This surface implements NO new
//                       domain logic and persists nothing of its own; the
//                       contract's own validation, tenant scoping and
//                       authority checks decide everything.
//   webhook.create     — subscribe one https endpoint to event-type patterns
//   webhook.deactivate  — stop fanout to a subscription (idempotent)
//   webhook.test       — enqueue a synthetic test ping for a subscription
//   webhook.redeliver   — clone one delivery as a fresh pending one
//   webhook.dispatch   — run the delivery pump for due deliveries; with no
//                       transport wired in this process it returns the
//                       honest unwired RESULT (not an error — the W066
//                       discipline: a failed test is a result)
//
// Discipline (scope rules / GOVERNANCE):
//   * body parsing/validation is pure and unit-testable; execution is a
//     separate step so tests drive the exact code the /api/product/developer
//     route drives without booting Next.js;
//   * there is NO field anywhere in this surface that accepts a webhook
//     signing-secret VALUE — only an opaque `secretRef`;
//   * the raw key value appears only in the action RESULT (client-side
//     reveal); the view/read model can never carry it (only sha-256
//     hashes persist anywhere).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { ApiError } from '@/modules/api/contract';
import {
  createApiKey,
  createWebhookSubscription,
  deactivateWebhookSubscription,
  dispatchWebhookDeliveries,
  getApiWebhookTransport,
  listApiKeys,
  redeliverWebhookDelivery,
  revokeApiKey,
  sendWebhookTest,
} from '@/modules/api/contract';
import type { ApiKey, ApiKeyIssuance, WebhookDelivery, WebhookSubscription } from '@/modules/api/contract';

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export const DEVELOPER_ACTIONS = [
  'key.create',
  'key.revoke',
  'key.rotate',
  'webhook.create',
  'webhook.deactivate',
  'webhook.test',
  'webhook.redeliver',
  'webhook.dispatch',
] as const;

export type DeveloperAction = (typeof DEVELOPER_ACTIONS)[number];

export function isDeveloperAction(value: unknown): value is DeveloperAction {
  return typeof value === 'string' && (DEVELOPER_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parsed inputs (shape-checked; the contract re-validates authoritatively)
// ---------------------------------------------------------------------------

export type ParsedActionInput =
  | { action: 'key.create'; label: string; scopes: string[]; authority: string[]; principalId: string | null }
  | { action: 'key.revoke'; keyId: string }
  | { action: 'key.rotate'; keyId: string }
  | {
      action: 'webhook.create';
      label: string;
      url: string;
      eventTypes: string[];
      secretRef: string | null;
      maxAttempts: number | null;
    }
  | { action: 'webhook.deactivate'; subscriptionId: string }
  | { action: 'webhook.test'; subscriptionId: string }
  | { action: 'webhook.redeliver'; deliveryId: string }
  | { action: 'webhook.dispatch' };

export type ParseResult =
  | { ok: true; value: ParsedActionInput }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure body parsing
// ---------------------------------------------------------------------------

function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/** Accepts a JSON array or a comma/newline/whitespace-separated string. */
function parseEventTypeList(value: unknown): string[] | null {
  if (Array.isArray(value)) return stringArray(value);
  if (typeof value === 'string') {
    const parts = value
      .split(/[,\n]/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    return parts;
  }
  return null;
}

/**
 * Parse and shape-check one action body. PURE. The api contract remains the
 * authoritative validator — this layer only guarantees the shape the
 * dispatcher needs and produces readable 400 messages.
 */
export function parseActionBody(body: unknown): ParseResult {
  if (!isObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const action = body['action'];
  if (!isDeveloperAction(action)) {
    return {
      ok: false,
      error: `unknown action '${String(action)}' (supported: ${DEVELOPER_ACTIONS.join(', ')})`,
    };
  }

  switch (action) {
    case 'key.create': {
      const label = text(body['label']);
      if (label === null) {
        return { ok: false, error: 'key.create requires a label' };
      }
      const scopes = stringArray(body['scopes']);
      if (scopes === null || scopes.length === 0) {
        return { ok: false, error: 'key.create requires a non-empty scopes array' };
      }
      // Optional, defaulting to the empty grant — the contract's own
      // semantics (parseAuthorityGrant treats missing as []).
      const authority = body['authority'] === undefined || body['authority'] === null
        ? []
        : stringArray(body['authority']);
      if (authority === null) {
        return { ok: false, error: 'key.create: authority must be an array of claim names (may be empty)' };
      }
      const principalId = text(body['principalId']);
      return {
        ok: true,
        value: { action, label, scopes, authority, principalId },
      };
    }
    case 'key.revoke':
    case 'key.rotate': {
      const keyId = text(body['keyId']);
      if (keyId === null) {
        return { ok: false, error: `${action} requires a keyId` };
      }
      return { ok: true, value: { action, keyId } };
    }
    case 'webhook.create': {
      const label = text(body['label']);
      if (label === null) {
        return { ok: false, error: 'webhook.create requires a label' };
      }
      const url = text(body['url']);
      if (url === null) {
        return { ok: false, error: 'webhook.create requires a url (https, or http for loopback hosts)' };
      }
      const eventTypes = parseEventTypeList(body['eventTypes']);
      if (eventTypes === null || eventTypes.length === 0) {
        return {
          ok: false,
          error: 'webhook.create requires at least one event-type pattern (array or comma/newline-separated)',
        };
      }
      const secretRef = text(body['secretRef']);
      let maxAttempts: number | null = null;
      if (body['maxAttempts'] !== undefined && body['maxAttempts'] !== null && body['maxAttempts'] !== '') {
        const value = Number(body['maxAttempts']);
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          return { ok: false, error: 'webhook.create: maxAttempts must be an integer 1..10' };
        }
        maxAttempts = value;
      }
      return {
        ok: true,
        value: { action, label, url, eventTypes, secretRef, maxAttempts },
      };
    }
    case 'webhook.deactivate':
    case 'webhook.test': {
      const subscriptionId = text(body['subscriptionId']);
      if (subscriptionId === null) {
        return { ok: false, error: `${action} requires a subscriptionId` };
      }
      return { ok: true, value: { action, subscriptionId } };
    }
    case 'webhook.redeliver': {
      const deliveryId = text(body['deliveryId']);
      if (deliveryId === null) {
        return { ok: false, error: 'webhook.redeliver requires a deliveryId' };
      }
      return { ok: true, value: { action, deliveryId } };
    }
    case 'webhook.dispatch':
      return { ok: true, value: { action } };
  }
}

// ---------------------------------------------------------------------------
// Rotation labeling (pure)
// ---------------------------------------------------------------------------

/** Max label length the api contract accepts (mirrored for truncation). */
const LABEL_MAX = 120;

/**
 * The replacement key's label: the old label, marked with its rotation
 * stamp, kept inside the contract's 1..120 budget by trimming the ORIGINAL
 * part first (the stamp itself is never cut, so the marker always lands).
 */
export function rotatedLabel(original: string, nowIso: string): string {
  const stamp = ` (rotated ${nowIso.slice(0, 10)})`;
  const budget = LABEL_MAX - stamp.length;
  const base = original.length <= budget ? original : original.slice(0, budget);
  return `${base}${stamp}`;
}

// ---------------------------------------------------------------------------
// Action results
// ---------------------------------------------------------------------------

/**
 * key.create / key.rotate — the one-time raw key rides the result ONLY
 * (never the view/read model; nothing persists it anywhere).
 */
export interface KeyIssuedResult {
  kind: 'key';
  action: 'key.create' | 'key.rotate';
  apiKey: ApiKey;
  /** The raw key — rendered once by the client reveal, never persisted. */
  key: string;
  /** Rotation only: the revoked predecessor. */
  revoked?: ApiKey;
}

/** key.revoke — the credential is gone; only the record remains. */
export interface KeyRevokedResult {
  kind: 'key';
  action: 'key.revoke';
  apiKey: ApiKey;
}

export interface WebhookActionResult {
  kind: 'webhook';
  action: 'webhook.create' | 'webhook.deactivate' | 'webhook.test' | 'webhook.redeliver' | 'webhook.dispatch';
  subscription?: WebhookSubscription;
  delivery?: WebhookDelivery;
  /** webhook.dispatch only. */
  dispatched?: { deliveryId: string; outcome: string; statusCode: number | null; attempts: number }[];
  /** webhook.dispatch only: false when no transport is wired (deliveries stay pending). */
  transportWired?: boolean;
}

export type DeveloperActionResult = KeyIssuedResult | KeyRevokedResult | WebhookActionResult;

// ---------------------------------------------------------------------------
// Execution (delegates to the api contract; the contract decides everything)
// ---------------------------------------------------------------------------

async function rotateApiKey(ctx: TenantContext, keyId: string): Promise<KeyIssuedResult> {
  // Resolve the grant to copy: listApiKeys is the contract's tenant-scoped
  // read (and re-checks 'api:administer' itself).
  const keys = await listApiKeys(ctx);
  const source = keys.find((candidate) => candidate.id === keyId);
  if (source === undefined) {
    throw new ApiError('api_key_not_found', `api key '${keyId}' does not exist in this tenant`);
  }
  if (source.status !== 'active') {
    throw new ApiError(
      'invalid_input',
      'the key being rotated is already revoked — create a fresh key instead',
    );
  }
  // 1. Issue the replacement (same principal, scopes and authority claims).
  const issuance: ApiKeyIssuance = await createApiKey(ctx, {
    label: rotatedLabel(source.label, now().toISOString()),
    principalId: source.principalId,
    scopes: [...source.scopes],
    authority: [...source.authority],
  });
  // 2. Revoke the predecessor. Failure is reported honestly: the new key
  //    IS active, the old one may still be — the operator retries the
  //    (idempotent) revoke.
  let revoked: ApiKey;
  try {
    revoked = await revokeApiKey(ctx, { keyId });
  } catch (error) {
    throw new ApiError(
      'internal_error',
      `rotation incomplete: the replacement key was issued but the old key could not be revoked (${
        error instanceof Error ? error.message : 'unknown failure'
      }) — revoke it explicitly`,
    );
  }
  return { kind: 'key', action: 'key.rotate', apiKey: issuance.apiKey, key: issuance.key, revoked };
}

/**
 * Execute one parsed action through the api module's contract. Throws the
 * module's own typed errors (ApiError) — the API layer maps them to HTTP
 * outcomes. NO surface-level authority gates: the contract's own checks are
 * the gate (GOVERNANCE: no second source of truth, not even for policy).
 */
export async function executeDeveloperAction(
  ctx: TenantContext,
  input: ParsedActionInput,
): Promise<DeveloperActionResult> {
  switch (input.action) {
    case 'key.create': {
      const issuance = await createApiKey(ctx, {
        label: input.label,
        principalId: input.principalId ?? undefined,
        scopes: input.scopes,
        authority: input.authority,
      });
      return { kind: 'key', action: 'key.create', apiKey: issuance.apiKey, key: issuance.key };
    }
    case 'key.revoke': {
      const apiKey = await revokeApiKey(ctx, { keyId: input.keyId });
      return { kind: 'key', action: 'key.revoke', apiKey };
    }
    case 'key.rotate':
      return rotateApiKey(ctx, input.keyId);
    case 'webhook.create': {
      const subscription = await createWebhookSubscription(ctx, {
        label: input.label,
        url: input.url,
        eventTypes: input.eventTypes,
        secretRef: input.secretRef,
        maxAttempts: input.maxAttempts ?? undefined,
      });
      return { kind: 'webhook', action: 'webhook.create', subscription };
    }
    case 'webhook.deactivate': {
      const subscription = await deactivateWebhookSubscription(ctx, {
        subscriptionId: input.subscriptionId,
      });
      return { kind: 'webhook', action: 'webhook.deactivate', subscription };
    }
    case 'webhook.test': {
      const delivery = await sendWebhookTest(ctx, { subscriptionId: input.subscriptionId });
      return { kind: 'webhook', action: 'webhook.test', delivery };
    }
    case 'webhook.redeliver': {
      const delivery = await redeliverWebhookDelivery(ctx, { deliveryId: input.deliveryId });
      return { kind: 'webhook', action: 'webhook.redeliver', delivery };
    }
    case 'webhook.dispatch': {
      // The honest unwired result (the W066 discipline): with no transport
      // wired in this process the pump cannot run, and no request body can
      // change that — deliveries stay pending and the surface says so.
      if (getApiWebhookTransport() === null) {
        return { kind: 'webhook', action: 'webhook.dispatch', dispatched: [], transportWired: false };
      }
      const result = await dispatchWebhookDeliveries(ctx, {});
      return {
        kind: 'webhook',
        action: 'webhook.dispatch',
        dispatched: result.dispatched.map((outcome) => ({
          deliveryId: outcome.deliveryId,
          outcome: outcome.outcome,
          statusCode: outcome.statusCode,
          attempts: outcome.attempts,
        })),
        transportWired: true,
      };
    }
  }
}

/** Human summary of one action result (the client status line + tests). */
export function summarizeActionResult(result: DeveloperActionResult): string {
  switch (result.action) {
    case 'key.create':
      return `Key “${result.apiKey.label}” created — copy the raw key now, it is shown once.`;
    case 'key.revoke':
      return `Key “${result.apiKey.label}” revoked. The record and its audit history stay.`;
    case 'key.rotate':
      return `Key “${result.apiKey.label}” issued and the old key revoked — copy the new raw key now, it is shown once.`;
    case 'webhook.create':
      return `Webhook “${result.subscription?.label ?? ''}” subscribed.`;
    case 'webhook.deactivate':
      return `Webhook “${result.subscription?.label ?? ''}” deactivated — no further fanout targets it.`;
    case 'webhook.test':
      return `Test ping enqueued (delivery ${result.delivery?.id.slice(0, 8) ?? ''}). Run the delivery pump to send it.`;
    case 'webhook.redeliver':
      return `Delivery ${result.delivery?.id.slice(0, 8) ?? ''} cloned as a fresh pending redelivery.`;
    case 'webhook.dispatch':
      if (result.transportWired === false) {
        return 'No webhook transport is wired in this process — deliveries stay pending until one is.';
      }
      return `Delivery pump ran: ${result.dispatched?.length ?? 0} due deliver${(result.dispatched?.length ?? 0) === 1 ? 'y' : 'ies'} attempted.`;
  }
}
