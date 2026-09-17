// Unit tests for the outcomes module's pure validation/normalization logic
// and the intervention-prior math (no database). Covers every guard a
// caller crosses before storage:
//
//  * tenant-context shape (invalid_context);
//  * the capability-key normalizer — the ONE deterministic way similarity
//    keys form (case, surrounding/inner whitespace, underscores, hyphen
//    collapsing, edge stripping, idempotence, emptiness rejection);
//  * record-input validation — the eight §13 intervention kinds, capability
//    label bounds and key derivability, opaque target shape (open kind
//    slug, uuid-or-label traceability), originating-goal refs (uuid +
//    unique + capped), opaque recommendation/authorization/execution
//    references, the ONE validated cross-module outcome uuid, traceable
//    actor, and the origin-link rule (at least one originating link or a
//    target — an intervention must be traceable to where it came from),
//    plus unknown-key rejection including the system-minted fields (id,
//    tenantId, status, polarity, realization, metric, capabilityKey,
//    createdAt);
//  * realize/abandon input validation — abandonment requires a reason;
//  * query validation — status/polarity consistency (polarity only with
//    realized), key normalization at query time, bounded limits;
//  * computePriorUpdate — the single deterministic definition of the
//    learning update: success/failure polarity counting, success rate,
//    expected/realized sums, net and mean variance, evidence-id ordering
//    and uniqueness, empty-sample and duplicate-sample rejection;
//  * priorRecommendationSignal — the single deterministic definition of
//    the recommendation-quality signal: stance thresholds (favor/mixed/
//    caution), evidence-strength bands, and sample-consistency rejection.
//
// The learning-contract existence check for outcomeId is a service-level
// concern (it needs the db) and is covered by the service tests.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { OutcomesError } from '../errors';
import type {
  AbandonInterventionInput,
  RealizeInterventionInput,
  RecordInterventionInput,
} from '../types';
import type { PriorSampleEntry } from '../validation';
import {
  assertOutcomesTenantContext,
  computePriorUpdate,
  isEvidencePolarity,
  isInterventionAssessment,
  isInterventionKind,
  isInterventionStatus,
  isUuid,
  normalizeCapabilityKey,
  priorRecommendationSignal,
  validateAbandonInterventionInput,
  validateGetInterventionPriorsQuery,
  validateListInterventionPriorVersionsQuery,
  validateListInterventionsQuery,
  validateRealizeInterventionInput,
  validateRecordInterventionInput,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const GOAL_ID_1 = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const GOAL_ID_2 = '2d4b0a5c-3e6d-4fac-9b5a-9c4d8e7f6a1b';
const OUTCOME_ID = '7f9a5b3d-8c1e-4d4f-9e2b-3a5c7d9e1f3a';
const RECOMMENDATION_ID = '3c5e1a7f-4b6d-4c8e-9d0a-1e3f5a7c9e1b';

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OutcomesError);
    expect((error as OutcomesError).code).toBe(code);
  }
}

