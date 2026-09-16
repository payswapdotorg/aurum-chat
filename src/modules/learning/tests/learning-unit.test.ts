// Unit tests for the learning module's pure validation/normalization logic
// and the expected-versus-realized math (no database). Covers every guard a
// caller crosses before storage:
//
//  * tenant-context shape (invalid_context);
//  * define-input validation — subject tie (the four W040 subject kinds,
//    REQUIRED uuid id — the tie must be precise), metric name/unit bounds,
//    direction vocabulary, baseline/expected as bounded finite metric
//    values, optional real-calendar ISO horizon, affected-goal refs (uuid +
//    unique + capped), originating execution uuid, traceable actor,
//    defaults, and unknown-key rejection including the system-minted fields
//    (id, tenantId, status, realization, measurementCount,
//    latestMeasurement, recordedAt);
//  * measurement input validation — value bounds, note, traceable evidence
//    refs (kind vocabulary, uuid-or-label, capped), actor;
//  * settlement/abandonment input validation — settlement requires a
//    measurement uuid (realization is evidence-grounded), abandonment
//    requires a reason;
//  * list/measurements/summarize query validation — subjectId requires
//    subjectKind, assessment requires settled status, bounded limit;
//  * assessRealization — the single deterministic definition of
//    expected-versus-realized: direction-aware met/exceeded/missed,
//    variance vs expected and improvement vs baseline, including exact
//    equality, negative metrics and at_most inversions.
//
// The cognition-contract existence check for originExecutionId is a
// service-level concern (it needs the db) and is covered by the service
// tests.

