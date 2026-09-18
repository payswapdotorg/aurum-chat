// Unit tests for the quality module's pure logic (no database): the
// deterministic judgment-resolution rules and the nine metric-family
// computations of metrics.ts (the discovery.ts / ranking.ts precedent —
// the single definitions, tested in isolation).
//
// Covered:
//  * judgment resolution — latest-wins by (recordedAt, id), gap windows
//    (unbounded judgments apply everywhere; bounded ones only when they
//    overlap the evaluation window), candidate-scoped precedence over
//    gap-scoped for precision, plan-scoped verdicts;
//  * unknown-discovery precision/recall — TP/FP/unjudged promoted
//    candidates, discovered vs missed ground-truth gaps, null on empty
//    denominators (absence, not zero);
//  * source-selection — first-choice determination (earliest per mission,
//    id tiebreak), objective answer rate, judgment-labeled quality rate,
//    employee routing accuracy restricted to 'ask-person';
//  * mission-resolution efficiency — median/mean steps, zero-step
//    missions, null when nothing resolved;
//  * evidence quality — descriptive stats, null on empty;
//  * recommendation calibration — signed bias flips with metric
//    direction, absolute error, met/exceeded/missed;
//  * intervention success + realized value — buckets per subject kind,
//    direction-signed improvement;
//  * investigation cost — per-currency grouping (never across
//    currencies), window vs per-mission cost, zero-plan missions;
//  * time-to-useful-understanding — resolution and first-answer hours,
//    pre-creation answers excluded;
//  * the computeMetric dispatcher covers all nine kinds.

import { describe, expect, it } from 'vitest';
import {
  METRIC_SCHEMA_VERSION,
  candidateVerdicts,
  computeEvidenceQuality,
  computeInterventionSuccess,
  computeInvestigationCost,
  computeMetric,
  computeMissionResolutionEfficiency,
  computeRealizedValue,
  computeRecommendationCalibration,
  computeSourceSelection,
  computeTimeToUsefulUnderstanding,
  computeUnknownDiscovery,
  firstChoicePlans,
  groundTruthGaps,
  planVerdicts,
  round6,
  type CandidateFact,
  type JudgmentFact,
  type ObservationFact,
  type PlanFact,
  type ResolvedMissionFact,
  type SettledOutcomeFact,
} from '../metrics';
import { QUALITY_METRIC_KINDS } from '../validation';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const T1 = Date.parse('2026-10-01T00:00:00.000Z');
const T2 = Date.parse('2026-11-01T00:00:00.000Z');
const T3 = Date.parse('2026-12-01T00:00:00.000Z');
/** A mid-window recording instant. */
const TM = Date.parse('2026-10-15T12:00:00.000Z');

const WINDOW = { fromMs: T1, toMs: T2 };

function candidate(id: string, gapKey: string, atMs: number): CandidateFact {
  return { candidateId: id, gapKey, recordedAtMs: atMs };
}

function gapJudgment(
  id: string,
  gapKey: string,
  verdict: 'consequential' | 'not_consequential',
  recordedAtMs: number,
  options: { candidateId?: string | null; from?: number | null; to?: number | null } = {},
): JudgmentFact {
  return {
    id,
    kind: 'unknown-consequentiality',
    gapKey,
    candidateId: options.candidateId ?? null,
    planId: null,
    windowFromMs: options.from ?? null,
    windowToMs: options.to ?? null,
    verdict,
    recordedAtMs,
  };
}

function planJudgment(
  id: string,
  planId: string,
  verdict: 'correct' | 'incorrect',
  recordedAtMs: number,
): JudgmentFact {
  return {
    id,
    kind: 'source-selection',
    gapKey: null,
    candidateId: null,
    planId,
    windowFromMs: null,
    windowToMs: null,
    verdict,
    recordedAtMs,
  };
}

