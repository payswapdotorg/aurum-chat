// ============================================================================
// learning — the ONLY public surface of the learning module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W040 — Outcome Measurement:
// "Tie recommendations, agents, extensions and missions to measurable
//  outcomes and expected-versus-realized value."
//
// This module is the learning layer's measurement foundation (the frozen
// module map's L5 `learning`; W041 Company Learning and W042 Knowledge
// Contributions extend this module afterwards per the DAG — W040 → W041,
// W012 + W040 → W042). An Outcome ties ONE subject — a recommendation, an
// agent, an extension or a learning mission (W011) — to ONE measurable
// metric: a baseline, an expected value frozen at definition time, an
// append-only observation series, and a terminal settlement that records
// the realized value BY REFERENCE to one of those observations and freezes
// the expected-versus-realized assessment (ADR-0019's baseline → expected
// → observed → realized → variance chain; W054 capability outcome learning
// and W055 quality measurement consume these records).
//
//   defineOutcome   — tie a subject to a measurable outcome: the immutable
//      definition row (metric name/unit, direction, baseline, expected,
//      optional horizon, affected goals, optional originating cognitive
//      execution validated through the cognition contract). Status is
//      minted 'open'.
//   recordMeasurement — append one observed value to the outcome's
//      observation series (open outcomes only), with actor provenance and
//      optional opaque evidence references. Append-only evidence.
//   settleOutcome   — the one-way open → settled transition: the realized
//      value IS a referenced measurement's value (realization is always
//      evidence-grounded); the service freezes variance-vs-expected,
//      improvement-vs-baseline and the deterministic met/exceeded/missed
//      assessment. Terminal.
//   abandonOutcome  — the one-way open → abandoned transition with a
//      required reason. Terminal.
//   getOutcome      — the derived current view (definition + status +
//      frozen realization + observation-series summary).
//   listOutcomes    — current views, filtered (subject kind/id, status,
//      assessment, affected goal, originating execution, metric-name
//      search), newest first.
//   getMeasurement  — one observation-series record, deep-linked by id.
//   listMeasurements — one outcome's observation series, ascending.
//   summarizeRealization — the expected-versus-realized rollup: counts
//      and arithmetic sums per subject kind plus overall.
//
// There is deliberately NO operation to redefine an outcome, rewrite a
// measurement, un-settle, un-abandon or delete anything: the expected
// value is a prediction frozen at definition time (rewriting it after
// realization would destroy expected-versus-realized honesty, which
// W055's recommendation calibration measures), and measurements and
// terminal records are append-only evidence — PostgreSQL itself rejects
// UPDATE/DELETE/TRUNCATE on all three tables via migration 001 triggers.
// Terminal states are dead ends by design: a subject whose need returns
// is tied to a NEW outcome, which is what keeps realization measurable.
//
// Cross-module references: subjects (recommendations/agents/extensions/
// missions) and affected goals are opaque forward references owned by
// their modules (actions W009, agents W021+, extensions W025+, missions
// W011, goals W008) — no cross-module foreign keys, no contract imports
// (the missions module's affected-goals precedent). The originating
// cognitive execution is the one validated cross-module link: it is
// checked readable through the cognition contract at write time (the
// sanctioned W013 → W040 dependency; ADR-0019: outcomes are "linked to
// the originating goal, recommendation, authorization and execution").
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's outcomes
// or measurements (including measuring, settling and abandoning by
// foreign-tenant outcome id) is reported as `outcome_not_found` /
// `measurement_not_found` — no existence leak.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W012 + W013 → W040):
// this module imports the cognition contract only. The declared
// knowledge-acquisition (W012) dependency is verified present but not
// imported: its planner records answer investigations for missions, none
// of which outcome measurement consumes — W042 (Knowledge Contributions:
// "mission impact and investigation-cost avoidance") is the learning item
// that builds on the acquisition contract.
//
// W053 — CompanyModel Learning (ADR-0016) extends this module with the
// versioned CompanyModel (see the W053 section below): durable
// company-specific learning — vocabulary, organization, process
// exceptions, source reliability, employee expertise, capability patterns,
// goal interpretation, investigation preferences, intervention priors and
// organizational norms — where every learned assertion carries provenance,
// confidence, a validity interval and version metadata; learned preference
// never overrides explicit policy; provider/model replacement preserves
// learned state; and a longitudinal fixture proves measurable improvement.
// ============================================================================

export {
  abandonOutcome,
  defineOutcome,
  getMeasurement,
  getOutcome,
  listMeasurements,
  listOutcomes,
  recordMeasurement,
  settleOutcome,
  summarizeRealization,
  // W053 — CompanyModel Learning (ADR-0016)
  getCompanyModel,
  getCompanyModelAssertion,
  getLearningUpdate,
  listCompanyModelAssertions,
  listLearningUpdates,
  rankCandidates,
  recordLearningUpdate,
} from './service';

export { LearningError } from './errors';
export type { LearningErrorCode } from './errors';

// The expected-versus-realized math — the single deterministic definition,
// pure and reusable by downstream learning surfaces (W054/W055 consume the
// FROZEN record this produces; the function is exported for verification).
export { assessRealization } from './validation';
export type { RealizationAssessment } from './validation';

