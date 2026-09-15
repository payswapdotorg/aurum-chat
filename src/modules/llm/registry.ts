// The provider/model registry of the llm module (W034 — LLM Gateway and
// BYOA): the platform's canonical, code-owned catalog of AI providers and
// their models.
//
// WHY CODE, NOT A TABLE (the codebase's own standard): every persisted
// domain table must be tenant-scoped (check-architecture rule (d); only the
// platform allowlist `tenants`/`_migrations` is exempt), and the channels
// module solved the identical problem the same way — its provider
// vocabulary (CHANNEL_PROVIDERS) is code owned by the identity module and
// mirrored as CHECK constraints. Provider/model catalog entries are
// platform reference data, not tenant data: they change with adapter code
// (a provider whose dialect this module cannot speak cannot be routed to),
// so the registry and the adapter set version together. Tenants do NOT
// mutate the registry; they register tenant-owned AIProviderAccount records
// (BYOA) against it (ARCHITECTURE.md §18, lock 29).
//
// No provider/model is architecturally privileged (lock 30): the catalog is
// a flat list; routing preference comes only from tenant account
// configuration (priority ordering), never from registry position. Prices
// are LIST prices in integer minor units per million tokens
// (IMPLEMENTATION-STACK §8: integer minor units + ISO currency code) — they
// feed deterministic cost accounting; a tenant's own negotiated prices are
// a future extension and would live on the account, not here.

/** The canonical AI/LLM provider vocabulary (mirrored by every migration CHECK that names providers). */
export const LLM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'cohere',
  'deepseek',
  'groq',
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === 'string' &&
    (LLM_PROVIDERS as readonly string[]).includes(value)
  );
}

/** The canonical capabilities the gateway can route (mirrored by CHECK constraints and the adapters' dialects). */
export const LLM_CAPABILITIES = ['text-generation', 'embedding'] as const;

export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

