// Product shell (W057) — API request handling for /api/product/shell.
//
// The same thin-adapter discipline the tower follows (IMPLEMENTATION-STACK
// §5): resolve the explicit tenant context from headers/query, delegate to
// the shell-state view builder (module contracts only — lock 31/32), map
// errors to HTTP-ish outcomes. No handler logic lives in the route.ts
// itself, so the whole surface is testable without booting Next.js.

import { productContextFromRequest } from './context';
import type { ProductContextResolution } from './context';
import { buildShellState } from './shell-state';
import type { ShellStateView } from './shell-state';

export interface ApiOk {
  status: 200;
  body: ShellApiEnvelope;
}

export type ApiErrorStatus = 400 | 403 | 404 | 409 | 500;

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
  const resolution: ProductContextResolution = productContextFromRequest(request);
  if (!resolution.ok) {
    return apiError(400, resolution.failure, resolution.detail);
  }
  try {
    const view = await buildShellState(
      resolution.resolved.context,
      resolution.resolved.workspace,
    );
    return {
      status: 200,
      body: {
        shell: 'state',
        tenantId: resolution.resolved.context.tenantId,
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
  if (code === 'forbidden' || code === 'unauthorized') {
    return apiError(403, code, message);
  }
  if (code === 'not_pending' || code === 'conflict') {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}
