// Learning missions, contributions & rewards (W062) — the learning
// surface's API handlers (/api/product/learning/**).
//
// The thin-adapter discipline every product surface follows
// (IMPLEMENTATION-STACK §5): resolve the EXPLICIT TenantContext from the
// session cookie (W058 — never from headers or query parameters),
// delegate to the learning surface's own workflow (lib/answer.ts), and
// map code-carrying errors to HTTP-ish outcomes. No handler logic lives
// in the route.ts files, so the whole surface is testable without
// booting Next.js.
//
//   POST /api/product/learning/requests/<planId>/answer
//        — answer one open knowledge request: the answer becomes
//          acquisition evidence (an immutable observation) and the
//          contribution is recorded (the acknowledgement).
//   POST /api/product/learning/missions/<missionId>/ask
//        — request the NEXT knowledge acquisition for an active mission:
//          the W012 planner decides who/what to ask next and composes the
//          targeted question (policy-evaluated).
//
// Both writes ride the session's tenant; the answering/requesting
// principal's display name is the audit-trail actor (lock 15 — no
// verified person linkage exists for an auth principal).

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import type { AuthPrincipal } from '@/modules/auth/contract';
import {
  AnswerInputError,
  LearningStateError,
  answerKnowledgeRequest,
  requestNextKnowledge,
  validateAnswerInput,
} from './answer';

export interface ApiOk {
  status: 200;
  body: Record<string, unknown>;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

function apiError(status: ApiErrorStatus, error: string, message: string): ApiError {
  return { status, body: { error, message } };
}

type SessionFailure =
  | { ok: false; status: 401 | 409; error: string; message: string }
  | { ok: true; context: TenantContext; principal: AuthPrincipal };

/** Resolve the session into the learning surface's scope. */
async function learningSession(request: Request): Promise<SessionFailure> {
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
  return { ok: true, context: resolution.context, principal: resolution.principal };
}

/** Map a workflow/domain error to an API outcome (code-carrying errors). */
export function learningApiError(error: unknown): ApiError {
  if (error instanceof AnswerInputError) {
    return apiError(400, error.code, error.message);
  }
  if (error instanceof LearningStateError) {
    return apiError(409, error.code, error.message);
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected learning-surface failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized' || code === 'unauthenticated') {
    return apiError(403, code, message);
  }
  if (
    code === 'outcome_conflict' ||
    code === 'contribution_conflict' ||
    code === 'mission_not_active'
  ) {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}

// ---------------------------------------------------------------------------
// POST /api/product/learning/requests/<planId>/answer
// ---------------------------------------------------------------------------

/** The parsed answer body (unknown in, loosely-typed fields out — the
 *  workflow's validateAnswerInput does the real validation). */
export type ParsedAnswerBody =
  | { ok: true; summary: unknown; note: unknown; confidence: unknown }
  | { ok: false; error: 'invalid_body'; message: string };

/** Parse an answer POST body (a JSON object; fields validated downstream). */
export function parseAnswerBody(body: unknown): ParsedAnswerBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body', message: 'the request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  return {
    ok: true,
    summary: record.summary,
    note: record.note ?? null,
    confidence: record.confidence ?? 'medium',
  };
}

/** POST /api/product/learning/requests/<planId>/answer. */
export async function handleAnswerPost(
  request: Request,
  planId: string,
): Promise<ApiResult> {
  const session = await learningSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId)) {
    return apiError(404, 'plan_not_found', 'no knowledge request exists at this address');
  }
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return apiError(400, 'invalid_body', 'the request body must be valid JSON');
  }
  const body = parseAnswerBody(parsedBody);
  if (!body.ok) {
    return apiError(400, body.error, body.message);
  }
  try {
    const input = validateAnswerInput(body);
    const acknowledgement = await answerKnowledgeRequest(
      session.context,
      planId,
      input,
      session.principal.displayName,
    );
    return {
      status: 200,
      body: {
        learning: 'answer',
        tenantId: session.context.tenantId,
        planId: acknowledgement.planId,
        missionId: acknowledgement.missionId,
        missionTitle: acknowledgement.missionTitle,
        evidenceObservationId: acknowledgement.evidenceObservationId,
        contribution: {
          id: acknowledgement.contribution.id,
          status: acknowledgement.contribution.status,
          summary: acknowledgement.contribution.summary,
          missionId: acknowledgement.contribution.missionId,
          evidenceObservationId: acknowledgement.contribution.evidenceObservationId,
        },
      },
    };
  } catch (error) {
    return learningApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/learning/missions/<missionId>/ask
// ---------------------------------------------------------------------------

/** POST /api/product/learning/missions/<missionId>/ask. */
export async function handleAskPost(
  request: Request,
  missionId: string,
): Promise<ApiResult> {
  const session = await learningSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(missionId)) {
    return apiError(404, 'mission_not_found', 'no mission exists at this address');
  }
  try {
    const outcome = await requestNextKnowledge(
      session.context,
      missionId,
      session.principal.displayName,
    );
    return {
      status: 200,
      body: {
        learning: 'ask',
        tenantId: session.context.tenantId,
        ...outcome,
      },
    };
  } catch (error) {
    return learningApiError(error);
  }
}
