// Unit tests for the provider-billing module's PURE logic — the budget
// resolution/enforcement core and the input validators (no database, no
// clock, no adapters). The deterministic-evaluation discipline is the
// acceptance core of "budget policy can block/route usage": the decision
// must be a pure function of (budget rows, per-scope spend, request,
// period).

import { describe, expect, it } from 'vitest';
import {
  auditedBudgetIds,
  budgetCovers,
  budgetEventKind,
  budgetScopeKey,
  bySpecificity,
  evaluateBudgetEnforcement,
  isBudgetEnforcementKind,
  monthStartUtcIso,
  type BudgetEvaluationFacts,
} from '../budget';
import { ProviderBillingError } from '../errors';
import {
  isBudgetScope,
  isPaymentArrangementKind,
  isPaymentArrangementStatus,
  isUuid,
  validateEnforceBudgetInput,
  validateRecordUsageInput,
  validateRegisterArrangementInput,
  validateRouteCandidates,
  validateSetBudgetInput,
  validateSettleInput,
  validateSettlementRunInput,
} from '../validation';
import type { EnforceProviderBudgetInput, ProviderBudget } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type BudgetLike = Pick<
  ProviderBudget,
  'id' | 'scope' | 'scopeKey' | 'gateway' | 'provider' | 'capability' | 'budgetMinor' | 'enforcement'
>;

function budget(overrides: Partial<BudgetLike> & Pick<BudgetLike, 'id' | 'scope'>): BudgetLike {
  return {
    scopeKey: '',
    gateway: null,
    provider: null,
    capability: null,
    budgetMinor: 10_000,
    enforcement: 'block',
    ...overrides,
  } as BudgetLike;
}

function facts(
  covering: BudgetLike[],
  spendMinorByBudget: Record<string, number>,
  periodStart = '2026-10-01T00:00:00.000Z',
): BudgetEvaluationFacts {
  return {
    covering,
    spendMinorByBudget: new Map(Object.entries(spendMinorByBudget)),
    periodStart,
  };
}

const REQUEST: EnforceProviderBudgetInput = {
  gateway: 'llm',
  provider: 'openai',
  capability: 'text-generation',
  projectedCostMinor: 100,
};

function expectInvalidInput(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected ProviderBillingError(invalid_input) but the call succeeded');
  } catch (error) {
    if (!(error instanceof ProviderBillingError)) throw error;
    expect(error.code).toBe('invalid_input');
  }
}

// ---------------------------------------------------------------------------
// Scope keys, coverage and specificity
// ---------------------------------------------------------------------------

