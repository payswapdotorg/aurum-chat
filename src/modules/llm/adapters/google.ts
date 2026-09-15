// Google adapter (MODULE-INTERNAL — provider-native payloads never cross
// the llm module; lock 28 / IMPLEMENTATION-STACK §6).
//
// Dialect:
//   completion → generateContent
//     request  { model (in URL semantics; carried here as a field), contents:
//                [{role: 'user'|'model', parts: [{text}]}],
//                systemInstruction?: {parts: [{text}]},
//                generationConfig: {temperature?, maxOutputTokens} }
//     response { candidates: [{content: {parts: [{text}]}}],
//                usageMetadata: {promptTokenCount, candidatesTokenCount} }
//   embedding → embedContent
//     request  { model, content: {parts: [{text}]} }
//     response { embedding: {values: [..]}, usageMetadata: {tokenCount} }

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

function buildCompletion(input: WireCompletionInput): unknown {
  // Google maps canonical roles: system → systemInstruction, assistant →
  // 'model', user stays 'user'.
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const message of input.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }
  if (contents.length === 0) {
    throw new LlmError(
      'invalid_llm_input',
      'google requests require at least one user or assistant message (system-only requests cannot be mapped)',
    );
  }
  const body: Record<string, unknown> = {
    model: input.model,
    contents,
    generationConfig: { maxOutputTokens: input.maxOutputTokens },
  };
  if (systemParts.length > 0) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  if (input.temperature !== null) {
    (body.generationConfig as Record<string, unknown>).temperature = input.temperature;
  }
  return body;
}

function parseCompletion(payload: unknown): WireCompletionResult {
  const envelope = asObject(payload, 'the google completion response');
  const candidates = asArray(envelope.candidates, 'the google completion response .candidates');
  if (candidates.length === 0) {
    throw malformedResponse('the google completion response carries no candidate');
  }
  const candidate = asObject(candidates[0], 'candidates[0]');
  const content = asObject(candidate.content, 'candidates[0].content');
  const parts = asArray(content.parts, 'candidates[0].content.parts');
  const text = parts
    .map((entry, index) => {
      const part = asObject(entry, `candidates[0].content.parts[${index}]`);
      if (typeof part.text !== 'string') return null;
      return boundedText(part.text, 'text', `parts[${index}]`, MAX_RESULT_TEXT);
    })
    .filter((part): part is string => part !== null)
    .join('');
  if (text === '') {
    throw malformedResponse('the google completion response carries no text part');
  }
  const usageMetadata = asObject(envelope.usageMetadata, 'the google completion response .usageMetadata');
  return {
    text,
    usage: {
      inputTokens: requiredTokenCount(usageMetadata, 'promptTokenCount', 'usageMetadata'),
      outputTokens: requiredTokenCount(usageMetadata, 'candidatesTokenCount', 'usageMetadata'),
    },
    providerExecutionId: boundedId(
      envelope.responseId,
      'the google completion response .responseId',
    ),
  };
}

function buildEmbedding(input: WireEmbeddingInput): unknown {
  return { model: input.model, content: { parts: [{ text: input.input }] } };
}

function parseEmbedding(payload: unknown): WireEmbeddingResult {
  const envelope = asObject(payload, 'the google embedding response');
  const embedding = asObject(envelope.embedding, 'the google embedding response .embedding');
  const usageMetadata = asObject(envelope.usageMetadata, 'the google embedding response .usageMetadata');
  return {
    vector: parseVector(embedding.values, 'embedding.values', MAX_EMBEDDING_DIMENSIONS),
    usage: {
      inputTokens: requiredTokenCount(usageMetadata, 'tokenCount', 'usageMetadata'),
      outputTokens: 0,
    },
    providerExecutionId: boundedId(
      envelope.responseId,
      'the google embedding response .responseId',
    ),
  };
}

export const googleAdapter: LlmAdapter = {
  provider: 'google',
  buildCompletionRequest: buildCompletion,
  parseCompletionResponse: parseCompletion,
  buildEmbeddingRequest: buildEmbedding,
  parseEmbeddingResponse: parseEmbedding,
};
