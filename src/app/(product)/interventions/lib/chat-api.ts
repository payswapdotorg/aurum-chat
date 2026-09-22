// Conversational interventions & approval continuity (W074) — the
// chat-facing API handlers of the Interventions surface
// (/api/product/interventions/chat/**).
//
// The same thin-adapter discipline every product surface follows
// (IMPLEMENTATION-STACK §5): resolve the EXPLICIT TenantContext from the
// session cookie (W058 — never from headers or query parameters), delegate
// to the interventions surface's chat glue (lib/chat-interventions.ts —
// the SAME domain workflows the Interventions page drives), and map
// code-carrying errors to HTTP-ish outcomes. No handler logic lives in
// the route.ts files, so the whole surface is testable without booting
// Next.js.
//
//   POST /api/product/interventions/chat/deliver
//        — the proactive recommendation sweep: Aurum's awaiting
//          capability-gap proposals enter the persistent interventions
//          conversation (idempotent per proposal) as recommendation
//          messages, and decided recommendations converge with their
//          outcome message. The chat workspace fires this once on mount —
//          the manager never needs the Interventions route first.
//   POST /api/product/interventions/chat/proposals/<proposalId>/decide
//        — the INLINE HUMAN DECISION from the thread: the same authority
//          gate the Interventions decision form drives (decideApproval —
//          claim-gated, separation of duties) plus the settle onto the
//          proposal, then the OUTCOME message returns to the originating
//          thread (the one the card lives in).
//   POST /api/product/interventions/chat/proposals/<proposalId>/activate
//        — the ACTIVATION from the thread: registers the agent with
//          EXACTLY the scopes the approved comparison proposed (the same
//          activation the Interventions form drives), then the activation
//          outcome (the agent card + its lifecycle context) returns to
//          the originating thread.
//
// Every write rides the session's tenant; the deciding/activating
// principal's display name is the outcome copy's actor (lock 15 — the
// transcript never fabricates person attribution).

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import type { AuthPrincipal } from '@/modules/auth/contract';
import { ActionsError } from '@/modules/actions/contract';
import { AgentRecruitmentError } from '@/modules/agent-recruitment/contract';
import {
  activateProposalInChat,
  decideProposalInChat,
  deliverInterventionRecommendationsToChat,
} from './chat-interventions';
import type {
  ChatProposalActivationInput,
  ChatProposalDecisionInput,
} from './chat-interventions';
import { InterventionInputError, InterventionStateError } from './workflow';
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

