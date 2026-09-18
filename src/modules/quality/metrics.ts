// Pure metric computations of the quality module (W055) — no database, no
// clock, no contracts. The service fetches plain FACT rows through module
// contracts, these functions compute the nine metric families
// deterministically from them, and the result is frozen onto an append-only
// snapshot row. Everything here is total, pure and unit-testable in
// isolation (the discovery.ts / ranking.ts / signals.ts precedent).
//
// Determinism rules (the ADR-0018 discipline applied to measurement):
//  * "latest wins" resolution of ground-truth judgments orders by
//    (recordedAtMs, id) — id is a uuid, compared lexicographically as the
//    tiebreaker, so identical inputs always produce identical outputs;
//  * rates and means are rounded to 6 decimals; sums are exact double
//    arithmetic;
//  * empty denominators produce null — absence of evidence is recorded as
//    absence, never as a misleading 0 or 1;
//  * money is never summed across currencies (IMPLEMENTATION-STACK §8).
//
// METRIC_SCHEMA_VERSION versions these definitions: it is stamped onto
// every snapshot, so a future definition change bumps the version and old
// snapshots stay interpretable against the definitions that produced them
// (metrics are versioned and auditable — the work item's own words).

import type {
  CostByCurrency,
  EvidenceQualityPayload,
  InterventionSuccessBucket,
  InterventionSuccessPayload,
  InvestigationCostPayload,
  MissionResolutionEfficiencyPayload,
  QualityMetricKind,
  QualityMetricPayload,
  RealizedValueBucket,
  RealizedValuePayload,
  RecommendationCalibrationPayload,
  SourceSelectionPayload,
  TimeToUsefulUnderstandingPayload,
  UnknownDiscoveryPayload,
} from './types';

/** Version of the metric definitions in this file. Bump on any change. */
export const METRIC_SCHEMA_VERSION = 1;

/** Rates and means are rounded to 6 decimals (deterministic output). */
export const ROUNDING_DECIMALS = 6;

const MS_PER_HOUR = 3_600_000;

export function round6(value: number): number {
  const factor = 10 ** ROUNDING_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** n/d rounded, or null when d = 0 (no evidence, not zero). */
function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round6(numerator / denominator) : null;
}

/** Median of a non-empty sorted-agnostic numeric list; null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return round6(value);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round6(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Fact shapes (plain data the service derives from contract reads)
// ---------------------------------------------------------------------------

/** One promoted discovery candidate (attention W051). */
export interface CandidateFact {
  candidateId: string;
  gapKey: string;
  recordedAtMs: number;
}

/** One ground-truth judgment row (quality-owned). */
export interface JudgmentFact {
  id: string;
  kind: 'unknown-consequentiality' | 'source-selection';
  gapKey: string | null;
  candidateId: string | null;
  planId: string | null;
  windowFromMs: number | null;
  windowToMs: number | null;
  verdict: string;
  recordedAtMs: number;
}

/** One selected acquisition plan with its terminal outcome (W012). */
export interface PlanFact {
  planId: string;
  missionId: string;
  action: string;
  recordedAtMs: number;
  estimatedCost: number | null;
  budgetCurrency: string;
  outcomeKind: 'answered' | 'unavailable' | 'failed' | null;
  outcomeRecordedAtMs: number | null;
}

/** One completed mission (W011). */
export interface ResolvedMissionFact {
  missionId: string;
  createdAtMs: number;
  completedAtMs: number;
  budgetCurrency: string;
}

/** One settled outcome with its frozen realization (W040). */
export interface SettledOutcomeFact {
  outcomeId: string;
  subjectKind: 'recommendation' | 'agent' | 'extension' | 'mission';
  direction: 'at_least' | 'at_most';
  baseline: number;
  expected: number;
  realized: number;
  assessment: 'met' | 'exceeded' | 'missed';
}

/** One recorded observation (W004) — the evidence-quality inputs. */
export interface ObservationFact {
  confidenceValue: number;
  confidenceBasis: string | null;
  lineageParentCount: number;
}

