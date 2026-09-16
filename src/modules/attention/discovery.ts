// Pure goal-gap derivation logic of the attention module (W051 —
// Unprompted Unknown Discovery). No database, no context, no clock reads —
// everything here is a total, deterministic function of its arguments.
//
// This file is THE "unprompted" of ADR-0017: given the tenant's active
// goals and what the evidence says about them, it COMPUTES the candidate
// unknowns — question, consequence, decision impact, urgency, confidence
// gap, expected information value and candidate acquisition paths — with
// no user question and no LLM assertion anywhere in the path:
//
//   "Aurum derives consequential unknowns from active goals, desired
//    state, temporal state and evidence without requiring management to
//    state the exact question."
//
// Inputs map onto the ADR's four sources:
//  * active goals    — the goal snapshots (objective, desired state,
//                      metrics/thresholds, horizon, priority, evidence
//                      sources) fetched through the goals contract (W008);
//  * desired state   — each goal's `desiredState` (carried into the
//                      derived consequence text);
//  * temporal state  — the goal horizons evaluated against the pass's
//                      `now` (urgency bumps as deadlines approach);
//  * evidence        — the metric readings (what the tenant's claims say
//                      about each goal metric) and the standing confidence
//                      for metric-less goals.
//
// The three deterministic gap kinds:
//  * 'driver'  — a metric HAS readings and sits OFF its target: the
//    missing knowledge is what DRIVES it there (corrective action cannot
//    be chosen without it — the most consequential gap). Skipped when the
//    evidence already pins the drivers to the goal's required confidence
//    (knowledge sufficient → no unknown: discovery must not manufacture
//    gaps) and when the metric is on target (no gap at all).
//  * 'reading' — a goal metric has NO reading: the metric's current value
//    is the missing knowledge (the goal cannot even be evaluated).
//  * 'standing' — a metric-less goal whose standing confidence is below
//    the required confidence: the progress against the desired state is
//    the missing knowledge.
//
// Deterministic scoring (the numbers the policy gate consumes):
//  * decision impact  — goal priority rank scaled by how far off the
//    target the metric sits (severity): (rank/4) · (0.5 + 0.5·severity)
//    for driver gaps; severity is unknown for reading/standing gaps, so
//    they take the neutral 0.5. Impact therefore rises with goal
//    importance and shortfall — "mission priority changes with goal
//    importance" (MISSION-ALIGNMENT.md, Goal-driven learning).
//  * urgency          — the priority band, bumped one band per horizon
//    threshold crossed (≤ 90 days, ≤ 30 days, past due), clamped at
//    'critical'.
//  * confidence gap   — required minus current. Required confidence is
//    derived from priority (critical 0.9, high 0.8, medium 0.7,
//    low 0.6); current is the evidence's driver confidence (driver gaps)
//    or the standing confidence (standing gaps), 0 for reading gaps.
//  * information value — impact · confidenceGap, rounded to 4 decimals:
//    the expected value of closing exactly this gap, which is what the
//    materiality policy gates on (ADR-0017: "sufficient decision impact
//    AND information value").
//
// `evaluateMateriality` is the single definition of the policy gate; the
// service snapshots its inputs (the run's thresholds) and its output (the
// disposition) onto the append-only run/candidate records, so every
// promotion and dismissal is reconstructable.

import type { MissionCandidateKind } from '@/modules/missions/contract';
import type {
  AcquisitionPath,
  CandidateUrgency,
  GapKind,
  MaterialityPolicy,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies and fixed derivation constants
// ---------------------------------------------------------------------------

/** Goal priority → comparable rank (the goals module's vocabulary). */
export const PRIORITY_RANK: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** The urgency bands, ascending. */
export const URGENCY_BANDS: readonly CandidateUrgency[] = ['low', 'medium', 'high', 'critical'];

/** Days-before-horizon-end that bump urgency one band. */
export const HORIZON_BUMP_DAYS = [90, 30] as const;

/**
 * The required confidence each priority demands of closing knowledge:
 * how sure Aurum must be about the answer before the gap stops mattering.
 */
export const REQUIRED_CONFIDENCE: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 0.9,
  high: 0.8,
  medium: 0.7,
  low: 0.6,
};

/** The neutral severity reading/standing gaps score (their shortfall is the unknown). */
export const NEUTRAL_SEVERITY = 0.5;

