// Unit tests for the rewards module's pure validation and policy logic
// (no database). Covers every guard a caller crosses before storage, the
// deterministic §8 conversion, and W043's structural separation from
// compensation/performance:
//
//  * tenant-context shape (invalid_context);
//  * policy-input validation — qualifying statuses (vocabulary,
//    non-empty, duplicates), [0,1] scores everywhere, integer amounts and
//    the saturation ≥ 1 rule, the closed non-compensation reward-kind
//    vocabulary (compensation shapes rejected with a pointed message),
//    tier floors (distinct, order-independent input normalized
//    ascending), distinct tier names, currency shape, note bounds,
//    unknown-key rejection including the system-minted fields (version,
//    updatedByPrincipal, timestamps);
//  * apply-input validation — contribution anchor kinds, uuid ids/labels,
//    the contributor required-for-knowledge-contribution /
//    forbidden-for-acquisition-plan rule, the missionId pairing rule, the
//    §8 value shape (status vocabulary, [0,1] knowledge gain, impact
//    vocabulary, ≤ 16 goal refs with uuid ids, integer minor-unit cost,
//    currency shape), actor traceability, rationale bounds, unknown-key
//    rejection including every system-minted field (status, tier, amount,
//    actionRequestId, budgetRemainingBefore, appliedByPrincipal,
//    recordedAt);
//  * settlement/query input validation;
//  * THE CONVERSION (evaluateRewardPolicy) — the currency guard, the
//    fixed-order eligibility gates (status → knowledge gain → goal
//    impact), the three §8 factors (knowledge gain as-is, impact-kind
//    weight, cost avoided linear against saturation capped at 1), the
//    saturated 6-decimal composite score, the highest-matching-floor tier
//    selection, the no-reward reasons, and full determinism (same policy
//    + same value ⇒ deep-equal assessment; value changes move the tier);
//  * status derivations — request-status/outcome ⇒ minted status,
//    settlement-wins derivation;
//  * COMPENSATION SEPARATION — REWARD_KINDS is disjoint from
//    COMPENSATION_EXCLUDED_KINDS and contains no compensation/performance
//    shape; the reward vocabulary is closed.
//
// The service-level checks (mission budget, authority gate, settlement
// consumption, tenancy, append-only storage) need the database and are
// covered by the service tests.

import { describe, expect, it } from 'vitest';
import { RewardsError } from '../errors';
import type {
  ApplyRewardPolicyInput,
  RewardPolicy,
  RewardPolicyAssessment,
  RewardTier,
  SetRewardPolicyInput,
} from '../types';
import {
  COMPENSATION_EXCLUDED_KINDS,
  REWARD_KINDS,
  assertRewardsTenantContext,
  derivedRewardStatus,
  evaluateRewardPolicy,
  isContributionRefKind,
  isContributionStatus,
  isMissionImpactKind,
  isRewardKind,
  isRewardStatus,
  isSettlementDecision,
  isUuid,
  mintedStatusForOutcome,
  mintedStatusForRequestStatus,
  snapshotPolicy,
  validateApplyRewardPolicyInput,
  validateListRewardsQuery,
  validateSetRewardPolicyInput,
  validateSettleRewardInput,
  validateSummarizeRewardsQuery,
  type ValidatedContributionValue,
} from '../validation';

const TENANT_ID = '7c9e1d3a-5f4b-4c8e-9a2d-6b7c8d9e0f1a';
const PRINCIPAL_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const PERSON_ID = '5a7d3e9f-6b1c-4d2a-8e4b-3f5c7d9e1a2b';
const PLAN_ID = '8d0f2e4b-6a5c-4d9f-8b3e-7c8d9e0f1a2b';
const CONTRIBUTION_ID = '9e1d3a5f-7c4b-4e8a-9b2d-6f8c0d2e4a6b';
const MISSION_ID = '1a3c5e7f-9b1d-4f6a-8c2e-0d4b6a8c0e2f';
const GOAL_ID = '2b4d6f8a-0c2e-4a6c-8e0a-2d5f7b9d1c3e';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tiers(): RewardTier[] {
  return [
    { name: 'thank-you', minValueScore: 0.25, kind: 'recognition', amount: 0 },
    { name: 'thank-you-gift', minValueScore: 0.5, kind: 'gift', amount: 50_00 },
    { name: 'valued-contributor', minValueScore: 0.75, kind: 'voucher', amount: 150_00 },
  ];
}

