// Unit tests for the attention module's pure logic (no database): the
// deterministic goal-gap derivation (discovery.ts) and the materiality
// policy gate — the two halves of ADR-0017's unprompted unknown
// discovery.
//
//   * SCORING PRIMITIVES — decision impact (priority rank × severity),
//     information value (impact × gap), required confidence per priority,
//     urgency bands with horizon bumps, relative shortfall per direction,
//     target descriptions, gap keys, acquisition-path mapping.
//   * THE DERIVATION — driver/reading/standing gaps derived from active
//     goals + readings, with exact expected field values (the question
//     text is COMPUTED, never supplied — that is the "unprompted" of
//     ADR-0017); on-target metrics, sufficiently-known drivers and
//     sufficiently-known standings produce NO candidate (discovery never
//     manufactures gaps); determinism (same inputs → deep-equal output).
//   * THE POLICY GATE — material ⇔ impact AND value at/above thresholds,
//     with the auditable failure reason.

import { describe, expect, it } from 'vitest';
import {
  HORIZON_BUMP_DAYS,
  PRIORITY_RANK,
  REQUIRED_CONFIDENCE,
  URGENCY_BANDS,
  acquisitionPathsFromGoalSources,
  decisionImpactFor,
  deriveGoalGapCandidates,
  evaluateMateriality,
  gapKeyFor,
  informationValueFor,
  relativeShortfall,
  requiredConfidenceFor,
  round4,
  targetDescription,
  urgencyFromPriority,
  type GoalSnapshot,
} from '../discovery';

const NOW = new Date('2026-12-01T00:00:00.000Z');

/** A goal snapshot with the fields the derivation reads. */
function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Reduce monthly churn',
    objective: 'Bring churn under control',
    desiredState: 'Churn at or below 6 percent',
    priority: 'critical',
    horizonEnd: '2027-01-15T00:00:00.000Z', // 45 days out — one bump
    metrics: [
      {
        name: 'monthly-churn-rate',
        unit: 'percent',
        direction: 'at_most',
        threshold: 6,
        lowerBound: null,
        upperBound: null,
      },
    ],
    evidenceSources: [{ kind: 'source', label: 'Billing CRM' }],
    ...overrides,
  };
}

