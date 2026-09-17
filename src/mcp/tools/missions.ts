// ============================================================================
// mcp/tools/missions — MCP tools over the missions contract (W039).
//
// ARCHITECTURE.md §23: MCP "may expose authorized operations such as ...
// inspecting goals, unknowns and missions, requesting investigation".
//
//   list_missions / get_mission — READ class (matrix evaluation
//   'mcp.read' @ OBSERVE): current mission views.
//
//   request_investigation — the consequential GATED tool: proposing a
//   learning mission routes through the W009 approval gate
//   (authorizeAction @ PROPOSE, action kind 'mcp.request-investigation')
//   BEFORE missions.createMission runs:
//     * matrix allows PROPOSE  → the mission is created (policy
//       auto-approval, recorded as such on the action request);
//     * matrix gates PROPOSE   → the mission is NOT created; the tool
//       returns the pending request id for a human decision
//       (decide_approval / the future control tower). Re-invoking the
//       same tool with the same idempotencyKey after the decision
//       replays the request and executes or refuses accordingly;
//     * matrix forbids PROPOSE → refused outright.
//   Mission actor provenance is the MCP principal itself (kind 'person',
//   the acting principal) — the proposal's audit trail names exactly who
//   asked through which surface.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  createMission,
  getMission,
  listMissions,
} from '@/modules/missions/contract';
import type {
  Mission,
  MissionStatus,
  MissionUrgency,
} from '@/modules/missions/contract';
import { MCP_WRITE_AUTHORITY_LEVEL } from '../policy';
import { McpToolError } from '../errors';
import type { ToolDefinition } from '../types';
import {
  optionalEnum,
  optionalListLimit,
  optionalString,
  optionalUnitInterval,
  optionalUuid,
  optionalIdempotencyKey,
  optionalTextOrNull,
  requireArgsObject,
  requireCurrency,
  requireEnum,
  requireNonNegativeInt,
  requireString,
  requireUnitInterval,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const MISSION_STATUS_VALUES = ['active', 'completed', 'abandoned'] as const;
const MISSION_URGENCY_VALUES = ['critical', 'high', 'medium', 'low'] as const;

/** The gated tool's action kind in the W009 authority matrix. */
export const REQUEST_INVESTIGATION_ACTION_KIND = 'mcp.request-investigation';

const LIST_MISSIONS_ARGS = [
  'status',
  'urgency',
  'affectedGoalId',
  'unknownId',
  'search',
  'limit',
] as const;

const GET_MISSION_ARGS = ['missionId'] as const;

const REQUEST_INVESTIGATION_ARGS = [
  'title',
  'knowledgeObjective',
  'informationValue',
  'urgency',
  'currentConfidence',
  'targetConfidence',
  'investigationBudgetAmount',
  'investigationBudgetCurrency',
  'rewardBudgetAmount',
  'rewardBudgetCurrency',
  'completionCriteria',
  'affectedGoalId',
  'unknownId',
  'justification',
  'idempotencyKey',
] as const;

function missionSummary(mission: Mission): { missionId: string; title: string; status: string } {
  return { missionId: mission.id, title: mission.content.title, status: mission.content.status };
}

export const missionsTools: ToolDefinition[] = [
  {
    name: 'list_missions',
    title: 'List learning missions',
    description:
      "List the tenant's learning missions: knowledge objectives, affected goals, urgency, " +
      'confidence gap, budgets and lifecycle, filtered by status, urgency, affected goal, unknown ' +
      "or free-text search. Read capability over the missions module (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...MISSION_STATUS_VALUES],
          description: 'Filter by lifecycle status.',
        },
        urgency: {
          type: 'string',
          enum: [...MISSION_URGENCY_VALUES],
          description: 'Filter by urgency.',
        },
        affectedGoalId: {
          type: 'string',
          format: 'uuid',
          description: 'Missions whose affected goals include this goals-module record.',
        },
        unknownId: {
          type: 'string',
          format: 'uuid',
          description: 'Missions closing this epistemics unknown.',
        },
        search: {
          type: 'string',
          description: 'Case-insensitive substring on title or knowledge objective.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50).' },
      },
    },
    annotations: { title: 'List learning missions', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_missions';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_MISSIONS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const status = optionalEnum<MissionStatus>(args, 'status', MISSION_STATUS_VALUES, tool);
      if (status !== undefined) query.status = status;
      const urgency = optionalEnum<MissionUrgency>(args, 'urgency', MISSION_URGENCY_VALUES, tool);
      if (urgency !== undefined) query.urgency = urgency;
      const affectedGoalId = optionalUuid(args, 'affectedGoalId', tool);
      if (affectedGoalId !== undefined) query.affectedGoalId = affectedGoalId;
      const unknownId = optionalUuid(args, 'unknownId', tool);
      if (unknownId !== undefined) query.unknownId = unknownId;
      const search = optionalString(args, 'search', tool, 256);
      if (search !== undefined) query.search = search;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const missions = await listMissions(ctx, args);
      return { data: missions, summary: { count: missions.length } };
    },
  },
  {
    name: 'get_mission',
    title: 'Inspect one learning mission',
    description:
      'Retrieve one learning mission by id: knowledge objective, affected goals, unknowns, ' +
      'information value, urgency, confidence gap, budgets, candidate sources, completion criteria ' +
      "and the audit summary of the current version. Read capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string', format: 'uuid', description: 'The mission id.' },
      },
      required: ['missionId'],
    },
    annotations: { title: 'Inspect one learning mission', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'get_mission';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, GET_MISSION_ARGS, tool);
      return { missionId: requireUuid(args, 'missionId', tool) };
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const mission = await getMission(ctx, args.missionId as string);
      return { data: mission, summary: missionSummary(mission) };
    },
  },
  {
    name: 'request_investigation',
    title: 'Propose a learning mission (approval-gated)',
    description:
      `Propose a new learning mission to close a knowledge gap. Consequential action: routed ` +
      `through the tenant authority matrix at level ${MCP_WRITE_AUTHORITY_LEVEL} (action kind ` +
      `'${REQUEST_INVESTIGATION_ACTION_KIND}'). When policy allows, the mission is created ` +
      `immediately. When approval is required, the mission is NOT created and the pending request ` +
      `id is returned — a human decides it (see the decide_approval tool); re-invoking this tool ` +
      `with the same idempotencyKey after the decision completes the flow. The acting principal is ` +
      `the mission's defining actor.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200, description: 'Short mission name.' },
        knowledgeObjective: {
          type: 'string',
          maxLength: 2000,
          description: 'The knowledge objective/question the mission must answer.',
        },
        informationValue: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Expected value of the information to the affected goals/decisions (0..1).',
        },
        urgency: {
          type: 'string',
          enum: [...MISSION_URGENCY_VALUES],
          description: 'How soon the knowledge is needed.',
        },
        currentConfidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'What is already known (default 0).',
        },
        targetConfidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence the mission must reach (must exceed currentConfidence).',
        },
        investigationBudgetAmount: {
          type: 'integer',
          minimum: 0,
          description: 'Investigation budget in integer minor units (0 = none).',
        },
        investigationBudgetCurrency: {
          type: 'string',
          description: 'ISO 4217 currency code of the investigation budget.',
        },
        rewardBudgetAmount: {
          type: 'integer',
          minimum: 0,
          description: 'Reward budget in integer minor units (default 0).',
        },
        rewardBudgetCurrency: {
          type: 'string',
          description: 'ISO 4217 currency code of the reward budget (defaults to the investigation currency).',
        },
        completionCriteria: {
          type: 'string',
          maxLength: 4000,
          description: 'When the mission is done.',
        },
        affectedGoalId: {
          type: 'string',
          format: 'uuid',
          description: 'Goal this mission serves (optional forward reference).',
        },
        unknownId: {
          type: 'string',
          format: 'uuid',
          description: 'Epistemics unknown this mission closes (validated at write time).',
        },
        justification: {
          type: 'string',
          maxLength: 2000,
          description: 'Why this investigation matters — recorded on the approval request.',
        },
        idempotencyKey: {
          type: 'string',
          maxLength: 200,
          description:
            'Dedupe key for the whole proposal→approval→execution flow; re-use it to complete ' +
            'the flow after an approval instead of proposing twice.',
        },
      },
      required: [
        'title',
        'knowledgeObjective',
        'informationValue',
        'urgency',
        'targetConfidence',
        'investigationBudgetAmount',
        'investigationBudgetCurrency',
        'completionCriteria',
      ],
    },
    annotations: {
      title: 'Propose a learning mission (approval-gated)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    policy: { kind: 'gate', actionKind: REQUEST_INVESTIGATION_ACTION_KIND },
    normalize: (raw) => {
      const tool = 'request_investigation';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, REQUEST_INVESTIGATION_ARGS, tool);

      const currentConfidence = optionalUnitInterval(args, 'currentConfidence', tool) ?? 0;
      const targetConfidence = requireUnitInterval(args, 'targetConfidence', tool);
      if (targetConfidence <= currentConfidence) {
        throw new McpToolError(
          'invalid_arguments',
          `'${tool}': targetConfidence (${targetConfidence}) must exceed currentConfidence ` +
            `(${currentConfidence}) — a mission must plan to close a confidence gap`,
        );
      }

      const investigationCurrency = requireCurrency(args, 'investigationBudgetCurrency', tool);
      const rewardBudgetAmount =
        args.rewardBudgetAmount === undefined
          ? 0
          : requireNonNegativeInt(args, 'rewardBudgetAmount', tool);
      const rewardBudgetCurrency =
        args.rewardBudgetCurrency === undefined
          ? investigationCurrency
          : requireCurrency(args, 'rewardBudgetCurrency', tool);

      return {
        title: requireString(args, 'title', tool, 200),
        knowledgeObjective: requireString(args, 'knowledgeObjective', tool, 2000),
        informationValue: requireUnitInterval(args, 'informationValue', tool),
        urgency: requireEnum<MissionUrgency>(args, 'urgency', MISSION_URGENCY_VALUES, tool),
        currentConfidence,
        targetConfidence,
        investigationBudget: {
          amount: requireNonNegativeInt(args, 'investigationBudgetAmount', tool),
          currency: investigationCurrency,
        },
        rewardBudget: {
          amount: rewardBudgetAmount,
          currency: rewardBudgetCurrency,
        },
        completionCriteria: requireString(args, 'completionCriteria', tool, 4000),
        affectedGoalId: optionalUuid(args, 'affectedGoalId', tool) ?? null,
        unknownId: optionalUuid(args, 'unknownId', tool) ?? null,
        justification: optionalTextOrNull(args, 'justification', tool, 2000),
        idempotencyKey: optionalIdempotencyKey(args, tool),
      };
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      // The acting principal is the defining actor (provenance — §6).
      const createInput: Parameters<typeof createMission>[1] = {
        title: args.title as string,
        knowledgeObjective: args.knowledgeObjective as string,
        informationValue: args.informationValue as number,
        urgency: args.urgency as MissionUrgency,
        currentConfidence: args.currentConfidence as number,
        targetConfidence: args.targetConfidence as number,
        investigationBudget: args.investigationBudget as { amount: number; currency: string },
        rewardBudget: args.rewardBudget as { amount: number; currency: string },
        completionCriteria: args.completionCriteria as string,
        actor: { kind: 'person', id: ctx.principalId },
      };
      const affectedGoalId = args.affectedGoalId as string | null;
      if (affectedGoalId !== null) {
        createInput.affectedGoals = [{ goalId: affectedGoalId }];
      }
      const unknownId = args.unknownId as string | null;
      if (unknownId !== null) {
        createInput.unknownIds = [unknownId];
      }

      const mission = await createMission(ctx, createInput);
      return { data: mission, summary: missionSummary(mission) };
    },
  },
];
