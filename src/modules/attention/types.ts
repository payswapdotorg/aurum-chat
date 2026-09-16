// Public domain types of the attention module (W051 — Unprompted Unknown
// Discovery).
//
// A CandidateUnknown is a MATERIAL goal/evidence gap discovered WITHOUT a
// user question (ADR-0017): "Aurum derives consequential unknowns from
// active goals, desired state, temporal state and evidence without
// requiring management to state the exact question." It is the frozen
// module map's L2 `attention` concept — the unprompted attention
// allocation between goals (W008) and missions (W011): what the company's
// CURRENT direction makes worth knowing that the evidence does not yet
// answer.
//
// Per ADR-0017 a candidate unknown carries:
//   * affected goals/decisions   — the active goal (and optional metric)
//                                   the gap hangs off, validated readable
//                                   through the goals contract;
//   * missing knowledge          — the knowledge that is missing (the
//                                   future unknown's question — a DERIVED
//                                   gap statement, never an operator
//                                   question);
//   * evidence basis             — the observations (and optional claims)
//                                   the gap was derived from, validated
//                                   readable in this tenant;
//   * decision impact            — how much the gap affects decisions
//                                   (a [0, 1] score plus the narrative the
//                                   future unknown carries as its
//                                   consequence);
//   * urgency                    — critical | high | medium | low;
//   * confidence gap             — current confidence vs the confidence
//                                   decisions require (required > current,
//                                   or there is no gap at all);
//   * expected information value — a [0, 1] score;
//   * candidate acquisition paths — the sources/people/systems the future
//                                   mission offers the W012 planner.
//
// Unknown discovery is never an LLM assertion (ADR-0017): the evaluator —
// which MAY be an LLM-driven stage of the loop — PROPOSES the gap
// analysis; the application (this module) validates the goal, the
// evidence and the input shape, evaluates MATERIALLY deterministically
// against the tenant's DiscoveryPolicy, and only then records anything.
// The proposer is recorded on every candidate for auditability.
//
// Mission creation is application-owned, policy-gated and auditable
// (ADR-0017): only MATERIALIZED candidates — ones the deterministic
// materiality gate passed — may become LearningMissions, and they do so
// through this module (epistemics unknown + missions mission, both
// created through their public contracts and linked back on the
// candidate). Every candidate is reconstructable end to end: which goal,
// which evidence, which decision impact produced it, which policy
// thresholds decided it, and which unknown/mission it became.

/** Lifecycle of a candidate unknown — all states but 'material' are terminal. */
export type CandidateUnknownStatus =
  /** Below the tenant's materiality thresholds — never becomes a mission. Terminal. */
  | 'immaterial'
  /** Passed the materiality gate; waiting for (auto) or available for (manual) materialization. */
  | 'material'
  /** Materialized: the epistemic unknown exists and the LearningMission is launched. Terminal. */
  | 'materialized';

/**
 * How the tenant's discovery policy releases material candidates into
 * missions (ADR-0017's "policy-gated" mission creation):
 *  * 'auto'   — discovery materializes material candidates in the same
 *               call (the unprompted, continuous capability the ADR
 *               requires);
 *  * 'manual' — discovery records the material candidate only; an
 *               explicit `materializeCandidate` call launches the
 *               mission (human/worker-paced gating).
 */
export type MissionPolicyMode = 'auto' | 'manual';

/** Urgency of the missing knowledge (mirrors the missions module's vocabulary). */
export type GapUrgency = 'critical' | 'high' | 'medium' | 'low';

/**
 * Kinds of candidate acquisition paths (ADR-0017 "candidate acquisition
 * paths" = §6/§7's acquisition menu the W012 planner chooses among).
 * Mirrors the missions module's candidate-source vocabulary so a
 * materialized candidate's paths flow into `createMission` unchanged.
 */
export type AcquisitionPathKind =
  | 'person'
  | 'system'
  | 'document'
  | 'external'
  | 'agent'
  | 'analysis';

