// AI preferences (W091) — API request handling.
//
// The /api/product/ai/preferences route handlers are thin adapters in
// the IMPLEMENTATION-STACK §5 sense: resolve the tenant context from
// the SESSION COOKIE (W058 — the auth contract re-verifies the active
// company's membership; the header/query seam is gone), delegate to the
// view builder / action dispatcher (the provider-preferences module's
// contract only — locks 31/32), and map module errors to HTTP-ish
// outcomes. No handler logic lives in route.ts, so the entire surface
// is testable without booting Next.js — the discipline every product
// surface follows.
//
//   GET  /api/product/ai/preferences
//        — the whole outcome-oriented preferences view (the same read
//          model the /ai/preferences page renders; jargon-free).
//   POST /api/product/ai/preferences
//        — one surface action (set/clear the personal preference, set
//          the company preference, set/clear a technical override)
//          through the provider-preferences contract.

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import { buildPreferencesView } from './views';
import type { PreferencesView } from './views';
import {
  actionErrorStatus,
  executeAction,
  isPreferenceAction,
  parseActionBody,
  PreferenceActionParseError,
} from './actions';
import type { PreferenceAction } from './actions';

/** The session-based context resolution of the preferences API (W058). */
export type PreferencesContextResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; failure: 'unauthenticated' | 'no_active_company'; detail: string };

export interface PreferencesApiOk {
  status: 200;
  body: PreferencesApiEnvelope;
}

export type PreferencesApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

export interface PreferencesApiError {
  status: PreferencesApiErrorStatus;
  body: { error: string; message: string };
}

export type PreferencesApiResult = PreferencesApiOk | PreferencesApiError;

/** The JSON envelope every /api/product/ai/preferences success returns. */
export interface PreferencesApiEnvelope {
  surface: 'ai-preferences';
  tenantId: string;
  generatedAt: string;
  view?: PreferencesView;
  action?: PreferenceAction;
  summary?: string;
}

function apiError(
  status: PreferencesApiErrorStatus,
  error: string,
  message: string,
): PreferencesApiError {
  return { status, body: { error, message } };
}

/**
 * Resolve the preferences context for an API request (W058: from the
 * session cookie — the header/query seam is gone). Anonymous requests
 * are 401; a session without an active company is 409 (the client
 * routes to onboarding).
 */
export async function preferencesContextFromRequest(
  request: Request,
): Promise<PreferencesContextResolution> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return { ok: false, failure: 'unauthenticated', detail: 'no session for this request' };
  }
  if (resolution.status === 'no-company') {
    return {
      ok: false,
      failure: 'no_active_company',
      detail: 'the session has no active company',
    };
  }
  return { ok: true, context: resolution.context };
}

/** GET: the whole outcome-oriented preferences view. */
export async function handlePreferencesGet(
  request: Request,
): Promise<PreferencesApiResult> {
  const resolution = await preferencesContextFromRequest(request);
  if (!resolution.ok) {
    return apiError(
      resolution.failure === 'unauthenticated' ? 401 : 409,
      resolution.failure,
      resolution.detail,
    );
  }
  const view = await buildPreferencesView(resolution.context);
  return {
    status: 200,
    body: {
      surface: 'ai-preferences',
      tenantId: resolution.context.tenantId,
      generatedAt: view.generatedAt,
      view,
    },
  };
}

/** POST: one surface action through the provider-preferences contract. */
export async function handlePreferencesAction(
  request: Request,
  body: unknown,
): Promise<PreferencesApiResult> {
  const resolution = await preferencesContextFromRequest(request);
  if (!resolution.ok) {
    return apiError(
      resolution.failure === 'unauthenticated' ? 401 : 409,
      resolution.failure,
      resolution.detail,
    );
  }
  let parsed;
  try {
    parsed = parseActionBody(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'malformed action body';
    return apiError(400, 'invalid_body', message);
  }
  try {
    const result = await executeAction(resolution.context, parsed);
    const view = await buildPreferencesView(resolution.context);
    return {
      status: 200,
      body: {
        surface: 'ai-preferences',
        tenantId: resolution.context.tenantId,
        generatedAt: view.generatedAt,
        view,
        action: parsed.action,
        summary: result.summary,
      },
    };
  } catch (error) {
    const { status, message } = actionErrorStatus(error);
    return apiError(status, errorNameOf(error), message);
  }
}

function errorNameOf(error: unknown): string {
  if (error instanceof PreferenceActionParseError) return 'invalid_body';
  if (error instanceof Error && error.name === 'ProviderPreferencesError') return 'module_error';
  return 'action_failed';
}

/** Re-export the action guard for route.ts (kept tiny). */
export { isPreferenceAction };