describe('provider-billing unit — scope keys, coverage, specificity', () => {
  it('encodes the four budget scopes canonically', () => {
    expect(budgetScopeKey('tenant', null, null, null)).toBe('');
    expect(budgetScopeKey('gateway', 'llm', null, null)).toBe('llm');
    expect(budgetScopeKey('provider', 'llm', 'openai', null)).toBe('llm:openai');
    expect(budgetScopeKey('capability', 'llm', 'openai', 'text-generation')).toBe(
      'llm:openai:text-generation',
    );
  });

  it('coverage follows the scope hierarchy exactly', () => {
    const tenant = budget({ id: 'b-tenant', scope: 'tenant' });
    const gateway = budget({ id: 'b-gw', scope: 'gateway', gateway: 'llm' });
    const otherGateway = budget({ id: 'b-ogw', scope: 'gateway', gateway: 'agents' });
    const provider = budget({ id: 'b-prov', scope: 'provider', gateway: 'llm', provider: 'openai' });
    const otherProvider = budget({ id: 'b-oprov', scope: 'provider', gateway: 'llm', provider: 'anthropic' });
    const capability = budget({
      id: 'b-cap',
      scope: 'capability',
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
    });
    const otherCapability = budget({
      id: 'b-ocap',
      scope: 'capability',
      gateway: 'llm',
      provider: 'openai',
      capability: 'embedding',
    });

    const all = [tenant, gateway, otherGateway, provider, otherProvider, capability, otherCapability];
    const covering = all.filter((row) =>
      budgetCovers(row, 'llm', 'openai', 'text-generation'),
    );
    expect(covering.map((row) => row.id)).toEqual(['b-tenant', 'b-gw', 'b-prov', 'b-cap']);
  });

  it('sorts covering budgets most-specific first', () => {
    const rows = [
      budget({ id: 'b-tenant', scope: 'tenant' }),
      budget({ id: 'b-cap', scope: 'capability', scopeKey: 'llm:openai:text-generation', gateway: 'llm', provider: 'openai', capability: 'text-generation' }),
      budget({ id: 'b-gw', scope: 'gateway', scopeKey: 'llm', gateway: 'llm' }),
      budget({ id: 'b-prov', scope: 'provider', scopeKey: 'llm:openai', gateway: 'llm', provider: 'openai' }),
    ];
    expect([...rows].sort(bySpecificity).map((row) => row.id)).toEqual([
      'b-cap',
      'b-prov',
      'b-gw',
      'b-tenant',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The pure enforcement evaluation
// ---------------------------------------------------------------------------

describe('provider-billing unit — the pure enforcement evaluation', () => {
  it('allows when no covering budget is exceeded', () => {
    const enforcement = evaluateBudgetEnforcement(
      facts([budget({ id: 'b-tenant', scope: 'tenant' })], { 'b-tenant': 5_000 }),
      REQUEST,
    );
    expect(enforcement.decision).toBe('allow');
    expect(enforcement.reason).toBeNull();
    expect(enforcement.violations).toEqual([]);
    expect(enforcement.warnings).toEqual([]);
    expect(enforcement.postures).toHaveLength(1);
    expect(enforcement.postures[0]!.headroomMinor).toBe(5_000);
  });

  it('blocks when a covering block budget would be exceeded, naming the tightest reason', () => {
    const enforcement = evaluateBudgetEnforcement(
      facts(
        [
          budget({ id: 'b-tenant', scope: 'tenant', budgetMinor: 100_000 }),
          budget({ id: 'b-prov', scope: 'provider', scopeKey: 'llm:openai', gateway: 'llm', provider: 'openai', budgetMinor: 5_050 }),
        ],
        { 'b-tenant': 0, 'b-prov': 5_000 },
      ),
      REQUEST,
    );
    expect(enforcement.decision).toBe('block');
    expect(enforcement.reason).toContain('llm/openai/text-generation');
    expect(enforcement.reason).toContain("'llm:openai'");
    expect(enforcement.reason).toContain('overage 50');
    expect(enforcement.violations).toHaveLength(1);
    expect(enforcement.violations[0]!.posture.budgetId).toBe('b-prov');
    expect(enforcement.violations[0]!.projectedTotalMinor).toBe(5_100);
    expect(enforcement.violations[0]!.overageMinor).toBe(50);
    expect(enforcement.warnings).toEqual([]);
  });

  it('does not shadow: a wide block budget bites even when a narrow one is fine', () => {
    const enforcement = evaluateBudgetEnforcement(
      facts(
        [
          budget({ id: 'b-tenant', scope: 'tenant', budgetMinor: 5_050 }),
          budget({ id: 'b-cap', scope: 'capability', scopeKey: 'llm:openai:text-generation', gateway: 'llm', provider: 'openai', capability: 'text-generation', budgetMinor: 1_000_000 }),
        ],
        { 'b-tenant': 5_000, 'b-cap': 0 },
      ),
      REQUEST,
    );
    expect(enforcement.decision).toBe('block');
    expect(enforcement.violations[0]!.posture.budgetId).toBe('b-tenant');
  });

  it('an exceeded observe budget warns but allows; block and observe combine', () => {
    const warningOnly = evaluateBudgetEnforcement(
      facts([budget({ id: 'b-obs', scope: 'tenant', enforcement: 'observe', budgetMinor: 4_000 })], { 'b-obs': 5_000 }),
      REQUEST,
    );
    expect(warningOnly.decision).toBe('allow');
    expect(warningOnly.warnings).toHaveLength(1);
    expect(warningOnly.warnings[0]!.headroomMinor).toBe(-1_000);
    expect(budgetEventKind(warningOnly)).toBe('observed_exceeded');

    const combined = evaluateBudgetEnforcement(
      facts(
        [
          budget({ id: 'b-block', scope: 'provider', scopeKey: 'llm:openai', gateway: 'llm', provider: 'openai', budgetMinor: 4_000 }),
          budget({ id: 'b-obs', scope: 'tenant', enforcement: 'observe', budgetMinor: 4_000 }),
        ],
        { 'b-block': 5_000, 'b-obs': 5_000 },
      ),
      REQUEST,
    );
    expect(combined.decision).toBe('block');
    expect(combined.violations.map((v) => v.posture.budgetId)).toEqual(['b-block']);
    expect(combined.warnings.map((w) => w.budgetId)).toEqual(['b-obs']);
    expect(auditedBudgetIds(combined).sort()).toEqual(['b-block', 'b-obs']);
  });

  it('an exactly-reached budget allows (exceed means strictly over)', () => {
    const enforcement = evaluateBudgetEnforcement(
      facts([budget({ id: 'b-exact', scope: 'tenant', budgetMinor: 5_100 })], { 'b-exact': 5_000 }),
      REQUEST,
    );
    expect(enforcement.decision).toBe('allow');
    expect(budgetEventKind(enforcement)).toBeNull();
    expect(auditedBudgetIds(enforcement)).toEqual([]);
  });

  it('carries the request and period verbatim', () => {
    const enforcement = evaluateBudgetEnforcement(facts([], {}), REQUEST);
    expect(enforcement.request).toEqual(REQUEST);
    expect(enforcement.postures).toEqual([]);
    expect(enforcement.decision).toBe('allow');
  });

  it('monthStartUtcIso anchors UTC calendar months', () => {
    expect(monthStartUtcIso(new Date('2026-10-17T23:59:59.999Z'))).toBe('2026-10-01T00:00:00.000Z');
    expect(monthStartUtcIso(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(monthStartUtcIso(new Date('2026-12-31T12:00:00Z'))).toBe('2026-12-01T00:00:00.000Z');
  });

  it('guards the enforcement-mode vocabulary', () => {
    expect(isBudgetEnforcementKind('block')).toBe(true);
    expect(isBudgetEnforcementKind('observe')).toBe(true);
    expect(isBudgetEnforcementKind('warn')).toBe(false);
    expect(isBudgetEnforcementKind(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe('provider-billing unit — validators', () => {
  it('validates payment arrangement shapes', () => {
    expect(
      validateRegisterArrangementInput({
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'aurum-mediated',
        settlementAdapterKey: 'platform-account',
      }),
    ).toMatchObject({ arrangement: 'aurum-mediated', settlementAdapterKey: 'platform-account' });
    expect(
      validateRegisterArrangementInput({
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'direct-customer',
        directBillingNote: 'This provider bills your company directly.',
      }),
    ).toMatchObject({ arrangement: 'direct-customer', settlementAdapterKey: null });

    expectInvalidInput(() =>
      validateRegisterArrangementInput({ gateway: 'llm', provider: 'openai', arrangement: 'aurum-mediated' }),
    );
    expectInvalidInput(() =>
      validateRegisterArrangementInput({
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'aurum-mediated',
        settlementAdapterKey: 'platform-account',
        directBillingNote: 'nope',
      }),
    );
    expectInvalidInput(() =>
      validateRegisterArrangementInput({
        gateway: 'llm',
        provider: 'openai',
        arrangement: 'direct-customer',
        settlementAdapterKey: 'platform-account',
        directBillingNote: 'billed directly',
      }),
    );
    expectInvalidInput(() =>
      validateRegisterArrangementInput({ gateway: 'LLM', provider: 'openai', arrangement: 'aurum-mediated', settlementAdapterKey: 'x' }),
    );
    expect(isPaymentArrangementKind('aurum-mediated')).toBe(true);
    expect(isPaymentArrangementKind('managed')).toBe(false);
    expect(isPaymentArrangementStatus('active')).toBe(true);
    expect(isPaymentArrangementStatus('deleted')).toBe(false);
  });

  it('validates usage recording shapes', () => {
    const valid = validateRecordUsageInput({
      gateway: 'llm',
      provider: 'openai',
      capability: 'text-generation',
      executionRef: 'exec-1',
      accountRef: 'acct-1',
      costMinor: 1234,
      quantity: 900,
      unit: 'tokens',
      dedupeKey: 'k1',
      occurredAt: '2026-10-05T10:00:00Z',
    });
    expect(valid.costMinor).toBe(1234);
    expect(valid.source).toBe('gateway');
    expect(validateRecordUsageInput({ gateway: 'llm', provider: 'openai', capability: 'c', costMinor: 0, dedupeKey: 'k' }).source).toBe('gateway');

    expectInvalidInput(() =>
      validateRecordUsageInput({ gateway: 'llm', provider: 'openai', capability: 'c', costMinor: -1, dedupeKey: 'k' }),
    );
    expectInvalidInput(() =>
      validateRecordUsageInput({ gateway: 'llm', provider: 'openai', capability: 'c', costMinor: 1.5, dedupeKey: 'k' }),
    );
    expectInvalidInput(() =>
      validateRecordUsageInput({ gateway: 'llm', provider: 'openai', capability: 'c', costMinor: 1, dedupeKey: '' }),
    );
    expectInvalidInput(() =>
      validateRecordUsageInput({ gateway: 'llm', provider: 'openai', capability: 'c', costMinor: 1, dedupeKey: 'k', occurredAt: '2026-10-05' }),
    );
  });

  it('validates budget shapes (scope-shape consistency)', () => {
    expect(
      validateSetBudgetInput({ scope: 'tenant', budgetMinor: 1000, enforcement: 'block' }),
    ).toMatchObject({ scope: 'tenant', gateway: null });
    expect(
      validateSetBudgetInput({ scope: 'capability', gateway: 'llm', provider: 'openai', capability: 'text-generation', budgetMinor: 1000, enforcement: 'observe', note: 'watch embeddings' }),
    ).toMatchObject({ scope: 'capability', capability: 'text-generation', note: 'watch embeddings' });

    expectInvalidInput(() => validateSetBudgetInput({ scope: 'tenant', gateway: 'llm', budgetMinor: 1, enforcement: 'block' }));
    expectInvalidInput(() => validateSetBudgetInput({ scope: 'gateway', budgetMinor: 1, enforcement: 'block' }));
    expectInvalidInput(() => validateSetBudgetInput({ scope: 'provider', gateway: 'llm', budgetMinor: 1, enforcement: 'block' }));
    expectInvalidInput(() => validateSetBudgetInput({ scope: 'capability', gateway: 'llm', provider: 'openai', budgetMinor: 1, enforcement: 'block' }));
    expectInvalidInput(() => validateSetBudgetInput({ scope: 'zone', budgetMinor: 1, enforcement: 'block' }));
    expectInvalidInput(() => validateSetBudgetInput({ scope: 'tenant', budgetMinor: -5, enforcement: 'block' }));
    expectInvalidInput(() => validateSetBudgetInput({ scope: 'tenant', budgetMinor: 5, enforcement: 'maybe' }));
    expect(isBudgetScope('tenant')).toBe(true);
    expect(isBudgetScope('org')).toBe(false);
  });

  it('validates enforcement and routing inputs', () => {
    expect(
      validateEnforceBudgetInput({ gateway: 'llm', provider: 'openai', capability: 'text-generation', projectedCostMinor: 10 }),
    ).toMatchObject({ projectedCostMinor: 10 });
    expectInvalidInput(() =>
      validateEnforceBudgetInput({ gateway: 'llm', provider: 'openai', capability: 'c', projectedCostMinor: -1 }),
    );

    const candidates = validateRouteCandidates([
      { gateway: 'llm', provider: 'openai', capability: 'text-generation', projectedCostMinor: 1 },
      { gateway: 'llm', provider: 'anthropic', capability: 'text-generation', projectedCostMinor: 2 },
    ]);
    expect(candidates).toHaveLength(2);
    expectInvalidInput(() => validateRouteCandidates([]));
    expectInvalidInput(() =>
      validateRouteCandidates([
        { gateway: 'llm', provider: 'openai', capability: 'text-generation', projectedCostMinor: 1 },
        { gateway: 'llm', provider: 'openai', capability: 'text-generation', projectedCostMinor: 1 },
      ]),
    );
  });

  it('validates settlement windows and run inputs', () => {
    const valid = validateSettleInput({
      gateway: 'llm',
      provider: 'openai',
      windowFrom: '2026-10-01T00:00:00Z',
      windowTo: '2026-11-01T00:00:00Z',
    });
    expect(valid.windowFrom).toBe('2026-10-01T00:00:00Z');
    expect(valid.idempotencyKey).toBeNull();

    expectInvalidInput(() =>
      validateSettleInput({ gateway: 'llm', provider: 'openai', windowFrom: '2026-11-01T00:00:00Z', windowTo: '2026-10-01T00:00:00Z' }),
    );
    expectInvalidInput(() =>
      validateSettleInput({ gateway: 'llm', provider: 'openai', windowFrom: '2026-10-01T00:00:00Z', windowTo: '2028-01-01T00:00:00Z' }),
    );

    const run = validateSettlementRunInput({
      windows: [
        { gateway: 'llm', provider: 'openai', windowFrom: '2026-10-01T00:00:00Z', windowTo: '2026-11-01T00:00:00Z' },
      ],
    });
    expect(run.windows).toHaveLength(1);
    expectInvalidInput(() => validateSettlementRunInput({ windows: [] }));
    expectInvalidInput(() =>
      validateSettlementRunInput({ windows: [{ gateway: 'llm', provider: 'openai', windowFrom: '2026-11-01T00:00:00Z', windowTo: '2026-10-01T00:00:00Z' }] }),
    );
  });

  it('guards uuids', () => {
    expect(isUuid('6f9619ff-8b86-d011-b42d-00c04fc964ff')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
