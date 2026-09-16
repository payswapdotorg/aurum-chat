// Unit tests for the attention module's pure validation/normalization and
// derivation logic (no database). Covers every guard a caller crosses
// before storage, plus the deterministic ADR-0017 derivations:
//
//  * tenant-context shape (invalid_context) and the administer claim;
//  * discovery-input validation — required/bounded strings, vocabularies
//    (urgency, acquisition-path kinds, proposer kinds), uuids, the
//    evidence basis (>=1 observation, deduplicated, sorted, capped),
//    probability fields ([0,1]), the CONFIDENCE-GAP RULE (required >
//    current — a gap without a shortfall is not a gap), traceable
//    proposer and acquisition paths, and unknown-key rejection including
//    the system-minted fields (id, tenantId, status, recordedAt,
//    recordedByPrincipal, materiality, materialization, confidenceGap);
//  * policy-input validation — thresholds ([0,1]), mission policy mode,
//    budgets (integer minor units + ISO currency), claim gate constant;
//  * get/materialize/list query validation (filters, requires, limits);
//  * evaluateMateriality — the deterministic policy gate: inclusive
//    thresholds, each dimension deciding alone, and the reconstructable
//    basis strings;
//  * deriveUnknownRecord / deriveMissionDefinition — the deterministic
//    W007/W011 seams: question/consequence/subject/evidence links, title
//    and completion-criteria derivation, truncation, budget flow, and the
//    acquisition paths flowing into the planner's menu unchanged;
//  * urgency ranking.

import { describe, expect, it } from 'vitest';
import { AttentionError } from '../errors';
import type { DiscoverGoalGapInput, SetDiscoveryPolicyInput } from '../types';
import {
  BUILT_IN_DISCOVERY_POLICY,
  deriveMissionDefinition,
  deriveUnknownRecord,
  evaluateMateriality,
  GOAL_GAP_SUBJECT_KIND,
  urgencyRank,
  type DerivationCandidate,
} from '../materiality';
import {
  assertAttentionTenantContext,
  ATTENTION_AUTHORITY_ADMINISTER,
  canAdministerDiscoveryPolicy,
  escapeLike,
  isAcquisitionPathKind,
  isCandidateUnknownStatus,
  isGapProposerKind,
  isGapUrgency,
  isMissionPolicyMode,
  isUuid,
  validateDiscoveryInput,
  validateGetQuery,
  validateListQuery,
  validateMaterializeInput,
  validatePolicyInput,
} from '../validation';

const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const OBSERVATION_ID = '6a8e0f2c-9d1b-4c3e-a5f7-8b9c0d1e2f3a';
const OBSERVATION_ID_2 = '7b9f1a3d-0e2c-4d4f-b6a8-9c0d1e2f3a4b';
const CLAIM_ID = '8c0a2b4e-1f3d-4e5a-c7b9-0d1e2f3a4b5c';
const EXECUTION_ID = '9d1b3c5f-2a4e-4f6b-8c0d-1e2f3a4b5c6d';
const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const CANDIDATE_ID = 'a1c2e3f4-5d6b-4a79-8b8c-9d0e1f2a3b4c';

/** A full discovery evaluation, parameterized for the suites below. */
function discoveryInput(overrides: Partial<DiscoverGoalGapInput> = {}): DiscoverGoalGapInput {
  return {
    goalId: GOAL_ID,
    metricName: 'monthly-churn-rate',
    missingKnowledge: 'Which cohort silently received the July price increase?',
    impactDescription:
      'Churn-mitigation decisions cannot be targeted without knowing which cohort the July price increase hit.',
    decisionImpact: 0.8,
    informationValue: 0.75,
    urgency: 'high',
    currentConfidence: 0.1,
    requiredConfidence: 0.85,
    evidenceObservationIds: [OBSERVATION_ID, OBSERVATION_ID_2],
    evidenceClaimIds: [CLAIM_ID],
    acquisitionPaths: [
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', label: 'billing-export' },
    ],
    proposer: { kind: 'system', label: 'goal-gap-evaluator' },
    executionId: EXECUTION_ID,
    proposerNote: 'Goal evaluation pass 2026-09-14; no operator question involved.',
    ...overrides,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AttentionError);
    expect((error as AttentionError).code).toBe(code);
  }
}

