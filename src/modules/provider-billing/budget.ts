// Budget resolution + enforcement — the PURE core of the provider-billing
// budget policy (unit-testable without a database). The service loads the
// covering budget rows and the per-scope spend; this module decides.
//
// Semantics (W090 acceptance: "budget policy can block/route usage"):
//   * EVERY active budget row whose scope covers the evaluated request is
//     evaluated (tenant-wide rows always cover; narrower rows cover when
//     their gateway/provider/capability match). There is no shadowing: a
//     narrow budget does not silence a wide one — the tenant's policy is
//     the union of its rows.
//   * A covering 'block' budget that the projected cost would exceed
//     (spend + projected > budget) BLOCKS the usage. The first violation
//     (most specific scope first) names the deterministic reason.
//   * A covering 'observe' budget already exceeded by the projection is a
//     WARNING: allowed, but the posture is reported (and the service
//     records it as append-only evidence).
//
// The evaluation is a pure function of (budget rows, per-scope spend,
// request, period start): no clock reads, no LLM, no randomness — the
// deterministic discipline of the actions module's evaluateAuthorityMatrix
// (learning never silently overrides policy — lock 14 mirrored).

import type {
  BudgetEnforcement,
  BudgetEnforcementKind,
  BudgetPosture,
  BudgetScope,
  EnforceProviderBudgetInput,
  ProviderBudget,
} from './types';

/** The canonical scope-key encoding: '' | 'g' | 'g:p' | 'g:p:c'. */
export function budgetScopeKey(
  scope: BudgetScope,
  gateway: string | null,
  provider: string | null,
  capability: string | null,
): string {
  switch (scope) {
    case 'tenant':
      return '';
    case 'gateway':
      return gateway ?? '';
    case 'provider':
      return `${gateway ?? ''}:${provider ?? ''}`;
    case 'capability':
      return `${gateway ?? ''}:${provider ?? ''}:${capability ?? ''}`;
  }
}

/** Does one active budget row cover the evaluated (gateway, provider, capability)? */
export function budgetCovers(
  budget: Pick<ProviderBudget, 'scope' | 'gateway' | 'provider' | 'capability'>,
  gateway: string,
  provider: string,
  capability: string,
): boolean {
  switch (budget.scope) {
    case 'tenant':
      return true;
    case 'gateway':
      return budget.gateway === gateway;
    case 'provider':
      return budget.gateway === gateway && budget.provider === provider;
    case 'capability':
      return (
        budget.gateway === gateway &&
        budget.provider === provider &&
        budget.capability === capability
      );
  }
}

/** Scope-specificity ordering: capability > provider > gateway > tenant. */
const SCOPE_SPECIFICITY: Record<BudgetScope, number> = {
  capability: 3,
  provider: 2,
  gateway: 1,
  tenant: 0,
};

/** Sort covering budgets most-specific first (stable within a scope). */
export function bySpecificity(
  a: Pick<ProviderBudget, 'scope' | 'scopeKey'>,
  b: Pick<ProviderBudget, 'scope' | 'scopeKey'>,
): number {
  const delta = SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope];
  return delta !== 0 ? delta : (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0);
}

export interface BudgetEvaluationFacts {
  /** The tenant's ACTIVE budget rows that cover the request. */
  covering: ReadonlyArray<
    Pick<
      ProviderBudget,
      'id' | 'scope' | 'scopeKey' | 'gateway' | 'provider' | 'capability' | 'budgetMinor' | 'enforcement'
    >
  >;
  /**
   * The spend (integer minor units) already recorded this period for each
   * covering budget's OWN scope, keyed by budget id.
   */
  spendMinorByBudget: ReadonlyMap<string, number>;
  /** ISO 8601 — start of the current UTC calendar month (the period). */
  periodStart: string;
}

/** The pure enforcement evaluation. */
export function evaluateBudgetEnforcement(
  facts: BudgetEvaluationFacts,
  request: EnforceProviderBudgetInput,
): BudgetEnforcement {
  const postures: BudgetPosture[] = facts.covering
    .slice()
    .sort(bySpecificity)
    .map((budget) => {
      const spendMinor = facts.spendMinorByBudget.get(budget.id) ?? 0;
      return {
        budgetId: budget.id,
        scopeKey: budget.scopeKey,
        scope: budget.scope,
        enforcement: budget.enforcement,
        budgetMinor: budget.budgetMinor,
        currency: 'USD' as const,
        spendMinor,
        headroomMinor: budget.budgetMinor - spendMinor,
        periodStart: facts.periodStart,
      };
    });

  const violations: BudgetEnforcement['violations'] = [];
  const warnings: BudgetPosture[] = [];
  for (const posture of postures) {
    const projectedTotalMinor = posture.spendMinor + request.projectedCostMinor;
    const exceeded = projectedTotalMinor > posture.budgetMinor;
    if (!exceeded) continue;
    const entry = {
      posture,
      projectedTotalMinor,
      overageMinor: projectedTotalMinor - posture.budgetMinor,
    };
    if (posture.enforcement === 'block') violations.push(entry);
    else warnings.push(posture);
  }

  const decision: BudgetEnforcement['decision'] = violations.length > 0 ? 'block' : 'allow';
  const reason =
    violations.length === 0
      ? null
      : `budget policy blocks ${request.gateway}/${request.provider}/${request.capability}: projected ${request.projectedCostMinor} minor would exceed the '${violations[0]!.posture.scopeKey || 'tenant-wide'}' budget of ${violations[0]!.posture.budgetMinor} minor (spend ${violations[0]!.posture.spendMinor}, overage ${violations[0]!.overageMinor})`;

  return {
    decision,
    reason,
    violations,
    warnings,
    postures,
    request: {
      gateway: request.gateway,
      provider: request.provider,
      capability: request.capability,
      projectedCostMinor: request.projectedCostMinor,
    },
  };
}

/** Deterministic event kind for one enforcement outcome that bit. */
export function budgetEventKind(enforcement: BudgetEnforcement): 'blocked' | 'observed_exceeded' | null {
  if (enforcement.decision === 'block') return 'blocked';
  if (enforcement.warnings.length > 0) return 'observed_exceeded';
  return null;
}

/** The set of budget ids an enforcement outcome makes auditable. */
export function auditedBudgetIds(enforcement: BudgetEnforcement): string[] {
  if (enforcement.decision === 'block') {
    return [...enforcement.violations.map((v) => v.posture.budgetId), ...enforcement.warnings.map((w) => w.budgetId)];
  }
  return enforcement.warnings.map((w) => w.budgetId);
}

// ---------------------------------------------------------------------------
// Budget period helpers (UTC calendar months — the llm module's discipline)
// ---------------------------------------------------------------------------

/** Start of the current UTC calendar month (ISO 8601). */
export function monthStartUtcIso(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

// ---------------------------------------------------------------------------
// Enforcement-mode vocabulary guard (mirror of the CHECK constraints)
// ---------------------------------------------------------------------------

export function isBudgetEnforcementKind(value: unknown): value is BudgetEnforcementKind {
  return value === 'block' || value === 'observe';
}
