// ============================================================================
// W056 — THE LONGITUDINAL BENCHMARK (spec/LONGITUDINAL-BENCHMARK.md,
// normative for W056). The work item:
// "run month 1/3/6/12/24 scenarios per LONGITUDINAL-BENCHMARK.md; prove
//  repeated work improves source routing, unknown resolution efficiency
//  or recommendation quality; prove no cross-tenant or hidden-ground-truth
//  leakage."
//
// DESIGN (the benchmark doc's own words, materialized):
//  * "Run identical seeded companies with equivalent goals and information
//    environments." — ONE seed materializes the company THREE ways:
//      - EXPERIENCED: months 1..24 with recorded CompanyModel learning
//        (the Aurum instance that has done the work before);
//      - CONTROL: months 1..24 with NO recorded learning — the same
//        history, the same evidence, but no CompanyModel deltas (the
//        attribution control the doc's failure conditions demand);
//      - COLD-START: a fresh tenant per checkpoint that materializes the
//        same company and runs ONLY the checkpoint month (1, 3, 6, 12 or
//        24) — the same month's information environment, zero history.
//    The month scenario is a pure function of (seed, month), so every
//    instance faces byte-identical monthly evidence.
//  * "The benchmark must compare an EXPERIENCED Aurum instance against a
//    COLD-START Aurum instance on the same company." — at every checkpoint
//    the experienced month-N quality snapshot (W055, all nine families) is
//    compared against the cold-start month-N snapshot.
//  * "Improvement must arise from recorded CompanyModel updates only." —
//    the control (history, no learning) must equal the cold start at every
//    checkpoint; the experienced instance's applied priors must resolve to
//    recorded assertion versions whose updates link settled outcomes and
//    answer evidence.
//
// MEASURED at months 1, 3, 6, 12 and 24 (the doc's ten measurements):
//   1. consequential unknown discovery precision/recall;
//   2. median investigation steps per resolved mission;
//   3. first-choice source quality;
//   4. employee routing accuracy;
//   5. mission completion time and cost;
//   6. recommendation calibration;
//   7. intervention realized value versus expected value;
//   8. repeated-task performance improvement (the steps trajectory);
//   9. evidence quality (the doc's stale/contradictory-evidence
//      measurement maps onto the evidence-quality family — every answer
//      is recorded as evidence with confidence and provenance, and the
//      observation series never mutates);
//  10. policy compliance and tenant isolation (the frozen-policy and
//      cross-tenant assertions below).
//
// FAILURE CONDITIONS (each is asserted to NOT hold):
//  * policy relaxed between runs — one frozen materiality policy feeds
//    every discovery run of every instance; every recorded run carries
//    the same thresholds; every persisted planner signal shows
//    access 'allowed' with the public costs;
//  * hidden facts directly exposed to the reasoning layer — the 24 hidden
//    markers never appear on any cognition surface of any instance, and
//    the hidden answers exist only as the evidence observations of
//    answered acquisition plans;
//  * provider-specific hidden state becomes authoritative — no provider is
//    involved anywhere in the loop; the only channel from outcomes to
//    behavior is the recorded CompanyModel update (asserted by
//    attribution) and the W054 intervention priors realizeIntervention
//    appends as evidence-linked records;
//  * improvement without recorded CompanyModel deltas — the control
//    tenant HAS the history and does NOT improve; the experienced tenant's
//    final ranking applies recorded priors traceable to settled outcomes.
//
// Determinism: the service clock ticks +60s per call from a per-month
// pinned base (the repo's pinned-clock discipline, extended with a tick
// because one advanceMonth call makes many contract calls). Non-time
// assertions are exact; time assertions are strict inequalities.
// ============================================================================

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { systemClock } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listDiscoveryRuns } from '@/modules/attention/contract';
import { listAcquisitionPlans } from '@/modules/knowledge-acquisition/contract';
import { listClaims } from '@/modules/epistemics/contract';
import { listMessages } from '@/modules/conversations/contract';
import { listObservations } from '@/modules/observations/contract';
import {
  getCompanyModel,
  getCompanyModelAssertion,
  getLearningUpdate,
  rankCandidates,
} from '@/modules/learning/contract';
import type { RankCandidateInput } from '@/modules/learning/contract';
import { getQualitySnapshot } from '@/modules/quality/contract';
import { getInterventionPriors } from '@/modules/outcomes/contract';
import type {
  InvestigationCostPayload,
  MissionResolutionEfficiencyPayload,
  QualityMetricResult,
  RealizedValuePayload,
  RecommendationCalibrationPayload,
  SourceSelectionPayload,
  UnknownDiscoveryPayload,
} from '@/modules/quality/types';
import { runMigrations } from '../../scripts/migrate';
import {
  BENCHMARK_MONTHS,
  MATERIALITY_POLICY,
  TOTAL_MONTHS,
  advanceMonth,
  deriveCompanyDesign,
  getCompany,
  listMonthReports,
  materializeCompany,
  revealGroundTruth,
} from '../../src/modules/simulator/contract';
import type { MonthReport, SimCompanyView } from '../../src/modules/simulator/types';

