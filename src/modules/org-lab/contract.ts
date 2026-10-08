// ============================================================================
// org-lab — the ONLY public surface of the org-lab module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W135 — the Contextual Organizational Lab (spec/work-items/
// WORK-ITEM-CATALOG.md §W135; design contract AGENT-BODY-LAB-CROSS-
// PLATFORM-ARCHITECTURE.md §2/§4/§5/§10/§11):
//
//   The candidate registry (§4 compositions, §5 comparison set):
//   registerCandidate — register a tenant-scoped organization candidate:
//      the §4 composition (role-proposal nodes filled by tenant agents,
//      agent bodies, marketplace packages, human capabilities or external
//      specialists; delegation/review/handoff/escalation/information-feed
//      edges; information routes into the coverage registries) plus the
//      DECLARED contextual applicability hypotheses (which seasons,
//      duration classes, staffing profiles, workload levels, capabilities,
//      environment factors, risk tolerances, verification requirements and
//      fresh surfaces the design asserts it fits — caller-supplied
//      content, never industry-coded). Content is IMMUTABLE from
//      registration (a changed design is a NEW candidate with a new slug);
//      only the one-way active → retired lifecycle moves. Agent-body node
//      refs validate readable + active at write time (the W133 seam);
//      every other actor kind is an opaque forward reference owned by its
//      registry (the §5 ruling — the Lab records the comparison, the
//      owners remain the verification points).
//   getCandidate / listCandidates — tenant-scoped reads with the uniform
//      not-found discipline (a foreign id is indistinguishable from a
//      missing one). listCandidates takes a QUERY OBJECT (status, limit).
//   retireCandidate — the one-way lifecycle (active → retired, stamped
//      once, with the required retained reason). Retiring deliberately
//      leaves every evaluation that cites the candidate untouched:
//      evaluations are retained evidence.
//
//   The contextually-conditioned search (§2 — THE CONTEXTUAL RULE):
//   searchOrganizations — rank the tenant's ACTIVE candidates under a
//      ContextFingerprint derived FOR the subject goal (validated ACTIVE;
//      the fingerprint is consumed through the W134 contract, never
//      re-derived here). Every result carries the per-axis fit report
//      over ALL TWELVE acceptance dimensions (season/time window,
//      duration, staffing/staff experience, workload, capability,
//      environment, budget, quality, risk, verification, evidence
//      freshness — plus SLA), the deterministic fitScore, the
//      outcome-calibration aggregate, and the §5 node-kind census. The
//      matching is MECHANICAL (declared hypotheses vs observed
//      fingerprint — ranking.ts's pure functions, exported below for
//      verification); the same subject under a materially different
//      fingerprint may rank a different candidate first — that divergence
//      is DATA, never code.
//
//   The §11 evidence object (recommendations + calibration):
//   recordRecommendation — append ONE immutable recommendation: goal
//      revision, fingerprint, optional W134 strategy link, knowledge
//      objective, evaluation configuration, ALL evaluated candidates
//      (recommended AND rejected — rejected ones REQUIRE retained
//      rejection reasons; nothing is ever discarded), the recommended
//      candidate's model-occupancy snapshot (the agent-body + fabric
//      seams, read-only, opaque binding ids VERBATIM), and the
//      expected-outcome snapshots (readable OPEN learning-module outcomes
//      — the commitment BEFORE realization, the W054 prediction-hygiene
//      discipline). At most one evaluated candidate is 'recommended'
//      (zero is the honest no-winner case). The append is ONE
//      transaction; every evidence gate runs before it (the W134
//      transaction-discipline law — PGlite is single-connection).
//   recordCalibration — the outcome-calibration loop: consume the
//      learning module's FROZEN realizations (every expected outcome must
//      have SETTLED — an abandoned outcome never realizes), derive the
//      deterministic polarity (positive iff every realized outcome was
//      'met' or 'exceeded'; a single 'missed' is negative — failed
//      recommendations are retained as negative evidence), append the ONE
//      calibration and stamp the recommendation's one-way recorded →
//      calibrated transition. Terminal: one calibration per
//      recommendation, ever.
//   getRecommendation / listRecommendations / getCandidateCalibration —
//      tenant-scoped reads: the full evidence view (including the retained
//      rejected alternatives), the filtered summaries (goal, fingerprint,
//      evaluated candidate, status), and a candidate's calibration
//      aggregate (null = the honest cold start).
//
// AUTHORITY BOUNDARIES (§10, the completion law): the Lab RECOMMENDS —
// nothing on this surface installs a marketplace package, recruits an
// agent, executes an external specialist or grants any authority. Those
// belong to Marketplace governance (W028), Agent Recruitment (W022),
// Action Policy (W009) and the Agent Gateway (W021) at the composition
// boundary (W136/W137 own the follow-through; W141 the certification).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's candidates,
// recommendations and calibrations are indistinguishable from missing
// ones — no existence leak.
// ============================================================================

export {
  // The candidate registry
  registerCandidate,
  getCandidate,
  listCandidates,
  retireCandidate,
  // The contextually-conditioned search
  searchOrganizations,
  // The §11 evidence object
  recordCalibration,
  recordRecommendation,
  getCandidateCalibration,
  getRecommendation,
  listRecommendations,
} from './service';

export { OrgLabError } from './errors';
export type { OrgLabErrorCode } from './errors';

