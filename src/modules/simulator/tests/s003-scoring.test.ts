// S003 — the module-level unit tests of the pure W100 scoring surface
// (no database, no clock: the simulator's own unit-test discipline). These
// pin the benchmark's DESIGN CONTRACTS: the deterministic cohort, the
// latent-score criterion, the factor formulas over controlled inputs, the
// F19 conversion interaction, the partial-maturity labeling and the
// cohort aggregation semantics.

import { describe, expect, it } from 'vitest';
import {
  S003_BASELINE_COST_MODEL,
  S003_FACTOR_KEYS,
  S003_FACTOR_WEIGHTS,
  S003_FIRM_SIZES,
  S003_HETEROGENEITY_SIGMA,
  S003_INDUSTRIES,
  S003_MATURATION_ASSUMPTIONS,
  S003_MATURITY_CREDITS,
  S003_MATURE_LEVERS,
  S003_MATURE_STATE_PROJECTS,
  S003_MONTHS_PER_SCENARIO,
  S003_PROJECTS_PER_MONTH,
  S003_ROLES,
  S003_ROSTER_PATTERN,
  S003_ROLE_EMPLOYEE_INDEX,
  S003_SCORE_INTERCEPT,
  S003_THRESHOLD_ONLY,
  S003_THRESHOLD_PRIMARY,
  clamp01,
  round6,
  s003AffinityDraw,
  s003Cohort,
  s003LatentScore,
  s003SeedFor,
  aggregateS003Scenario,
  composeS003FirmResult,
  scoreS003Scenario,
  s003LeversForFirm,
  s003PartialMaturityForFirm,
  S003_EXPECTED_GOVERNANCE_EVENTS,
  S003_ROLE_FRICTION_BASE,
  S003_TRUST_SURFACES,
  type S003ComposedMeasurement,
  type S003LoopMeasurement,
} from '../contract';

// ---------------------------------------------------------------------------
// Fixtures (controlled measured inputs)
// ---------------------------------------------------------------------------

const FIRM = s003Cohort()[0]!; // sales-small

function loopFixture(overrides: Partial<S003LoopMeasurement> = {}): S003LoopMeasurement {
  const months = [7, 1, 1, 1].map((steps, index) => ({
    month: index + 1,
    topic: 'churn-driver',
    steps,
    firstChoiceKind: index === 0 ? ('person' as const) : ('system' as const),
    firstChoiceLabel: index === 0 ? 'Controller' : 'Billing CRM',
    firstChoiceCorrect: index === 0 ? 0 : 1,
    firstChoiceTotal: 1,
    medianSteps: steps,
    meanSteps: steps,
    predictionErrorMean: [1.5, 0.55, 0.15, 0.15][index]!,
    metOrExceededRate: index === 0 ? 0 : 1,
    realizedValueSum: 11.48,
    netVarianceSum: [-1.42, -0.55, -0.15, -0.15][index]!,
    windowPlans: steps,
    windowCostMinor: steps === 7 ? 150 : 150,
    observations: steps + 1,
    meanConfidence: steps === 7 ? 0.70625 : 0.94,
    shareWithConfidenceBasis: 1,
    learningRecorded: true,
  }));
  return {
    months,
    totalSteps: 10,
    meanSteps: 2.5,
    firstChoiceCorrectRate: 0.75,
    meanPredictionError: 0.5875,
    evidenceMeanConfidence: 0.881562,
    evidenceShareWithConfidenceBasis: 1,
    totalRealizedValueSum: 45.92,
    meanNetVariance: -0.5675,
    totalWindowCostMinor: 600,
    interventionsExecuted: 4,
    participationByRole: { controller: 2, operations: 5, support: 1, fulfillment: 3, analyst: 2 },
    channelsOfLoop: 1,
    ...overrides,
  };
}

