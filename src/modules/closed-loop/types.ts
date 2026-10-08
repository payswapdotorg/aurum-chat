// Public domain types of the closed-loop module (W140 — Unified
// Closed-Loop Learning).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md §W140):
// "Connect coverage/query, goal deviation, information strategy,
//  organization selection, execution outcomes and CompanyModel learning
//  into one longitudinal loop."
// Acceptance: "reality deviation and knowledge deviation remain distinct;
//  learning changes future ranking without silently overriding policy;
//  longitudinal evidence shows measurable improvement."
//
// A LoopCycle is ONE longitudinal turn of the unified loop around ONE
// subject goal (W008, validated ACTIVE at record time): the loop COMPARES
// what it expected (the current ranking's prediction) against what the
// world showed (execution outcomes, organization calibrations, goal
// metric readings) and against what it knew (coverage gaps, CompanyModel
// learning events), records the TWO deviation classes SEPARATELY, and —
// only through explicit, recorded, reviewable ranking signals — adjusts
// the ranking input channels that shape the NEXT cycle's prediction.
//
// THE DEVIATION DISTINCTION (acceptance clause 1, STRUCTURAL): a
// RealityDeviation is "the world differed from expectations" (evidence:
// agent-exchange execution runs W136, execution-fabric leases W137,
// org-lab calibration outcomes W135, goal metric readings W008) and a
// KnowledgeDeviation is "our knowledge was wrong or insufficient"
// (evidence: coverage gaps W125, CompanyModel learning events W053).
// They are distinct TypeScript interfaces with distinct source
// vocabularies, distinct input shapes, distinct storage tables and
// distinct read paths — never one union, never interchangeable, and the
// unit suite locks that neither input shape satisfies the other's
// validator. Conflating them would destroy the loop's honest semantics:
// a wrong world needs ACTING differently; a wrong map needs LEARNING
// differently (W128's frozen distinction).
//
// POLICY SAFETY (acceptance clause 2, STRUCTURAL): a RankingSignal is
// the ONLY learning-application primitive this module mints, and it is
// an ADVISORY, APPENDED, REVIEWABLE record addressed to one of the three
// ranking input channels (W134 info-strategy adjustments, W135 org-lab
// candidate ranking, W053 CompanyModel learned priors). Every signal
// read mints `authoritative: false` — there is no input field that could
// set it, no operation here touches any policy/settings surface, and a
// policy-shaped target is refused with a dedicated typed code
// (`policy_mutation_refused`). Policy stays authoritative exactly as in
// the learning module's W041/W053 precedents (ADR-0016 lock 14).
//
// MEASURABLE IMPROVEMENT (acceptance clause 3): closing a cycle freezes
// its longitudinal metrics — the prediction-vs-outcome calibration
// error, the knowledge gap-closure rate and the deviation recurrence
// against the previous closed cycle of the same goal — and the
// trajectory/summary reads carry the cycle-over-cycle series. The
// deterministic adjustment math (validation.ts's exported pure
// functions) is what makes "improvement" checkable: predictions adjust
// by applying recorded signals, and the service suite proves the error
// shrinks cycle-over-cycle when signals are applied and stays flat in a
// control loop where they are not.

/** The seams a REALITY deviation can cite (the world vs expectations). */
export type RealityDeviationSourceKind =
  | 'execution_run' // W136 agent-exchange run (frozen result/cost/status)
  | 'fabric_lease' // W137 execution-fabric lease (environment outcome)
  | 'org_calibration' // W135 org-lab recommendation, calibrated
  | 'goal_metric'; // W008 the loop goal's own metric reading

/** The seams a KNOWLEDGE deviation can cite (our knowledge was wrong/insufficient). */
export type KnowledgeDeviationSourceKind =
  | 'coverage_gap' // W125 material coverage gap
  | 'learning_update'; // W053 CompanyModel learning event

// ---------------------------------------------------------------------------
// Reality deviation — the world differed from expectations
// ---------------------------------------------------------------------------

/**
 * Input shape of one reality deviation. `expected`/`observed` are
 * normalized [0,1] scores (the loop's summary of the cited evidence's
 * expectation and outcome — the citation itself is gated readable on the
 * owning seam at record time).
 */
export interface RealityDeviationInput {
  sourceKind: RealityDeviationSourceKind;
  /**
   * The cited record's id on its owning seam: the execution-run id, the
   * fabric-lease id, the org-lab recommendation id, or — for
   * 'goal_metric' — THE LOOP GOAL'S OWN id (a goal-metric deviation
   * always measures the cycle's subject goal; validation enforces the
   * equality).
   */
  sourceRef: string;
  /** The W136 plan that owns the run (run lookups are plan-scoped). */
  planId?: string | null;
  /** The normalized expectation the world contradicted, in [0,1]. */
  expected: number;
  /** The normalized observed reality, in [0,1]. */
  observed: number;
  /** What differed (required, retained). */
  note: string;
}

