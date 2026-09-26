// Public domain types of the provider-preferences module (W091 —
// User-Friendly Provider Choice UX).
//
// This module is the OUTCOME LAYER over the llm gateway's routing facts —
// it is NOT a router and touches no provider implementation: the routing
// engine (llm/routing.ts) stays exactly as-is. The tenant expresses ONE
// outcome preference in plain language (privacy, cost, speed, reliability,
// or the balanced default of the organization's own configured order); the
// module maps that choice deterministically ONTO the existing routing
// facts — the tenant-owned account `priority` ordering consumed by the
// llm gateway (AiProviderAccount.priority, lower preferred) — and records
// the mapping and every change as append-only audit.
//
// No provider/model is architecturally privileged (lock 30): the mapping
// never hard-codes a provider name, and preference language contains no
// provider jargon by construction. Ordinary users see ONLY outcomes; the
// technical layer (accounts, priority numbers, pins, capabilities) is
// scope-gated behind the same authority claim that administers AI
// provider accounts ('llm:administer', W009 discipline), and the technical
// override rides the EXISTING llm service input
// (UpdateAiProviderAccountInput) — no new routing channel is invented.
//
// Honesty rules (the house discipline):
//   * outcome labels cite real contract facts — cost cites the W090
//     provider-billing usage attribution (public reads), privacy cites the
//     account's data-policy ceiling plus the provider-sdk technology
//     registry's security posture when an evaluated entry exists;
//   * when a dimension has no measured evidence in the public contracts,
//     the label says so (honestly-unavailable) and the current order
//     stays — ratings are never invented;
//   * missing facts render as honest unavailable states naming the
//     missing public contract, never invented explanations.

import type {
  AiProviderAccount,
  DataClassification,
  LlmProvider,
  LlmRoutingCandidateSnapshot,
  LlmRoutingRejectionReason,
} from '@/modules/llm/contract';
import type { UsageSummaryRow } from '@/modules/provider-billing/contract';

// ---------------------------------------------------------------------------
// The outcome preference vocabulary
// ---------------------------------------------------------------------------

/**
 * The tenant-level outcome preference. Plain-language choices only —
 * 'balanced' is the honest default meaning "keep the organization's own
 * configured order" (the administrator-set priorities ARE the
 * organizational policy).
 */
export type ProviderPreferenceKind =
  | 'privacy-first'
  | 'lowest-cost'
  | 'fastest'
  | 'most-reliable'
  | 'balanced';

/** The outcome dimension a preference expresses (W091's catalog language). */
export type PreferenceOutcomeDimension = 'privacy' | 'cost' | 'speed' | 'quality' | 'policy';

/** One selectable preference, carrying its user-language presentation. */
export interface PreferenceOption {
  kind: ProviderPreferenceKind;
  /** Plain-language label ("Prioritize privacy") — no provider jargon. */
  label: string;
  /** One plain sentence on what Aurum does under this choice. */
  description: string;
  dimension: PreferenceOutcomeDimension;
}

// ---------------------------------------------------------------------------
// The preference profile (persisted, tenant-scoped, audited)
// ---------------------------------------------------------------------------

/** The persisted tenant preference profile (one row per tenant). */
export interface ProviderPreferenceProfile {
  id: string;
  tenantId: string;
  preference: ProviderPreferenceKind;
  note: string | null;
  updatedBy: string;
  /** ISO 8601 — service clock. */
  updatedAt: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** The preference currently in routing effect (applied), null = never applied. */
  appliedPreference: ProviderPreferenceKind | null;
  /** ISO 8601 — when the applied preference was last written to routing. */
  appliedAt: string | null;
}

export interface SavePreferenceProfileInput {
  preference: ProviderPreferenceKind;
  note?: string | null;
}

/**
 * The tenant's preference profile composed for the DEFAULT surface —
 * everything here is plain-language-safe (no provider jargon): the saved
 * choice (or the honest default), its application state, and the current
 * mapping guidance (positions + basis + notes).
 */