/** A derivation view of one recorded candidate. */
function derivationCandidate(
  overrides: Partial<DerivationCandidate> = {},
): DerivationCandidate {
  return {
    id: CANDIDATE_ID,
    goalId: GOAL_ID,
    metricName: 'monthly-churn-rate',
    missingKnowledge: 'Which cohort silently received the July price increase?',
    impactDescription: 'Churn-mitigation decisions cannot be targeted without it.',
    urgency: 'high',
    informationValue: 0.75,
    currentConfidence: 0.1,
    requiredConfidence: 0.85,
    evidenceObservationIds: [OBSERVATION_ID, OBSERVATION_ID_2],
    evidenceClaimIds: [CLAIM_ID],
    acquisitionPaths: [
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', id: null, label: 'billing-export' },
    ],
    materialityBasis:
      'decision impact 0.8 >= 0.5 and information value 0.75 >= 0.5',
    proposer: { kind: 'system', id: null, label: 'goal-gap-evaluator' },
    ...overrides,
  };
}

describe('validation — tenant context and authority claim', () => {
  it('accepts a well-formed context and rejects malformed ones', () => {
    expect(() =>
      assertAttentionTenantContext({ tenantId: GOAL_ID, principalId: PERSON_ID, authority: [] }),
    ).not.toThrow();
    expectCode('invalid_context', () =>
      assertAttentionTenantContext({ tenantId: '  ', principalId: PERSON_ID, authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAttentionTenantContext({ tenantId: GOAL_ID, principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAttentionTenantContext({
        tenantId: GOAL_ID,
        principalId: PERSON_ID,
        authority: 'none',
      } as unknown as Parameters<typeof assertAttentionTenantContext>[0]),
    );
  });

  it('gates policy administration on the attention:administer claim', () => {
    expect(canAdministerDiscoveryPolicy({ tenantId: GOAL_ID, principalId: PERSON_ID, authority: [] })).toBe(false);
    expect(
      canAdministerDiscoveryPolicy({
        tenantId: GOAL_ID,
        principalId: PERSON_ID,
        authority: [ATTENTION_AUTHORITY_ADMINISTER],
      }),
    ).toBe(true);
    expect(ATTENTION_AUTHORITY_ADMINISTER).toBe('attention:administer');
  });
});

describe('validation — discovery input (the unprompted evaluation surface)', () => {
  it('normalizes a full evaluation: sorted/deduplicated evidence, optional fields', () => {
    const valid = validateDiscoveryInput(
      discoveryInput({
        evidenceObservationIds: [OBSERVATION_ID_2, OBSERVATION_ID, OBSERVATION_ID_2],
        metricName: '  monthly-churn-rate  ',
      }),
    );
    expect(valid.goalId).toBe(GOAL_ID);
    expect(valid.metricName).toBe('monthly-churn-rate');
    expect(valid.evidenceObservationIds).toEqual([OBSERVATION_ID, OBSERVATION_ID_2]);
    expect(valid.evidenceClaimIds).toEqual([CLAIM_ID]);
    expect(valid.executionId).toBe(EXECUTION_ID);
    expect(valid.proposer).toEqual({ kind: 'system', id: null, label: 'goal-gap-evaluator' });
    expect(valid.acquisitionPaths).toEqual([
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', id: null, label: 'billing-export' },
    ]);
  });

  it('applies defaults: no metric, no claims, no acquisition paths, no execution, no note', () => {
    const valid = validateDiscoveryInput({
      goalId: GOAL_ID,
      missingKnowledge: 'Which cohort silently received the July price increase?',
      impactDescription: 'Churn decisions cannot be targeted without it.',
      decisionImpact: 0.8,
      informationValue: 0.75,
      urgency: 'high',
      currentConfidence: 0.1,
      requiredConfidence: 0.85,
      evidenceObservationIds: [OBSERVATION_ID],
      proposer: { kind: 'system', label: 'goal-gap-evaluator' },
    });
    expect(valid.metricName).toBeNull();
    expect(valid.evidenceClaimIds).toEqual([]);
    expect(valid.acquisitionPaths).toEqual([]);
    expect(valid.executionId).toBeNull();
    expect(valid.proposerNote).toBeNull();
  });

  it('rejects system-minted fields on the input surface (audit fields are not forgeable)', () => {
    for (const field of [
      'id',
      'tenantId',
      'status',
      'recordedAt',
      'recordedByPrincipal',
      'materiality',
      'materialization',
      'confidenceGap',
    ]) {
      expectCode('invalid_discovery_input', () =>
        validateDiscoveryInput({ ...discoveryInput(), [field]: 'x' }),
      );
    }
  });

  it('requires uuid goal/execution ids and valid evidence ids', () => {
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ goalId: 'not-a-uuid' })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ executionId: 'not-a-uuid' })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ evidenceObservationIds: ['nope'] })),
    );
  });

  it('requires at least one evidence observation — discovery is evidence-linked', () => {
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ evidenceObservationIds: [] })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput({ ...discoveryInput(), evidenceObservationIds: undefined } as unknown as DiscoverGoalGapInput),
    );
  });

  it('caps the evidence basis and the acquisition paths', () => {
    const many = Array.from({ length: 17 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ evidenceObservationIds: many })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ evidenceClaimIds: many })),
    );
    const manyPaths = Array.from({ length: 17 }, () => ({ kind: 'system', label: 'x' }));
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(
        discoveryInput({ acquisitionPaths: manyPaths as unknown as DiscoverGoalGapInput['acquisitionPaths'] }),
      ),
    );
  });

  it('enforces the confidence-gap rule: required must exceed current', () => {
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ requiredConfidence: 0.1 })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ requiredConfidence: 0.05, currentConfidence: 0.1 })),
    );
  });

  it('bounds every probability field to [0, 1] and finite numbers', () => {
    for (const field of [
      'decisionImpact',
      'informationValue',
      'currentConfidence',
      'requiredConfidence',
    ]) {
      expectCode('invalid_discovery_input', () =>
        validateDiscoveryInput(discoveryInput({ [field]: 1.5 })),
      );
      expectCode('invalid_discovery_input', () =>
        validateDiscoveryInput(discoveryInput({ [field]: -0.1 })),
      );
      expectCode('invalid_discovery_input', () =>
        validateDiscoveryInput(discoveryInput({ [field]: Number.POSITIVE_INFINITY })),
      );
      expectCode('invalid_discovery_input', () =>
        validateDiscoveryInput(discoveryInput({ [field]: '0.5' as unknown as number })),
      );
    }
  });

  it('validates the urgency vocabulary and bounded text fields', () => {
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ urgency: 'whenever' as unknown as DiscoverGoalGapInput['urgency'] })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput({ ...discoveryInput(), missingKnowledge: '' }),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ missingKnowledge: '   ' })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ impactDescription: 'x'.repeat(2049) })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ metricName: 'x'.repeat(201) })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ proposerNote: 'x'.repeat(2049) })),
    );
  });

  it('requires a traceable proposer and traceable acquisition paths', () => {
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(discoveryInput({ proposer: { kind: 'system' } })),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput(
        discoveryInput({ proposer: { kind: 'deity', label: 'oracle' } as unknown as DiscoverGoalGapInput['proposer'] }),
      ),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput({
        ...discoveryInput(),
        acquisitionPaths: [{ kind: 'psychic', label: 'medium' }] as unknown as DiscoverGoalGapInput['acquisitionPaths'],
      }),
    );
    expectCode('invalid_discovery_input', () =>
      validateDiscoveryInput({
        ...discoveryInput(),
        acquisitionPaths: [{ kind: 'person', id: 'not-a-uuid' }],
      }),
    );
  });

  it('rejects a non-object input outright', () => {
    expectCode('invalid_discovery_input', () => validateDiscoveryInput(null as unknown as DiscoverGoalGapInput));
    expectCode('invalid_discovery_input', () => validateDiscoveryInput('gap' as unknown as DiscoverGoalGapInput));
  });
});

