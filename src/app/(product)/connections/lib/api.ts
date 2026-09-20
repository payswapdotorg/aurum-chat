// Connection & Integration Hub (W059) — API request handling.
//
// The /api/connections route handlers are thin adapters in the
// IMPLEMENTATION-STACK §5 sense: resolve the tenant context — W058: from
// the SESSION COOKIE (the auth contract re-verifies the active company's
// membership; the header/query seam is gone) — delegate to the view
// builder / action dispatcher (module contracts only — locks 31/32), map
// module errors to HTTP-ish outcomes. No handler logic lives in route.ts,
// so the entire surface is testable without booting Next.js — the same
// discipline the tower (W033) applies.

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';

/** The session-based context resolution of the hub API (W058). */
export type ConnectionsContextResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; failure: 'unauthenticated' | 'no_active_company'; detail: string };
import { buildConnectionsView } from './views';
import type { ConnectionsView, ConnectionsViewOptions } from './views';
import { executeConnectionsAction, parseActionBody } from './actions';
import type { ActionOutcome, ConnectionsAction } from './actions';

export interface ApiOk {
  status: 200;
  body: ConnectionsApiEnvelope;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

/** The JSON envelope every hub GET/POST success returns. */
export interface ConnectionsApiEnvelope {
  surface: 'connections';
  tenantId: string;
  generatedAt: string;
  view?: ConnectionsView;
  action?: ConnectionsAction;
  summary?: string;
  result?: unknown;
}

/** Map a session-resolution failure to its API outcome (W058). */
function connectionsContextError(failure: string, detail: string): ApiError {
  if (failure === 'unauthenticated') return apiError(401, failure, detail);
  return apiError(409, failure, detail);
}

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

/**
 * Resolve the hub context for an API request (W058: from the session
 * cookie — the header/query seam is gone). Anonymous requests are 401; a
 * session without an active company is 409 (the client routes to
 * onboarding).
 */
export async function connectionsContextFromRequest(request: Request): Promise<ConnectionsContextResolution> {
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

/** Query-string view options (identity lookup parameters). */
export function viewOptionsFromRequest(request: Request): ConnectionsViewOptions {
  const url = new URL(request.url);
  const provider = url.searchParams.get('identity_provider');
  const account = url.searchParams.get('identity_account');
  if (provider === null || provider.trim() === '' || account === null || account.trim() === '') {
    return {};
  }
  return { identityLookup: { provider: provider.trim(), providerAccountId: account.trim() } };
}

/** GET /api/connections — build the whole hub view. */
export async function handleConnectionsGet(request: Request): Promise<ApiResult> {
  const context = await connectionsContextFromRequest(request);
  if (!context.ok) {
    return connectionsContextError(context.failure, context.detail);
  }
  const view = await buildConnectionsView(context.context, viewOptionsFromRequest(request));
  return {
    status: 200,
    body: {
      surface: 'connections',
      tenantId: context.context.tenantId,
      generatedAt: view.generatedAt,
      view,
    },
  };
}

/** POST /api/connections — execute one hub action through the contracts. */
export async function handleConnectionsAction(
  request: Request,
  body: unknown,
): Promise<ApiResult> {
  const context = await connectionsContextFromRequest(request);
  if (!context.ok) {
    return connectionsContextError(context.failure, context.detail);
  }
  const parsed = parseActionBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const outcome: ActionOutcome = await executeConnectionsAction(context.context, parsed.value);
    return {
      status: 200,
      body: {
        surface: 'connections',
        tenantId: context.context.tenantId,
        generatedAt: new Date().toISOString(),
        action: outcome.action,
        summary: outcome.summary,
        result: outcome.result,
      },
    };
  } catch (error) {
    return connectionsApiError(error);
  }
}

/** Conflict-ish module codes that map to 409 (lifecycle/state mismatches). */
const CONFLICT_CODES = new Set([
  'conflict',
  'not_pending',
  'ingestion_busy',
  'source_conflict',
  'delivery_not_retryable',
  'identity_already_verified',
  'identity_already_linked',
  'identity_not_eligible',
  'challenge_not_active',
  'challenge_expired',
  'challenge_code_mismatch',
  'challenge_attempts_exhausted',
]);

/** Map a module error to an API outcome (code-carrying errors only). */
export function connectionsApiError(error: unknown): ApiError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected connections failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized') return apiError(403, code, message);
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  if (CONFLICT_CODES.has(code)) return apiError(409, code, message);
  return apiError(400, code, message);
}
