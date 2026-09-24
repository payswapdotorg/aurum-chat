// OpenAI adapter (MODULE-INTERNAL — provider-native payloads never cross
// the llm module; lock 28 / IMPLEMENTATION-STACK §6).
//
// Dialect:
//   completion → POST /v1/chat/completions
//     request  { model, messages: [{role, content}], temperature?, max_tokens }
//     response { id, choices: [{message: {content}}], usage: {prompt_tokens, completion_tokens} }
//   embedding → POST /v1/embeddings
//     request  { model, input }
//     response { data: [{embedding: [..]}], usage: {prompt_tokens} }
//
// W089 (Provider Adapter SDK): alongside its gateway-native LlmAdapter
// translation duties, this adapter is a conforming ProviderAdapterDefinition
// — the canonical lifecycle/error/capability contract shared by every
// gateway. The definition is PURE metadata + error normalization: it adds
// no execution method and no selection logic (routing stays in routing.ts).
// Behavior of the translation methods is UNCHANGED (the module's existing
// suites stay green unmodified).

import {
  createProviderAdapterDefinition,
  type CanonicalErrorCategory,
  type ProviderAdapterDefinition,
} from '@/modules/provider-sdk/contract';
import type { LlmProvider } from '../registry';
import { LlmError } from '../errors';
import {
  asArray,
  asObject,
  boundedId,
  boundedText,
  parseVector,
  requiredTokenCount,
} from './shared';
import {
  malformedResponse,
  type LlmAdapter,
  type WireCompletionInput,
  type WireCompletionResult,
  type WireEmbeddingInput,
  type WireEmbeddingResult,
} from './types';

const MAX_RESULT_TEXT = 262_144;
const MAX_EMBEDDING_DIMENSIONS = 4_096;

/**
 * Provider-specific error classification for the SDK's canonical taxonomy:
 * the LlmError codes this adapter can produce (or observe from the module's
 * execution path) map onto the gateway-neutral categories; anything else
 * falls through to the SDK's conservative heuristics.
 */
function classifyOpenAiError(error: unknown): CanonicalErrorCategory | null {
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'provider_malformed_response':
        return 'malformed_response';
      case 'unsupported_capability':
      case 'unsupported_provider':
        return 'unsupported_capability';
      case 'invalid_llm_input':
        return 'invalid_request';
      case 'provider_unavailable':
        return 'provider_unavailable';
      default:
        return null;
    }
  }
  return null;
}

function buildCompletion(input: WireCompletionInput): unknown {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_tokens: input.maxOutputTokens,
  };
  if (input.temperature !== null) body.temperature = input.temperature;
  return body;
}

function parseCompletion(payload: unknown): WireCompletionResult {
  const envelope = asObject(payload, 'the openai completion response');
  const choices = asArray(envelope.choices, 'the openai completion response .choices');
  if (choices.length === 0) {
    throw malformedResponse('the openai completion response carries no choice');
  }
  const choice = asObject(choices[0], 'choices[0]');
  const message = asObject(choice.message, 'choices[0].message');
  const usage = asObject(envelope.usage, 'the openai completion response .usage');
  return {
    text: boundedText(message.content, 'content', 'choices[0].message', MAX_RESULT_TEXT),
    usage: {
      inputTokens: requiredTokenCount(usage, 'prompt_tokens', 'usage'),
      outputTokens: requiredTokenCount(usage, 'completion_tokens', 'usage'),
    },
    providerExecutionId: boundedId(envelope.id, 'the openai completion response .id'),
  };
}

function buildEmbedding(input: WireEmbeddingInput): unknown {
  return { model: input.model, input: input.input };
}

function parseEmbedding(payload: unknown): WireEmbeddingResult {
  const envelope = asObject(payload, 'the openai embedding response');
  const data = asArray(envelope.data, 'the openai embedding response .data');
  if (data.length === 0) {
    throw malformedResponse('the openai embedding response carries no datum');
  }
  const datum = asObject(data[0], 'data[0]');
  const usage = asObject(envelope.usage, 'the openai embedding response .usage');
  return {
    vector: parseVector(datum.embedding, 'data[0].embedding', MAX_EMBEDDING_DIMENSIONS),
    usage: {
      inputTokens: requiredTokenCount(usage, 'prompt_tokens', 'usage'),
      outputTokens: 0,
    },
    providerExecutionId: boundedId(envelope.id, 'the openai embedding response .id'),
  };
}

/** The W089 SDK adapter definition (canonical lifecycle/error/capability surface). */
export const openaiDefinition: ProviderAdapterDefinition = createProviderAdapterDefinition({
  gateway: 'llm',
  provider: 'openai',
  capabilities: ['text-generation', 'embedding'],
  classifyError: classifyOpenAiError,
});

export const openaiAdapter: LlmAdapter & ProviderAdapterDefinition = {
  ...openaiDefinition,
  provider: 'openai',
  buildCompletionRequest: buildCompletion,
  parseCompletionResponse: parseCompletion,
  buildEmbeddingRequest: buildEmbedding,
  parseEmbeddingResponse: parseEmbedding,
};

/**
 * Factory for providers that speak the OpenAI-compatible dialect
 * (deepseek, groq): the same request/response shapes, a different provider
 * key. Swapping a provider implementation (or adding one) never touches a
 * domain contract — exactly the hot-swap property W034 must demonstrate.
 */
export function openaiCompatibleAdapter(provider: LlmProvider): LlmAdapter {
  return {
    provider,
    buildCompletionRequest: buildCompletion,
    parseCompletionResponse: parseCompletion,
    buildEmbeddingRequest: buildEmbedding,
    parseEmbeddingResponse: parseEmbedding,
  };
}
