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
// W041 — Company Learning (DAG: W040 → W041; ADR-0016 normative):
// "Version company-specific usefulness/preferences from explicit,
//  behavioral and outcome feedback without mutating policy silently."
//
//   recordCompanyLearning — ONE feedback event → ONE appended version of
//      the company-specific (target, aspect) chain: explicit feedback is a
//      statement; behavioral feedback is observed behavior and MUST cite
//      evidence; outcome feedback is grounded in a SETTLED W040 outcome of
//      the same tenant with its frozen assessment snapshotted onto the
//      version (ADR-0016's learning invariant: "A completed project or
//      intervention may improve future behavior only through a recorded
//      learning update linked to evidence and outcome. The learning update
//      must identify what changed and why" — the required `reason` is the
//      why; the retained previous version is the what). Version numbers
//      are 1-based, monotonic per chain; NOTHING is ever rewritten
//      (append-only at the storage level, migration 002 triggers).
//   getCompanyLearning / listCompanyLearnings — the derived current views
//      of the chains (current + previous version, derived validity
//      'active' | 'expired', version count), filtered by target
//      kind/id, aspect, the current version's channel and validity,
//      most recently learned first.
//   getCompanyLearningVersion — one learned assertion, deep-linked by id.
//   listCompanyLearningVersions — one chain's full version history,
//      ascending — the audit trail every consumer of a learned preference
//      can reconstruct "what changed and why" from (lock 37).
//
// POLICY NON-AUTHORITY (the item's "without mutating policy silently",
// lock 14, ADR-0016 "Explicit policy remains authoritative over learned
// preference"): every version read mints `authoritative: false` — there
// is no input field that could set it, no operation here touches any
// policy surface, and versions are append-only, so a learned preference
// can never silently override, relax or tighten policy. Consumers
// (W052 source ranking, W053 CompanyModel, W055 quality measurement)
// must defer to explicit policy.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; the chain key includes tenant_id (the
// same target+aspect in two tenants is two independent chains); access to
// another tenant's learnings or versions is reported as
// `learning_not_found` / `learning_version_not_found` — no existence leak.
// The outcome link of outcome feedback follows the module's uniform
// not-found discipline (`outcome_not_found`; an existing but unsettled
// outcome is `invalid_outcome_ref`).
//
// W041 also has deliberately NO operation to edit, reorder, renumber or
// delete a version, and none to un-expire a chain: a learned preference is
// versioned, not mutated — exactly the item's verb. PostgreSQL itself
// rejects UPDATE/DELETE/TRUNCATE on both company-learning tables via
// migration 002 triggers. An expired chain is not dead: new feedback
// appends a new version.
//
// W041 target references (sources/people/agents/extensions/missions/
// channels/processes/capabilities) are opaque forward references owned by
// their modules — no cross-module foreign keys, no NEW contract imports
// (the W040 subject precedent). The outcome link stays INSIDE the module:
// `outcomes` is this module's own W040 surface, so the W040 → W041
// dependency needs no import at all — the module's only cross-module
// import remains the cognition contract (the sanctioned W013 → W040 edge,
// for origin-execution validation).
//
// There is deliberately NO W040 operation to redefine an outcome, rewrite a
// measurement, un-settle, un-abandon or delete anything: the expected
// value is a prediction frozen at definition time (rewriting it after
// realization would destroy expected-versus-realized honesty, which
// W055's recommendation calibration measures), and measurements and
// terminal records are append-only evidence — PostgreSQL itself rejects
// UPDATE/DELETE/TRUNCATE on all three tables via migration 001 triggers.
// Terminal states are dead ends by design: a subject whose need returns
// is tied to a NEW outcome, which is what keeps realization measurable.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W012 + W013 → W040,
// then W040 → W041): this module imports the cognition contract only. The
// declared knowledge-acquisition (W012) dependency is verified present but
// not imported: its planner records answer investigations for missions,
// none of which outcome measurement consumes — W042 (Knowledge
// Contributions: "mission impact and investigation-cost avoidance") is
// the learning item that builds on the acquisition contract. W041's
// outcome-feedback grounding reads this module's own `outcomes` tables
// directly — no additional cross-module edge.
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
} from './service';

// W041 — Company Learning (versioned usefulness/preferences).
export {
  getCompanyLearning,
  getCompanyLearningVersion,
  listCompanyLearnings,
  listCompanyLearningVersions,
  recordCompanyLearning,
} from './service';

export { LearningError } from './errors';
export type { LearningErrorCode } from './errors';

// The expected-versus-realized math — the single deterministic definition,
// pure and reusable by downstream learning surfaces (W054/W055 consume the
// FROZEN record this produces; the function is exported for verification).
export { assessRealization } from './validation';
export type { RealizationAssessment } from './validation';

// The read-time validity derivation — the single deterministic definition
// of a company learning chain's 'active' | 'expired' state (pure; exported
// for verification).
export { deriveLearningStatus } from './validation';

export {
  DEFAULT_LIST_LIMIT,
  MAX_AFFECTED_GOALS,
  MAX_ASPECT_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_LEARNING_VALUE_BYTES,
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
  LEARNING_FEEDBACK_CHANNELS,
  LEARNING_STATUSES,
  LEARNING_TARGET_KINDS,
  escapeLike,
  isLearningFeedbackChannel,
  isLearningStatus,
  isLearningTargetKind,
  isOutcomeAssessment,
  isOutcomeDirection,
  isOutcomeEvidenceKind,
  isOutcomePartyKind,
  isOutcomeStatus,
  isOutcomeSubjectKind,
  isUuid,
} from './validation';

export type {
  ValidatedAbandonInput,
  ValidatedDefineInput,
  ValidatedListLearningsQuery,
  ValidatedListLearningVersionsQuery,
  ValidatedListQuery,
  ValidatedMeasurementInput,
  ValidatedMeasurementsQuery,
  ValidatedParty,
  ValidatedRecordLearningInput,
  ValidatedSettleInput,
  ValidatedSummarizeQuery,
} from './validation';

export type {
  AbandonOutcomeInput,
  CompanyLearning,
  CompanyLearningVersion,
  DefineOutcomeInput,
  LearningActor,
  LearningEvidenceRef,
  LearningFeedbackChannel,
  LearningStatus,
  LearningTarget,
  LearningTargetInput,
  ListCompanyLearningsQuery,
  ListCompanyLearningVersionsQuery,
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
  RecordCompanyLearningInput,
  RecordMeasurementInput,
  SettleOutcomeInput,
  SummarizeRealizationQuery,
} from './types';
