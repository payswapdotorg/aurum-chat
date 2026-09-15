// The canonical adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical provider (the llm module's registry
// vocabulary). Adapters are private to the llm module: the contract speaks
// only canonical types, so swapping a provider implementation (or adding
// one) never touches a domain contract — the hot-swap property W034 must
// demonstrate and W048 will verify end-to-end. DeepSeek and Groq speak the
// OpenAI-compatible dialect through the factory in openai.ts.

import type { LlmProvider } from '../registry';
import { LLM_PROVIDERS } from '../registry';
import { LlmError } from '../errors';
import { anthropicAdapter } from './anthropic';
import { cohereAdapter } from './cohere';
import { googleAdapter } from './google';
import { mistralAdapter } from './mistral';
import { openaiAdapter, openaiCompatibleAdapter } from './openai';
import type { LlmAdapter } from './types';

const ADAPTERS: Record<LlmProvider, LlmAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  mistral: mistralAdapter,
  cohere: cohereAdapter,
  deepseek: openaiCompatibleAdapter('deepseek'),
  groq: openaiCompatibleAdapter('groq'),
};

/** The adapter of a canonical provider (never null — the vocabulary is closed). */
export function getLlmAdapter(provider: string): LlmAdapter {
  const adapter = (ADAPTERS as Record<string, LlmAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new LlmError('unsupported_provider', `unsupported llm provider '${provider}'`);
  }
  return adapter;
}

/** Every canonical provider has an adapter (exhaustiveness guard). */
export function allLlmAdapters(): LlmAdapter[] {
  return LLM_PROVIDERS.map((provider) => ADAPTERS[provider]);
}