describe('validation — policy input (the materiality gate configuration)', () => {
  function policyInput(overrides: Partial<SetDiscoveryPolicyInput> = {}): SetDiscoveryPolicyInput {
    return {
      minDecisionImpact: 0.6,
      minInformationValue: 0.55,
      missionPolicy: 'manual',
      investigationBudget: { amount: 250_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'eur' },
      ...overrides,
    };
  }

  it('normalizes budgets (uppercase currency) and accepts the vocabulary', () => {
    const valid = validatePolicyInput(policyInput());
    expect(valid.minDecisionImpact).toBe(0.6);
    expect(valid.minInformationValue).toBe(0.55);
    expect(valid.missionPolicy).toBe('manual');
    expect(valid.investigationBudget).toEqual({ amount: 250_00, currency: 'EUR' });
    expect(valid.rewardBudget).toEqual({ amount: 50_00, currency: 'EUR' });
  });

  it('bounds thresholds to [0, 1] and validates the mission policy mode', () => {
    expectCode('invalid_policy_input', () =>
      validatePolicyInput(policyInput({ minDecisionImpact: 1.5 })),
    );
    expectCode('invalid_policy_input', () =>
      validatePolicyInput(policyInput({ minInformationValue: -0.1 })),
    );
    expectCode('invalid_policy_input', () =>
      validatePolicyInput(policyInput({ missionPolicy: 'maybe' as SetDiscoveryPolicyInput['missionPolicy'] })),
    );
  });

  it('validates budgets: integer minor units, ISO currency, non-negative', () => {
    expectCode('invalid_policy_input', () =>
      validatePolicyInput(policyInput({ investigationBudget: { amount: -1, currency: 'EUR' } })),
    );
    expectCode('invalid_policy_input', () =>
      validatePolicyInput(policyInput({ investigationBudget: { amount: 1.5, currency: 'EUR' } })),
    );
    expectCode('invalid_policy_input', () =>
      validatePolicyInput(policyInput({ investigationBudget: { amount: 10, currency: 'EURO' } })),
    );
    expectCode('invalid_policy_input', () =>
      validatePolicyInput({ ...policyInput(), unknownField: 1 } as unknown as SetDiscoveryPolicyInput),
    );
  });
});

