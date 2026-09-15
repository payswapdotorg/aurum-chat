// Cohere adapter (MODULE-INTERNAL — provider-native payloads never cross
// the llm module; lock 28 / IMPLEMENTATION-STACK §6).
//
// Dialect (v2-style chat; v3-style embeddings):
//   completion → POST /v2/chat
//     request  { model, messages: [{role, content}], temperature?, max_tokens }
//     response { id, text, usage: {input_tokens, output_tokens} }
//   embedding → POST /v2/embed (v3) / /v1/embed
//     request  { model, texts: [text], input_type: 'search_document' }
//     response { id, embeddings: {float: [[..]]}, meta: {billed_units: {input_tokens}} }

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
  const envelope = asObject(payload, 'the cohere completion response');
  const usage = asObject(envelope.usage, 'the cohere completion response .usage');
  return {
    text: boundedText(envelope.text, 'text', 'the cohere completion response', MAX_RESULT_TEXT),
    usage: {
      inputTokens: requiredTokenCount(usage, 'input_tokens', 'usage'),
      outputTokens: requiredTokenCount(usage, 'output_tokens', 'usage'),
    },
    providerExecutionId: boundedId(envelope.id, 'the cohere completion response .id'),
  };
}

function buildEmbedding(input: WireEmbeddingInput): unknown {
  return { model: input.model, texts: [input.input], input_type: 'search_document' };
}

function parseEmbedding(payload: unknown): WireEmbeddingResult {
  const envelope = asObject(payload, 'the cohere embedding response');
  const embeddings = asObject(envelope.embeddings, 'the cohere embedding response .embeddings');
  const floats = asArray(embeddings.float, 'embeddings.float');
  if (floats.length === 0) {
    throw malformedResponse('the cohere embedding response carries no vector');
  }
  const meta = asObject(envelope.meta, 'the cohere embedding response .meta');
  const billedUnits = asObject(meta.billed_units, 'meta.billed_units');
  return {
    vector: parseVector(floats[0], 'embeddings.float[0]', MAX_EMBEDDING_DIMENSIONS),
    usage: {
      inputTokens: requiredTokenCount(billedUnits, 'input_tokens', 'meta.billed_units'),
      outputTokens: 0,
    },
    providerExecutionId: boundedId(envelope.id, 'the cohere embedding response .id'),
  };
}

export const cohereAdapter: LlmAdapter = {
  provider: 'cohere',
  buildCompletionRequest: buildCompletion,
  parseCompletionResponse: parseCompletion,
  buildEmbeddingRequest: buildEmbedding,
  parseEmbeddingResponse: parseEmbedding,
};