function plan(
  id: string,
  missionId: string,
  recordedAtMs: number,
  overrides: Partial<PlanFact> = {},
): PlanFact {
  return {
    planId: id,
    missionId,
    action: 'query-system',
    recordedAtMs,
    estimatedCost: 100,
    budgetCurrency: 'EUR',
    outcomeKind: null,
    outcomeRecordedAtMs: null,
    ...overrides,
  };
}

function mission(id: string, createdAtMs: number, completedAtMs: number, currency = 'EUR'): ResolvedMissionFact {
  return { missionId: id, createdAtMs, completedAtMs, budgetCurrency: currency };
}

function outcome(
  id: string,
  overrides: Partial<SettledOutcomeFact> = {},
): SettledOutcomeFact {
  return {
    outcomeId: id,
    subjectKind: 'recommendation',
    direction: 'at_least',
    baseline: 10,
    expected: 15,
    realized: 15,
    assessment: 'met',
    ...overrides,
  };
}

describe('round6', () => {
  it('rounds rates and means to 6 decimals deterministically', () => {
    expect(round6(1 / 3)).toBe(0.333333);
    expect(round6(2 / 3)).toBe(0.666667);
    expect(round6(1)).toBe(1);
    expect(round6(0)).toBe(0);
  });
});

describe('groundTruthGaps — window-scoped latest-wins resolution', () => {
  it('applies unbounded judgments to every window', () => {
    const judgments = [gapJudgment('j1', 'gap-a', 'consequential', T0)];
    expect(groundTruthGaps(judgments, WINDOW).get('gap-a')).toBe('consequential');
    expect(groundTruthGaps(judgments, { fromMs: T2, toMs: T3 }).get('gap-a')).toBe('consequential');
  });

  it('applies window-bounded judgments only when they overlap', () => {
    const judgments = [
      gapJudgment('j1', 'gap-a', 'consequential', T0, { from: T0, to: T1 - 1 }),
      gapJudgment('j2', 'gap-b', 'consequential', T0, { from: T1, to: T2 }),
    ];
    // [T0, T1−1] ends strictly before the window [T1, T2]: no overlap.
    const truth = groundTruthGaps(judgments, WINDOW);
    expect(truth.get('gap-a')).toBeUndefined();
    // [T1, T2] is exactly the window (inclusive bounds): overlap.
    expect(truth.get('gap-b')).toBe('consequential');
    const later = groundTruthGaps(judgments, { fromMs: T2 + 1, toMs: T3 });
    expect(later.get('gap-a')).toBeUndefined();
    expect(later.get('gap-b')).toBeUndefined();
  });

  it('resolves the latest judgment per gap by (recordedAt, id)', () => {
    const judgments = [
      gapJudgment('j1', 'gap-a', 'not_consequential', T0),
      gapJudgment('j2', 'gap-a', 'consequential', TM),
      gapJudgment('j3', 'gap-b', 'consequential', TM),
      // same recordedAt as j3 — the lexicographically larger id wins
      gapJudgment('j4', 'gap-b', 'not_consequential', TM),
    ];
    const truth = groundTruthGaps(judgments, WINDOW);
    expect(truth.get('gap-a')).toBe('consequential');
    expect(truth.get('gap-b')).toBe('not_consequential');
  });

  it('ignores source-selection judgments entirely', () => {
    const judgments = [planJudgment('j1', 'plan-1', 'correct', TM)];
    expect(groundTruthGaps(judgments, WINDOW).size).toBe(0);
  });
});

describe('candidateVerdicts — candidate-scoped precedence', () => {
  it('resolves the latest candidate-scoped judgment per candidate', () => {
    const judgments = [
      gapJudgment('j1', 'gap-a', 'not_consequential', T0, { candidateId: 'c1' }),
      gapJudgment('j2', 'gap-a', 'consequential', TM, { candidateId: 'c1' }),
    ];
    const verdicts = candidateVerdicts(judgments);
    expect(verdicts.get('c1')).toBe('consequential');
    expect(verdicts.size).toBe(1);
  });

  it('leaves candidates without their own judgments to the gap fallback', () => {
    const verdicts = candidateVerdicts([gapJudgment('j1', 'gap-a', 'consequential', T0)]);
    expect(verdicts.size).toBe(0);
  });
});