export function isLlmCapability(value: unknown): value is LlmCapability {
  return (
    typeof value === 'string' &&
    (LLM_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * One model in the registry: what it can serve, its window, and its list
 * price. `modelId` is the canonical id the provider's own API accepts — an
 * OPAQUE string to everything outside the adapters (lock 16 discipline:
 * provider-minted values cross boundaries only as opaque strings).
 */
export interface LlmModelDescriptor {
  provider: LlmProvider;
  modelId: string;
  capabilities: readonly LlmCapability[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Integer minor units per 1,000,000 input tokens (USD). */
  priceInputMinorPerMillion: number;
  /** Integer minor units per 1,000,000 output tokens (USD). */
  priceOutputMinorPerMillion: number;
  currency: 'USD';
}

// The registry itself (MODULE-INTERNAL data; read access is re-exported
// read-only through the contract).
const MODELS: readonly LlmModelDescriptor[] = [
  // --- openai ---------------------------------------------------------------
  {
    provider: 'openai',
    modelId: 'gpt-4o',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    priceInputMinorPerMillion: 250,
    priceOutputMinorPerMillion: 1_000,
    currency: 'USD',
  },
  {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    priceInputMinorPerMillion: 15,
    priceOutputMinorPerMillion: 60,
    currency: 'USD',
  },
  {
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    capabilities: ['embedding'],
    contextWindowTokens: 8_191,
    maxOutputTokens: 0,
    priceInputMinorPerMillion: 2,
    priceOutputMinorPerMillion: 0,
    currency: 'USD',
  },
  // --- anthropic ------------------------------------------------------------
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    capabilities: ['text-generation'],
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    priceInputMinorPerMillion: 300,
    priceOutputMinorPerMillion: 1_500,
    currency: 'USD',
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    capabilities: ['text-generation'],
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    priceInputMinorPerMillion: 100,
    priceOutputMinorPerMillion: 500,
    currency: 'USD',
  },
  // --- google ----------------------------------------------------------------
  {
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    capabilities: ['text-generation'],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    priceInputMinorPerMillion: 125,
    priceOutputMinorPerMillion: 1_000,
    currency: 'USD',
  },
  {
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    capabilities: ['text-generation'],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    priceInputMinorPerMillion: 3,
    priceOutputMinorPerMillion: 12,
    currency: 'USD',
  },
  {
    provider: 'google',
    modelId: 'gemini-embedding-001',
    capabilities: ['embedding'],
    contextWindowTokens: 8_192,
    maxOutputTokens: 0,
    priceInputMinorPerMillion: 1,
    priceOutputMinorPerMillion: 0,
    currency: 'USD',
  },
  // --- mistral ---------------------------------------------------------------
  {
    provider: 'mistral',
    modelId: 'mistral-large-latest',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    priceInputMinorPerMillion: 200,
    priceOutputMinorPerMillion: 600,
    currency: 'USD',
  },
  {
    provider: 'mistral',
    modelId: 'mistral-small-latest',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    priceInputMinorPerMillion: 20,
    priceOutputMinorPerMillion: 60,
    currency: 'USD',
  },
  {
    provider: 'mistral',
    modelId: 'mistral-embed',
    capabilities: ['embedding'],
    contextWindowTokens: 8_192,
    maxOutputTokens: 0,
    priceInputMinorPerMillion: 1,
    priceOutputMinorPerMillion: 0,
    currency: 'USD',
  },
  // --- cohere ----------------------------------------------------------------
  {
    provider: 'cohere',
    modelId: 'command-r-plus',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    priceInputMinorPerMillion: 250,
    priceOutputMinorPerMillion: 1_250,
    currency: 'USD',
  },
  {
    provider: 'cohere',
    modelId: 'command-r',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
    priceInputMinorPerMillion: 50,
    priceOutputMinorPerMillion: 250,
    currency: 'USD',
  },
  {
    provider: 'cohere',
    modelId: 'embed-english-v3.0',
    capabilities: ['embedding'],
    contextWindowTokens: 512,
    maxOutputTokens: 0,
    priceInputMinorPerMillion: 10,
    priceOutputMinorPerMillion: 0,
    currency: 'USD',
  },
  // --- deepseek ---------------------------------------------------------------
  {
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    capabilities: ['text-generation'],
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192,
    priceInputMinorPerMillion: 27,
    priceOutputMinorPerMillion: 110,
    currency: 'USD',
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    capabilities: ['text-generation'],
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192,
    priceInputMinorPerMillion: 55,
    priceOutputMinorPerMillion: 219,
    currency: 'USD',
  },
  // --- groq --------------------------------------------------------------------
  {
    provider: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 32_768,
    priceInputMinorPerMillion: 59,
    priceOutputMinorPerMillion: 79,
    currency: 'USD',
  },
  {
    provider: 'groq',
    modelId: 'llama-3.1-8b-instant',
    capabilities: ['text-generation'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    priceInputMinorPerMillion: 5,
    priceOutputMinorPerMillion: 8,
    currency: 'USD',
  },
] as const;

const BY_PROVIDER = new Map<string, readonly LlmModelDescriptor[]>();
for (const model of MODELS) {
  const bucket = BY_PROVIDER.get(model.provider);
  if (bucket === undefined) BY_PROVIDER.set(model.provider, [model]);
  else BY_PROVIDER.set(model.provider, [...bucket, model]);
}

/** Every provider in the canonical vocabulary, in registry order. */
export function listLlmProviders(): LlmProvider[] {
  return [...LLM_PROVIDERS];
}

/** Every model of one provider (or of all providers when omitted), in registry order. */
export function listLlmModels(provider?: LlmProvider | null): LlmModelDescriptor[] {
  if (provider === undefined || provider === null) {
    return MODELS.map((model) => ({ ...model }));
  }
  const bucket = BY_PROVIDER.get(provider);
  return bucket === undefined ? [] : bucket.map((model) => ({ ...model }));
}

/** Look up one model of a provider; null when the registry carries no such entry. */
export function findLlmModel(provider: LlmProvider, modelId: string): LlmModelDescriptor | null {
  const bucket = BY_PROVIDER.get(provider);
  if (bucket === undefined) return null;
  const found = bucket.find((model) => model.modelId === modelId);
  return found === undefined ? null : { ...found };
}

/**
 * Internal invariant guard: a registry model must serve a capability and
 * its prices must be non-negative integers (the data below is static, but
 * the guard keeps future edits honest — tested).
 */
export function isValidModelDescriptor(model: LlmModelDescriptor): boolean {
  return (
    isLlmProvider(model.provider) &&
    typeof model.modelId === 'string' &&
    model.modelId.length > 0 &&
    model.capabilities.length > 0 &&
    model.capabilities.every((capability) => isLlmCapability(capability)) &&
    Number.isSafeInteger(model.contextWindowTokens) &&
    model.contextWindowTokens > 0 &&
    Number.isSafeInteger(model.maxOutputTokens) &&
    model.maxOutputTokens >= 0 &&
    Number.isSafeInteger(model.priceInputMinorPerMillion) &&
    model.priceInputMinorPerMillion >= 0 &&
    Number.isSafeInteger(model.priceOutputMinorPerMillion) &&
    model.priceOutputMinorPerMillion >= 0 &&
    model.currency === 'USD'
  );
}
