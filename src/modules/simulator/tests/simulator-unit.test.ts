// Unit tests for the pure simulator engine (W056) — no database, no clock.
// Covers the deterministic world derivation, the planner-signal composition
// (the benchmark's learned-signal channel), the exact walk arithmetic of
// the frozen reference company (cold start = 7 steps, experienced = 1 from
// month 2), the intervention-expectation math and the confidence schedule
// — plus the promotion envelope verified against the attention module's
// OWN pure derivation (the module's scenario guarantee).
import { describe, expect, it } from 'vitest';
import {
  deriveGoalGapCandidates,
  evaluateMateriality,
  DEFAULT_IMPACT_THRESHOLD,
  DEFAULT_VALUE_THRESHOLD,
} from '@/modules/attention/contract';
import {
  SIGNAL_WEIGHTS,
  scoreCandidateSignals,
} from '@/modules/knowledge-acquisition/contract';
import {
  BENCHMARK_MONTHS,
  MATERIALITY_POLICY,
  REFERENCE_EMPLOYEES,
  REFERENCE_SYSTEMS,
  TOPIC_CYCLE,
  TOTAL_MONTHS,
  composePlannerSignals,
  deriveCompanyDesign,
  interventionExpectation,
  mulberry32,
  nextPriorConfidence,
} from '../world';

const SEED_A = 0x005eedc0;
const SEED_B = 0x0badc0de;

describe('mulberry32 — deterministic PRNG', () => {
  it('produces identical streams for identical seeds', () => {
    const left = mulberry32(SEED_A);
    const right = mulberry32(SEED_A);
    for (let index = 0; index < 100; index += 1) {
      expect(left()).toBe(right());
    }
  });

  it('produces different streams for different seeds', () => {
    const left = mulberry32(SEED_A);
    const right = mulberry32(SEED_B);
    let diverged = false;
    for (let index = 0; index < 100; index += 1) {
      if (left() !== right()) diverged = true;
    }
    expect(diverged).toBe(true);
  });
});

describe('deriveCompanyDesign — the seeded synthetic company', () => {
  it('is a pure function of the seed (identical designs)', () => {
    expect(deriveCompanyDesign(SEED_A)).toEqual(deriveCompanyDesign(SEED_A));
  });

  it('different seeds produce different companies but the same structure', () => {
    const a = deriveCompanyDesign(SEED_A);
    const b = deriveCompanyDesign(SEED_B);
    expect(a.companyName).not.toBe(b.companyName);
    expect(a.employees).not.toHaveLength(0);
    expect(a.employees.map((employee) => employee.fullName)).not.toEqual(
      b.employees.map((employee) => employee.fullName),
    );
    // Structure is the frozen reference template.
    expect(a.employees).toHaveLength(REFERENCE_EMPLOYEES.length);
    expect(a.systems).toHaveLength(REFERENCE_SYSTEMS.length);
    expect(a.systems.map((system) => system.key)).toEqual(b.systems.map((system) => system.key));
    expect(a.months).toHaveLength(TOTAL_MONTHS);
    expect(a.months.map((month) => month.topic)).toEqual(b.months.map((month) => month.topic));
  });

  it('gives every month a unique leak-detection marker', () => {
    const design = deriveCompanyDesign(SEED_A);
    const markers = new Set(design.months.map((month) => month.hidden.marker));
    expect(markers.size).toBe(TOTAL_MONTHS);
    for (const month of design.months) {
      // The marker never appears in the answer the world gives.
      expect(month.hidden.answerText).not.toContain(month.hidden.marker);
    }
  });

  it('keeps every reading inside the promotion envelope (attention verifies)', () => {
    // The scenario guarantee: for every seed and every month, the reading is
    // off target with low driver confidence such that the attention
    // module's OWN derivation derives exactly one material driver gap.
    for (const seed of [SEED_A, SEED_B, 1, 42, 0x7fff_ffff]) {
      const design = deriveCompanyDesign(seed);
      for (const scenario of design.months) {
        const candidates = deriveGoalGapCandidates({
          goals: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: design.goal.title,
              objective: design.goal.objective,
              desiredState: design.goal.desiredState,
              priority: 'critical',
              horizonEnd: design.goal.horizonEnd,
              metrics: [
                {
                  name: design.goal.metricName,
                  unit: design.goal.metricUnit,
                  direction: 'at_most',
                  threshold: design.goal.threshold,
                  lowerBound: null,
                  upperBound: null,
                },
              ],
              evidenceSources: [],
            },
          ],
          evidence: {
            '11111111-1111-4111-8111-111111111111': {
              readings: [
                {
                  metricName: design.goal.metricName,
                  value: scenario.readingValue,
                  driverConfidence: design.goal.driverConfidence,
                  evidenceClaimIds: [],
                  evidenceBeliefIds: [],
                },
              ],
            },
          },
          now: new Date('2026-06-15T00:00:00.000Z'),
        });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.gapKind).toBe('driver');
        const decision = evaluateMateriality(candidates[0]!, {
          impactThreshold: DEFAULT_IMPACT_THRESHOLD,
          valueThreshold: DEFAULT_VALUE_THRESHOLD,
        });
        expect(decision.material).toBe(true);
      }
    }
  });

  it('cycles the eight monthly topics across the 24 months', () => {
    const design = deriveCompanyDesign(SEED_A);
    for (let month = 1; month <= TOTAL_MONTHS; month += 1) {
      expect(design.months[month - 1]!.topic).toBe(TOPIC_CYCLE[(month - 1) % TOPIC_CYCLE.length]);
    }
    expect(BENCHMARK_MONTHS).toEqual([1, 3, 6, 12, 24]);
  });
});