// W053 — the deterministic learned-prior scoring (the single definition of
// how the CompanyModel reorders policy-vetted candidates), plus the subject
// key derivation. Pure and provider-independent; exported for verification
// and for downstream learning surfaces (W054/W055/W056 consume these, never
// a re-derivation).
export { deriveSubjectKey, scoreCandidateSet, slugifySubjectName } from './validation';
export type {
  ScoreableAssertion,
  ValidatedRankCandidate,
  ValidatedRankInput,
  ValidatedRankPolicy,
} from './validation';

export {
  DEFAULT_LIST_LIMIT,
  MAX_AFFECTED_GOALS,
  MAX_EVIDENCE_REFS,
  MAX_LIST_LIMIT,
  MAX_METRIC_NAME_LENGTH,
  MAX_METRIC_UNIT_LENGTH,
  MAX_METRIC_VALUE,
  MAX_NOTE_LENGTH,
  MAX_PARTY_LABEL_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_SUBJECT_LABEL_LENGTH,
  OUTCOME_ASSESSMENTS,
  OUTCOME_DIRECTIONS,
  OUTCOME_EVIDENCE_KINDS,
  OUTCOME_PARTY_KINDS,
  OUTCOME_STATUSES,
  OUTCOME_SUBJECT_KINDS,
  escapeLike,
  isOutcomeAssessment,
  isOutcomeDirection,
  isOutcomeEvidenceKind,
  isOutcomePartyKind,
  isOutcomeStatus,
  isOutcomeSubjectKind,
  isUuid,
  // W053 — CompanyModel Learning (ADR-0016)
  ASSERTION_DISPOSITIONS,
  ASSERTION_PROVENANCE_KINDS,
  CANDIDATE_DOMAINS,
  COMPANY_MODEL_AREAS,
  COMPANY_MODEL_STATUSES,
  COMPANY_MODEL_SUBJECT_KINDS,
  DEFAULT_CANDIDATE_BASE_SCORE,
  MAX_CHANGES_PER_UPDATE,
  MAX_POLICY_KIND_LENGTH,
  MAX_POLICY_KINDS,
  MAX_PROVENANCE_REFS,
  MAX_RANK_CANDIDATES,
  MAX_STATEMENT_JSON_LENGTH,
  MAX_STATEMENT_KEYS,
  MAX_STATEMENT_KEY_LENGTH,
  MAX_SUBJECT_KEY_LENGTH,
  MAX_SUBJECT_NAME_LENGTH,
  MAX_SUBJECT_SLUG_LENGTH,
  MAX_TOPIC_LENGTH,
  RANK_DOMAIN_FAMILIES,
  SCORE_DECIMALS,
  isAssertionDisposition,
  isAssertionProvenanceKind,
  isCandidateDomain,
  isCompanyModelArea,
  isCompanyModelStatus,
  isCompanyModelSubjectKind,
} from './validation';

export type {
  ValidatedAbandonInput,
  ValidatedDefineInput,
  ValidatedListQuery,
  ValidatedMeasurementInput,
  ValidatedMeasurementsQuery,
  ValidatedParty,
  ValidatedSettleInput,
  ValidatedSummarizeQuery,
  // W053 — CompanyModel Learning (ADR-0016)
  ValidatedAssertionDelta,
  ValidatedAssertionListQuery,
  ValidatedCompanyModelSubject,
  ValidatedModelQuery,
  ValidatedProvenanceRef,
  ValidatedUpdateInput,
  ValidatedUpdatesListQuery,
} from './validation';

export type {
  AbandonOutcomeInput,
  DefineOutcomeInput,
  ListMeasurementsQuery,
  ListOutcomesQuery,
  Outcome,
  OutcomeActor,
  OutcomeAssessment,
  OutcomeDirection,
  OutcomeEvidenceKind,
  OutcomeEvidenceRef,
  OutcomeEvidenceRefInput,
  OutcomeGoalRef,
  OutcomeGoalRefInput,
  OutcomeMeasurement,
  OutcomeParty,
  OutcomePartyInput,
  OutcomePartyKind,
  OutcomeRealization,
  OutcomeStatus,
  OutcomeSubject,
  OutcomeSubjectInput,
  OutcomeSubjectKind,
  RealizationBucket,
  RealizationSummary,
  RecordMeasurementInput,
  SettleOutcomeInput,
  SummarizeRealizationQuery,
  // W053 — CompanyModel Learning (ADR-0016)
  AppliedPrior,
  AssertionDeltaInput,
  AssertionDisposition,
  AssertionProvenanceKind,
  AssertionProvenanceRef,
  AssertionProvenanceRefInput,
  CandidateDomain,
  CompanyModel,
  CompanyModelArea,
  CompanyModelAssertion,
  CompanyModelAssertionStatus,
  CompanyModelRanking,
  CompanyModelSubject,
  CompanyModelSubjectInput,
  CompanyModelSubjectKind,
  GetCompanyModelQuery,
  LearningUpdate,
  ListCompanyAssertionsQuery,
  ListLearningUpdatesQuery,
  RankCandidatesInput,
  RankCandidateInput,
  RankedCandidate,
  RankPolicyConstraints,
  RecordLearningUpdateInput,
} from './types';
