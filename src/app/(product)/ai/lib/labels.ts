// AI/BYOA & Provider Routing UX (W066) — the surface's pure label/format
// layer.
//
// Everything here is a total function over llm-module CONTRACT vocabulary
// (providers, scopes, classifications, capabilities, availability states,
// routing rejection reasons, hot-swap outcomes): the human copy the page,
// the client controls and the tests all share, so the vocabularies can
// never drift between them (the same discipline the marketplace's
// labels.ts applies).
//
// Provider neutrality (locks 28/30): provider names render as plain
// labels — nothing here ranks, recommends or defaults any provider. The
// provider list the page renders is sorted ALPHABETICALLY on purpose, so
// not even display order can read as preference.

import type { PillTone } from '../../lib/states';
import type {
  AiProviderAccountStatus,
  DataClassification,
  LlmCapability,
  LlmHotSwapOutcome,
  LlmProvider,
  LlmRoutingRejectionReason,
  LlmScope,
} from '@/modules/llm/contract';

// CLIENT-SAFETY (the shell's navigation.ts discipline): this module is
// imported by CLIENT components (components/controls.tsx), so it must stay
// free of server-only imports. `@/modules/llm/contract` is therefore
// imported TYPE-ONLY (erased at compile time) and the two small runtime
// vocabularies it needs are declared HERE as the client-safe copies —
// the unit tests lock them to the contract's own lists so the two can
// never drift (exactly how navigation.ts mirrors the tower registry).

/** The llm contract's scope vocabulary (client-safe local copy; test-locked). */
export const AI_SCOPES: readonly LlmScope[] = [
  'cognition',
  'conversation',
  'analysis',
  'background',
];

/** The llm contract's data-classification vocabulary (client-safe copy; test-locked). */
export const AI_CLASSIFICATIONS: readonly DataClassification[] = [
  'public',
  'internal',
  'restricted',
];

// ---------------------------------------------------------------------------
// Vocabulary labels (every domain value has human copy)
// ---------------------------------------------------------------------------

/** Human provider names (labels only — never a ranking). */
const PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  mistral: 'Mistral',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  groq: 'Groq',
};

export function providerLabel(provider: LlmProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** What an account may be used FOR (scope labels + one-line semantics). */
const SCOPE_COPY: Record<LlmScope, { label: string; explanation: string }> = {
  cognition: {
    label: 'Cognition',
    explanation: 'The company intelligence loop’s own reasoning stages.',
  },
  conversation: {
    label: 'Conversation',
    explanation: 'Rendering chat replies (presentation, never authority).',
  },
  analysis: {
    label: 'Analysis',
    explanation: 'On-demand analysis of tenant evidence.',
  },
  background: {
    label: 'Background',
    explanation: 'Quiet background work (summaries, embeddings, maintenance).',
  },
};

export function scopeLabel(scope: LlmScope): string {
  return SCOPE_COPY[scope]?.label ?? scope;
}

export function scopeExplanation(scope: LlmScope): string {
  return SCOPE_COPY[scope]?.explanation ?? '';
}

/** The account’s data-policy ceiling (ordered: public < internal < restricted). */
export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  restricted: 2,
};

const CLASSIFICATION_COPY: Record<DataClassification, { label: string; explanation: string }> = {
  public: {
    label: 'Public data',
    explanation: 'Only data you would publish anyway may route here.',
  },
  internal: {
    label: 'Internal data',
    explanation: 'Normal company data may route here.',
  },
  restricted: {
    label: 'Restricted data',
    explanation: 'Even your most sensitive data may route here.',
  },
};

export function classificationLabel(classification: DataClassification): string {
  return CLASSIFICATION_COPY[classification]?.label ?? classification;
}

export function classificationExplanation(classification: DataClassification): string {
  return CLASSIFICATION_COPY[classification]?.explanation ?? '';
}

