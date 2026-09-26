// The provider-preferences module's PURE decision core (the budget.ts
// discipline): everything here is deterministic, side-effect free and
// unit-testable without a database — no DB, no clock, no randomness.
// The service loads the routing facts and measured evidence through the
// llm / provider-billing contracts; this core decides.
//
// W091's two pure derivations:
//
//   1. PREFERENCE → ROUTING ORDER (computePreferenceOrder): the outcome
//      choice maps deterministically ONTO the existing routing facts. It
//      never re-implements routing and never privileges a provider (lock
//      30): the base order is the tenant's own current order (priority,
//      then creation time, then id — the routing engine's own tiebreak),
//      and each dimension only re-sorts that order against MEASURED
//      contract evidence. Where evidence is missing the option keeps its
//      configured place and the basis says so — ratings are never
//      invented (W091's honesty rule). Provider keys join evidence to
//      options but are never rendered: no provider name, model id,
//      capability code, scope code or classification enum value ever
//      appears in a default-surface string this core produces.
//
//   2. MACHINE REASONS → PLAIN LANGUAGE (explainRoutingSnapshot): every
//      LlmRoutingRejectionReason of the frozen routing snapshot becomes
//      one plain sentence; an unknown reason becomes an honest
//      "we cannot explain this yet" line, never an invented one.
//
// Cost evidence prefers the W090 provider-billing usage attribution
// (gateway 'llm' rows) and falls back to the llm gateway's own recorded
// usage; both sources are named in the basis (outcomes cite contracts).

import { DATA_CLASSIFICATIONS, MAX_PRIORITY } from '@/modules/llm/contract';
import type {
  DataClassification,
  LlmRoutingRejectionReason,
  LlmRoutingSnapshot,
} from '@/modules/llm/contract';
import type {
  AccountPreferenceFacts,
  PreferenceAssignment,
  PreferenceEvidence,
  PreferenceOption,
  PreferenceOrderPlan,
  ProviderPreferenceKind,
  RoutingExplanation,
  RoutingExplanationLine,
} from './types';

// ---------------------------------------------------------------------------
// The preference catalog (plain language only)
// ---------------------------------------------------------------------------

