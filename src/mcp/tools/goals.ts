// ============================================================================
// mcp/tools/goals — MCP tools over the goals contract (W039).
//
// ARCHITECTURE.md §23: MCP "may expose authorized operations such as ...
// inspecting goals". Both tools are READ class (matrix evaluation
// 'mcp.read' @ OBSERVE) and call exactly one contract operation:
//   list_goals → listGoals (filtered current views)
//   get_goal   → getGoal  (one current view)
// Goal history/audit trails stay with the goals module (W046 owns the
// cross-cutting decision-evidence surface); MCP exposes current views.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  getGoal,
  listGoals,
} from '@/modules/goals/contract';
import type { Goal, GoalStatus, GoalPriority, GoalPartyKind } from '@/modules/goals/contract';
import type { ToolDefinition } from '../types';
import {
  optionalEnum,
  optionalListLimit,
  optionalString,
  optionalUuid,
  requireArgsObject,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const GOAL_STATUS_VALUES = ['active', 'archived'] as const;
const GOAL_PRIORITY_VALUES = ['critical', 'high', 'medium', 'low'] as const;
const GOAL_PARTY_KIND_VALUES = ['person', 'team', 'agent', 'system', 'external'] as const;

const LIST_GOALS_ARGS = [
  'status',
  'priority',
  'ownerKind',
  'ownerId',
  'horizonEndFrom',
  'horizonEndTo',
  'search',
  'limit',
] as const;

const GET_GOAL_ARGS = ['goalId'] as const;

function toSummary(goal: Goal): { goalId: string; title: string; status: string } {
  return { goalId: goal.id, title: goal.content.title, status: goal.content.status };
}

export const goalsTools: ToolDefinition[] = [
  {
    name: 'list_goals',
    title: 'List management goals',
    description:
      "List the tenant's current management goals (objective, metrics, horizon, owner, priority), " +
      'filtered by status, priority, owner and horizon window. Read capability over the goals module; ' +
      "evaluated against the tenant authority matrix (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...GOAL_STATUS_VALUES], description: 'Filter by goal status.' },
        priority: {
          type: 'string',
          enum: [...GOAL_PRIORITY_VALUES],
          description: 'Filter by priority.',
        },
        ownerKind: {
          type: 'string',
          enum: [...GOAL_PARTY_KIND_VALUES],
          description: 'Filter by owner kind (requires ownerId to be meaningful).',
        },
        ownerId: { type: 'string', format: 'uuid', description: 'Filter by owner id.' },
        horizonEndFrom: {
          type: 'string',
          description: 'Inclusive lower bound on horizon end (strict ISO 8601).',
        },
        horizonEndTo: {
          type: 'string',
          description: 'Inclusive upper bound on horizon end (strict ISO 8601).',
        },
        search: { type: 'string', description: 'Case-insensitive substring on the title.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50).' },
      },
    },
    annotations: { title: 'List management goals', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_goals';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_GOALS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const status = optionalEnum<GoalStatus>(args, 'status', GOAL_STATUS_VALUES, tool);
      if (status !== undefined) query.status = status;
      const priority = optionalEnum<GoalPriority>(args, 'priority', GOAL_PRIORITY_VALUES, tool);
      if (priority !== undefined) query.priority = priority;
      const ownerKind = optionalEnum<GoalPartyKind>(args, 'ownerKind', GOAL_PARTY_KIND_VALUES, tool);
      if (ownerKind !== undefined) query.ownerKind = ownerKind;
      const ownerId = optionalUuid(args, 'ownerId', tool);
      if (ownerId !== undefined) query.ownerId = ownerId;
      const horizonEndFrom = optionalString(args, 'horizonEndFrom', tool, 64);
      if (horizonEndFrom !== undefined) query.horizonEndFrom = horizonEndFrom;
      const horizonEndTo = optionalString(args, 'horizonEndTo', tool, 64);
      if (horizonEndTo !== undefined) query.horizonEndTo = horizonEndTo;
      const search = optionalString(args, 'search', tool, 256);
      if (search !== undefined) query.search = search;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const goals = await listGoals(ctx, args);
      return { data: goals, summary: { count: goals.length } };
    },
  },
  {
    name: 'get_goal',
    title: 'Inspect one management goal',
    description:
      'Retrieve one goal by id: the current version content (objective, desired state, metrics, ' +
      'thresholds, horizon, owner, priority, evidence sources, success criteria) plus the audit summary ' +
      "of the change that produced it. Read capability over the goals module (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string', format: 'uuid', description: 'The goal id.' },
      },
      required: ['goalId'],
    },
    annotations: { title: 'Inspect one management goal', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'get_goal';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, GET_GOAL_ARGS, tool);
      return { goalId: requireUuid(args, 'goalId', tool) };
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const goal = await getGoal(ctx, args.goalId as string);
      return { data: goal, summary: toSummary(goal) };
    },
  },
];
