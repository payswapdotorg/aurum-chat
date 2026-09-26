// DEV ONLY (offline calibration, /tmp): replicate the S003 scoring over the
// dumped measured inputs with PARAMETRIZED population constants, and fit
// (intercept, thresholds, industry constants) to the S002 baseline anchors
// by coordinate descent, with hard caps keeping the MATURE scenario inside
// the honest partial-maturity band.
//   bunx tsx tests/longitudinal/s003/dev-calibrate.ts /tmp/s003-results.json
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// The S002 anchors (the calibration targets)
// ---------------------------------------------------------------------------

const S002_BASELINE_BY_INDUSTRY: Record<string, number> = {
  sales: 0.89,
  technology: 0.56,
  entertainment: 0.51,
  fashion: 0.43,
  hospitality: 0.19,
  construction: 0.07,
  transportation: 0.06,
  finance: 0.0,
  legal: 0.0,
  healthcare: 0.0,
  defense: 0.0,
};
const S002_BASELINE_BY_SIZE: Record<string, number> = { small: 0.48, medium: 0.37, large: 0.2 };
const S002_BASELINE_OVERALL = 0.247;

interface Dumped {
  firms: Array<{
    key: string;
    industryKey: string;
    sizeKey: string;
    seed: number;
    baseline: FirmSide;
    mature: FirmSide;
  }>;
}
interface FirmSide {
  seed: number;
  loop: {
    totalSteps: number;
    meanSteps: number;
    firstChoiceCorrectRate: number;
    meanPredictionError: number;
    evidenceMeanConfidence: number;
    evidenceShareWithConfidenceBasis: number;
    totalRealizedValueSum: number;
    meanNetVariance: number;
    totalWindowCostMinor: number;
    interventionsExecuted: number;
    participationByRole: Record<string, number>;
    channelsOfLoop: number;
  };
  composed: {
    effort: { contractCalls: number; approvals: number; elapsedSimulatedMinutes: number };
    coverage: {
      systemsDiscovered: number;
      systemsConnected: number;
      systemsVerified: number;
      systemsWithWritePath: number;
      channelsWithEvidence: number;
    };
    migration: { roundsCommitted: number; identifierMappings: number; divergencesSurfaced: number };
    kit: { installed: boolean; active: boolean; capabilitiesInvoked: number };
  };
  professionals: Array<{
    role: string;
    roleFit: number;
    roleSwitchEase: number;
    affinityDraw: number;
  }>;
}

// ---------------------------------------------------------------------------
// The parametrized model (replicates s003-scoring.ts; dev-only duplication)
// ---------------------------------------------------------------------------

const ROLE_FRICTION_BASE: Record<string, number> = {
  controller: 0.3,
  operations: 0.42,
  support: 0.5,
  fulfillment: 0.72,
  analyst: 0.22,
};
const SIGMA = 0.25;
const COLD_STEPS = 7;
const COLD_ERROR = 1.5;
const MONTHS = 4;
const COST = {
  manualSetupMinutesPerSystem: 240,
  reEntryMinutesPerTask: 30,
  switchesPerManualExecution: 3,
  switchesPerManualInvestigationStep: 1,
  approvalMinutes: 10,
  manualInvestigationMinutesPerStep: 20,
};
const EXPECTED_GOVERNANCE_EVENTS = 12;