/** The inclusive evaluation window, in epoch milliseconds. */
export interface MetricWindow {
  fromMs: number;
  toMs: number;
}

// ---------------------------------------------------------------------------
// Unknown-discovery precision/recall
// ---------------------------------------------------------------------------

/**
 * A judgment "applies to" the window when its own consequentiality window
 * (defaulting to unbounded) overlaps the evaluation window. A judgment
 * without window fields is an unqualified statement of fact: it applies to
 * every window.
 */
function appliesToWindow(judgment: JudgmentFact, window: MetricWindow): boolean {
  const from = judgment.windowFromMs ?? Number.NEGATIVE_INFINITY;
  const to = judgment.windowToMs ?? judgment.windowFromMs ?? Number.POSITIVE_INFINITY;
  return from <= window.toMs && to >= window.fromMs;
}

/** Later of two judgments by (recordedAtMs, id) — the deterministic order. */
function isLater(a: JudgmentFact, b: JudgmentFact): boolean {
  if (a.recordedAtMs !== b.recordedAtMs) return a.recordedAtMs > b.recordedAtMs;
  return a.id > b.id;
}

/**
 * Ground truth per gapKey for the window: among the
 * 'unknown-consequentiality' judgments referencing the gap (gap-scoped or
 * candidate-scoped) that apply to the window, the latest decides whether
 * the gap was a consequential unknown.
 */
export function groundTruthGaps(
  judgments: JudgmentFact[],
  window: MetricWindow,
): Map<string, 'consequential' | 'not_consequential'> {
  const latest = new Map<string, JudgmentFact>();
  for (const judgment of judgments) {
    if (judgment.kind !== 'unknown-consequentiality') continue;
    if (judgment.gapKey === null) continue;
    if (!appliesToWindow(judgment, window)) continue;
    const current = latest.get(judgment.gapKey);
    if (current === undefined || isLater(judgment, current)) {
      latest.set(judgment.gapKey, judgment);
    }
  }
  const verdicts = new Map<string, 'consequential' | 'not_consequential'>();
  for (const [gapKey, judgment] of latest) {
    if (judgment.verdict === 'consequential' || judgment.verdict === 'not_consequential') {
      verdicts.set(gapKey, judgment.verdict);
    }
  }
  return verdicts;
}

/**
 * Latest candidate-scoped verdict per candidateId (window fields are
 * ignored for precision: a candidate-scoped judgment speaks about that
 * specific discovery).
 */
export function candidateVerdicts(judgments: JudgmentFact[]): Map<string, 'consequential' | 'not_consequential'> {
  const latest = new Map<string, JudgmentFact>();
  for (const judgment of judgments) {
    if (judgment.kind !== 'unknown-consequentiality') continue;
    if (judgment.candidateId === null) continue;
    const current = latest.get(judgment.candidateId);
    if (current === undefined || isLater(judgment, current)) {
      latest.set(judgment.candidateId, judgment);
    }
  }
  const verdicts = new Map<string, 'consequential' | 'not_consequential'>();
  for (const [candidateId, judgment] of latest) {
    if (judgment.verdict === 'consequential' || judgment.verdict === 'not_consequential') {
      verdicts.set(candidateId, judgment.verdict);
    }
  }
  return verdicts;
}

/**
 * Unknown-discovery precision/recall (benchmark measurement 1).
 *
 * Precision (per discovery): promoted candidates recorded in the window,
 * resolved by the latest candidate-scoped judgment for the candidate or,
 * falling back, the window-scoped ground-truth verdict for its gapKey.
 * Recall (per gap): the share of ground-truth consequential gapKeys with
 * at least one promoted candidate in the window.
 */
