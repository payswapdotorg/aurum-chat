// Unit tests for the contributions module's pure validation/normalization
// logic and the knowledge-gain math (no database). Covers every guard a
// caller crosses before storage:
//
//  * tenant-context shape (invalid_context);
//  * record-input validation — plan uuid, summary bounds, optional note,
//    traceable actor, defaults, and unknown-key rejection including the
//    system-minted fields (id, tenantId, missionId, contributor,
//    question, evidenceObservationId, budgetCurrency, status, validation,
//    validationCount, impact, recordedAt, recordedByPrincipal);
//  * validation-input validation — outcome vocabulary, quality score in
//    [0,1], traceable evidence refs (kind vocabulary, uuid-or-label,
//    capped), actor;
//  * impact-input validation — mission-impact vocabulary, confidences in
//    [0,1], affected-goal refs (uuid + unique + capped), avoided cost as
//    non-negative integer minor units, avoided paths (acquisition-action
//    vocabulary, label, estimated cost, capped), optional learning
//    outcome uuid, actor;
//  * list/validations/summarize query validation — vocabularies, uuid
//    filters, bounded search and limit;
//  * assessKnowledgeGain — the single deterministic definition of the
//    knowledge gain: signed delta and gain/loss/flat direction, including
//    exact equality, negative gains (contradiction can lower confidence)
//    and the full-scale extremes.
//
// The knowledge-acquisition-contract and learning-contract existence
// checks (plan anchor, learning outcome link) are service-level concerns
// (they need the db) and are covered by the service tests.

import { describe, expect, it } from 'vitest';
import { ContributionsError } from '../errors';
import type {
  RecordContributionInput,
  RecordImpactInput,
  ValidateContributionInput,
} from '../types';
import {
  AVOIDED_PATH_ACTIONS,
  assessKnowledgeGain,
  assertContributionsTenantContext,
  escapeLike,
  isAvoidedPathAction,
  isContributionEvidenceKind,
  isContributionPartyKind,
  isContributionStatus,
  isMissionImpactKind,
  isUuid,
  isValidationOutcome,
  MAX_AVOIDED_PATHS,
  MAX_COST_AMOUNT,
  validateListContributionsQuery,
  validateListValidationsQuery,
  validateRecordContributionInput,
  validateRecordImpactInput,
  validateSummarizeContributionsQuery,
  validateValidateContributionInput,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const PLAN_ID = '5e7a3c9b-6d8f-4e0a-9f2c-3a5b7c9e1a3d';
const CONTRIBUTION_ID = '8a0b6c4e-9d2f-4e5a-8f3c-4b6d8e0f2a4b';
const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const GOAL_ID_2 = '2d4b0a5c-3e6d-4fac-9b5a-9c4d8e7f6a1b';
const OBSERVATION_ID = 'ac2d8e6a-1f4b-4a7c-8b5e-6d8f0a2c4e6d';
const OUTCOME_ID = '9b1c7d5f-0e3a-4f6b-9a4d-5c7e9f1a3b5c';

/** A full W042 record input, parameterized for the suites below. */
function recordInput(overrides: Partial<RecordContributionInput> = {}): RecordContributionInput {
  return {
    planId: PLAN_ID,
    summary: 'Pricing changes drove Q3 churn; enterprise tier hit hardest.',
    note: 'answered over Slack',
    actor: { kind: 'system', label: 'aurum-cognition' },
    ...overrides,
  };
}

function validationInput(
  overrides: Partial<ValidateContributionInput> = {},
): ValidateContributionInput {
  return {
    contributionId: CONTRIBUTION_ID,
    outcome: 'validated',
    quality: 0.8,
    evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'billing churn export' }],
    note: null,
    actor: { kind: 'person', id: PERSON_ID },
    ...overrides,
  };
}

