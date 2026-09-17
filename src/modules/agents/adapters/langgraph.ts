// LangGraph runtime adapter (MODULE-INTERNAL — provider-native payloads
// never cross the agents module; lock 24 / IMPLEMENTATION-STACK §6).
//
// Dialect (LangGraph Server runs, wait mode):
//   task → POST /runs/wait
//     request  { assistant_id, input: { task, instructions, permissions }, metadata }
//     response { run_id, output: { result, summary? },
//                usage: { input_tokens, output_tokens, steps } }
//
// The graph's final state (`output.result`) is the agent's output — any
// JSON value; `steps` counts the graph steps executed (billable operations).

import type { AgentRuntimeProvider } from '../policy';
import { invalidRuntimeConfig, type AgentRuntimeAdapter, type WireTaskInput, type WireTaskResult, type WireUsage } from './types';
import { asObject, boundedId, boundedSummary, optionalCount, optionalString } from './shared';
import { agentRuntimeCostMinor, findAgentRuntime } from '../registry';

function resolveRuntimeAgentRef(runtimeConfig: unknown): string {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null || Array.isArray(runtimeConfig)) {
    throw invalidRuntimeConfig(
      'the langgraph runtime configuration must be an object carrying an assistantId',
    );
  }
  const config = runtimeConfig as { assistantId?: unknown };
  if (typeof config.assistantId !== 'string' || config.assistantId.trim() === '') {
    throw invalidRuntimeConfig(
      'the langgraph runtime configuration must carry a non-empty assistantId (the deployed graph assistant reference)',
    );
  }
  return config.assistantId.trim();
}

function buildTaskRequest(input: WireTaskInput): unknown {
  return {
    assistant_id: input.runtimeAgentRef,
    input: {
      task: input.task,
      instructions: input.instructions,
      permissions: input.requestedPermissions,
    },
    metadata: { submitted_by: 'aurum-agent-gateway' },
  };
}

function parseTaskResult(payload: unknown): WireTaskResult {
  const envelope = asObject(payload, 'the langgraph run response');
  const output = asObject(envelope.output, 'the langgraph run response .output');
  const usageHolder =
    envelope.usage === undefined || envelope.usage === null ? {} : asObject(envelope.usage, 'usage');
  const usage: WireUsage = {
    inputTokens: optionalCount(usageHolder, 'input_tokens', 'usage'),
    outputTokens: optionalCount(usageHolder, 'output_tokens', 'usage'),
    operations: optionalCount(usageHolder, 'steps', 'usage'),
  };
  return {
    output: output.result,
    summary: boundedSummary(output.summary, 'the langgraph run output .summary', 512),
    usage,
    providerTaskId: boundedId(
      optionalString(envelope, 'run_id') ?? envelope.run_id,
      'the langgraph run response .run_id',
    ),
  };
}

function costForUsage(usage: WireUsage): number {
  // W035: list prices live in the module registry (single source of truth).
  const runtime = findAgentRuntime('langgraph');
  if (runtime === null) {
    throw new Error("the registry carries no 'langgraph' runtime (internal invariant violation)");
  }
  return agentRuntimeCostMinor(runtime.pricing, usage);
}

export const langgraphAdapter: AgentRuntimeAdapter = {
  provider: 'langgraph' as AgentRuntimeProvider,
  resolveRuntimeAgentRef,
  buildTaskRequest,
  parseTaskResult,
  costForUsage,
};