/** One recorded reality deviation (append-only evidence). */
export interface RealityDeviation {
  id: string;
  tenantId: string;
  cycleId: string;
  sourceKind: RealityDeviationSourceKind;
  sourceRef: string;
  /** The plan reference for 'execution_run' citations, else null. */
  planRef: string | null;
  expected: number;
  observed: number;
  /** |observed − expected|, deterministic, 4 decimals. */
  magnitude: number;
  note: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Knowledge deviation — our knowledge was wrong or insufficient
// ---------------------------------------------------------------------------

/**
 * Input shape of one knowledge deviation. `severity` is the normalized
 * (0,1] insufficiency the loop assigns to the cited gap/learning event
 * (the citation itself is gated readable on the owning seam at record
 * time). There are deliberately NO expected/observed fields here: a
 * knowledge deviation is not a prediction failure — that is the reality
 * class. The two shapes are structurally distinct and test-locked as
 * non-interchangeable.
 */
export interface KnowledgeDeviationInput {
  sourceKind: KnowledgeDeviationSourceKind;
  /** The coverage-gap id, or the CompanyModel learning-update id. */
  sourceRef: string;
  /** The W125 snapshot the cited gap was detected by (gap citations). */
  snapshotId?: string | null;
  /** Normalized (0,1] severity of the knowledge insufficiency. */
  severity: number;
  /** What was missing or wrong (required, retained). */
  note: string;
}

/** One recorded knowledge deviation (append-only evidence). */
export interface KnowledgeDeviation {
  id: string;
  tenantId: string;
  cycleId: string;
  sourceKind: KnowledgeDeviationSourceKind;
  sourceRef: string;
  /** The snapshot reference for 'coverage_gap' citations, else null. */
  snapshotRef: string | null;
  severity: number;
  note: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// The loop cycle — the longitudinal record
// ---------------------------------------------------------------------------

export type LoopCycleStatus = 'open' | 'closed';

/** Input shape of `recordLoopCycle`. */
export interface RecordLoopCycleInput {
  /** The loop's subject goal (validated ACTIVE through the goals contract). */
  goalId: string;
  /**
   * The loop's prediction of goal outcome quality this cycle, [0,1] —
   * the current ranking's weighted expectation, BEFORE any of this
   * cycle's signals are applied (frozen at record time; the W054
   * prediction-hygiene discipline: predictions commit before
   * realization).
   */
  predictedScore: number;
  /** The world-vs-expectation evidence (may be empty — an honest cycle). */
  realityDeviations?: RealityDeviationInput[];
  /** The knowledge-vs-coverage evidence (may be empty — an honest cycle). */
  knowledgeDeviations?: KnowledgeDeviationInput[];
  /** Why this cycle was recorded (required, retained). */
  rationale: string;
}

/**
 * The longitudinal metrics frozen at close. `observedScore` is the
 * deterministic mean of the cycle's reality-deviation observed values
 * (null when the cycle recorded none — honestly unmeasured, never
 * defaulted); `calibrationError` is |predictedScore − observedScore|;
 * `gapClosureRate` and `deviationRecurrence` compare this cycle's
 * knowledge/reality source references against the PREVIOUS closed cycle
 * of the same goal (null when there was none or the previous cycle held
 * none of that class — absence stated, not defaulted).
 */
export interface LoopCycleMetrics {
  observedScore: number | null;
  calibrationError: number | null;
  /** 1 − (previous knowledge sources recurring this cycle / previous count). */
  gapClosureRate: number | null;
  /** This cycle's reality sources that already deviated last cycle / count. */
  deviationRecurrence: number | null;
  realityCount: number;
  knowledgeCount: number;
}

/** The deep view of one loop cycle (the longitudinal record). */
export interface LoopCycle {
  id: string;
  tenantId: string;
  goalId: string;
  /** The goal's current version at record time (snapshotted, W135 precedent). */
  goalVersion: number;
  /** 1-based, monotonic per (tenant, goal). */
  cycleNumber: number;
  status: LoopCycleStatus;
  predictedScore: number;
  /** The frozen metrics — null while the cycle is open. */
  metrics: LoopCycleMetrics | null;
  /** The world-vs-expectation evidence (reality deviations, own class). */
  realityDeviations: RealityDeviation[];
  /** The knowledge-vs-coverage evidence (knowledge deviations, own class). */
  knowledgeDeviations: KnowledgeDeviation[];
  /** The ranking signals recorded against this cycle (advisory, reviewable). */
  signals: RankingSignal[];
  rationale: string;
  recordedBy: string;
  recordedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  /** The retained close note (present once closed). */
  closeNote: string | null;
}

/** `listLoopCycles` summary row (deep-link with `getLoopCycle`). */
export interface LoopCycleSummary {
  id: string;
  tenantId: string;
  goalId: string;
  cycleNumber: number;
  status: LoopCycleStatus;
  predictedScore: number;
  /** The frozen calibration error (null while open). */
  calibrationError: number | null;
  realityCount: number;
  knowledgeCount: number;
  signalCount: number;
  recordedAt: string;
  closedAt: string | null;
}

/** Input shape of `closeLoopCycle`. */
export interface CloseLoopCycleInput {
  cycleId: string;
  /** Why the cycle is closing (required, retained). */
  note: string;
}

// ---------------------------------------------------------------------------
// Ranking signals — policy-safe learning applications
// ---------------------------------------------------------------------------

/** The ranking input channels a signal may address. */
export type RankingTargetSeam = 'info_strategy' | 'org_lab' | 'company_model';

/** Which way the signal moves the target's ranking weight. */
export type SignalDirection = 'raise' | 'lower';

/**
 * Which deviation class produced the signal — the distinction flows
 * through the whole loop (a reality-derived signal tunes the world
 * model; a knowledge-derived signal tunes the acquisition/coverage
 * effort).
 */
export type SignalBasis = 'reality_deviation' | 'knowledge_deviation';

/** Input shape of `applyRankingSignal`. */
export interface ApplyRankingSignalInput {
  /** The open cycle the signal is derived from (gated readable). */
  cycleId: string;
  targetSeam: RankingTargetSeam;
  /**
   * The target on the seam: the info-strategy id (W134, validated
   * goal-matched with the cycle's goal), the org-lab candidate id
   * (W135), or the CompanyModel subject key (W053, e.g. 'source:<uuid>').
   */
  targetRef: string;
  direction: SignalDirection;
  /** The normalized (0,1] adjustment magnitude. */
  magnitude: number;
  basis: SignalBasis;
  /** Why this signal (required — the reviewable learning rationale). */
  rationale: string;
}

/**
 * One recorded ranking signal — an explicit, reviewable learning
 * application. `authoritative` is ALWAYS false and minted by the
 * service: a signal advises future ranking through the target seam's
 * own input channel; explicit policy remains authoritative over every
 * learned signal (ADR-0016 lock 14; the learning module's identical
 * mint).
 */
export interface RankingSignal {
  id: string;
  tenantId: string;
  cycleId: string;
  targetSeam: RankingTargetSeam;
  targetRef: string;
  direction: SignalDirection;
  magnitude: number;
  basis: SignalBasis;
  rationale: string;
  /** Always false — minted, never caller-suppliable. */
  authoritative: false;
  recordedBy: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Longitudinal reads — the trajectory + the improvement summary
// ---------------------------------------------------------------------------

/** One closed cycle's frozen point on the trajectory. */
export interface LoopTrajectoryPoint {
  cycleNumber: number;
  predictedScore: number;
  observedScore: number | null;
  calibrationError: number | null;
  gapClosureRate: number | null;
  deviationRecurrence: number | null;
  signalCount: number;
  closedAt: string;
}

/** The cycle-over-cycle series of one goal's loop (closed cycles, ascending). */
export interface LoopTrajectory {
  tenantId: string;
  goalId: string;
  points: LoopTrajectoryPoint[];
  generatedAt: string;
}

/** The honest verdict over the trajectory's calibration errors. */
export type ImprovementVerdict =
  | 'improved'
  | 'flat'
  | 'degraded'
  | 'insufficient_evidence';

/** `summarizeLoopImprovement` — the longitudinal evidence rollup. */
export interface LoopImprovementSummary {
  tenantId: string;
  goalId: string;
  closedCycleCount: number;
  /** |pred−obs| of the FIRST closed cycle (null when unmeasured). */
  firstCalibrationError: number | null;
  /** |pred−obs| of the LAST closed cycle (null when unmeasured). */
  lastCalibrationError: number | null;
  /** first − last: positive means the error shrank. */
  calibrationDelta: number | null;
  gapClosureMean: number | null;
  recurrenceFirst: number | null;
  recurrenceLast: number | null;
  signalCount: number;
  verdict: ImprovementVerdict;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------

export interface GetLoopCycleQuery {
  cycleId: string;
}

/** Query shape of `listLoopCycles`. All filters AND-combined. */
export interface ListLoopCyclesQuery {
  goalId?: string;
  status?: LoopCycleStatus;
  /** 1..200, default 50. */
  limit?: number;
}

/** Query shape of `listRankingSignals`. All filters AND-combined. */
export interface ListRankingSignalsQuery {
  cycleId?: string;
  goalId?: string;
  targetSeam?: RankingTargetSeam;
  basis?: SignalBasis;
  /** 1..200, default 50. */
  limit?: number;
}

export interface GetLoopTrajectoryQuery {
  goalId: string;
}

export interface SummarizeLoopImprovementQuery {
  goalId: string;
}
