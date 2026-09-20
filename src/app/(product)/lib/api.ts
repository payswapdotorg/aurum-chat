// Product shell (W057/W058) — API request handling for /api/product/shell.
//
// Thin adapter (IMPLEMENTATION-STACK §5): resolve the authenticated scope
// from the SESSION COOKIE (W058 — the query/header seam is gone), build
// the chrome's composed state through module contracts only, return JSON.
// The shell chrome fetches this on mount and on demand (scope switches,
// opening the notification entry).
//
// The envelope now also carries the ACCOUNT section (the signed-in
// principal + the companies they have activated) so the switcher can
// offer real company switching through /api/auth/tenant/switch — no URL
// scope parameter anywhere.

import { listReachableTenants } from '@/modules/auth/contract';
import type { AuthPrincipal } from '@/modules/auth/contract';
import { resolveRequestScope } from '@/app/lib/request-session';
import { buildShellState } from './shell-state';
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

/** The account section: who is signed in and which companies they can work in. */
export interface AccountSection {
  principal: { email: string; displayName: string };
  /** Live-verified activated companies (the switcher's data). */
  tenants: { id: string; name: string; slug: string; role: string }[];
}

/** The JSON envelope the shell-state GET returns. */
export interface ShellApiEnvelope {
  shell: 'state';
  tenantId: string;
  generatedAt: string;
  view: ShellStateView;
  account: AccountSection;
}

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

function accountOf(
  principal: AuthPrincipal,
  tenants: Awaited<ReturnType<typeof listReachableTenants>>,
): AccountSection {
  return {
    principal: { email: principal.email, displayName: principal.displayName },
    tenants: tenants.map((tenant) => ({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      role: tenant.role,
    })),
  };
}

/** GET /api/product/shell — the chrome's composed state. */
export async function handleShellStateGet(request: Request): Promise<ApiResult> {
  const scope = await resolveRequestScope(request);
  if (scope.phase === 'unauthenticated') {
    return apiError(401, 'unauthenticated', 'sign in to use Aurum');
  }
  if (scope.phase === 'no_active_tenant') {
    return apiError(409, 'no_active_tenant', 'choose or create a company first');
  }
  try {
    const [view, tenants] = await Promise.all([
      buildShellState(scope.context, scope.workspace),
      listReachableTenants(scope.token),
    ]);
    return {
      status: 200,
      body: {
        shell: 'state',
        tenantId: scope.context.tenantId,
        generatedAt: view.generatedAt,
        view,
        account: accountOf(scope.principal, tenants),
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
  if (code === 'forbidden' || code === 'unauthorized') {
    return apiError(403, code, message);
  }
  if (code === 'not_pending' || code === 'conflict') {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}
