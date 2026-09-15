// Anthropic adapter (MODULE-INTERNAL — provider-native payloads never cross
// the llm module; lock 28 / IMPLEMENTATION-STACK §6).
//
// Dialect:
//   completion → POST /v1/messages
//     request  { model, max_tokens, system?, temperature?, messages:
//                [{role: 'user'|'assistant', content: [{type: 'text', text}]}] }
//     response { id, content: [{type: 'text', text}], usage: {input_tokens, output_tokens} }
//   embedding — Anthropic exposes no embeddings API: the registry carries no
//     anthropic embedding model, so the adapter rejects the attempt loudly
//     instead of faking one.

import { LlmError } from '../errors';
import {
  asArray,
  asObject,
  boundedId,
  boundedText,
  requiredTokenCount,
} from './shared';
import {
  malformedResponse,
  type LlmAdapter,
  type WireCompletionInput,
  type WireCompletionResult,
} from './types';

const MAX_RESULT_TEXT = 262_144;

export function buildAnthropicCompletionRequest(input: WireCompletionInput): unknown {
  // Anthropic carries system prompts OUT of the message list (the `system`
  // field); user/assistant turns become typed content blocks.
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }> = [];
  for (const message of input.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    messages.push({
      role: message.role,
      content: [{ type: 'text', text: message.content }],
    });
  }
  if (messages.length === 0) {
    // Canonical validation guarantees at least one message, but an
    // all-system request cannot map onto the anthropic wire shape — reject
    // rather than substitute.
    throw new LlmError(
      'invalid_llm_input',
      'anthropic requests require at least one user or assistant message (system-only requests cannot be mapped)',
    );
  }
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxOutputTokens,
    messages,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (input.temperature !== null) body.temperature = input.temperature;
  return body;
}

function parseCompletion(payload: unknown): WireCompletionResult {
  const envelope = asObject(payload, 'the anthropic completion response');
  const content = asArray(envelope.content, 'the anthropic completion response .content');
  if (content.length === 0) {
    throw malformedResponse('the anthropic completion response carries no content block');
  }
  const text = content
    .map((entry, index) => {
      const block = asObject(entry, `content[${index}]`);
      if (block.type !== 'text') return null;
      return boundedText(block.text, 'text', `content[${index}]`, MAX_RESULT_TEXT);
    })
    .filter((part): part is string => part !== null)
    .join('');
  if (text === '') {
    throw malformedResponse('the anthropic completion response carries no text block');
  }
  const usage = asObject(envelope.usage, 'the anthropic completion response .usage');
  return {
    text,
    usage: {
      inputTokens: requiredTokenCount(usage, 'input_tokens', 'usage'),
      outputTokens: requiredTokenCount(usage, 'output_tokens', 'usage'),
    },
    providerExecutionId: boundedId(envelope.id, 'the anthropic completion response .id'),
  };
}

export const anthropicAdapter: LlmAdapter = {
  provider: 'anthropic',
  buildCompletionRequest: buildAnthropicCompletionRequest,
  parseCompletionResponse: parseCompletion,
  buildEmbeddingRequest(): never {
    throw new LlmError(
      'unsupported_capability',
      'the anthropic provider exposes no embeddings API — the registry carries no anthropic embedding model',
    );
  },
  parseEmbeddingResponse(): never {
    throw new LlmError(
      'unsupported_capability',
      'the anthropic provider exposes no embeddings API — the registry carries no anthropic embedding model',
    );
  },
};
