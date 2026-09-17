// Semantic Kernel runtime adapter (MODULE-INTERNAL — provider-native
// payloads never cross the agents module; lock 24 / IMPLEMENTATION-STACK
// §6).
//
// Dialect (Semantic Kernel agent invocation):
//   task → POST /agents/{agentId}/invoke
//     request  { agentId, arguments: { instructions, task, permissions } }
//     response { runId, output, summary?, usage: { inputTokens, outputTokens, invocations } }
//
// `output` is the agent's final result (any JSON value); `invocations`
// counts the kernel function invocations consumed (billable operations).

import type { AgentRuntimeProvider } from '../policy';
import { invalidRuntimeConfig, type AgentRuntimeAdapter, type WireTaskInput, type WireTaskResult, type WireUsage } from './types';
import { asObject, boundedId, boundedSummary, optionalCount } from './shared';
import { agentRuntimeCostMinor, findAgentRuntime } from '../registry';

function resolveRuntimeAgentRef(runtimeConfig: unknown): string {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null || Array.isArray(runtimeConfig)) {
    throw invalidRuntimeConfig(
      'the semantic-kernel runtime configuration must be an object carrying an agentId',
    );
  }
  const config = runtimeConfig as { agentId?: unknown };
  if (typeof config.agentId !== 'string' || config.agentId.trim() === '') {
    throw invalidRuntimeConfig(
      'the semantic-kernel runtime configuration must carry a non-empty agentId (the registered kernel agent reference)',
    );
  }
  return config.agentId.trim();
}

function buildTaskRequest(input: WireTaskInput): unknown {
  return {
    agentId: input.runtimeAgentRef,
    arguments: {
      instructions: input.instructions,
      task: input.task,
      permissions: input.requestedPermissions,
    },
  };
}

function parseTaskResult(payload: unknown): WireTaskResult {
  const envelope = asObject(payload, 'the semantic-kernel invocation response');
  const usageHolder =
    envelope.usage === undefined || envelope.usage === null ? {} : asObject(envelope.usage, 'usage');
  const usage: WireUsage = {
    inputTokens: optionalCount(usageHolder, 'inputTokens', 'usage'),
    outputTokens: optionalCount(usageHolder, 'outputTokens', 'usage'),
    operations: optionalCount(usageHolder, 'invocations', 'usage'),
  };
  return {
    output: envelope.output,
    summary: boundedSummary(envelope.summary, 'the semantic-kernel invocation response .summary', 512),
    usage,
    providerTaskId: boundedId(envelope.runId, 'the semantic-kernel invocation response .runId'),
  };
}

function costForUsage(usage: WireUsage): number {
  // W035: list prices live in the module registry (single source of truth).
  const runtime = findAgentRuntime('semantic-kernel');
  if (runtime === null) {
    throw new Error("the registry carries no 'semantic-kernel' runtime (internal invariant violation)");
  }
  return agentRuntimeCostMinor(runtime.pricing, usage);
}

export const semanticKernelAdapter: AgentRuntimeAdapter = {
  provider: 'semantic-kernel' as AgentRuntimeProvider,
  resolveRuntimeAgentRef,
  buildTaskRequest,
  parseTaskResult,
  costForUsage,
};