import { describe, expect, it } from 'vitest';
import { LearningError } from '../errors';
import type {
  AbandonOutcomeInput,
  DefineOutcomeInput,
  RecordMeasurementInput,
  SettleOutcomeInput,
} from '../types';
import {
  assessRealization,
  assertLearningTenantContext,
  escapeLike,
  isOutcomeAssessment,
  isOutcomeDirection,
  isOutcomeEvidenceKind,
  isOutcomePartyKind,
  isOutcomeStatus,
  isOutcomeSubjectKind,
  isUuid,
  OUTCOME_SUBJECT_KINDS,
  validateAbandonOutcomeInput,
  validateDefineOutcomeInput,
  validateListMeasurementsQuery,
  validateListOutcomesQuery,
  validateRecordMeasurementInput,
  validateSettleOutcomeInput,
  validateSummarizeRealizationQuery,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const GOAL_ID = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const GOAL_ID_2 = '2d4b0a5c-3e6d-4fac-9b5a-9c4d8e7f6a1b';
const EXECUTION_ID = '6e8f4a2c-7b9d-4c3e-8d1a-2f4a6b8c0d2e';
const RECOMMENDATION_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';
const MEASUREMENT_ID = '8a0b6c4e-9d2f-4e5a-8f3c-4b6d8e0f2a4b';
const OUTCOME_ID = '9b1c7d5f-0e3a-4f6b-9a4d-5c7e9f1a3b5c';
const OBSERVATION_ID = 'ac2d8e6a-1f4b-4a7c-8b5e-6d8f0a2c4e6d';

/** A full W040 definition, parameterized for the suites below. */
function defineInput(overrides: Partial<DefineOutcomeInput> = {}): DefineOutcomeInput {
  return {
    subject: { kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Churn play' },
    metricName: 'monthly churn rate',
    metricUnit: 'percent',
    direction: 'at_most',
    baseline: 8.4,
    expected: 6.0,
    horizon: '2027-03-31',
    affectedGoals: [{ goalId: GOAL_ID, label: 'Q4 churn reduction' }],
    originExecutionId: EXECUTION_ID,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'cognition-2026-09 churn cycle',
    ...overrides,
  };
}

function measurementInput(overrides: Partial<RecordMeasurementInput> = {}): RecordMeasurementInput {
  return {
    outcomeId: OUTCOME_ID,
    value: 6.2,
    note: 'February cohort export',
    evidence: [{ kind: 'observation', id: OBSERVATION_ID, label: 'billing churn export' }],
    actor: { kind: 'system', label: 'metrics-warehouse' },
    ...overrides,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

describe('assertLearningTenantContext', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertLearningTenantContext({
        tenantId: 't',
        principalId: 'p',
        authority: ['x'],
      }),
    ).not.toThrow();
  });

  it('rejects blank tenant/principal and non-array authority', () => {
    expectCode('invalid_context', () =>
      assertLearningTenantContext({ tenantId: ' ', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertLearningTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertLearningTenantContext({ tenantId: 't', principalId: 'p', authority: 'none' as unknown as string[] }),
    );
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('type guards and helpers', () => {
  it('guards every vocabulary', () => {
    for (const kind of OUTCOME_SUBJECT_KINDS) {
      expect(isOutcomeSubjectKind(kind)).toBe(true);
    }
    expect(isOutcomeSubjectKind('opportunity')).toBe(false); // not a W040 subject
    expect(isOutcomeDirection('at_least')).toBe(true);
    expect(isOutcomeDirection('at_most')).toBe(true);
    expect(isOutcomeDirection('higher_is_better')).toBe(false);
    for (const status of ['open', 'settled', 'abandoned'] as const) {
      expect(isOutcomeStatus(status)).toBe(true);
    }
    expect(isOutcomeStatus('completed')).toBe(false); // missions vocabulary, not outcomes
    for (const assessment of ['met', 'exceeded', 'missed'] as const) {
      expect(isOutcomeAssessment(assessment)).toBe(true);
    }
    expect(isOutcomeAssessment('achieved')).toBe(false);
    for (const kind of ['person', 'team', 'agent', 'system', 'external'] as const) {
      expect(isOutcomePartyKind(kind)).toBe(true);
    }
    expect(isOutcomePartyKind('manager')).toBe(false);
    for (const kind of ['observation', 'event', 'document', 'report', 'system', 'metric'] as const) {
      expect(isOutcomeEvidenceKind(kind)).toBe(true);
    }
    expect(isOutcomeEvidenceKind('provider')).toBe(false);
  });

  it('guards uuid shape and escapes LIKE metacharacters', () => {
    expect(isUuid(RECOMMENDATION_ID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(escapeLike('50%_of\\us')).toBe('50\\%\\_of\\\\us');
  });
});

// ---------------------------------------------------------------------------
// defineOutcome input
// ---------------------------------------------------------------------------

describe('validateDefineOutcomeInput', () => {
  it('normalizes a full definition and round-trips every field', () => {
    const valid = validateDefineOutcomeInput(defineInput());
    expect(valid.subject).toEqual({ kind: 'recommendation', id: RECOMMENDATION_ID, label: 'Churn play' });
    expect(valid.metricName).toBe('monthly churn rate');
    expect(valid.metricUnit).toBe('percent');
    expect(valid.direction).toBe('at_most');
    expect(valid.baseline).toBe(8.4);
    expect(valid.expected).toBe(6.0);
    expect(valid.horizon).toBe('2027-03-31');
    expect(valid.affectedGoals).toEqual([{ goalId: GOAL_ID, label: 'Q4 churn reduction' }]);
    expect(valid.originExecutionId).toBe(EXECUTION_ID);
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(valid.rationale).toBe('cognition-2026-09 churn cycle');
  });

  it('applies defaults: no goals, no horizon, no origin, no rationale', () => {
    const valid = validateDefineOutcomeInput(
      defineInput({ affectedGoals: undefined, horizon: undefined, originExecutionId: undefined, rationale: undefined }),
    );
    expect(valid.affectedGoals).toEqual([]);
    expect(valid.horizon).toBeNull();
    expect(valid.originExecutionId).toBeNull();
    expect(valid.rationale).toBeNull();
  });

  it('accepts every W040 subject kind and clears an optional label', () => {
    for (const kind of ['recommendation', 'agent', 'extension', 'mission'] as const) {
      const valid = validateDefineOutcomeInput(defineInput({ subject: { kind, id: RECOMMENDATION_ID } }));
      expect(valid.subject.kind).toBe(kind);
      expect(valid.subject.label).toBeNull();
    }
  });

  it('rejects a subject without a precise uuid id (the tie must be precise)', () => {
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ subject: { kind: 'agent', id: 'agent-one' } })),
    );
    // a label alone is NOT a tie — the id is required
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ subject: { kind: 'agent', label: 'Collections agent' } as never })),
    );
  });

  it('rejects non-object or non-string subjects and unknown subject kinds', () => {
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ subject: 'agent' as unknown as DefineOutcomeInput['subject'] })),
    );
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ subject: { kind: 'opportunity', id: RECOMMENDATION_ID } as never })),
    );
  });

  it('rejects blank/oversized metric names and units', () => {
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ metricName: '   ' })));
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ metricName: 'x'.repeat(201) })));
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ metricUnit: '' })));
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ metricUnit: 'y'.repeat(101) })));
  });

  it('rejects an unknown direction', () => {
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ direction: 'maximize' as never })),
    );
  });

  it('rejects non-finite and out-of-envelope baseline/expected values', () => {
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ baseline: Number.NaN })));
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ baseline: Number.POSITIVE_INFINITY })));
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ expected: '6' as unknown as number })));
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ expected: 9_007_199_254_740_992 })),
    );
    // negative values are legal metrics (debt, latency deltas, net variance)
    expect(validateDefineOutcomeInput(defineInput({ baseline: -12.5, expected: -10 })).baseline).toBe(-12.5);
  });

  it('accepts only real calendar dates as the horizon', () => {
    expect(validateDefineOutcomeInput(defineInput({ horizon: '2028-02-29' })).horizon).toBe('2028-02-29'); // leap year
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ horizon: '2027-02-29' }))); // not a leap year
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ horizon: '2027-13-01' })));
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput(defineInput({ horizon: 'March 2027' })));
    expect(validateDefineOutcomeInput(defineInput({ horizon: null })).horizon).toBeNull();
  });

  it('validates affected-goal refs: uuid, unique, capped, optional labels', () => {
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ affectedGoals: [{ goalId: 'goal-1' }] })),
    );
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(
        defineInput({ affectedGoals: [{ goalId: GOAL_ID }, { goalId: GOAL_ID }] }),
      ),
    );
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput({
        affectedGoals: Array.from({ length: 17 }, () => ({ goalId: GOAL_ID })),
      }),
    );
    const valid = validateDefineOutcomeInput(defineInput({ affectedGoals: [{ goalId: GOAL_ID }, { goalId: GOAL_ID_2 }] }));
    expect(valid.affectedGoals).toHaveLength(2);
  });

  it('requires a uuid originating execution or null', () => {
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ originExecutionId: 'exec-1' })),
    );
    expect(validateDefineOutcomeInput(defineInput({ originExecutionId: null })).originExecutionId).toBeNull();
  });

  it('requires a traceable actor', () => {
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ actor: { kind: 'person' } })),
    );
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput(defineInput({ actor: { kind: 'manager', id: PERSON_ID } as never })),
    );
    // a label alone is traceable
    expect(validateDefineOutcomeInput(defineInput({ actor: { kind: 'system', label: 'cognition' } })).actor).toEqual({
      kind: 'system',
      id: null,
      label: 'cognition',
    });
  });

  it('rejects unknown keys, including every system-minted field', () => {
    for (const key of ['id', 'tenantId', 'status', 'realization', 'measurementCount', 'latestMeasurement', 'createdAt']) {
      expectCode('invalid_outcome_input', () =>
        validateDefineOutcomeInput(defineInput({ [key]: 'x' as never })),
      );
    }
    expectCode('invalid_outcome_input', () => validateDefineOutcomeInput('not an object'));
    expectCode('invalid_outcome_input', () =>
      validateDefineOutcomeInput({ ...defineInput(), revision: 2 } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// recordMeasurement input
// ---------------------------------------------------------------------------

describe('validateRecordMeasurementInput', () => {
  it('round-trips a full measurement and applies defaults', () => {
    const valid = validateRecordMeasurementInput(measurementInput());
    expect(valid.outcomeId).toBe(OUTCOME_ID);
    expect(valid.value).toBe(6.2);
    expect(valid.note).toBe('February cohort export');
    expect(valid.evidence).toEqual([{ kind: 'observation', id: OBSERVATION_ID, label: 'billing churn export' }]);
    expect(valid.actor).toEqual({ kind: 'system', id: null, label: 'metrics-warehouse' });

    const minimal = validateRecordMeasurementInput({
      outcomeId: OUTCOME_ID,
      value: 0,
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(minimal.note).toBeNull();
    expect(minimal.evidence).toEqual([]);
  });

  it('rejects a non-uuid outcome, bad values and oversized notes', () => {
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ outcomeId: 'outcome-1' })),
    );
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ value: Number.NaN })),
    );
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ value: 1e16 })),
    );
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ note: 'n'.repeat(2001) })),
    );
  });

  it('validates evidence refs: traceable, capped, known kinds', () => {
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ evidence: [{ kind: 'observation' }] })),
    );
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ evidence: [{ kind: 'provider', label: 'x' } as never] })),
    );
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput(measurementInput({ evidence: [{ kind: 'metric', id: 'not-uuid' }] })),
    );
    expectCode('invalid_measurement_input', () =>
      validateRecordMeasurementInput({
        evidence: Array.from({ length: 9 }, () => ({ kind: 'metric', label: 'm' })),
      }),
    );
    // an id alone is traceable
    expect(
      validateRecordMeasurementInput(measurementInput({ evidence: [{ kind: 'event', id: OBSERVATION_ID }] })).evidence,
    ).toEqual([{ kind: 'event', id: OBSERVATION_ID, label: null }]);
  });

  it('rejects unknown keys including system-minted fields', () => {
    for (const key of ['id', 'tenantId', 'recordedAt', 'recordedByPrincipal']) {
      expectCode('invalid_measurement_input', () =>
        validateRecordMeasurementInput(measurementInput({ [key]: 'x' as never })),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// settleOutcome / abandonOutcome input
// ---------------------------------------------------------------------------

describe('validateSettleOutcomeInput', () => {
  it('round-trips a settlement (realization is evidence-grounded by shape)', () => {
    const valid = validateSettleOutcomeInput({
      outcomeId: OUTCOME_ID,
      measurementId: MEASUREMENT_ID,
      note: 'final cohort reading',
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(valid).toEqual({
      outcomeId: OUTCOME_ID,
      measurementId: MEASUREMENT_ID,
      note: 'final cohort reading',
      actor: { kind: 'person', id: PERSON_ID, label: null },
    });
  });

  it('requires uuids and a traceable actor', () => {
    const base: SettleOutcomeInput = {
      outcomeId: OUTCOME_ID,
      measurementId: MEASUREMENT_ID,
      actor: { kind: 'person', id: PERSON_ID },
    };
    expectCode('invalid_settlement_input', () =>
      validateSettleOutcomeInput({ ...base, measurementId: 'measurement-1' }),
    );
    expectCode('invalid_settlement_input', () =>
      validateSettleOutcomeInput({ ...base, outcomeId: 42 as never }),
    );
    expectCode('invalid_settlement_input', () =>
      validateSettleOutcomeInput({ ...base, actor: { kind: 'team' } }),
    );
  });

  it('rejects unknown keys including the realized value (never caller-supplied)', () => {
    expectCode('invalid_settlement_input', () =>
      validateSettleOutcomeInput({
        outcomeId: OUTCOME_ID,
        measurementId: MEASUREMENT_ID,
        actor: { kind: 'person', id: PERSON_ID },
        realizedValue: 5.9,
      } as never),
    );
  });
});

describe('validateAbandonOutcomeInput', () => {
  it('round-trips an abandonment with its required reason', () => {
    const valid = validateAbandonOutcomeInput({
      outcomeId: OUTCOME_ID,
      reason: '  the subject was withdrawn  ',
      actor: { kind: 'person', id: PERSON_ID },
    } satisfies AbandonOutcomeInput);
    expect(valid.reason).toBe('the subject was withdrawn');
  });

  it('requires a non-empty bounded reason and uuid outcome', () => {
    expectCode('invalid_abandonment_input', () =>
      validateAbandonOutcomeInput({ outcomeId: OUTCOME_ID, reason: '   ', actor: { kind: 'person', id: PERSON_ID } }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonOutcomeInput({ outcomeId: OUTCOME_ID, reason: 'r'.repeat(2001), actor: { kind: 'person', id: PERSON_ID } }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonOutcomeInput({ outcomeId: 'x', reason: 'why', actor: { kind: 'person', id: PERSON_ID } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('validates list filters and their pairings', () => {
    expect(validateListOutcomesQuery({})).toMatchObject({
      subjectKind: null,
      subjectId: null,
      status: null,
      assessment: null,
      limit: 50,
    });
    expectCode('invalid_query', () => validateListOutcomesQuery({ subjectId: RECOMMENDATION_ID }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ subjectKind: 'vendor' as never }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ status: 'completed' as never }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ assessment: 'met', status: 'open' }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ assessment: 'met', status: 'abandoned' }));
    expect(validateListOutcomesQuery({ assessment: 'met', status: 'settled' })).toMatchObject({
      assessment: 'met',
      status: 'settled',
    });
    expectCode('invalid_query', () => validateListOutcomesQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ search: 's'.repeat(201) }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ affectedGoalId: 'goal-1' }));
    expectCode('invalid_query', () => validateListOutcomesQuery({ originExecutionId: 'exec-1' }));
  });

  it('validates the measurements and summarize queries', () => {
    expectCode('invalid_query', () => validateListMeasurementsQuery({}));
    expect(validateListMeasurementsQuery({ outcomeId: OUTCOME_ID })).toEqual({ outcomeId: OUTCOME_ID });
    expect(validateSummarizeRealizationQuery({})).toEqual({ subjectKind: null });
    expect(validateSummarizeRealizationQuery({ subjectKind: 'agent' })).toEqual({ subjectKind: 'agent' });
    expectCode('invalid_query', () => validateSummarizeRealizationQuery({ subjectKind: 'vendor' as never }));
    expectCode('invalid_query', () => validateSummarizeRealizationQuery({ subjectKind: 'agent', status: 'open' }));
  });
});

// ---------------------------------------------------------------------------
// The expected-versus-realized math
// ---------------------------------------------------------------------------

describe('assessRealization', () => {
  it('at_least: higher is better — exceeded / met / missed', () => {
    expect(assessRealization('at_least', 10, 20, 25)).toEqual({
      varianceVsExpected: 5,
      improvementVsBaseline: 15,
      assessment: 'exceeded',
    });
    expect(assessRealization('at_least', 10, 20, 20)).toEqual({
      varianceVsExpected: 0,
      improvementVsBaseline: 10,
      assessment: 'met',
    });
    const missed = assessRealization('at_least', 10, 20, 19.9);
    expect(missed.assessment).toBe('missed');
    expect(missed.varianceVsExpected).toBeCloseTo(-0.1, 10);
    expect(missed.improvementVsBaseline).toBeCloseTo(9.9, 10);
  });

  it('at_most: lower is better — the polarity inverts', () => {
    const exceeded = assessRealization('at_most', 8.4, 6.0, 5.1);
    expect(exceeded.assessment).toBe('exceeded');
    expect(exceeded.varianceVsExpected).toBeCloseTo(-0.9, 10);
    expect(exceeded.improvementVsBaseline).toBeCloseTo(-3.3, 10);
    const met = assessRealization('at_most', 8.4, 6.0, 6.0);
    expect(met.assessment).toBe('met');
    expect(met.varianceVsExpected).toBe(0);
    expect(met.improvementVsBaseline).toBeCloseTo(-2.4, 10);
    const missed = assessRealization('at_most', 8.4, 6.0, 6.1);
    expect(missed.assessment).toBe('missed');
    expect(missed.varianceVsExpected).toBeCloseTo(0.1, 10);
    expect(missed.improvementVsBaseline).toBeCloseTo(-2.3, 10);
  });

  it('is direction-aware even when improvement and variance disagree', () => {
    // Realized 7 is an improvement over the 10 baseline but misses the
    // at-least expectation of 8 — both facts are retained.
    const result = assessRealization('at_least', 10, 8, 7);
    expect(result.assessment).toBe('missed');
    expect(result.varianceVsExpected).toBe(-1);
    expect(result.improvementVsBaseline).toBe(-3);
    // Realized 9 beats the at-most expectation of 10 even though it is
    // worse than the 7 baseline.
    const inverted = assessRealization('at_most', 7, 10, 9);
    expect(inverted.assessment).toBe('exceeded');
    expect(inverted.improvementVsBaseline).toBe(2);
  });

  it('works on negative metrics and exact zero crossings', () => {
    expect(assessRealization('at_least', -5, 0, 0).assessment).toBe('met');
    expect(assessRealization('at_most', 3, 0, -0.5).assessment).toBe('exceeded');
    expect(assessRealization('at_least', -5, 0, -0.001).varianceVsExpected).toBeCloseTo(-0.001, 10);
  });

  it('is deterministic and pure (the frozen single definition)', () => {
    const args = ['at_most', 8.4, 6.0, 5.1] as const;
    expect(assessRealization(...args)).toEqual(assessRealization(...args));
  });
});
