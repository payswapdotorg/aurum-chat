// Pure routing logic of the llm module (W034): eligibility, deterministic
// candidate selection and cost accounting. No database, no clock, no
// network — everything here is a total, deterministic function of its
// arguments, which is exactly what explainable routing demands (the same
// tenant account state and the same request always yield the same decision,
// with a machine-readable reason per candidate — ARCHITECTURE.md §24
// auditability).
//
// The DISTINCT concerns of ARCHITECTURE.md §18 collapse into named checks
// here, each with its own machine reason:
//   * capability        — the model must SUPPORT it and the account must
//                          PERMIT it (two different questions);
//   * policy (data)     — the account's classification ceiling;
//   * preference        — the account's priority (lower first); registry
//                          position NEVER participates (lock 30: no
//                          provider/model is architecturally privileged);
//   * availability      — per (account, model) outage state with expiry;
//   * budget            — recorded spend vs the account's monthly cap.
//
// Pinned targets (explicit account/model chosen by the caller, e.g. the
// hot-swap verification or an operator pin) are a ROUTING instruction, not
// an eligibility bypass: the pinned candidate still passes every check
// except availability — an operator pin deliberately overrides the
// availability heuristic (documented, tested), because re-running against
// a cooling-down target is sometimes exactly what an operator wants.

import type {
  AiProviderAccountStatus,
  DataClassification,
  LlmCapability,
  LlmRoutingCandidateSnapshot,
  LlmRoutingRejectionReason,
  LlmRoutingSnapshot,
  LlmScope,
} from './types';
import type { LlmModelDescriptor, LlmProvider } from './registry';

// ---------------------------------------------------------------------------
// Inputs (plain data the service assembles from tenant state)
// ---------------------------------------------------------------------------

/** The tenant-side account facts routing needs (a projection of AiProviderAccount). */
export interface AccountForRouting {
  id: string;
  provider: LlmProvider;
  status: AiProviderAccountStatus;
  scopes: readonly LlmScope[];
  capabilities: readonly LlmCapability[];
  maxDataClassification: DataClassification;
  priority: number;
  budgetMinor: number | null;
  createdAt: string;
}

/** The current availability facts for one (account, model) pair. */
export interface AvailabilityForRouting {
  state: 'available' | 'unavailable';
  /** When the unavailable state lapses; null = indefinite. */
  expiresAt: string | null;
}

export interface RouteLlmRequestInput {
  capability: LlmCapability;
  scope: LlmScope;
  dataClassification: DataClassification;
  /** The tenant's accounts (ALL of them — the snapshot must show every rejection). */
  accounts: readonly AccountForRouting[];
  /** Current availability keyed by `${accountId}:${model}`. */
  availability: ReadonlyMap<string, AvailabilityForRouting>;
  /** Recorded spend (minor units, current UTC month) keyed by account id. */
  spendMinorByAccount: ReadonlyMap<string, number>;
  /** Every registry model of a provider (keyed by provider). */
  providerModels: ReadonlyMap<LlmProvider, readonly LlmModelDescriptor[]>;
  at: Date;
  pinnedAccountId: string | null;
  pinnedModel: string | null;
  /** The caller's requested output cap; candidates whose model cannot serve it are rejected ('model_output_limit'). */
  maxOutputTokens: number | null;
}

export interface RoutingCandidate {
  accountId: string;
  provider: LlmProvider;
  model: string;
}

export interface RoutingDecision {
  /** The frozen evidence of every candidate considered and why. */
  snapshot: LlmRoutingSnapshot;
  /** Eligible candidates in deterministic routing order (best first). */
  orderedEligible: RoutingCandidate[];
}

/** Data-classification order: public < internal < restricted. */
export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  restricted: 2,
};

export function availabilityKey(accountId: string, model: string): string {
  return `${accountId}:${model}`;
}

/** Is the (account, model) pair effectively unavailable at `at`? */
export function isEffectivelyUnavailable(
  availability: AvailabilityForRouting | undefined,
  at: Date,
): boolean {
  if (availability === undefined) return false;
  if (availability.state !== 'unavailable') return false;
  if (availability.expiresAt === null) return true;
  return Date.parse(availability.expiresAt) > at.getTime();
}

// ---------------------------------------------------------------------------
// The deterministic router
// ---------------------------------------------------------------------------

/**
 * Route one canonical request over the tenant's accounts. For every
 * (account, model) pair the tenant COULD serve, the decision records an
 * eligibility verdict with a machine reason; eligible pairs are ordered by
 * (priority ASC, createdAt ASC, id ASC) — fully deterministic, no registry
 * position, no randomness, no clock (the `at` argument only evaluates
 * availability expiry).
 */