/** Round to 4 decimals — the persisted score granularity (deterministic output). */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Derivation input snapshots (plain structural types — the service builds
// them from the goals contract and the validated run input)
// ---------------------------------------------------------------------------

/** One goal metric as the goals module (W008) defines it. */
export interface GoalMetricSnapshot {
  name: string;
  unit: string | null;
  direction: 'at_least' | 'at_most' | 'in_range';
  threshold: number | null;
  lowerBound: number | null;
  upperBound: number | null;
}

/** One goal evidence source as the goals module (W008) defines it. */
export interface GoalEvidenceSourceSnapshot {
  kind: 'source' | 'person' | 'agent' | 'system' | 'external';
  id?: string | null;
  label?: string | null;
}

/** One active goal, snapshotted for the derivation. */
export interface GoalSnapshot {
  id: string;
  title: string;
  objective: string;
  desiredState: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** ISO 8601 — when the goal's horizon ends (the deadline). */
  horizonEnd: string;
  metrics: GoalMetricSnapshot[];
  evidenceSources: GoalEvidenceSourceSnapshot[];
}

/** One validated metric reading (the evidence extraction). */
export interface ReadingSnapshot {
  metricName: string;
  value: number;
  driverConfidence: number;
  evidenceClaimIds: string[];
  evidenceBeliefIds: string[];
}

/** The evidence state of one goal (absent readings = nothing known). */
export interface GoalEvidenceSnapshot {
  readings?: ReadingSnapshot[];
  /** Confidence the evidence pins a metric-less goal's standing; [0, 1], default 0. */
  standingConfidence?: number;
}

/** The derivation input: the active goals plus their evidence, and `now`. */
export interface DerivationInput {
  goals: GoalSnapshot[];
  /** Evidence per goal id; goals without an entry count as evidence-less. */
  evidence: Record<string, GoalEvidenceSnapshot>;
  /** The pass's instant (service clock; test-controllable). */
  now: Date;
}

// ---------------------------------------------------------------------------
// The derived candidate (the pure output — the service validates, gates,
// persists and promotes it)
// ---------------------------------------------------------------------------

/** One derived candidate unknown, before the materiality gate decides it. */
export interface DerivedGapCandidate {
  gapKey: string;
  gapKind: GapKind;
  /** The metric the gap is about, when kind is 'driver'/'reading' (else null). */
  metricName: string | null;
  affectedGoalIds: string[];
  missingKnowledge: string;
  consequence: string;
  decisionImpact: number;
  urgency: CandidateUrgency;
  currentConfidence: number;
  requiredConfidence: number;
  informationValue: number;
  evidenceClaimIds: string[];
  evidenceBeliefIds: string[];
  acquisitionPaths: AcquisitionPath[];
}

// ---------------------------------------------------------------------------
// Deterministic scoring primitives
// ---------------------------------------------------------------------------

/**
 * Decision impact of a gap: goal priority rank scaled by severity —
 * (rank/4) · (0.5 + 0.5·severity), clamped to [0, 1]. A critical goal
 * fully off target scores 1; a low-priority goal never exceeds 0.25 (its
 * gaps stay below the default materiality bar — attention follows
 * importance).
 */
export function decisionImpactFor(
  priority: 'critical' | 'high' | 'medium' | 'low',
  severity: number,
): number {
  const clamped = Math.min(1, Math.max(0, severity));
  return round4((PRIORITY_RANK[priority] / 4) * (0.5 + 0.5 * clamped));
}

/**
 * Expected information value of closing a confidence gap: impact · gap,
 * clamped to [0, 1]. The more a decision depends on the knowledge
 * (impact) and the less is currently known (gap), the more the answer is
 * worth — the two axes ADR-0017's policy gate thresholds separately.
 */
export function informationValueFor(decisionImpact: number, confidenceGap: number): number {
  const impact = Math.min(1, Math.max(0, decisionImpact));
  const gap = Math.min(1, Math.max(0, confidenceGap));
  return round4(impact * gap);
}

/** The required confidence a priority demands (REQUIRED_CONFIDENCE). */
export function requiredConfidenceFor(
  priority: 'critical' | 'high' | 'medium' | 'low',
): number {
  return REQUIRED_CONFIDENCE[priority];
}

/**
 * Urgency of a gap: the priority's band, bumped one band per horizon
 * threshold crossed (≤ 90 days, then ≤ 30 days — a past-due horizon
 * crosses both), clamped at 'critical'. Temporal state made deterministic.
 */
export function urgencyFromPriority(
  priority: 'critical' | 'high' | 'medium' | 'low',
  horizonEnd: string,
  now: Date,
): CandidateUrgency {
  // The priority's own band (critical→3, high→2, medium→1, low→0).
  let band = PRIORITY_RANK[priority] - 1;
  const end = Date.parse(horizonEnd);
  if (!Number.isNaN(end)) {
    const daysLeft = (end - now.getTime()) / 86_400_000;
    for (const threshold of HORIZON_BUMP_DAYS) {
      if (daysLeft <= threshold) band += 1;
    }
  }
  const clamped = Math.min(URGENCY_BANDS.length - 1, Math.max(0, band));
  return URGENCY_BANDS[clamped]!;
}

/** Human-readable target of a metric for the derived question text. */
export function targetDescription(metric: GoalMetricSnapshot): string {
  if (metric.direction === 'at_least') return `at least ${String(metric.threshold)}`;
  if (metric.direction === 'at_most') return `at most ${String(metric.threshold)}`;
  return `within [${String(metric.lowerBound)}, ${String(metric.upperBound)}]`;
}

/**
 * How far off its target a metric value sits, as a share of the target
 * magnitude — the driver gap's severity. Returns null when the value is
 * ON target (no gap). The denominator guards against zero thresholds
 * (a 0-target metric measures absolute distance).
 */
export function relativeShortfall(metric: GoalMetricSnapshot, value: number): number | null {
  let distance: number;
  switch (metric.direction) {
    case 'at_least':
      if (value >= (metric.threshold ?? 0)) return null;
      distance = (metric.threshold ?? 0) - value;
      break;
    case 'at_most':
      if (value <= (metric.threshold ?? 0)) return null;
      distance = value - (metric.threshold ?? 0);
      break;
    case 'in_range': {
      const lower = metric.lowerBound ?? 0;
      const upper = metric.upperBound ?? 0;
      if (value >= lower && value <= upper) return null;
      distance = value < lower ? lower - value : value - upper;
      break;
    }
  }
  const magnitude =
    metric.direction === 'in_range'
      ? Math.abs(value < (metric.lowerBound ?? 0) ? (metric.lowerBound ?? 0) : (metric.upperBound ?? 0))
      : Math.abs(metric.threshold ?? 0);
  return round4(Math.min(1, distance / Math.max(magnitude, 1e-9)));
}

/** The stable gap identity: goal · kind · metric (metric-less kinds use ''). */
export function gapKeyFor(goalId: string, kind: GapKind, metricName?: string): string {
  return `${goalId}|${kind}|${metricName ?? ''}`;
}

/**
 * Maps a goal's evidence sources (W008 vocabulary) onto candidate
 * acquisition paths (the §7/missions menu): where evidence about the goal
 * is expected to come from is where the missing knowledge is most likely
 * obtainable. `source` connectors map to `system` (a source connector is
 * a system of record); every other kind maps identically. Duplicates
 * (same kind + identity) collapse — the mission menu stays clean.
 */
export function acquisitionPathsFromGoalSources(
  sources: GoalEvidenceSourceSnapshot[],
): AcquisitionPath[] {
  const kindMap: Record<GoalEvidenceSourceSnapshot['kind'], MissionCandidateKind> = {
    source: 'system',
    person: 'person',
    agent: 'agent',
    system: 'system',
    external: 'external',
  };
  const seen = new Set<string>();
  const paths: AcquisitionPath[] = [];
  for (const source of sources) {
    const kind = kindMap[source.kind];
    const id = source.id ?? null;
    const label = source.label ?? null;
    if (id === null && label === null) continue; // untraceable — not a path
    const key = `${kind}|${id ?? ''}|${label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push({ kind, id, label });
  }
  return paths;
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

/**
 * Derives the candidate unknowns of one discovery pass — the deterministic
 * goal+evidence evaluation of ADR-0017. Total and pure: the same goals,
 * evidence and instant always produce the same candidates, in a stable
 * order (goal input order, then metric declaration order).
 *
 * What it deliberately does NOT do: manufacture gaps. A metric on target
 * produces no candidate; a driver question the evidence already answers
 * to the goal's required confidence produces no candidate; a metric-less
 * goal whose standing is sufficiently known produces no candidate. The
 * unprompted capability surfaces exactly the material-shaped holes in the
 * tenant's knowledge — attention, not noise.
 */
export function deriveGoalGapCandidates(input: DerivationInput): DerivedGapCandidate[] {
  const candidates: DerivedGapCandidate[] = [];

  for (const goal of input.goals) {
    const evidence = input.evidence[goal.id] ?? {};
    const readings = evidence.readings ?? [];
    const readingsByName = new Map<string, ReadingSnapshot>();
    for (const reading of readings) {
      readingsByName.set(reading.metricName, reading);
    }
    const paths = acquisitionPathsFromGoalSources(goal.evidenceSources);
    const required = requiredConfidenceFor(goal.priority);

    for (const metric of goal.metrics) {
      const reading = readingsByName.get(metric.name);
      if (reading === undefined) {
        // No reading at all: the metric's current value is unknown — the
        // goal cannot be evaluated against its desired state.
        const impact = decisionImpactFor(goal.priority, NEUTRAL_SEVERITY);
        candidates.push({
          gapKey: gapKeyFor(goal.id, 'reading', metric.name),
          gapKind: 'reading',
          metricName: metric.name,
          affectedGoalIds: [goal.id],
          missingKnowledge: `What is the current value of ${metric.name} for goal '${goal.title}'?`,
          consequence: `Goal '${goal.title}' (desired state: ${goal.desiredState}) cannot be evaluated while ${metric.name} is unknown; progress and drift are invisible to management.`,
          decisionImpact: impact,
          urgency: urgencyFromPriority(goal.priority, goal.horizonEnd, input.now),
          currentConfidence: 0,
          requiredConfidence: required,
          informationValue: informationValueFor(impact, required),
          evidenceClaimIds: [],
          evidenceBeliefIds: [],
          acquisitionPaths: paths,
        });
        continue;
      }

      const shortfall = relativeShortfall(metric, reading.value);
      if (shortfall === null) continue; // on target — no gap

      const driverConfidence = Math.min(1, Math.max(0, reading.driverConfidence));
      if (driverConfidence >= required) continue; // drivers sufficiently known

      const impact = decisionImpactFor(goal.priority, shortfall);
      const gap = round4(required - driverConfidence);
      candidates.push({
        gapKey: gapKeyFor(goal.id, 'driver', metric.name),
        gapKind: 'driver',
        metricName: metric.name,
        affectedGoalIds: [goal.id],
        missingKnowledge: `What is driving ${metric.name} to ${String(reading.value)} instead of ${targetDescription(metric)} for goal '${goal.title}'?`,
        consequence: `Without knowing what drives ${metric.name} (currently ${String(reading.value)} against ${targetDescription(metric)}), goal '${goal.title}' (desired state: ${goal.desiredState}) cannot be steered back on track, and corrective-action decisions carry unmanaged risk.`,
        decisionImpact: impact,
        urgency: urgencyFromPriority(goal.priority, goal.horizonEnd, input.now),
        currentConfidence: driverConfidence,
        requiredConfidence: required,
        informationValue: informationValueFor(impact, gap),
        evidenceClaimIds: [...reading.evidenceClaimIds],
        evidenceBeliefIds: [...reading.evidenceBeliefIds],
        acquisitionPaths: paths,
      });
    }

    if (goal.metrics.length === 0) {
      // A metric-less goal is evaluated by its standing confidence alone.
      const standing = Math.min(1, Math.max(0, evidence.standingConfidence ?? 0));
      if (standing < required) {
        const impact = decisionImpactFor(goal.priority, NEUTRAL_SEVERITY);
        candidates.push({
          gapKey: gapKeyFor(goal.id, 'standing'),
          gapKind: 'standing',
          metricName: null,
          affectedGoalIds: [goal.id],
          missingKnowledge: `What is the current standing of goal '${goal.title}' relative to its desired state?`,
          consequence: `Progress and drift of goal '${goal.title}' (desired state: ${goal.desiredState}) are unknown, so management cannot judge whether the goal is being reached.`,
          decisionImpact: impact,
          urgency: urgencyFromPriority(goal.priority, goal.horizonEnd, input.now),
          currentConfidence: standing,
          requiredConfidence: required,
          informationValue: informationValueFor(impact, round4(required - standing)),
          evidenceClaimIds: [],
          evidenceBeliefIds: [],
          acquisitionPaths: paths,
        });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// The materiality policy gate (ADR-0017)
// ---------------------------------------------------------------------------

/** The policy gate's decision on one candidate. */
export interface MaterialityDecision {
  material: boolean;
  /** Which threshold failed, when one did — the auditable why. */
  reason:
    | 'material'
    | 'impact_below_threshold'
    | 'value_below_threshold'
    | 'impact_and_value_below_threshold';
}

/**
 * The single definition of ADR-0017's policy gate: a candidate is material
 * when its decision impact is at least the impact threshold AND its
 * expected information value is at least the value threshold. Pure and
 * total; the service persists the thresholds on the run and the resulting
 * disposition on the candidate, so the decision is reconstructable.
 */
export function evaluateMateriality(
  candidate: { decisionImpact: number; informationValue: number },
  policy: MaterialityPolicy,
): MaterialityDecision {
  const impactOk = candidate.decisionImpact >= policy.impactThreshold;
  const valueOk = candidate.informationValue >= policy.valueThreshold;
  if (impactOk && valueOk) return { material: true, reason: 'material' };
  if (!impactOk && !valueOk) return { material: false, reason: 'impact_and_value_below_threshold' };
  if (!impactOk) return { material: false, reason: 'impact_below_threshold' };
  return { material: false, reason: 'value_below_threshold' };
}
