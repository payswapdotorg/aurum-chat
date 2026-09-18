// Management Control Tower (W033) — API request handling.
//
// The /api/tower route handlers are thin adapters in the IMPLEMENTATION-
// STACK §5 sense: resolve the tenant context, delegate to view builders
// (module contracts only — lock 31/32), map module errors to HTTP-ish
// outcomes. No handler logic lives in the route.ts files themselves, so
// the whole surface is testable without booting Next.js.

import { decideApproval } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import {
  towerContextFromHeaders,
  towerContextFromSearchParams,
} from './tower-context';
import type { TowerContextResolution } from './tower-context';
import { buildTowerView, isTowerSurface } from './surfaces';
import type { TowerSurface } from './surfaces';

export interface ApiOk {
  status: 200;
  body: TowerApiEnvelope;
}

export type ApiErrorStatus = 400 | 403 | 404 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

/** The JSON envelope every tower GET returns. */
export interface TowerApiEnvelope {
  surface: TowerSurface | 'approvals-decision';
  tenantId: string;
  generatedAt: string;
  view: unknown;
}

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

/**
 * Resolve the tower context for an API request: headers first, then
 * query parameters (so a browser fetch can also scope a tenant without
 * custom headers). Header failures win the error message when both fail.
 */
export function towerContextFromRequest(request: Request): TowerContextResolution {
  const fromHeaders = towerContextFromHeaders(request.headers);
  if (fromHeaders.ok) return fromHeaders;
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const key of ['tenant', 'principal', 'authority']) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = value;
  }
  const fromQuery = towerContextFromSearchParams(query);
  return fromQuery.ok ? fromQuery : fromHeaders;
}

/** GET /api/tower/<surface> — build one surface's view. */
export async function handleTowerSurfaceGet(
  request: Request,
  surface: string,
): Promise<ApiResult> {
  const context = towerContextFromRequest(request);
  if (!context.ok) {
    return apiError(400, context.failure, context.detail);
  }
  if (!isTowerSurface(surface)) {
    return apiError(
      404,
      'unknown_surface',
      `'${surface}' is not a tower surface`,
    );
  }
  const view = await buildTowerView(context.context, surface);
  return {
    status: 200,
    body: {
      surface,
      tenantId: context.context.tenantId,
      generatedAt: view.generatedAt,
      view,
    },
  };
}

/** The decision body of POST /api/tower/approvals/<id>/decide. */
export interface DecideApprovalBody {
  decision: 'approve' | 'reject';
  note?: string | null;
}

export type DecideBodyParse =
  | { ok: true; value: DecideApprovalBody }
  | { ok: false; error: string };

/** Validate the decide body (the actions contract validates the rest). */
export function parseDecideApprovalBody(body: unknown): DecideBodyParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  if (record['decision'] !== 'approve' && record['decision'] !== 'reject') {
    return { ok: false, error: "'decision' must be 'approve' or 'reject'" };
  }
  const note = record['note'];
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return { ok: false, error: "'note' must be a string or null" };
  }
  return {
    ok: true,
    value: { decision: record['decision'], note: (note as string | null | undefined) ?? null },
  };
}

/** POST /api/tower/approvals/<requestId>/decide — the human gate decision. */
export async function handleTowerApprovalDecision(
  request: Request,
  requestId: string,
  body: unknown,
): Promise<ApiResult> {
  const context = towerContextFromRequest(request);
  if (!context.ok) {
    return apiError(400, context.failure, context.detail);
  }
  const parsed = parseDecideApprovalBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const request_: ActionRequest = await decideApproval(context.context, {
      requestId,
      decision: parsed.value.decision,
      note: parsed.value.note,
    });
    return {
      status: 200,
      body: {
        surface: 'approvals-decision',
        tenantId: context.context.tenantId,
        generatedAt: request_.decidedAt ?? new Date().toISOString(),
        view: request_,
      },
    };
  } catch (error) {
    return towerApiError(error);
  }
}

/** Map a module error to an API outcome (code-carrying errors only). */
export function towerApiError(error: unknown): ApiError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected tower failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized') return apiError(403, code, message);
  if (code === 'not_pending' || code === 'conflict') return apiError(409, code, message);
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}