/** Semantic bands: each industry's constants must stay plausible. */
const BANDS: Record<string, Record<'sor' | 'spec' | 'compl', [number, number]>> = {
  sales: { sor: [0.05, 0.25], spec: [0.05, 0.25], compl: [0.04, 0.2] },
  technology: { sor: [0.15, 0.35], spec: [0.1, 0.3], compl: [0.1, 0.3] },
  entertainment: { sor: [0.15, 0.35], spec: [0.1, 0.3], compl: [0.1, 0.3] },
  fashion: { sor: [0.15, 0.35], spec: [0.15, 0.35], compl: [0.1, 0.3] },
  hospitality: { sor: [0.25, 0.45], spec: [0.2, 0.4], compl: [0.15, 0.35] },
  construction: { sor: [0.35, 0.55], spec: [0.25, 0.45], compl: [0.2, 0.4] },
  transportation: { sor: [0.35, 0.55], spec: [0.25, 0.45], compl: [0.2, 0.4] },
  finance: { sor: [0.4, 0.55], spec: [0.35, 0.5], compl: [0.36, 0.5] },
  legal: { sor: [0.4, 0.55], spec: [0.35, 0.5], compl: [0.36, 0.5] },
  healthcare: { sor: [0.4, 0.55], spec: [0.35, 0.5], compl: [0.4, 0.55] },
  defense: { sor: [0.4, 0.55], spec: [0.35, 0.5], compl: [0.4, 0.55] },
};
const SIZE_BANDS: Record<string, [number, number]> = {
  small: [0.2, 0.35],
  medium: [0.3, 0.5],
  large: [0.5, 0.75],
};

interface Params {
  weights: Record<string, number>;
  b0: number;
  tOnly: number;
  tPrimary: number;
  credits: { sor: number; kit: number; gov: number; mig: number };
  industries: Record<string, { sor: number; spec: number; compl: number }>;
  sizeFriction: Record<string, number>;
}

const FACTOR_KEYS = [
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
] as const;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function logistic(u: number): number {
  return 1 / (1 + Math.exp(-u));
}

function scoreFirm(
  firm: Dumped['firms'][number],
  side: FirmSide,
  scenario: 'baseline' | 'mature',
  p: Params,
): { scores: number[]; only: number; primary: number } {
  const ind = p.industries[firm.industryKey]!;
  const friction = p.sizeFriction[firm.sizeKey]!;
  const conversion = clamp01(1 - ind.compl);
  const coverageRaw =
    side.composed.coverage.systemsDiscovered > 0
      ? side.composed.coverage.systemsWithWritePath / side.composed.coverage.systemsDiscovered
      : 0;
  const coverageEff = coverageRaw * conversion;
  const manualExec = side.loop.interventionsExecuted * (1 - coverageEff);
  const isMature = scenario === 'mature';

  const f1 =
    0.35 * clamp01(1 - side.loop.meanSteps / COLD_STEPS) +
    0.3 * side.loop.firstChoiceCorrectRate +
    0.2 * clamp01(1 - side.loop.meanPredictionError / COLD_ERROR) +
    0.15 * side.loop.evidenceMeanConfidence;
  const f2 = 0.6 + 0.4 * coverageEff;
  const composedChannels = Math.max(0, side.composed.coverage.channelsWithEvidence - 1);
  const f3 = 0.5 + 0.5 * (composedChannels > 0 ? conversion : 0);
  const noAurum =
    3 * COST.manualSetupMinutesPerSystem +
    side.loop.interventionsExecuted * COST.reEntryMinutesPerTask +
    MONTHS * COLD_STEPS * COST.manualInvestigationMinutesPerStep;
  const baselineBurden =
    3 * COST.manualSetupMinutesPerSystem + side.loop.interventionsExecuted * COST.reEntryMinutesPerTask;
  const matureBurden =
    side.composed.effort.approvals * COST.approvalMinutes +
    side.composed.effort.elapsedSimulatedMinutes +
    manualExec * COST.reEntryMinutesPerTask;
  const burden = isMature ? matureBurden : baselineBurden;
  const baselineRelief = clamp01(1 - baselineBurden / noAurum);
  const fullRelief = clamp01(1 - burden / noAurum);
  const f8 = clamp01(baselineRelief + (fullRelief - baselineRelief) * conversion);
  const switchesNoAurum =
    COLD_STEPS * MONTHS + side.loop.interventionsExecuted * COST.switchesPerManualExecution;
  const amortized = side.composed.effort.approvals / MONTHS;
  const switchesScenario = manualExec * COST.switchesPerManualExecution + amortized;
  const f5 = clamp01(1 - switchesScenario / Math.max(1, switchesNoAurum));
  const kitLever = side.composed.kit.active && side.composed.kit.capabilitiesInvoked > 0 ? 1 : 0;
  const f6 = 1 - ind.sor * (1 - p.credits.sor * coverageEff);
  const kitConversion = 1 - ind.compl * 0.5;
  const f7 = 1 - ind.spec * (1 - p.credits.kit * kitLever * kitConversion);
  const govLever = clamp01(
    (side.composed.coverage.systemsVerified +
      side.composed.effort.approvals +
      1 +
      side.composed.coverage.systemsVerified) /
      EXPECTED_GOVERNANCE_EVENTS,
  );
  const f9 = 1 - ind.compl * (1 - p.credits.gov * govLever);
  const migLever = clamp01(
    (Math.min(1, side.composed.migration.roundsCommitted) +
      (side.composed.migration.identifierMappings > 0 ? 1 : 0) +
      (side.composed.migration.roundsCommitted > 0 ? 1 : 0)) /
      3,
  );
  const f10 = 1 - friction * (1 - p.credits.mig * migLever * conversion);

  const scores: number[] = [];
  for (const prof of side.professionals) {
    const f11 = clamp01(
      (1 - ROLE_FRICTION_BASE[prof.role]! * (0.75 + 0.5 * ind.spec)) * (1 + SIGMA * prof.affinityDraw),
    );
    const factors: Record<string, number> = {
      organizationalIntelligenceValue: f1,
      oneWorkSurface: f2,
      channelAccessibility: f3,
      roleFit: prof.roleFit,
      contextSwitchingReduction: f5,
      incumbentIndependence: f6,
      specialistIndependence: f7,
      reEntryRelief: f8,
      governanceHeadroom: f9,
      migrationEase: f10,
      roleSwitchEase: f11,
    };
    let u = p.b0;
    for (const key of FACTOR_KEYS) u += p.weights[key]! * factors[key]!;
    scores.push(logistic(u));
  }
  const only = scores.filter((s) => s >= p.tOnly).length / Math.max(1, scores.length);
  const primary = scores.filter((s) => s >= p.tPrimary).length / Math.max(1, scores.length);
  return { scores, only, primary };
}

