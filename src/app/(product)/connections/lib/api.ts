// Connection & Integration Hub (W059) — API request handling.
//
// The /api/connections route handlers are thin adapters in the
// IMPLEMENTATION-STACK §5 sense: resolve the tenant context (the documented
// dev seam until W058), delegate to the view builder / action dispatcher
// (module contracts only — locks 31/32), map module errors to HTTP-ish
// outcomes. No handler logic lives in route.ts, so the entire surface is
// testable without booting Next.js — the same discipline the tower (W033)
// applies.

import { resolveRequestScope } from '@/app/lib/request-session';
import type { RequestScope } from '@/app/lib/request-session';
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

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

/**
 * Resolve the hub context for an API request (W058: from the SESSION
 * COOKIE — the query/header seam is gone). Returns the ready scope or
 * the 401/409 failure the handlers answer with.
 */
export async function connectionsScopeFromRequest(
  request: Request,
): Promise<
  | { ok: true; scope: Extract<RequestScope, { phase: 'ready' }> }
  | { ok: false; error: ApiError }
> {
  const scope = await resolveRequestScope(request);
  if (scope.phase === 'unauthenticated') {
    return { ok: false, error: apiError(401, 'unauthenticated', 'sign in to use Aurum') };
  }
  if (scope.phase === 'no_active_tenant') {
    return { ok: false, error: apiError(409, 'no_active_tenant', 'choose or create a company first') };
  }
  return { ok: true, scope };
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
  const resolved = await connectionsScopeFromRequest(request);
  if (!resolved.ok) return resolved.error;
  const context = resolved.scope.context;
  const view = await buildConnectionsView(context, viewOptionsFromRequest(request));
  return {
    status: 200,
    body: {
      surface: 'connections',
      tenantId: context.tenantId,
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
  const resolved = await connectionsScopeFromRequest(request);
  if (!resolved.ok) return resolved.error;
  const context = resolved.scope.context;
  const parsed = parseActionBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const outcome: ActionOutcome = await executeConnectionsAction(context, parsed.value);
    return {
      status: 200,
      body: {
        surface: 'connections',
        tenantId: context.tenantId,
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
