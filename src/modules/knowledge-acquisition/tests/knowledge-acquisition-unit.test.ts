// Unit tests for the knowledge-acquisition module's pure validation and
// ranking logic (no database). Covers every guard a caller crosses before
// storage, and the deterministic arithmetic ADR-0018 requires:
//
//  * tenant-context shape (invalid_context);
//  * plan-input validation — mission uuid, candidate signal sets (kind
//    vocabulary, traceable id/label, uuid ids, bounded labels, six [0,1]
//    signals, integer minor-unit cost, access vocabulary, duplicate
//    keys), actor shape, rationale bounds, unknown-key rejection
//    including the system-minted fields (decision, chosen, action,
//    question, askPolicy, ranked, budgetRemaining, estimatedCost,
//    missionVersion, plannedByPrincipal, recordedAt);
//  * outcome-input validation — plan uuid, outcome vocabulary, the
//    note-required rule for unavailable/failed, the evidence
//    required-on-answered / forbidden-otherwise rule, evidence shape
//    (non-null payload, confidence value/method/basis, strict ISO
//    observedAt);
//  * list-query validation;
//  * scoring — fixed weights arithmetic, cost share capping, dominant
//    signal, deterministic total ordering and its tie-breaks (score ↓,
//    §7 kind order, key ↑), selection = first eligible;
//  * targeted question composition — deterministic, derived from the
//    mission, addressed to the person;
//  * candidate key identity rules.
//
// The service-level checks (mission menu coverage, ask policy, person
// gates, budget, attempts, tenancy) need the database and are covered by
// the service tests.

import { describe, expect, it } from 'vitest';
import { KnowledgeAcquisitionError } from '../errors';
import type {
  CandidateSignals,
  PlanNextAcquisitionInput,
  RankedCandidate,
  RecordAcquisitionOutcomeInput,
} from '../types';
import {
  candidateKey,
  composeTargetedQuestion,
  computeCostShare,
  orderRankedCandidates,
  scoreCandidateSignals,
  SIGNAL_WEIGHTS,
} from '../ranking';
import {
  assertAcquisitionTenantContext,
  isAccessScope,
  isAcquisitionOutcomeKind,
  isPlanDecision,
  isUuid,
  validateListAcquisitionPlansQuery,
  validatePlanNextAcquisitionInput,
  validateRecordAcquisitionOutcomeInput,
} from '../validation';

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const PERSON_ID_2 = '5a7d3e9f-6b1c-4d2a-8e4b-3f5c7d9e1a2b';
const MISSION_ID = '7c9e1d3a-5f4b-4c8e-9a2d-6b7c8d9e0f1a';
const PLAN_ID = '8d0f2e4b-6a5c-4d9f-8b3e-7c8d9e0f1a2b';

function signals(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'person',
    id: PERSON_ID,
    label: 'VP Customer Success',
    relevance: 0.9,
    reliability: 0.8,
    freshness: 0.7,
    authority: 0.85,
    expectedQuality: 0.75,
    priorContributionValue: 0.4,
    cost: 0,
    access: 'allowed',
    ...overrides,
  };
}

function planInput(overrides: Record<string, unknown> = {}): PlanNextAcquisitionInput {
  return {
    missionId: MISSION_ID,
    candidates: [signals()],
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'goal-gap-2026-09',
    ...overrides,
  } as unknown as PlanNextAcquisitionInput;
}

function outcomeInput(overrides: Record<string, unknown> = {}): RecordAcquisitionOutcomeInput {
  return {
    planId: PLAN_ID,
    outcome: 'answered',
    evidence: {
      payload: { answer: 'The Q3 pricing change drove churn.' },
      confidence: { value: 0.8, method: 'source_trust' },
    },
    ...overrides,
  } as unknown as RecordAcquisitionOutcomeInput;
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeAcquisitionError);
    expect((error as KnowledgeAcquisitionError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

describe('assertAcquisitionTenantContext', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertAcquisitionTenantContext({ tenantId: MISSION_ID, principalId: PERSON_ID, authority: [] }),
    ).not.toThrow();
  });

  it('rejects malformed contexts', () => {
    expectCode('invalid_context', () => assertAcquisitionTenantContext({ tenantId: '', principalId: 'p', authority: [] }));
    expectCode('invalid_context', () => assertAcquisitionTenantContext({ tenantId: 't', principalId: ' ', authority: [] }));
    expectCode('invalid_context', () => assertAcquisitionTenantContext({ tenantId: 't', principalId: 'p', authority: 'none' as unknown as string[] }));
  });
});