/** A full stored-shape policy (the shape the service loads from storage). */
function policy(overrides: Partial<RewardPolicy> = {}): RewardPolicy {
  return {
    version: 3,
    qualifyingStatuses: ['validated', 'measured'],
    minKnowledgeGain: 0,
    minAffectedGoals: 0,
    weights: { knowledgeGain: 0.4, missionImpact: 0.4, costAvoided: 0.2 },
    impactKindWeights: { advanced: 0.6, resolved: 1, no_effect: 0 },
    costAvoidedSaturation: 500_00,
    tiers: tiers(),
    rewardCurrency: 'EUR',
    note: null,
    updatedByPrincipal: PRINCIPAL_ID,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

function value(overrides: Partial<ValidatedContributionValue> = {}): ValidatedContributionValue {
  return {
    status: 'measured',
    knowledgeGain: 0.4,
    missionImpact: 'resolved',
    affectedGoals: [{ goalId: GOAL_ID, label: 'Churn goal' }],
    costAvoided: { amount: 250_00, currency: 'EUR' },
    ...overrides,
  };
}

function policyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tiers: tiers(),
    rewardCurrency: 'EUR',
    ...overrides,
  };
}

function applyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contribution: {
      kind: 'knowledge-contribution',
      id: CONTRIBUTION_ID,
      contributor: { personId: PERSON_ID, label: 'Ada Lovelace' },
    },
    missionId: MISSION_ID,
    value: {
      status: 'measured',
      knowledgeGain: 0.4,
      missionImpact: 'resolved',
      affectedGoals: [{ goalId: GOAL_ID }],
      costAvoided: { amount: 250_00, currency: 'EUR' },
    },
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'mission resolved by this answer',
    ...overrides,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(RewardsError);
    expect((error as RewardsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

describe('assertRewardsTenantContext', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertRewardsTenantContext({ tenantId: TENANT_ID, principalId: PRINCIPAL_ID, authority: [] }),
    ).not.toThrow();
  });

  it('rejects a missing tenant, principal and non-array authority uniformly', () => {
    expectCode('invalid_context', () =>
      assertRewardsTenantContext({ tenantId: '', principalId: PRINCIPAL_ID, authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertRewardsTenantContext({ tenantId: TENANT_ID, principalId: '  ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertRewardsTenantContext({
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        authority: 'admin',
      } as unknown as Parameters<typeof assertRewardsTenantContext>[0]),
    );
  });
});

// ---------------------------------------------------------------------------
// Vocabularies + the compensation separation (structural)
// ---------------------------------------------------------------------------