const SEED = 0x005eedc0;

const tenantExperienced = newId();
const tenantControl = newId();
const tenantCold: Record<number, string> = {};
for (const month of BENCHMARK_MONTHS) tenantCold[month] = newId();

function privileged(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: ['identity:attest', 'identity:link'],
  };
}

// The tick clock: every now() call advances 60s from the pinned base.
let virtualMs = Date.parse('2025-12-15T09:00:00.000Z');
function pinMonth(month: number): void {
  const year = month <= 12 ? 2026 : 2027;
  virtualMs = Date.UTC(year, (month - 1) % 12, 1, 0, 0, 0);
}

interface Instance {
  view: SimCompanyView;
  reports: MonthReport[];
}

const experienced: Instance = { view: null as unknown as SimCompanyView, reports: [] };
const control: Instance = { view: null as unknown as SimCompanyView, reports: [] };
const cold: Record<number, Instance> = {};

/** One month's quality snapshot payload, keyed by metric kind. */
function payloadsOf(results: QualityMetricResult[]): Map<string, unknown> {
  return new Map(results.map((result) => [result.metricKind, result.payload]));
}

async function snapshotOf(instance: Instance, month: number): Promise<Map<string, unknown>> {
  const report = instance.reports.find((entry) => entry.month === month)!;
  const snapshot = await getQualitySnapshot(privileged(instance.view.tenantId), {
    snapshotId: report.snapshotId!,
  });
  expect(snapshot.windowFrom).toBe(report.windowFrom);
  expect(snapshot.windowTo).toBe(report.windowTo);
  return payloadsOf(snapshot.results);
}

