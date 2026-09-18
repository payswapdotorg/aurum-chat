// ============================================================================
// mcp/tools/agents — MCP tools over the agents contract (W039).
//
// ARCHITECTURE.md §23: MCP "may expose authorized operations such as ...
// inspecting agents". Both tools are READ class (matrix evaluation
// 'mcp.read' @ OBSERVE) and call exactly one contract operation:
//   list_agents          → listAgents (the tenant's persistent agent
//                           definitions: role, provider, instructions,
//                           granted permission scopes, lifecycle)
//   list_agent_executions → listAgentExecutions (the trace surface:
//                           async, permission-scoped, policy-gated
//                           executions with their W009 snapshot)
//
// Agent RECRUITMENT (proposing new agents, W022) is not a delivered
// contract at this base; the generic propose_action tool covers
// "proposing agent recruitment" through the W009 authority matrix
// (action kind 'agent-recruitment', level PROPOSE) — the request waits
// in the approval gate for the owning human workflow either way.
// Execution submission stays internal (the agents module's own policy
// gate governs it); MCP never triggers agent dispatch directly.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  listAgentExecutions,
  listAgents,
} from '@/modules/agents/contract';
import type {
  AgentExecutionStatus,
  AgentRuntimeProvider,
  AgentStatus,
} from '@/modules/agents/contract';
import type { ToolDefinition } from '../types';
import {
  optionalEnum,
  optionalListLimit,
  optionalString,
  requireArgsObject,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const AGENT_STATUS_VALUES = ['active', 'disabled'] as const;
const AGENT_PROVIDER_VALUES = [
  'openai-assistants',
  'langgraph',
  'crewai',
  'autogen',
  'semantic-kernel',
] as const;
const AGENT_EXECUTION_STATUS_VALUES = [
  'awaiting_approval',
  'queued',
  'succeeded',
  'failed',
  'refused',
  'cancelled',
] as const;

const LIST_AGENTS_ARGS = ['provider', 'status', 'limit'] as const;
const LIST_AGENT_EXECUTIONS_ARGS = ['agentId', 'provider', 'status', 'correlationId', 'limit'] as const;

export const agentsTools: ToolDefinition[] = [
  {
    name: 'list_agents',
    title: 'List the agent workforce',
    description:
      "List the tenant's agent definitions: role, operating instructions, canonical runtime " +
      'provider, granted permission scopes and lifecycle status. Agent definitions are the ' +
      "persistent side of the agent gateway; providers stay behind it. Read capability " +
      "(action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: [...AGENT_PROVIDER_VALUES],
          description: 'Filter by canonical runtime provider.',
        },
        status: {
          type: 'string',
          enum: [...AGENT_STATUS_VALUES],
          description: 'Filter by lifecycle status.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50).' },
      },
    },
    annotations: { title: 'List the agent workforce', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_agents';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_AGENTS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const provider = optionalEnum<AgentRuntimeProvider>(
        args,
        'provider',
        AGENT_PROVIDER_VALUES,
        tool,
      );
      if (provider !== undefined) query.provider = provider;
      const status = optionalEnum<AgentStatus>(args, 'status', AGENT_STATUS_VALUES, tool);
      if (status !== undefined) query.status = status;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const agents = await listAgents(ctx, args);
      return { data: agents, summary: { count: agents.length } };
    },
  },
  {
    name: 'list_agent_executions',
    title: 'List agent executions (trace surface)',
    description:
      "List the tenant's agent executions: the async, permission-scoped, policy-gated units of " +
      'agent work with their frozen authority-matrix decision snapshot, provider task ids, cost ' +
      "and normalized outcome. Filter by agent, provider, status or correlation id. Read " +
      "capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', format: 'uuid', description: 'Filter by agent definition id.' },
        provider: {
          type: 'string',
          enum: [...AGENT_PROVIDER_VALUES],
          description: 'Filter by canonical runtime provider.',
        },
        status: {
          type: 'string',
          enum: [...AGENT_EXECUTION_STATUS_VALUES],
          description: 'Filter by execution lifecycle status.',
        },
        correlationId: {
          type: 'string',
          format: 'uuid',
          description: 'Every execution of one logical flow (§25 correlation identity).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50).' },
      },
    },
    annotations: {
      title: 'List agent executions (trace surface)',
      readOnlyHint: true,
      openWorldHint: false,
    },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_agent_executions';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_AGENT_EXECUTIONS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const agentIdRaw = optionalString(args, 'agentId', tool, 64);
      if (agentIdRaw !== undefined) {
        const agentId = requireUuid({ agentId: agentIdRaw }, 'agentId', tool);
        query.agentId = agentId;
      }
      const provider = optionalEnum<AgentRuntimeProvider>(
        args,
        'provider',
        AGENT_PROVIDER_VALUES,
        tool,
      );
      if (provider !== undefined) query.provider = provider;
      const status = optionalEnum<AgentExecutionStatus>(
        args,
        'status',
        AGENT_EXECUTION_STATUS_VALUES,
        tool,
      );
      if (status !== undefined) query.status = status;
      const correlationIdRaw = optionalString(args, 'correlationId', tool, 64);
      if (correlationIdRaw !== undefined) {
        query.correlationId = requireUuid({ correlationId: correlationIdRaw }, 'correlationId', tool);
      }
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const executions = await listAgentExecutions(ctx, args);
      return { data: executions, summary: { count: executions.length } };
    },
  },
];