export function routeLlmRequest(input: RouteLlmRequestInput): RoutingDecision {
  const pinned = input.pinnedAccountId !== null;
  const candidates: LlmRoutingCandidateSnapshot[] = [];
  const eligible: Array<{ candidate: RoutingCandidate; account: AccountForRouting }> = [];

  for (const account of input.accounts) {
    // A pinned invocation considers only the pinned account's models (and,
    // when the model is pinned too, exactly that model).
    if (pinned && account.id !== input.pinnedAccountId) continue;

    const models = input.providerModels.get(account.provider) ?? [];
    for (const model of models) {
      // The account-side (eligibility) verdicts are identical for every
      // model of the account; recompute them per candidate so the snapshot
      // is self-contained.
      const reason = rejectionReasonFor(input, account, model);
      const snapshot: LlmRoutingCandidateSnapshot = {
        accountId: account.id,
        provider: account.provider,
        model: model.modelId,
        eligible: reason === null,
        reason,
      };
      candidates.push(snapshot);
      if (reason === null) {
        eligible.push({ candidate: snapshot, account });
      }
    }
  }

  eligible.sort((left, right) => {
    if (left.account.priority !== right.account.priority) {
      return left.account.priority - right.account.priority;
    }
    if (left.account.createdAt !== right.account.createdAt) {
      return left.account.createdAt < right.account.createdAt ? -1 : 1;
    }
    return left.candidate.accountId < right.candidate.accountId ? -1 : 1;
  });

  const orderedEligible = eligible.map((entry) => ({
    accountId: entry.candidate.accountId,
    provider: entry.candidate.provider,
    model: entry.candidate.model,
  }));

  return {
    snapshot: {
      pinned,
      candidates,
      chosen: orderedEligible[0] ?? null,
    },
    orderedEligible,
  };
}

/** The first rejection reason that applies to one (account, model) pair, or null when eligible. */
function rejectionReasonFor(
  input: RouteLlmRequestInput,
  account: AccountForRouting,
  model: LlmModelDescriptor,
): LlmRoutingRejectionReason | null {
  if (account.status !== 'active') return 'account_disabled';
  if (!(account.scopes as readonly string[]).includes(input.scope)) {
    return 'scope_not_permitted';
  }
  if (!(account.capabilities as readonly string[]).includes(input.capability)) {
    return 'capability_not_permitted';
  }
  if (CLASSIFICATION_RANK[input.dataClassification] > CLASSIFICATION_RANK[account.maxDataClassification]) {
    return 'data_classification_exceeds_account_policy';
  }
  if (account.budgetMinor !== null) {
    const spend = input.spendMinorByAccount.get(account.id) ?? 0;
    if (spend >= account.budgetMinor) return 'budget_exhausted';
  }
  if (!(model.capabilities as readonly string[]).includes(input.capability)) {
    return 'capability_not_supported_by_model';
  }
  if (
    input.capability === 'text-generation' &&
    input.maxOutputTokens !== null &&
    input.maxOutputTokens > model.maxOutputTokens
  ) {
    return 'model_output_limit';
  }
  // An explicit pin is an operator instruction: availability heuristics
  // serve AUTOMATIC routing only (documented contract behavior).
  if (input.pinnedAccountId === null) {
    if (
      isEffectivelyUnavailable(
        input.availability.get(availabilityKey(account.id, model.modelId)),
        input.at,
      )
    ) {
      return 'unavailable';
    }
  }
  if (input.pinnedModel !== null && model.modelId !== input.pinnedModel) {
    return 'not_pinned_target';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cost accounting (deterministic, integer minor units)
// ---------------------------------------------------------------------------

/**
 * The deterministic cost of one execution in integer minor units: usage ×
 * the registry model's list price per million tokens, each direction
 * rounded UP to the next minor unit (ceil) so fractional micro-minor
 * amounts never under-report spend. Failed executions carry zero cost
 * (no tokens were consumed — or none were reported).
 */
export function costMinorForUsage(
  model: LlmModelDescriptor,
  inputTokens: number,
  outputTokens: number,
): number {
  const inputCost = Math.ceil((inputTokens * model.priceInputMinorPerMillion) / 1_000_000);
  const outputCost = Math.ceil((outputTokens * model.priceOutputMinorPerMillion) / 1_000_000);
  return inputCost + outputCost;
}

/** The start of the current UTC calendar month (budget periods are UTC months). */
export function monthStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