// ---------------------------------------------------------------------------
// The exact walk arithmetic of the frozen reference company
// ---------------------------------------------------------------------------

/** The planner's composite score for one candidate (the W012 definition). */
function plannerScore(signals: {
  relevance: number;
  reliability: number;
  freshness: number;
  authority: number;
  expectedQuality: number;
  priorContributionValue: number;
}, cost: number): number {
  return scoreCandidateSignals(signals, cost, 50_000).score;
}

const MENU = [
  ...REFERENCE_EMPLOYEES.map((employee, index) => ({
    kind: 'person' as const,
    id: `employee-uuid-${index}`,
    label: employee.fullName || employee.title,
    authority: employee.authority,
    costMinor: 0,
    hiddenQuality: employee.hiddenQuality,
  })),
  ...REFERENCE_SYSTEMS.map((system) => ({
    kind: 'system' as const,
    id: `source-uuid-${system.key}`,
    label: system.label,
    authority: system.authority,
    costMinor: system.costMinor,
    hiddenQuality: system.hiddenQuality,
  })),
];

describe('composePlannerSignals — the learned-signal channel', () => {
  it('feeds byte-identical neutral signals when nothing is learned', () => {
    const signals = composePlannerSignals(MENU, new Map());
    expect(signals).toHaveLength(MENU.length);
    for (const signal of signals) {
      expect(signal.reliability).toBe(0.5);
      expect(signal.expectedQuality).toBe(0.5);
      expect(signal.relevance).toBe(0.5);
      expect(signal.freshness).toBe(0.5);
      expect(signal.priorContributionValue).toBe(0.5);
      expect(signal.access).toBe('allowed');
      expect(signal.cost).toBe(
        MENU.find((entry) => entry.id === signal.id)!.costMinor,
      );
    }
  });

  it('carries the CompanyModel blend into reliability and expected quality', () => {
    const learned = new Map([['source:source-uuid-billing-crm', 0.764]]);
    const signals = composePlannerSignals(MENU, learned);
    const crm = signals.find((signal) => signal.id === 'source-uuid-billing-crm')!;
    expect(crm.reliability).toBe(0.764);
    expect(crm.expectedQuality).toBe(0.764);
    const dana = signals.find((signal) => signal.id === 'employee-uuid-0')!;
    expect(dana.reliability).toBe(0.5);
  });

  it('the cold start walks exactly 7 steps and only the CRM clears the bar', () => {
    // No priors: the planner's fixed weights order the menu by public
    // authority; the walk accumulates the best answer confidence and
    // completes when it reaches the critical goal's required confidence
    // (0.9) — which only the CRM (0.98) clears, in 7th position.
    const signals = composePlannerSignals(MENU, new Map());
    const scored = MENU.map((entry, index) => ({
      entry,
      score: plannerScore(
        {
          relevance: signals[index]!.relevance,
          reliability: signals[index]!.reliability,
          freshness: signals[index]!.freshness,
          authority: signals[index]!.authority,
          expectedQuality: signals[index]!.expectedQuality,
          priorContributionValue: signals[index]!.priorContributionValue,
        },
        entry.costMinor,
      ),
    }));
    const order = [...scored].sort((a, b) => b.score - a.score);

    // Every cold score is unique (no uuid-dependent tie-breaks).
    const scores = order.map((ranked) => ranked.score);
    expect(new Set(scores).size).toBe(MENU.length);

    // The walk: accumulate max-confidence; only the CRM reaches 0.9.
    let confidence = 0.2; // the reading's driver confidence
    let steps = 0;
    let lastQuality = 0;
    for (const ranked of order) {
      steps += 1;
      confidence = Math.max(confidence, ranked.entry.hiddenQuality);
      lastQuality = ranked.entry.hiddenQuality;
      if (confidence >= 0.9) break;
    }
    expect(steps).toBe(7);
    expect(order[steps - 1]!.entry.kind).toBe('system');
    expect((order[steps - 1]!.entry as { id: string }).id).toBe('source-uuid-billing-crm');
    expect(lastQuality).toBe(0.98);
    expect(order[0]!.entry.kind).toBe('person'); // the Controller — highest authority
    expect(order[0]!.entry.hiddenQuality).toBe(0.72); // and judged incorrect (< 0.9)
  });

  it('the month-2 learned priors put the CRM first (one step)', () => {
    // After month 1 the experienced instance has learned every queried
    // source's reliability at confidence 0.55 (schedule version 1):
    // blend = 0.5·0.45 + q·0.55.
    const learned = new Map<string, number>();
    for (const entry of MENU) {
      const key = `${entry.kind === 'person' ? 'employee' : 'source'}:${entry.id}`;
      // Month 1 walks the first 7 candidates (everyone but ERP and sheets).
      learned.set(key, 0.5 * 0.45 + entry.hiddenQuality * 0.55);
    }
    const signals = composePlannerSignals(MENU, learned);
    const scored = MENU.map((entry, index) => ({
      entry,
      score: plannerScore(
        {
          relevance: signals[index]!.relevance,
          reliability: signals[index]!.reliability,
          freshness: signals[index]!.freshness,
          authority: signals[index]!.authority,
          expectedQuality: signals[index]!.expectedQuality,
          priorContributionValue: signals[index]!.priorContributionValue,
        },
        entry.costMinor,
      ),
    }));
    const order = [...scored].sort((a, b) => b.score - a.score);
    expect(order[0]!.entry.kind).toBe('system');
    expect((order[0]!.entry as { id: string }).id).toBe('source-uuid-billing-crm');
    // The margin over the runner-up is comfortable, not razor-thin.
    expect(order[0]!.score - order[1]!.score).toBeGreaterThan(0.01);
    // One step resolves: the CRM's 0.98 clears the 0.9 bar immediately.
    expect(order[0]!.entry.hiddenQuality).toBeGreaterThanOrEqual(0.9);
  });

  it('the frozen policies are deeply frozen (never relaxed between runs)', () => {
    expect(Object.isFrozen(MATERIALITY_POLICY)).toBe(true);
    expect(MATERIALITY_POLICY.impactThreshold).toBe(0.5);
    expect(MATERIALITY_POLICY.valueThreshold).toBe(0.5);
  });

  it('the planner weights are the fixed W012 policy (documentation pin)', () => {
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

describe('interventionExpectation — the recommendation-quality leg', () => {
  it('expects the base in full with no learned prior', () => {
    expect(interventionExpectation(12, 1)).toBe(12);
  });

  it('converges toward the hidden realized value as confidence grows', () => {
    // The learned prior score is the realized/expected ratio 10.5/12 =
    // 0.875; rankCandidates blends baseScore 1.0 with it by confidence.
    const blend = (confidence: number): number => 1 * (1 - confidence) + 0.875 * confidence;
    // Cold / month 1: error 1.5.
    expect(interventionExpectation(12, blend(0))).toBe(12);
    // After one recorded version (confidence 0.55): 11.175.
    expect(interventionExpectation(12, blend(0.55))).toBeCloseTo(11.175, 3);
    // After two (0.7): 10.95; after three (0.85) and beyond (0.9): 10.65.
    expect(interventionExpectation(12, blend(0.7))).toBeCloseTo(10.95, 3);
    expect(interventionExpectation(12, blend(0.85))).toBeCloseTo(10.725, 3);
    expect(interventionExpectation(12, blend(0.9))).toBeCloseTo(10.65, 3);
    // The hidden realized value is 10.5 — every experienced expectation is
    // strictly better calibrated than the cold 12, and the error shrinks
    // monotonically with the recorded versions.
    const errors = [0, 0.55, 0.7, 0.85, 0.9].map((confidence) =>
      Math.abs(interventionExpectation(12, blend(confidence)) - 10.5),
    );
    for (let index = 1; index < errors.length; index += 1) {
      expect(errors[index]!).toBeLessThan(errors[index - 1]!);
    }
  });
});

describe('nextPriorConfidence — the recorded-assertion schedule', () => {
  it('is monotone and capped', () => {
    expect(nextPriorConfidence(0)).toBe(0.55);
    expect(nextPriorConfidence(1)).toBe(0.7);
    expect(nextPriorConfidence(2)).toBe(0.85);
    expect(nextPriorConfidence(3)).toBe(0.9);
    expect(nextPriorConfidence(10)).toBe(0.9);
    for (let versions = 0; versions < 10; versions += 1) {
      expect(nextPriorConfidence(versions)).toBeLessThanOrEqual(nextPriorConfidence(versions + 1));
    }
  });
});
