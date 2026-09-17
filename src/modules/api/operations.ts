// The v1 operation handlers (W038 — Public API): one function per route in
// routes.ts, each a THIN delegation to the owning module's contract
// (lock 31 — the API exposes application capabilities, never raw
// persistence). Handlers only translate the HTTP-shaped request (params,
// query, JSON body) into contract inputs; every domain rule — validation,
// tenancy, authority, versioning, audit trails — stays inside the owning
// module, where it belongs.
//
// The api module's OWN capabilities (api keys, webhooks) delegate to
// service.ts the same way. Actor fields on write inputs default to the
// authenticated principal (`{ kind: 'person', id: principalId, label:
// 'api-key:<id>' }`) so an API-authored mission reads exactly as who it
// was; callers may still supply an explicit actor when acting on behalf of
// another party.

import type { TenantContext } from '@/infra/tenant';
import {
  getGoal,
  getGoalVersion,
  listGoals,
  listGoalVersions,
} from '@/modules/goals/contract';
import type {
  GoalPartyKind,
  GoalPriority,
  GoalStatus,
  ListGoalsQuery,
} from '@/modules/goals/contract';
import {
  abandonMission,
  completeMission,
  createMission,
  getMission,
  getMissionVersion,
  listMissions,
  listMissionVersions,
  reviseMission,
} from '@/modules/missions/contract';
import type {
  AbandonMissionInput,
  CompleteMissionInput,
  CreateMissionInput,
  MissionCandidateKind,
  MissionStatus,
  MissionUrgency,
  ReviseMissionInput,
} from '@/modules/missions/contract';
import { getBelief, getUnknown, listBeliefs, listUnknowns } from '@/modules/epistemics/contract';
import type { BeliefStatus, UnknownStatus } from '@/modules/epistemics/contract';
import {
  getKnowledgeEntry,
  getKnowledgeEntryEvidence,
  listKnowledgeEntries,
} from '@/modules/memory/contract';
import type { KnowledgeEntryKind } from '@/modules/memory/contract';
import {
  getObservation,
  getObservationLineage,
  listObservations,
} from '@/modules/observations/contract';
import type { ObservationSourceKind } from '@/modules/observations/contract';
import { analyzeGaps, getCapability, listCapabilities } from '@/modules/capabilities/contract';
import type { CapabilityRecordStatus, GapStatus } from '@/modules/capabilities/contract';
import {
  getAgent,
  getAgentExecution,
  listAgentExecutionAttempts,
  listAgentExecutions,
  listAgents,
} from '@/modules/agents/contract';
import type {
  AgentExecutionStatus,
  AgentRuntimeProvider,
  AgentStatus,
} from '@/modules/agents/contract';
import {
  authorizeAction,
  decideApproval,
  getActionRequest,
  listActionRequests,
  listApprovalDecisions,
} from '@/modules/actions/contract';
import type {
  ActionRequestStatus,
  ApprovalDecisionKind,
  AuthorizeActionInput,
  AuthorityLevel,
} from '@/modules/actions/contract';
import { ApiError } from './errors';
import {
  createApiKey,
  createWebhookSubscription,
  deactivateWebhookSubscription,
  dispatchWebhookDeliveries,
  fanoutEvent,
  getWebhookDelivery,
  getWebhookSubscription,
  listApiKeys,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  redeliverWebhookDelivery,
  revokeApiKey,
  sendWebhookTest,
} from './service';
import type { ApiKey, CreateApiKeyInput, CreateWebhookSubscriptionInput } from './types';

/** Everything a handler receives — already authenticated and scoped. */
export interface ApiOperationArgs {
  ctx: TenantContext;
  key: ApiKey;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
}

export type ApiOperationHandler = (args: ApiOperationArgs) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Query/body helpers (minimal translation; contracts remain the authority)
// ---------------------------------------------------------------------------

