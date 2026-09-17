// AutoGen runtime adapter (MODULE-INTERNAL — provider-native payloads
// never cross the agents module; lock 24 / IMPLEMENTATION-STACK §6).
//
// Dialect (AutoGen runtime run):
//   task → POST /teams/{team_id}/run
//     request  { team, task: { instructions, payload, permissions } }
//     response { id, summary, result, usage: { prompt_tokens, completion_tokens } }
//
// `result` is the team's final answer (any JSON value); `summary` is the
// runtime's own one-line digest of the conversation.

import type { AgentRuntimeProvider } from '../policy';
import { invalidRuntimeConfig, type AgentRuntimeAdapter, type WireTaskInput, type WireTaskResult, type WireUsage } from './types';
import { asObject, boundedId, boundedSummary, optionalCount } from './shared';
import { agentRuntimeCostMinor, findAgentRuntime } from '../registry';

function resolveRuntimeAgentRef(runtimeConfig: unknown): string {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null || Array.isArray(runtimeConfig)) {
    throw invalidRuntimeConfig(
      'the autogen runtime configuration must be an object carrying a teamId',
    );
  }
  const config = runtimeConfig as { teamId?: unknown };
  if (typeof config.teamId !== 'string' || config.teamId.trim() === '') {
    throw invalidRuntimeConfig(
      'the autogen runtime configuration must carry a non-empty teamId (the deployed team reference)',
    );
  }
  return config.teamId.trim();
}

function buildTaskRequest(input: WireTaskInput): unknown {
  return {
    team: input.runtimeAgentRef,
    task: {
      instructions: input.instructions,
      payload: input.task,
      permissions: input.requestedPermissions,
    },
  };
}

function parseTaskResult(payload: unknown): WireTaskResult {
  const envelope = asObject(payload, 'the autogen run response');
  const usageHolder =
    envelope.usage === undefined || envelope.usage === null ? {} : asObject(envelope.usage, 'usage');
  const usage: WireUsage = {
    inputTokens: optionalCount(usageHolder, 'prompt_tokens', 'usage'),
    outputTokens: optionalCount(usageHolder, 'completion_tokens', 'usage'),
    operations: null,
  };
  return {
    output: envelope.result,
    summary: boundedSummary(envelope.summary, 'the autogen run response .summary', 512),
    usage,
    providerTaskId: boundedId(envelope.id, 'the autogen run response .id'),
  };
}

function costForUsage(usage: WireUsage): number {
  // W035: list prices live in the module registry (single source of truth).
  const runtime = findAgentRuntime('autogen');
  if (runtime === null) {
    throw new Error("the registry carries no 'autogen' runtime (internal invariant violation)");
  }
  return agentRuntimeCostMinor(runtime.pricing, usage);
}

export const autogenAdapter: AgentRuntimeAdapter = {
  provider: 'autogen' as AgentRuntimeProvider,
  resolveRuntimeAgentRef,
  buildTaskRequest,
  parseTaskResult,
  costForUsage,
};
