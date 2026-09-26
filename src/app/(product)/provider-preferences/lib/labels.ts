// Provider choice (W091) — the surface's pure label/format layer.
//
// Everything here is a total function over PLAIN vocabulary: the human copy
// the page, the client controls and the tests all share, so the copy can
// never drift between them (the ai/labels.ts discipline).
//
// JARGON RULE (W091 acceptance): the DEFAULT surface (choice form,
// explanation, change history, and the unauthorized advanced branch)
// renders NO provider names, model ids, capability codes, scope codes or
// classification enum values — everything a member sees is outcomes in
// plain words. The technical labels (providerLabel, scopeLabel,
// capabilityLabel, classificationLabel, accountStatus*) exist ONLY for the
// authorized advanced table.
//
// CLIENT-SAFETY (the shell's navigation.ts discipline): this module is
// imported by CLIENT components (components/controls.tsx), so it must stay
// free of server-only imports. The module contracts are therefore imported
// TYPE-ONLY (erased at compile time) and the vocabularies the client needs
// are declared HERE as client-safe copies — the unit tests lock them to
// the contract's own values so the two can never drift (exactly how
// navigation.ts mirrors the tower registry and ai/labels.ts mirrors the
// llm vocabulary).

import type { PillTone } from '../../lib/states';
import type {
  AiProviderAccountStatus,
  DataClassification,
  LlmCapability,
  LlmProvider,
  LlmScope,
} from '@/modules/llm/contract';
import type {
  PreferenceChangeEventKind,
  PreferenceOutcomeDimension,
  ProviderPreferenceKind,
} from '@/modules/provider-preferences/contract';

// ---------------------------------------------------------------------------
// The preference catalog (client-safe copy; unit-test-locked to the contract)
// ---------------------------------------------------------------------------

/** One selectable outcome preference, as the choice form renders it. */
export interface PreferenceOptionCopy {
  kind: ProviderPreferenceKind;
  /** Plain-language label — no provider jargon. */
  label: string;
  /** One plain sentence on what Aurum does under this choice. */
  description: string;
  dimension: PreferenceOutcomeDimension;
}

/**
 * The five outcome options, verbatim copies of the module contract's
 * PREFERENCE_OPTIONS (the unit test deep-matches the two so the client
 * copy can never drift from the module's own catalog).
 */
export const PREFERENCE_OPTIONS_COPY: readonly PreferenceOptionCopy[] = [
  {
    kind: 'privacy-first',
    label: 'Prioritize privacy',
    description:
      'Aurum tries the options allowed to handle the least sensitive information first, and never sends anything beyond your data policy.',
    dimension: 'privacy',
  },
  {
    kind: 'lowest-cost',
    label: 'Lowest cost',
    description:
      'Aurum tries your cheapest options first — based on the costs your own usage has recorded, never on guessed prices.',
    dimension: 'cost',
  },
  {
    kind: 'fastest',
    label: 'Fastest responses',
    description:
      'Aurum tries the options that have answered fastest in your own recorded usage.',
    dimension: 'speed',
  },
  {
    kind: 'most-reliable',
    label: 'Most reliable',
    description:
      'Aurum tries the options with the highest share of completed tasks in your own recorded usage.',
    dimension: 'quality',
  },
  {
    kind: 'balanced',
    label: 'Balanced (your organization’s policy)',
    description:
      'Keep the order your administrators configured — your organization’s own settings are the policy.',
    dimension: 'policy',
  },
];

/** The plain label of one preference (falls back to the kind id). */
export function preferenceLabel(kind: ProviderPreferenceKind): string {
  return PREFERENCE_OPTIONS_COPY.find((option) => option.kind === kind)?.label ?? kind;
}

/** The plain description of one preference (falls back to the kind id). */
export function preferenceDescription(kind: ProviderPreferenceKind): string {
  return PREFERENCE_OPTIONS_COPY.find((option) => option.kind === kind)?.description ?? kind;
}

/** The client-safe copy of the contract's note length cap (test-locked). */
export const MAX_NOTE_LENGTH_COPY = 2000;

// ---------------------------------------------------------------------------
// Application state (the honest In effect / Saved / Default states)
// ---------------------------------------------------------------------------

/** The application facts a state label needs (structural — the view fits). */
export interface PreferenceStateFacts {
  saved: boolean;
  pendingApplication: boolean;
}

/** The current state of the tenant's choice, in plain words. */
export function preferenceStateLabel(facts: PreferenceStateFacts): string {
  if (!facts.saved) return 'Default (nothing saved yet)';
  return facts.pendingApplication ? 'Saved — waiting to be applied' : 'In effect';
}

/** The pill tone for that state (never color alone — the pill carries text). */
export function preferenceStateTone(facts: PreferenceStateFacts): PillTone {
  if (!facts.saved) return 'neutral';
  return facts.pendingApplication ? 'warning' : 'positive';
}

/**
 * The honest pending-application note (the same words the module's save
 * summary uses — a saved-but-unapplied choice is waiting for an
 * administrator, never silently lost).
 */
export const PENDING_APPLICATION_NOTE =
  'Saved — an administrator of your company applies new choices in the advanced settings.';

// ---------------------------------------------------------------------------
// Change-history labels (plain words; technical overrides stay advanced)
// ---------------------------------------------------------------------------

/** The plain label of one change-history event kind. */
export function eventLabel(event: PreferenceChangeEventKind): string {
  if (event === 'preference-saved') return 'Choice saved';
  if (event === 'preference-applied') return 'Choice applied';
  return 'Technical change';
}

/** The pill tone for one change-history event kind. */
export function eventTone(event: PreferenceChangeEventKind): PillTone {
  if (event === 'preference-applied') return 'positive';
  if (event === 'technical-override') return 'neutral';
  return 'info';
}

/** What the default surface renders for a technical-override event. */
export const TECHNICAL_CHANGE_PLACEHOLDER = 'Technical change (see advanced settings)';

// ---------------------------------------------------------------------------
// Formatting (integer minor units + relative ages — the ai/labels.ts copies)
// ---------------------------------------------------------------------------

/** Format integer minor units as a USD amount ("$1.23"). */
export function formatUsdMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(minor));
  const dollars = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${cents}`;
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
// Technical labels (ADVANCED TABLE ONLY — provider names live here and only
// here; the default surface never calls these)
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

/** What an account may be used FOR (scope labels). */
const SCOPE_LABELS: Record<LlmScope, string> = {
  cognition: 'Cognition',
  conversation: 'Conversation',
  analysis: 'Analysis',
  background: 'Background',
};

export function scopeLabel(scope: LlmScope): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** The capabilities an account may serve. */
const CAPABILITY_LABELS: Record<LlmCapability, string> = {
  'text-generation': 'Text generation',
  embedding: 'Embeddings',
};

export function capabilityLabel(capability: LlmCapability): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

/** The data-policy ceiling (advanced table only). */
const CLASSIFICATION_LABELS: Record<DataClassification, string> = {
  public: 'Public data',
  internal: 'Internal data',
  restricted: 'Restricted data',
};

export function classificationLabel(classification: DataClassification): string {
  return CLASSIFICATION_LABELS[classification] ?? classification;
}

/** Account status in plain words (advanced table + override form). */
export function accountStatusLabel(status: AiProviderAccountStatus): string {
  return status === 'active' ? 'Active' : 'Switched off';
}

export function accountStatusTone(status: AiProviderAccountStatus): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}