function evaluate(p: Params, dump: Dumped): {
  loss: number;
  baselineByIndustry: Record<string, number>;
  baselineBySize: Record<string, number>;
  baselineOverall: number;
  matureOverall: number;
  matureByIndustry: Record<string, number>;
} {
  // Professional-weighted aggregation (exactly the real aggregateS003Scenario
  // semantics: counts of professionals, not means of firm shares).
  const byIndustry: Record<string, [number, number]> = {};
  const byIndustryMature: Record<string, [number, number]> = {};
  const bySize: Record<string, [number, number]> = {};
  let overallWilling = 0;
  let overallTotal = 0;
  let matureWilling = 0;
  for (const firm of dump.firms) {
    const base = scoreFirm(firm, firm.baseline, 'baseline', p);
    const mat = scoreFirm(firm, firm.mature, 'mature', p);
    const count = base.scores.length;
    const industry = (byIndustry[firm.industryKey] ??= [0, 0]);
    industry[0] += Math.round(base.only * count);
    industry[1] += count;
    const industryMature = (byIndustryMature[firm.industryKey] ??= [0, 0]);
    industryMature[0] += Math.round(mat.only * count);
    industryMature[1] += count;
    const size = (bySize[firm.sizeKey] ??= [0, 0]);
    size[0] += Math.round(base.only * count);
    size[1] += count;
    overallWilling += Math.round(base.only * count);
    overallTotal += count;
    matureWilling += Math.round(mat.only * count);
  }
  const ratio = (entry: [number, number]): number => entry[0] / Math.max(1, entry[1]);
  const baselineByIndustry = Object.fromEntries(Object.entries(byIndustry).map(([k, v]) => [k, ratio(v)]));
  const baselineBySize = Object.fromEntries(Object.entries(bySize).map(([k, v]) => [k, ratio(v)]));
  const baselineOverall = overallWilling / Math.max(1, overallTotal);
  const matureOverall = matureWilling / Math.max(1, overallTotal);

  let loss = 6 * (baselineOverall - S002_BASELINE_OVERALL) ** 2;
  for (const [industry, target] of Object.entries(S002_BASELINE_BY_INDUSTRY)) {
    loss += (baselineByIndustry[industry]! - target) ** 2;
  }
  for (const [size, target] of Object.entries(S002_BASELINE_BY_SIZE)) {
    loss += 1.5 * (baselineBySize[size]! - target) ** 2;
  }
  // semantic-band penalties (implausible population constants are refused)
  for (const [industry, band] of Object.entries(BANDS)) {
    const cur = p.industries[industry]!;
    for (const key of ['sor', 'spec', 'compl'] as const) {
      const value = cur[key];
      if (value < band[key][0] - 1e-9 || value > band[key][1] + 1e-9) {
        loss += 1 + 10 * (Math.max(0, band[key][0] - value) + Math.max(0, value - band[key][1])) ** 2;
      }
    }
  }
  for (const [size, band] of Object.entries(SIZE_BANDS)) {
    const value = p.sizeFriction[size]!;
    if (value < band[0] - 1e-9 || value > band[1] + 1e-9) {
      loss += 1 + 10 * (Math.max(0, band[0] - value) + Math.max(0, value - band[1])) ** 2;
    }
  }
  // ordering penalties (the S002 shape must be preserved)
  const order = ['sales', 'technology', 'entertainment', 'fashion', 'hospitality', 'construction', 'transportation', 'finance'];
  for (let i = 1; i < order.length; i += 1) {
    const prev = baselineByIndustry[order[i - 1]!]!;
    const cur = baselineByIndustry[order[i]!]!;
    if (cur > prev + 0.005) loss += 0.3 * (cur - prev) ** 2 + 0.01;
  }
  // the mature caps (honest partial maturity)
  if (matureOverall > 0.46) loss += 20 * (matureOverall - 0.46) ** 2;
  for (const industry of ['finance', 'legal', 'healthcare', 'defense']) {
    const m = ratio(byIndustryMature[industry]!);
    if (m > 0.15) loss += 5 * (m - 0.15) ** 2;
  }
  return { loss, baselineByIndustry, baselineBySize, baselineOverall, matureOverall, matureByIndustry: Object.fromEntries(Object.entries(byIndustryMature).map(([k, v]) => [k, ratio(v)])) };
}