function queryValue(
  query: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function queryInt(
  query: Record<string, string | string[] | undefined>,
  name: string,
): number | undefined {
  const raw = queryValue(query, name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError('invalid_query', `query parameter '${name}' must be a positive integer`);
  }
  return value;
}

function queryList(
  query: Record<string, string | string[] | undefined>,
  name: string,
): string[] | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : value.split(',');
  const trimmed = items.map((item) => item.trim()).filter((item) => item !== '');
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireRecordBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('invalid_body', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** The default actor for API-authored writes: the authenticated principal. */
function principalActor(key: ApiKey): { kind: 'person'; id: string; label: string } {
  return { kind: 'person', id: key.principalId, label: `api-key:${key.id}` };
}

function withDefaultActor(input: Record<string, unknown>, key: ApiKey): Record<string, unknown> {
  if (input.actor === undefined || input.actor === null) {
    return { ...input, actor: principalActor(key) };
  }
  return input;
}

// ---------------------------------------------------------------------------
// The handler registry — one entry per route in routes.ts
// ---------------------------------------------------------------------------

export const OPERATIONS: Record<string, ApiOperationHandler> = {
  // -- discovery ------------------------------------------------------------
  discovery: async (): Promise<unknown> => {
    // Served by the kernel directly (unauthenticated surface); the entry
    // exists so the audit/registry never references a missing handler.
    return null;
  },

  // -- goals (W008) ----------------------------------------------------------
  'goals.list': ({ ctx, query }) =>
    listGoals(ctx, {
      status: queryValue(query, 'status') as GoalStatus | undefined,
      priority: queryValue(query, 'priority') as GoalPriority | undefined,
      ownerKind: queryValue(query, 'ownerKind') as GoalPartyKind | undefined,
      ownerId: queryValue(query, 'ownerId'),
      horizonEndFrom: queryValue(query, 'horizonEndFrom'),
      horizonEndTo: queryValue(query, 'horizonEndTo'),
      search: queryValue(query, 'search'),
      limit: queryInt(query, 'limit'),
    } satisfies ListGoalsQuery),
  'goals.get': ({ ctx, params }) => getGoal(ctx, params.goalId ?? ''),
  'goals.versions': ({ ctx, params }) => listGoalVersions(ctx, { goalId: params.goalId ?? '' }),
  'goals.version': ({ ctx, params }) => {
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError('invalid_query', 'version path segment must be a positive integer');
    }
    return getGoalVersion(ctx, { goalId: params.goalId ?? '', version });
  },

  // -- unknowns & beliefs (W007) ----------------------------------------------
  'unknowns.list': ({ ctx, query }) =>
    listUnknowns(ctx, {
      status: queryValue(query, 'status') as UnknownStatus | undefined,
      subjectKind: queryValue(query, 'subjectKind'),
      subjectId: queryValue(query, 'subjectId'),
      limit: queryInt(query, 'limit'),
    }),
  'unknowns.get': ({ ctx, params }) => getUnknown(ctx, { unknownId: params.unknownId ?? '' }),
  'beliefs.list': ({ ctx, query }) =>
    listBeliefs(ctx, {
      status: queryValue(query, 'status') as BeliefStatus | undefined,
      subjectKind: queryValue(query, 'subjectKind'),
      subjectId: queryValue(query, 'subjectId'),
      limit: queryInt(query, 'limit'),
    }),
  'beliefs.get': ({ ctx, params, query }) =>
    getBelief(ctx, { beliefId: params.beliefId ?? '', asOf: queryValue(query, 'asOf') }),

  // -- missions (W011): inspect + request investigations ----------------------
  'missions.list': ({ ctx, query }) =>
    listMissions(ctx, {
      status: queryValue(query, 'status') as MissionStatus | undefined,
      urgency: queryValue(query, 'urgency') as MissionUrgency | undefined,
      affectedGoalId: queryValue(query, 'affectedGoalId'),
      unknownId: queryValue(query, 'unknownId'),
      candidateKind: queryValue(query, 'candidateKind') as MissionCandidateKind | undefined,
      candidateId: queryValue(query, 'candidateId'),
      search: queryValue(query, 'search'),
      limit: queryInt(query, 'limit'),
    }),
  'missions.get': ({ ctx, params }) => getMission(ctx, params.missionId ?? ''),
  'missions.versions': ({ ctx, params }) =>
    listMissionVersions(ctx, { missionId: params.missionId ?? '' }),
  'missions.version': ({ ctx, params }) => {
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError('invalid_query', 'version path segment must be a positive integer');
    }
    return getMissionVersion(ctx, { missionId: params.missionId ?? '', version });
  },
  'missions.create': ({ ctx, key, body }) =>
    createMission(
      ctx,
      withDefaultActor(requireRecordBody(body), key) as unknown as CreateMissionInput,
    ),
  'missions.revise': ({ ctx, key, params, body }) =>
    reviseMission(
      ctx,
      withDefaultActor({ ...requireRecordBody(body), missionId: params.missionId ?? '' }, key) as unknown as ReviseMissionInput,
    ),
  'missions.complete': ({ ctx, key, params, body }) =>
    completeMission(
      ctx,
      withDefaultActor({ ...requireRecordBody(body), missionId: params.missionId ?? '' }, key) as unknown as CompleteMissionInput,
    ),
  'missions.abandon': ({ ctx, key, params, body }) =>
    abandonMission(
      ctx,
      withDefaultActor({ ...requireRecordBody(body), missionId: params.missionId ?? '' }, key) as unknown as AbandonMissionInput,
    ),

  // -- knowledge (W010) --------------------------------------------------------
  'knowledge.list': ({ ctx, query }) =>
    listKnowledgeEntries(ctx, {
      kind: queryValue(query, 'kind') as KnowledgeEntryKind | undefined,
      topics: queryList(query, 'topics'),
      entityKind: queryValue(query, 'entityKind'),
      entityId: queryValue(query, 'entityId'),
      evidenceObservationId: queryValue(query, 'evidenceObservationId'),
      text: queryValue(query, 'text'),
      recordedFrom: queryValue(query, 'recordedFrom'),
      recordedTo: queryValue(query, 'recordedTo'),
      limit: queryInt(query, 'limit'),
    }),
  'knowledge.get': ({ ctx, params }) => getKnowledgeEntry(ctx, params.entryId ?? ''),
  'knowledge.evidence': ({ ctx, params }) => getKnowledgeEntryEvidence(ctx, params.entryId ?? ''),

  // -- evidence (W004) ----------------------------------------------------------
  'observations.list': ({ ctx, query }) =>
    listObservations(ctx, {
      kind: queryValue(query, 'kind'),
      channel: queryValue(query, 'channel'),
      sourceKind: queryValue(query, 'sourceKind') as ObservationSourceKind | undefined,
      sourceId: queryValue(query, 'sourceId'),
      observedFrom: queryValue(query, 'observedFrom'),
      observedTo: queryValue(query, 'observedTo'),
      limit: queryInt(query, 'limit'),
    }),
  'observations.get': ({ ctx, params }) => getObservation(ctx, params.observationId ?? ''),
  'observations.lineage': ({ ctx, params }) =>
    getObservationLineage(ctx, params.observationId ?? ''),

  // -- capabilities (W017) -------------------------------------------------------
  'capabilities.list': ({ ctx, query }) =>
    listCapabilities(ctx, {
      name: queryValue(query, 'name'),
      search: queryValue(query, 'search'),
      status: queryValue(query, 'status') as CapabilityRecordStatus | undefined,
      limit: queryInt(query, 'limit'),
    }),
  'capabilities.gaps': ({ ctx, query }) =>
    analyzeGaps(ctx, {
      capabilityId: queryValue(query, 'capabilityId'),
      status: queryValue(query, 'status') as GapStatus | undefined,
      limit: queryInt(query, 'limit'),
    }),
  'capabilities.get': ({ ctx, params }) => getCapability(ctx, params.capabilityId ?? ''),

  // -- agents (W021) --------------------------------------------------------------
  'agents.list': ({ ctx, query }) =>
    listAgents(ctx, {
      provider: queryValue(query, 'provider') as AgentRuntimeProvider | undefined,
      status: queryValue(query, 'status') as AgentStatus | undefined,
      limit: queryInt(query, 'limit'),
    }),
  'agents.get': ({ ctx, params }) => getAgent(ctx, { agentId: params.agentId ?? '' }),
  'agents.executions': ({ ctx, params, query }) =>
    listAgentExecutions(ctx, {
      agentId: params.agentId,
      provider: queryValue(query, 'provider') as AgentRuntimeProvider | undefined,
      status: queryValue(query, 'status') as AgentExecutionStatus | undefined,
      correlationId: queryValue(query, 'correlationId'),
      limit: queryInt(query, 'limit'),
    }),
  'agents.execution': ({ ctx, params }) =>
    getAgentExecution(ctx, { executionId: params.executionId ?? '' }),
  'agents.attempts': ({ ctx, params }) =>
    listAgentExecutionAttempts(ctx, { executionId: params.executionId ?? '' }),

  // -- approvals (W009): propose through the authority matrix + decide -------------
  'approvals.list': ({ ctx, query }) =>
    listActionRequests(ctx, {
      actionKind: queryValue(query, 'actionKind'),
      authorityLevel: queryValue(query, 'authorityLevel') as AuthorityLevel | undefined,
      status: queryValue(query, 'status') as ActionRequestStatus | undefined,
      requestedBy: queryValue(query, 'requestedBy'),
      limit: queryInt(query, 'limit'),
    }),
  'approvals.create': ({ ctx, body }) =>
    authorizeAction(ctx, requireRecordBody(body) as unknown as AuthorizeActionInput),
  'approvals.get': ({ ctx, params }) => getActionRequest(ctx, { requestId: params.requestId ?? '' }),
  'approvals.decisions': ({ ctx, params }) =>
    listApprovalDecisions(ctx, { requestId: params.requestId ?? '' }),
  'approvals.decide': ({ ctx, params, body }) => {
    const input = requireRecordBody(body);
    return decideApproval(ctx, {
      requestId: params.requestId ?? '',
      decision: input.decision as ApprovalDecisionKind,
      note: (input.note === undefined ? null : input.note) as string | null,
    });
  },

  // -- api keys (this module) ------------------------------------------------------
  'apiKeys.create': ({ ctx, body }) =>
    createApiKey(ctx, requireRecordBody(body) as unknown as CreateApiKeyInput),
  'apiKeys.list': ({ ctx }) => listApiKeys(ctx),
  'apiKeys.revoke': ({ ctx, params }) => revokeApiKey(ctx, { keyId: params.keyId ?? '' }),

  // -- webhooks (this module) --------------------------------------------------------
  'webhooks.create': ({ ctx, body }) =>
    createWebhookSubscription(ctx, requireRecordBody(body) as unknown as CreateWebhookSubscriptionInput),
  'webhooks.list': ({ ctx }) => listWebhookSubscriptions(ctx),
  'webhooks.get': ({ ctx, params }) =>
    getWebhookSubscription(ctx, { subscriptionId: params.subscriptionId ?? '' }),
  'webhooks.deactivate': ({ ctx, params }) =>
    deactivateWebhookSubscription(ctx, { subscriptionId: params.subscriptionId ?? '' }),
  'webhooks.test': ({ ctx, params }) =>
    sendWebhookTest(ctx, { subscriptionId: params.subscriptionId ?? '' }),
  'webhooks.deliveries': ({ ctx, params, query }) =>
    listWebhookDeliveries(ctx, {
      subscriptionId: params.subscriptionId,
      status: queryValue(query, 'status'),
      limit: queryInt(query, 'limit'),
    }),
  'webhooks.delivery': ({ ctx, params }) =>
    getWebhookDelivery(ctx, { deliveryId: params.deliveryId ?? '' }),
  'webhooks.redeliver': ({ ctx, params }) =>
    redeliverWebhookDelivery(ctx, { deliveryId: params.deliveryId ?? '' }),
  'webhooks.dispatch': ({ ctx, body }) => {
    const input =
      body === undefined || body === null ? {} : requireRecordBody(body);
    return dispatchWebhookDeliveries(ctx, { limit: input.limit as number | undefined });
  },
  'webhooks.fanout': ({ ctx, body }) => {
    const input = requireRecordBody(body);
    return fanoutEvent(ctx, { eventId: input.eventId as string });
  },
};
