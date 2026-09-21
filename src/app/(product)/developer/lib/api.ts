// Developer / API / MCP Console (W067) — API request handling.
//
// The /api/product/developer route handlers are thin adapters in the
// IMPLEMENTATION-STACK §5 sense: resolve the tenant context from the
// SESSION COOKIE (W058 — the auth contract re-verifies the active
// company's membership; the header/query seam is gone), delegate to the
// view builder / action dispatcher (the api module's contract only —
// locks 31/32), and map module errors to HTTP-ish outcomes. No handler
// logic lives in route.ts, so the entire surface is testable without
// booting Next.js — the discipline every product surface follows.
//
//   GET  /api/product/developer[?delivery=<uuid>]
//        — the whole developer-console view; `delivery` additionally
//          resolves one webhook delivery WITH its append-only attempt
//          trail (uniform not-found for foreign/missing ids).
//   POST /api/product/developer
//        — one surface action (key create/revoke/rotate, webhook
//          create/deactivate/test/redeliver/dispatch) through the api
//          contract.

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import { getWebhookDelivery } from '@/modules/api/contract';
import type { WebhookDeliveryDetail } from '@/modules/api/contract';
import { buildDeveloperView } from './views';
import type { DeveloperView } from './views';
import { executeDeveloperAction, parseActionBody, summarizeActionResult } from './actions';
import type { DeveloperAction } from './actions';

/** The session-based context resolution of the developer API (W058). */
export type DeveloperContextResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; failure: 'unauthenticated' | 'no_active_company'; detail: string };

export interface ApiOk {
  status: 200;
  body: DeveloperApiEnvelope;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

/** The JSON envelope every /api/product/developer success returns. */
export interface DeveloperApiEnvelope {
  surface: 'developer';
  tenantId: string;
  generatedAt: string;
  view?: DeveloperView;
  /** The resolved delivery detail, when ?delivery= was present. */
  delivery?: WebhookDeliveryDetail | null;
  action?: DeveloperAction;
  summary?: string;
  result?: unknown;
}

function apiError(status: ApiErrorStatus, error: string, message: string): ApiError {
  return { status, body: { error, message } };
}

/** Map a session-resolution failure to its API outcome (W058). */
function developerContextError(failure: string, detail: string): ApiError {
  if (failure === 'unauthenticated') return apiError(401, failure, detail);
  return apiError(409, failure, detail);
}

/**
 * Resolve the developer-console context for an API request (W058: from the
 * session cookie — the header/query seam is gone). Anonymous requests are
 * 401; a session without an active company is 409 (the client routes to
 * onboarding).
 */
export async function developerContextFromRequest(
  request: Request,
): Promise<DeveloperContextResolution> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return { ok: false, failure: 'unauthenticated', detail: 'no session for this request' };
  }
  if (resolution.status === 'no-company') {
    return {
      ok: false,
      failure: 'no_active_company',
      detail: 'the session has no active company — complete onboarding first',
    };
  }
  return { ok: true, context: resolution.context };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `?delivery=` query parameter: a uuid-shaped string or null. A
 * non-uuid value maps to 400 (malformed request), a uuid that matches no
 * delivery maps to 404 (uniform not-found — no cross-tenant leak).
 */
export function deliveryIdFromRequest(request: Request): string | null | 'invalid' {
  const url = new URL(request.url);
  const value = url.searchParams.get('delivery');
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : 'invalid';
}

/** GET /api/product/developer — build the whole developer-console view. */
export async function handleDeveloperGet(request: Request): Promise<ApiResult> {
  const context = await developerContextFromRequest(request);
  if (!context.ok) {
    return developerContextError(context.failure, context.detail);
  }
  const deliveryId = deliveryIdFromRequest(request);
  if (deliveryId === 'invalid') {
    return apiError(400, 'invalid_query', 'the delivery parameter must be a uuid');
  }
  let delivery: WebhookDeliveryDetail | null = null;
  if (deliveryId !== null) {
    try {
      delivery = await getWebhookDelivery(context.context, { deliveryId });
    } catch (error) {
      return developerApiError(error);
    }
  }
  const view = await buildDeveloperView(context.context);
  return {
    status: 200,
    body: {
      surface: 'developer',
      tenantId: context.context.tenantId,
      generatedAt: view.generatedAt,
      view,
      ...(deliveryId === null ? {} : { delivery }),
    },
  };
}

/** POST /api/product/developer — execute one surface action through the api contract. */
export async function handleDeveloperAction(request: Request, body: unknown): Promise<ApiResult> {
  const context = await developerContextFromRequest(request);
  if (!context.ok) {
    return developerContextError(context.failure, context.detail);
  }
  const parsed = parseActionBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const result = await executeDeveloperAction(context.context, parsed.value);
    return {
      status: 200,
      body: {
        surface: 'developer',
        tenantId: context.context.tenantId,
        generatedAt: new Date().toISOString(),
        action: result.action,
        summary: summarizeActionResult(result),
        result,
      },
    };
  } catch (error) {
    return developerApiError(error);
  }
}

/**
 * Map a module error to an API outcome (code-carrying errors only).
 * `provider_unavailable` is the honest 503: the environment has no webhook
 * transport wired, which no request body can fix. `missing_scope` /
 * `forbidden` are the authority gates (the contract's own decision).
 */
export function developerApiError(error: unknown): ApiError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected developer-console failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'missing_scope' || code === 'forbidden' || code === 'unauthorized') {
    return apiError(403, code, message);
  }
  if (code === 'provider_unavailable') return apiError(503, code, message);
  if (code === 'webhook_conflict') return apiError(409, code, message);
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}
