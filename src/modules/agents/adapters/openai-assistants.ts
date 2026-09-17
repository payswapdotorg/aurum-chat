// OpenAI Assistants/Agents runtime adapter (MODULE-INTERNAL —
// provider-native payloads never cross the agents module; lock 24 /
// IMPLEMENTATION-STACK §6).
//
// Dialect (Assistants runs):
//   task → POST /v1/agents/{assistant_id}/runs (synchronous run)
//     request  { assistant_id, instructions, input: [{ role: 'user', content }] }
//     response { id: 'run_…', status: 'completed',
//                output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
//                usage: { input_tokens, output_tokens } }
//
// The agent's canonical task is carried as the user turn's content
// (JSON-serialized); the run's output_text is parsed back into JSON when
// it parses, and kept as a string otherwise — agents return either.

import type { AgentRuntimeProvider } from '../policy';
import { invalidRuntimeConfig, malformedResponse, type AgentRuntimeAdapter, type WireTaskInput, type WireTaskResult, type WireUsage } from './types';
import { asArray, asObject, boundedId, boundedSummary, optionalCount } from './shared';

const MAX_OUTPUT_CHARS = 262_144;
/** Interim list prices (USD): $2.50 / 1M input tokens, $10.00 / 1M output tokens. */
const INPUT_CENTS_PER_MILLION = 250;
const OUTPUT_CENTS_PER_MILLION = 1_000;

function resolveRuntimeAgentRef(runtimeConfig: unknown): string {
  if (typeof runtimeConfig !== 'object' || runtimeConfig === null || Array.isArray(runtimeConfig)) {
    throw invalidRuntimeConfig(
      'the openai-assistants runtime configuration must be an object carrying an assistantId',
    );
  }
  const config = runtimeConfig as { assistantId?: unknown };
  if (typeof config.assistantId !== 'string' || config.assistantId.trim() === '') {
    throw invalidRuntimeConfig(
      'the openai-assistants runtime configuration must carry a non-empty assistantId (the provider-side assistant reference)',
    );
  }
  return config.assistantId.trim();
}

function buildTaskRequest(input: WireTaskInput): unknown {
  return {
    assistant_id: input.runtimeAgentRef,
    instructions: input.instructions,
    input: [
      {
        role: 'user',
        content: JSON.stringify({ task: input.task, permissions: input.requestedPermissions }),
      },
    ],
  };
}

function parseTaskResult(payload: unknown): WireTaskResult {
  const envelope = asObject(payload, 'the openai-assistants run response');
  const output = asArray(envelope.output, 'the openai-assistants run response .output');
  if (output.length === 0) {
    throw malformedResponse('the openai-assistants run response carries no output item');
  }
  const last = asObject(output[output.length - 1], 'output[]');
  const content = asArray(last.content, 'output[].content');
  if (content.length === 0) {
    throw malformedResponse('the openai-assistants run output carries no content part');
  }
  const part = asObject(content[content.length - 1], 'output[].content[]');
  if (typeof part.text !== 'string') {
    throw malformedResponse('output[].content[].text must be a string');
  }
  if (part.text.length > MAX_OUTPUT_CHARS) {
    throw malformedResponse(
      `output[].content[].text must be at most ${MAX_OUTPUT_CHARS} characters (got ${part.text.length})`,
    );
  }
  let parsed: unknown = part.text;
  try {
    parsed = JSON.parse(part.text) as unknown;
  } catch {
    // Not JSON — the agent answered in prose; the text IS the output.
  }
  const usageHolder =
    envelope.usage === undefined || envelope.usage === null ? {} : asObject(envelope.usage, 'usage');
  const usage: WireUsage = {
    inputTokens: optionalCount(usageHolder, 'input_tokens', 'usage'),
    outputTokens: optionalCount(usageHolder, 'output_tokens', 'usage'),
    operations: null,
  };
  return {
    output: parsed,
    summary: boundedSummary(envelope.summary, 'the openai-assistants run response .summary', 512),
    usage,
    providerTaskId: boundedId(envelope.id, 'the openai-assistants run response .id'),
  };
}

function costForUsage(usage: WireUsage): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return Math.round(
    (input * INPUT_CENTS_PER_MILLION + output * OUTPUT_CENTS_PER_MILLION) / 1_000_000,
  );
}

export const openaiAssistantsAdapter: AgentRuntimeAdapter = {
  provider: 'openai-assistants' as AgentRuntimeProvider,
  resolveRuntimeAgentRef,
  buildTaskRequest,
  parseTaskResult,
  costForUsage,
};
