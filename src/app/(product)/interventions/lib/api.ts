// Capability, workforce & agent interventions (W063) — the surface's
// API handlers (/api/product/interventions/**).
//
// The thin-adapter discipline every product surface follows
// (IMPLEMENTATION-STACK §5): resolve the EXPLICIT TenantContext from
// the session cookie (W058 — never from headers or query parameters),
// delegate to the surface's own workflow (lib/workflow.ts), and map
// code-carrying errors to HTTP-ish outcomes. No handler logic lives in
// the route.ts files, so the whole surface is testable without booting
// Next.js.
//
//   POST /api/product/interventions/proposals/<proposalId>/decide
//        — the human authority decision on an awaiting proposal.
//   POST /api/product/interventions/proposals/<proposalId>/activate
//        — activation of an approved recruit alternative (register the
//          agent with the proposed permission scopes).
//   POST /api/product/interventions/teams
//        — compose one draft team (topology, roster, objective, budget).
//   POST /api/product/interventions/teams/<teamId>/lifecycle
//        — drive one gated team transition (activate / dissolve); the
//          same call applies after the human decision.
//   POST /api/product/interventions/agents/<agentId>/lifecycle
//        — record one retain/modify/terminate decision following a
//          measured evaluation.
//   POST /api/product/interventions/decisions/<decisionId>/settle
//        — the idempotent pump that applies an approved termination.
//
// Every write rides the session's tenant; the authority claims (the
// actions module's approve claim, the agents module's administer claim)
// are the session's own derived claims — the domain gates stay the
// gates (§20).

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import type { AuthPrincipal } from '@/modules/auth/contract';
import {
  InterventionInputError,
  InterventionStateError,
  activateRecruitedAgent,
  composeTeam,
  decideAgentLifecycleFromForm,
  decideProposalGate,
  driveTeamLifecycle,
  settleAgentTermination,
  validateActivationInput,
  validateAgentDecisionInput,
  validateProposalDecisionInput,
  validateTeamComposeInput,
  validateTeamLifecycleInput,
} from './workflow';

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