// ---------------------------------------------------------------------------
// Plan input validation
// ---------------------------------------------------------------------------

describe('validatePlanNextAcquisitionInput', () => {
  it('normalizes a valid input (ids lowercased, labels trimmed, optionals nulled)', () => {
    const valid = validatePlanNextAcquisitionInput({
      missionId: MISSION_ID.toUpperCase(),
      candidates: [signals({ id: PERSON_ID.toUpperCase(), label: '  VP Customer Success  ' }) as unknown as CandidateSignals],
      actor: { kind: 'person', id: PERSON_ID_2, label: undefined },
      rationale: '  why  ',
    } as unknown as PlanNextAcquisitionInput);
    expect(valid.missionId).toBe(MISSION_ID);
    expect(valid.candidates[0]!.id).toBe(PERSON_ID);
    expect(valid.candidates[0]!.label).toBe('VP Customer Success');
    expect(valid.actor).toEqual({ kind: 'person', id: PERSON_ID_2, label: null });
    expect(valid.rationale).toBe('why');
  });

  it('rejects non-objects and unknown keys — including every system-minted field', () => {
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(null as unknown as PlanNextAcquisitionInput));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput({ ...planInput(), decision: 'selected' } as unknown as PlanNextAcquisitionInput));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput({ ...planInput(), chosen: { kind: 'person' } } as unknown as PlanNextAcquisitionInput));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput({ ...planInput(), question: 'hi' } as unknown as PlanNextAcquisitionInput));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput({ ...planInput(), ranked: [] } as unknown as PlanNextAcquisitionInput));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput({ ...planInput(), plannedByPrincipal: 'x' } as unknown as PlanNextAcquisitionInput));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput({ ...planInput(), recordedAt: '2026-01-01T00:00:00Z' } as unknown as PlanNextAcquisitionInput));
  });

  it('requires a uuid missionId', () => {
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ missionId: 'not-a-uuid' })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ missionId: '' })));
  });

  it('requires candidates to be an array within the cap', () => {
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: 'nope' })));
    const many = Array.from({ length: 17 }, () => signals({ label: `s${Math.random()}` }));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: many })));
  });

  it('validates one candidate signal set end to end', () => {
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), kind: 'android' }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), id: 'nope' }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), id: null, label: null }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), label: 'x'.repeat(201) }] })));
    for (const field of ['relevance', 'reliability', 'freshness', 'authority', 'expectedQuality', 'priorContributionValue']) {
      expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), [field]: 1.5 }] })));
      expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), [field]: 'high' }] })));
    }
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), cost: -1 }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), cost: 10.5 }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), cost: 9_007_199_254_740_992 }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), access: 'open' }] })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ candidates: [{ ...signals(), unknownField: 1 }] })));
  });

  it('rejects duplicate candidate keys (same candidate scored twice)', () => {
    expectCode('invalid_plan_input', () =>
      validatePlanNextAcquisitionInput(planInput({ candidates: [signals(), signals({ label: 'other label' })] })),
    );
  });

  it('validates the actor (vocabulary, traceability, uuid id, bounded label)', () => {
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ actor: { kind: 'robot' } })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ actor: { kind: 'system' } })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ actor: { kind: 'person', id: 'nope' } })));
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ actor: { kind: 'person', label: 'x'.repeat(201) } })));
  });

  it('bounds the rationale', () => {
    expectCode('invalid_plan_input', () => validatePlanNextAcquisitionInput(planInput({ rationale: 'x'.repeat(2001) })));
    expect(validatePlanNextAcquisitionInput(planInput({ rationale: null })).rationale).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcome input validation
// ---------------------------------------------------------------------------

describe('validateRecordAcquisitionOutcomeInput', () => {
  it('accepts an answered outcome with evidence and normalizes it', () => {
    const valid = validateRecordAcquisitionOutcomeInput(outcomeInput({
      evidence: {
        payload: { a: 1 },
        confidence: { value: 0.5, method: ' source_trust ', basis: ' long-term trust ' },
        observedAt: '2026-09-14T12:30:00Z',
      },
    }));
    expect(valid.outcome).toBe('answered');
    expect(valid.evidence!.confidence.method).toBe('source_trust');
    expect(valid.evidence!.confidence.basis).toBe('long-term trust');
    expect(valid.evidence!.observedAt).toBe('2026-09-14T12:30:00Z');
  });

  it('requires a note on unavailable/failed and forbids evidence there', () => {
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(outcomeInput({ outcome: 'failed' })));
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(outcomeInput({ outcome: 'unavailable', note: '   ' })));
    expectCode('invalid_outcome_input', () =>
      validateRecordAcquisitionOutcomeInput(outcomeInput({ outcome: 'failed', note: 'api down', evidence: outcomeInput().evidence })),
    );
    const valid = validateRecordAcquisitionOutcomeInput(outcomeInput({ outcome: 'failed', note: 'export unavailable', evidence: undefined }));
    expect(valid.evidence).toBeNull();
    expect(valid.note).toBe('export unavailable');
  });

  it('requires evidence on answered and validates its shape', () => {
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(outcomeInput({ evidence: undefined })));
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(outcomeInput({ evidence: { confidence: { value: 0.5, method: 'x' } } })));
    expectCode('invalid_outcome_input', () =>
      validateRecordAcquisitionOutcomeInput(outcomeInput({ evidence: { payload: { a: 1 }, confidence: { value: 1.5, method: 'x' } } })),
    );
    expectCode('invalid_outcome_input', () =>
      validateRecordAcquisitionOutcomeInput(outcomeInput({ evidence: { payload: { a: 1 }, confidence: { value: 0.5, method: '' } } })),
    );
    expectCode('invalid_outcome_input', () =>
      validateRecordAcquisitionOutcomeInput(outcomeInput({ evidence: { payload: { a: 1 }, confidence: { value: 0.5, method: 'x' }, observedAt: '2026-09-14' } })),
    );
    expectCode('invalid_outcome_input', () =>
      validateRecordAcquisitionOutcomeInput(outcomeInput({ evidence: { payload: { a: 1 }, confidence: { value: 0.5, method: 'x' }, extra: 1 } })),
    );
  });

  it('validates planId and the outcome vocabulary', () => {
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(outcomeInput({ planId: 'nope' })));
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(outcomeInput({ outcome: 'maybe' })));
    expectCode('invalid_outcome_input', () => validateRecordAcquisitionOutcomeInput(null as unknown as RecordAcquisitionOutcomeInput));
  });
});

