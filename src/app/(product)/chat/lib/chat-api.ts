// Aurum chat (W060) — the chat API surface (/api/product/chat/**).
//
// The same thin-adapter discipline the tower and the shell follow
// (IMPLEMENTATION-STACK §5): every handler resolves its EXPLICIT
// TenantContext from the session cookie (W058 — never from headers or
// query parameters), delegates to the chat surface's own composition
// (module contracts only — lock 31/32), and maps code-carrying errors to
// HTTP-ish outcomes. No handler logic lives in the route.ts files, so
// the whole surface is testable without booting Next.js.
//
//   GET  /api/product/chat/state?conversationId=<uuid>
//        — the composed chat state (conversation list + open timeline):
//          what the page hydrates from and the client polls for new
//          activity.
//   POST /api/product/chat/messages
//        — one chat turn: record the member's message, run the Aurum
//          workflow (a full cognition execution + the reply), return
//          both turns as renderer views.
//   POST /api/product/chat/approvals/<requestId>/decide
//        — the human decision on a pending action request, straight
//          through the actions contract (claim-gated, separation of
//          duties, first decision wins) so a manager never has to leave
//          the conversation (plan §2 Journey E).

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import { decideApproval } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { buildChatStateView } from './chat-view';
import { runChatTurn } from './workflow';
import { ChatWorkflowError } from './workflow';
import { toMessageView } from './chat-view';
import type { ChatMessageView } from './chat-types';

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

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

type SessionFailure =
  | { ok: false; status: 401 | 409; error: string; message: string }
  | { ok: true; context: TenantContext; displayName: string };

/** Resolve the session into the chat surface's scope (the only scope source). */
async function chatSession(request: Request): Promise<SessionFailure> {
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
  return {
    ok: true,
    context: resolution.context,
    displayName: resolution.principal.displayName,
  };
}

/** Map a module/workflow error to an API outcome (code-carrying errors only). */
export function chatApiError(error: unknown): ApiError {
  if (error instanceof ChatWorkflowError) {
    if (error.code === 'invalid_text') {
      return apiError(400, error.code, error.message);
    }
    return apiError(400, error.code, error.message);
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected chat failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized' || code === 'separation_of_duties') {
    return apiError(403, code, message);
  }
  if (code === 'not_pending' || code === 'conflict' || code === 'no_active_company') {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found') || code === 'invalid_reference') {
    return apiError(404, code, message);
  }
  return apiError(400, code, message);
}

/** GET /api/product/chat/state — the composed chat state. */
export async function handleChatStateGet(request: Request): Promise<ApiResult> {
  const session = await chatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversationId');
  try {
    const view = await buildChatStateView(
      session.context,
      conversationId === null || conversationId === '' ? null : conversationId,
    );
    return {
      status: 200,
      body: {
        chat: 'state',
        tenantId: session.context.tenantId,
        generatedAt: view.generatedAt,
        view,
      },
    };
  } catch (error) {
    return chatApiError(error);
  }
}

interface SendBody {
  conversationId?: unknown;
  text?: unknown;
  starterId?: unknown;
  clientMessageId?: unknown;
}

/** Parse the send body (unknown JSON → the workflow's narrow input). */
export function parseSendBody(
  body: unknown,
): { ok: true; value: { conversationId: string | null; text: string; starterId: string | null; clientMessageId: string | null } } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'the body must be a JSON object' };
  }
  const record = body as SendBody;
  if (typeof record.text !== 'string' || record.text.trim() === '') {
    return { ok: false, error: 'text is required (a non-empty string)' };
  }
  const conversationId =
    typeof record.conversationId === 'string' && record.conversationId.trim() !== ''
      ? record.conversationId.trim()
      : null;
  const starterId =
    typeof record.starterId === 'string' && record.starterId.trim() !== ''
      ? record.starterId.trim()
      : null;
  const clientMessageId =
    typeof record.clientMessageId === 'string' && record.clientMessageId.trim() !== ''
      ? record.clientMessageId.trim().slice(0, 100)
      : null;
  return { ok: true, value: { conversationId, text: record.text, starterId, clientMessageId } };
}

/** POST /api/product/chat/messages — one full chat turn. */
export async function handleChatSendPost(request: Request): Promise<ApiResult> {
  const session = await chatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'invalid_body', 'the body must be valid JSON');
  }
  const parsed = parseSendBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const result = await runChatTurn(session.context, { displayName: session.displayName }, {
      conversationId: parsed.value.conversationId,
      text: parsed.value.text,
      starterId: parsed.value.starterId,
      clientMessageId: parsed.value.clientMessageId,
    });
    const inbound: ChatMessageView = toMessageView(result.inbound);
    const reply: ChatMessageView = toMessageView(result.reply);
    return {
      status: 200,
      body: {
        chat: 'turn',
        tenantId: session.context.tenantId,
        conversationId: result.conversationId,
        executionId: result.executionId,
        inbound,
        reply,
      },
    };
  } catch (error) {
    return chatApiError(error);
  }
}

interface DecideBody {
  decision?: unknown;
  note?: unknown;
}

/** Parse the decision body ('approve' | 'reject' + optional note). */
export function parseDecideBody(
  body: unknown,
): { ok: true; value: { decision: 'approve' | 'reject'; note: string | null } } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'the body must be a JSON object' };
  }
  const record = body as DecideBody;
  if (record.decision !== 'approve' && record.decision !== 'reject') {
    return { ok: false, error: "decision must be 'approve' or 'reject'" };
  }
  const note =
    typeof record.note === 'string' && record.note.trim() !== ''
      ? record.note.trim().slice(0, 500)
      : null;
  return { ok: true, value: { decision: record.decision, note } };
}

/** POST /api/product/chat/approvals/<requestId>/decide — the human gate. */
export async function handleChatApprovalDecidePost(
  request: Request,
  requestId: string,
): Promise<ApiResult> {
  const session = await chatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (requestId.trim() === '') {
    return apiError(400, 'invalid_body', 'the request id must not be empty');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'invalid_body', 'the body must be valid JSON');
  }
  const parsed = parseDecideBody(body);
  if (!parsed.ok) {
    return apiError(400, 'invalid_body', parsed.error);
  }
  try {
    const decided: ActionRequest = await decideApproval(session.context, {
      requestId,
      decision: parsed.value.decision,
      note:
        parsed.value.note === null
          ? 'Decided in the Aurum chat'
          : `${parsed.value.note} (decided in the Aurum chat)`,
    });
    return {
      status: 200,
      body: {
        chat: 'approval-decision',
        tenantId: session.context.tenantId,
        requestId: decided.id,
        status: decided.status,
        decidedAt: decided.decidedAt,
      },
    };
  } catch (error) {
    return chatApiError(error);
  }
}