/** Resolve the session into the interventions surface's chat scope. */
async function interventionsChatSession(request: Request): Promise<SessionFailure> {
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
export function interventionsChatApiError(error: unknown): ApiError {
  if (error instanceof InterventionInputError) {
    return apiError(400, error.code, error.message);
  }
  if (error instanceof InterventionStateError) {
    return apiError(409, error.code, error.message);
  }
  if (error instanceof ActionsError) {
    // The authority gate's own honest refusals: the approve claim and
    // separation of duties (surfaced as 'forbidden' by the actions
    // module — the requesting principal can never decide its own
    // request) are enforced THERE, never re-implemented here.
    if (error.code === 'forbidden') {
      return apiError(403, error.code, error.message);
    }
    if (error.code === 'not_pending') {
      return apiError(409, error.code, error.message);
    }
    return apiError(400, error.code, error.message);
  }
  if (error instanceof AgentRecruitmentError) {
    if (error.code.endsWith('_not_found')) return apiError(404, error.code, error.message);
    if (error.code === 'forbidden') return apiError(403, error.code, error.message);
    return apiError(409, error.code, error.message);
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected interventions-chat failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized' || code === 'unauthenticated') {
    return apiError(403, code, message);
  }
  if (code === 'not_pending' || code === 'conflict' || code === 'no_active_company') {
    return apiError(409, code, message);
  }
  if (
    code.endsWith('_not_found') ||
    code === 'invalid_reference' ||
    code === 'conversation_not_found'
  ) {
    return apiError(404, code, message);
  }
  return apiError(400, code, message);
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/chat/deliver
// ---------------------------------------------------------------------------

/** POST /api/product/interventions/chat/deliver — the proactive sweep. */
export async function handleInterventionsChatDeliverPost(request: Request): Promise<ApiResult> {
  const session = await interventionsChatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  try {
    const delivery = await deliverInterventionRecommendationsToChat(session.context);
    if (!delivery.ok) {
      return apiError(
        503,
        delivery.reason,
        'the interventions reads were unavailable just now — nothing was delivered',
      );
    }
    return {
      status: 200,
      body: {
        interventions: 'chat-deliver',
        tenantId: session.context.tenantId,
        delivered: delivery.delivered,
        conversationId: delivery.conversationId,
        awaitingCount: delivery.awaitingCount,
        recommendationsRecorded: delivery.recommendationsRecorded,
        outcomesRecorded: delivery.outcomesRecorded,
        recommendationsDeduped: delivery.recommendationsDeduped,
        recommendationProposalIds: delivery.recommendationProposalIds,
      },
    };
  } catch (error) {
    return interventionsChatApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/chat/proposals/<proposalId>/decide
// ---------------------------------------------------------------------------

/** The parsed inline-decision body. */
export type ParsedChatProposalDecisionBody =
  | { ok: true; value: ChatProposalDecisionInput }
  | { ok: false; error: 'invalid_body'; message: string };

/** Parse an inline decision POST body ('approve' | 'reject' + optional note). */
export function parseChatProposalDecisionBody(
  body: unknown,
): ParsedChatProposalDecisionBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: 'invalid_body',
      message: 'the request body must be a JSON object',
    };
  }
  const record = body as Record<string, unknown>;
  if (record['decision'] !== 'approve' && record['decision'] !== 'reject') {
    return {
      ok: false,
      error: 'invalid_body',
      message: "decision must be 'approve' or 'reject'",
    };
  }
  const conversationId =
    typeof record['conversationId'] === 'string' && record['conversationId'].trim() !== ''
      ? record['conversationId'].trim()
      : null;
  const note =
    typeof record['note'] === 'string' && record['note'].trim() !== ''
      ? record['note'].trim().slice(0, 500)
      : null;
  return {
    ok: true,
    value: { conversationId, decision: record['decision'], note },
  };
}

/**
 * POST /api/product/interventions/chat/proposals/<proposalId>/decide —
 * the INLINE HUMAN DECISION from the thread. The human vote goes
 * through the authority gate (claim-gated, separation of duties), the
 * settle lands on the proposal, and the OUTCOME message returns to the
 * originating thread — the same governance truth the Interventions
 * surface renders.
 */
export async function handleInterventionsChatProposalDecidePost(
  request: Request,
  proposalId: string,
): Promise<ApiResult> {
  const session = await interventionsChatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposalId)
  ) {
    return apiError(404, 'proposal_not_found', 'no intervention proposal exists at this address');
  }
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return apiError(400, 'invalid_body', 'the request body must be valid JSON');
  }
  const body = parseChatProposalDecisionBody(parsedBody);
  if (!body.ok) {
    return apiError(400, body.error, body.message);
  }
  try {
    const outcome = await decideProposalInChat(
      session.context,
      proposalId,
      body.value,
      session.principal.displayName,
    );
    const reply: ChatMessageView = toMessageView(outcome.outcome);
    return {
      status: 200,
      body: {
        interventions: 'chat-decide',
        tenantId: session.context.tenantId,
        status: outcome.status,
        proposalId: outcome.proposalId,
        decidedHere: outcome.decidedHere,
        conversationId: outcome.conversationId,
        actionRequestId: outcome.actionRequestId,
        decidedBy: outcome.decidedBy,
        decidedAt: outcome.decidedAt,
        outcome: reply,
      },
    };
  } catch (error) {
    return interventionsChatApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/chat/proposals/<proposalId>/activate
// ---------------------------------------------------------------------------

/** The parsed inline-activation body (all fields optional overrides). */
export type ParsedChatProposalActivationBody =
  | { ok: true; value: ChatProposalActivationInput }
  | { ok: false; error: 'invalid_body'; message: string };

/** Parse an inline activation POST body (a JSON object of optional fields). */
export function parseChatProposalActivationBody(
  body: unknown,
): ParsedChatProposalActivationBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: 'invalid_body',
      message: 'the request body must be a JSON object',
    };
  }
  const record = body as Record<string, unknown>;
  const optional = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };
  const permissionsRaw = record['permissions'];
  const permissions =
    Array.isArray(permissionsRaw) &&
    permissionsRaw.every((entry) => typeof entry === 'string')
      ? (permissionsRaw as string[])
      : null;
  return {
    ok: true,
    value: {
      conversationId: optional('conversationId'),
      slug: optional('slug'),
      displayName: optional('displayName'),
      role: optional('role'),
      instructions: optional('instructions'),
      provider: optional('provider'),
      permissions,
    },
  };
}

/**
 * POST /api/product/interventions/chat/proposals/<proposalId>/activate —
 * the ACTIVATION from the thread: registers the agent with exactly the
 * scopes the approved comparison proposed (the same activation the
 * Interventions surface drives — 'agents:administer' claim-gated), then
 * the activation outcome (the agent card with its lifecycle context)
 * returns to the originating thread.
 */
export async function handleInterventionsChatProposalActivatePost(
  request: Request,
  proposalId: string,
): Promise<ApiResult> {
  const session = await interventionsChatSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposalId)
  ) {
    return apiError(404, 'proposal_not_found', 'no intervention proposal exists at this address');
  }
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return apiError(400, 'invalid_body', 'the request body must be valid JSON');
  }
  const body = parseChatProposalActivationBody(parsedBody);
  if (!body.ok) {
    return apiError(400, body.error, body.message);
  }
  try {
    const outcome = await activateProposalInChat(
      session.context,
      proposalId,
      body.value,
      session.principal.displayName,
    );
    const reply: ChatMessageView = toMessageView(outcome.outcome);
    return {
      status: 200,
      body: {
        interventions: 'chat-activate',
        tenantId: session.context.tenantId,
        proposalId: outcome.proposalId,
        created: outcome.created,
        conversationId: outcome.conversationId,
        agent: {
          id: outcome.agent.id,
          slug: outcome.agent.slug,
          displayName: outcome.agent.displayName,
          status: outcome.agent.status,
          permissions: outcome.agent.permissions,
        },
        outcome: reply,
      },
    };
  } catch (error) {
    return interventionsChatApiError(error);
  }
}