describe('computeUnknownDiscovery — precision/recall', () => {
  it('computes precision per discovery and recall per gap', () => {
    const candidates = [
      candidate('c1', 'gap-a', TM), // judged consequential (gap-scoped) → TP
      candidate('c2', 'gap-b', TM), // judged not consequential (candidate-scoped) → FP
      candidate('c3', 'gap-c', TM), // unjudged
      candidate('c4', 'gap-a', TM - 1), // same gap promoted twice (a returning need)
    ];
    const judgments = [
      gapJudgment('j1', 'gap-a', 'consequential', T0),
      gapJudgment('j2', 'gap-b', 'consequential', T0), // gap says consequential…
      gapJudgment('j3', 'gap-b', 'not_consequential', TM, { candidateId: 'c2' }), // …but THIS discovery was spurious
      gapJudgment('j4', 'gap-d', 'consequential', T0), // never discovered → missed
    ];
    const payload = computeUnknownDiscovery(candidates, judgments, WINDOW);
    expect(payload.promotedInWindow).toBe(4);
    // c1 and c4 are gap-a TPs; c2 is a candidate-scoped FP; c3 unjudged.
    expect(payload.truePositives).toBe(2);
    expect(payload.falsePositives).toBe(1);
    expect(payload.unjudgedPromoted).toBe(1);
    expect(payload.judgedPromoted).toBe(3);
    expect(payload.precision).toBe(round6(2 / 3));
    // gap-b's latest judgment is the candidate-scoped j3 ('not_consequential'):
    // ground truth for the window is gap-a + gap-d only.
    expect(payload.groundTruthConsequential).toBe(2);
    expect(payload.discoveredConsequential).toBe(1); // gap-a
    expect(payload.missedConsequential).toBe(1); // gap-d
    expect(payload.recall).toBe(0.5);
  });

  it('excludes out-of-window candidates from both rates', () => {
    const candidates = [
      candidate('c1', 'gap-a', T0), // before the window
      candidate('c2', 'gap-b', TM),
    ];
    const judgments = [
      gapJudgment('j1', 'gap-a', 'consequential', T0),
      gapJudgment('j2', 'gap-b', 'consequential', T0),
    ];
    const payload = computeUnknownDiscovery(candidates, judgments, WINDOW);
    expect(payload.promotedInWindow).toBe(1);
    expect(payload.precision).toBe(1);
    expect(payload.recall).toBe(round6(1 / 2)); // gap-a not discovered in window
  });

  it('records absence as null, never as zero', () => {
    const payload = computeUnknownDiscovery([], [], WINDOW);
    expect(payload.precision).toBeNull();
    expect(payload.recall).toBeNull();
    expect(payload.promotedInWindow).toBe(0);
    expect(payload.groundTruthConsequential).toBe(0);

    const unjudged = computeUnknownDiscovery([candidate('c1', 'gap-a', TM)], [], WINDOW);
    expect(unjudged.precision).toBeNull();
    expect(unjudged.unjudgedPromoted).toBe(1);
  });
});

describe('firstChoicePlans and planVerdicts', () => {
  it('picks the earliest selected plan per mission with an id tiebreak', () => {
    const plans = [
      plan('p-b', 'm1', TM),
      plan('p-a', 'm1', TM), // same instant — lexicographically smaller id wins
      plan('p-c', 'm2', TM - 1),
      plan('p-d', 'm3', TM + 1),
    ];
    const first = firstChoicePlans(plans);
    expect(first.map((p) => p.planId).sort()).toEqual(['p-a', 'p-c', 'p-d']);
  });

  it('resolves the latest source-selection verdict per plan', () => {
    const judgments = [
      planJudgment('j1', 'p-1', 'incorrect', T0),
      planJudgment('j2', 'p-1', 'correct', TM),
    ];
    expect(planVerdicts(judgments).get('p-1')).toBe('correct');
    expect(planVerdicts([gapJudgment('j3', 'gap-a', 'consequential', TM)]).size).toBe(0);
  });
});

