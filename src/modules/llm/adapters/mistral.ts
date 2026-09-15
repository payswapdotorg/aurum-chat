// Mistral adapter (MODULE-INTERNAL — provider-native payloads never cross
// the llm module; lock 28 / IMPLEMENTATION-STACK §6).
//
// Dialect (chat completions / embeddings endpoints):
//   completion → POST /v1/chat/completions
//     request  { model, messages: [{role, content}], temperature?, max_tokens }
//     response { id, choices: [{message: {content}}], usage: {prompt_tokens, completion_tokens} }
//   embedding → POST /v1/embeddings
//     request  { model, input: [text] }
//     response { id, data: [{embedding: [..]}], usage: {prompt_tokens, total_tokens} }

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
  const envelope = asObject(payload, 'the mistral completion response');
  const choices = asArray(envelope.choices, 'the mistral completion response .choices');
  if (choices.length === 0) {
    throw malformedResponse('the mistral completion response carries no choice');
  }
  const choice = asObject(choices[0], 'choices[0]');
  const message = asObject(choice.message, 'choices[0].message');
  const usage = asObject(envelope.usage, 'the mistral completion response .usage');
  return {
    text: boundedText(message.content, 'content', 'choices[0].message', MAX_RESULT_TEXT),
    usage: {
      inputTokens: requiredTokenCount(usage, 'prompt_tokens', 'usage'),
      outputTokens: requiredTokenCount(usage, 'completion_tokens', 'usage'),
    },
    providerExecutionId: boundedId(envelope.id, 'the mistral completion response .id'),
  };
}

function buildEmbedding(input: WireEmbeddingInput): unknown {
  // Mistral's embeddings endpoint takes an ARRAY of inputs.
  return { model: input.model, input: [input.input] };
}

function parseEmbedding(payload: unknown): WireEmbeddingResult {
  const envelope = asObject(payload, 'the mistral embedding response');
  const data = asArray(envelope.data, 'the mistral embedding response .data');
  if (data.length === 0) {
    throw malformedResponse('the mistral embedding response carries no datum');
  }
  const datum = asObject(data[0], 'data[0]');
  const usage = asObject(envelope.usage, 'the mistral embedding response .usage');
  return {
    vector: parseVector(datum.embedding, 'data[0].embedding', MAX_EMBEDDING_DIMENSIONS),
    usage: {
      inputTokens: requiredTokenCount(usage, 'prompt_tokens', 'usage'),
      outputTokens: 0,
    },
    providerExecutionId: boundedId(envelope.id, 'the mistral embedding response .id'),
  };
}

export const mistralAdapter: LlmAdapter = {
  provider: 'mistral',
  buildCompletionRequest: buildCompletion,
  parseCompletionResponse: parseCompletion,
  buildEmbeddingRequest: buildEmbedding,
  parseEmbeddingResponse: parseEmbedding,
};