export function computeUnknownDiscovery(
  candidates: CandidateFact[],
  judgments: JudgmentFact[],
  window: MetricWindow,
): UnknownDiscoveryPayload {
  const gapTruth = groundTruthGaps(judgments, window);
  const byCandidate = candidateVerdicts(judgments);

  const promotedInWindow = candidates.filter(
    (candidate) => candidate.recordedAtMs >= window.fromMs && candidate.recordedAtMs <= window.toMs,
  );

  let truePositives = 0;
  let falsePositives = 0;
  let unjudged = 0;
  const discoveredGaps = new Set<string>();
  for (const candidate of promotedInWindow) {
    discoveredGaps.add(candidate.gapKey);
    const verdict = byCandidate.get(candidate.candidateId) ?? gapTruth.get(candidate.gapKey);
    if (verdict === undefined) {
      unjudged += 1;
    } else if (verdict === 'consequential') {
      truePositives += 1;
    } else {
      falsePositives += 1;
    }
  }

  const groundTruthConsequential = [...gapTruth.entries()]
    .filter(([, verdict]) => verdict === 'consequential')
    .map(([gapKey]) => gapKey);
  const discoveredConsequential = groundTruthConsequential.filter((gapKey) =>
    discoveredGaps.has(gapKey),
  ).length;

  const judgedPromoted = truePositives + falsePositives;
  return {
    promotedInWindow: promotedInWindow.length,
    judgedPromoted,
    unjudgedPromoted: unjudged,
    truePositives,
    falsePositives,
    groundTruthConsequential: groundTruthConsequential.length,
    discoveredConsequential,
    missedConsequential: groundTruthConsequential.length - discoveredConsequential,
    precision: rate(truePositives, judgedPromoted),
    recall: rate(discoveredConsequential, groundTruthConsequential.length),
  };
}

// ---------------------------------------------------------------------------
// Source-selection quality
// ---------------------------------------------------------------------------

/**
 * The first-choice plan per mission: the earliest selected plan by
 * (recordedAtMs, planId) — lock 17's "next best action" makes the first
 * selection the routing decision under test.
 */
export function firstChoicePlans(plans: PlanFact[]): PlanFact[] {
  const first = new Map<string, PlanFact>();
  for (const plan of plans) {
    const current = first.get(plan.missionId);
    if (
      current === undefined ||
      plan.recordedAtMs < current.recordedAtMs ||
      (plan.recordedAtMs === current.recordedAtMs && plan.planId < current.planId)
    ) {
      first.set(plan.missionId, plan);
    }
  }
  return [...first.values()];
}

/** Latest 'source-selection' verdict per planId. */
export function planVerdicts(judgments: JudgmentFact[]): Map<string, 'correct' | 'incorrect'> {
  const latest = new Map<string, JudgmentFact>();
  for (const judgment of judgments) {
    if (judgment.kind !== 'source-selection') continue;
    if (judgment.planId === null) continue;
    const current = latest.get(judgment.planId);
    if (current === undefined || isLater(judgment, current)) {
      latest.set(judgment.planId, judgment);
    }
  }
  const verdicts = new Map<string, 'correct' | 'incorrect'>();
  for (const [planId, judgment] of latest) {
    if (judgment.verdict === 'correct' || judgment.verdict === 'incorrect') {
      verdicts.set(planId, judgment.verdict);
    }
  }
  return verdicts;
}

/**
 * Source-selection quality (benchmark measurements 3 and 4): objective
 * first-choice answer rate plus the judgment-labeled first-choice quality
 * rate and employee routing accuracy.
 */
export function computeSourceSelection(
  plans: PlanFact[],
  judgments: JudgmentFact[],
  window: MetricWindow,
): SourceSelectionPayload {
  const verdicts = planVerdicts(judgments);
  const inWindow = firstChoicePlans(plans).filter(
    (plan) => plan.recordedAtMs >= window.fromMs && plan.recordedAtMs <= window.toMs,
  );

  let firstChoiceResolved = 0;
  let firstChoiceAnswered = 0;
  let judgedFirstChoice = 0;
  let correctFirstChoice = 0;
  let employeeFirstChoice = 0;
  let employeeJudged = 0;
  let employeeCorrect = 0;
  for (const plan of inWindow) {
    if (plan.outcomeKind !== null) {
      firstChoiceResolved += 1;
      if (plan.outcomeKind === 'answered') firstChoiceAnswered += 1;
    }
    const verdict = verdicts.get(plan.planId);
    if (verdict !== undefined) {
      judgedFirstChoice += 1;
      if (verdict === 'correct') correctFirstChoice += 1;
    }
    if (plan.action === 'ask-person') {
      employeeFirstChoice += 1;
      if (verdict !== undefined) {
        employeeJudged += 1;
        if (verdict === 'correct') employeeCorrect += 1;
      }
    }
  }

  return {
    firstChoiceTotal: inWindow.length,
    firstChoiceResolved,
    firstChoiceAnswered,
    firstChoiceAnswerRate: rate(firstChoiceAnswered, firstChoiceResolved),
    judgedFirstChoice,
    correctFirstChoice,
    firstChoiceQualityRate: rate(correctFirstChoice, judgedFirstChoice),
    employeeFirstChoice,
    employeeJudged,
    employeeCorrect,
    employeeRoutingAccuracy: rate(employeeCorrect, employeeJudged),
  };
}