describe('computeSourceSelection — first-choice quality and employee routing', () => {
  it('computes answer rate, labeled quality and employee routing accuracy', () => {
    const plans = [
      plan('p1', 'm1', TM, { action: 'ask-person', outcomeKind: 'answered', outcomeRecordedAtMs: TM + 1 }),
      plan('p2', 'm2', TM, { action: 'query-system', outcomeKind: 'unavailable', outcomeRecordedAtMs: TM + 1 }),
      plan('p3', 'm3', TM, { action: 'query-system' }), // no outcome yet
      plan('p4', 'm4', TM, { action: 'ask-person', outcomeKind: 'failed', outcomeRecordedAtMs: TM + 1 }),
      plan('p5', 'm5', TM, { action: 'query-system', outcomeKind: 'answered', outcomeRecordedAtMs: TM + 1 }),
    ];
    const judgments = [
      planJudgment('j1', 'p1', 'correct', TM + 2),
      planJudgment('j2', 'p2', 'incorrect', TM + 2),
      planJudgment('j3', 'p4', 'correct', TM + 2),
    ];
    const payload = computeSourceSelection(plans, judgments, WINDOW);
    expect(payload.firstChoiceTotal).toBe(5);
    expect(payload.firstChoiceResolved).toBe(4);
    expect(payload.firstChoiceAnswered).toBe(2);
    expect(payload.firstChoiceAnswerRate).toBe(0.5);
    expect(payload.judgedFirstChoice).toBe(3);
    expect(payload.correctFirstChoice).toBe(2);
    expect(payload.firstChoiceQualityRate).toBe(round6(2 / 3));
    expect(payload.employeeFirstChoice).toBe(2);
    expect(payload.employeeJudged).toBe(2);
    expect(payload.employeeCorrect).toBe(2);
    expect(payload.employeeRoutingAccuracy).toBe(1);
  });

  it('ignores non-first-choice plans and out-of-window first choices', () => {
    const plans = [
      plan('p1', 'm1', TM, { action: 'query-system', outcomeKind: 'answered', outcomeRecordedAtMs: TM + 1 }),
      plan('p2', 'm1', TM + 2, { action: 'ask-person' }), // second choice — not first
      plan('p3', 'm2', T0, { action: 'ask-person' }), // before the window
    ];
    const payload = computeSourceSelection(plans, [], WINDOW);
    expect(payload.firstChoiceTotal).toBe(1);
    expect(payload.firstChoiceAnswered).toBe(1);
    expect(payload.firstChoiceAnswerRate).toBe(1);
    expect(payload.employeeFirstChoice).toBe(0);
    expect(payload.employeeRoutingAccuracy).toBeNull();
  });

  it('records absence as null', () => {
    const payload = computeSourceSelection([], [], WINDOW);
    expect(payload.firstChoiceTotal).toBe(0);
    expect(payload.firstChoiceAnswerRate).toBeNull();
    expect(payload.firstChoiceQualityRate).toBeNull();
    expect(payload.employeeRoutingAccuracy).toBeNull();
  });
});

describe('computeMissionResolutionEfficiency — steps per resolved mission', () => {
  it('computes median and mean steps, counting zero-step missions', () => {
    const missions = [
      mission('m1', T0, TM), // 3 plans
      mission('m2', T0, TM), // 1 plan
      mission('m3', T0, TM), // 0 plans
    ];
    const plans = [
      plan('p1', 'm1', TM - 3),
      plan('p2', 'm1', TM - 2),
      plan('p3', 'm1', TM - 1),
      plan('p4', 'm2', TM - 1),
      plan('p5', 'm9', TM), // a plan for a mission not completed here
    ];
    const payload = computeMissionResolutionEfficiency(missions, plans, WINDOW);
    expect(payload.resolvedMissions).toBe(3);
    expect(payload.missionsWithoutSteps).toBe(1);
    expect(payload.medianSteps).toBe(1);
    expect(payload.meanSteps).toBe(round6(4 / 3));
  });

  it('excludes missions completed outside the window and nulls on none', () => {
    const missions = [mission('m1', T0, T0 + 1), mission('m2', T2, T3)];
    const payload = computeMissionResolutionEfficiency(missions, [], WINDOW);
    expect(payload.resolvedMissions).toBe(0);
    expect(payload.medianSteps).toBeNull();
    expect(payload.meanSteps).toBeNull();
  });
});

