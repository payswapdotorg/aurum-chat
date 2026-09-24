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
//
// W089 (Provider Adapter SDK): alongside its gateway-native LlmAdapter
// translation duties, this adapter is a conforming ProviderAdapterDefinition
// — the canonical lifecycle/error/capability contract shared by every
// gateway (the second of the two-provider proof; see openai.ts). The
// definition adds no execution method and no selection logic. Behavior of
// the translation methods is UNCHANGED (the module's existing suites stay
// green unmodified).

import {
  createProviderAdapterDefinition,
  type CanonicalErrorCategory,
  type ProviderAdapterDefinition,
} from '@/modules/provider-sdk/contract';
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

/**
 * Provider-specific error classification for the SDK's canonical taxonomy:
 * the LlmError codes this adapter can produce (malformed responses, the
 * loud unsupported-embedding rejection, the system-only mapping rejection)
 * map onto the gateway-neutral categories; anything else falls through to
 * the SDK's conservative heuristics.
 */
function classifyAnthropicError(error: unknown): CanonicalErrorCategory | null {
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

/** The W089 SDK adapter definition (canonical lifecycle/error/capability surface). */
export const anthropicDefinition: ProviderAdapterDefinition = createProviderAdapterDefinition({
  gateway: 'llm',
  provider: 'anthropic',
  // Anthropic exposes no embeddings API — the capability declaration says
  // so honestly (text-generation only), matching the registry and the loud
  // embedding rejection below.
  capabilities: ['text-generation'],
  classifyError: classifyAnthropicError,
});

export const anthropicAdapter: LlmAdapter & ProviderAdapterDefinition = {
  ...anthropicDefinition,
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
