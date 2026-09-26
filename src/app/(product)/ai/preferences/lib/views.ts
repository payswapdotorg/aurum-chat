// AI preferences (W091) — the read models.
//
// `buildPreferencesView` composes the provider-preferences module's
// CONTRACT only (locks 31/32 — this page is a view, never a second
// source of truth): the resolved profile with its source attribution,
// the two preference levels, and the ORDINARY explanation feed — the
// jargon-free "why this option?" answer. Technical identity NEVER
// enters this view (the module's ordinary projection strips it; this
// builder never asks for it).
//
// `buildAdvancedView` is the ADVANCED half — the one surface technical
// identity appears on. It is claim-gated at the source: without the
// 'provider-preferences:administer' claim the builder returns the
// honest `unauthorized` shape (the page renders a gate notice, not
// data). With the claim it composes the module's claim-gated reads
// (the technical override rows, the FULL explanation record when
// ?explanation=<id> deep-links one) PLUS the llm module's registry and
// BYOA account reads — the technical provider details the authorized
// advanced user needs to pin an override deliberately. This is the
// only place in the preferences surface that may speak provider names.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  getPersonalPreference,
  getResolvedPreference,
  getSelectionExplanation,
  getTenantPreference,
  listSelectionExplanations,
  listTechnicalOverrides,
  PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER,
  type PersonalPreference,
  type ProviderPreferenceOutcome,
  type ResolvedPreferenceProfile,
  type SelectionExplanationRecord,
  type SelectionExplanationView,
  type TenantPreference,
  type TechnicalOverride,
} from '@/modules/provider-preferences/contract';
import { listAiProviderAccounts, listLlmModels, listLlmProviders } from '@/modules/llm/contract';
import type { AiProviderAccount, LlmModelDescriptor } from '@/modules/llm/contract';
import { ageLabel, capabilityLabel, outcomeLabel } from './labels';

// ---------------------------------------------------------------------------
// The ordinary view (jargon-free by construction)
// ---------------------------------------------------------------------------

/** One row of the ordinary "why this option?" feed. */
export interface ExplanationRow {
  id: string;
  capabilityLabel: string;
  decision: SelectionExplanationView['decision'];
  preferenceSource: SelectionExplanationView['preferenceSource'];
  decidingOutcomeLabel: string | null;
  candidatesConsidered: number;
  budgetExcludedCount: number;
  explanation: string;
  ageLabel: string;
}

/** The outcome-oriented preferences view the /ai/preferences page renders. */
export interface PreferencesView {
  /** The effective outcome priority for THIS member, with attribution. */
  resolved: ResolvedPreferenceProfile;
  /** The member's own preference (null when unset). */
  personal: PersonalPreference | null;
  /** The company-wide preference (null when unset). */
  tenant: TenantPreference | null;
  /** True when the session carries the administer claim. */
  canAdminister: boolean;
  /** The recent jargon-free "why this option?" records. */
  recentExplanations: ExplanationRow[];
  /** The ISO anchor the age labels are relative to. */
  generatedAt: string;
}

/** The ordinary explanation feed length (the page's quiet window). */
export const RECENT_EXPLANATION_LIMIT = 20;