// ---------------------------------------------------------------------------
// List query validation
// ---------------------------------------------------------------------------

describe('validateListAcquisitionPlansQuery', () => {
  it('applies the default limit and accepts the filters', () => {
    const valid = validateListAcquisitionPlansQuery({});
    expect(valid).toEqual({ missionId: null, decision: null, action: null, limit: 50 });
    expect(
      validateListAcquisitionPlansQuery({ missionId: MISSION_ID, decision: 'selected', action: 'ask-person', limit: 1 }),
    ).toEqual({ missionId: MISSION_ID, decision: 'selected', action: 'ask-person', limit: 1 });
  });

  it('rejects malformed queries', () => {
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery(null as unknown as Record<string, never>));
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery({ nope: 1 } as unknown as Record<string, never>));
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery({ missionId: 'nope' } as unknown as Record<string, never>));
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery({ decision: 'maybe' } as unknown as Record<string, never>));
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery({ action: 'ask-everyone' } as unknown as Record<string, never>));
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery({ limit: 0 } as unknown as Record<string, never>));
    expectCode('invalid_query', () => validateListAcquisitionPlansQuery({ limit: 501 } as unknown as Record<string, never>));
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('vocabulary guards', () => {
  it('classifies values', () => {
    expect(isUuid(MISSION_ID)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isPlanDecision('selected')).toBe(true);
    expect(isPlanDecision('maybe')).toBe(false);
    expect(isAccessScope('forbidden')).toBe(true);
    expect(isAccessScope('open')).toBe(false);
    expect(isAcquisitionOutcomeKind('answered')).toBe(true);
    expect(isAcquisitionOutcomeKind('lost')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scoring (the deterministic ADR-0018 core)
// ---------------------------------------------------------------------------

describe('computeCostShare', () => {
  it('maps cost onto a [0,1] share of the budget, capped', () => {
    expect(computeCostShare(0, 100_00)).toBe(0);
    expect(computeCostShare(25_00, 100_00)).toBe(0.25);
    expect(computeCostShare(100_00, 100_00)).toBe(1);
    expect(computeCostShare(250_00, 100_00)).toBe(1); // capped
    expect(computeCostShare(1, 0)).toBe(1); // zero budget: any cost is a full share
    expect(computeCostShare(0, 0)).toBe(0);
  });
});

describe('scoreCandidateSignals', () => {
  it('computes the fixed-weight sum minus the cost penalty (deterministic)', () => {
    const base = { relevance: 1, reliability: 1, freshness: 1, authority: 1, expectedQuality: 1, priorContributionValue: 1 };
    const perfect = scoreCandidateSignals(base, 0, 100_00);
    // All-positive weights sum to 0.95; no cost.
    expect(perfect.score).toBe(0.95);
    expect(perfect.costShare).toBe(0);
    expect(perfect.dominantSignal).toBe('relevance'); // highest weight

    const costed = scoreCandidateSignals(base, 100_00, 100_00);
    expect(costed.score).toBe(0.8); // 0.95 − 0.15·1

    const empty = scoreCandidateSignals(
      { relevance: 0, reliability: 0, freshness: 0, authority: 0, expectedQuality: 0, priorContributionValue: 0 },
      50_00,
      100_00,
    );
    expect(empty.score).toBe(-0.075); // 0 − 0.15·0.5 — cost can dominate
  });

  it('is a pure function: identical inputs produce identical outputs', () => {
    const a = scoreCandidateSignals(
      { relevance: 0.62, reliability: 0.11, freshness: 0.97, authority: 0.4, expectedQuality: 0.83, priorContributionValue: 0.29 },
      12_345,
      99_999,
    );
    const b = scoreCandidateSignals(
      { relevance: 0.62, reliability: 0.11, freshness: 0.97, authority: 0.4, expectedQuality: 0.83, priorContributionValue: 0.29 },
      12_345,
      99_999,
    );
    expect(a).toEqual(b);
  });

  it('reports the dominant signal as the highest weighted contribution', () => {
    const authorityHeavy = scoreCandidateSignals(
      { relevance: 0.1, reliability: 0.1, freshness: 0.1, authority: 1, expectedQuality: 0.1, priorContributionValue: 0.1 },
      0,
      100_00,
    );
    expect(authorityHeavy.dominantSignal).toBe('authority');
    const qualityHeavy = scoreCandidateSignals(
      { relevance: 0.4, reliability: 0.4, freshness: 0.4, authority: 0.4, expectedQuality: 1, priorContributionValue: 0.4 },
      0,
      100_00,
    );
    expect(qualityHeavy.dominantSignal).toBe('expectedQuality');
  });

  it('changes the ranking when a signal changes (ADR-0018 verification)', () => {
    const budget = 100_00;
    const person = { relevance: 0.75, reliability: 0.75, freshness: 0.75, authority: 0.75, expectedQuality: 0.75, priorContributionValue: 0.75 };
    const system = { relevance: 0.7, reliability: 0.7, freshness: 0.7, authority: 0.7, expectedQuality: 0.7, priorContributionValue: 0.7 };
    expect(scoreCandidateSignals(person, 0, budget).score).toBeGreaterThan(
      scoreCandidateSignals(system, 0, budget).score,
    );
    // Reliability moves: the system's reliability rises to 1 while the
    // person's collapses → the ordering flips.
    const learnedSystem = { ...system, reliability: 1 };
    const failedPerson = { ...person, reliability: 0.1 };
    expect(scoreCandidateSignals(learnedSystem, 0, budget).score).toBeGreaterThan(
      scoreCandidateSignals(failedPerson, 0, budget).score,
    );
    // Cost moves: even a better source loses when its cost overruns.
    expect(scoreCandidateSignals(person, 100_00, budget).score).toBeLessThan(
      scoreCandidateSignals(system, 0, budget).score,
    );
  });
});

describe('orderRankedCandidates', () => {
  function entry(kind: RankedCandidate['candidate']['kind'], score: number, label: string, exclusion: RankedCandidate['exclusion'] = null): RankedCandidate {
    return {
      candidate: { kind, id: null, label },
      signals: {
        relevance: 0, reliability: 0, freshness: 0, authority: 0,
        expectedQuality: 0, priorContributionValue: 0, cost: 0, access: 'allowed',
      },
      score,
      costShare: 0,
      dominantSignal: 'relevance',
      status: exclusion === null ? 'eligible' : 'excluded',
      exclusion,
    };
  }

  it('orders by score desc, then the §7 kind order, then key', () => {
    const ordered = orderRankedCandidates([
      entry('analysis', 0.5, 'a'),
      entry('person', 0.5, 'z'),
      entry('system', 0.5, 'm'),
      entry('document', 0.9, 'd'),
    ]);
    expect(ordered.map((e) => e.candidate.kind)).toEqual(['document', 'person', 'system', 'analysis']);
    expect(ordered.map((e) => e.candidate.label)).toEqual(['d', 'z', 'm', 'a']);
  });

  it('breaks full ties by candidate key ascending and does not mutate the input', () => {
    const input = [entry('system', 0.5, 'beta'), entry('system', 0.5, 'alpha')];
    const ordered = orderRankedCandidates(input);
    expect(ordered.map((e) => e.candidate.label)).toEqual(['alpha', 'beta']);
    expect(input.map((e) => e.candidate.label)).toEqual(['beta', 'alpha']);
  });

  it('keeps excluded candidates in the order — selection is the first eligible', () => {
    const ordered = orderRankedCandidates([
      entry('person', 0.9, 'top', 'already_attempted'),
      entry('system', 0.8, 'next'),
      entry('document', 0.7, 'low', 'over_budget'),
    ]);
    const winner = ordered.find((e) => e.status === 'eligible');
    expect(winner!.candidate.kind).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Candidate identity
// ---------------------------------------------------------------------------

describe('candidateKey', () => {
  it('keys id-bearing candidates by (kind, id) and label-only by (kind, label)', () => {
    expect(candidateKey({ kind: 'person', id: PERSON_ID, label: 'A' })).toBe(`person:id:${PERSON_ID}`);
    expect(candidateKey({ kind: 'system', id: null, label: 'billing' })).toBe('system:label:billing');
    expect(candidateKey({ kind: 'system', label: 'billing' })).toBe('system:label:billing');
    expect(candidateKey({ kind: 'person', id: PERSON_ID })).not.toBe(candidateKey({ kind: 'person', label: 'A' }));
  });
});

// ---------------------------------------------------------------------------
// Targeted question composition
// ---------------------------------------------------------------------------

describe('composeTargetedQuestion', () => {
  it('derives the question from the mission and addresses the person (deterministic)', () => {
    const question = composeTargetedQuestion({
      missionTitle: 'Churn root cause',
      knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
      personName: 'Ada Lovelace',
    });
    expect(question).toBe(
      'Hello Ada Lovelace — Aurum is working on the mission "Churn root cause" ' +
        'and needs your knowledge to answer: Why did churn rise in Q3 and what is ' +
        'the dominant driver? What can you tell us about this?',
    );
    expect(question).toContain('Ada Lovelace'); // targeted
    expect(question).toContain('Why did churn rise in Q3'); // mission-driven
    expect(question).toContain('?');
    expect(
      composeTargetedQuestion({
        missionTitle: 'Churn root cause',
        knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
        personName: 'Ada Lovelace',
      }),
    ).toBe(question); // pure
  });

  it('bounds the person name so any mission content fits the storage cap', () => {
    const question = composeTargetedQuestion({
      missionTitle: 'T'.repeat(200),
      knowledgeObjective: 'O'.repeat(2000) + '?',
      personName: 'N'.repeat(10_000),
    });
    expect(question.length).toBeLessThanOrEqual(4000);
    expect(question).toContain('N'.repeat(200));
    expect(question).not.toContain('N'.repeat(201));
  });
});

// ---------------------------------------------------------------------------
// Weight sanity (the ranking policy is fixed code, not tenant state)
// ---------------------------------------------------------------------------

describe('SIGNAL_WEIGHTS', () => {
  it('pins the policy/workflow-level weights', () => {
    expect(SIGNAL_WEIGHTS).toEqual({
      relevance: 0.3,
      reliability: 0.2,
      authority: 0.15,
      expectedQuality: 0.15,
      freshness: 0.1,
      priorContributionValue: 0.05,
      costPenalty: 0.15,
    });
  });
});
