// ============================================================================
// quality — the ONLY public surface of the quality module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W055 — Aurum Quality Measurement:
// "Implement quality metrics: unknown-discovery precision/recall,
//  source-selection quality, mission resolution efficiency, evidence
//  quality, recommendation calibration, intervention success, realized
//  value, investigation cost and time-to-useful-understanding. Metrics are
//  tenant-aware, versioned and auditable and do not become business truth.
//  Dependencies: W013, W041, W051, W052, W054."
//
// MODULE PLACEMENT: `quality` is the measurement layer the W055 work order
// assigns this implementation to own (the work order's "Modules you OWN
// (create/extend): quality"). It sits beside the learning layer's modules
// in the frozen map's spirit (L5 learning/rewards is where the moat's
// measurement belongs) and touches NOTHING but contracts: attention (W051
// discovery candidates — precision/recall), knowledge-acquisition (W012
// plans/outcomes — source selection, steps, cost, first answers), missions
// (W011 completed missions — resolution efficiency and time), observations
// (W004 evidence — evidence quality), learning (W040 settled outcomes —
// calibration, intervention success, realized value) and cognition (W013 —
// the validated originating-execution link on snapshots).
//
//   recordJudgment   — record ONE ground-truth label an evaluator states
//      about Aurum's behavior: whether a discovered gap was a consequential
//      unknown ('unknown-consequentiality' — gap-scoped, optionally
//      candidate-linked and window-bounded; the labeled truth
//      precision/recall is computed against), or whether the source one
//      recorded acquisition plan chose was the right one
//      ('source-selection' — the labeled truth first-choice source quality
//      and employee routing accuracy are computed against). Judgments are
//      evaluation evidence with evaluator provenance — corrections are NEW
//      judgments; computation resolves the latest per target
//      deterministically (metrics.ts), so the audit trail is never
//      rewritten.
//   getJudgment / listJudgments — the judgment audit surface: one record
//      deep-linked by id, or the feed filtered by kind / gapKey / planId,
//      newest first.
//   computeQualitySnapshot — ONE explicit, bounded computation pass over
//      an evaluation window: fetches the source records through their
//      module contracts (fixed caps; a capped fetch is named in the input
//      audit), applies the tenant's judgments, computes the requested
//      metric families through the versioned pure functions (metrics.ts)
//      and persists the append-only snapshot with its full input audit
//      plus one result row per family. Returns the deep-linked view.
//   getQualitySnapshot / listQualitySnapshots — the snapshot audit
//      surface: one snapshot with its results (canonical order), or the
//      feed filtered by contained metric family, newest first.
//
// There is deliberately NO operation to update or erase a judgment, a
// snapshot or a result, and NO operation that feeds a metric into ranking,
// priors, policy or any business decision: quality metrics are DERIVED
// INTELLIGENCE, never business truth (the briefings discipline) — the
// learning update path (W053/W054 CompanyModel and intervention priors) is
// the ONLY channel from outcomes to future behavior (ADR-0019), and this
// module deliberately stays outside it. PostgreSQL itself rejects
// UPDATE/DELETE/TRUNCATE on all three tables via migration 001 triggers.
// LONGITUDINAL-BENCHMARK.md (normative for W055/W056) is served directly:
// measurements 1–7 map onto the nine metric families this contract
// computes, and W056 drives them over its synthetic companies.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's judgments and
// snapshots are indistinguishable from missing ones (`judgment_not_found`
// / `snapshot_not_found` — no existence leak), and the validated
// cross-module references (discovery candidate, acquisition plan,
// originating execution) are uniformly invalid_*_ref for the same reason.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md:
// W013 + W041 + W051 + W052 + W054 → W055): at this repository state the
// delivered dependency MODULES are cognition (W013), attention (W051),
// knowledge-acquisition (W012 — the records W052 ranks with), missions
// (W011) and learning (W040 — the outcome records W054's priors are
// learned from; its own contract documents W055 consuming them). The
// W041/W052/W054 work items themselves are not yet delivered at this base:
// their records are not consumed here because quality measurement measures
// the underlying evidence (candidates, plans, missions, observations,
// outcomes), which IS present — see the delivery report's DEVIATIONS for
// the dependency-status verification this design is based on.
// ============================================================================

