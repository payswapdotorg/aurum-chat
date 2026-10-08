// ============================================================================
// closed-loop — the ONLY public surface of the closed-loop module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W140 — Unified Closed-Loop Learning (spec/work-items/
// WORK-ITEM-CATALOG.md §W140):
// "Connect coverage/query, goal deviation, information strategy,
//  organization selection, execution outcomes and CompanyModel learning
//  into one longitudinal loop."
//
//   THE LONGITUDINAL LOOP RECORD:
//   recordLoopCycle — append ONE loop cycle around a subject goal
//      (validated ACTIVE through the goals contract, current version
//      snapshotted): the loop's frozen prediction for the cycle plus
//      the TWO deviation classes, each citing REAL evidence gated
//      readable on its owning seam's contract BEFORE the mutation
//      transaction (the W134 law):
//        · reality deviations — the world differed from expectations
//          (agent-exchange execution runs W136, execution-fabric leases
//          W137, org-lab calibrated recommendations W135, the goal's
//          own metric readings W008);
//        · knowledge deviations — our knowledge was wrong or
//          insufficient (coverage gaps W125 snapshot-scoped, CompanyModel
//          learning updates W053).
//      Cycle numbers are 1-based, monotonic per (tenant, goal); the
//      spine is append-and-close (identity immutable from creation).
//   closeLoopCycle — the one-way open → closed transition: freezes the
//      longitudinal metrics (the deterministic observed score, the
//      prediction-vs-outcome calibration error, the knowledge
//      gap-closure rate and the reality-deviation recurrence against
//      the previous closed cycle of the same goal) under a FOR UPDATE
//      staleness re-check. Terminal.
//
//   THE POLICY-SAFE LEARNING APPLICATIONS:
//   applyRankingSignal — append ONE advisory, reviewable ranking signal
//      derived from an OPEN cycle, addressed to one of the three ranking
//      input channels: the W134 info-strategy (validated readable AND
//      goal-matched with the cycle's goal), the W135 org-lab candidate
//      ranking (validated readable), or the W053 CompanyModel subject
//      key (validated through the learning contract's own vocabulary
//      guard). Every signal mints `authoritative: false` — there is no
//      input field that could set it; learning changes FUTURE ranking
//      through these recorded signals and never silently overrides
//      policy. A policy/settings/authority-shaped target is refused
//      with the dedicated typed code `policy_mutation_refused`
//      (test-locked). No operation on this surface touches any other
//      module's state — every cross-module import is a read.
//
//   THE LONGITUDINAL EVIDENCE:
//   getLoopCycle — the deep view (spine + both deviation classes +
//      signals + frozen metrics).
//   listLoopCycles — current summaries (goal, status filters), newest
//      first.
//   listRankingSignals — the review surface (cycle, goal, target seam,
//      deviation-basis filters), newest first.
//   getLoopTrajectory — the closed cycles' frozen metric series for one
//      goal, ascending (the cycle-over-cycle longitudinal evidence).
//   summarizeLoopImprovement — the honest rollup: first/last calibration
//      error, the delta, the mean gap-closure, recurrence trend, the
//      signal count, and the deterministic verdict ('improved' only
//      when the last measured error is strictly smaller than the first;
//      unmeasured trajectories are 'insufficient_evidence', never a
//      fabricated improvement).
//
// THE DEVIATION DISTINCTION (acceptance clause 1): the two classes are
// distinct types, distinct input shapes (each validator rejects the
// other class's fields), distinct storage tables and distinct read
// paths — never conflated, never interchangeable.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's cycles,
// deviations and signals are indistinguishable from missing ones
// (`cycle_not_found` — no existence leak). Cited evidence of a foreign
// tenant is uniformly its seam's mapped not-found code.
//
// Cross-module reads: goals (W008), agent-exchange (W136),
// execution-fabric (W137), coverage (W125), learning (W053),
// info-strategy (W134), org-lab (W135) — all through their public
// contracts, all READ-ONLY. Error propagation policy: see errors.ts.
// ============================================================================

export {
  // The longitudinal loop record
  recordLoopCycle,
  closeLoopCycle,
  // The policy-safe learning applications
  applyRankingSignal,
  // The longitudinal evidence
  getLoopCycle,
  listLoopCycles,
  listRankingSignals,
  getLoopTrajectory,
  summarizeLoopImprovement,
} from './service';

export { ClosedLoopError } from './errors';
export type { ClosedLoopErrorCode } from './errors';

// Guards + vocabularies + limits (pure; unit-testable without a database).
export {
  DEFAULT_LIST_LIMIT,
  KNOWLEDGE_DEVIATION_SOURCE_KINDS,
  LOOP_CYCLE_STATUSES,
  MAX_DEVIATIONS_PER_CLASS,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_REF_LENGTH,
  POLICY_SURFACE_WORDS,
  RANKING_TARGET_SEAMS,
  REALITY_DEVIATION_SOURCE_KINDS,
  SCORE_DECIMALS,
  SIGNAL_BASES,
  SIGNAL_DIRECTIONS,
  SIGNAL_STEP,
  assertClosedLoopTenantContext,
  isCompanyModelSubjectKey,
  isKnowledgeDeviationSourceKind,
  isLoopCycleStatus,
  isPolicySurfaceWord,
  isRankingTargetSeam,
  isRealityDeviationSourceKind,
  isSignalBasis,
  isSignalDirection,
  isUuid,
} from './validation';

// The deterministic loop math (the single definition of how recorded
// signals adjust future ranking and how the longitudinal metrics are
// derived — pure, exported for verification; the service consumes,
// never re-derives; the outcomes/learning discipline).
export {
  applyRankingSignals,
  calibrationErrorOf,
  deriveSignalDirection,
  deriveSignalMagnitude,
  deviationRecurrenceOf,
  gapClosureRateOf,
  improvementVerdictOf,
  magnitudeOf,
  observedScoreOf,
  round4,
} from './validation';

export type {
  ValidatedApplyRankingSignalInput,
  ValidatedCloseLoopCycleInput,
  ValidatedGetLoopCycleQuery,
  ValidatedGetLoopTrajectoryQuery,
  ValidatedKnowledgeDeviation,
  ValidatedListLoopCyclesQuery,
  ValidatedListRankingSignalsQuery,
  ValidatedRealityDeviation,
  ValidatedRecordLoopCycleInput,
  ValidatedSummarizeLoopImprovementQuery,
} from './validation';

export type {
  ApplyRankingSignalInput,
  CloseLoopCycleInput,
  GetLoopCycleQuery,
  GetLoopTrajectoryQuery,
  ImprovementVerdict,
  KnowledgeDeviation,
  KnowledgeDeviationInput,
  KnowledgeDeviationSourceKind,
  ListLoopCyclesQuery,
  ListRankingSignalsQuery,
  LoopCycle,
  LoopCycleMetrics,
  LoopCycleStatus,
  LoopCycleSummary,
  LoopImprovementSummary,
  LoopTrajectory,
  LoopTrajectoryPoint,
  RankingSignal,
  RankingTargetSeam,
  RealityDeviation,
  RealityDeviationInput,
  RealityDeviationSourceKind,
  RecordLoopCycleInput,
  SignalBasis,
  SignalDirection,
  SummarizeLoopImprovementQuery,
} from './types';
