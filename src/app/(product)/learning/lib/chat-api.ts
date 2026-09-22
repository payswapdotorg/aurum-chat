// Chat-based learning requests (W073) — the chat-facing API handlers of
// the Learning surface (/api/product/learning/chat/**).
//
// The same thin-adapter discipline every product surface follows
// (IMPLEMENTATION-STACK §5): resolve the EXPLICIT TenantContext from the
// session cookie (W058 — never from headers or query parameters), delegate
// to the learning surface's chat glue (lib/chat-requests.ts — the SAME
// domain workflows the Learning page drives), and map code-carrying
// errors to HTTP-ish outcomes. No handler logic lives in the route.ts
// files, so the whole surface is testable without booting Next.js.
//
//   POST /api/product/learning/chat/deliver
//        — the proactive ask sweep: Aurum's open knowledge requests
//          enter the persistent learning conversation (idempotent per
//          plan), and answered asks get their acknowledgement turn
//          ensured. The chat workspace fires this once on mount — the
//          employee never needs the Learning route first.
//   POST /api/product/learning/chat/requests/<planId>/answer
//        — answer one knowledge request FROM THE THREAD: the same
//          domain workflow the Learning form drives (evidence capture +
//          contribution acknowledgement), then the member's turn and
//          Aurum's acknowledgement land in the same conversation.
//
// Both writes ride the session's tenant; the answering/delivering
// principal's display name is the audit-trail actor (lock 15).

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import type { AuthPrincipal } from '@/modules/auth/contract';
import { AnswerInputError } from './answer';
import { LearningStateError } from './answer';
import {
  answerKnowledgeRequestInChat,
  deliverKnowledgeRequestsToChat,
} from './chat-requests';
import { toMessageView } from '../../chat/lib/chat-view';
import type { ChatMessageView } from '../../chat/lib/chat-types';

export interface ApiOk {
  status: 200;
  body: Record<string, unknown>;
}

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

export interface ApiError {
  status: ApiErrorStatus;
  /** The error pair plus any honest context (e.g. the converged 409 body). */
  body: { error: string; message: string } & Record<string, unknown>;
}

export type ApiResult = ApiOk | ApiError;

function apiError(status: ApiErrorStatus, error: string, message: string): ApiError {
  return { status, body: { error, message } };
}

type SessionFailure =
  | { ok: false; status: 401 | 409; error: string; message: string }
  | { ok: true; context: TenantContext; principal: AuthPrincipal };

/** Resolve the session into the learning surface's chat scope. */
async function learningChatSession(request: Request): Promise<SessionFailure> {
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
export function learningChatApiError(error: unknown): ApiError {
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
    error instanceof Error ? error.message : 'unexpected learning-chat failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized' || code === 'unauthenticated') {
    return apiError(403, code, message);
  }
  if (code === 'outcome_conflict' || code === 'contribution_conflict' || code === 'mission_not_active') {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}

// ---------------------------------------------------------------------------
// POST /api/product/learning/chat/deliver
// ---------------------------------------------------------------------------

/** POST /api/product/learning/chat/deliver — the proactive ask sweep. */
export async function handleChatDeliverPost(request: Request): Promise<ApiResult> {
  const session = await learningChatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  try {
    const delivery = await deliverKnowledgeRequestsToChat(session.context);
    if (!delivery.ok) {
      return apiError(
        503,
        delivery.reason,
        'the learning reads were unavailable just now — nothing was delivered',
      );
    }
    return {
      status: 200,
      body: {
        learning: 'chat-deliver',
        tenantId: session.context.tenantId,
        delivered: delivery.delivered,
        conversationId: delivery.conversationId,
        openCount: delivery.openCount,
        asksRecorded: delivery.asksRecorded,
        asksDeduped: delivery.asksDeduped,
        acksRecorded: delivery.acksRecorded,
        askPlanIds: delivery.askPlanIds,
      },
    };
  } catch (error) {
    return learningChatApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/learning/chat/requests/<planId>/answer
// ---------------------------------------------------------------------------

/** The parsed chat-answer body (loosely-typed; validated downstream). */
export type ParsedChatAnswerBody =
  | { ok: true; conversationId: string | null; text: unknown; confidence: unknown }
  | { ok: false; error: 'invalid_body'; message: string };

/** Parse a chat-answer POST body (a JSON object; fields validated downstream). */
export function parseChatAnswerBody(body: unknown): ParsedChatAnswerBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body', message: 'the request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const conversationId =
    typeof record['conversationId'] === 'string' && record['conversationId'].trim() !== ''
      ? record['conversationId'].trim()
      : null;
  return {
    ok: true,
    conversationId,
    text: record['text'] ?? record['summary'] ?? null,
    confidence: record['confidence'] ?? 'medium',
  };
}

/** POST /api/product/learning/chat/requests/<planId>/answer — capture from the thread. */
export async function handleChatAnswerPost(request: Request, planId: string): Promise<ApiResult> {
  const session = await learningChatSession(request);
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
  const body = parseChatAnswerBody(parsedBody);
  if (!body.ok) {
    return apiError(400, body.error, body.message);
  }
  try {
    const outcome = await answerKnowledgeRequestInChat(
      session.context,
      {
        conversationId: body.conversationId,
        planId,
        // The summary is validated by the workflow (AnswerInputError → 400).
        summary: typeof body.text === 'string' ? body.text : '',
        confidence: body.confidence === 'high' || body.confidence === 'low' ? body.confidence : 'medium',
      },
      session.principal.displayName,
    );
    const acknowledgement: ChatMessageView = toMessageView(outcome.acknowledgement);
    if (outcome.status === 'answered') {
      const inbound: ChatMessageView = toMessageView(outcome.inbound);
      return {
        status: 200,
        body: {
          learning: 'chat-answer',
          tenantId: session.context.tenantId,
          status: 'answered',
          conversationId: outcome.conversationId,
          planId: outcome.planId,
          missionId: outcome.missionId,
          missionTitle: outcome.missionTitle,
          evidenceObservationId: outcome.evidenceObservationId,
          contribution: {
            id: outcome.contribution.id,
            status: outcome.contribution.status,
            summary: outcome.contribution.summary,
            missionId: outcome.contribution.missionId,
            evidenceObservationId: outcome.contribution.evidenceObservationId,
          },
          inbound,
          acknowledgement,
        },
      };
    }
    // The honest first-write-wins outcome: the answer was NOT recorded
    // (someone answered first — here or on the Learning surface), but the
    // thread was converged with the recorded state so the employee and
    // management see the truth from both surfaces.
    return {
      status: 409,
      body: {
        learning: 'chat-answer',
        tenantId: session.context.tenantId,
        status: 'already_answered',
        error: 'request_state',
        message:
          'this knowledge request was already answered — first write wins; the recorded state is attached',
        conversationId: outcome.conversationId,
        planId: outcome.planId,
        evidenceObservationId: outcome.evidenceObservationId,
        acknowledgement,
      },
    };
  } catch (error) {
    return learningChatApiError(error);
  }
}