function composedFixture(
  overrides: Partial<S003ComposedMeasurement> & { mature?: boolean } = {},
): S003ComposedMeasurement {
  const mature = overrides.mature ?? false;
  const base: S003ComposedMeasurement = {
    leverInvocations: {
      'integration-discovery': mature ? 10 : 0,
      'connection-lifecycle': mature ? 6 : 0,
      'progressive-grants': mature ? 12 : 0,
      'deep-action-execution': mature ? 11 : 0,
      'migration-continuity': mature ? 8 : 0,
      'vertical-kit': 0,
      'channel-coverage': mature ? 10 : 0,
      'edge-jobs': 0,
      'browser-fallback': 0,
      'agent-supervision': mature ? 4 : 0,
    },
    effort: {
      contractCalls: mature ? 61 : 0,
      approvals: mature ? 7 : 0,
      elapsedSimulatedMinutes: mature ? 134 : 0,
    },
    coverage: {
      systemsDiscovered: mature ? 3 : 0,
      systemsConnected: mature ? 3 : 0,
      systemsVerified: mature ? 3 : 0,
      systemsWithWritePath: mature ? 2 : 0,
      channelsWithEvidence: mature ? 4 : 1,
    },
    deepAction: {
      tasks: mature ? 1 : 0,
      operations: mature ? 2 : 0,
      opsExecuted: mature ? 2 : 0,
      opsReconciledClean: mature ? 1 : 0,
      opsMismatched: mature ? 1 : 0,
      preStateEvidence: mature ? 2 : 0,
      postStateEvidence: mature ? 2 : 0,
      mismatchUnknowns: mature ? 1 : 0,
    },
    migration: {
      roundsCommitted: mature ? 1 : 0,
      recordsImported: mature ? 3 : 0,
      identifierMappings: mature ? 3 : 0,
      conflictsSurfaced: 0,
      divergencesSurfaced: mature ? 1 : 0,
    },
    kit: { installed: false, active: false, capabilitiesInvoked: 0 },
    browser: { tasks: 0, stepsVerified: 0 },
    edge: { jobsIssued: 0, jobsSucceeded: 0 },
    channels: {
      messagesOutbound: mature ? 1 : 0,
      smsReachAttempts: mature ? 1 : 0,
      meetingsIngested: mature ? 2 : 0,
    },
    supervision: {
      agentsSupervised: mature ? 1 : 0,
      executionsAdmitted: mature ? 1 : 0,
      healthObservations: mature ? 1 : 0,
    },
    trust: {
      gateDecisionsRecorded: mature ? 5 : 0,
      actionRequestsSubmitted: mature ? 5 : 0,
      verificationRunsClean: mature ? 3 : 0,
      verificationRunsTotal: mature ? 3 : 0,
      auditLedgersWithEntries: mature ? 5 : 3,
    },
  };
  const { mature: _ignored, ...rest } = overrides;
  void _ignored;
  return { ...base, ...rest };
}

// ---------------------------------------------------------------------------
// The cohort design
// ---------------------------------------------------------------------------