/** The canonical capabilities the gateway routes. */
const CAPABILITY_COPY: Record<LlmCapability, { label: string; explanation: string }> = {
  'text-generation': {
    label: 'Text generation',
    explanation: 'Chat completions and reasoning turns rendered as text.',
  },
  embedding: {
    label: 'Embeddings',
    explanation: 'Vector representations for retrieval and similarity.',
  },
};

export function capabilityLabel(capability: LlmCapability): string {
  return CAPABILITY_COPY[capability]?.label ?? capability;
}

export function capabilityExplanation(capability: LlmCapability): string {
  return CAPABILITY_COPY[capability]?.explanation ?? '';
}

// ---------------------------------------------------------------------------
// Statuses, availability, routing reasons, hot-swap outcomes
// ---------------------------------------------------------------------------

export function accountStatusTone(status: AiProviderAccountStatus): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

export function accountStatusLabel(status: AiProviderAccountStatus): string {
  return status === 'active' ? 'Active' : 'Revoked';
}

export function accountStatusExplanation(status: AiProviderAccountStatus): string {
  return status === 'active'
    ? 'Eligible for routing under its scopes, capabilities, data policy and budget.'
    : 'Revoked — the gateway no longer routes here. The record, its evidence and its spend history are retained.';
}

/** Availability states as pill tone + human copy. */
export function availabilityTone(state: 'available' | 'unavailable'): PillTone {
  return state === 'available' ? 'positive' : 'error';
}

export function availabilityLabel(state: 'available' | 'unavailable'): string {
  return state === 'available' ? 'Available' : 'Unavailable';
}

/** Human copy for every machine routing-rejection reason (§24 auditability). */
const REJECTION_LABELS: Record<LlmRoutingRejectionReason, string> = {
  account_disabled: 'account revoked',
  scope_not_permitted: 'scope not permitted by the account',
  capability_not_permitted: 'capability not permitted by the account',
  data_classification_exceeds_account_policy: 'data policy ceiling exceeded',
  budget_exhausted: 'monthly budget exhausted',
  capability_not_supported_by_model: 'model does not support the capability',
  model_output_limit: 'requested output exceeds the model cap',
  unavailable: 'temporarily unavailable (cooldown or manual hold)',
  not_pinned_target: 'not the pinned target',
};

export function routingRejectionLabel(reason: LlmRoutingRejectionReason): string {
  return REJECTION_LABELS[reason] ?? reason;
}

/** Hot-swap verification outcomes (deterministic structural comparison). */
export function hotSwapOutcomeTone(outcome: LlmHotSwapOutcome): PillTone {
  if (outcome === 'equivalent') return 'positive';
  if (outcome === 'completed-divergent') return 'info';
  return 'error';
}

export function hotSwapOutcomeLabel(outcome: LlmHotSwapOutcome): string {
  if (outcome === 'equivalent') return 'Equivalent';
  if (outcome === 'completed-divergent') return 'Completed, divergent output';
  return 'Failed';
}

export function hotSwapOutcomeExplanation(outcome: LlmHotSwapOutcome): string {
  if (outcome === 'equivalent') {
    return 'Both targets completed and produced identical normalized canonical output — the swap is proven byte-for-byte.';
  }
  if (outcome === 'completed-divergent') {
    return 'Both targets completed through the same provider-neutral contract; their canonical outputs differ textually. The swap still proved — semantic judgment stays with you.';
  }
  return 'At least one target failed — the recorded executions carry the failure evidence.';
}

/** Execution status (append-only evidence rows). */
export function executionStatusTone(status: 'completed' | 'failed'): PillTone {
  return status === 'completed' ? 'positive' : 'error';
}

export function executionPurposeLabel(purpose: 'invocation' | 'hot-swap-verification'): string {
  return purpose === 'invocation' ? 'Invocation' : 'Hot-swap verification';
}

// ---------------------------------------------------------------------------
// Formatting (integer minor units + ISO currency — IMPLEMENTATION-STACK §8)
// ---------------------------------------------------------------------------

