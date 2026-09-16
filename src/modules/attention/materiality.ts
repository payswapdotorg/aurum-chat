// Pure, deterministic derivation logic of the attention module (no
// database) — the cognition module's loop.ts/signals.ts precedent.
//
// Everything here is a total function over validated inputs, so the
// materiality decision and the unknown/mission derivations are:
//   * DETERMINISTIC — no clock, no randomness, no LLM, no principal
//     identity participates (ADR-0017: "Unknown discovery is never an LLM
//     assertion: the LLM may propose, the application decides, records
//     and links evidence");
//   * UNIT-TESTABLE in isolation (tests/attention-unit.test.ts);
//   * RECONSTRUCTABLE — every produced string records which values and
//     thresholds produced it (§24).
//
// Downstream modules (W052 knowledge source ranking, W055 quality
// measurement) consume these through the contract to score and audit
// discovery decisions without a database.

import type {
  AcquisitionPathKind,
  CandidateMaterialization,
  CandidateUnknown,
  GapUrgency,
  MaterialityDecision,
  MissionPolicyMode,
} from './types';

// ---------------------------------------------------------------------------
// Built-in default policy (applies when no tenant row exists)
// ---------------------------------------------------------------------------

/** Default minimum sufficient decision impact (the built-in policy floor). */
export const DEFAULT_MIN_DECISION_IMPACT = 0.5;
/** Default minimum sufficient information value (the built-in policy floor). */
export const DEFAULT_MIN_INFORMATION_VALUE = 0.5;
/** Default mission release mode: discovery materializes immediately (ADR-0017's unprompted capability). */
export const DEFAULT_MISSION_POLICY: MissionPolicyMode = 'auto';
/** Default discovery mission budgets: nothing may be spent or offered until a tenant configures it. */
export const DEFAULT_INVESTIGATION_BUDGET = { amount: 0, currency: 'EUR' } as const;
export const DEFAULT_REWARD_BUDGET = { amount: 0, currency: 'EUR' } as const;

/** The built-in materiality floor applied when the tenant has no policy row. */
export const BUILT_IN_DISCOVERY_POLICY = {
  minDecisionImpact: DEFAULT_MIN_DECISION_IMPACT,
  minInformationValue: DEFAULT_MIN_INFORMATION_VALUE,
  missionPolicy: DEFAULT_MISSION_POLICY,
  investigationBudget: { ...DEFAULT_INVESTIGATION_BUDGET },
  rewardBudget: { ...DEFAULT_REWARD_BUDGET },
} as const;

// ---------------------------------------------------------------------------
// Urgency ranking (deterministic ordering for listings)
// ---------------------------------------------------------------------------

const URGENCY_RANK: Record<GapUrgency, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Rank of one urgency (0 = critical first); deterministic listing order. */
export function urgencyRank(urgency: GapUrgency): number {
  return URGENCY_RANK[urgency];
}

// ---------------------------------------------------------------------------
// Materiality — THE deterministic policy gate (ADR-0017)
// ---------------------------------------------------------------------------

/** The thresholds a materiality decision is evaluated against. */
export interface MaterialityThresholds {
  minDecisionImpact: number;
  minInformationValue: number;
}

/** The materiality inputs of one candidate. */
export interface MaterialityInputs {
  decisionImpact: number;
  informationValue: number;
}

