// AI/BYOA & Provider Routing UX (W066) — API request handling.
//
// The /api/product/ai route handlers are thin adapters in the
// IMPLEMENTATION-STACK §5 sense: resolve the tenant context from the
// SESSION COOKIE (W058 — the auth contract re-verifies the active
// company's membership; the header/query seam is gone), delegate to the
// view builder / action dispatcher (the llm module's contract only —
// locks 28/31/32), and map module errors to HTTP-ish outcomes. No
// handler logic lives in route.ts, so the entire surface is testable
// without booting Next.js — the discipline every product surface follows.
//
//   GET  /api/product/ai[?verification=<uuid>]
//        — the whole AI-providers view; `verification` additionally
//          resolves one hot-swap verification record by id (uniform
//          not-found for foreign/missing ids).
//   POST /api/product/ai
//        — one surface action (register/update/revoke/test/availability/
//          hot-swap) through the llm contract.

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import { getHotSwapVerification } from '@/modules/llm/contract';
import type { LlmHotSwapVerification } from '@/modules/llm/contract';
import { buildByoaView } from './views';
import type { ByoaView } from './views';
import { executeAiAction, parseActionBody } from './actions';
import type { AiAction } from './actions';

/** The session-based context resolution of the AI-providers API (W058). */
export type AiContextResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; failure: 'unauthenticated' | 'no_active_company'; detail: string };

export interface ApiOk {
  status: 200;
  body: AiApiEnvelope;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

/** The JSON envelope every /api/product/ai success returns. */
export interface AiApiEnvelope {
  surface: 'ai';
  tenantId: string;
  generatedAt: string;
  view?: ByoaView;
  /** The resolved hot-swap verification, when ?verification= was present. */
  verification?: LlmHotSwapVerification | null;
  action?: AiAction;
  summary?: string;
  result?: unknown;
}

function apiError(status: ApiErrorStatus, error: string, message: string): ApiError {
  return { status, body: { error, message } };
}

/** Map a session-resolution failure to its API outcome (W058). */
function aiContextError(failure: string, detail: string): ApiError {
  if (failure === 'unauthenticated') return apiError(401, failure, detail);
  return apiError(409, failure, detail);
}

/**
 * Resolve the AI-providers context for an API request (W058: from the
 * session cookie — the header/query seam is gone). Anonymous requests are
 * 401; a session without an active company is 409 (the client routes to
 * onboarding).
 */
export async function aiContextFromRequest(request: Request): Promise<AiContextResolution> {
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
 * The `?verification=` query parameter: a uuid-shaped string or null. A
 * non-uuid value maps to 400 (malformed request), a uuid that matches no
 * verification maps to 404 (uniform not-found — no cross-tenant leak).
 */
export function verificationIdFromRequest(request: Request): string | null | 'invalid' {
  const url = new URL(request.url);
  const value = url.searchParams.get('verification');
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : 'invalid';
}

/** GET /api/product/ai — build the whole AI-providers view. */
export async function handleAiGet(request: Request): Promise<ApiResult> {
  const context = await aiContextFromRequest(request);
  if (!context.ok) {
    return aiContextError(context.failure, context.detail);
  }
  const verificationId = verificationIdFromRequest(request);
  if (verificationId === 'invalid') {
    return apiError(400, 'invalid_query', 'the verification parameter must be a uuid');
  }
  let verification: LlmHotSwapVerification | null = null;
  if (verificationId !== null) {
    try {
      verification = await getHotSwapVerification(context.context, {
        verificationId,
      });
    } catch (error) {
      return aiApiError(error);
    }
  }
  const view = await buildByoaView(context.context);
  return {
    status: 200,
    body: {
      surface: 'ai',
      tenantId: context.context.tenantId,
      generatedAt: view.generatedAt,
      view,
      ...(verificationId === null ? {} : { verification }),
    },
  };
}

/** POST /api/product/ai — execute one surface action through the llm contract. */
export async function handleAiAction(request: Request, body: unknown): Promise<ApiResult> {
  const context = await aiContextFromRequest(request);
  if (!context.ok) {
    return aiContextError(context.failure, context.detail);
  }
  const parsed = parseActionBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const outcome = await executeAiAction(context.context, parsed.value);
    return {
      status: 200,
      body: {
        surface: 'ai',
        tenantId: context.context.tenantId,
        generatedAt: new Date().toISOString(),
        action: outcome.action,
        summary: outcome.summary,
        result: outcome.result,
      },
    };
  } catch (error) {
    return aiApiError(error);
  }
}

/**
 * Map a module error to an API outcome (code-carrying errors only).
 * `provider_unavailable` is the honest 503: the environment has no
 * provider transport wired, which no request body can fix.
 */
export function aiApiError(error: unknown): ApiError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected AI-providers failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized') return apiError(403, code, message);
  if (code === 'provider_unavailable') return apiError(503, code, message);
  if (code === 'invocation_approval_required') return apiError(409, code, message);
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}