// Guards + vocabularies + limits (pure; unit-testable without a database).
export {
  CANDIDATE_DISPOSITIONS,
  COVERAGE_SOURCE_REGISTRIES,
  DEFAULT_LIST_LIMIT,
  DURATION_CLASSES,
  MAX_ADVISORY_NOTE_CHARS,
  MAX_AGENT_EVALUATION_REFS,
  MAX_CRITERIA,
  MAX_CRITERION_NAME_CHARS,
  MAX_DECLARED_VALUES,
  MAX_DESCRIPTION_CHARS,
  MAX_EDGES,
  MAX_EDGE_NOTE_CHARS,
  MAX_EVIDENCE_REFS,
  MAX_EXPECTED_OUTCOMES,
  MAX_EVALUATED_CANDIDATES,
  MAX_INFORMATION_ROUTES,
  MAX_KNOWLEDGE_OBJECTIVE_CHARS,
  MAX_LABEL_CHARS,
  MAX_LIST_LIMIT,
  MAX_NODES,
  MAX_NOTE_CHARS,
  MAX_PURPOSES_PER_NODE,
  MAX_REASON_CHARS,
  MAX_REJECTION_REASONS,
  MAX_REF_CHARS,
  MAX_REQUIRED_ITEMS,
  MAX_SCORES,
  MAX_SEASON_WINDOWS,
  MAX_SLUG_CHARS,
  MAX_SUMMARY_CHARS,
  MIN_EVALUATED_CANDIDATES,
  MIN_EXPECTED_OUTCOMES,
  MODEL_BINDING_PURPOSES,
  ORG_CANDIDATE_STATUSES,
  ORG_EDGE_KINDS,
  ORG_NODE_KINDS,
  ORG_RECOMMENDATION_STATUSES,
  RISK_TOLERANCES,
  STAFFING_PROFILES,
  WORKLOAD_LEVELS,
  assertOrgLabTenantContext,
  isCandidateDisposition,
  isCoverageSourceRegistryValue,
  isDurationClassValue,
  isModelBindingPurposeValue,
  isOrgCandidateStatus,
  isOrgEdgeKind,
  isOrgNodeKind,
  isOrgRecommendationStatus,
  isRiskTolerance,
  isStaffingProfile,
  isUuid,
  isWorkloadLevelValue,
  validateGetCandidateCalibrationQuery,
  validateGetCandidateQuery,
  validateGetRecommendationQuery,
  validateListCandidatesQuery,
  validateListRecommendationsQuery,
  validateRecordCalibrationInput,
  validateRecordRecommendationInput,
  validateRegisterCandidateInput,
  validateRetireCandidateInput,
  validateSearchOrganizationsQuery,
} from './validation';
export type {
  ValidatedCandidateEvaluation,
  ValidatedGetCandidateCalibrationQuery,
  ValidatedGetCandidateQuery,
  ValidatedGetRecommendationQuery,
  ValidatedListCandidatesQuery,
  ValidatedListRecommendationsQuery,
  ValidatedRecordCalibrationInput,
  ValidatedRecordRecommendationInput,
  ValidatedRegisterCandidateInput,
  ValidatedRetireCandidateInput,
  ValidatedSearchOrganizationsQuery,
} from './validation';

// The pure contextual-fit + ranking math (the single deterministic
// definition of how the Lab ranks candidates under a fingerprint —
// exported for verification, the outcomes/learning discipline).
export {
  CALIBRATION_GAIN,
  NEUTRAL_FIT,
  calibrationAggregate,
  calibrationPolarity,
  contextualFit,
  observedStaffingProfile,
  rankOrganizationCandidates,
  rankScoreOf,
  smoothedSuccessRate,
} from './ranking';

// The domain vocabularies (types.ts is their single home; the frozen
// status/disposition arrays are re-exported above through validation.ts).
export { ORG_FIT_AXES } from './types';
export type {
  CandidateApplicability,
  CandidateApplicabilityInput,
  CandidateDisposition,
  CandidateEvaluationInput,
  CandidateEvaluationRecord,
  CalibrationPolarity,
  CalibrationSummary,
  DimensionFit,
  DimensionVerdict,
  EvaluationConfig,
  EvaluationConfigInput,
  EvaluationCriterion,
  EvaluationScore,
  ExpectedOutcomeRecord,
  FitFingerprint,
  GetCandidateCalibrationQuery,
  GetCandidateQuery,
  GetRecommendationQuery,
  ListCandidatesQuery,
  ListRecommendationsQuery,
  OccupancySnapshot,
  OrgCalibration,
  OrgCandidate,
  OrgCandidateStatus,
  OrgComposition,
  OrgEdge,
  OrgEdgeInput,
  OrgEdgeKind,
  OrgInformationRoute,
  OrgInformationRouteInput,
  OrgNode,
  OrgNodeInput,
  OrgNodeKind,
  OrgRecommendation,
  OrgRecommendationStatus,
  OrgRecommendationSummary,
  OrgSearchResult,
  RankableCandidate,
  RankedCandidate,
  RealizedOutcomeRecord,
  RecordCalibrationInput,
  RecordRecommendationInput,
  RegisterCandidateInput,
  RetireCandidateInput,
  RiskTolerance,
  SearchOrganizationsQuery,
  StaffingProfile,
} from './types';

// The frozen cross-module vocabularies this surface speaks, re-exported
// TYPE-ONLY through their owning contracts (the single legal cross-module
// imports, enforced by the architecture gate) so consumers never need to
// know where each union was frozen.
export type {
  ContextDimensionKey,
  DurationClass,
  WorkloadLevel,
} from '@/modules/context/contract';
export type { CoverageSourceRegistry } from '@/modules/coverage/contract';
export type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';