describe('reward vocabularies', () => {
  it('REWARD_KINDS is closed and disjoint from every compensation/performance shape', () => {
    // §8: "Rewards must never silently become compensation decisions or
    // performance ratings." The vocabulary is the structural enforcement.
    for (const excluded of COMPENSATION_EXCLUDED_KINDS) {
      expect(REWARD_KINDS).not.toContain(excluded);
      expect(isRewardKind(excluded)).toBe(false);
    }
    expect([...REWARD_KINDS]).toEqual(['recognition', 'gift', 'voucher', 'experience', 'donation']);
  });

  it('guards the contribution-status, impact, ref-kind, status and settlement vocabularies', () => {
    expect(isContributionStatus('measured')).toBe(true);
    expect(isContributionStatus('bonus')).toBe(false);
    expect(isMissionImpactKind('resolved')).toBe(true);
    expect(isMissionImpactKind('huge')).toBe(false);
    expect(isContributionRefKind('acquisition-plan')).toBe(true);
    expect(isContributionRefKind('github-issue')).toBe(false);
    expect(isRewardStatus('proposed')).toBe(true);
    expect(isRewardStatus('paid')).toBe(false);
    expect(isSettlementDecision('granted')).toBe(true);
    expect(isSettlementDecision('maybe')).toBe(false);
    expect(isUuid(CONTRIBUTION_ID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy input validation
// ---------------------------------------------------------------------------

describe('validateSetRewardPolicyInput', () => {
  it('normalizes a full policy input (defaults, ascending tiers)', () => {
    const valid = validateSetRewardPolicyInput(
      policyInput({
        tiers: [tiers()[2]!, tiers()[0]!, tiers()[1]!], // deliberately unsorted
      }) as unknown as SetRewardPolicyInput,
    );
    expect(valid.qualifyingStatuses).toEqual(['validated', 'measured']);
    expect(valid.minKnowledgeGain).toBe(0);
    expect(valid.minAffectedGoals).toBe(0);
    expect(valid.weights).toEqual({ knowledgeGain: 0.4, missionImpact: 0.4, costAvoided: 0.2 });
    expect(valid.impactKindWeights).toEqual({ advanced: 0.6, resolved: 1, no_effect: 0 });
    expect(valid.costAvoidedSaturation).toBe(500_00);
    expect(valid.tiers.map((tier) => tier.minValueScore)).toEqual([0.25, 0.5, 0.75]);
    expect(valid.rewardCurrency).toBe('EUR');
    expect(valid.note).toBeNull();
  });

  it('rejects system-minted and unknown fields — a caller cannot smuggle a version', () => {
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ version: 42 }) as unknown as SetRewardPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ updatedByPrincipal: 'whoever' }) as unknown as SetRewardPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ createdAt: '2026-09-17T00:00:00Z' }) as unknown as SetRewardPolicyInput),
    );
  });

  it('rejects compensation-shaped reward kinds with a pointed message', () => {
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({
          tiers: [{ name: 'raise', minValueScore: 0.5, kind: 'salary', amount: 500_00 }],
        }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({
          tiers: [{ name: 'merit', minValueScore: 0.5, kind: 'performance-rating', amount: 0 }],
        }) as unknown as SetRewardPolicyInput,
      ),
    );
  });

  it('rejects empty/duplicate/oversized tier sets, duplicate floors and duplicate names', () => {
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ tiers: [] }) as unknown as SetRewardPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({
          tiers: [
            { name: 'a', minValueScore: 0.5, kind: 'gift', amount: 10_00 },
            { name: 'b', minValueScore: 0.5, kind: 'voucher', amount: 20_00 },
          ],
        }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({
          tiers: [
            { name: 'a', minValueScore: 0.25, kind: 'gift', amount: 10_00 },
            { name: 'a', minValueScore: 0.5, kind: 'voucher', amount: 20_00 },
          ],
        }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({
          tiers: Array.from({ length: 9 }, (_, index) => ({
            name: `t${index}`,
            minValueScore: index / 10,
            kind: 'recognition',
            amount: 0,
          })),
        }) as unknown as SetRewardPolicyInput,
      ),
    );
  });

  it('rejects out-of-range scores, negative/non-integer amounts, a zero saturation point and malformed currencies', () => {
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({ minKnowledgeGain: 1.5 }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ weights: { knowledgeGain: -0.1 } }) as unknown as SetRewardPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({
          tiers: [{ name: 'a', minValueScore: 0.5, kind: 'gift', amount: 10.5 }],
        }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({ costAvoidedSaturation: 0 }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ rewardCurrency: 'eur' }) as unknown as SetRewardPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ rewardCurrency: 'EURO' }) as unknown as SetRewardPolicyInput),
    );
  });

  it('rejects malformed qualifying statuses and duplicates', () => {
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(policyInput({ qualifyingStatuses: [] }) as unknown as SetRewardPolicyInput),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({ qualifyingStatuses: ['validated', 'validated'] }) as unknown as SetRewardPolicyInput,
      ),
    );
    expectCode('invalid_policy_input', () =>
      validateSetRewardPolicyInput(
        policyInput({ qualifyingStatuses: ['amazing'] }) as unknown as SetRewardPolicyInput,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// applyRewardPolicy input validation
// ---------------------------------------------------------------------------

describe('validateApplyRewardPolicyInput', () => {
  it('accepts a well-formed knowledge-contribution application', () => {
    const valid = validateApplyRewardPolicyInput(applyInput() as unknown as ApplyRewardPolicyInput);
    expect(valid.contribution.kind).toBe('knowledge-contribution');
    expect(valid.contribution.contributor).toEqual({
      personId: PERSON_ID,
      label: 'Ada Lovelace',
    });
    expect(valid.missionId).toBe(MISSION_ID);
    expect(valid.value.status).toBe('measured');
    expect(valid.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(valid.rationale).toBe('mission resolved by this answer');
  });

  it('accepts an acquisition-plan anchor without contributor or missionId (both derived)', () => {
    const valid = validateApplyRewardPolicyInput(
      applyInput({
        contribution: { kind: 'acquisition-plan', id: PLAN_ID },
        missionId: null,
      }) as unknown as ApplyRewardPolicyInput,
    );
    expect(valid.contribution.contributor).toBeNull();
    expect(valid.missionId).toBeNull();
  });

  it('rejects a caller-supplied contributor on an acquisition-plan anchor (derived, never trusted)', () => {
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          contribution: {
            kind: 'acquisition-plan',
            id: PLAN_ID,
            contributor: { personId: PERSON_ID },
          },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
  });

  it('requires contributor and missionId on a knowledge-contribution reference', () => {
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          contribution: { kind: 'knowledge-contribution', id: CONTRIBUTION_ID },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ missionId: null }) as unknown as ApplyRewardPolicyInput,
      ),
    );
  });

  it('rejects unknown keys — the reward itself is never caller-forgeable', () => {
    for (const minted of [
      'status',
      'tier',
      'amount',
      'reward',
      'policyVersion',
      'actionRequestId',
      'budgetRemainingBefore',
      'appliedByPrincipal',
      'recordedAt',
      'settlement',
    ]) {
      expectCode('invalid_reward_input', () =>
        validateApplyRewardPolicyInput(
          applyInput({ [minted]: 'forged' }) as unknown as ApplyRewardPolicyInput,
        ),
      );
    }
  });

  it('validates the §8 value shape (status, gain, impact, goals, cost, currency)', () => {
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ value: { ...value(), status: 'great' } }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          value: { ...value(), knowledgeGain: 1.2 },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ value: { ...value(), missionImpact: 'decisive' } }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          value: { ...value(), affectedGoals: [{ goalId: 'not-a-uuid' }] },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          value: { ...value(), costAvoided: { amount: -5, currency: 'EUR' } },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          value: { ...value(), costAvoided: { amount: 5, currency: 'euros' } },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({
          value: { ...value(), affectedGoals: Array.from({ length: 17 }, () => ({ goalId: GOAL_ID })) },
        }) as unknown as ApplyRewardPolicyInput,
      ),
    );
  });

  it('requires a traceable actor and validates ids/labels/rationale bounds', () => {
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ actor: { kind: 'system' } }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ actor: { kind: 'subsystem', label: 'x' } }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ actor: { kind: 'system', id: 'nope' } }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ rationale: 'x'.repeat(2001) }) as unknown as ApplyRewardPolicyInput,
      ),
    );
    expectCode('invalid_reward_input', () =>
      validateApplyRewardPolicyInput(
        applyInput({ contribution: { kind: 'knowledge-contribution', id: 'nope' } }) as unknown as ApplyRewardPolicyInput,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Settlement + query validation
// ---------------------------------------------------------------------------

describe('settlement and query validation', () => {
  it('validates settle input', () => {
    expect(validateSettleRewardInput({ rewardId: PLAN_ID }).rewardId).toBe(PLAN_ID);
    expectCode('invalid_settlement_input', () => validateSettleRewardInput({}));
    expectCode('invalid_settlement_input', () => validateSettleRewardInput({ rewardId: 'x' }));
    expectCode('invalid_settlement_input', () =>
      validateSettleRewardInput({ rewardId: PLAN_ID, decision: 'granted' }),
    );
  });

  it('validates list and summarize queries', () => {
    expect(validateListRewardsQuery({}).limit).toBe(50);
    expect(validateListRewardsQuery({ status: 'granted', kind: 'gift', limit: 1 }).status).toBe('granted');
    expectCode('invalid_query', () =>
      validateListRewardsQuery({ status: 'paid' } as unknown as Parameters<
        typeof validateListRewardsQuery
      >[0]),
    );
    expectCode('invalid_query', () =>
      validateListRewardsQuery({ kind: 'bonus' } as unknown as Parameters<
        typeof validateListRewardsQuery
      >[0]),
    );
    expectCode('invalid_query', () => validateListRewardsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListRewardsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListRewardsQuery({ missionId: 'x' }));
    expect(validateSummarizeRewardsQuery({})).toEqual({
      missionId: null,
      contributorPersonId: null,
    });
    expectCode('invalid_query', () => validateSummarizeRewardsQuery({ contributorPersonId: 'x' }));
  });
});

// ---------------------------------------------------------------------------
// The deterministic conversion (W043's core)
// ---------------------------------------------------------------------------

describe('evaluateRewardPolicy', () => {
  it('converts a valuable contribution into the configured tier reward', () => {
    // factors: gain 0.4, impact resolved 1, cost 250/500 = 0.5
    // score: 0.4*0.4 + 0.4*1 + 0.2*0.5 = 0.16 + 0.4 + 0.1 = 0.66 → tier 0.5
    const assessment = evaluateRewardPolicy(policy(), value());
    expect(assessment.decision).toBe('reward_due');
    expect(assessment.factors).toEqual({ knowledgeGain: 0.4, missionImpact: 1, costAvoided: 0.5 });
    expect(assessment.valueScore).toBe(0.66);
    expect(assessment.tier).toEqual({
      name: 'thank-you-gift',
      minValueScore: 0.5,
      kind: 'gift',
      amount: 50_00,
      currency: 'EUR',
    });
  });

  it('selects the HIGHEST matching floor and saturates the score at 1', () => {
    const assessment = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 1, costAvoided: { amount: 500_00, currency: 'EUR' } }),
    );
    expect(assessment.valueScore).toBe(1);
    expect(assessment.tier?.name).toBe('valued-contributor');
    expect(assessment.tier?.amount).toBe(150_00);
    // cost above the saturation point caps the factor at 1
    expect(assessment.factors.costAvoided).toBe(1);
  });

  it('returns the first failing eligibility gate as the no-reward reason, in fixed order', () => {
    expect(evaluateRewardPolicy(policy(), value({ status: 'rejected' })).reason).toBe(
      'non_qualifying_status',
    );
    expect(evaluateRewardPolicy(policy(), value({ status: 'pending' })).reason).toBe(
      'non_qualifying_status',
    );
    expect(
      evaluateRewardPolicy(policy({ minKnowledgeGain: 0.5 }), value()).reason,
    ).toBe('knowledge_gain_below_minimum');
    expect(
      evaluateRewardPolicy(policy({ minAffectedGoals: 2 }), value()).reason,
    ).toBe('insufficient_goal_impact');
    // Order: status beats gain beats goals.
    expect(
      evaluateRewardPolicy(
        policy({ minKnowledgeGain: 0.5, minAffectedGoals: 2 }),
        value({ status: 'rejected' }),
      ).reason,
    ).toBe('non_qualifying_status');
  });

  it('reports below_tier_floor with the computed score when nothing matches', () => {
    const assessment = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 0.1, missionImpact: 'no_effect', costAvoided: { amount: 0, currency: 'EUR' } }),
    );
    expect(assessment.decision).toBe('no_reward_due');
    expect(assessment.reason).toBe('below_tier_floor');
    // 0.4*0.1 + 0.4*0 + 0.2*0 = 0.04 — below the 0.25 floor
    expect(assessment.valueScore).toBe(0.04);
    expect(assessment.tier).toBeNull();
  });

  it('throws a uniform currency_mismatch for a foreign-denominated cost figure', () => {
    expectCode('currency_mismatch', () =>
      evaluateRewardPolicy(policy(), value({ costAvoided: { amount: 250_00, currency: 'USD' } })),
    );
  });

  it('is fully deterministic — same policy + same value ⇒ deep-equal assessment', () => {
    const one: RewardPolicyAssessment = evaluateRewardPolicy(policy(), value());
    const two: RewardPolicyAssessment = evaluateRewardPolicy(policy(), value());
    expect(one).toEqual(two);
  });

  it('value changes move the matched tier (the conversion follows the evidence)', () => {
    const low = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 0.2, missionImpact: 'advanced', costAvoided: { amount: 0, currency: 'EUR' } }),
    );
    const high = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 0.8, missionImpact: 'resolved', costAvoided: { amount: 400_00, currency: 'EUR' } }),
    );
    expect(low.tier?.name ?? 'none').not.toBe(high.tier?.name);
    expect(low.valueScore).toBeLessThan(high.valueScore);
    expect(high.tier?.name).toBe('valued-contributor');
  });

  it('rounds the score to 6 decimals deterministically', () => {
    // 0.4*(1/3) + 0.4*0 + 0.2*0 = 0.1333333… → 0.133333
    const assessment = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 1 / 3, missionImpact: 'no_effect', costAvoided: { amount: 0, currency: 'EUR' } }),
    );
    expect(assessment.valueScore).toBe(0.133333);
  });

  it('zero-amount recognition tiers reward zero-budget contexts (amount 0 is configured)', () => {
    const assessment = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 0.4, missionImpact: 'no_effect', costAvoided: { amount: 0, currency: 'EUR' } }),
    );
    // 0.16 + 0 + 0 = 0.16 — below the first floor: no reward. Bump the gain
    // to cross 0.25 with the recognition floor still at amount 0.
    expect(assessment.decision).toBe('no_reward_due');
    const crossing = evaluateRewardPolicy(
      policy(),
      value({ knowledgeGain: 0.65, missionImpact: 'no_effect', costAvoided: { amount: 0, currency: 'EUR' } }),
    );
    expect(crossing.decision).toBe('reward_due');
    expect(crossing.tier?.kind).toBe('recognition');
    expect(crossing.tier?.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Status derivations + snapshots
// ---------------------------------------------------------------------------

describe('status derivations', () => {
  it('maps request statuses and authority outcomes onto minted statuses', () => {
    expect(mintedStatusForRequestStatus('approved')).toBe('granted');
    expect(mintedStatusForRequestStatus('pending')).toBe('proposed');
    expect(mintedStatusForRequestStatus('rejected')).toBe('refused');
    expect(mintedStatusForOutcome('allowed')).toBe('granted');
    expect(mintedStatusForOutcome('approval_required')).toBe('proposed');
    expect(mintedStatusForOutcome('forbidden')).toBe('refused');
  });

  it('derives the current status with the settlement winning over the minted one', () => {
    expect(derivedRewardStatus('proposed', null)).toBe('proposed');
    expect(derivedRewardStatus('granted', null)).toBe('granted');
    expect(derivedRewardStatus('refused', null)).toBe('refused');
    expect(derivedRewardStatus('proposed', { decision: 'granted' })).toBe('granted');
    expect(derivedRewardStatus('proposed', { decision: 'declined' })).toBe('declined');
  });

  it('snapshots the policy exactly as it decided, with the matched floor', () => {
    const matched = tiers()[1]!;
    const snapshot = snapshotPolicy(policy(), matched);
    expect(snapshot).toEqual({
      version: 3,
      qualifyingStatuses: ['validated', 'measured'],
      minKnowledgeGain: 0,
      minAffectedGoals: 0,
      weights: { knowledgeGain: 0.4, missionImpact: 0.4, costAvoided: 0.2 },
      impactKindWeights: { advanced: 0.6, resolved: 1, no_effect: 0 },
      costAvoidedSaturation: 500_00,
      rewardCurrency: 'EUR',
      matchedTierFloor: 0.5,
    });
    // Frozen copies, not live references.
    expect(snapshot.qualifyingStatuses).not.toBe(policy().qualifyingStatuses);
    expect(snapshot.weights).not.toBe(policy().weights);
  });
});

// ---------------------------------------------------------------------------
// The structural no-compensation guarantee, once more, on the conversion
// ---------------------------------------------------------------------------

describe('compensation separation (structural)', () => {
  it('never produces a compensation-shaped reward from any value', () => {
    // Every configured tier of every representable policy can only be one
    // of the five non-compensation kinds (validateSetRewardPolicyInput
    // rejects the rest), so the pure conversion mathematically cannot
    // emit a compensation shape.
    for (const kind of REWARD_KINDS) {
      const assessment = evaluateRewardPolicy(
        policy({ tiers: [{ name: 't', minValueScore: 0, kind, amount: 0 }] }),
        value(),
      );
      expect(COMPENSATION_EXCLUDED_KINDS).not.toContain(assessment.tier?.kind);
    }
  });
});