function impactInput(overrides: Partial<RecordImpactInput> = {}): RecordImpactInput {
  return {
    contributionId: CONTRIBUTION_ID,
    missionImpact: 'advanced',
    confidenceBefore: 0.1,
    confidenceAfter: 0.55,
    affectedGoals: [{ goalId: GOAL_ID, label: 'Q4 churn reduction' }],
    avoidedCost: 120_00,
    avoidedPaths: [
      { action: 'query-system', label: 'billing-export full scan', estimatedCost: 80_00 },
      { action: 'ask-person', label: 'CFO follow-up', estimatedCost: 40_00 },
    ],
    outcomeId: OUTCOME_ID,
    note: 'mission confidence revised after cross-check',
    actor: { kind: 'system', label: 'aurum-cognition' },
    ...overrides,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ContributionsError);
    expect((error as ContributionsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

describe('assertContributionsTenantContext', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertContributionsTenantContext({ tenantId: 't', principalId: 'p', authority: ['x'] }),
    ).not.toThrow();
  });

  it('rejects blank tenant, blank principal and non-array authority', () => {
    expectCode('invalid_context', () =>
      assertContributionsTenantContext({ tenantId: ' ', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertContributionsTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertContributionsTenantContext({ tenantId: 't', principalId: 'p', authority: null as never }),
    );
  });
});

// ---------------------------------------------------------------------------
// recordContribution input
// ---------------------------------------------------------------------------

describe('validateRecordContributionInput', () => {
  it('normalizes a full record input', () => {
    const valid = validateRecordContributionInput(recordInput());
    expect(valid).toEqual({
      planId: PLAN_ID,
      summary: 'Pricing changes drove Q3 churn; enterprise tier hit hardest.',
      note: 'answered over Slack',
      actor: { kind: 'system', id: null, label: 'aurum-cognition' },
    });
  });

  it('defaults the note and keeps a traceable actor', () => {
    const valid = validateRecordContributionInput(recordInput({ note: undefined }));
    expect(valid.note).toBeNull();
    expect(validateRecordContributionInput(recordInput({ note: null })).note).toBeNull();
    expect(validateRecordContributionInput(recordInput({ actor: { kind: 'person', id: PERSON_ID } })).actor).toEqual({
      kind: 'person',
      id: PERSON_ID,
      label: null,
    });
  });

  it('requires a uuid plan id — the anchor must be precise', () => {
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ planId: 'not-a-uuid' })),
    );
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ planId: '' })),
    );
    // uppercase uuids normalize to lowercase
    expect(
      validateRecordContributionInput(recordInput({ planId: PLAN_ID.toUpperCase() })).planId,
    ).toBe(PLAN_ID);
  });

  it('bounds the summary and note', () => {
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ summary: '' })),
    );
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ summary: 'x'.repeat(2001) })),
    );
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ note: 'x'.repeat(2001) })),
    );
  });

  it('requires a traceable actor and a known party kind', () => {
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ actor: { kind: 'person' } as never })),
    );
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ actor: { kind: 'vendor', label: 'x' } as never })),
    );
    expectCode('invalid_contribution_input', () =>
      validateRecordContributionInput(recordInput({ actor: { kind: 'person', id: 'nope' } as never })),
    );
  });

  it('rejects unknown keys — system-minted fields are not caller-forgeable', () => {
    for (const key of [
      'id',
      'tenantId',
      'missionId',
      'contributor',
      'question',
      'evidenceObservationId',
      'budgetCurrency',
      'status',
      'validation',
      'validationCount',
      'impact',
      'recordedAt',
      'recordedByPrincipal',
    ]) {
      expectCode('invalid_contribution_input', () =>
        validateRecordContributionInput(recordInput({ [key]: 'x' as never })),
      );
    }
  });

  it('rejects a non-object input', () => {
    expectCode('invalid_contribution_input', () => validateRecordContributionInput(null));
    expectCode('invalid_contribution_input', () => validateRecordContributionInput('x'));
  });
});

// ---------------------------------------------------------------------------
// validateContribution input
// ---------------------------------------------------------------------------