/** Format integer minor units as a USD amount ("$1.23"). */
export function formatUsdMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(minor));
  const dollars = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${cents}`;
}

/** The per-million list price of one direction, as a display string. */
export function formatPricePerMillion(minorPerMillion: number): string {
  return `${formatUsdMinor(minorPerMillion)} / 1M tokens`;
}

/** Compact latency copy ("812 ms", "1.4 s"). */
export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

/** Compact token counts ("1.1k", "2.4M"). */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Relative age from ISO instants (quiet "3m ago" style, no locale data). */
export function ageLabel(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// The surface’s standing notes (lock 30 honesty, credential discipline)
// ---------------------------------------------------------------------------

/**
 * Lock 30 stated where it matters — on the routing surface itself: no
 * provider/model is architecturally privileged, preference is tenant-owned.
 */
export const NO_PRIVILEGED_PROVIDER_NOTE =
  'No provider or model is architecturally privileged. The registry is a flat catalog of reference data; routing preference comes only from your accounts’ priority ordering — registry position never participates.';

/** The BYOA credential discipline (never a credential VALUE). */
export const CREDENTIAL_NOTE =
  'Accounts store an opaque secret-store reference — never the credential value. Rotate the reference when the underlying credential changes.';

/** What a revoked account means (there is deliberately no delete). */
export const REVOKE_NOTE =
  'Revoking disables routing while the account, its evidence and its spend history stay intact — failures and forensic reconstruction need the record.';

/** Provider options for select controls — ALPHABETICAL, never registry order. */
export function providerOptions(providers: readonly LlmProvider[]): {
  value: string;
  label: string;
}[] {
  return [...providers]
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => ({ value: provider, label: providerLabel(provider) }));
}

/** Scope options in the contract’s own vocabulary order. */
export function scopeOptions(): { value: string; label: string }[] {
  return AI_SCOPES.map((scope) => ({ value: scope, label: scopeLabel(scope) }));
}

/** Classification options ordered from the safest ceiling upward. */
export function classificationOptions(): { value: string; label: string }[] {
  return AI_CLASSIFICATIONS.map((classification) => ({
    value: classification,
    label: classificationLabel(classification),
  }));
}

// ---------------------------------------------------------------------------
// Suggested hot-swap parameters (pure; the form’s honest defaults)
// ---------------------------------------------------------------------------

/**
 * The scope + data classification a hot-swap between two accounts can use
 * RIGHT NOW: a scope both accounts permit, and the STRICTER (lower) of the
 * two data-policy ceilings. Pure suggestion — the module still validates.
 */
export function suggestedHotSwapParameters(
  accountA: { scopes: readonly LlmScope[]; maxDataClassification: DataClassification },
  accountB: { scopes: readonly LlmScope[]; maxDataClassification: DataClassification },
): { scope: LlmScope; dataClassification: DataClassification } | null {
  const scope =
    AI_SCOPES.find(
      (candidate) =>
        (accountA.scopes as readonly string[]).includes(candidate) &&
        (accountB.scopes as readonly string[]).includes(candidate),
    ) ?? null;
  if (scope === null) return null;
  const dataClassification =
    CLASSIFICATION_RANK[accountA.maxDataClassification] <=
    CLASSIFICATION_RANK[accountB.maxDataClassification]
      ? accountA.maxDataClassification
      : accountB.maxDataClassification;
  return { scope, dataClassification };
}

// ---------------------------------------------------------------------------
// The connection-test / hot-swap canonical prompts (surface-owned constants)
// ---------------------------------------------------------------------------

/** The tiny canonical prompt a connection test sends (public data only). */
export const ACCOUNT_TEST_PROMPT =
  'Connection test. Reply with the single word: ready.';

/** The canonical prompt a hot-swap verification runs on both targets. */
export const HOT_SWAP_PROMPT =
  'Provider swap verification. Reply with exactly: provider swap verified.';

/** The canonical embedding input for embedding-capability tests. */
export const EMBEDDING_TEST_INPUT = 'aurum provider connection test';