/** Kinds of parties that may propose a goal-gap evaluation. */
export type GapProposerKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * One candidate acquisition path: a provider-neutral kind plus an opaque
 * uuid `id` and/or a human-readable `label` (at least one — a candidate
 * path must be traceable). Deliberately unverified here: the W012
 * planner validates routes when it drives acquisition (the missions
 * module's candidate-source precedent).
 */
export interface AcquisitionPath {
  kind: AcquisitionPathKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `AcquisitionPath`. */
export interface AcquisitionPathInput {
  kind: AcquisitionPathKind;
  id?: string | null;
  label?: string | null;
}

/**
 * Who/what proposed the gap evaluation (ADR-0017: "the LLM may propose,
 * the application decides"): an opaque uuid `id` owned by the respective
 * module and/or a human-readable `label`. At least one must be present —
 * proposals must be traceable to their source.
 */
export interface GapProposer {
  kind: GapProposerKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `GapProposer`. */
export interface GapProposerInput {
  kind: GapProposerKind;
  id?: string | null;
  label?: string | null;
}

/** A mission budget: integer minor units + ISO currency code (§8 convention). */
export interface DiscoveryBudget {
  amount: number;
  currency: string;
}

/** Input shape of `DiscoveryBudget`. */
export interface DiscoveryBudgetInput {
  amount: number;
  currency: string;
}

/**
 * The deterministic materiality policy — THE policy gate on mission
 * creation (ADR-0017: "Only material unknowns (sufficient decision impact
 * and information value) may become LearningMissions, through the policy
 * gate"). A candidate is material iff
 * `decisionImpact >= minDecisionImpact && informationValue >= minInformationValue`
 * (inclusive — "sufficient"). A management control like the actions
 * module's authority policies (updatable, not evidence; the DECISIONS it
 * produced are snapshotted immutably on every candidate).
 */
export interface DiscoveryPolicy {
  /** Minimum sufficient decision impact, [0, 1]. */
  minDecisionImpact: number;
  /** Minimum sufficient information value, [0, 1]. */
  minInformationValue: number;
  missionPolicy: MissionPolicyMode;
  /** What a discovery-launched mission may spend (minor units + currency). */
  investigationBudget: DiscoveryBudget;
  /** What a discovery-launched mission may reward (minor units + currency). */
  rewardBudget: DiscoveryBudget;
  /**
   * ISO 8601 — when the tenant row was last set; null when this is the
   * built-in default (no tenant row exists yet).
   */
  updatedAt: string | null;
  /** The principal that last set the tenant row; null for the built-in default. */
  updatedBy: string | null;
}

/** Input shape of `setDiscoveryPolicy` (full replacement of the tenant row). */
export interface SetDiscoveryPolicyInput {
  minDecisionImpact: number;
  minInformationValue: number;
  missionPolicy: MissionPolicyMode;
  investigationBudget: DiscoveryBudgetInput;
  rewardBudget: DiscoveryBudgetInput;
}

/** Output shape of `getDiscoveryPolicy`. */
export interface EffectiveDiscoveryPolicy extends DiscoveryPolicy {
  /** Whether the values come from the tenant row or the built-in default. */
  source: 'tenant' | 'built-in';
}

// ---------------------------------------------------------------------------
// Goal-gap discovery (the unprompted capability — no user question exists
// anywhere in this input: goal + evidence evaluation only)
// ---------------------------------------------------------------------------

/**
 * Input shape of `discoverGoalGap` — one goal-gap evaluation. Everything
 * here is PROPOSAL content (the bounded-reasoning seam): the application
 * validates the goal (active, metric-scoped), the evidence (readable in
 * this tenant), the shapes and the confidence-gap rule, then decides
 * materiality deterministically — never the proposer.
 */
export interface DiscoverGoalGapInput {
  /** The active goal the gap hangs off (validated through the goals contract). */
  goalId: string;
  /**
   * The specific goal metric the gap concerns, when the gap is
   * metric-scoped; must match one of the goal's current metric names.
   * Null = the goal as a whole.
   */
  metricName?: string | null;
  /** The missing knowledge — the future unknown's question (a derived gap statement). */
  missingKnowledge: string;
  /**
   * The decision-impact narrative — why the gap matters. Becomes the
   * future unknown's CONSEQUENCE (an unknown without a consequence is
   * not consequential, lock 7).
   */
  impactDescription: string;
  /** Decision-impact score, [0, 1]. */
  decisionImpact: number;
  /** Expected information value, [0, 1]. */
  informationValue: number;
  urgency: GapUrgency;
  /** Current confidence in the answer, [0, 1]. */
  currentConfidence: number;
  /** The confidence decisions require, [0, 1]; MUST exceed currentConfidence. */
  requiredConfidence: number;
  /**
   * The evidence basis: observations the gap was derived from
   * (1..16 — discovery is evidence-linked; a gap derived from nothing is
   * not discoverable knowledge).
   */
  evidenceObservationIds: string[];
  /** Additional claims in the evidence basis (0..16). */
  evidenceClaimIds?: string[];
  /** Candidate acquisition paths the future mission offers the planner (0..16). */
  acquisitionPaths?: AcquisitionPathInput[];
  /** Who/what proposed this evaluation — traceability (ADR-0017's propose/decide split). */
  proposer: GapProposerInput;
  /**
   * The cognitive execution (W013) whose goal evaluation produced this
   * discovery, when one is running — links the discovery into the loop's
   * trace (§24). Optional: discovery is a continuous capability, not only
   * a loop stage.
   */
  executionId?: string | null;
  /** Free-text proposer note (recorded verbatim, auditable). */
  proposerNote?: string | null;
}

/** The deterministic materiality verdict — reconstructable (§24). */
export interface MaterialityDecision {
  /** 'material' | 'immaterial'. */
  decision: 'material' | 'immaterial';
  /** True iff decision === 'material'. */
  material: boolean;
  /**
   * Deterministic reconstruction of WHY: the compared values and the
   * thresholds that decided. Stored on the candidate row.
   */
  basis: string;
}

/** What a materialized candidate produced (present once status = 'materialized'). */
export interface CandidateMaterialization {
  /** The epistemic unknown (W007) recorded from the gap. */
  unknownId: string;
  /** The LearningMission (W011) launched through the policy gate. */
  missionId: string;
  /** ISO 8601 — when the application materialized the candidate. */
  materializedAt: string;
  /** The authenticated principal that committed the materialization. */
  materializedBy: string;
}

/** One recorded candidate unknown — the auditable discovery artifact. */
export interface CandidateUnknown {
  id: string;
  tenantId: string;
  goalId: string;
  metricName: string | null;
  missingKnowledge: string;
  impactDescription: string;
  decisionImpact: number;
  informationValue: number;
  urgency: GapUrgency;
  currentConfidence: number;
  requiredConfidence: number;
  /** Derived: requiredConfidence - currentConfidence (always > 0). */
  confidenceGap: number;
  evidenceObservationIds: string[];
  evidenceClaimIds: string[];
  acquisitionPaths: AcquisitionPath[];
  proposer: GapProposer;
  proposerNote: string | null;
  executionId: string | null;
  status: CandidateUnknownStatus;
  /**
   * The deterministic verdict plus the policy thresholds that produced it
   * (snapshotted at decision time — reconstructable even if the policy
   * changes afterwards).
   */
  materiality: MaterialityDecision & {
    minDecisionImpact: number;
    minInformationValue: number;
  };
  /** The authenticated principal that recorded the discovery. */
  recordedByPrincipal: string;
  /** ISO 8601 — when the discovery was recorded (service clock). */
  recordedAt: string;
  /** Present once status = 'materialized'. */
  materialization: CandidateMaterialization | null;
}

/** Input shape of `materializeCandidate`. */
export interface MaterializeCandidateInput {
  candidateId: string;
}

/** Query shape of `getCandidateUnknown`. */
export interface GetCandidateUnknownQuery {
  candidateId: string;
}

/** Query shape of `listCandidateUnknowns`. */
export interface ListCandidateUnknownsQuery {
  status?: CandidateUnknownStatus;
  goalId?: string;
  urgency?: GapUrgency;
  /** Requires `proposerKind` (an id is meaningless without its kind). */
  proposerKind?: GapProposerKind;
  /** Requires `proposerKind`. */
  proposerId?: string;
  /** All discoveries linked to one cognitive execution (trace reconstruction). */
  executionId?: string;
  /** Case-insensitive substring on missingKnowledge. */
  search?: string;
  /** 1..500, default 100. */
  limit?: number;
}