describe('validateValidateContributionInput', () => {
  it('normalizes a full validation input', () => {
    const valid = validateValidateContributionInput(validationInput());
    expect(valid).toEqual({
      contributionId: CONTRIBUTION_ID,
      outcome: 'validated',
      quality: 0.8,
      evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'billing churn export' }],
      note: null,
      actor: { kind: 'person', id: PERSON_ID, label: null },
    });
  });

  it('requires the outcome vocabulary', () => {
    for (const outcome of ['validated', 'contradicted', 'rejected'] as const) {
      expect(validateValidateContributionInput(validationInput({ outcome })).outcome).toBe(outcome);
    }
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput({ outcome: 'accepted' as never })),
    );
  });

  it('bounds the quality score to [0, 1]', () => {
    expect(validateValidateContributionInput(validationInput({ quality: 0 })).quality).toBe(0);
    expect(validateValidateContributionInput(validationInput({ quality: 1 })).quality).toBe(1);
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput({ quality: 1.2 })),
    );
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput({ quality: -0.1 })),
    );
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput({ quality: Number.NaN })),
    );
  });

  it('validates evidence refs: vocabulary, uuid-or-label, capped', () => {
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput({ evidence: [{ kind: 'gossip' } as never] })),
    );
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(
        validationInput({ evidence: [{ kind: 'observation' } as never] }),
      ),
    );
    expect(
      validateValidateContributionInput(
        validationInput({ evidence: [{ kind: 'report', label: 'churn deep-dive' }] }),
      ).evidence,
    ).toEqual([{ kind: 'report', id: null, label: 'churn deep-dive' }]);
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput({ evidence: 'nope' as never })),
    );
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(
        validationInput({
          evidence: Array.from({ length: 9 }, () => ({ kind: 'report', label: 'x' })),
        }),
      ),
    );
  });

  it('rejects unknown keys', () => {
    const smuggled = { id: 'x' } as Partial<ValidateContributionInput> & Record<string, unknown>;
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput(smuggled as never)),
    );
    const smuggledStatus = { status: 'x' } as Partial<ValidateContributionInput> & Record<string, unknown>;
    expectCode('invalid_validation_input', () =>
      validateValidateContributionInput(validationInput(smuggledStatus as never)),
    );
  });
});

// ---------------------------------------------------------------------------
// recordImpact input
// ---------------------------------------------------------------------------

