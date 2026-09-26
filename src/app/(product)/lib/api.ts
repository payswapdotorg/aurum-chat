// Product shell API request handling for /api/product/shell (W057; W058
// re-sources the context).
//
// The same thin-adapter discipline the tower follows (IMPLEMENTATION-STACK
// §5): resolve the tenant context — now from the SESSION COOKIE through
// the auth contract (membership re-verified per request), never from
// headers or query parameters — delegate to the shell-state view builder
// (module contracts only — lock 31/32), map errors to HTTP-ish outcomes.
// No handler logic lives in the route.ts itself, so the whole surface is
// testable without booting Next.js.
//
// W101: an anonymous session (no cookie) is NOT an error — the racing
// chrome fetch of a session that just ended (sign-out navigation, fast
// sign-out click during hydration, session expiry mid-view) gets the
// anonymous view with 200, mirroring what the layout renders server-side
// for anonymous visitors. No tenant data is ever present in it.

import { resolveSessionRequest } from '@/app/lib/session';
import type { UserCompany } from '@/modules/auth/contract';
import { buildAnonymousShellView, buildShellState } from './shell-state';
import type { ShellStateView } from './shell-state';

export interface ApiOk {
  status: 200;
  body: ShellApiEnvelope;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

/** The JSON envelope the shell-state GET returns. */
export interface ShellApiEnvelope {
  shell: 'state';
  tenantId: string;
  generatedAt: string;
  view: ShellStateView;
}

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

/** GET /api/product/shell — the chrome's composed state. */
export async function handleShellStateGet(request: Request): Promise<ApiResult> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    // W101: the honest anonymous chrome — a racing post-sign-out or
    // expired-session fetch degrades to this view instead of a 401
    // console error (zero tenant data, same shape the layout renders
    // for anonymous visitors).
    const view = buildAnonymousShellView();
    return {
      status: 200,
      body: {
        shell: 'state',
        tenantId: '',
        generatedAt: view.generatedAt,
        view,
      },
    };
  }
  if (resolution.status === 'no-company') {
    return apiError(
      409,
      'no_active_company',
      'the session has no active company — complete onboarding first',
    );
  }
  try {
    const view = await buildShellState(
      resolution.context,
      resolution.workspaceId,
      { principal: resolution.principal, companies: resolution.companies, role: resolution.role },
    );
    return {
      status: 200,
      body: {
        shell: 'state',
        tenantId: resolution.context.tenantId,
        generatedAt: view.generatedAt,
        view,
      },
    };
  } catch (error) {
    return shellApiError(error);
  }
}

/** Map a module error to an API outcome (code-carrying errors only). */
export function shellApiError(error: unknown): ApiError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected shell failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized' || code === 'unauthenticated') {
    return apiError(403, code, message);
  }
  if (code === 'not_pending' || code === 'conflict' || code === 'no_active_company') {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}

/** Re-exported for the chrome's view typing (the switcher's data). */
export type { UserCompany };