/** Resolve the session into the interventions surface's scope. */
async function interventionsSession(request: Request): Promise<SessionFailure> {
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
export function interventionsApiError(error: unknown): ApiError {
  if (error instanceof InterventionInputError) {
    return apiError(400, error.code, error.message);
  }
  if (error instanceof InterventionStateError) {
    return apiError(409, error.code, error.message);
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected interventions-surface failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (
    code === 'forbidden' ||
    code === 'forbidden_by_policy' ||
    code === 'unauthorized' ||
    code === 'unauthenticated'
  ) {
    return apiError(403, code, message);
  }
  if (
    code === 'invalid_transition' ||
    code === 'team_conflict' ||
    code === 'not_pending' ||
    code === 'already_decided'
  ) {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a JSON object body (fields validated downstream). */
async function parseBody(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | ApiError> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return apiError(400, 'invalid_body', 'the request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return apiError(400, 'invalid_body', 'the request body must be a JSON object');
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/proposals/<proposalId>/decide
// ---------------------------------------------------------------------------

/** POST — decide an awaiting proposal at the human authority gate. */
export async function handleProposalDecidePost(
  request: Request,
  proposalId: string,
): Promise<ApiResult> {
  const session = await interventionsSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!UUID_PATTERN.test(proposalId)) {
    return apiError(404, 'proposal_not_found', 'no recruitment proposal exists at this address');
  }
  const parsed = await parseBody(request);
  if ('status' in parsed) return parsed;
  try {
    const input = validateProposalDecisionInput(parsed.body);
    const outcome = await decideProposalGate(session.context, proposalId, input);
    return {
      status: 200,
      body: {
        interventions: 'proposal-decision',
        tenantId: session.context.tenantId,
        ...outcome,
      },
    };
  } catch (error) {
    return interventionsApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/proposals/<proposalId>/activate
// ---------------------------------------------------------------------------

/** POST — activate an approved proposal's recruit alternative. */
export async function handleProposalActivatePost(
  request: Request,
  proposalId: string,
): Promise<ApiResult> {
  const session = await interventionsSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!UUID_PATTERN.test(proposalId)) {
    return apiError(404, 'proposal_not_found', 'no recruitment proposal exists at this address');
  }
  const parsed = await parseBody(request);
  if ('status' in parsed) return parsed;
  try {
    const input = validateActivationInput(parsed.body);
    const outcome = await activateRecruitedAgent(session.context, proposalId, input);
    return {
      status: 200,
      body: {
        interventions: 'agent-activation',
        tenantId: session.context.tenantId,
        proposalId: outcome.proposalId,
        agent: {
          id: outcome.agent.id,
          slug: outcome.agent.slug,
          status: outcome.agent.status,
          permissions: outcome.agent.permissions,
        },
        created: outcome.created,
      },
    };
  } catch (error) {
    return interventionsApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/teams
// ---------------------------------------------------------------------------

/** POST — compose one draft team. */
export async function handleTeamCreatePost(request: Request): Promise<ApiResult> {
  const session = await interventionsSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  const parsed = await parseBody(request);
  if ('status' in parsed) return parsed;
  try {
    const input = validateTeamComposeInput(parsed.body);
    const outcome = await composeTeam(session.context, input);
    return {
      status: 200,
      body: {
        interventions: 'team-compose',
        tenantId: session.context.tenantId,
        team: {
          id: outcome.team.id,
          slug: outcome.team.slug,
          status: outcome.team.status,
          version: outcome.team.version,
        },
        created: outcome.created,
      },
    };
  } catch (error) {
    return interventionsApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/teams/<teamId>/lifecycle
// ---------------------------------------------------------------------------

/** POST — drive one gated team transition. */
export async function handleTeamLifecyclePost(
  request: Request,
  teamId: string,
): Promise<ApiResult> {
  const session = await interventionsSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!UUID_PATTERN.test(teamId)) {
    return apiError(404, 'team_not_found', 'no agent team exists at this address');
  }
  const parsed = await parseBody(request);
  if ('status' in parsed) return parsed;
  try {
    const input = validateTeamLifecycleInput(parsed.body);
    const outcome = await driveTeamLifecycle(session.context, teamId, input);
    return {
      status: 200,
      body: {
        interventions: 'team-lifecycle',
        tenantId: session.context.tenantId,
        teamId: outcome.teamId,
        action: outcome.action,
        applied: outcome.applied,
        gate: outcome.gate,
        team: {
          id: outcome.team.id,
          slug: outcome.team.slug,
          status: outcome.team.status,
          version: outcome.team.version,
        },
      },
    };
  } catch (error) {
    return interventionsApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/agents/<agentId>/lifecycle
// ---------------------------------------------------------------------------

/** POST — record one retain/modify/terminate decision. */
export async function handleAgentLifecyclePost(
  request: Request,
  agentId: string,
): Promise<ApiResult> {
  const session = await interventionsSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!UUID_PATTERN.test(agentId)) {
    return apiError(404, 'agent_not_found', 'no agent exists at this address');
  }
  const parsed = await parseBody(request);
  if ('status' in parsed) return parsed;
  const evaluationId = parsed.body.evaluationId;
  if (typeof evaluationId !== 'string' || !UUID_PATTERN.test(evaluationId)) {
    return apiError(
      400,
      'invalid_intervention_input',
      'the measured evaluation this decision follows from must be a valid id',
    );
  }
  try {
    const input = validateAgentDecisionInput(parsed.body);
    const outcome = await decideAgentLifecycleFromForm(
      session.context,
      evaluationId,
      input,
    );
    return {
      status: 200,
      body: {
        interventions: 'agent-lifecycle',
        tenantId: session.context.tenantId,
        agentId,
        decision: {
          id: outcome.decision.id,
          change: outcome.decision.change,
          status: outcome.decision.status,
          appliedAt: outcome.decision.appliedAt,
        },
        applied: outcome.applied,
        gateRequestId: outcome.gateRequestId,
      },
    };
  } catch (error) {
    return interventionsApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/interventions/decisions/<decisionId>/settle
// ---------------------------------------------------------------------------

/** POST — settle (apply) an approved termination decision. */
export async function handleDecisionSettlePost(
  request: Request,
  decisionId: string,
): Promise<ApiResult> {
  const session = await interventionsSession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }
  if (!UUID_PATTERN.test(decisionId)) {
    return apiError(404, 'decision_not_found', 'no agent lifecycle decision exists at this address');
  }
  try {
    const decision = await settleAgentTermination(session.context, decisionId);
    return {
      status: 200,
      body: {
        interventions: 'termination-settle',
        tenantId: session.context.tenantId,
        decision: {
          id: decision.id,
          change: decision.change,
          status: decision.status,
          appliedAt: decision.appliedAt,
        },
      },
    };
  } catch (error) {
    return interventionsApiError(error);
  }
}