function recordInput(overrides: Partial<RecordInterventionInput> = {}): RecordInterventionInput {
  return {
    kind: 'recruit_agent',
    capabilityLabel: 'Invoice Processing',
    target: { kind: 'recruitment_proposal', id: PERSON_ID, label: 'Proposal #12' },
    originGoalIds: [{ goalId: GOAL_ID_1, label: 'AP efficiency' }],
    originRecommendationId: RECOMMENDATION_ID,
    authorizationRef: { kind: 'action_request', label: 'approval #7' },
    originExecutionId: null,
    outcomeId: OUTCOME_ID,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'cognition-2026-10 capability gap cycle',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The capability-key normalizer
// ---------------------------------------------------------------------------

describe('normalizeCapabilityKey', () => {
  it('lowercases, trims and collapses whitespace/underscores into hyphens', () => {
    expect(normalizeCapabilityKey('Invoice Processing')).toBe('invoice-processing');
    expect(normalizeCapabilityKey('  Invoice   Processing  ')).toBe('invoice-processing');
    expect(normalizeCapabilityKey('Invoice_processing')).toBe('invoice-processing');
    expect(normalizeCapabilityKey('invoice--__processing')).toBe('invoice-processing');
    expect(normalizeCapabilityKey('---Invoice Processing---')).toBe('invoice-processing');
  });

  it('is idempotent and keeps non-whitespace punctuation as-is', () => {
    const key = normalizeCapabilityKey('AP Automation (v2)');
    expect(normalizeCapabilityKey(key)).toBe(key);
    expect(key).toBe('ap-automation-(v2)');
  });

  it('collapses to empty for blank/dash-only labels (record input rejects that)', () => {
    expect(normalizeCapabilityKey('   ')).toBe('');
    expect(normalizeCapabilityKey(' -- __ ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// recordIntervention input
// ---------------------------------------------------------------------------

describe('validateRecordInterventionInput', () => {
  it('accepts the full shape and derives the normalized key', () => {
    const valid = validateRecordInterventionInput(recordInput());
    expect(valid.kind).toBe('recruit_agent');
    expect(valid.capabilityLabel).toBe('Invoice Processing');
    expect(valid.capabilityKey).toBe('invoice-processing');
    expect(valid.target).toEqual({
      kind: 'recruitment_proposal',
      id: PERSON_ID,
      label: 'Proposal #12',
    });
    expect(valid.originGoalIds).toEqual([{ goalId: GOAL_ID_1, label: 'AP efficiency' }]);
    expect(valid.originRecommendationId).toBe(RECOMMENDATION_ID);
    expect(valid.authorizationRef).toEqual({ kind: 'action_request', id: null, label: 'approval #7' });
    expect(valid.outcomeId).toBe(OUTCOME_ID);
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(valid.rationale).toBe('cognition-2026-10 capability gap cycle');
  });

  it('accepts every §13 acquisition-option kind', () => {
    const kinds = [
      'train_employee',
      'reassign_work',
      'hire_human',
      'recruit_agent',
      'recruit_agent_team',
      'install_extension',
      'build_extension',
      'outsource',
    ] as const;
    for (const kind of kinds) {
      expect(validateRecordInterventionInput(recordInput({ kind })).kind).toBe(kind);
    }
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ kind: 'reorg_company' as never })),
    );
  });

  it('rejects labels that normalize to nothing or past the key cap', () => {
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ capabilityLabel: '  --  ' })),
    );
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ capabilityLabel: 'x'.repeat(201) })),
    );
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({ capabilityLabel: `a ${'b'.repeat(130)} c` }),
        ),
    );
  });

  it('validates the opaque target: open slug, uuid-or-label traceability', () => {
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ target: { kind: 'agent_team' } })),
    );
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({ target: { kind: 'agent_team', id: 'not-a-uuid' } }),
        ),
    );
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({ target: { kind: 'x'.repeat(61), label: 'team' } }),
        ),
    );
    // null target is fine (an origin link still present below)
    expect(validateRecordInterventionInput(recordInput({ target: null })).target).toBeNull();
  });

  it('validates originating-goal refs: uuid, unique, capped', () => {
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({ originGoalIds: [{ goalId: 'nope' }] }),
        ),
    );
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({
            originGoalIds: [
              { goalId: GOAL_ID_1 },
              { goalId: GOAL_ID_1 },
            ],
          }),
        ),
    );
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({
            originGoalIds: Array.from({ length: 17 }, () => ({ goalId: GOAL_ID_1 })),
          }),
        ),
    );
    expect(
      validateRecordInterventionInput(
        recordInput({
          originGoalIds: [
            { goalId: GOAL_ID_1 },
            { goalId: GOAL_ID_2, label: 'Ops throughput' },
          ],
        }),
      ).originGoalIds,
    ).toEqual([
      { goalId: GOAL_ID_1, label: null },
      { goalId: GOAL_ID_2, label: 'Ops throughput' },
    ]);
  });

  it('requires at least one originating link or target (traceable origin)', () => {
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(
          recordInput({
            target: null,
            originGoalIds: [],
            originRecommendationId: null,
            authorizationRef: null,
            originExecutionId: null,
          }),
        ),
    );
    // each single link alone satisfies the rule
    expect(
      validateRecordInterventionInput(
        recordInput({
          target: null,
          originGoalIds: [],
          originRecommendationId: RECOMMENDATION_ID,
          authorizationRef: null,
          originExecutionId: null,
        }),
      ).originRecommendationId,
    ).toBe(RECOMMENDATION_ID);
    expect(
      validateRecordInterventionInput(
        recordInput({
          target: null,
          originGoalIds: [],
          originRecommendationId: null,
          authorizationRef: { kind: 'action_request', label: 'approval #7' },
          originExecutionId: null,
        }),
      ).authorizationRef,
    ).toEqual({ kind: 'action_request', id: null, label: 'approval #7' });
  });

  it('validates outcome/execution/recommendation uuids and the traceable actor', () => {
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ outcomeId: 'not-a-uuid' })),
    );
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ originExecutionId: 'nope' as never })),
    );
    expectCode(
      'invalid_intervention_input',
      () =>
        validateRecordInterventionInput(recordInput({ originRecommendationId: 'nope' as never })),
    );
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ actor: { kind: 'vendor' } as never })),
    );
    expectCode(
      'invalid_intervention_input',
      () => validateRecordInterventionInput(recordInput({ actor: { kind: 'person' } })),
    );
  });

  it('rejects unknown keys — including every system-minted field', () => {
    for (const smuggled of [
      'id',
      'tenantId',
      'status',
      'polarity',
      'realization',
      'metric',
      'capabilityKey',
      'createdAt',
      'recordedByPrincipal',
    ]) {
      expectCode('invalid_intervention_input', () =>
        validateRecordInterventionInput({ ...recordInput(), [smuggled]: 'smuggled' }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// realize / abandon inputs
// ---------------------------------------------------------------------------

describe('validateRealize/AbandonInterventionInput', () => {
  const realize: RealizeInterventionInput = {
    interventionId: OUTCOME_ID,
    note: 'post-mortem attached',
    actor: { kind: 'system', label: 'outcomes-worker' },
  };
  const abandon: AbandonInterventionInput = {
    interventionId: OUTCOME_ID,
    reason: 'scope withdrawn',
    actor: { kind: 'person', id: PERSON_ID },
  };

  it('accepts and normalizes both shapes', () => {
    expect(validateRealizeInterventionInput(realize)).toEqual({
      interventionId: OUTCOME_ID,
      note: 'post-mortem attached',
      actor: { kind: 'system', id: null, label: 'outcomes-worker' },
    });
    expect(validateAbandonInterventionInput(abandon)).toEqual({
      interventionId: OUTCOME_ID,
      reason: 'scope withdrawn',
      actor: { kind: 'person', id: PERSON_ID, label: null },
    });
  });

  it('requires the intervention uuid, a traceable actor and an abandonment reason', () => {
    expectCode('invalid_realization_input', () =>
      validateRealizeInterventionInput({ ...realize, interventionId: 'nope' }),
    );
    expectCode('invalid_realization_input', () =>
      validateRealizeInterventionInput({ ...realize, actor: { kind: 'team' } }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonInterventionInput({ ...abandon, reason: '   ' }),
    );
    expectCode('invalid_abandonment_input', () =>
      validateAbandonInterventionInput({ ...abandon, interventionId: 'nope' }),
    );
    // realize notes are optional
    expect(validateRealizeInterventionInput({ ...realize, note: null }).note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('listInterventions: normalizes keys, enforces polarity-with-realized, bounds limits', () => {
    const valid = validateListInterventionsQuery({
      interventionKind: 'build_extension',
      capabilityKey: '  Report Generation ',
      status: 'realized',
      polarity: 'negative',
      limit: 10,
    });
    expect(valid.capabilityKey).toBe('report-generation');
    expect(valid.polarity).toBe('negative');

    expectCode('invalid_query', () =>
      validateListInterventionsQuery({ status: 'active', polarity: 'negative' }),
    );
    expectCode('invalid_query', () =>
      validateListInterventionsQuery({ interventionKind: 'reorg' as never }),
    );
    expectCode('invalid_query', () => validateListInterventionsQuery({ status: 'zombie' as never }));
    expectCode('invalid_query', () => validateListInterventionsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListInterventionsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListInterventionsQuery({ capabilityKey: '  ' }));
    expect(validateListInterventionsQuery({}).limit).toBe(50);
  });

  it('getInterventionPriors: optional kind/key, bounded limit', () => {
    const valid = validateGetInterventionPriorsQuery({ capabilityKey: 'Invoice Processing' });
    expect(valid.interventionKind).toBeNull();
    expect(valid.capabilityKey).toBe('invoice-processing');
    expectCode('invalid_query', () => validateGetInterventionPriorsQuery({ limit: -1 }));
    expectCode('invalid_query', () =>
      validateGetInterventionPriorsQuery({ interventionKind: 'nope' as never }),
    );
  });

  it('listInterventionPriorVersions: requires kind and key', () => {
    const valid = validateListInterventionPriorVersionsQuery({
      interventionKind: 'recruit_agent',
      capabilityKey: 'invoice processing',
    });
    expect(valid.capabilityKey).toBe('invoice-processing');
    expectCode('invalid_query', () => validateListInterventionPriorVersionsQuery({}));
    expectCode('invalid_query', () =>
      validateListInterventionPriorVersionsQuery({ interventionKind: 'recruit_agent' }),
    );
  });
});

// ---------------------------------------------------------------------------
// computePriorUpdate — the learning-update math
// ---------------------------------------------------------------------------

describe('computePriorUpdate', () => {
  const sample = (
    id: string,
    assessment: PriorSampleEntry['assessment'],
    expected: number,
    realizedValue: number,
  ): PriorSampleEntry => ({
    interventionId: id,
    assessment,
    expected,
    realizedValue,
    varianceVsExpected: realizedValue - expected,
  });

  it('counts polarity, rate, sums and mean variance over a mixed sample', () => {
    const aggregate = computePriorUpdate([
      sample(OUTCOME_ID, 'exceeded', 10, 12),
      sample(GOAL_ID_1, 'met', 8, 8),
      sample(GOAL_ID_2, 'missed', 8, 3),
    ]);
    expect(aggregate.sampleSize).toBe(3);
    expect(aggregate.successes).toBe(2);
    expect(aggregate.failures).toBe(1);
    expect(aggregate.successRate).toBeCloseTo(2 / 3, 12);
    expect(aggregate.expectedSum).toBe(26);
    expect(aggregate.realizedSum).toBe(23);
    expect(aggregate.netVariance).toBe(-3);
    expect(aggregate.meanVariance).toBe(-1);
    expect(aggregate.evidenceInterventionIds).toEqual([OUTCOME_ID, GOAL_ID_1, GOAL_ID_2]);
  });

  it('single-sample edge cases: all-success and all-failure', () => {
    const success = computePriorUpdate([sample(OUTCOME_ID, 'met', 5, 5)]);
    expect(success).toMatchObject({
      sampleSize: 1,
      successes: 1,
      failures: 0,
      successRate: 1,
      netVariance: 0,
      meanVariance: 0,
    });
    const failure = computePriorUpdate([sample(OUTCOME_ID, 'missed', 5, 2)]);
    expect(failure).toMatchObject({
      sampleSize: 1,
      successes: 0,
      failures: 1,
      successRate: 0,
      netVariance: -3,
      meanVariance: -3,
    });
  });

  it('rejects empty samples, duplicate ids and non-uuid ids', () => {
    expectCode('invalid_realization_input', () => computePriorUpdate([]));
    expectCode('invalid_realization_input', () =>
      computePriorUpdate([sample(OUTCOME_ID, 'met', 1, 1), sample(OUTCOME_ID, 'missed', 1, 0)]),
    );
    expectCode('invalid_realization_input', () =>
      computePriorUpdate([sample('not-a-uuid', 'met', 1, 1)]),
    );
  });

  it('rejects aggregates leaving the storable envelope', () => {
    // 1001 max-magnitude expectations sum past the ±9e18 aggregate
    // envelope (the per-metric cap is ~9.007e15).
    const huge = 9_007_199_254_740_991;
    const flood = Array.from({ length: 1001 }, () => sample(newId(), 'met', huge, huge));
    expectCode('invalid_realization_input', () => computePriorUpdate(flood));
  });
});

// ---------------------------------------------------------------------------
// priorRecommendationSignal — the recommendation-quality math
// ---------------------------------------------------------------------------

describe('priorRecommendationSignal', () => {
  it('derives stance from the success rate', () => {
    expect(priorRecommendationSignal({
      sampleSize: 4,
      successes: 3,
      failures: 1,
      successRate: 0.75,
      meanVariance: 1.5,
    })).toMatchObject({ stance: 'favor', strength: 'weak', successRate: 0.75, meanVariance: 1.5 });
    expect(
      priorRecommendationSignal({ sampleSize: 2, successes: 1, failures: 1, successRate: 0.5, meanVariance: 0 })
        .stance,
    ).toBe('mixed');
    expect(
      priorRecommendationSignal({ sampleSize: 1, successes: 0, failures: 1, successRate: 0, meanVariance: -3 })
        .stance,
    ).toBe('caution');
  });

  it('bands evidence strength by sample size', () => {
    const bands = [1, 2, 5, 20] as const;
    const expected = ['single_observation', 'weak', 'moderate', 'strong'] as const;
    bands.forEach((sampleSize, index) => {
      expect(
        priorRecommendationSignal({
          sampleSize,
          successes: sampleSize,
          failures: 0,
          successRate: 1,
          meanVariance: 0,
        }).strength,
      ).toBe(expected[index]);
    });
  });

  it('rejects inconsistent samples', () => {
    expectCode('invalid_query', () =>
      priorRecommendationSignal({ sampleSize: 0, successes: 0, failures: 0, successRate: 0, meanVariance: 0 }),
    );
    expectCode('invalid_query', () =>
      priorRecommendationSignal({ sampleSize: 3, successes: 1, failures: 1, successRate: 0.5, meanVariance: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Vocabulary guards + tenant context
// ---------------------------------------------------------------------------

describe('guards and context', () => {
  it('type-guards the vocabularies', () => {
    expect(isInterventionKind('outsource')).toBe(true);
    expect(isInterventionKind('reorg')).toBe(false);
    expect(isInterventionStatus('realized')).toBe(true);
    expect(isInterventionStatus('done')).toBe(false);
    expect(isInterventionAssessment('missed')).toBe(true);
    expect(isInterventionAssessment('bad')).toBe(false);
    expect(isEvidencePolarity('negative')).toBe(true);
    expect(isEvidencePolarity('bad')).toBe(false);
    expect(isUuid(OUTCOME_ID)).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });

  it('asserts the tenant-context shape', () => {
    expectCode('invalid_context', () =>
      assertOutcomesTenantContext({ tenantId: ' ', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertOutcomesTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertOutcomesTenantContext({ tenantId: 't', principalId: 'p', authority: 'nope' as never }),
    );
    expect(() =>
      assertOutcomesTenantContext({ tenantId: 't', principalId: 'p', authority: [] }),
    ).not.toThrow();
  });
});
