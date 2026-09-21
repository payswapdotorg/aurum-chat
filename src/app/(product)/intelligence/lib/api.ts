// Intelligence discovery (W061) — the intelligence API surface
// (/api/product/intelligence/**).
//
// The thin-adapter discipline the shell, tower and chat all follow
// (IMPLEMENTATION-STACK §5): every handler resolves its EXPLICIT
// TenantContext from the session cookie (W058 — never from headers or
// query parameters), delegates to the intelligence surface's own
// composition, and maps code-carrying errors to HTTP-ish outcomes. No
// handler logic lives in the route.ts files, so the whole surface is
// testable without booting Next.js.
//
//   POST /api/product/intelligence/briefing/deliver
//        — deliver the tenant's current proactive findings into the chat
//          (the persistent intelligence conversation), idempotent per
//          findings digest. This is the write the Intelligence page's
//          "Deliver to chat" affordance posts.

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import { deliverFindingsToChat } from './briefing-chat';

export interface ApiOk {
  status: 200;
  body: Record<string, unknown>;
}

export type ApiErrorStatus = 400 | 401 | 403 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

type SessionFailure =
  | { ok: false; status: 401 | 409; error: string; message: string }
  | { ok: true; context: TenantContext };

/** Resolve the session into the intelligence surface's scope. */
async function intelligenceSession(request: Request): Promise<SessionFailure> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return {
      ok: false,
      status: 401,
      error: 'unauthenticated',
      message: 'no session for this request',
    };
  }
  if (resolution.status === 'no-company') {
    return {
      ok: false,
      status: 409,
      error: 'no_active_company',
      message: 'the session has no active company — complete onboarding first',
    };
  }
  return { ok: true, context: resolution.context };
}

/** POST /api/product/intelligence/briefing/deliver. */
export async function handleBriefingDeliverPost(request: Request): Promise<ApiResult> {
  const session = await intelligenceSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  try {
    const outcome = await deliverFindingsToChat(session.context);
    if (!outcome.ok) {
      return apiError(
        409,
        outcome.reason,
        'the intelligence conversation could not be opened right now — try again in a moment',
      );
    }
    return {
      status: 200,
      body: {
        intelligence: 'briefing-delivery',
        tenantId: session.context.tenantId,
        ...outcome,
      },
    };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
    const message =
      error instanceof Error ? error.message : 'unexpected delivery failure';
    if (code === 'forbidden' || code === 'unauthorized') {
      return apiError(403, code, message);
    }
    return apiError(500, 'internal', message);
  }
}