describe('computeEvidenceQuality — descriptive profile', () => {
  it('computes confidence stats and provenance shares', () => {
    const observations: ObservationFact[] = [
      { confidenceValue: 0.9, confidenceBasis: 'source trust', lineageParentCount: 2 },
      { confidenceValue: 0.5, confidenceBasis: null, lineageParentCount: 0 },
      { confidenceValue: 0.7, confidenceBasis: 'fixture', lineageParentCount: 1 },
      { confidenceValue: 0.3, confidenceBasis: null, lineageParentCount: 0 },
    ];
    const payload = computeEvidenceQuality(observations);
    expect(payload.observations).toBe(4);
    expect(payload.meanConfidence).toBe(0.6);
    expect(payload.minConfidence).toBe(0.3);
    expect(payload.maxConfidence).toBe(0.9);
    expect(payload.shareWithLineage).toBe(0.5);
    expect(payload.shareWithConfidenceBasis).toBe(0.5);
  });

  it('nulls everything on no observations', () => {
    const payload = computeEvidenceQuality([]);
    expect(payload.observations).toBe(0);
    expect(payload.meanConfidence).toBeNull();
    expect(payload.shareWithLineage).toBeNull();
  });
});

describe('computeRecommendationCalibration — predicted vs realized', () => {
  const settledAt = (id: string): number | null => (id === 'outside' ? T0 : TM);

  it('flips the bias sign with the metric direction', () => {
    const outcomes = [
      outcome('o1', { direction: 'at_least', expected: 10, realized: 12, assessment: 'exceeded' }), // +2
      outcome('o2', { direction: 'at_most', expected: 10, realized: 8, assessment: 'exceeded' }), // +2 (better = lower)
      outcome('o3', { direction: 'at_least', expected: 10, realized: 9, assessment: 'missed' }), // −1
    ];
    const payload = computeRecommendationCalibration(outcomes, settledAt, WINDOW);
    expect(payload.settledRecommendations).toBe(3);
    expect(payload.predictionBiasMean).toBe(1);
    expect(payload.predictionErrorMean).toBe(round6(5 / 3));
    expect(payload.met).toBe(0);
    expect(payload.exceeded).toBe(2);
    expect(payload.missed).toBe(1);
    expect(payload.metOrExceededRate).toBe(round6(2 / 3));
  });

  it('filters to recommendation subjects settled in the window', () => {
    const outcomes = [
      outcome('o1'),
      outcome('outside', { subjectKind: 'mission' }), // both wrong subject and outside window
    ];
    const payload = computeRecommendationCalibration(outcomes, settledAt, WINDOW);
    expect(payload.settledRecommendations).toBe(1);
  });

  it('nulls on no settled recommendations', () => {
    const payload = computeRecommendationCalibration([], settledAt, WINDOW);
    expect(payload.settledRecommendations).toBe(0);
    expect(payload.predictionBiasMean).toBeNull();
    expect(payload.metOrExceededRate).toBeNull();
  });
});