describe('the S003 cohort design', () => {
  it('is the S002 population: 11 industries x 3 sizes, one deterministic seed per firm', () => {
    const cohort = s003Cohort();
    expect(cohort).toHaveLength(33);
    expect(S003_INDUSTRIES).toHaveLength(11);
    expect(S003_FIRM_SIZES).toHaveLength(3);
    expect(new Set(cohort.map((firm) => firm.seed)).size).toBe(33);
    expect(new Set(cohort.map((firm) => firm.key)).size).toBe(33);
    // The S002 size cohorts: 30/120/500 professionals scaled to 8/16/32.
    expect(S003_ROSTER_PATTERN.small).toHaveLength(8);
    expect(S003_ROSTER_PATTERN.medium).toHaveLength(16);
    expect(S003_ROSTER_PATTERN.large).toHaveLength(32);
    expect(
      cohort.reduce((sum, firm) => sum + firm.professionals.length, 0),
    ).toBe(11 * (8 + 16 + 32));
  });

  it('the same seed always materializes the same firm (reproducibility)', () => {
    expect(s003SeedFor(0, 0)).toBe(s003SeedFor(0, 0));
    expect(s003SeedFor(3, 2)).not.toBe(s003SeedFor(4, 2));
    const first = s003Cohort();
    const second = s003Cohort();
    expect(first).toEqual(second);
    // The affinity draws are deterministic per (seed, professional index).
    expect(s003AffinityDraw(12345, 0)).toBe(s003AffinityDraw(12345, 0));
    expect(s003AffinityDraw(12345, 0)).not.toBe(s003AffinityDraw(12345, 1));
    for (const firm of first) {
      for (const professional of firm.professionals) {
        expect(professional.affinityDraw).toBe(
          round6(s003AffinityDraw(firm.seed, professional.index)),
        );
        expect(Math.abs(professional.affinityDraw)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every role maps to a distinct simulator reference employee', () => {
    expect(S003_ROLES).toHaveLength(5);
    expect(new Set(Object.values(S003_ROLE_EMPLOYEE_INDEX)).size).toBe(5);
    for (const index of Object.values(S003_ROLE_EMPLOYEE_INDEX)) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(5);
    }
  });

  it('the portfolio representation reaches the S002 mature state', () => {
    expect(S003_MONTHS_PER_SCENARIO * S003_PROJECTS_PER_MONTH).toBe(
      S003_MATURE_STATE_PROJECTS,
    );
    expect(S003_MATURE_STATE_PROJECTS).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// The latent criterion
// ---------------------------------------------------------------------------

describe('the latent switching criterion', () => {
  it('is a logistic over the eleven weighted factors with the committed intercept', () => {
    const factors = Object.fromEntries(
      S003_FACTOR_KEYS.map((key) => [key, 0.5]),
    ) as Record<(typeof S003_FACTOR_KEYS)[number], number>;
    const weightSum = Object.values(S003_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    const expected = 1 / (1 + Math.exp(-(S003_SCORE_INTERCEPT + weightSum * 0.5)));
    expect(s003LatentScore(factors)).toBeCloseTo(expected, 6);
    expect(S003_FACTOR_KEYS).toHaveLength(11);
    // The S002 criterion's eleven factors, by name.
    expect([...S003_FACTOR_KEYS]).toEqual([
      'organizationalIntelligenceValue',
      'oneWorkSurface',
      'channelAccessibility',
      'roleFit',
      'contextSwitchingReduction',
      'incumbentIndependence',
      'specialistIndependence',
      'reEntryRelief',
      'governanceHeadroom',
      'migrationEase',
      'roleSwitchEase',
    ]);
  });

  it('is strictly monotone in every factor and respects both thresholds', () => {
    for (const key of S003_FACTOR_KEYS) {
      const low = Object.fromEntries(S003_FACTOR_KEYS.map((k) => [k, 0.4]));
      const high = Object.fromEntries(S003_FACTOR_KEYS.map((k) => [k, 0.6]));
      (low as Record<string, number>)[key] = 0.4;
      (high as Record<string, number>)[key] = 0.6;
      expect(s003LatentScore(high as never)).toBeGreaterThan(s003LatentScore(low as never));
    }
    // The Aurum-only threshold is STRICTER than the Aurum-primary bar (F15).
    expect(S003_THRESHOLD_ONLY).toBeGreaterThan(S003_THRESHOLD_PRIMARY);
    expect(S003_THRESHOLD_ONLY).toBeGreaterThan(0.5);
    expect(S003_THRESHOLD_PRIMARY).toBeGreaterThan(0);
    expect(S003_THRESHOLD_PRIMARY).toBeLessThan(S003_THRESHOLD_ONLY);
  });

  it('the committed weights are frozen (Object.isFrozen) and positive', () => {
    expect(Object.isFrozen(S003_FACTOR_WEIGHTS)).toBe(true);
    for (const weight of Object.values(S003_FACTOR_WEIGHTS)) {
      expect(weight).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The factor formulas over controlled measured inputs
// ---------------------------------------------------------------------------

describe('the factor formulas', () => {
  it('the baseline factors: full re-entry burden, half channel credit, no composed coverage', () => {
    const result = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    // One-work-surface: the investigation half only.
    expect(result.factors.oneWorkSurface).toBe(0.6);
    // Channels: the loop's own chat channel at half credit (sublinear).
    expect(result.factors.channelAccessibility).toBe(0.5);
    // Re-entry relief: the baseline absorbs only the manual investigation
    // (1 - 840/1400 = 0.4; the cost model's no-Aurum counterfactual).
    expect(result.factors.reEntryRelief).toBeCloseTo(0.4, 6);
    // Switching: 1 - (4x3)/(7x4 + 4x3) = 0.7.
    expect(result.factors.contextSwitchingReduction).toBeCloseTo(0.7, 6);
    // The industry factors sit at their committed bases.
    expect(result.factors.incumbentIndependence).toBeCloseTo(
      1 - FIRM.industry.incumbentSoRDependence,
      6,
    );
    expect(result.factors.specialistIndependence).toBeCloseTo(
      1 - FIRM.industry.specialistDependence,
      6,
    );
    expect(result.factors.governanceHeadroom).toBeCloseTo(
      1 - FIRM.industry.complianceConstraint,
      6,
    );
    expect(result.factors.migrationEase).toBeCloseTo(1 - FIRM.size.migrationFriction, 6);
  });

  it('the composed factors move ONLY through the measured composition', () => {
    const baseline = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    const mature = scoreS003Scenario(FIRM, 'mature', loopFixture(), composedFixture({ mature: true }));
    // The core loop's value is IDENTICAL (never double-counted).
    expect(mature.factors.organizationalIntelligenceValue).toBe(
      baseline.factors.organizationalIntelligenceValue,
    );
    // The composed coverage (2/3 systems, conversion-damped) lifts the
    // work surface, channels and re-entry relief.
    expect(mature.factors.oneWorkSurface).toBeGreaterThan(baseline.factors.oneWorkSurface);
    expect(mature.factors.channelAccessibility).toBeGreaterThan(baseline.factors.channelAccessibility);
    expect(mature.factors.reEntryRelief).toBeGreaterThan(baseline.factors.reEntryRelief);
    expect(mature.factors.incumbentIndependence).toBeGreaterThan(baseline.factors.incumbentIndependence);
    expect(mature.factors.migrationEase).toBeGreaterThan(baseline.factors.migrationEase);
    // The governance headroom gains only the PARTIAL credit (the
    // authority/audit half is real; the deployment pack is not).
    const expectedGovernanceGain =
      FIRM.industry.complianceConstraint * S003_MATURITY_CREDITS.governanceCredit;
    expect(
      round6(mature.factors.governanceHeadroom - baseline.factors.governanceHeadroom),
    ).toBeCloseTo(round6(expectedGovernanceGain), 6);
  });

  it('the F19 conversion interaction damps generic relief in constrained industries', () => {
    const sales = s003Cohort().find((firm) => firm.key === 'sales-small')!;
    const finance = s003Cohort().find((firm) => firm.key === 'finance-large')!;
    const loop = loopFixture();
    const composed = composedFixture({ mature: true });
    const salesResult = scoreS003Scenario(sales, 'mature', loop, composed);
    const financeResult = scoreS003Scenario(finance, 'mature', loop, composed);
    // The SAME measured composition converts to less work-surface gain in
    // the compliance-constrained industry (F19: "general UX improvement
    // alone does little").
    const salesGain = salesResult.factors.oneWorkSurface - 0.6;
    const financeGain = financeResult.factors.oneWorkSurface - 0.6;
    expect(salesGain).toBeGreaterThan(0);
    expect(financeGain).toBeGreaterThan(0);
    expect(financeGain).toBeLessThan(salesGain);
    // The ratio is exactly the conversion terms.
    const salesConversion = 1 - sales.industry.complianceConstraint;
    const financeConversion = 1 - finance.industry.complianceConstraint;
    expect(financeGain / salesGain).toBeCloseTo(financeConversion / salesConversion, 6);
  });

  it('role fit follows the measured participation; the affinity draw modulates it', () => {
    const result = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    // Operations participated most (5 of 13 events) -> fit 1.0 before the draw.
    const operations = result.professionals.filter((p) => p.role === 'operations');
    expect(operations.length).toBeGreaterThan(0);
    for (const professional of operations) {
      const expected = round6(clamp01(1 * (1 + S003_HETEROGENEITY_SIGMA * professional.affinityDraw)));
      expect(professional.roleFit).toBeCloseTo(expected, 6);
    }
    // Support participated least (1) -> fit (0.4 + 0.6/5) before the draw.
    const support = result.professionals.find((p) => p.role === 'support')!;
    const expectedSupport = round6(
      clamp01((0.4 + 0.6 * (1 / 5)) * (1 + S003_HETEROGENEITY_SIGMA * support.affinityDraw)),
    );
    expect(support.roleFit).toBeCloseTo(expectedSupport, 6);
  });

  it('role switching ease follows the committed role frictions with the industry interaction', () => {
    const result = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    for (const professional of result.professionals) {
      const friction =
        S003_ROLE_FRICTION_BASE[professional.role] *
        (0.75 + 0.5 * FIRM.industry.specialistDependence);
      const expected = round6(clamp01((1 - friction) * (1 + S003_HETEROGENEITY_SIGMA * professional.affinityDraw)));
      expect(professional.roleSwitchEase).toBeCloseTo(expected, 6);
    }
    // Fulfillment (the execution role) is the stickiest; analyst the least.
    const fulfillment = result.professionals.find((p) => p.role === 'fulfillment')!;
    const analyst = result.professionals.find((p) => p.role === 'analyst')!;
    expect(fulfillment.roleSwitchEase).toBeLessThan(analyst.roleSwitchEase);
  });

  it('willingness uses both committed thresholds', () => {
    const result = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    for (const professional of result.professionals) {
      expect(professional.willingOnly).toBe(professional.score >= S003_THRESHOLD_ONLY);
      expect(professional.willingPrimary).toBe(professional.score >= S003_THRESHOLD_PRIMARY);
      if (professional.willingOnly) expect(professional.willingPrimary).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The trust measurement
// ---------------------------------------------------------------------------

describe('the trust measurement', () => {
  it('composes the five measured surfaces with equal weights', () => {
    const baseline = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    // Baseline: evidence basis 1.0, audit trail 3/5, everything composed 0.
    expect(baseline.measurements.trust.evidenceConfidenceBasis).toBe(1);
    expect(baseline.measurements.trust.gateDiscipline).toBe(0);
    expect(baseline.measurements.trust.verificationLedger).toBe(0);
    expect(baseline.measurements.trust.evidenceChain).toBe(0);
    expect(baseline.measurements.trust.auditTrail).toBeCloseTo(3 / S003_TRUST_SURFACES, 6);
    expect(baseline.measurements.trust.score).toBeCloseTo(
      0.2 * 1 + 0.2 * 0 + 0.2 * 0 + 0.2 * 0 + 0.2 * (3 / S003_TRUST_SURFACES),
      6,
    );

    const mature = scoreS003Scenario(FIRM, 'mature', loopFixture(), composedFixture({ mature: true }));
    expect(mature.measurements.trust.gateDiscipline).toBe(1); // 5 decided / 5 submitted
    expect(mature.measurements.trust.verificationLedger).toBe(1); // 3 clean / 3 total
    expect(mature.measurements.trust.evidenceChain).toBe(1); // 2 chained / 2 executed
    expect(mature.measurements.trust.auditTrail).toBe(1); // 5 ledgers / 5 surfaces
    expect(mature.measurements.trust.score).toBe(1);
    expect(S003_TRUST_SURFACES).toBe(5);
    expect(S003_EXPECTED_GOVERNANCE_EVENTS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The setup-effort measurement (labeled by origin)
// ---------------------------------------------------------------------------

describe('the integration setup effort measurement', () => {
  it('the baseline is the labeled manual cost model; the mature is measured', () => {
    const baseline = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    expect(baseline.measurements.setupEffort.origin).toBe('baseline-cost-model');
    expect(baseline.measurements.setupEffort.minutes).toBe(
      FIRM.industry.systems.length *
        S003_BASELINE_COST_MODEL.manualSetupMinutesPerSystem +
        4 * S003_BASELINE_COST_MODEL.reEntryMinutesPerTask,
    );
    const mature = scoreS003Scenario(FIRM, 'mature', loopFixture(), composedFixture({ mature: true }));
    expect(mature.measurements.setupEffort.origin).toBe('measured');
    expect(mature.measurements.setupEffort.steps).toBe(61);
    expect(mature.measurements.setupEffort.approvals).toBe(7);
    // measured minutes = approvals x 10 + elapsed 134 + residual re-entry.
    const residual =
      4 * (1 - (2 / 3) * (1 - FIRM.industry.complianceConstraint)) *
      S003_BASELINE_COST_MODEL.reEntryMinutesPerTask;
    expect(mature.measurements.setupEffort.minutes).toBeCloseTo(
      7 * S003_BASELINE_COST_MODEL.approvalMinutes + 134 + round6(residual),
      3,
    );
  });
});

// ---------------------------------------------------------------------------
// The lever + assumption registries and the per-firm labels
// ---------------------------------------------------------------------------

describe('the maturity registries', () => {
  it('the seven S002 maturation assumptions are labeled by real maturity', () => {
    expect(S003_MATURATION_ASSUMPTIONS).toHaveLength(7);
    const maturities = new Set(S003_MATURATION_ASSUMPTIONS.map((entry) => entry.maturity));
    expect(maturities).toContain('real');
    expect(maturities).toContain('partial');
    expect(maturities).toContain('none');
    // Every non-'none' assumption cites real contracts.
    for (const assumption of S003_MATURATION_ASSUMPTIONS) {
      if (assumption.maturity === 'none') {
        expect(assumption.contracts).toHaveLength(0);
      } else {
        expect(assumption.contracts.length).toBeGreaterThan(0);
        for (const citation of assumption.contracts) {
          expect(citation).toMatch(/contract\.ts/);
        }
      }
    }
  });

  it('the ten mature levers each cite their contracts', () => {
    expect(S003_MATURE_LEVERS).toHaveLength(10);
    for (const lever of S003_MATURE_LEVERS) {
      expect(lever.contracts.length).toBeGreaterThan(0);
      expect(lever.label.length).toBeGreaterThan(0);
    }
  });

  it('the per-firm levers are industry-conditional and the labels honest', () => {
    for (const firm of s003Cohort()) {
      const levers = s003LeversForFirm(firm);
      // Every firm composes the universal levers.
      for (const universal of [
        'integration-discovery',
        'connection-lifecycle',
        'progressive-grants',
        'deep-action-execution',
        'migration-continuity',
        'channel-coverage',
        'agent-supervision',
      ] as const) {
        expect(levers).toContain(universal);
      }
      // The kit lever fires only where a real kit ships.
      expect(levers.includes('vertical-kit')).toBe(firm.industry.verticalKitKey !== null);
      // The edge lever fires only for on-prem stacks.
      expect(levers.includes('edge-jobs')).toBe(firm.industry.onPrem);
      // The browser lever fires only where a system has no API.
      expect(levers.includes('browser-fallback')).toBe(
        firm.industry.browserFallbackSystem !== null,
      );
      // Every firm carries the honest partial-maturity labels.
      const labels = s003PartialMaturityForFirm(firm);
      expect(labels).toContain('role-native-ux');
      expect(labels).toContain('regulated-trust-packs:deployment-residency-half');
      expect(labels.includes('vertical-extensions:no-shipped-kit')).toBe(
        firm.industry.verticalKitKey === null,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The pairwise firm result and the cohort aggregation
// ---------------------------------------------------------------------------

describe('the pairwise deliverable and the aggregation', () => {
  it('composeS003FirmResult pairs the scenarios and computes the six deltas', () => {
    const baseline = scoreS003Scenario(FIRM, 'baseline', loopFixture(), composedFixture());
    const mature = scoreS003Scenario(FIRM, 'mature', loopFixture(), composedFixture({ mature: true }));
    const firm = composeS003FirmResult(FIRM, baseline, mature);
    expect(firm.key).toBe(FIRM.key);
    expect(firm.baseline).toBe(baseline);
    expect(firm.mature).toBe(mature);
    expect(firm.delta.aurumOnlyShare).toBe(
      round6(
        mature.professionals.filter((p) => p.willingOnly).length /
          mature.professionals.length -
          baseline.professionals.filter((p) => p.willingOnly).length /
            baseline.professionals.length,
      ),
    );
    expect(firm.delta.trust).toBe(
      round6(mature.measurements.trust.score - baseline.measurements.trust.score),
    );
  });

  it('aggregateS003Scenario counts professionals (never means of firm shares)', () => {
    const firms = [s003Cohort()[0]!, s003Cohort()[1]!].map((firm) => {
      const baseline = scoreS003Scenario(firm, 'baseline', loopFixture(), composedFixture());
      const mature = scoreS003Scenario(firm, 'mature', loopFixture(), composedFixture({ mature: true }));
      return composeS003FirmResult(firm, baseline, mature);
    });
    const aggregate = aggregateS003Scenario(firms, 'baseline');
    expect(aggregate.professionals).toBe(
      firms[0]!.baseline.professionals.length + firms[1]!.baseline.professionals.length,
    );
    const willing =
      firms[0]!.baseline.professionals.filter((p) => p.willingOnly).length +
      firms[1]!.baseline.professionals.filter((p) => p.willingOnly).length;
    expect(aggregate.aurumOnlyShare).toBeCloseTo(willing / aggregate.professionals, 6);
    expect(aggregate.byIndustry).toHaveLength(1);
    // The aggregate emits only the sizes that hold professionals
    // (a zero-professional row would violate the schema of record).
    expect(aggregate.bySize).toHaveLength(2);
    expect(aggregate.bySize.map((row) => row.sizeKey).sort()).toEqual(['medium', 'small']);
  });
});