describe('validateRecordImpactInput', () => {
  it('normalizes a full impact input', () => {
    const valid = validateRecordImpactInput(impactInput());
    expect(valid).toEqual({
      contributionId: CONTRIBUTION_ID,
      missionImpact: 'advanced',
      confidenceBefore: 0.1,
      confidenceAfter: 0.55,
      affectedGoals: [{ goalId: GOAL_ID, label: 'Q4 churn reduction' }],
      avoidedCost: 120_00,
      avoidedPaths: [
        { action: 'query-system', label: 'billing-export full scan', estimatedCost: 80_00 },
        { action: 'ask-person', label: 'CFO follow-up', estimatedCost: 40_00 },
      ],
      outcomeId: OUTCOME_ID,
      note: 'mission confidence revised after cross-check',
      actor: { kind: 'system', id: null, label: 'aurum-cognition' },
    });
  });

  it('defaults the collections and optional refs', () => {
    const valid = validateRecordImpactInput(
      impactInput({ affectedGoals: undefined, avoidedPaths: undefined, outcomeId: undefined, note: undefined }),
    );
    expect(valid.affectedGoals).toEqual([]);
    expect(valid.avoidedPaths).toEqual([]);
    expect(valid.outcomeId).toBeNull();
    expect(valid.note).toBeNull();
  });

  it('requires the mission-impact vocabulary', () => {
    for (const kind of ['advanced', 'resolved', 'no_effect'] as const) {
      expect(validateRecordImpactInput(impactInput({ missionImpact: kind })).missionImpact).toBe(kind);
    }
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ missionImpact: 'completed' as never })),
    );
  });

  it('bounds the confidences to [0, 1] (the missions confidence scale)', () => {
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ confidenceBefore: -0.01 })),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ confidenceAfter: 1.0001 })),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ confidenceBefore: Number.POSITIVE_INFINITY })),
    );
    // a negative gain (after < before) is legal: contradiction can lower
    // confidence — validated here, frozen by the service
    expect(() =>
      validateRecordImpactInput(impactInput({ confidenceBefore: 0.8, confidenceAfter: 0.2 })),
    ).not.toThrow();
  });

  it('validates affected goals: uuid, unique, capped', () => {
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ affectedGoals: [{ goalId: 'nope' } as never] })),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(
        impactInput({ affectedGoals: [
          { goalId: GOAL_ID },
          { goalId: GOAL_ID_2 },
          { goalId: GOAL_ID },
        ] }),
      ),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(
        impactInput({ affectedGoals: Array.from({ length: 17 }, () => ({ goalId: newIdish() })) }),
      ),
    );
  });

  it('requires avoidedCost to be non-negative integer minor units', () => {
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ avoidedCost: -1 })),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ avoidedCost: 12.5 })),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ avoidedCost: MAX_COST_AMOUNT + 1 })),
    );
    expect(validateRecordImpactInput(impactInput({ avoidedCost: 0 })).avoidedCost).toBe(0);
  });

  it('validates avoided paths: acquisition-action vocabulary, label, cost, capped', () => {
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(
        impactInput({ avoidedPaths: [{ action: 'bribe-auditor', label: 'x', estimatedCost: 1 } as never] }),
      ),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(
        impactInput({ avoidedPaths: [{ action: 'run-analysis', label: '', estimatedCost: 1 }] }),
      ),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(
        impactInput({ avoidedPaths: [{ action: 'run-analysis', label: 'x', estimatedCost: -5 }] }),
      ),
    );
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(
        impactInput({ avoidedPaths: Array.from({ length: MAX_AVOIDED_PATHS + 1 }, (_, i) => ({
          action: 'run-analysis',
          label: `analysis-${i}`,
          estimatedCost: 1,
        })) }),
      ),
    );
    // every acquisition action is a legal avoided path (incl. ask-person:
    // asking Ada can avoid asking Bob)
    for (const action of AVOIDED_PATH_ACTIONS) {
      expect(
        validateRecordImpactInput(impactInput({ avoidedPaths: [{ action, label: 'x', estimatedCost: 0 }] })).avoidedPaths,
      ).toEqual([{ action, label: 'x', estimatedCost: 0 }]);
    }
  });

  it('requires a uuid learning-outcome ref when present', () => {
    expectCode('invalid_impact_input', () =>
      validateRecordImpactInput(impactInput({ outcomeId: 'not-a-uuid' })),
    );
    expect(validateRecordImpactInput(impactInput({ outcomeId: null })).outcomeId).toBeNull();
  });

  it('rejects unknown keys — the knowledge gain is never caller-supplied', () => {
    for (const key of ['knowledgeGain', 'id', 'status', 'missionId', 'recordedAt']) {
      expectCode('invalid_impact_input', () =>
        validateRecordImpactInput(impactInput({ [key]: 1 as never })),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('validateListContributionsQuery', () => {
  it('defaults every filter and the limit', () => {
    expect(validateListContributionsQuery({})).toEqual({
      missionId: null,
      personId: null,
      status: null,
      missionImpact: null,
      search: null,
      limit: 50,
    });
  });

  it('accepts the full status ladder and mission-impact vocabulary', () => {
    for (const status of ['pending', 'validated', 'contradicted', 'rejected', 'measured'] as const) {
      expect(validateListContributionsQuery({ status }).status).toBe(status);
    }
    for (const kind of ['advanced', 'resolved', 'no_effect'] as const) {
      expect(validateListContributionsQuery({ missionImpact: kind }).missionImpact).toBe(kind);
    }
    expectCode('invalid_query', () =>
      validateListContributionsQuery({ status: 'open' as never }),
    );
    expectCode('invalid_query', () =>
      validateListContributionsQuery({ missionImpact: 'blocked' as never }),
    );
  });

  it('requires uuid mission/person filters', () => {
    expectCode('invalid_query', () => validateListContributionsQuery({ missionId: 'nope' }));
    expectCode('invalid_query', () => validateListContributionsQuery({ personId: 'nope' }));
    expect(validateListContributionsQuery({ missionId: PLAN_ID, personId: PERSON_ID })).toMatchObject({
      missionId: PLAN_ID,
      personId: PERSON_ID,
    });
  });

  it('bounds the search text and the limit', () => {
    expectCode('invalid_query', () => validateListContributionsQuery({ search: 'x'.repeat(201) }));
    expectCode('invalid_query', () => validateListContributionsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListContributionsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListContributionsQuery({ limit: 2.5 }));
    expect(validateListContributionsQuery({ limit: 500, search: 'churn' })).toMatchObject({
      limit: 500,
      search: 'churn',
    });
  });

  it('rejects unknown keys', () => {
    expectCode('invalid_query', () => validateListContributionsQuery({ planId: PLAN_ID }));
  });
});

describe('validateListValidationsQuery', () => {
  it('requires a uuid contribution id', () => {
    expect(validateListValidationsQuery({ contributionId: CONTRIBUTION_ID })).toEqual({
      contributionId: CONTRIBUTION_ID,
    });
    expectCode('invalid_query', () => validateListValidationsQuery({ contributionId: 'nope' }));
    expectCode('invalid_query', () => validateListValidationsQuery({}));
  });
});

describe('validateSummarizeContributionsQuery', () => {
  it('accepts undefined/null and a uuid person filter', () => {
    expect(validateSummarizeContributionsQuery(undefined)).toEqual({ personId: null });
    expect(validateSummarizeContributionsQuery(null)).toEqual({ personId: null });
    expect(validateSummarizeContributionsQuery({})).toEqual({ personId: null });
    expect(validateSummarizeContributionsQuery({ personId: PERSON_ID })).toEqual({
      personId: PERSON_ID,
    });
  });

  it('rejects a malformed person filter and unknown keys', () => {
    expectCode('invalid_query', () => validateSummarizeContributionsQuery({ personId: 'nope' }));
    expectCode('invalid_query', () => validateSummarizeContributionsQuery({ missionId: PLAN_ID }));
  });
});

// ---------------------------------------------------------------------------
// The knowledge-gain math (single definition, frozen at record time)
// ---------------------------------------------------------------------------

describe('assessKnowledgeGain', () => {
  it('computes the signed delta and the direction', () => {
    const gain = assessKnowledgeGain(0.1, 0.55);
    expect(gain.knowledgeGain).toBeCloseTo(0.45, 12);
    expect(gain.direction).toBe('gain');

    const loss = assessKnowledgeGain(0.8, 0.2);
    expect(loss.knowledgeGain).toBeCloseTo(-0.6, 12);
    expect(loss.direction).toBe('loss');

    const flat = assessKnowledgeGain(0.5, 0.5);
    expect(flat.knowledgeGain).toBe(0);
    expect(flat.direction).toBe('flat');
  });

  it('covers the full-scale extremes deterministically', () => {
    expect(assessKnowledgeGain(0, 1)).toEqual({ knowledgeGain: 1, direction: 'gain' });
    expect(assessKnowledgeGain(1, 0)).toEqual({ knowledgeGain: -1, direction: 'loss' });
    expect(assessKnowledgeGain(0, 0)).toEqual({ knowledgeGain: 0, direction: 'flat' });
    expect(assessKnowledgeGain(1, 1)).toEqual({ knowledgeGain: 0, direction: 'flat' });
  });

  it('is deterministic: the same inputs always produce the same result', () => {
    const first = assessKnowledgeGain(0.25, 0.9);
    const second = assessKnowledgeGain(0.25, 0.9);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe('guards and escapeLike', () => {
  it('the vocabulary guards match only their members', () => {
    expect(isContributionStatus('measured')).toBe(true);
    expect(isContributionStatus('open')).toBe(false);
    expect(isValidationOutcome('contradicted')).toBe(true);
    expect(isValidationOutcome('validated ')).toBe(false);
    expect(isMissionImpactKind('no_effect')).toBe(true);
    expect(isMissionImpactKind('no-effect')).toBe(false);
    expect(isContributionPartyKind('external')).toBe(true);
    expect(isContributionPartyKind('provider')).toBe(false);
    expect(isContributionEvidenceKind('metric')).toBe(true);
    expect(isContributionEvidenceKind('vibe')).toBe(false);
    expect(isAvoidedPathAction('run-analysis')).toBe(true);
    expect(isAvoidedPathAction('run-analysises')).toBe(false);
  });

  it('isUuid accepts canonical uuids only', () => {
    expect(isUuid(CONTRIBUTION_ID)).toBe(true);
    expect(isUuid(CONTRIBUTION_ID.toUpperCase())).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('escapeLike escapes LIKE metacharacters', () => {
    expect(escapeLike('100%_\\churn')).toBe('100\\%\\_\\\\churn');
    expect(escapeLike('plain')).toBe('plain');
  });
});

/** A fresh uuid-shaped string for cap tests (never inserted anywhere). */
function newIdish(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