describe('computeInterventionSuccess — frozen assessments rolled up', () => {
  const settledAt = (): number | null => TM;

  it('buckets per subject kind with success rates', () => {
    const outcomes = [
      outcome('o1', { subjectKind: 'recommendation', assessment: 'met' }),
      outcome('o2', { subjectKind: 'recommendation', assessment: 'missed' }),
      outcome('o3', { subjectKind: 'agent', assessment: 'exceeded' }),
      outcome('o4', { subjectKind: 'mission', assessment: 'met' }),
    ];
    const payload = computeInterventionSuccess(outcomes, settledAt, WINDOW);
    expect(payload.settled).toBe(4);
    expect(payload.successRate).toBe(0.75);
    expect(payload.bySubjectKind.recommendation).toEqual({
      settled: 2,
      met: 1,
      exceeded: 0,
      missed: 1,
      successRate: 0.5,
    });
    expect(payload.bySubjectKind.agent?.successRate).toBe(1);
    expect(payload.bySubjectKind.extension?.settled).toBe(0);
    expect(payload.bySubjectKind.extension?.successRate).toBeNull();
  });
});

describe('computeRealizedValue — expected versus realized', () => {
  const settledAt = (): number | null => TM;

  it('sums value with direction-signed improvement', () => {
    const outcomes = [
      outcome('o1', { subjectKind: 'agent', baseline: 10, expected: 15, realized: 18, assessment: 'exceeded' }),
      // at_most: lower is better; realized 5 vs baseline 10 → improvement +5
      outcome('o2', { subjectKind: 'agent', direction: 'at_most', baseline: 10, expected: 6, realized: 5, assessment: 'exceeded' }),
      outcome('o3', { subjectKind: 'mission', baseline: 4, expected: 6, realized: 5, assessment: 'missed' }),
    ];
    const payload = computeRealizedValue(outcomes, settledAt, WINDOW);
    expect(payload.settled).toBe(3);
    expect(payload.expectedValueSum).toBe(27);
    expect(payload.realizedValueSum).toBe(28);
    expect(payload.netVarianceSum).toBe(1); // (18−15) + (5−6) + (5−6)
    expect(payload.improvementSum).toBe(14); // (18−10) + (10−5) + (5−4)
    expect(payload.bySubjectKind.agent?.realizedValueSum).toBe(23);
    expect(payload.bySubjectKind.mission?.improvementSum).toBe(1);
  });
});

describe('computeInvestigationCost — per-currency cost', () => {
  it('groups window cost and per-mission cost by currency, never across', () => {
    const missions = [
      mission('m1', T0, TM, 'EUR'), // 2 plans, 250 total
      mission('m2', T0, TM, 'EUR'), // 1 plan, 100
      mission('m3', T0, TM, 'USD'), // 0 plans → cost 0
    ];
    const plans = [
      plan('p1', 'm1', TM - 3, { estimatedCost: 150 }),
      plan('p2', 'm1', TM - 2, { estimatedCost: 100 }),
      plan('p3', 'm2', TM - 1, { estimatedCost: 100 }),
      plan('p4', 'm4', TM, { estimatedCost: 75, budgetCurrency: 'USD' }), // window cost, other mission
      plan('p5', 'm5', T0, { estimatedCost: 999 }), // outside window (cost), m5 not resolved here
    ];
    const payload = computeInvestigationCost(plans, missions, WINDOW);
    expect(payload.windowPlans).toBe(4);
    expect(payload.windowCostByCurrency).toEqual([
      { currency: 'EUR', plans: 3, totalCost: 350 },
      { currency: 'USD', plans: 1, totalCost: 75 },
    ]);
    expect(payload.resolvedMissions).toBe(3);
    expect(payload.missionsWithoutPlans).toBe(1);
    expect(payload.costPerResolvedMissionByCurrency).toEqual([
      { currency: 'EUR', missions: 2, totalCost: 350, medianCost: 175, meanCost: 175 },
      { currency: 'USD', missions: 1, totalCost: 0, medianCost: 0, meanCost: 0 },
    ]);
  });

  it('returns empty buckets when nothing was considered', () => {
    const payload = computeInvestigationCost([], [], WINDOW);
    expect(payload.windowPlans).toBe(0);
    expect(payload.windowCostByCurrency).toEqual([]);
    expect(payload.costPerResolvedMissionByCurrency).toEqual([]);
  });
});