export interface ProviderPreferenceProfileView {
  /** The tenant's saved choice, or the honest default when none is saved. */
  preference: ProviderPreferenceKind;
  /** True when a profile row exists (a choice has been saved). */
  saved: boolean;
  note: string | null;
  updatedBy: string;
  /** ISO 8601 — service clock. */
  updatedAt: string | null;
  /** The preference currently in routing effect; null = never applied. */
  appliedPreference: ProviderPreferenceKind | null;
  appliedAt: string | null;
  /** True when a saved choice is not yet in routing effect. */
  pendingApplication: boolean;
  /** The current mapping guidance (positions + plain basis). */
  mappings: PreferenceAssignment[];
  mappingNotes: string[];
  /** How many change events the audit carries (the change-anytime proof). */
  changeEventCount: number;
}

// ---------------------------------------------------------------------------
// The deterministic preference → routing-order mapping (the documentation
// of how the outcome choice maps ONTO the existing routing facts)
// ---------------------------------------------------------------------------

/** The routing facts of one AI option, read from the llm contract. */
export interface AccountPreferenceFacts {
  accountId: string;
  /**
   * The option's provider key (the llm contract's neutral vocabulary).
   * A pure evidence-join key for the mapping core — NEVER rendered on
   * the default surface (lock 30: no provider is privileged, and the
   * default surface speaks outcomes only).
   */
  provider: LlmProvider;
  /** Current routing priority (lower preferred — the llm contract's fact). */
  priority: number;
  maxDataClassification: DataClassification;
  status: AiProviderAccount['status'];
  /** ISO 8601 — creation time (the routing engine's deterministic tiebreak). */
  createdAt: string;
}

/**
 * The measured evidence the mapping may cite (public contract reads only).
 * Cost evidence prefers the W090 provider-billing attribution; latency and
 * reliability come from the llm gateway's own usage aggregates.
 */
export interface PreferenceEvidence {
  /** llm contract getLlmUsageSummary — per (provider, model, capability). */
  usage: readonly {
    provider: LlmProvider;
    executions: number;
    completed: number;
    failed: number;
    costMinor: number;
    avgLatencyMs: number | null;
  }[];
  /** W090 provider-billing getUsageSummary({ gateway: 'llm' }) attribution rows. */
  billing: readonly UsageSummaryRow[];
}

/** One option's assigned place under the current preference. */
export interface PreferenceAssignment {
  accountId: string;
  /** 1-based position in the preference's order (1 = tried first). */
  position: number;
  /** The routing priority the mapping assigns (lower preferred). */
  assignedPriority: number;
  /**
   * Plain-language basis for this option's place — cites the contract
   * evidence or states honestly that none exists. NO provider jargon.
   */
  basis: string;
  /** False when this option kept its configured place for lack of evidence. */
  evidenceAvailable: boolean;
}