// ---------------------------------------------------------------------------
// Main: coordinate descent over (b0, T_only, T_primary, industry constants)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const file = process.argv[2] ?? '/tmp/s003-results.json';
  const dump = JSON.parse(fs.readFileSync(file, 'utf8')) as Dumped;

  const p: Params = {
    weights: {
      organizationalIntelligenceValue: 1.5,
      oneWorkSurface: 0.15,
      channelAccessibility: 0.06,
      roleFit: 0.15,
      contextSwitchingReduction: 0.08,
      incumbentIndependence: 0.9,
      specialistIndependence: 0.87,
      reEntryRelief: 0.15,
      governanceHeadroom: 0.87,
      migrationEase: 0.44,
      roleSwitchEase: 0.5,
    },
    b0: -3.38,
    tOnly: 0.66,
    tPrimary: 0.555,
    credits: { sor: 0.12, kit: 0.15, gov: 0.12, mig: 0.15 },
    industries: {
      sales: { sor: 0.2, spec: 0.11, compl: 0.06 },
      technology: { sor: 0.25, spec: 0.15, compl: 0.18 },
      entertainment: { sor: 0.205, spec: 0.235, compl: 0.185 },
      fashion: { sor: 0.21, spec: 0.24, compl: 0.19 },
      hospitality: { sor: 0.3, spec: 0.23, compl: 0.18 },
      construction: { sor: 0.42, spec: 0.29, compl: 0.25 },
      transportation: { sor: 0.42, spec: 0.29, compl: 0.24 },
      finance: { sor: 0.44, spec: 0.4, compl: 0.36 },
      legal: { sor: 0.44, spec: 0.42, compl: 0.38 },
      healthcare: { sor: 0.46, spec: 0.44, compl: 0.42 },
      defense: { sor: 0.46, spec: 0.44, compl: 0.42 },
    },
    sizeFriction: { small: 0.21, medium: 0.34, large: 0.66 },
  };

  let best = evaluate(p, dump);
  console.log('initial loss', best.loss.toFixed(6), 'baseline', best.baselineOverall.toFixed(3), 'mature', best.matureOverall.toFixed(3));
  for (const key of ['sales-small', 'sales-medium', 'sales-large', 'technology-small', 'finance-small']) {
    const firm = dump.firms.find((f) => f.key === key)!;
    const base = scoreFirm(firm, firm.baseline, 'baseline', p);
    console.log('replica', key, 'willing@0.66:', base.scores.filter((x) => x >= p.tOnly).length, '/', base.scores.length,
      'scores:', base.scores.map((x) => x.toFixed(3)).join(' '));
  }

  // Clean coordinate descent (snapshot-based).
  const steps = [0.08, 0.04, 0.02, 0.01, 0.005];
  let converged = false;
  for (const step of steps) {
    while (!converged) {
      converged = true;
      const moves: Array<{ apply: () => void; undo: () => void }> = [];
      moves.push(
        { apply: () => (p.b0 += step), undo: () => (p.b0 -= step) },
        { apply: () => (p.b0 -= step), undo: () => (p.b0 += step) },
        { apply: () => (p.tOnly += step / 2), undo: () => (p.tOnly -= step / 2) },
        { apply: () => (p.tOnly -= step / 2), undo: () => (p.tOnly += step / 2) },
      );
      for (const industry of Object.keys(p.industries)) {
        for (const key of ['sor', 'spec', 'compl'] as const) {
          moves.push({
            apply: () => (p.industries[industry]![key] += step),
            undo: () => (p.industries[industry]![key] -= step),
          });
          moves.push({
            apply: () => (p.industries[industry]![key] -= step),
            undo: () => (p.industries[industry]![key] += step),
          });
        }
      }
      for (const size of Object.keys(p.sizeFriction)) {
        moves.push(
          { apply: () => (p.sizeFriction[size]! += step), undo: () => (p.sizeFriction[size]! -= step) },
          { apply: () => (p.sizeFriction[size]! -= step), undo: () => (p.sizeFriction[size]! += step) },
        );
      }
      for (const move of moves) {
        move.apply();
        const trial = evaluate(p, dump);
        if (trial.loss < best.loss - 1e-9) {
          best = trial;
          converged = false;
        } else {
          move.undo();
        }
      }
    }
    converged = false;
  }

  console.log('final loss', best.loss.toFixed(6));
  console.log('b0', p.b0.toFixed(3), 'tOnly', p.tOnly.toFixed(4), 'tPrimary', p.tPrimary.toFixed(4));
  console.log('sizeFriction', JSON.stringify(p.sizeFriction));
  console.log('industries', JSON.stringify(p.industries, null, 1));
  console.log('--- baseline by industry (target vs fit) ---');
  for (const [industry, target] of Object.entries(S002_BASELINE_BY_INDUSTRY)) {
    console.log(
      industry.padEnd(16),
      'target', target.toFixed(2),
      'fit', best.baselineByIndustry[industry]!.toFixed(3),
      'mature', best.matureByIndustry[industry]!.toFixed(3),
    );
  }
  console.log('--- baseline by size ---');
  for (const [size, target] of Object.entries(S002_BASELINE_BY_SIZE)) {
    console.log(size.padEnd(16), 'target', target.toFixed(2), 'fit', best.baselineBySize[size]!.toFixed(3));
  }
  console.log('overall: baseline', best.baselineOverall.toFixed(4), 'mature', best.matureOverall.toFixed(4));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
