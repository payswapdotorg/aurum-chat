// Public domain types of the quality module (W055 — Aurum Quality
// Measurement).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W055):
// "Implement quality metrics: unknown-discovery precision/recall,
//  source-selection quality, mission resolution efficiency, evidence
//  quality, recommendation calibration, intervention success, realized
//  value, investigation cost and time-to-useful-understanding. Metrics are
//  tenant-aware, versioned and auditable and do not become business truth.
//  Dependencies: W013, W041, W051, W052, W054."
//
// WHAT THIS MODULE IS. The measurement layer of the learning moat: it
// computes, records and exposes QUALITY METRICS over the records the
// cognition stack already persists — attention discovery runs/candidates
// (W051), learning missions and their versions (W011), knowledge-acquisition
// plans/outcomes (W012), observations (W004) and learning outcomes with
// their frozen expected-versus-realized records (W040). The metric
// definitions implement the measurements LONGITUDINAL-BENCHMARK.md names
// (normative for W055/W056): consequential unknown discovery
// precision/recall; first-choice source quality and employee routing
// accuracy (this module's "source-selection quality"); mission completion
// time and cost; recommendation calibration; intervention realized value
// versus expected value — plus the work item's mission resolution
// efficiency, evidence quality, intervention success, investigation cost
// and time-to-useful-understanding.
//
// WHAT THIS MODULE IS NOT. Quality metrics are DERIVED INTELLIGENCE, never
// business truth (the briefings discipline, lock 34's analog): a snapshot
// is a recorded computation over evidence owned by other modules, and
// nothing in this module can mutate a mission, a plan, an outcome, an
// observation or any other module's state. There is deliberately no
// operation that feeds a metric back into ranking, priors or policy — the
// learning update path (W053/W054) is the ONLY channel from outcomes to
// future behavior (ADR-0019), and quality measurement deliberately stays
// outside it. Downstream consumers (W056's longitudinal benchmark, the
// management tower, briefings) may read snapshots for reporting and
// verification only.
//
// TWO RECORD CARRIERS, both append-only:
//
//   QualityJudgment — one ground-truth label an evaluator records about
//      Aurum's behavior: whether a discovered gap was a CONSEQUENTIAL
//      unknown ('unknown-consequentiality' — the labeled truth
//      precision/recall is computed against), or whether the source a plan
//      chose was the right one to ask ('source-selection' — the labeled
//      truth first-choice source quality and employee routing accuracy are
//      computed against). Judgments are evaluation evidence: they are
//      recorded through this contract with evaluator provenance, never
//      inferred silently, and never consumed by the ranked/prior paths.
//      Corrections are NEW judgments — computation resolves the latest per
//      target deterministically, so the audit trail is never rewritten.
//
//   QualitySnapshot — ONE explicit computation pass over a bounded
//      evaluation window: the requested metric families, computed from the
//      source records read through their module contracts plus the
//      tenant's judgments, persisted with the full input audit (what was
//      considered, what was truncated by the fetch bounds) and the metric
//      definition version that produced it. Snapshots are versioned
//      (METRIC_SCHEMA_VERSION — old snapshots stay comparable-with-care
//      when definitions evolve) and auditable (every number is
//      reconstructable from the recorded inputs + the versioned pure
//      functions in metrics.ts).
//
// Provider neutrality (lock 16): evaluators and computation actors are
// opaque references — kind + uuid id and/or human label — owned by their
// respective modules. The originating cognitive execution (W013) is the one
// validated cross-module link on a snapshot, checked readable through the
// cognition contract at write time (the sanctioned W013 dependency, the
// learning/attention precedent).

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The nine metric families of the work item, in canonical order. A
 * snapshot computes exactly the families its input requests; result rows
 * are stored and returned in this order.
 */
export type QualityMetricKind =
  | 'unknown-discovery' // precision/recall of unprompted unknown discovery
  | 'source-selection' // first-choice source quality + employee routing accuracy
  | 'mission-resolution-efficiency' // investigation steps per resolved mission
  | 'evidence-quality' // confidence/provenance profile of recorded evidence
  | 'recommendation-calibration' // predicted vs realized for recommendation outcomes
  | 'intervention-success' // met/exceeded/missed rate over settled outcomes
  | 'realized-value' // expected vs realized value over settled outcomes
  | 'investigation-cost' // committed investigation cost, by currency
  | 'time-to-useful-understanding'; // creation → resolution / first answer

/** The two ground-truth judgment kinds. */
export type JudgmentKind = 'unknown-consequentiality' | 'source-selection';