describe('validation — queries', () => {
  it('validates get/materialize queries', () => {
    expect(validateGetQuery({ candidateId: CANDIDATE_ID })).toEqual({ candidateId: CANDIDATE_ID });
    expectCode('invalid_query', () => validateGetQuery({ candidateId: 'nope' }));
    expectCode('invalid_query', () => validateGetQuery({ extra: 1 } as unknown as { candidateId: string }));
    expect(validateMaterializeInput({ candidateId: CANDIDATE_ID })).toEqual({
      candidateId: CANDIDATE_ID,
    });
    expectCode('invalid_query', () => validateMaterializeInput(null as unknown as { candidateId: string }));
  });

  it('validates list filters: vocabularies, uuids, proposer requires, limit bounds', () => {
    expect(validateListQuery({})).toEqual({ limit: 100 });
    expect(validateListQuery({ status: 'material', goalId: GOAL_ID, limit: 1 })).toEqual({
      status: 'material',
      goalId: GOAL_ID,
      limit: 1,
    });
    expectCode('invalid_query', () =>
      validateListQuery({ status: 'dismissed' as unknown as Parameters<typeof validateListQuery>[0]['status'] }));
    expectCode('invalid_query', () =>
      validateListQuery({ urgency: 'soon' as unknown as Parameters<typeof validateListQuery>[0]['urgency'] }));
    expectCode('invalid_query', () => validateListQuery({ goalId: 'nope' }));
    expectCode('invalid_query', () => validateListQuery({ executionId: 'nope' }));
    expectCode('invalid_query', () => validateListQuery({ proposerId: PERSON_ID }));
    expectCode('invalid_query', () =>
      validateListQuery({
        proposerKind: 'deity' as unknown as Parameters<typeof validateListQuery>[0]['proposerKind'],
      }));
    // proposerKind alone is a legal filter (matches any proposer of that kind).
    expect(validateListQuery({ proposerKind: 'person' }).proposerKind).toBe('person');
    expectCode('invalid_query', () => validateListQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListQuery({ limit: 2.5 }));
    expectCode('invalid_query', () => validateListQuery({ search: 'x'.repeat(201) }));
    expect(
      validateListQuery({ proposerKind: 'person', proposerId: PERSON_ID }).proposerId,
    ).toBe(PERSON_ID);
  });

  it('exposes the vocabulary guards and escapeLike', () => {
    for (const status of ['immaterial', 'material', 'materialized']) {
      expect(isCandidateUnknownStatus(status)).toBe(true);
    }
    expect(isCandidateUnknownStatus('dismissed')).toBe(false);
    expect(isGapUrgency('high')).toBe(true);
    expect(isGapUrgency('highish')).toBe(false);
    expect(isMissionPolicyMode('auto')).toBe(true);
    expect(isMissionPolicyMode('maybe')).toBe(false);
    expect(isAcquisitionPathKind('analysis')).toBe(true);
    expect(isAcquisitionPathKind('psychic')).toBe(false);
    expect(isGapProposerKind('team')).toBe(true);
    expect(isGapProposerKind('deity')).toBe(false);
    expect(isUuid(CANDIDATE_ID)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(escapeLike('50%_of\\us')).toBe('50\\%\\_of\\\\us');
  });
});

describe('materiality — the deterministic policy gate (ADR-0017)', () => {
  const thresholds = { minDecisionImpact: 0.5, minInformationValue: 0.5 };

  it('is material iff both dimensions are sufficient (inclusive thresholds)', () => {
    expect(evaluateMateriality(thresholds, { decisionImpact: 0.5, informationValue: 0.5 }).material).toBe(true);
    expect(evaluateMateriality(thresholds, { decisionImpact: 1, informationValue: 1 }).material).toBe(true);
    expect(evaluateMateriality(thresholds, { decisionImpact: 0.4999, informationValue: 0.9 }).material).toBe(false);
    expect(evaluateMateriality(thresholds, { decisionImpact: 0.9, informationValue: 0.4999 }).material).toBe(false);
    expect(evaluateMateriality(thresholds, { decisionImpact: 0.2, informationValue: 0.2 }).material).toBe(false);
  });

  it('produces reconstructable basis strings naming values and thresholds', () => {
    const material = evaluateMateriality(thresholds, {
      decisionImpact: 0.8,
      informationValue: 0.75,
    });
    expect(material.decision).toBe('material');
    expect(material.basis).toBe(
      'decision impact 0.8 >= 0.5 and information value 0.75 >= 0.5',
    );
    const immaterial = evaluateMateriality(
      { minDecisionImpact: 0.9, minInformationValue: 0.5 },
      { decisionImpact: 0.8, informationValue: 0.75 },
    );
    expect(immaterial.decision).toBe('immaterial');
    expect(immaterial.basis).toBe(
      'decision impact 0.8 < 0.9 or information value 0.75 >= 0.5 — below the materiality thresholds',
    );
  });

  it('is deterministic: identical inputs produce identical decisions', () => {
    const inputs = { decisionImpact: 0.62, informationValue: 0.71 };
    expect(evaluateMateriality(thresholds, inputs)).toEqual(evaluateMateriality(thresholds, inputs));
  });

  it('exposes the built-in default policy floor', () => {
    expect(BUILT_IN_DISCOVERY_POLICY.minDecisionImpact).toBe(0.5);
    expect(BUILT_IN_DISCOVERY_POLICY.minInformationValue).toBe(0.5);
    expect(BUILT_IN_DISCOVERY_POLICY.missionPolicy).toBe('auto');
    expect(BUILT_IN_DISCOVERY_POLICY.investigationBudget).toEqual({ amount: 0, currency: 'EUR' });
    expect(BUILT_IN_DISCOVERY_POLICY.rewardBudget).toEqual({ amount: 0, currency: 'EUR' });
  });
});

describe('materiality — the deterministic W007/W011 derivations', () => {
  it('derives the epistemic unknown: question, consequence, subject, evidence links, note', () => {
    const unknown = deriveUnknownRecord(derivationCandidate());
    expect(unknown.question).toBe('Which cohort silently received the July price increase?');
    expect(unknown.consequence).toBe('Churn-mitigation decisions cannot be targeted without it.');
    expect(unknown.subject).toEqual({ kind: GOAL_GAP_SUBJECT_KIND, id: GOAL_ID });
    expect(GOAL_GAP_SUBJECT_KIND).toBe('goals.goal');
    expect(unknown.relatedObservationIds).toEqual([OBSERVATION_ID, OBSERVATION_ID_2]);
    expect(unknown.relatedClaimIds).toEqual([CLAIM_ID]);
    expect(unknown.note).toContain(CANDIDATE_ID);
    expect(unknown.note).toContain('confidence gap 0.1');
    expect(unknown.note).toContain('goal');
  });

  it('omits the metric segment when the gap is not metric-scoped', () => {
    const unknown = deriveUnknownRecord(derivationCandidate({ metricName: null }));
    expect(unknown.note).not.toContain('metric');
    const mission = deriveMissionDefinition(derivationCandidate({ metricName: null }), 'Q4 churn reduction', {
      investigationBudget: { amount: 250_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
    });
    expect(mission.title).toBe('Goal gap · Q4 churn reduction');
  });

  it('derives the LearningMission: title, objective, affected goal, confidences, budgets, paths', () => {
    const policy = {
      investigationBudget: { amount: 250_00, currency: 'EUR' },
      rewardBudget: { amount: 50_00, currency: 'EUR' },
    };
    const mission = deriveMissionDefinition(
      derivationCandidate(),
      'Q4 churn reduction',
      policy,
    );
    expect(mission.title).toBe('Goal gap · Q4 churn reduction · monthly-churn-rate');
    expect(mission.knowledgeObjective).toBe(
      'Which cohort silently received the July price increase?',
    );
    expect(mission.affectedGoals).toEqual([{ goalId: GOAL_ID, label: 'Q4 churn reduction' }]);
    expect(mission.unknownIds).toEqual([]); // appended by the service once the unknown exists
    expect(mission.informationValue).toBe(0.75);
    expect(mission.urgency).toBe('high');
    expect(mission.currentConfidence).toBe(0.1);
    expect(mission.targetConfidence).toBe(0.85);
    expect(mission.investigationBudget).toEqual({ amount: 250_00, currency: 'EUR' });
    expect(mission.rewardBudget).toEqual({ amount: 50_00, currency: 'EUR' });
    expect(mission.candidateSources).toEqual([
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', id: null, label: 'billing-export' },
    ]);
    expect(mission.completionCriteria).toContain('0.1');
    expect(mission.completionCriteria).toContain('0.85');
    expect(mission.rationale).toContain(CANDIDATE_ID);
    expect(mission.rationale).toContain(GOAL_ID);
    expect(mission.rationale).toContain('proposer system');
  });

  it('truncates derived strings deterministically to the missions module caps', () => {
    const policy = {
      investigationBudget: { amount: 0, currency: 'EUR' },
      rewardBudget: { amount: 0, currency: 'EUR' },
    };
    const long = 'x'.repeat(300);
    const mission = deriveMissionDefinition(
      derivationCandidate({ missingKnowledge: long, metricName: null }),
      'y'.repeat(300),
      policy,
    );
    expect(mission.title.length).toBeLessThanOrEqual(200);
    expect(mission.title.endsWith('...')).toBe(true);
    expect(mission.completionCriteria.length).toBeLessThanOrEqual(4000);
    expect(mission.rationale.length).toBeLessThanOrEqual(2000);
    expect(mission.knowledgeObjective).toBe(long);
  });
});

describe('materiality — urgency ranking', () => {
  it('ranks critical first and low last', () => {
    expect(urgencyRank('critical')).toBeLessThan(urgencyRank('high'));
    expect(urgencyRank('high')).toBeLessThan(urgencyRank('medium'));
    expect(urgencyRank('medium')).toBeLessThan(urgencyRank('low'));
  });
});