function formatValue(value: number): string {
  // Plain, locale-independent rendering — the basis string is audit data.
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * The deterministic materiality verdict (ADR-0017: "Only material unknowns
 * (sufficient decision impact and information value) may become
 * LearningMissions, through the policy gate"): material iff
 * `decisionImpact >= minDecisionImpact && informationValue >= minInformationValue`
 * — inclusive, because the threshold IS the definition of "sufficient".
 */
export function evaluateMateriality(
  thresholds: MaterialityThresholds,
  inputs: MaterialityInputs,
): MaterialityDecision {
  const impactOk = inputs.decisionImpact >= thresholds.minDecisionImpact;
  const valueOk = inputs.informationValue >= thresholds.minInformationValue;
  const material = impactOk && valueOk;
  const basis = material
    ? `decision impact ${formatValue(inputs.decisionImpact)} >= ${formatValue(thresholds.minDecisionImpact)} and information value ${formatValue(inputs.informationValue)} >= ${formatValue(thresholds.minInformationValue)}`
    : `decision impact ${formatValue(inputs.decisionImpact)} ${impactOk ? '>=' : '<'} ${formatValue(thresholds.minDecisionImpact)} or information value ${formatValue(inputs.informationValue)} ${valueOk ? '>=' : '<'} ${formatValue(thresholds.minInformationValue)} — below the materiality thresholds`;
  return { decision: material ? 'material' : 'immaterial', material, basis };
}

// ---------------------------------------------------------------------------
// Unknown derivation (candidate → the epistemics recordUnknown input)
// ---------------------------------------------------------------------------

/**
 * The epistemics subject kind goal-gap unknowns are recorded under —
 * exported so tenants and downstream modules key policies/reports
 * identically (the epistemics module's BELIEF_SUBJECT_KIND precedent).
 */
export const GOAL_GAP_SUBJECT_KIND = 'goals.goal';

/** The epistemics module's note cap (MAX_NOTE_CHARS) — the derivation target bound. */
const MAX_UNKNOWN_NOTE_CHARS = 2048;
/** The missions module's caps the derived mission fields must respect. */
const MAX_MISSION_TITLE_CHARS = 200;
const MAX_MISSION_COMPLETION_CHARS = 4000;
const MAX_MISSION_RATIONALE_CHARS = 2000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** The fields of a candidate the derivations consume (row-mapped view). */
export interface DerivationCandidate {
  id: string;
  goalId: string;
  metricName: string | null;
  missingKnowledge: string;
  impactDescription: string;
  urgency: GapUrgency;
  informationValue: number;
  currentConfidence: number;
  requiredConfidence: number;
  evidenceObservationIds: string[];
  evidenceClaimIds: string[];
  acquisitionPaths: { kind: AcquisitionPathKind; id: string | null; label: string | null }[];
  materialityBasis: string;
  proposer: { kind: string; id: string | null; label: string | null };
}

/** The deterministic `recordUnknown` input for one candidate (W007 seam). */
export function deriveUnknownRecord(candidate: DerivationCandidate): {
  question: string;
  consequence: string;
  subject: { kind: string; id: string };
  relatedObservationIds: string[];
  relatedClaimIds: string[];
  note: string;
} {
  const note = truncate(
    `Unprompted goal-gap discovery ${candidate.id}: goal ${candidate.goalId}` +
      `${candidate.metricName === null ? '' : ` · metric ${candidate.metricName}`}; ` +
      `confidence gap ${formatValue(candidate.currentConfidence)} → ${formatValue(candidate.requiredConfidence)}; ` +
      `information value ${formatValue(candidate.informationValue)}; ` +
      `materiality: ${candidate.materialityBasis}.`,
    MAX_UNKNOWN_NOTE_CHARS,
  );
  return {
    // The gap statement is the unknown's question; the decision-impact
    // narrative is its consequence — an unknown without a consequence is
    // not consequential (lock 7).
    question: candidate.missingKnowledge,
    consequence: candidate.impactDescription,
    subject: { kind: GOAL_GAP_SUBJECT_KIND, id: candidate.goalId },
    relatedObservationIds: [...candidate.evidenceObservationIds],
    relatedClaimIds: [...candidate.evidenceClaimIds],
    note,
  };
}

// ---------------------------------------------------------------------------
// Mission derivation (candidate → the missions createMission input)
// ---------------------------------------------------------------------------

/** The policy-owned fields the mission derivation consumes. */
export interface MissionDerivationPolicy {
  investigationBudget: { amount: number; currency: string };
  rewardBudget: { amount: number; currency: string };
}

/** The deterministic `createMission` content for one candidate (W011 seam). */
export function deriveMissionDefinition(
  candidate: DerivationCandidate,
  goalTitle: string,
  policy: MissionDerivationPolicy,
): {
  title: string;
  knowledgeObjective: string;
  affectedGoals: { goalId: string; label: string }[];
  unknownIds: string[];
  informationValue: number;
  urgency: GapUrgency;
  currentConfidence: number;
  targetConfidence: number;
  investigationBudget: { amount: number; currency: string };
  rewardBudget: { amount: number; currency: string };
  candidateSources: { kind: AcquisitionPathKind; id: string | null; label: string | null }[];
  completionCriteria: string;
  rationale: string;
} {
  const title = truncate(
    `Goal gap · ${goalTitle}${candidate.metricName === null ? '' : ` · ${candidate.metricName}`}`,
    MAX_MISSION_TITLE_CHARS,
  );
  const completionCriteria = truncate(
    `Current confidence ${formatValue(candidate.currentConfidence)} in the missing knowledge must reach ${formatValue(candidate.requiredConfidence)}: ${candidate.missingKnowledge}`,
    MAX_MISSION_COMPLETION_CHARS,
  );
  const proposer =
    candidate.proposer.id !== null
      ? `${candidate.proposer.kind} ${candidate.proposer.id}`
      : `${candidate.proposer.kind} '${candidate.proposer.label ?? ''}'`;
  const rationale = truncate(
    `Unprompted goal-gap discovery ${candidate.id} for goal ${candidate.goalId} ` +
      `(${candidate.evidenceObservationIds.length} observations, ${candidate.evidenceClaimIds.length} claims; proposer ${proposer}); ` +
      `materiality: ${candidate.materialityBasis}.`,
    MAX_MISSION_RATIONALE_CHARS,
  );
  return {
    title,
    knowledgeObjective: candidate.missingKnowledge,
    affectedGoals: [{ goalId: candidate.goalId, label: goalTitle }],
    // unknownIds is appended by the service once the unknown exists.
    unknownIds: [],
    informationValue: candidate.informationValue,
    urgency: candidate.urgency,
    currentConfidence: candidate.currentConfidence,
    targetConfidence: candidate.requiredConfidence,
    investigationBudget: { ...policy.investigationBudget },
    rewardBudget: { ...policy.rewardBudget },
    // The ADR-0017 candidate acquisition paths flow into the mission's
    // candidate sources unchanged — the W012 planner's menu.
    candidateSources: candidate.acquisitionPaths.map((path) => ({ ...path })),
    completionCriteria,
    rationale,
  };
}

/** True when the materialization fields of a candidate view are complete. */
export function hasMaterialization(
  candidate: CandidateUnknown,
): candidate is CandidateUnknown & { materialization: CandidateMaterialization } {
  return candidate.materialization !== null;
}