describe('computeTimeToUsefulUnderstanding', () => {
  it('computes resolution and first-answer hours', () => {
    const created = T1;
    const missions = [
      mission('m1', created, created + 2 * 3_600_000), // 2h resolution, answered at +1h
      mission('m2', created, created + 6 * 3_600_000), // 6h resolution, answered at +2h
      mission('m3', created, created + 3 * 3_600_000), // 3h resolution, never answered
    ];
    const plans = [
      plan('p1', 'm1', created + 0.5 * 3_600_000, { outcomeKind: 'answered', outcomeRecordedAtMs: created + 3_600_000 }),
      plan('p2', 'm1', created + 0.25 * 3_600_000, { outcomeKind: 'answered', outcomeRecordedAtMs: created + 2 * 3_600_000 }),
      plan('p3', 'm2', created + 0.5 * 3_600_000, { outcomeKind: 'answered', outcomeRecordedAtMs: created + 2 * 3_600_000 }),
      plan('p4', 'm3', created + 0.5 * 3_600_000, { outcomeKind: 'failed', outcomeRecordedAtMs: created + 3_600_000 }),
    ];
    const payload = computeTimeToUsefulUnderstanding(missions, plans, WINDOW);
    expect(payload.resolvedMissions).toBe(3);
    expect(payload.medianResolutionHours).toBe(3);
    expect(payload.meanResolutionHours).toBe(round6(11 / 3));
    expect(payload.missionsWithFirstAnswer).toBe(2);
    expect(payload.medianTimeToFirstAnswerHours).toBe(1.5);
    expect(payload.meanTimeToFirstAnswerHours).toBe(1.5);
  });

  it('excludes answers recorded before mission creation', () => {
    const missions = [mission('m1', T1, T1 + 3_600_000)];
    const plans = [
      plan('p1', 'm1', T1 - 3_600_000, { outcomeKind: 'answered', outcomeRecordedAtMs: T1 - 1000 }),
    ];
    const payload = computeTimeToUsefulUnderstanding(missions, plans, WINDOW);
    expect(payload.missionsWithFirstAnswer).toBe(0);
    expect(payload.medianTimeToFirstAnswerHours).toBeNull();
  });

  it('nulls when nothing resolved in the window', () => {
    const payload = computeTimeToUsefulUnderstanding([mission('m1', T0, T0 + 1)], [], WINDOW);
    expect(payload.resolvedMissions).toBe(0);
    expect(payload.medianResolutionHours).toBeNull();
    expect(payload.meanResolutionHours).toBeNull();
  });
});

describe('computeMetric — the dispatcher', () => {
  it('computes every family and stamps the metric kind', () => {
    const facts = {
      window: WINDOW,
      candidates: [candidate('c1', 'gap-a', TM)],
      judgments: [gapJudgment('j1', 'gap-a', 'consequential', T0)],
      plans: [plan('p1', 'm1', TM, { outcomeKind: 'answered', outcomeRecordedAtMs: TM + 1 })],
      missions: [mission('m1', T0, TM)],
      observations: [{ confidenceValue: 0.8, confidenceBasis: null, lineageParentCount: 1 }],
      outcomes: [outcome('o1', { subjectKind: 'agent' })],
      settledAtMs: () => TM,
    };
    for (const kind of QUALITY_METRIC_KINDS) {
      const payload = computeMetric(kind, facts);
      expect(payload.metricKind).toBe(kind);
      expect(Object.keys(payload).length).toBeGreaterThan(1);
    }
    expect(METRIC_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown metric kind loudly', () => {
    expect(() => computeMetric('not-a-metric' as never, {
      window: WINDOW,
      candidates: [],
      judgments: [],
      plans: [],
      missions: [],
      observations: [],
      outcomes: [],
      settledAtMs: () => null,
    })).toThrow(/unknown metric kind/);
  });
});