/** The full deterministic plan a preference implies. */
export interface PreferenceOrderPlan {
  preference: ProviderPreferenceKind;
  assignments: PreferenceAssignment[];
  /** Honest-unavailable notes (plain language) about missing evidence. */
  notes: string[];
  /** False when the plan's order already matches the current routing order. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// The explanation surface (rendered from FROZEN routing snapshots)
// ---------------------------------------------------------------------------

/** One plain-language line of a routing explanation. */
export interface RoutingExplanationLine {
  kind: 'chosen' | 'rejected' | 'unexplained';
  /** Plain language, no provider/model names, no machine codes. */
  text: string;
}

/** The pure rendering of one frozen LlmRoutingSnapshot (machine → plain). */
export interface RoutingExplanation {
  pinned: boolean;
  /** Null when nothing was chosen (every candidate rejected). */
  chosen: RoutingExplanationLine | null;
  /** One line per candidate that was not chosen. */
  rejected: RoutingExplanationLine[];
  /** One line per candidate whose machine reason is not in the vocabulary. */
  unexplained: RoutingExplanationLine[];
}

/** The explanation of one routing decision, default (jargon-free) + technical. */
export type RoutingDecisionExplanation =
  | { found: false; reason: 'no-executions' | 'execution-not-found'; note: string }
  | {
      found: true;
      executionId: string;
      /** ISO 8601 — when the explained task ran. */
      invokedAt: string;
      status: 'completed' | 'failed';
      /** Plain-language, jargon-free explanation lines (the default surface). */
      explanation: RoutingExplanation;
      /** Plain sentence naming the tenant's current outcome choice. */
      preferenceLine: string;
      /**
       * Technical detail (provider/model names, machine reasons) — rendered
       * ONLY by the authorized advanced view, never the default surface.
       */
      technical: {
        pinned: boolean;
        chosen: { accountId: string; provider: LlmProvider; model: string } | null;
        candidates: LlmRoutingCandidateSnapshot[];
      };
    };

// ---------------------------------------------------------------------------
// Change events (append-only audit)
// ---------------------------------------------------------------------------

export type PreferenceChangeEventKind =
  | 'preference-saved'
  | 'preference-applied'
  | 'technical-override';

/** One append-only change event (the "changed at any time" audit). */
export interface PreferenceChangeEvent {
  id: string;
  tenantId: string;
  event: PreferenceChangeEventKind;
  /** The preference the event concerns (null for technical overrides). */
  preference: ProviderPreferenceKind | null;
  summary: string;
  actor: string;
  /** ISO 8601 — service clock at event time. */
  occurredAt: string;
}

export interface ListPreferenceChangeEventsQuery {
  limit?: number;
}

// ---------------------------------------------------------------------------
// The technical layer (authorized advanced users only)
// ---------------------------------------------------------------------------

/** One AI option as the authorized technical view renders it. */
export interface TechnicalAccountRow {
  accountId: string;
  provider: LlmProvider;
  label: string;
  status: AiProviderAccount['status'];
  scopes: AiProviderAccount['scopes'];
  capabilities: AiProviderAccount['capabilities'];
  maxDataClassification: DataClassification;
  priority: number;
  /** 1-based position in the current routing order. */
  routingPosition: number;
  budgetMinor: number | null;
}

/** The authorized technical view of the provider-choice layer. */
export interface TechnicalLayerView {
  /** ISO 8601 — service clock. */
  generatedAt: string;
  preference: ProviderPreferenceKind;
  appliedPreference: ProviderPreferenceKind | null;
  appliedAt: string | null;
  /** The current deterministic mapping guidance (positions + basis). */
  mappings: PreferenceAssignment[];
  mappingNotes: string[];
  /** The tenant's AI options in current routing order (technical detail). */
  accounts: TechnicalAccountRow[];
}

/**
 * The technical override input — a thin, validated projection onto the
 * EXISTING llm service input (UpdateAiProviderAccountInput): priority,
 * status, scopes, data-policy ceiling and budget. Credential rotation
 * stays on the /ai surface (the account-management home); this surface's
 * override is the routing-relevant subset, reversible at any time.
 */
export interface TechnicalOverrideInput {
  accountId: string;
  priority?: number;
  status?: AiProviderAccount['status'];
  scopes?: AiProviderAccount['scopes'];
  capabilities?: AiProviderAccount['capabilities'];
  maxDataClassification?: DataClassification;
  budgetMinor?: number | null;
}

/** The result of applying a preference (or saving one) to routing. */
export interface PreferenceApplication {
  /** True when the preference is in routing effect after this call. */
  applied: boolean;
  /** True when an authorized administrator must apply the saved choice. */
  requiresAdministrator: boolean;
  /** Plain-language summary of what happened (no jargon). */
  summary: string;
  /** How many account priorities the application wrote (0 = no change needed). */
  written: number;
}

/** The saved profile plus its application outcome. */
export interface SavePreferenceProfileResult {
  profile: ProviderPreferenceProfile;
  application: PreferenceApplication;
}

export interface ApplyPreferenceProfileResult {
  profile: ProviderPreferenceProfile;
  application: PreferenceApplication;
}

export interface TechnicalOverrideResult {
  account: AiProviderAccount;
  summary: string;
}

// Re-exported for the mapping core's consumers (kept type-only; the
// rejection vocabulary is the machine reason source of truth).
export type { LlmRoutingRejectionReason };