/** The selectable outcome preferences, in catalog order. */
export const PREFERENCE_OPTIONS: readonly PreferenceOption[] = [
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

/** The honest default when no choice has been saved. */
export const DEFAULT_PREFERENCE: ProviderPreferenceKind = 'balanced';

export function preferenceOption(kind: ProviderPreferenceKind): PreferenceOption {
  const found = PREFERENCE_OPTIONS.find((option) => option.kind === kind);
  if (found === undefined) {
    throw new Error(`unknown provider preference '${kind}'`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Plain-language vocabularies (NO enum tokens, NO provider/model names)
// ---------------------------------------------------------------------------

/**
 * The plain-language phrase for each data-policy ceiling. Deliberately
 * avoids the classification enum words themselves — the default surface
 * renders outcomes, not vocabulary codes.
 */
const CLASSIFICATION_PHRASES: Record<DataClassification, string> = {
  public: 'handles only genuinely shareable information',
  internal: 'handles everyday company information',
  restricted: 'may handle even your most sensitive information',
};

/** The plain-language phrase for every machine rejection reason. */
export const REJECTION_REASON_PHRASES: Record<LlmRoutingRejectionReason, string> = {
  account_disabled: 'it is switched off',
  scope_not_permitted: 'it is not allowed for this kind of work',
  capability_not_permitted: 'you have not given it permission for this kind of task',
  data_classification_exceeds_account_policy:
    'it is not within your data policy for this information',
  budget_exhausted: 'it is over budget',
  capability_not_supported_by_model: 'it cannot do this kind of task',
  model_output_limit: 'it cannot produce a reply of the requested size',
  unavailable: 'it could not be reached at that moment',
  not_pinned_target: 'a different specific option was requested for this task',
};

/** The plain name of a preference, used inside sentences. */
const PREFERENCE_NAME_PHRASES: Record<ProviderPreferenceKind, string> = {
  'privacy-first': 'privacy first',
  'lowest-cost': 'lowest cost',
  fastest: 'fastest responses',
  'most-reliable': 'reliability first',
  balanced: 'a balanced approach',
};

/** One plain sentence naming the tenant's choice (the preference line). */
export function preferenceLineFor(kind: ProviderPreferenceKind): string {
  return `Your choice: ${PREFERENCE_NAME_PHRASES[kind]} — Aurum tries the options that match it first.`;
}

/** Plain USD from integer minor units (the contracts' currency discipline). */
function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Evidence aggregation (per provider; provider keys join, never render)
// ---------------------------------------------------------------------------

/** Where a cost number came from — named in the basis (contracts cited). */
export type CostEvidenceSource = 'billing-attribution' | 'recorded-usage';

const COST_SOURCE_PHRASES: Record<CostEvidenceSource, string> = {
  'billing-attribution': 'from your billing records',
  'recorded-usage': 'from your recorded usage',
};

/** The measured evidence one provider's options carry. */
export interface ProviderMeasuredEvidence {
  cost: { avgCostMinor: number; source: CostEvidenceSource } | null;
  /** Weighted average latency (ms) over recorded executions; null = none. */
  avgLatencyMs: number | null;
  /** Completed share over recorded executions; null = no executions. */
  completionShare: number | null;
}

/**
 * Aggregate the measured evidence per provider (deterministic). Cost
 * prefers the W090 provider-billing attribution rows (gateway 'llm');
 * latency and reliability come from the llm gateway's usage aggregates.
 */
export function evidenceByProvider(
  evidence: PreferenceEvidence,
): Map<string, ProviderMeasuredEvidence> {
  const cost = new Map<string, { avgCostMinor: number; source: CostEvidenceSource }>();

  // Tier 1: W090 billing attribution (the provider-billing usage ledger).
  const billingCost = new Map<string, { cost: number; executions: number }>();
  for (const row of evidence.billing) {
    const entry = billingCost.get(row.provider) ?? { cost: 0, executions: 0 };
    entry.cost += row.costMinor;
    entry.executions += row.executions;
    billingCost.set(row.provider, entry);
  }
  for (const [provider, totals] of billingCost) {
    if (totals.executions > 0) {
      cost.set(provider, {
        avgCostMinor: Math.round(totals.cost / totals.executions),
        source: 'billing-attribution',
      });
    }
  }

  // Tier 2: the llm gateway's own recorded usage.
  const usageCost = new Map<string, { cost: number; executions: number }>();
  for (const row of evidence.usage) {
    const entry = usageCost.get(row.provider) ?? { cost: 0, executions: 0 };
    entry.cost += row.costMinor;
    entry.executions += row.executions;
    usageCost.set(row.provider, entry);
  }
  for (const [provider, totals] of usageCost) {
    if (totals.executions > 0 && !cost.has(provider)) {
      cost.set(provider, {
        avgCostMinor: Math.round(totals.cost / totals.executions),
        source: 'recorded-usage',
      });
    }
  }

  const latency = new Map<string, { total: number; executions: number }>();
  const completion = new Map<string, { completed: number; executions: number }>();
  for (const row of evidence.usage) {
    if (row.avgLatencyMs !== null && row.executions > 0) {
      const entry = latency.get(row.provider) ?? { total: 0, executions: 0 };
      entry.total += row.avgLatencyMs * row.executions;
      entry.executions += row.executions;
      latency.set(row.provider, entry);
    }
    const done = completion.get(row.provider) ?? { completed: 0, executions: 0 };
    done.completed += row.completed;
    done.executions += row.executions;
    completion.set(row.provider, done);
  }

  const providers = new Set<string>([...cost.keys(), ...latency.keys(), ...completion.keys()]);
  const out = new Map<string, ProviderMeasuredEvidence>();
  for (const provider of providers) {
    const latencyEntry = latency.get(provider);
    const completionEntry = completion.get(provider);
    out.set(provider, {
      cost: cost.get(provider) ?? null,
      avgLatencyMs:
        latencyEntry !== undefined && latencyEntry.executions > 0
          ? Math.round(latencyEntry.total / latencyEntry.executions)
          : null,
      completionShare:
        completionEntry !== undefined && completionEntry.executions > 0
          ? completionEntry.completed / completionEntry.executions
          : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The preference → routing-order mapping
// ---------------------------------------------------------------------------

/** Spacing between assigned priorities (position 1 → 10, 2 → 20, …). */
export const PRIORITY_STEP = 10;

function classificationRank(value: DataClassification): number {
  const rank = (DATA_CLASSIFICATIONS as readonly string[]).indexOf(value);
  return rank === -1 ? 0 : rank;
}

/** The tenant's own current order — the routing engine's tiebreak order. */
function baseOrder(accounts: readonly AccountPreferenceFacts[]): AccountPreferenceFacts[] {
  return [...accounts].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.accountId.localeCompare(right.accountId);
  });
}

function finishPlan(
  preference: ProviderPreferenceKind,
  ordered: readonly AccountPreferenceFacts[],
  basisByAccount: ReadonlyMap<string, { basis: string; evidenceAvailable: boolean }>,
  notes: string[],
  base: readonly AccountPreferenceFacts[],
): PreferenceOrderPlan {
  const assignments: PreferenceAssignment[] = ordered.map((account, index) => {
    const basis = basisByAccount.get(account.accountId);
    return {
      accountId: account.accountId,
      position: index + 1,
      assignedPriority: Math.min(MAX_PRIORITY, (index + 1) * PRIORITY_STEP),
      basis: basis?.basis ?? 'kept its configured place',
      evidenceAvailable: basis?.evidenceAvailable ?? false,
    };
  });

  const changed =
    assignments.length !== base.length ||
    assignments.some((assignment, index) => assignment.accountId !== base[index]!.accountId);

  return { preference, assignments, notes, changed };
}

/**
 * Compute the deterministic order a preference implies for the tenant's
 * AI options. Pure: same facts + same evidence → the same plan, always.
 *
 * Evidence rules (W091 honesty):
 *   * privacy-first — needs no measurement: re-sorts by the data-policy
 *     ceiling (most restrictive first) using only contract facts;
 *   * balanced — keeps the organization's configured order exactly and
 *     writes nothing;
 *   * lowest-cost / fastest / most-reliable — re-sort ONLY the options
 *     with measured evidence (cost prefers the W090 attribution); an
 *     option without evidence keeps its configured relative place after
 *     the evidenced ones, and the notes say so plainly. `provider` on the
 *     facts is a pure evidence-join key — it is never rendered.
 */
export function computePreferenceOrder(
  preference: ProviderPreferenceKind,
  accounts: readonly AccountPreferenceFacts[],
  evidence: PreferenceEvidence,
): PreferenceOrderPlan {
  const base = baseOrder(accounts);
  const notes: string[] = [];
  const basisByAccount = new Map<string, { basis: string; evidenceAvailable: boolean }>();

  if (preference === 'balanced') {
    for (const account of base) {
      basisByAccount.set(account.accountId, {
        basis: 'your organization’s configured order (administrator-set)',
        evidenceAvailable: true,
      });
    }
    notes.push(
      'Balanced keeps the order your administrators configured — your organization’s settings are the policy, and nothing is rewritten.',
    );
    return finishPlan(preference, base, basisByAccount, notes, base);
  }

  if (preference === 'privacy-first') {
    const ordered = [...base].sort((left, right) => {
      const leftRank = classificationRank(left.maxDataClassification);
      const rightRank = classificationRank(right.maxDataClassification);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return 0; // stable — the tenant's own order breaks ties
    });
    for (const account of ordered) {
      basisByAccount.set(account.accountId, {
        basis: `privacy: ${CLASSIFICATION_PHRASES[account.maxDataClassification]}`,
        evidenceAvailable: true,
      });
    }
    notes.push(
      'Options are ordered most privacy-restrictive first — the ones allowed to handle the least sensitive information are tried first.',
    );
    return finishPlan(preference, ordered, basisByAccount, notes, base);
  }

  // Measured dimensions: lowest-cost / fastest / most-reliable.
  const byProvider = evidenceByProvider(evidence);
  const keyOf = (account: AccountPreferenceFacts): number | null => {
    const measured = byProvider.get(account.provider);
    if (measured === undefined) return null;
    if (preference === 'lowest-cost') return measured.cost?.avgCostMinor ?? null;
    if (preference === 'fastest') return measured.avgLatencyMs;
    return measured.completionShare;
  };

  const evidenced: AccountPreferenceFacts[] = [];
  const unevidenced: AccountPreferenceFacts[] = [];
  for (const account of base) {
    if (keyOf(account) === null) unevidenced.push(account);
    else evidenced.push(account);
  }

  // Stable re-sort of the evidenced block by the measured key (lower is
  // better for cost and latency; higher is better for reliability).
  evidenced.sort((left, right) => {
    const leftKey = keyOf(left)!;
    const rightKey = keyOf(right)!;
    if (leftKey !== rightKey) {
      return preference === 'most-reliable' ? rightKey - leftKey : leftKey - rightKey;
    }
    return 0;
  });
  const ordered = [...evidenced, ...unevidenced];

  for (const account of ordered) {
    const measured = byProvider.get(account.provider);
    const hasEvidence = keyOf(account) !== null;
    if (!hasEvidence) {
      basisByAccount.set(account.accountId, {
        basis:
          preference === 'lowest-cost'
            ? 'no cost evidence recorded yet — kept its configured place'
            : preference === 'fastest'
              ? 'no response times recorded yet — kept its configured place'
              : 'no completion record yet — kept its configured place',
        evidenceAvailable: false,
      });
      continue;
    }
    if (preference === 'lowest-cost') {
      basisByAccount.set(account.accountId, {
        basis: `cost: about ${usd(measured!.cost!.avgCostMinor)} per recorded task (${COST_SOURCE_PHRASES[measured!.cost!.source]})`,
        evidenceAvailable: true,
      });
    } else if (preference === 'fastest') {
      basisByAccount.set(account.accountId, {
        basis: `speed: about ${String(measured!.avgLatencyMs)} ms per recorded task`,
        evidenceAvailable: true,
      });
    } else {
      const share = Math.round(measured!.completionShare! * 100);
      basisByAccount.set(account.accountId, {
        basis: `reliability: ${String(share)}% of recorded tasks completed`,
        evidenceAvailable: true,
      });
    }
  }

  if (unevidenced.length > 0) {
    notes.push(
      unevidenced.length === 1
        ? 'One option has no recorded evidence for this choice yet — its place stays as configured.'
        : `${String(unevidenced.length)} options have no recorded evidence for this choice yet — their places stay as configured.`,
    );
    notes.push('Places come from your own recorded usage — never from guessed ratings.');
  }

  return finishPlan(preference, ordered, basisByAccount, notes, base);
}

// ---------------------------------------------------------------------------
// The machine-reason → plain-language explanation
// ---------------------------------------------------------------------------

/**
 * Render one frozen routing snapshot into plain language: one line for
 * the chosen candidate (if any) and one line per candidate that was not
 * chosen. Unknown machine reasons become honest "unexplained" lines —
 * never invented text. No provider/model names, no machine codes.
 */
export function explainRoutingSnapshot(routing: LlmRoutingSnapshot): RoutingExplanation {
  const chosen = routing.chosen;
  const chosenLine: RoutingExplanationLine | null =
    chosen === null
      ? null
      : {
          kind: 'chosen',
          text: routing.pinned
            ? 'Used: a specific option was requested for this task, and it passed every check.'
            : 'Used: it passed every check and came first under your choice of what matters.',
        };

  const rejected: RoutingExplanationLine[] = [];
  const unexplained: RoutingExplanationLine[] = [];

  for (const candidate of routing.candidates) {
    const isChosen =
      chosen !== null &&
      candidate.accountId === chosen.accountId &&
      candidate.model === chosen.model;
    if (isChosen) continue;

    if (candidate.eligible) {
      rejected.push({
        kind: 'rejected',
        text: 'Not used: it passed every check but was tried after the chosen option (your order of what matters).',
      });
      continue;
    }

    const phrase =
      candidate.reason === null || candidate.reason === undefined
        ? undefined
        : REJECTION_REASON_PHRASES[candidate.reason as LlmRoutingRejectionReason];
    if (phrase !== undefined) {
      rejected.push({ kind: 'rejected', text: `Not used: ${phrase}.` });
    } else {
      unexplained.push({
        kind: 'unexplained',
        text: 'Not used: we cannot explain this one in plain language yet — the recorded reason is not one our explanations cover.',
      });
    }
  }

  return { pinned: routing.pinned, chosen: chosenLine, rejected, unexplained };
}

/** Every explanation line of a snapshot, in reading order (chosen first). */
export function allExplanationLines(explanation: RoutingExplanation): RoutingExplanationLine[] {
  const lines: RoutingExplanationLine[] = [];
  if (explanation.chosen !== null) lines.push(explanation.chosen);
  lines.push(...explanation.rejected);
  lines.push(...explanation.unexplained);
  return lines;
}