/** Ground truth about a discovered gap: was it a consequential unknown? */
export type UnknownConsequentialityVerdict = 'consequential' | 'not_consequential';

/** Ground truth about a plan's source choice: was it the right source? */
export type SourceSelectionVerdict = 'correct' | 'incorrect';

/** Kinds of parties that can record judgments and compute snapshots. */
export type QualityPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * A source whose bounded fetch feeds one snapshot. Listed in the snapshot's
 * input audit when the fetch returned exactly its cap — the recorded
 * numbers are then computed over a bounded prefix, which consumers must
 * know (auditable bounds, honest metrics).
 */
export type TruncatedSource =
  | 'discovery-runs'
  | 'acquisition-plans'
  | 'missions'
  | 'outcomes'
  | 'observations'
  | 'judgments';

// ---------------------------------------------------------------------------
// Shared reference shapes
// ---------------------------------------------------------------------------

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — the party recording a judgment or computing a snapshot
 * must be traceable (the missions actor rule).
 */
export interface QualityParty {
  kind: QualityPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `QualityParty`. */
export interface QualityPartyInput {
  kind: QualityPartyKind;
  id?: string | null;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Ground-truth judgments
// ---------------------------------------------------------------------------

/**
 * Input shape of `recordJudgment` for the 'unknown-consequentiality' kind.
 *
 * The judgment states ground truth about ONE gap — the attention module's
 * stable `gapKey` vocabulary (e.g. `<goalId>|driver|<metricName>`): whether
 * that gap was a consequential unknown. `candidateId` optionally deep-links
 * the specific discovery candidate being judged (validated readable
 * through the attention contract); a candidate-scoped judgment takes
 * precedence over gap-scoped ones when precision is computed for that
 * candidate. `windowFrom`/`windowTo` optionally bound WHEN the gap was
 * consequential; a judgment without them applies to every evaluation
 * window (an unqualified statement of fact).
 */
export interface UnknownConsequentialityInput {
  kind: 'unknown-consequentiality';
  /** Stable gap identity (the attention module's gapKey). 1..200 chars. */
  gapKey: string;
  /** Optional: the specific discovery candidate being judged. */
  candidateId?: string | null;
  /** Optional: when the gap was consequential (inclusive). */
  windowFrom?: string | null;
  /** Optional: when the gap stopped being consequential (inclusive). */
  windowTo?: string | null;
  verdict: UnknownConsequentialityVerdict;
  /** Who/what evaluated (audit trail). */
  evaluator: QualityPartyInput;
  /** Why — optional context. */
  note?: string | null;
}

/**
 * Input shape of `recordJudgment` for the 'source-selection' kind: whether
 * the source ONE recorded acquisition plan chose was the right one to
 * investigate. `planId` is validated readable through the
 * knowledge-acquisition contract (the plan carries the chosen candidate,
 * the persisted ranking rationale and the terminal outcome — this judgment
 * is the labeled truth about the CHOICE itself).
 */
export interface SourceSelectionJudgmentInput {
  kind: 'source-selection';
  planId: string;
  verdict: SourceSelectionVerdict;
  /** Who/what evaluated (audit trail). */
  evaluator: QualityPartyInput;
  /** Why — optional context. */
  note?: string | null;
}

/** Input shape of `recordJudgment` (discriminated union on `kind`). */
export type RecordJudgmentInput = UnknownConsequentialityInput | SourceSelectionJudgmentInput;

/** The persisted ground-truth judgment (union shape; kind constrains fields). */
export interface QualityJudgment {
  id: string;
  tenantId: string;
  kind: JudgmentKind;
  /** Present for 'unknown-consequentiality' (always) — null otherwise. */
  gapKey: string | null;
  /** Present when an 'unknown-consequentiality' judgment targets one candidate. */
  candidateId: string | null;
  /** Present for 'source-selection' (always) — null otherwise. */
  planId: string | null;
  /** The gap's consequentiality window ('unknown-consequentiality' only). */
  windowFrom: string | null;
  windowTo: string | null;
  /** 'consequential' | 'not_consequential' | 'correct' | 'incorrect' (kind-scoped). */
  verdict: string;
  evaluator: QualityParty;
  note: string | null;
  /** The authenticated TenantContext principal that recorded the judgment. */
  recordedByPrincipal: string;
  /** ISO 8601 — when the judgment was committed (service clock). */
  recordedAt: string;
}

/** Query shape of `getJudgment`. */
export interface GetJudgmentQuery {
  judgmentId: string;
}

/** Query shape of `listJudgments` (newest first). */
export interface ListJudgmentsQuery {
  kind?: JudgmentKind;
  /** Judgments about one gap. */
  gapKey?: string;
  /** Judgments about one acquisition plan. */
  planId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * The input audit of one snapshot — what the computation actually saw.
 * Every counter is recorded so each metric is reconstructable and every
 * bound is visible: `truncated` names the sources whose bounded fetch hit
 * its cap (the numbers were then computed over a bounded prefix).
 */
export interface QualitySnapshotInputs {
  /** Discovery runs listed (runs with ≥1 promoted candidate). */
  discoveryRunsConsidered: number;
  /** Promoted candidates inside those runs (pre-window-filter). */
  discoveryCandidatesConsidered: number;
  /** Selected acquisition plans fetched. */
  acquisitionPlansConsidered: number;
  /** Completed missions fetched. */
  missionsConsidered: number;
  /** Settled outcomes fetched. */
  outcomesConsidered: number;
  /** Observations fetched (readable to the computing principal). */
  observationsConsidered: number;
  /** Quality judgments read. */
  judgmentsConsidered: number;
  /** Sources whose fetch hit its cap — the recorded bounds. */
  truncated: TruncatedSource[];
}

/** Input shape of `computeQualitySnapshot`. */
export interface ComputeQualitySnapshotInput {
  /** Inclusive lower bound of the evaluation window (strict ISO 8601). */
  windowFrom: string;
  /** Inclusive upper bound of the evaluation window (strict ISO 8601). */
  windowTo: string;
  /** Which metric families to compute; non-empty subset of the nine. */
  metricKinds: QualityMetricKind[];
  /**
   * The cognitive execution (W013) this evaluation belongs to — the loop
   * linkage, validated readable through the cognition contract at write
   * time. Optional.
   */
  originExecutionId?: string | null;
  /** Who/what is computing (audit trail). */
  actor: QualityPartyInput;
  /** Why — optional, recorded on the snapshot. */
  rationale?: string | null;
}

// ---------------------------------------------------------------------------
// Metric payloads (one per family; discriminated by metricKind)
// ---------------------------------------------------------------------------

/**
 * Unknown-discovery precision/recall (benchmark measurement 1). Precision
 * is per-discovery: of the candidates promoted to unknowns+missions in the
 * window that ground truth judged, the share judged consequential. Recall
 * is per-gap: of the gapKeys ground truth marks consequential for the
 * window, the share Aurum promoted. Null when the denominator is zero —
 * absence of evidence is recorded as absence, never as zero.
 */
export interface UnknownDiscoveryPayload {
  /** Promoted candidates recorded in the window. */
  promotedInWindow: number;
  /** Promoted candidates a judgment resolved (candidate- or gap-scoped). */
  judgedPromoted: number;
  /** Promoted candidates no judgment resolved. */
  unjudgedPromoted: number;
  /** Promoted candidates judged consequential (precision numerator). */
  truePositives: number;
  /** Promoted candidates judged not consequential. */
  falsePositives: number;
  /** Distinct gapKeys ground truth marks consequential for the window. */
  groundTruthConsequential: number;
  /** Of those, gapKeys with at least one promoted candidate in the window. */
  discoveredConsequential: number;
  /** Ground-truth consequential gapKeys never promoted in the window. */
  missedConsequential: number;
  /** truePositives / (truePositives + falsePositives); null when judgedPromoted = 0. */
  precision: number | null;
  /** discoveredConsequential / groundTruthConsequential; null when ground truth is empty. */
  recall: number | null;
}

/**
 * Source-selection quality (benchmark measurements 3 and 4). A mission's
 * FIRST-CHOICE plan is its earliest selected acquisition plan (lock 17's
 * "next best action" — the first one is the routing decision under
 * test). Objective sub-metrics come from the plans' terminal outcomes;
 * labeled sub-metrics come from 'source-selection' judgments. Employee
 * routing accuracy is the labeled rate restricted to 'ask-person'
 * selections.
 */
export interface SourceSelectionPayload {
  /** First-choice plans recorded in the window. */
  firstChoiceTotal: number;
  /** First-choice plans with a terminal outcome recorded. */
  firstChoiceResolved: number;
  /** First-choice plans whose outcome was 'answered'. */
  firstChoiceAnswered: number;
  /** firstChoiceAnswered / firstChoiceResolved; null when firstChoiceResolved = 0. */
  firstChoiceAnswerRate: number | null;
  /** First-choice plans a judgment resolved. */
  judgedFirstChoice: number;
  /** First-choice plans judged 'correct'. */
  correctFirstChoice: number;
  /** correctFirstChoice / judgedFirstChoice; null when judgedFirstChoice = 0. */
  firstChoiceQualityRate: number | null;
  /** First-choice 'ask-person' plans recorded in the window. */
  employeeFirstChoice: number;
  /** First-choice 'ask-person' plans a judgment resolved. */
  employeeJudged: number;
  /** First-choice 'ask-person' plans judged 'correct'. */
  employeeCorrect: number;
  /** employeeCorrect / employeeJudged; null when employeeJudged = 0. */
  employeeRoutingAccuracy: number | null;
}

/**
 * Mission resolution efficiency (benchmark measurement 2: median
 * investigation steps per resolved mission). One step = one selected
 * acquisition plan; the count is over the plans the snapshot's bounded
 * fetch considered. Null when no missions resolved in the window.
 */
export interface MissionResolutionEfficiencyPayload {
  /** Missions completed in the window. */
  resolvedMissions: number;
  /** Resolved missions with zero considered steps (resolved without investigation). */
  missionsWithoutSteps: number;
  /** Median selected-plan count per resolved mission; null when none. */
  medianSteps: number | null;
  /** Mean selected-plan count per resolved mission; null when none. */
  meanSteps: number | null;
}

/**
 * Evidence quality (benchmark measurement 9's evidence half): the
 * descriptive confidence/provenance profile of the evidence recorded in
 * the window. Deliberately descriptive, not normative — no threshold
 * decides "good" here; consumers interpret. Null when no observations.
 */
export interface EvidenceQualityPayload {
  /** Observations readable to the computing principal, observed in the window. */
  observations: number;
  /** Mean recorded confidence value; null when none. */
  meanConfidence: number | null;
  minConfidence: number | null;
  maxConfidence: number | null;
  /** Share of observations with at least one extraction-lineage parent. */
  shareWithLineage: number | null;
  /** Share of observations whose confidence states a basis. */
  shareWithConfidenceBasis: number | null;
}

/**
 * Recommendation calibration (benchmark measurement 6) over the settled
 * outcomes of 'recommendation' subjects in the window. The prediction is
 * the outcome's FROZEN expected value (W040: expectations cannot be
 * rewritten — that is what makes calibration measurable); the sign flips
 * with the metric direction so positive bias always means "better than
 * predicted".
 */
export interface RecommendationCalibrationPayload {
  /** Settled recommendation outcomes in the window. */
  settledRecommendations: number;
  met: number;
  exceeded: number;
  missed: number;
  /** Mean signed prediction error ((realized − expected) × direction sign). */
  predictionBiasMean: number | null;
  /** Mean absolute prediction error (|realized − expected|, metric units). */
  predictionErrorMean: number | null;
  /** (met + exceeded) / settledRecommendations; null when none. */
  metOrExceededRate: number | null;
}

/**
 * Intervention success (ADR-0019's assessment, benchmark measurement 7's
 * success half) over ALL settled outcomes in the window — the frozen
 * met/exceeded/missed verdicts W040 settles, rolled up overall and per
 * subject kind. Null success rates when a bucket is empty.
 */
export interface InterventionSuccessBucket {
  settled: number;
  met: number;
  exceeded: number;
  missed: number;
  /** (met + exceeded) / settled; null when settled = 0. */
  successRate: number | null;
}

/** Realized value (benchmark measurement 7) over settled outcomes. */
export interface RealizedValueBucket {
  settled: number;
  /** Σ expected over settled outcomes (metric units — see the caveat below). */
  expectedValueSum: number;
  /** Σ realized over settled outcomes. */
  realizedValueSum: number;
  /** Σ (realized − expected). */
  netVarianceSum: number;
  /** Σ (realized − baseline) × direction sign — improvement delivered. */
  improvementSum: number;
}

/**
 * Intervention success payload: the overall bucket plus one per outcome
 * subject kind (recommendation / agent / extension / mission).
 */
export interface InterventionSuccessPayload extends InterventionSuccessBucket {
  bySubjectKind: Partial<
    Record<'recommendation' | 'agent' | 'extension' | 'mission', InterventionSuccessBucket>
  >;
}

/** Realized-value payload: overall plus per outcome subject kind. */
export interface RealizedValuePayload extends RealizedValueBucket {
  /**
   * Sums are arithmetic over metric values in mixed units — the learning
   * module's own rollup caveat applies: comparing across metrics is the
   * consumer's interpretation, never this module's assertion.
   */
  bySubjectKind: Partial<
    Record<'recommendation' | 'agent' | 'extension' | 'mission', RealizedValueBucket>
  >;
}

/**
 * One currency-denominated cost bucket (money is integer minor units +
 * ISO currency — never summed across currencies).
 */
export interface CostByCurrency {
  currency: string;
  /** Selected plans considered (window bucket); absent on per-mission buckets. */
  plans?: number;
  /** Resolved missions (per-mission bucket); absent on window buckets. */
  missions?: number;
  /** Σ estimated cost (minor units). */
  totalCost: number;
  /** Median cost per resolved mission; null when no missions. */
  medianCost?: number | null;
  /** Mean cost per resolved mission; null when no missions. */
  meanCost?: number | null;
}

/**
 * Investigation cost (benchmark measurement 5's cost half). Window cost =
 * estimated cost committed by selected plans recorded in the window,
 * grouped by the mission budget currency. Per-mission cost = the
 * all-steps cost of missions completed in the window (missions that
 * resolved without any considered plan cost zero and are counted).
 */
export interface InvestigationCostPayload {
  /** Selected plans recorded in the window. */
  windowPlans: number;
  /** Window-committed cost by currency. */
  windowCostByCurrency: CostByCurrency[];
  /** Missions completed in the window. */
  resolvedMissions: number;
  /** Resolved missions with zero considered plans. */
  missionsWithoutPlans: number;
  /** Per-resolved-mission cost by currency. */
  costPerResolvedMissionByCurrency: CostByCurrency[];
}

/**
 * Time-to-useful-understanding (benchmark measurement 5's time half).
 * Resolution time: mission creation → the 'completed' version's commit
 * time. First-answer time: creation → the earliest 'answered' acquisition
 * outcome of the mission's considered plans. Hours, rounded to 6
 * decimals; null when the respective set is empty.
 */
export interface TimeToUsefulUnderstandingPayload {
  resolvedMissions: number;
  medianResolutionHours: number | null;
  meanResolutionHours: number | null;
  /** Resolved missions with at least one considered 'answered' plan. */
  missionsWithFirstAnswer: number;
  medianTimeToFirstAnswerHours: number | null;
  meanTimeToFirstAnswerHours: number | null;
}

/** The union of all metric payloads, discriminated by metric kind. */
export type QualityMetricPayload =
  | ({ metricKind: 'unknown-discovery' } & UnknownDiscoveryPayload)
  | ({ metricKind: 'source-selection' } & SourceSelectionPayload)
  | ({ metricKind: 'mission-resolution-efficiency' } & MissionResolutionEfficiencyPayload)
  | ({ metricKind: 'evidence-quality' } & EvidenceQualityPayload)
  | ({ metricKind: 'recommendation-calibration' } & RecommendationCalibrationPayload)
  | ({ metricKind: 'intervention-success' } & InterventionSuccessPayload)
  | ({ metricKind: 'realized-value' } & RealizedValuePayload)
  | ({ metricKind: 'investigation-cost' } & InvestigationCostPayload)
  | ({ metricKind: 'time-to-useful-understanding' } & TimeToUsefulUnderstandingPayload);

// ---------------------------------------------------------------------------
// Snapshot read models
// ---------------------------------------------------------------------------

/** One computed metric result row of a snapshot. */
export interface QualityMetricResult {
  metricKind: QualityMetricKind;
  payload: Omit<QualityMetricPayload, 'metricKind'>;
}

/**
 * The current view of one quality snapshot: the window, the requested
 * metric families, the metric definition version, the input audit, the
 * computed results (canonical order), the actor and provenance. Read-only
 * derived intelligence — never business truth.
 */
export interface QualitySnapshot {
  id: string;
  tenantId: string;
  windowFrom: string;
  windowTo: string;
  metricKinds: QualityMetricKind[];
  /** METRIC_SCHEMA_VERSION at compute time (metrics are versioned). */
  metricVersion: number;
  inputs: QualitySnapshotInputs;
  results: QualityMetricResult[];
  originExecutionId: string | null;
  actor: QualityParty;
  /** The authenticated TenantContext principal that computed the snapshot. */
  computedByPrincipal: string;
  rationale: string | null;
  /** ISO 8601 — when the snapshot was committed (service clock). */
  recordedAt: string;
}

/** Query shape of `getQualitySnapshot`. */
export interface GetQualitySnapshotQuery {
  snapshotId: string;
}

/** Query shape of `listQualitySnapshots` (newest first). */
export interface ListQualitySnapshotsQuery {
  /** Snapshots whose metric families include this one. */
  metricKind?: QualityMetricKind;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * One snapshot of `listQualitySnapshots` — the snapshot without the
 * embedded results (deep-link with `getQualitySnapshot`).
 */
export type QualitySnapshotSummary = Omit<QualitySnapshot, 'results'>;
