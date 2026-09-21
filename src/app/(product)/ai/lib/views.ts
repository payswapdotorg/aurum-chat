// AI/BYOA & Provider Routing UX (W066) — the view builders.
//
// Server-side composition of the llm module's CONTRACT only (locks 28/30/31:
// the LLM gateway is the single way in, contracts never raw persistence):
// the tenant's BYOA accounts with per-model availability and budget
// posture, the provider/model registry (platform reference data — read
// via the contract, never mutated), the cost/latency usage aggregates,
// the append-only execution evidence, and the hot-swap verification
// evidence feed.
//
// Honesty rules (the learning/connections discipline):
//   * a FAILING read renders an empty section plus a `degraded` note —
//     never fake emptiness, never a crash;
//   * the view never claims a provider is "preferred": accounts render in
//     the tenant's own priority order (the routing order), the registry
//     renders alphabetically, and the no-privilege note rides along
//     (labels.ts, tested);
//   * credentials appear only as their opaque references.
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's accounts, availability, spend, executions and
// verifications are indistinguishable from missing ones (the contract's
// own uniform not-found — no existence leak).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  getAiAvailability,
  getAiProviderAccountSpend,
  getLlmTransport,
  listAiProviderAccounts,
  listLlmExecutions,
  listLlmModels,
  listLlmProviders,
  getLlmUsageSummary,
} from '@/modules/llm/contract';
import type {
  AiProviderAccount,
  AiProviderAccountSpend,
  LlmAvailability,
  LlmCapability,
  LlmExecution,
  LlmExecutionPurpose,
  LlmExecutionStatus,
  LlmModelDescriptor,
  LlmProvider,
  LlmScope,
  DataClassification,
  LlmUsageSummaryRow,
} from '@/modules/llm/contract';

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page/client; labels resolve at render)
// ---------------------------------------------------------------------------

/** How many rows each list carries (the surface stays calm). */
export const EXECUTION_ROW_LIMIT = 20;
export const HOT_SWAP_ROW_LIMIT = 12;
export const ACCOUNT_LIMIT = 100;