export async function buildPreferencesView(ctx: TenantContext): Promise<PreferencesView> {
  const [resolved, personal, tenant, explanations] = await Promise.all([
    getResolvedPreference(ctx),
    getPersonalPreference(ctx),
    getTenantPreference(ctx),
    listSelectionExplanations(ctx, { limit: RECENT_EXPLANATION_LIMIT }),
  ]);
  const generatedAt = now().toISOString();
  return {
    resolved,
    personal,
    tenant,
    canAdminister: ctx.authority.includes(PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER),
    recentExplanations: explanations.map((entry) => ({
      id: entry.id,
      capabilityLabel: capabilityLabel(entry.capability),
      decision: entry.decision,
      preferenceSource: entry.preferenceSource,
      decidingOutcomeLabel:
        entry.decidingOutcome === null ? null : outcomeLabel(entry.decidingOutcome),
      candidatesConsidered: entry.candidatesConsidered,
      budgetExcludedCount: entry.budgetExcludedCount,
      explanation: entry.explanation,
      ageLabel: ageLabel(entry.occurredAt, generatedAt),
    })),
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// The advanced view (claim-gated; technical identity lives HERE)
// ---------------------------------------------------------------------------

/** One provider row of the technical catalog (registry + tenant accounts). */
export interface ProviderDetailRow {
  provider: string;
  models: number;
  /** Cheapest input list price across the provider's models (minor/million). */
  minInputPriceMinorPerMillion: number | null;
  /** The tenant's BYOA accounts on this provider. */
  accounts: Array<{ id: string; label: string; status: string; priority: number }>;
}

/** One override row of the advanced surface. */
export interface OverrideRow {
  id: string;
  gateway: string;
  capability: string | null;
  provider: string;
  reason: string;
  status: TechnicalOverride['status'];
  setBy: string;
  setAt: string;
  retiredAt: string | null;
}

/** The advanced view the /ai/preferences/advanced page renders. */
export interface AdvancedView {
  authorized: boolean;
  /** Present only when authorized. */
  providers: ProviderDetailRow[];
  overrides: OverrideRow[];
  /** The deep-linked FULL explanation record (?explanation=<id>). */
  explanationDetail: SelectionExplanationRecord | null;
  /** True when a deep-linked id resolved to nothing (uniform not-found). */
  explanationMissing: boolean;
  generatedAt: string;
}

/** The capability scopes the override form offers for the llm gateway. */
export const OVERRIDE_CAPABILITY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'All AI work (the whole gateway)' },
  { value: 'text-generation', label: 'Writing and analysis (text-generation)' },
  { value: 'embedding', label: 'Meaning and search (embedding)' },
];

export async function buildAdvancedView(
  ctx: TenantContext,
  explanationId: string | null,
): Promise<AdvancedView> {
  const generatedAt = now().toISOString();
  if (!ctx.authority.includes(PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER)) {
    return {
      authorized: false,
      providers: [],
      overrides: [],
      explanationDetail: null,
      explanationMissing: false,
      generatedAt,
    };
  }
  const [providers, models, accounts, overrides] = await Promise.all([
    listLlmProviders(),
    listLlmModels(null),
    listAiProviderAccounts(ctx, {}),
    listTechnicalOverrides(ctx, {}),
  ]);
  const modelsByProvider = new Map<string, LlmModelDescriptor[]>();
  for (const model of models) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(model);
    modelsByProvider.set(model.provider, list);
  }
  const accountsByProvider = new Map<string, AiProviderAccount[]>();
  for (const account of accounts) {
    const list = accountsByProvider.get(account.provider) ?? [];
    list.push(account);
    accountsByProvider.set(account.provider, list);
  }
  const providerRows: ProviderDetailRow[] = providers.map((provider) => {
    const providerModels = modelsByProvider.get(provider) ?? [];
    const inputPrices = providerModels.map((model) => model.priceInputMinorPerMillion);
    return {
      provider,
      models: providerModels.length,
      minInputPriceMinorPerMillion:
        inputPrices.length === 0 ? null : Math.min(...inputPrices),
      accounts: (accountsByProvider.get(provider) ?? []).map((account) => ({
        id: account.id,
        label: account.label,
        status: account.status,
        priority: account.priority,
      })),
    };
  });
  let explanationDetail: SelectionExplanationRecord | null = null;
  let explanationMissing = false;
  if (explanationId !== null) {
    try {
      explanationDetail = await getSelectionExplanation(ctx, { explanationId });
    } catch {
      explanationMissing = true;
    }
  }
  return {
    authorized: true,
    providers: providerRows,
    overrides: overrides.map((override) => ({
      id: override.id,
      gateway: override.gateway,
      capability: override.capability,
      provider: override.provider,
      reason: override.reason,
      status: override.status,
      setBy: override.setBy,
      setAt: override.setAt,
      retiredAt: override.retiredAt,
    })),
    explanationDetail,
    explanationMissing,
    generatedAt,
  };
}

/** The complete outcome-priority options for the forms (both levels). */
export function outcomeOptions(): readonly ProviderPreferenceOutcome[] {
  return ['cost', 'privacy', 'quality', 'speed'];
}
