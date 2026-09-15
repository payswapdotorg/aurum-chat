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

import type { LlmProvider } from '../registry';
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

export const openaiAdapter: LlmAdapter = {
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