describe('scoring primitives', () => {
  it('maps goal priority to comparable ranks and required confidences', () => {
    expect(PRIORITY_RANK).toEqual({ critical: 4, high: 3, medium: 2, low: 1 });
    expect(REQUIRED_CONFIDENCE.critical).toBe(0.9);
    expect(REQUIRED_CONFIDENCE.high).toBe(0.8);
    expect(REQUIRED_CONFIDENCE.medium).toBe(0.7);
    expect(REQUIRED_CONFIDENCE.low).toBe(0.6);
    expect(requiredConfidenceFor('high')).toBe(0.8);
  });

  it('computes decision impact as priority rank scaled by severity', () => {
    // (rank/4) · (0.5 + 0.5·severity)
    expect(decisionImpactFor('critical', 1)).toBe(1);
    expect(decisionImpactFor('critical', 0)).toBe(0.5);
    expect(decisionImpactFor('critical', 0.4)).toBe(0.7);
    expect(decisionImpactFor('high', 1)).toBe(0.75);
    expect(decisionImpactFor('low', 1)).toBe(0.25);
    // out-of-range severity clamps, never throws
    expect(decisionImpactFor('medium', 5)).toBe(0.5);
    expect(decisionImpactFor('medium', -3)).toBe(0.25);
  });

  it('computes information value as impact times confidence gap', () => {
    expect(informationValueFor(0.7, 0.9)).toBe(0.63);
    expect(informationValueFor(1, 1)).toBe(1);
    expect(informationValueFor(0.5, 0)).toBe(0);
    // clamped inputs, deterministic rounding
    expect(informationValueFor(2, 2)).toBe(1);
    expect(round4(0.123456)).toBe(0.1235);
  });

  it('derives urgency from priority with horizon bumps, clamped at critical', () => {
    const farHorizon = '2027-12-01T00:00:00.000Z'; // > 90 days
    expect(urgencyFromPriority('low', farHorizon, NOW)).toBe('low');
    expect(urgencyFromPriority('medium', farHorizon, NOW)).toBe('medium');
    expect(urgencyFromPriority('high', farHorizon, NOW)).toBe('high');
    expect(urgencyFromPriority('critical', farHorizon, NOW)).toBe('critical');

    // ≤ 90 days: one bump
    expect(urgencyFromPriority('low', '2027-02-01T00:00:00.000Z', NOW)).toBe('medium');
    expect(urgencyFromPriority('medium', '2027-02-01T00:00:00.000Z', NOW)).toBe('high');
    // ≤ 30 days: two bumps (HORIZON_BUMP_DAYS is [90, 30])
    expect(HORIZON_BUMP_DAYS).toEqual([90, 30]);
    expect(urgencyFromPriority('low', '2026-12-20T00:00:00.000Z', NOW)).toBe('high');
    expect(urgencyFromPriority('medium', '2026-12-20T00:00:00.000Z', NOW)).toBe('critical');
    // clamped at the top band
    expect(urgencyFromPriority('critical', '2026-12-20T00:00:00.000Z', NOW)).toBe('critical');
    // past due crosses every threshold (≤90 and ≤30) — at most two bands:
    // a low-priority goal goes to 'high', never to 'critical' (urgency
    // never outruns importance by more than the two horizon bumps)
    expect(urgencyFromPriority('low', '2026-11-01T00:00:00.000Z', NOW)).toBe('high');
    expect(urgencyFromPriority('medium', '2026-11-01T00:00:00.000Z', NOW)).toBe('critical');
    expect(URGENCY_BANDS).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('computes relative shortfall per direction and detects on-target values', () => {
    const atMost = { name: 'churn', unit: null, direction: 'at_most' as const, threshold: 6, lowerBound: null, upperBound: null };
    expect(relativeShortfall(atMost, 6)).toBeNull(); // on target
    expect(relativeShortfall(atMost, 5.9)).toBeNull();
    expect(relativeShortfall(atMost, 8.4)).toBe(round4(2.4 / 6)); // 0.4
    expect(relativeShortfall(atMost, 12)).toBe(1); // clamped at 1

    const atLeast = { name: 'arr', unit: null, direction: 'at_least' as const, threshold: 100, lowerBound: null, upperBound: null };
    expect(relativeShortfall(atLeast, 100)).toBeNull();
    expect(relativeShortfall(atLeast, 120)).toBeNull();
    expect(relativeShortfall(atLeast, 75)).toBe(0.25);

    const inRange = { name: 'uptime', unit: null, direction: 'in_range' as const, threshold: null, lowerBound: 99, upperBound: 100 };
    expect(relativeShortfall(inRange, 99.5)).toBeNull();
    expect(relativeShortfall(inRange, 98.5)).toBe(round4(0.5 / 99));
    expect(relativeShortfall(inRange, 102)).toBe(round4(2 / 100));

    // zero-threshold metrics measure absolute distance without dividing by zero
    const zeroTarget = { name: 'defects', unit: null, direction: 'at_most' as const, threshold: 0, lowerBound: null, upperBound: null };
    expect(relativeShortfall(zeroTarget, 0)).toBeNull();
    expect(relativeShortfall(zeroTarget, 0.5)).toBe(1); // clamped
  });

  it('renders target descriptions per direction', () => {
    expect(
      targetDescription({ name: 'a', unit: null, direction: 'at_least', threshold: 10, lowerBound: null, upperBound: null }),
    ).toBe('at least 10');
    expect(
      targetDescription({ name: 'a', unit: null, direction: 'at_most', threshold: 6, lowerBound: null, upperBound: null }),
    ).toBe('at most 6');
    expect(
      targetDescription({ name: 'a', unit: null, direction: 'in_range', threshold: null, lowerBound: 99, upperBound: 100 }),
    ).toBe('within [99, 100]');
  });

  it('builds stable gap keys', () => {
    expect(gapKeyFor('g1', 'driver', 'churn')).toBe('g1|driver|churn');
    expect(gapKeyFor('g1', 'driver', 'churn')).toBe(gapKeyFor('g1', 'driver', 'churn'));
    expect(gapKeyFor('g1', 'standing')).toBe('g1|standing|');
    expect(gapKeyFor('g1', 'standing')).not.toBe(gapKeyFor('g2', 'standing'));
  });

  it('maps goal evidence sources onto the acquisition menu deterministically', () => {
    expect(
      acquisitionPathsFromGoalSources([
        { kind: 'source', label: 'Billing CRM' },
        { kind: 'person', id: '22222222-2222-4222-8222-222222222222', label: 'Head of CX' },
        { kind: 'agent', label: 'ops-agent' },
        { kind: 'external', label: 'industry-report' },
        { kind: 'system', label: 'warehouse' },
        { kind: 'source', label: 'Billing CRM' }, // duplicate collapses
        { kind: 'person', label: null, id: null }, // untraceable — dropped
      ]),
    ).toEqual([
      { kind: 'system', id: null, label: 'Billing CRM' },
      { kind: 'person', id: '22222222-2222-4222-8222-222222222222', label: 'Head of CX' },
      { kind: 'agent', id: null, label: 'ops-agent' },
      { kind: 'external', id: null, label: 'industry-report' },
      { kind: 'system', id: null, label: 'warehouse' },
    ]);
  });
});

describe('deriveGoalGapCandidates — the unprompted derivation', () => {
  it('derives a driver gap from an off-target reading, with every ADR-0017 field computed', () => {
    const claimId = '33333333-3333-4333-8333-333333333333';
    const candidates = deriveGoalGapCandidates({
      goals: [goal()],
      evidence: {
        '11111111-1111-4111-8111-111111111111': {
          readings: [
            {
              metricName: 'monthly-churn-rate',
              value: 8.4,
              driverConfidence: 0,
              evidenceClaimIds: [claimId],
              evidenceBeliefIds: [],
            },
          ],
        },
      },
      now: NOW,
    });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    // The QUESTION is computed by the application — no user supplied it.
    expect(candidate.missingKnowledge).toBe(
      "What is driving monthly-churn-rate to 8.4 instead of at most 6 for goal 'Reduce monthly churn'?",
    );
    expect(candidate.consequence).toContain('cannot be steered back on track');
    expect(candidate.consequence).toContain('Churn at or below 6 percent');
    expect(candidate.gapKind).toBe('driver');
    expect(candidate.metricName).toBe('monthly-churn-rate');
    expect(candidate.gapKey).toBe('11111111-1111-4111-8111-111111111111|driver|monthly-churn-rate');
    expect(candidate.affectedGoalIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    // critical (rank 4) with severity 0.4 → (4/4)·(0.5+0.2) = 0.7
    expect(candidate.decisionImpact).toBe(0.7);
    // critical + 45-day horizon (one bump at ≤90d) → 'critical'
    expect(candidate.urgency).toBe('critical');
    // confidence gap 0 → 0.9
    expect(candidate.currentConfidence).toBe(0);
    expect(candidate.requiredConfidence).toBe(0.9);
    // value = impact · gap = 0.7 · 0.9 = 0.63
    expect(candidate.informationValue).toBe(0.63);
    expect(candidate.evidenceClaimIds).toEqual([claimId]);
    expect(candidate.evidenceBeliefIds).toEqual([]);
    expect(candidate.acquisitionPaths).toEqual([{ kind: 'system', id: null, label: 'Billing CRM' }]);
  });

  it('derives a reading gap when a declared metric has no reading at all', () => {
    const candidates = deriveGoalGapCandidates({
      goals: [goal()],
      evidence: {}, // nothing known
      now: NOW,
    });
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.gapKind).toBe('reading');
    expect(candidate.missingKnowledge).toBe(
      "What is the current value of monthly-churn-rate for goal 'Reduce monthly churn'?",
    );
    // critical rank 4, neutral severity 0.5 → 0.75
    expect(candidate.decisionImpact).toBe(0.75);
    expect(candidate.currentConfidence).toBe(0);
    expect(candidate.requiredConfidence).toBe(0.9);
    expect(candidate.informationValue).toBe(round4(0.75 * 0.9));
    expect(candidate.evidenceClaimIds).toEqual([]);
  });

  it('derives a standing gap for a metric-less goal with insufficient standing confidence', () => {
    const metricLess = goal({
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Regulatory readiness',
      metrics: [],
    });
    const candidates = deriveGoalGapCandidates({
      goals: [metricLess],
      evidence: {
        '44444444-4444-4444-8444-444444444444': { standingConfidence: 0.2 },
      },
      now: NOW,
    });
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.gapKind).toBe('standing');
    expect(candidate.gapKey).toBe('44444444-4444-4444-8444-444444444444|standing|');
    expect(candidate.missingKnowledge).toBe(
      "What is the current standing of goal 'Regulatory readiness' relative to its desired state?",
    );
    expect(candidate.currentConfidence).toBe(0.2);
    expect(candidate.requiredConfidence).toBe(0.9);
    expect(candidate.informationValue).toBe(round4(0.75 * 0.7));
  });

  it('derives NO candidate when the metric is on target', () => {
    const candidates = deriveGoalGapCandidates({
      goals: [goal()],
      evidence: {
        '11111111-1111-4111-8111-111111111111': {
          readings: [
            { metricName: 'monthly-churn-rate', value: 5.2, driverConfidence: 0, evidenceClaimIds: ['33333333-3333-4333-8333-333333333333'], evidenceBeliefIds: [] },
          ],
        },
      },
      now: NOW,
    });
    expect(candidates).toHaveLength(0);
  });

  it('derives NO driver candidate when the evidence already pins the drivers to the required confidence', () => {
    const candidates = deriveGoalGapCandidates({
      goals: [goal()],
      evidence: {
        '11111111-1111-4111-8111-111111111111': {
          readings: [
            { metricName: 'monthly-churn-rate', value: 8.4, driverConfidence: 0.95, evidenceClaimIds: ['33333333-3333-4333-8333-333333333333'], evidenceBeliefIds: [] },
          ],
        },
      },
      now: NOW,
    });
    expect(candidates).toHaveLength(0); // understood situation — no manufactured gap
  });

  it('derives NO standing candidate when the standing confidence meets the requirement', () => {
    const metricLess = goal({ id: '44444444-4444-4444-8444-444444444444', metrics: [] });
    const candidates = deriveGoalGapCandidates({
      goals: [metricLess],
      evidence: { '44444444-4444-4444-8444-444444444444': { standingConfidence: 0.95 } },
      now: NOW,
    });
    expect(candidates).toHaveLength(0);
  });

  it('handles mixed goals: per-metric driver/reading gaps plus standing, in stable order', () => {
    const mixed = goal({
      id: '55555555-5555-4555-8555-555555555555',
      priority: 'high',
      horizonEnd: '2027-06-30T00:00:00.000Z', // far — no bump
      metrics: [
        { name: 'nps', unit: 'points', direction: 'at_least', threshold: 40, lowerBound: null, upperBound: null },
        { name: 'tickets', unit: 'count', direction: 'at_most', threshold: 100, lowerBound: null, upperBound: null },
      ],
    });
    const metricLess = goal({ id: '66666666-6666-4666-8666-666666666666', title: 'Brand', priority: 'low', metrics: [], horizonEnd: '2027-12-01T00:00:00.000Z' });
    const candidates = deriveGoalGapCandidates({
      goals: [mixed, metricLess],
      evidence: {
        '55555555-5555-4555-8555-555555555555': {
          readings: [
            // nps is on target (45 ≥ 40) → no candidate
            { metricName: 'nps', value: 45, driverConfidence: 0, evidenceClaimIds: ['33333333-3333-4333-8333-333333333333'], evidenceBeliefIds: [] },
            // tickets off target AND drivers partially known (0.3 < 0.8) → driver gap
            { metricName: 'tickets', value: 160, driverConfidence: 0.3, evidenceClaimIds: ['33333333-3333-4333-8333-333333333333'], evidenceBeliefIds: ['77777777-7777-4777-8777-777777777777'] },
          ],
        },
      },
      now: NOW,
    });
    // mixed: driver(tickets); metricLess: standing(Brand, low priority)
    expect(candidates.map((c) => c.gapKind)).toEqual(['driver', 'standing']);
    const driver = candidates[0]!;
    expect(driver.urgency).toBe('high'); // high priority, far horizon — no bump
    expect(driver.currentConfidence).toBe(0.3);
    expect(driver.requiredConfidence).toBe(0.8);
    // impact: high rank 3, severity 0.6 → 0.75·(0.5+0.3)=0.6; value 0.6·0.5=0.3
    expect(driver.decisionImpact).toBe(0.6);
    expect(driver.informationValue).toBe(0.3);
    expect(driver.evidenceBeliefIds).toEqual(['77777777-7777-4777-8777-777777777777']);
    const standing = candidates[1]!;
    expect(standing.urgency).toBe('low');
    // low rank 1, neutral severity → 0.25·0.75=0.1875 — below every default gate
    expect(standing.decisionImpact).toBe(0.1875);
  });

  it('is deterministic: identical inputs produce deeply equal candidates', () => {
    const input = {
      goals: [goal()],
      evidence: {
        '11111111-1111-4111-8111-111111111111': {
          readings: [
            { metricName: 'monthly-churn-rate', value: 8.4, driverConfidence: 0, evidenceClaimIds: ['33333333-3333-4333-8333-333333333333'], evidenceBeliefIds: [] },
          ],
        },
      } as Record<string, { readings: { metricName: string; value: number; driverConfidence: number; evidenceClaimIds: string[]; evidenceBeliefIds: string[] }[] }>,
      now: NOW,
    };
    expect(deriveGoalGapCandidates(input)).toEqual(deriveGoalGapCandidates(input));
  });
});

describe('evaluateMateriality — ADR-0017’s policy gate', () => {
  const policy = { impactThreshold: 0.5, valueThreshold: 0.5 };

  it('is material when decision impact AND information value meet the thresholds', () => {
    expect(evaluateMateriality({ decisionImpact: 0.7, informationValue: 0.63 }, policy)).toEqual({
      material: true,
      reason: 'material',
    });
    // exactly at the thresholds is material (>=)
    expect(evaluateMateriality({ decisionImpact: 0.5, informationValue: 0.5 }, policy).material).toBe(true);
  });

  it('reports which threshold failed — the auditable why', () => {
    expect(evaluateMateriality({ decisionImpact: 0.25, informationValue: 0.63 }, policy)).toEqual({
      material: false,
      reason: 'impact_below_threshold',
    });
    expect(evaluateMateriality({ decisionImpact: 0.7, informationValue: 0.3 }, policy)).toEqual({
      material: false,
      reason: 'value_below_threshold',
    });
    expect(evaluateMateriality({ decisionImpact: 0.25, informationValue: 0.3 }, policy)).toEqual({
      material: false,
      reason: 'impact_and_value_below_threshold',
    });
  });

  it('applies the run’s own thresholds, not hardcoded ones', () => {
    const strict = { impactThreshold: 0.9, valueThreshold: 0.9 };
    expect(evaluateMateriality({ decisionImpact: 0.7, informationValue: 0.63 }, strict).material).toBe(false);
    const lenient = { impactThreshold: 0.2, valueThreshold: 0.2 };
    expect(evaluateMateriality({ decisionImpact: 0.25, informationValue: 0.3 }, lenient).material).toBe(true);
  });
});
