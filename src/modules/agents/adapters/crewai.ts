// CrewAI runtime adapter (MODULE-INTERNAL — provider-native payloads
// never cross the agents module; lock 24 / IMPLEMENTATION-STACK §6).
//
// Dialect (CrewAI execution service):
//   task → POST /crews/{crew_name}/execute
//     request  { crew, inputs: { task, instructions, permissions } }
//     response { run_id, status: 'completed', result, summary?,
//                token_usage: { input_tokens, output_tokens, requests } }
//
// `result` is the crew's final output (any JSON value); `requests` counts
// the LLM round-trips the crew consumed (billable operations).

import type { AgentRuntimeProvider } from '../policy';
import { invalidRuntimeConfig, type AgentRuntimeAdapter, type WireTaskInput, type WireTaskResult, type WireUsage } from './types';
import { asObject, boundedId, boundedSummary, optionalCount } from './shared';
import { agentRuntimeCostMinor, findAgentRuntime } from '../registry';

function resolveRuntimeAgentRef(runtimeConfig: unknown): string {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null || Array.isArray(runtimeConfig)) {
    throw invalidRuntimeConfig(
      'the crewai runtime configuration must be an object carrying a crewName',
    );
  }
  const config = runtimeConfig as { crewName?: unknown };
  if (typeof config.crewName !== 'string' || config.crewName.trim() === '') {
    throw invalidRuntimeConfig(
      'the crewai runtime configuration must carry a non-empty crewName (the deployed crew reference)',
    );
  }
  return config.crewName.trim();
}

function buildTaskRequest(input: WireTaskInput): unknown {
  return {
    crew: input.runtimeAgentRef,
    inputs: {
      task: input.task,
      instructions: input.instructions,
      permissions: input.requestedPermissions,
    },
  };
}

function parseTaskResult(payload: unknown): WireTaskResult {
  const envelope = asObject(payload, 'the crewai execution response');
  const usageHolder =
    envelope.token_usage === undefined || envelope.token_usage === null
      ? {}
      : asObject(envelope.token_usage, 'token_usage');
  const usage: WireUsage = {
    inputTokens: optionalCount(usageHolder, 'input_tokens', 'token_usage'),
    outputTokens: optionalCount(usageHolder, 'output_tokens', 'token_usage'),
    operations: optionalCount(usageHolder, 'requests', 'token_usage'),
  };
  return {
    output: envelope.result,
    summary: boundedSummary(envelope.summary, 'the crewai execution response .summary', 512),
    usage,
    providerTaskId: boundedId(envelope.run_id, 'the crewai execution response .run_id'),
  };
}

function costForUsage(usage: WireUsage): number {
  // W035: list prices live in the module registry (single source of truth).
  const runtime = findAgentRuntime('crewai');
  if (runtime === null) {
    throw new Error("the registry carries no 'crewai' runtime (internal invariant violation)");
  }
  return agentRuntimeCostMinor(runtime.pricing, usage);
}

export const crewaiAdapter: AgentRuntimeAdapter = {
  provider: 'crewai' as AgentRuntimeProvider,
  resolveRuntimeAgentRef,
  buildTaskRequest,
  parseTaskResult,
  costForUsage,
};