export {
  computeQualitySnapshot,
  getJudgment,
  getQualitySnapshot,
  listJudgments,
  listQualitySnapshots,
  recordJudgment,
} from './service';

export { QualityError } from './errors';
export type { QualityErrorCode } from './errors';

// The versioned pure metric computations — the single deterministic
// definitions of the nine families, reusable by downstream verification
// surfaces (W056's longitudinal benchmark) and unit-testable in isolation
// (the discovery.ts / ranking.ts / signals.ts precedent).
export {
  METRIC_SCHEMA_VERSION,
  ROUNDING_DECIMALS,
  candidateVerdicts,
  computeEvidenceQuality,
  computeInterventionSuccess,
  computeInvestigationCost,
  computeMetric,
  computeMissionResolutionEfficiency,
  computeRealizedValue,
  computeRecommendationCalibration,
  computeSourceSelection,
  computeTimeToUsefulUnderstanding,
  computeUnknownDiscovery,
  firstChoicePlans,
  groundTruthGaps,
  planVerdicts,
  round6,
} from './metrics';
export type {
  CandidateFact,
  JudgmentFact,
  MetricComputationInput,
  MetricWindow,
  ObservationFact,
  PlanFact,
  ResolvedMissionFact,
  SettledOutcomeFact,
} from './metrics';

export {
  DEFAULT_LIST_LIMIT,
  JUDGMENT_KINDS,
  JUDGMENTS_FETCH_LIMIT,
  MAX_GAP_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_METRIC_KINDS,
  MAX_NOTE_LENGTH,
  MAX_PARTY_LABEL_LENGTH,
  MAX_RATIONALE_LENGTH,
  QUALITY_METRIC_KINDS,
  QUALITY_PARTY_KINDS,
  SELECTION_VERDICTS,
  SOURCE_FETCH_LIMIT,
  UNKNOWN_VERDICTS,
  isJudgmentKind,
  isQualityMetricKind,
  isQualityPartyKind,
  isSelectionVerdict,
  isUnknownVerdict,
  isUuid,
} from './validation';

export type {
  ValidatedGetJudgmentQuery,
  ValidatedGetSnapshotQuery,
  ValidatedJudgmentInput,
  ValidatedListJudgmentsQuery,
  ValidatedListSnapshotsQuery,
  ValidatedSnapshotInput,
} from './validation';

export type {
  ComputeQualitySnapshotInput,
  CostByCurrency,
  EvidenceQualityPayload,
  GetJudgmentQuery,
  GetQualitySnapshotQuery,
  InterventionSuccessBucket,
  InterventionSuccessPayload,
  InvestigationCostPayload,
  JudgmentKind,
  ListJudgmentsQuery,
  ListQualitySnapshotsQuery,
  MissionResolutionEfficiencyPayload,
  QualityJudgment,
  QualityMetricKind,
  QualityMetricPayload,
  QualityMetricResult,
  QualityParty,
  QualityPartyInput,
  QualityPartyKind,
  QualitySnapshot,
  QualitySnapshotInputs,
  QualitySnapshotSummary,
  RealizedValueBucket,
  RealizedValuePayload,
  RecordJudgmentInput,
  RecommendationCalibrationPayload,
  SourceSelectionJudgmentInput,
  SourceSelectionPayload,
  SourceSelectionVerdict,
  TimeToUsefulUnderstandingPayload,
  TruncatedSource,
  UnknownConsequentialityInput,
  UnknownConsequentialityVerdict,
  UnknownDiscoveryPayload,
} from './types';