// ---------------------------------------------------------------------------
// Mission resolution efficiency
// ---------------------------------------------------------------------------

/**
 * Mission resolution efficiency (benchmark measurement 2): median/mean
 * selected-plan count per mission completed in the window. One step = one
 * selected acquisition plan.
 */
export function computeMissionResolutionEfficiency(
  missions: ResolvedMissionFact[],
  plans: PlanFact[],
  window: MetricWindow,
): MissionResolutionEfficiencyPayload {
  const stepsByMission = new Map<string, number>();
  for (const plan of plans) {
    stepsByMission.set(plan.missionId, (stepsByMission.get(plan.missionId) ?? 0) + 1);
  }
  const resolved = missions.filter(
    (mission) => mission.completedAtMs >= window.fromMs && mission.completedAtMs <= window.toMs,
  );
  const steps = resolved.map((mission) => stepsByMission.get(mission.missionId) ?? 0);
  return {
    resolvedMissions: resolved.length,
    missionsWithoutSteps: steps.filter((count) => count === 0).length,
    medianSteps: median(steps),
    meanSteps: mean(steps),
  };
}

// ---------------------------------------------------------------------------
// Evidence quality
// ---------------------------------------------------------------------------

/**
 * Evidence quality (benchmark measurement 9's evidence half): the
 * descriptive confidence/provenance profile of the observations considered.
 * No normative threshold — consumers interpret.
 */
export function computeEvidenceQuality(observations: ObservationFact[]): EvidenceQualityPayload {
  const count = observations.length;
  if (count === 0) {
    return {
      observations: 0,
      meanConfidence: null,
      minConfidence: null,
      maxConfidence: null,
      shareWithLineage: null,
      shareWithConfidenceBasis: null,
    };
  }
  let withLineage = 0;
  let withBasis = 0;
  for (const observation of observations) {
    if (observation.lineageParentCount > 0) withLineage += 1;
    if (observation.confidenceBasis !== null) withBasis += 1;
  }
  const confidences = observations.map((observation) => observation.confidenceValue);
  return {
    observations: count,
    meanConfidence: mean(confidences),
    minConfidence: round6(Math.min(...confidences)),
    maxConfidence: round6(Math.max(...confidences)),
    shareWithLineage: rate(withLineage, count),
    shareWithConfidenceBasis: rate(withBasis, count),
  };
}

// ---------------------------------------------------------------------------
// Recommendation calibration, intervention success, realized value
// ---------------------------------------------------------------------------

/** +1 when the direction says higher-is-better, −1 otherwise. */
function directionSign(direction: 'at_least' | 'at_most'): number {
  return direction === 'at_least' ? 1 : -1;
}

function inWindow(ms: number, window: MetricWindow): boolean {
  return ms >= window.fromMs && ms <= window.toMs;
}

/**
 * Recommendation calibration (benchmark measurement 6) over settled
 * 'recommendation' outcomes in the window. The prediction is the frozen
 * expected value; positive bias always means "better than predicted"
 * regardless of metric direction.
 */