/** One registry model (platform reference data, verbatim from the contract). */
export interface CatalogModelRow {
  modelId: string;
  capabilities: LlmCapability[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  priceInputMinorPerMillion: number;
  priceOutputMinorPerMillion: number;
  currency: 'USD';
}

/** One provider's catalog section (alphabetical — display order is not preference). */
export interface CatalogProviderRow {
  provider: LlmProvider;
  models: CatalogModelRow[];
}

/** One (account, model) pair with its routing verdict + availability state. */
export interface AccountModelRow {
  modelId: string;
  capabilities: LlmCapability[];
  /** True when the account's own capability permissions include what the model serves. */
  accountPermits: boolean;
  /** The capabilities the account may actually use on this model (intersection). */
  usableCapabilities: LlmCapability[];
  /** The current effective availability of this (account, model) pair. */
  availability: LlmAvailability | null;
}

/** One tenant-owned provider account, composed for rendering. */
export interface AccountCard {
  id: string;
  provider: LlmProvider;
  label: string;
  status: AiProviderAccount['status'];
  scopes: LlmScope[];
  capabilities: LlmCapability[];
  maxDataClassification: DataClassification;
  priority: number;
  budgetMinor: number | null;
  budgetCurrency: 'USD';
  credentialRef: string;
  createdAt: string;
  updatedAt: string;
  /** 1-based position in the tenant's routing order (priority, then age, then id). */
  routingPosition: number;
  /** Every registry model of this account's provider, with its verdicts. */
  models: AccountModelRow[];
  /** Budget posture for the current UTC month (null when the read degraded). */
  spend: AiProviderAccountSpend | null;
  /** The most recent execution evidence timestamp for this account. */
  lastExecutionAt: string | null;
}

/** One execution evidence row (append-only; failures are evidence too). */
export interface ExecutionRow {
  id: string;
  purpose: LlmExecutionPurpose;
  capability: LlmCapability;
  provider: LlmProvider;
  model: string;
  accountId: string;
  status: LlmExecutionStatus;
  errorCode: string | null;
  latencyMs: number;
  costMinor: number;
  invokedAt: string;
}

/** The /ai page's whole view (one build, every family degraded-safe). */
export interface ByoaView {
  generatedAt: string;
  /** True when the session's authority carries 'llm:administer' (management gate). */
  canAdminister: boolean;
  /** True when a provider transport is wired in this process. */
  transportWired: boolean;
  /** The provider/model registry, alphabetically (reference data, no privilege). */
  catalog: CatalogProviderRow[];
  /** The tenant's accounts in routing order. */
  accounts: AccountCard[];
  /** Per (provider, model, capability) usage aggregates (cost + latency). */
  usage: LlmUsageSummaryRow[];
  /** Recent execution evidence, newest first. */
  executions: ExecutionRow[];
  /** Recent hot-swap verification executions, newest first. */
  hotSwapExecutions: ExecutionRow[];
  /** Which read families failed (honest degradation, never silence). */
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One bounded failed read → an empty section + a degraded note. */
async function safe<T>(
  family: string,
  degraded: string[],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

function toCatalogModel(model: LlmModelDescriptor): CatalogModelRow {
  return {
    modelId: model.modelId,
    capabilities: [...model.capabilities],
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    priceInputMinorPerMillion: model.priceInputMinorPerMillion,
    priceOutputMinorPerMillion: model.priceOutputMinorPerMillion,
    currency: model.currency,
  };
}

/** The registry catalog, ALPHABETICAL by provider (display order ≠ preference). */
function buildCatalog(): CatalogProviderRow[] {
  return listLlmProviders()
    .map((provider) => ({
      provider,
      models: listLlmModels(provider).map(toCatalogModel),
    }))
    .filter((entry) => entry.models.length > 0)
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

/** Compose one account's per-model rows: registry × account permissions × availability. */
export function accountModelRows(
  account: AiProviderAccount,
  providerModels: readonly LlmModelDescriptor[],
  availabilityByModel: ReadonlyMap<string, LlmAvailability>,
): AccountModelRow[] {
  return providerModels.map((model) => ({
    modelId: model.modelId,
    capabilities: [...model.capabilities],
    accountPermits: model.capabilities.some((capability) =>
      (account.capabilities as readonly string[]).includes(capability),
    ),
    usableCapabilities: model.capabilities.filter((capability) =>
      (account.capabilities as readonly string[]).includes(capability),
    ),
    availability: availabilityByModel.get(model.modelId) ?? null,
  }));
}

function toExecutionRow(execution: LlmExecution): ExecutionRow {
  return {
    id: execution.id,
    purpose: execution.purpose,
    capability: execution.capability,
    provider: execution.provider,
    model: execution.model,
    accountId: execution.accountId,
    status: execution.status,
    errorCode: execution.errorCode,
    latencyMs: execution.latencyMs,
    costMinor: execution.costMinor,
    invokedAt: execution.invokedAt,
  };
}

// ---------------------------------------------------------------------------
// buildByoaView
// ---------------------------------------------------------------------------

/**
 * Build the whole AI-providers view for one tenant: accounts (with
 * availability, spend and routing position), the registry catalog, usage
 * aggregates and the execution/hot-swap evidence feeds.
 */
export async function buildByoaView(ctx: TenantContext): Promise<ByoaView> {
  const degraded: string[] = [];

  const [accountsRead, usage, executions, hotSwapExecutions] = await Promise.all([
    safe('accounts', degraded, () => listAiProviderAccounts(ctx, { limit: ACCOUNT_LIMIT })),
    safe('usage', degraded, () => getLlmUsageSummary(ctx, {})),
    safe('executions', degraded, () => listLlmExecutions(ctx, { limit: EXECUTION_ROW_LIMIT })),
    safe('hot-swap', degraded, () =>
      listLlmExecutions(ctx, { purpose: 'hot-swap-verification', limit: HOT_SWAP_ROW_LIMIT }),
    ),
  ]);

  const accounts = accountsRead ?? [];
  const lastExecutionByAccount = new Map<string, string>();
  for (const execution of executions ?? []) {
    if (!lastExecutionByAccount.has(execution.accountId)) {
      lastExecutionByAccount.set(execution.accountId, execution.invokedAt);
    }
  }

  // Per-account reads (availability + spend), each degraded-safe.
  const cards: AccountCard[] = [];
  for (const account of accounts) {
    const [availability, spend] = await Promise.all([
      safe('availability', degraded, () => getAiAvailability(ctx, { accountId: account.id })),
      safe('spend', degraded, () => getAiProviderAccountSpend(ctx, { accountId: account.id })),
    ]);
    const availabilityByModel = new Map<string, LlmAvailability>();
    for (const entry of availability ?? []) {
      availabilityByModel.set(entry.model, entry);
    }
    cards.push({
      id: account.id,
      provider: account.provider,
      label: account.label,
      status: account.status,
      scopes: [...account.scopes],
      capabilities: [...account.capabilities],
      maxDataClassification: account.maxDataClassification,
      priority: account.priority,
      budgetMinor: account.budgetMinor,
      budgetCurrency: account.budgetCurrency,
      credentialRef: account.credentialRef,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      // listAiProviderAccounts already returns routing order
      // (priority, createdAt, id) — position 1 is the first-routed account.
      routingPosition: cards.length + 1,
      models: accountModelRows(account, listLlmModels(account.provider), availabilityByModel),
      spend,
      lastExecutionAt: lastExecutionByAccount.get(account.id) ?? null,
    });
  }

  return {
    generatedAt: now().toISOString(),
    canAdminister: ctx.authority.includes('llm:administer'),
    transportWired: getLlmTransport() !== null,
    catalog: buildCatalog(),
    accounts: cards,
    usage: usage ?? [],
    executions: (executions ?? []).map(toExecutionRow),
    hotSwapExecutions: (hotSwapExecutions ?? []).map(toExecutionRow),
    degraded: [...new Set(degraded)],
  };
}