// The scenario (24 months × 2 instances + 5 cold-start checkpoints) runs
// ~15s; the hook timeout accommodates it under the repo's default config.
beforeAll(async () => {
  await runMigrations(getDb());
  vi.spyOn(systemClock, 'now').mockImplementation(() => {
    virtualMs += 60_000;
    return new Date(virtualMs);
  });

  // -- The experienced instance: 24 months, learning after every month.
  const ctxExperienced = privileged(tenantExperienced);
  experienced.view = await materializeCompany(ctxExperienced, { seed: SEED });
  for (let month = 1; month <= TOTAL_MONTHS; month += 1) {
    pinMonth(month);
    experienced.reports.push(
      await advanceMonth(ctxExperienced, {
        companyId: experienced.view.id,
        learning: true,
      }),
    );
  }

  // -- The control instance: the same 24 months, no recorded learning.
  const ctxControl = privileged(tenantControl);
  control.view = await materializeCompany(ctxControl, { seed: SEED });
  for (let month = 1; month <= TOTAL_MONTHS; month += 1) {
    pinMonth(month);
    control.reports.push(
      await advanceMonth(ctxControl, {
        companyId: control.view.id,
        learning: false,
      }),
    );
  }

  // -- The cold-start instances: a fresh tenant per checkpoint that begins
  //    working on the company AT the checkpoint month — the same month's
  //    information environment, zero history, zero learning.
  for (const month of BENCHMARK_MONTHS) {
    const ctx = privileged(tenantCold[month]!);
    cold[month] = {
      view: await materializeCompany(ctx, { seed: SEED, startMonth: month }),
      reports: [],
    };
    pinMonth(month);
    cold[month]!.reports.push(
      await advanceMonth(ctx, { companyId: cold[month]!.view.id, learning: false }),
    );
  }
}, 600_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

// ---------------------------------------------------------------------------
// The benchmark comparison at every checkpoint
// ---------------------------------------------------------------------------

describe('the longitudinal benchmark — experienced vs cold-start vs control', () => {
  it('month 1 is identical for every instance (no model, same behavior)', async () => {
    // Before any learning the instances are behaviorally identical —
    // whatever improvement appears later can only come from recorded
    // CompanyModel updates.
    const exp1 = await snapshotOf(experienced, 1);
    const cold1 = await snapshotOf(cold[1]!, 1);
    const ctrl1 = await snapshotOf(control, 1);
    expect(exp1).toEqual(cold1);
    expect(cold1).toEqual(ctrl1);
    expect(experienced.reports[0]!.steps).toBe(cold[1]!.reports[0]!.steps);
    expect(experienced.reports[0]!.firstChoice?.label).toBe(cold[1]!.reports[0]!.firstChoice?.label);
  });

  it('source routing improves: first-choice quality 0 → 1 while cold stays 0', async () => {
    for (const month of [3, 6, 12, 24]) {
      const exp = (await snapshotOf(experienced, month)).get('source-selection') as SourceSelectionPayload;
      const coldAtMonth = (await snapshotOf(cold[month]!, month)).get('source-selection') as SourceSelectionPayload;
      const ctrl = (await snapshotOf(control, month)).get('source-selection') as SourceSelectionPayload;

      // Measurement 3 — first-choice source quality (labeled).
      expect(exp.firstChoiceTotal).toBe(1);
      expect(exp.firstChoiceAnswerRate).toBe(1);
      expect(exp.correctFirstChoice).toBe(1);
      expect(exp.firstChoiceQualityRate).toBe(1);

      // The cold start and the control stay at the baseline: the
      // Controller is the first choice every time, and the oracle judges
      // that choice incorrect (hidden quality 0.72 < 0.9).
      expect(coldAtMonth.correctFirstChoice).toBe(0);
      expect(coldAtMonth.firstChoiceQualityRate).toBe(0);
      expect(ctrl.firstChoiceQualityRate).toBe(0);

      // Measurement 4 — employee routing accuracy: the cold start's only
      // ask-person first choice is judged incorrect; the experienced
      // instance routes to the CRM (a system) and has no employee samples.
      expect(coldAtMonth.employeeFirstChoice).toBe(1);
      expect(coldAtMonth.employeeJudged).toBe(1);
      expect(coldAtMonth.employeeCorrect).toBe(0);
      expect(coldAtMonth.employeeRoutingAccuracy).toBe(0);
      expect(exp.employeeFirstChoice).toBe(0);
      expect(exp.employeeRoutingAccuracy).toBeNull();
    }

    // The first choice itself: the Controller (person) cold, the
    // Billing CRM (system) experienced.
    expect(cold[3]!.reports[0]!.firstChoice?.kind).toBe('person');
    expect(experienced.reports[2]!.firstChoice?.kind).toBe('system');
    expect(experienced.reports[2]!.firstChoice?.label).toBe('Billing CRM');
  });

  it('unknown resolution efficiency improves: median steps 7 → 1', async () => {
    // Measurement 2 + 8.
    for (const month of [3, 6, 12, 24]) {
      const exp = (await snapshotOf(experienced, month)).get('mission-resolution-efficiency') as MissionResolutionEfficiencyPayload;
      const coldAtMonth = (await snapshotOf(cold[month]!, month)).get('mission-resolution-efficiency') as MissionResolutionEfficiencyPayload;
      const ctrl = (await snapshotOf(control, month)).get('mission-resolution-efficiency') as MissionResolutionEfficiencyPayload;

      expect(exp.resolvedMissions).toBe(1);
      expect(exp.medianSteps).toBe(1);
      expect(exp.meanSteps).toBe(1);

      expect(coldAtMonth.medianSteps).toBe(7);
      expect(coldAtMonth.meanSteps).toBe(7);
      expect(ctrl.medianSteps).toBe(7);
    }

    // Repeated-task performance: the trajectory over all 24 months.
    const experiencedSteps = experienced.reports.map((report) => report.steps);
    const controlSteps = control.reports.map((report) => report.steps);
    expect(experiencedSteps[0]).toBe(7);
    for (let month = 2; month <= TOTAL_MONTHS; month += 1) {
      expect(experiencedSteps[month - 1]).toBe(1);
    }
    for (const steps of controlSteps) expect(steps).toBe(7);
    const experiencedTotal = experiencedSteps.reduce((sum, steps) => sum + steps, 0);
    const controlTotal = controlSteps.reduce((sum, steps) => sum + steps, 0);
    expect(experiencedTotal).toBe(7 + (TOTAL_MONTHS - 1)); // 30 vs 168
    expect(controlTotal).toBe(7 * TOTAL_MONTHS);
    expect(experiencedTotal).toBeLessThan(controlTotal);
  });

  it('mission completion time improves; cost is equivalent', async () => {
    // Measurement 5.
    for (const month of [3, 6, 12, 24]) {
      const exp = (await snapshotOf(experienced, month)).get('time-to-useful-understanding') as {
        medianResolutionHours: number | null;
        medianTimeToFirstAnswerHours: number | null;
        missionsWithFirstAnswer: number;
      };
      const coldAtMonth = (await snapshotOf(cold[month]!, month)).get('time-to-useful-understanding') as {
        medianResolutionHours: number | null;
        medianTimeToFirstAnswerHours: number | null;
      };
      expect(exp.missionsWithFirstAnswer).toBe(1);
      expect(exp.medianResolutionHours!).toBeGreaterThan(0);
      expect(coldAtMonth.medianResolutionHours!).toBeGreaterThan(0);
      // One step resolves strictly faster than seven.
      expect(exp.medianResolutionHours!).toBeLessThan(coldAtMonth.medianResolutionHours!);

      const expCost = (await snapshotOf(experienced, month)).get('investigation-cost') as InvestigationCostPayload;
      const coldCost = (await snapshotOf(cold[month]!, month)).get('investigation-cost') as InvestigationCostPayload;
      expect(coldCost.windowPlans).toBe(7);
      expect(coldCost.windowCostByCurrency).toEqual([
        { currency: 'EUR', plans: 7, totalCost: 150 },
      ]);
      expect(coldCost.costPerResolvedMissionByCurrency).toEqual([
        { currency: 'EUR', missions: 1, totalCost: 150, medianCost: 150, meanCost: 150 },
      ]);
      // The experienced instance pays the same CRM query and nothing else.
      expect(expCost.windowPlans).toBe(1);
      expect(expCost.windowCostByCurrency).toEqual([
        { currency: 'EUR', plans: 1, totalCost: 150 },
      ]);
    }
  });

  it('recommendation calibration improves: prediction error 1.5 → 0.45 → 0.15', async () => {
    // Measurement 6 — the recommendation-quality leg (the learned
    // intervention prior calibrates the monthly expectation toward the
    // hidden realized value 10.5).
    const expectations: number[] = [];
    for (const month of [1, 3, 6, 12, 24]) {
      const exp = (await snapshotOf(experienced, month)).get('recommendation-calibration') as RecommendationCalibrationPayload;
      const coldAtMonth = (await snapshotOf(cold[month]!, month)).get('recommendation-calibration') as RecommendationCalibrationPayload;

      expect(exp.settledRecommendations).toBe(1);
      expect(coldAtMonth.settledRecommendations).toBe(1);
      // The cold start always expects the optimistic 12 against the
      // realized 10.5 — constant error 1.5, always 'missed'.
      expect(coldAtMonth.predictionErrorMean).toBeCloseTo(1.5, 5);
      expect(coldAtMonth.missed).toBe(1);
      expect(coldAtMonth.metOrExceededRate).toBe(0);

      expectations.push(exp.predictionErrorMean!);
      if (month > 1) {
        expect(exp.predictionErrorMean!).toBeLessThan(1.5);
      }
    }
    // Monotone improvement across the checkpoints.
    for (let index = 1; index < expectations.length; index += 1) {
      expect(expectations[index]!).toBeLessThanOrEqual(expectations[index - 1]!);
    }
    expect(expectations[0]).toBeCloseTo(1.5, 5); // month 1: identical to cold
    expect(expectations[1]).toBeCloseTo(0.45, 5); // month 3
    expect(expectations[2]).toBeCloseTo(0.15, 5); // month 6
    expect(expectations[4]).toBeCloseTo(0.15, 5); // month 24
  });

  it('intervention realized value versus expected value improves', async () => {
    // Measurement 7 — the realized-value family's net variance.
    const netVariances: number[] = [];
    for (const month of [1, 3, 6, 12, 24]) {
      const exp = (await snapshotOf(experienced, month)).get('realized-value') as RealizedValuePayload;
      const coldAtMonth = (await snapshotOf(cold[month]!, month)).get('realized-value') as RealizedValuePayload;

      // Both instances settle two outcomes per month: the mission
      // (exceeded — the walk reaches the 0.98 evidence) and the
      // recommendation.
      expect(exp.settled).toBe(2);
      expect(exp.realizedValueSum).toBeCloseTo(11.48, 5);
      expect(exp.improvementSum).toBeCloseTo(11.28, 5);
      expect(exp.bySubjectKind.mission?.realizedValueSum).toBeCloseTo(0.98, 5);
      expect(exp.bySubjectKind.recommendation?.realizedValueSum).toBeCloseTo(10.5, 5);

      // The cold start nets −1.5 on the recommendation every month
      // (12 expected, 10.5 realized) and the mission nets +0.08.
      expect(coldAtMonth.netVarianceSum).toBeCloseTo(-1.42, 5);
      netVariances.push(exp.netVarianceSum!);
      if (month > 1) {
        expect(exp.netVarianceSum!).toBeGreaterThan(coldAtMonth.netVarianceSum!);
      }
    }
    for (let index = 1; index < netVariances.length; index += 1) {
      expect(netVariances[index]!).toBeGreaterThanOrEqual(netVariances[index - 1]!);
    }
    expect(netVariances[0]).toBeCloseTo(-1.42, 5);
    expect(netVariances[4]).toBeCloseTo(-0.07, 5);
  });

  it('consequential unknown discovery precision/recall stays perfect for everyone', async () => {
    // Measurement 1 — discovery quality is not sacrificed for speed.
    for (const month of [1, 3, 6, 12, 24]) {
      for (const instance of [experienced, cold[month]!, control]) {
        const payload = (await snapshotOf(instance, month)).get('unknown-discovery') as UnknownDiscoveryPayload;
        expect(payload.promotedInWindow).toBe(1);
        expect(payload.truePositives).toBe(1);
        expect(payload.falsePositives).toBe(0);
        expect(payload.precision).toBe(1);
        expect(payload.groundTruthConsequential).toBe(1);
        expect(payload.discoveredConsequential).toBe(1);
        expect(payload.missedConsequential).toBe(0);
        expect(payload.recall).toBe(1);
      }
    }
  });

  it('evidence quality: every answer is recorded evidence with confidence', async () => {
    // Measurement 9 (the doc's stale/contradictory-evidence measurement
    // maps onto the evidence-quality family — the answer series is
    // append-only and confidence-bearing by construction).
    const exp1 = (await snapshotOf(experienced, 1)).get('evidence-quality') as {
      observations: number;
      meanConfidence: number | null;
      shareWithConfidenceBasis: number | null;
    };
    expect(exp1.observations).toBe(8); // the reading + 7 answers
    expect(exp1.meanConfidence).toBeCloseTo(0.70625, 6);
    expect(exp1.shareWithConfidenceBasis).toBe(1);

    const exp6 = (await snapshotOf(experienced, 6)).get('evidence-quality') as {
      observations: number;
      meanConfidence: number | null;
    };
    expect(exp6.observations).toBe(2); // the reading + the CRM answer
    expect(exp6.meanConfidence).toBeCloseTo(0.94, 6);
  });
});

// ---------------------------------------------------------------------------
// Attribution — improvement arises from recorded CompanyModel updates only
// ---------------------------------------------------------------------------

describe('attribution — recorded CompanyModel deltas, evidence and outcomes', () => {
  it('the cold-start and control instances never learn (version 0)', async () => {
    for (const month of BENCHMARK_MONTHS) {
      const model = await getCompanyModel(privileged(tenantCold[month]!), {});
      expect(model.modelVersion).toBe(0);
      expect(model.assertions).toEqual([]);
    }
    const controlModel = await getCompanyModel(privileged(tenantControl), {});
    expect(controlModel.modelVersion).toBe(0);
    expect(controlModel.assertions).toEqual([]);
  });

  it('the control instance (history, no learning) equals the cold start at every checkpoint', async () => {
    for (const month of [3, 6, 12, 24]) {
      expect(control.reports[month - 1]!.steps).toBe(cold[month]!.reports[0]!.steps);
      expect(control.reports[month - 1]!.firstChoice?.label).toBe(
        cold[month]!.reports[0]!.firstChoice?.label,
      );
      expect(control.reports[month - 1]!.intervention!.expected).toBe(
        cold[month]!.reports[0]!.intervention!.expected,
      );
      expect(control.reports[month - 1]!.learningUpdateId).toBeNull();
    }
  });

  it('the experienced instance recorded one update per month, linked to outcomes', async () => {
    const ctx = privileged(tenantExperienced);
    const model = await getCompanyModel(ctx, {});
    expect(model.modelVersion).toBe(TOTAL_MONTHS);

    for (const report of experienced.reports) {
      expect(report.learningUpdateId).not.toBeNull();
      const update = await getLearningUpdate(ctx, report.learningUpdateId!);
      expect(update.modelVersion).toBe(report.month);
      expect(update.linkedOutcomeIds.length).toBeGreaterThan(0);
      expect(update.changes.length).toBeGreaterThanOrEqual(2); // sources + intervention
    }
  });

  it('every applied prior of the final ranking resolves to evidence and outcomes', async () => {
    const ctx = privileged(tenantExperienced);
    const design = deriveCompanyDesign(SEED);
    const crmSourceId = experienced.view.systems.find(
      (system) => system.key === 'billing-crm',
    )!.sourceId;

    const ranking = await rankCandidates(ctx, {
      domain: 'source_selection',
      candidates: experienced.view.employees
        .map((employee): RankCandidateInput => ({
          kind: 'employee',
          id: employee.personId,
          label: employee.fullName,
        }))
        .concat(
          experienced.view.systems.map(
            (system): RankCandidateInput => ({
              kind: 'source',
              id: system.sourceId,
              label: system.label,
            }),
          ),
        ),
    });
    expect(ranking.modelVersion).toBe(TOTAL_MONTHS);

    // The CRM is ranked first, on a recorded prior.
    const crm = ranking.candidates.find((candidate) => candidate.key === `source:${crmSourceId}`)!;
    expect(crm.rank).toBe(1);
    expect(crm.appliedPrior).not.toBeNull();
    expect(crm.appliedPrior!.learnedScore).toBe(0.98);

    // Attribution: the applied prior is a recorded assertion version whose
    // provenance cites evidence AND the settled outcome it was learned
    // from, through the recorded update (the benchmark's attribution
    // requirement, verbatim).
    const assertion = await getCompanyModelAssertion(ctx, crm.appliedPrior!.assertionId);
    expect(assertion.status).toBe('active');
    expect(assertion.version).toBe(crm.appliedPrior!.version);
    expect(assertion.provenance.outcomeId).not.toBeNull();
    expect(assertion.provenance.evidence.length).toBeGreaterThan(0);
    const update = await getLearningUpdate(ctx, assertion.updateId);
    expect(update.linkedOutcomeIds).toContain(assertion.provenance.outcomeId);

    // The learned intervention prior is recorded too — the
    // recommendation-quality leg's channel.
    const interventionRanking = await rankCandidates(ctx, {
      domain: 'intervention',
      candidates: [{ kind: 'intervention', name: design.intervention.name, baseScore: 1 }],
    });
    const interventionCandidate = interventionRanking.candidates[0]!;
    expect(interventionCandidate.appliedPrior).not.toBeNull();
    expect(interventionCandidate.appliedPrior!.learnedScore).toBeCloseTo(10.5 / 12, 4);
  });

  it('the W054 intervention priors were realized and retained as evidence-linked records', async () => {
    // realizeIntervention appended one prior version per month — the
    // outcomes module's own evidence-linked record of the same learning
    // (ADR-0019's only-channel rule), with the failures retained.
    const ctx = privileged(tenantExperienced);
    const priors = await getInterventionPriors(ctx, {
      capabilityKey: 'invoice-matching-automation',
    });
    expect(priors).toHaveLength(1);
    const prior = priors[0]!;
    expect(prior.sampleSize).toBe(TOTAL_MONTHS);
    expect(prior.successes + prior.failures).toBe(TOTAL_MONTHS);
    expect(prior.evidenceInterventionIds).toHaveLength(TOTAL_MONTHS);
  });
});

// ---------------------------------------------------------------------------
// Policy compliance and tenant isolation (measurement 10)
// ---------------------------------------------------------------------------

describe('policy compliance and tenant isolation', () => {
  it('the frozen materiality policy governed every run of every instance', async () => {
    expect(Object.isFrozen(MATERIALITY_POLICY)).toBe(true);
    for (const instance of [experienced, control, ...BENCHMARK_MONTHS.map((m) => cold[m]!)]) {
      const ctx = privileged(instance.view.tenantId);
      const runs = await listDiscoveryRuns(ctx, { limit: 500 });
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.policy.impactThreshold).toBe(MATERIALITY_POLICY.impactThreshold);
        expect(run.policy.valueThreshold).toBe(MATERIALITY_POLICY.valueThreshold);
      }
      // Every persisted planner signal shows the explicit access policy
      // held (allowed) — learned preference never overrode it.
      const plans = await listAcquisitionPlans(ctx, { limit: 500 });
      for (const plan of plans) {
        for (const ranked of plan.ranked) {
          expect(ranked.signals.access).toBe('allowed');
        }
      }
    }
  });

  it('every instance advanced only its own company (isolation at the driver)', async () => {
    for (const instance of [experienced, control, ...BENCHMARK_MONTHS.map((m) => cold[m]!)]) {
      const reports = await listMonthReports(privileged(instance.view.tenantId), {
        companyId: instance.view.id,
      });
      expect(reports.every((report) => report.tenantId === instance.view.tenantId)).toBe(true);
      expect(reports.every((report) => report.companyId === instance.view.id)).toBe(true);
    }
    // The cold-start checkpoints only ever lived their one month (at
    // their checkpoint position in the company's life); the experienced
    // and control instances lived all 24 (fresh reads).
    for (const month of BENCHMARK_MONTHS) {
      const view = await getCompany(privileged(tenantCold[month]!), {
        companyId: cold[month]!.view.id,
      });
      expect(view.currentMonth).toBe(month);
      expect(cold[month]!.reports).toHaveLength(1);
      expect(cold[month]!.reports[0]!.month).toBe(month);
    }
    const experiencedView = await getCompany(privileged(tenantExperienced), {
      companyId: experienced.view.id,
    });
    expect(experiencedView.currentMonth).toBe(TOTAL_MONTHS);
  });

  it("one tenant's hidden markers never appear in another tenant's records", async () => {
    // The markers are seed-derived, so this sweep is over the exact
    // strings any tenant of this company could ever leak. Answer texts
    // are seed-derived too — the same synthetic world legitimately
    // answers the same question in every tenant — so the cross-tenant
    // assertion for them is that each tenant's answer-bearing
    // observations trace to THAT tenant's own answered plans, never to
    // a foreign tenant's records.
    const ctxExperienced = privileged(tenantExperienced);
    const markers: string[] = [];
    const answers: string[] = [];
    for (let month = 1; month <= TOTAL_MONTHS; month += 1) {
      const reveal = await revealGroundTruth(ctxExperienced, {
        companyId: experienced.view.id,
        month,
      });
      markers.push(reveal.marker);
      answers.push(reveal.answerText);
    }
    expect(new Set(markers).size).toBe(TOTAL_MONTHS);

    for (const instance of [control, ...BENCHMARK_MONTHS.map((m) => cold[m]!)]) {
      const ctx = privileged(instance.view.tenantId);
      const observations = await listObservations(ctx, { limit: 500 });
      const plans = await listAcquisitionPlans(ctx, { limit: 500 });
      const ownAnsweredEvidence = new Set(
        plans
          .filter((plan) => plan.outcome?.outcome === 'answered')
          .map((plan) => plan.outcome!.evidenceObservationId)
          .filter((id): id is string => id !== null),
      );
      for (const observation of observations) {
        const serialized = JSON.stringify(observation.payload);
        for (const marker of markers) {
          expect(serialized.includes(marker)).toBe(false);
        }
        if (answers.some((answer) => serialized.includes(answer))) {
          // The same world answered the same question — through THIS
          // tenant's own acquisition plans.
          expect(ownAnsweredEvidence.has(observation.id)).toBe(true);
        }
      }
      const claims = await listClaims(ctx, { limit: 500 });
      for (const claim of claims) {
        for (const marker of markers) {
          expect(claim.proposition.includes(marker)).toBe(false);
        }
        for (const answer of answers) {
          expect(claim.proposition.includes(answer)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// No ground-truth leakage (the failure conditions, asserted to NOT hold)
// ---------------------------------------------------------------------------

describe('no hidden-ground-truth leakage', () => {
  it('the 24 markers never appear on any cognition surface of the experienced tenant', async () => {
    const ctx = privileged(tenantExperienced);
    const markers: string[] = [];
    const answers: string[] = [];
    for (let month = 1; month <= TOTAL_MONTHS; month += 1) {
      const reveal = await revealGroundTruth(ctx, {
        companyId: experienced.view.id,
        month,
      });
      markers.push(reveal.marker);
      answers.push(reveal.answerText);
    }

    const surfaces: Array<{ serialized: string; surface: string }> = [];
    const observations = await listObservations(ctx, { limit: 500 });
    for (const observation of observations) {
      surfaces.push({ serialized: JSON.stringify(observation.payload), surface: 'observation' });
    }
    const claims = await listClaims(ctx, { limit: 500 });
    for (const claim of claims) {
      surfaces.push({ serialized: JSON.stringify(claim.proposition), surface: 'claim' });
    }
    const messages = await listMessages(ctx, { limit: 500 });
    for (const message of messages) {
      surfaces.push({ serialized: JSON.stringify(message.payload), surface: 'message' });
    }
    const model = await getCompanyModel(ctx, {});
    for (const assertion of model.assertions) {
      surfaces.push({
        serialized: JSON.stringify(assertion.statement) + JSON.stringify(assertion.subject),
        surface: 'company-model',
      });
    }
    expect(surfaces.length).toBeGreaterThan(0);

    for (const surface of surfaces) {
      for (const marker of markers) {
        expect(surface.serialized.includes(marker)).toBe(false);
      }
    }

    // The hidden answers exist ONLY as the evidence observations of
    // answered acquisition plans — the sanctioned acquisition channel.
    const plans = await listAcquisitionPlans(ctx, { limit: 500 });
    const answeredEvidenceIds = new Set(
      plans
        .filter((plan) => plan.outcome?.outcome === 'answered')
        .map((plan) => plan.outcome!.evidenceObservationId)
        .filter((id): id is string => id !== null),
    );
    expect(answeredEvidenceIds.size).toBe(7 + (TOTAL_MONTHS - 1)); // month 1: 7, months 2-24: 1 each
    for (const observation of observations) {
      const serialized = JSON.stringify(observation.payload);
      const containsAnswer = answers.some((answer) => serialized.includes(answer));
      if (containsAnswer) {
        expect(answeredEvidenceIds.has(observation.id)).toBe(true);
      }
    }
  });
});