export function computeRecommendationCalibration(
  outcomes: SettledOutcomeFact[],
  settledAtMs: (outcomeId: string) => number | null,
  window: MetricWindow,
): RecommendationCalibrationPayload {
  const recommendations = outcomes.filter(
    (outcome) =>
      outcome.subjectKind === 'recommendation' &&
      inWindow(settledAtMs(outcome.outcomeId) ?? Number.NEGATIVE_INFINITY, window),
  );
  return calibrationOf(recommendations);
}

function calibrationOf(outcomes: SettledOutcomeFact[]): RecommendationCalibrationPayload {
  const signed = outcomes.map(
    (outcome) => (outcome.realized - outcome.expected) * directionSign(outcome.direction),
  );
  const absolute = outcomes.map((outcome) => Math.abs(outcome.realized - outcome.expected));
  const met = outcomes.filter((outcome) => outcome.assessment === 'met').length;
  const exceeded = outcomes.filter((outcome) => outcome.assessment === 'exceeded').length;
  const missed = outcomes.filter((outcome) => outcome.assessment === 'missed').length;
  return {
    settledRecommendations: outcomes.length,
    met,
    exceeded,
    missed,
    predictionBiasMean: mean(signed),
    predictionErrorMean: mean(absolute),
    metOrExceededRate: rate(met + exceeded, outcomes.length),
  };
}

function successBucketOf(outcomes: SettledOutcomeFact[]): InterventionSuccessBucket {
  const met = outcomes.filter((outcome) => outcome.assessment === 'met').length;
  const exceeded = outcomes.filter((outcome) => outcome.assessment === 'exceeded').length;
  const missed = outcomes.filter((outcome) => outcome.assessment === 'missed').length;
  return {
    settled: outcomes.length,
    met,
    exceeded,
    missed,
    successRate: rate(met + exceeded, outcomes.length),
  };
}

/**
 * Intervention success (benchmark measurement 7's success half) over ALL
 * settled outcomes in the window — ADR-0019's frozen assessment, overall
 * and per subject kind.
 */
export function computeInterventionSuccess(
  outcomes: SettledOutcomeFact[],
  settledAtMs: (outcomeId: string) => number | null,
  window: MetricWindow,
): InterventionSuccessPayload {
  const inWindowOutcomes = outcomes.filter((outcome) =>
    inWindow(settledAtMs(outcome.outcomeId) ?? Number.NEGATIVE_INFINITY, window),
  );
  const bySubjectKind: InterventionSuccessPayload['bySubjectKind'] = {};
  for (const kind of ['recommendation', 'agent', 'extension', 'mission'] as const) {
    bySubjectKind[kind] = successBucketOf(
      inWindowOutcomes.filter((outcome) => outcome.subjectKind === kind),
    );
  }
  return { ...successBucketOf(inWindowOutcomes), bySubjectKind };
}

function valueBucketOf(outcomes: SettledOutcomeFact[]): RealizedValueBucket {
  let expectedValueSum = 0;
  let realizedValueSum = 0;
  let netVarianceSum = 0;
  let improvementSum = 0;
  for (const outcome of outcomes) {
    expectedValueSum += outcome.expected;
    realizedValueSum += outcome.realized;
    netVarianceSum += outcome.realized - outcome.expected;
    improvementSum += (outcome.realized - outcome.baseline) * directionSign(outcome.direction);
  }
  return {
    settled: outcomes.length,
    expectedValueSum: round6(expectedValueSum),
    realizedValueSum: round6(realizedValueSum),
    netVarianceSum: round6(netVarianceSum),
    improvementSum: round6(improvementSum),
  };
}

/**
 * Realized value (benchmark measurement 7): expected versus realized over
 * settled outcomes in the window, overall and per subject kind. Sums are
 * arithmetic over metric values in mixed units — the consumer interprets.
 */
export function computeRealizedValue(
  outcomes: SettledOutcomeFact[],
  settledAtMs: (outcomeId: string) => number | null,
  window: MetricWindow,
): RealizedValuePayload {
  const inWindowOutcomes = outcomes.filter((outcome) =>
    inWindow(settledAtMs(outcome.outcomeId) ?? Number.NEGATIVE_INFINITY, window),
  );
  const bySubjectKind: RealizedValuePayload['bySubjectKind'] = {};
  for (const kind of ['recommendation', 'agent', 'extension', 'mission'] as const) {
    bySubjectKind[kind] = valueBucketOf(
      inWindowOutcomes.filter((outcome) => outcome.subjectKind === kind),
    );
  }
  return { ...valueBucketOf(inWindowOutcomes), bySubjectKind };
}

// ---------------------------------------------------------------------------
// Investigation cost
// ---------------------------------------------------------------------------

/**
 * Investigation cost (benchmark measurement 5's cost half). Window cost is
 * committed by selected plans recorded in the window; per-mission cost is
 * the all-steps cost of missions completed in the window (zero-plan
 * missions count at zero). Money is grouped by currency — never summed
 * across currencies.
 */
export function computeInvestigationCost(
  plans: PlanFact[],
  missions: ResolvedMissionFact[],
  window: MetricWindow,
): InvestigationCostPayload {
  // Window-committed cost by currency.
  const windowCost = new Map<string, { plans: number; totalCost: number }>();
  const windowPlans = plans.filter((plan) => inWindow(plan.recordedAtMs, window));
  for (const plan of windowPlans) {
    const bucket = windowCost.get(plan.budgetCurrency) ?? { plans: 0, totalCost: 0 };
    bucket.plans += 1;
    bucket.totalCost += plan.estimatedCost ?? 0;
    windowCost.set(plan.budgetCurrency, bucket);
  }

  // Per-resolved-mission cost by currency (all considered steps, not just
  // the window's — the mission's total investigation bill).
  const resolved = missions.filter((mission) => inWindow(mission.completedAtMs, window));
  const missionCost = new Map<string, number[]>();
  let missionsWithoutPlans = 0;
  for (const mission of resolved) {
    const missionPlans = plans.filter((plan) => plan.missionId === mission.missionId);
    if (missionPlans.length === 0) {
      missionsWithoutPlans += 1;
      missionCost.set(mission.budgetCurrency, [
        ...(missionCost.get(mission.budgetCurrency) ?? []),
        0,
      ]);
      continue;
    }
    const currency = missionPlans[0]!.budgetCurrency;
    const cost = missionPlans.reduce((sum, plan) => sum + (plan.estimatedCost ?? 0), 0);
    missionCost.set(currency, [...(missionCost.get(currency) ?? []), cost]);
  }

  const costPerResolvedMissionByCurrency: CostByCurrency[] = [...missionCost.entries()]
    .map(([currency, costs]) => ({
      currency,
      missions: costs.length,
      totalCost: costs.reduce((sum, cost) => sum + cost, 0),
      medianCost: median(costs),
      meanCost: mean(costs),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const windowCostByCurrency: CostByCurrency[] = [...windowCost.entries()]
    .map(([currency, bucket]) => ({
      currency,
      plans: bucket.plans,
      totalCost: bucket.totalCost,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    windowPlans: windowPlans.length,
    windowCostByCurrency,
    resolvedMissions: resolved.length,
    missionsWithoutPlans,
    costPerResolvedMissionByCurrency,
  };
}

// ---------------------------------------------------------------------------
// Time-to-useful-understanding
// ---------------------------------------------------------------------------

/**
 * Time-to-useful-understanding (benchmark measurement 5's time half):
 * creation → resolution, and creation → the first 'answered' acquisition
 * outcome. Hours, 6-decimal rounded; null when the respective set is empty.
 */
export function computeTimeToUsefulUnderstanding(
  missions: ResolvedMissionFact[],
  plans: PlanFact[],
  window: MetricWindow,
): TimeToUsefulUnderstandingPayload {
  const resolved = missions.filter((mission) => inWindow(mission.completedAtMs, window));

  const resolutionHours = resolved.map(
    (mission) => (mission.completedAtMs - mission.createdAtMs) / MS_PER_HOUR,
  );

  // First answer per mission: the earliest 'answered' outcome at or after
  // the mission's creation (never a negative duration).
  const resolvedByMission = new Map(resolved.map((mission) => [mission.missionId, mission]));
  const firstAnswerByMission = new Map<string, number>();
  for (const plan of plans) {
    if (plan.outcomeKind !== 'answered' || plan.outcomeRecordedAtMs === null) continue;
    const mission = resolvedByMission.get(plan.missionId);
    if (mission === undefined || plan.outcomeRecordedAtMs < mission.createdAtMs) continue;
    const current = firstAnswerByMission.get(plan.missionId);
    if (current === undefined || plan.outcomeRecordedAtMs < current) {
      firstAnswerByMission.set(plan.missionId, plan.outcomeRecordedAtMs);
    }
  }
  const answerHours = resolved
    .filter((mission) => firstAnswerByMission.has(mission.missionId))
    .map(
      (mission) =>
        (firstAnswerByMission.get(mission.missionId)! - mission.createdAtMs) / MS_PER_HOUR,
    );

  return {
    resolvedMissions: resolved.length,
    medianResolutionHours: median(resolutionHours),
    meanResolutionHours: mean(resolutionHours),
    missionsWithFirstAnswer: answerHours.length,
    medianTimeToFirstAnswerHours: median(answerHours),
    meanTimeToFirstAnswerHours: mean(answerHours),
  };
}

// ---------------------------------------------------------------------------
// The dispatcher (canonical entry the service uses)
// ---------------------------------------------------------------------------

/** Everything the pure computations need, gathered by the service. */
export interface MetricComputationInput {
  window: MetricWindow;
  candidates: CandidateFact[];
  judgments: JudgmentFact[];
  plans: PlanFact[];
  missions: ResolvedMissionFact[];
  observations: ObservationFact[];
  outcomes: SettledOutcomeFact[];
  /** settledAt lookup (epoch ms) for the fetched outcomes; null when unknown. */
  settledAtMs: (outcomeId: string) => number | null;
}

/** Computes ONE metric family from the gathered facts (pure dispatch). */
export function computeMetric(
  metricKind: QualityMetricKind,
  facts: MetricComputationInput,
): QualityMetricPayload {
  const computation = COMPUTATIONS[metricKind];
  if (computation === undefined) {
    throw new Error(`unknown metric kind '${metricKind}'`);
  }
  return computation(facts);
}

const COMPUTATIONS: Record<QualityMetricKind, (facts: MetricComputationInput) => QualityMetricPayload> = {
  'unknown-discovery': (facts) => ({
    metricKind: 'unknown-discovery',
    ...computeUnknownDiscovery(facts.candidates, facts.judgments, facts.window),
  }),
  'source-selection': (facts) => ({
    metricKind: 'source-selection',
    ...computeSourceSelection(facts.plans, facts.judgments, facts.window),
  }),
  'mission-resolution-efficiency': (facts) => ({
    metricKind: 'mission-resolution-efficiency',
    ...computeMissionResolutionEfficiency(facts.missions, facts.plans, facts.window),
  }),
  'evidence-quality': (facts) => ({
    metricKind: 'evidence-quality',
    ...computeEvidenceQuality(facts.observations),
  }),
  'recommendation-calibration': (facts) => ({
    metricKind: 'recommendation-calibration',
    ...computeRecommendationCalibration(facts.outcomes, facts.settledAtMs, facts.window),
  }),
  'intervention-success': (facts) => ({
    metricKind: 'intervention-success',
    ...computeInterventionSuccess(facts.outcomes, facts.settledAtMs, facts.window),
  }),
  'realized-value': (facts) => ({
    metricKind: 'realized-value',
    ...computeRealizedValue(facts.outcomes, facts.settledAtMs, facts.window),
  }),
  'investigation-cost': (facts) => ({
    metricKind: 'investigation-cost',
    ...computeInvestigationCost(facts.plans, facts.missions, facts.window),
  }),
  'time-to-useful-understanding': (facts) => ({
    metricKind: 'time-to-useful-understanding',
    ...computeTimeToUsefulUnderstanding(facts.missions, facts.plans, facts.window),
  }),
};
