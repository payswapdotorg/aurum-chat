// Public domain types of the learning module (W040 — Outcome Measurement).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W040):
// "Tie recommendations, agents, extensions and missions to measurable
//  outcomes and expected-versus-realized value."
//
// An Outcome is the learning layer's measurement vehicle: it ties ONE
// subject — a recommendation, an agent, an extension or a learning mission
// — to ONE measurable metric with a baseline (the "before"), an expected
// value (the committed prediction, frozen at definition time) and an
// append-only observation series; settling the outcome records the realized
// value BY REFERENCE to one of those observations and freezes the
// expected-versus-realized assessment (variance, improvement, met/exceeded/
// missed). This is exactly the primitive ADR-0019 requires of every
// material intervention ("a baseline; an expected outcome; an intervention
// record; an observed outcome; variance/realized value") and the record
// W054 capability outcome learning and W055 quality measurement build on.
//
// Like a mission (W011), an outcome is planned work — NOT a belief
// (epistemics W007) and NOT evidence (observations W004): it is a
// commitment plus measurements. Unlike a mission, its definition is
// immutable: there is deliberately NO revision operation, because a
// prediction that can be rewritten after realization is worthless for
// expected-versus-realized honesty (W055's "recommendation calibration" and
// "intervention realized value versus expected value" depend on the
// expectation being frozen). Lifecycle is therefore three derived states:
// 'open' (defined, accepting measurements), 'settled' (realized value
// recorded — terminal) and 'abandoned' (terminal, with a required reason).
//
// Provider neutrality (lock 16): the subject, the affected goals and
// measurement evidence are opaque references — kind + uuid id and/or human
// label — owned by their respective modules (actions W009 for
// recommendations, agents W021+ for agents, extensions W025+ for
// extensions, missions W011 for missions, goals W008 for goals). No
// cross-module foreign keys and no contract imports for them (the missions
// module's affected-goals precedent). The ONE validated cross-module link
// is the originating cognitive execution: `originExecutionId` is checked
// readable through the cognition contract at write time (the sanctioned
// W013 → W040 dependency; ADR-0019: outcomes are "linked to the originating
// goal, recommendation, authorization and execution").

/** The subjects W040 ties to measurable outcomes (the catalog entry's list). */
export type OutcomeSubjectKind = 'recommendation' | 'agent' | 'extension' | 'mission';

/**
 * Which way the metric moves when things go well:
 *  * 'at_least' — the metric is expected to be AT LEAST the expected value
 *    (higher is better; realized >= expected is a success);
 *  * 'at_most'  — the metric is expected to be AT MOST the expected value
 *    (lower is better; realized <= expected is a success).
 */
export type OutcomeDirection = 'at_least' | 'at_most';

/**
 * Lifecycle of an outcome, DERIVED from the realization record (never
 * stored on the definition row): no realization row = 'open'; a 'settled'
 * or 'abandoned' realization row is terminal — a settled or abandoned
 * outcome is a dead end, exactly like a completed/abandoned mission. A
 * subject whose need returns is tied to a NEW outcome; the old record
 * stays as measured, which is what keeps expected-versus-realized honest.
 */
export type OutcomeStatus = 'open' | 'settled' | 'abandoned';

/**
 * The deterministic verdict of realized-versus-expected, frozen at settle
 * time (validation.ts `assessRealization` is the single definition):
 *  * 'exceeded' — strictly better than expected;
 *  * 'met'      — exactly meets the expectation;
 *  * 'missed'   — worse than expected.
 */
export type OutcomeAssessment = 'met' | 'exceeded' | 'missed';

/**
 * The subject one outcome measures: a provider-neutral kind plus the
 * subject record's uuid `id` (required — the tie must be precise) and an
 * optional human-readable label. Opaque forward reference: the owning
 * module (actions for recommendations, agents, extensions, missions)
 * remains the verification point; this module creates no cross-module
 * foreign keys and imports no contract for subjects.
 */
export interface OutcomeSubject {
  kind: OutcomeSubjectKind;
  id: string;
  label?: string | null;
}

/** Input shape of `OutcomeSubject`. */
export interface OutcomeSubjectInput {
  kind: OutcomeSubjectKind;
  id: string;
  label?: string | null;
}

/**
 * One affected-goal reference (the missions module's precedent): an opaque
 * uuid forward reference to a goals module (W008) record plus an optional
 * human label. ADR-0019: outcomes are "linked to the originating goal".
 */
export interface OutcomeGoalRef {
  goalId: string;
  label?: string | null;
}

/** Input shape of `OutcomeGoalRef`. */
export interface OutcomeGoalRefInput {
  goalId: string;
  label?: string | null;
}

/** Kinds of parties that can define, measure or settle an outcome. */
export type OutcomePartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — the party must be traceable (the missions actor rule).
 */
export interface OutcomeParty {
  kind: OutcomePartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `OutcomeParty`. */
export interface OutcomePartyInput {
  kind: OutcomePartyKind;
  id?: string | null;
  label?: string | null;
}

/** The party that made one outcome change (`OutcomeParty`). */
export type OutcomeActor = OutcomeParty;

/**
 * One opaque evidence reference on a measurement — where the observed
 * value came from. Kinds cover the canonical evidence surfaces (W004
 * observations, W003 events, documents, reports, business systems, metric
 * streams); the reference carries an opaque uuid `id` and/or a human label
 * (at least one — evidence must be traceable). Deliberately unvalidated
 * here: no sanctioned dependency owns these references for the learning
 * module, and measurement provenance is the actor + clock + evidence trio.
 */
export type OutcomeEvidenceKind = 'observation' | 'event' | 'document' | 'report' | 'system' | 'metric';

/** One evidence reference of a measurement. */
export interface OutcomeEvidenceRef {
  kind: OutcomeEvidenceKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `OutcomeEvidenceRef`. */
export interface OutcomeEvidenceRefInput {
  kind: OutcomeEvidenceKind;
  id?: string | null;
  label?: string | null;
}

/**
 * The frozen expected-versus-realized record — computed by the service at
 * settle time from the outcome definition and the grounding measurement,
 * stored on the terminal realization row, and never recomputed or edited
 * afterwards. This is W040's core deliverable and W054/W055's input.
 */
export interface OutcomeRealization {
  /** The realized metric value — by definition the grounding measurement's value. */
  realizedValue: number;
  /** realized − expected (signed, in metric units). */
  varianceVsExpected: number;
  /** realized − baseline (signed, in metric units). */
  improvementVsBaseline: number;
  /** The deterministic verdict (see `OutcomeAssessment`). */
  assessment: OutcomeAssessment;
  /** The measurement this realization is grounded in (never free-floating). */
  fromMeasurementId: string;
  /** Optional context recorded at settle time. */
  note: string | null;
  /** Who settled (domain provenance). */
  actor: OutcomeActor;
  /** The authenticated TenantContext principal that committed the settlement. */
  realizedByPrincipal: string;
  /** ISO 8601 — when the settlement was committed (service clock). */
  settledAt: string;
}

/** Input shape of `defineOutcome` (status is minted 'open'). */
export interface DefineOutcomeInput {
  /** What is being tied to this measurable outcome. */
  subject: OutcomeSubjectInput;
  /** The measured quantity, e.g. 'monthly churn rate'. */
  metricName: string;
  /** The metric's unit, e.g. 'percent', 'tickets', 'EUR-minor'. */
  metricUnit: string;
  /** Which way the metric moves when things go well. */
  direction: OutcomeDirection;
  /** The value before the subject acted (ADR-0019's baseline). */
  baseline: number;
  /** The committed prediction (ADR-0019's expected outcome). */
  expected: number;
  /** Optional ISO date (YYYY-MM-DD) by which the outcome should be assessable. */
  horizon?: string | null;
  /** Defaults to `[]` (opaque forward references to goals W008 records). */
  affectedGoals?: OutcomeGoalRefInput[];
  /**
   * The cognitive execution (W013) that produced the subject — ADR-0019's
   * "originating execution" link. Validated readable through the
   * cognition contract at write time. Optional.
   */
  originExecutionId?: string | null;
  /** Who is defining the outcome (audit trail). */
  actor: OutcomePartyInput;
  /** Why — optional, recorded on the definition. */
  rationale?: string | null;
}

/** Input shape of `recordMeasurement` (open outcomes only). */
export interface RecordMeasurementInput {
  outcomeId: string;
  /** The observed metric value. */
  value: number;
  /** Optional context for this observation. */
  note?: string | null;
  /** Optional opaque evidence references (where the value came from). */
  evidence?: OutcomeEvidenceRefInput[];
  /** Who observed/recorded (audit trail). */
  actor: OutcomePartyInput;
}

/**
 * Input shape of `settleOutcome` (open → settled, terminal). The realized
 * value is NOT caller-supplied: it is the referenced measurement's value —
 * realization is always evidence-grounded.
 */
export interface SettleOutcomeInput {
  outcomeId: string;
  /** A measurement of THIS outcome whose value is the realized value. */
  measurementId: string;
  /** Optional context recorded on the frozen realization. */
  note?: string | null;
  /** Who settles (audit trail). */
  actor: OutcomePartyInput;
}

/** Input shape of `abandonOutcome` (open → abandoned, terminal). */
export interface AbandonOutcomeInput {
  outcomeId: string;
  /** Required: why — terminal transitions record their why. */
  reason: string;
  /** Who abandons (audit trail). */
  actor: OutcomePartyInput;
}

/** One append-only observed value of an outcome (the observation series). */
export interface OutcomeMeasurement {
  id: string;
  tenantId: string;
  outcomeId: string;
  value: number;
  note: string | null;
  evidence: OutcomeEvidenceRef[];
  actor: OutcomeActor;
  /** The authenticated TenantContext principal that recorded the value. */
  recordedByPrincipal: string;
  /** ISO 8601 — when Aurum committed this observation (service clock). */
  recordedAt: string;
}

/**
 * The current view of an outcome: the immutable definition plus the
 * derived lifecycle state, the frozen realization (once terminal), and the
 * observation-series summary (count + latest observed value).
 */
export interface Outcome {
  id: string;
  tenantId: string;
  /** Version 1-equivalent of the definition — immutable from birth. */
  subject: OutcomeSubject;
  metricName: string;
  metricUnit: string;
  direction: OutcomeDirection;
  baseline: number;
  expected: number;
  horizon: string | null;
  affectedGoals: OutcomeGoalRef[];
  originExecutionId: string | null;
  /** Derived: open ⇔ realization is null. */
  status: OutcomeStatus;
  /** The frozen expected-versus-realized record; null while open, retained on abandonment (null there too — nothing was realized). */
  realization: OutcomeRealization | null;
  /** Why the outcome was abandoned, once it was (terminal audit). */
  abandonment: { reason: string; actor: OutcomeActor; abandonedByPrincipal: string; abandonedAt: string } | null;
  /** How many measurements the observation series holds. */
  measurementCount: number;
  /** The most recently recorded measurement, if any. */
  latestMeasurement: OutcomeMeasurement | null;
  /** ISO 8601 — when the definition was committed. */
  createdAt: string;
  /** Audit summary of the definition (the only change an outcome ever has). */
  lastChange: {
    actor: OutcomeActor;
    changedByPrincipal: string;
    rationale: string | null;
    recordedAt: string;
  };
}

/** Query shape of `listOutcomes` (over the derived current views). */
export interface ListOutcomesQuery {
  subjectKind?: OutcomeSubjectKind;
  /** Requires `subjectKind` (an id is meaningless without its kind). */
  subjectId?: string;
  status?: OutcomeStatus;
  /** Only meaningful with status='settled'. */
  assessment?: OutcomeAssessment;
  /** Outcomes whose affected goals include this goals-module record id. */
  affectedGoalId?: string;
  /** Outcomes originating from this cognitive execution. */
  originExecutionId?: string;
  /** Case-insensitive substring on the metric name. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listMeasurements`. */
export interface ListMeasurementsQuery {
  outcomeId: string;
}

/**
 * One expected-versus-realized bucket of `summarizeRealization` — the
 * rollup surface W055's "intervention success / realized value" metrics
 * and management reporting read. Sums are arithmetic over metric values;
 * comparing across metrics is the caller's interpretation.
 */
export interface RealizationBucket {
  total: number;
  open: number;
  settled: number;
  abandoned: number;
  /** Sum of expected values over settled outcomes. */
  settledExpected: number;
  /** Sum of realized values over settled outcomes. */
  settledRealized: number;
  /** Sum of (realized − expected) over settled outcomes. */
  netVariance: number;
  met: number;
  exceeded: number;
  missed: number;
}

/** Result shape of `summarizeRealization`: overall + per subject kind. */
export interface RealizationSummary {
  /** Aggregated over every outcome matching the query. */
  overall: RealizationBucket;
  /** One bucket per requested subject kind (zeroed when absent). */
  bySubjectKind: Partial<Record<OutcomeSubjectKind, RealizationBucket>>;
}

/** Query shape of `summarizeRealization`. */
export interface SummarizeRealizationQuery {
  /** Narrow the rollup to one subject kind; omitted = all kinds. */
  subjectKind?: OutcomeSubjectKind;
}

// =====================================================================
// W053 — CompanyModel Learning (ADR-0016)
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W053):
// "Implement the versioned CompanyModel per ADR-0016: durable
//  company-specific learning stores vocabulary, organization, process
//  exceptions, source reliability, employee expertise, capability patterns,
//  investigation preferences and intervention priors; every learned
//  assertion has provenance, confidence, validity and version; learned
//  preference never overrides policy; provider/model replacement preserves
//  learned state; longitudinal testing shows measurable improvement."
//
// The CompanyModel is durable company-specific learning BEYOND raw memories
// (memory W010) and distinct from beliefs (epistemics W007): it is not a
// claim about the world's truth — it is versioned working knowledge about
// HOW THIS COMPANY works (its vocabulary, organization, process exceptions,
// source reliability, employee expertise, capability patterns, goal
// interpretation, investigation preferences, intervention priors and
// organizational norms). It is "never authoritative merely because it was
// learned": explicit policy stays authoritative, and every assertion keeps
// provenance so it can always be traced back to evidence, outcomes and
// validated interactions.
// ============================================================================

/**
 * The ten ADR-0016 knowledge areas of the CompanyModel (mirrored by the
 * migration 002 CHECK and validation.ts):
 *  * 'vocabulary'             — company vocabulary and semantic conventions;
 *  * 'organization'           — organizational structure and role relationships;
 *  * 'process_exception'      — process patterns and documented-versus-observed exceptions;
 *  * 'source_reliability'     — source reliability and freshness characteristics;
 *  * 'employee_expertise'     — employee expertise and transactive-memory signals;
 *  * 'capability_pattern'     — capability patterns and known capability gaps;
 *  * 'goal_interpretation'    — goal interpretation and priority patterns;
 *  * 'investigation_preference' — investigation and source-selection preferences;
 *  * 'intervention_prior'     — intervention effectiveness priors (ADR-0019);
 *  * 'organizational_norm'    — recurring organizational norms and exceptions.
 */
export type CompanyModelArea =
  | 'vocabulary'
  | 'organization'
  | 'process_exception'
  | 'source_reliability'
  | 'employee_expertise'
  | 'capability_pattern'
  | 'goal_interpretation'
  | 'investigation_preference'
  | 'intervention_prior'
  | 'organizational_norm';

/**
 * What a CompanyModel assertion can be about: a provider-neutral subject
 * kind (the owning module stays the verification point — opaque forward
 * references, the W040 subjects precedent). Record-backed subjects
 * (employee, team, role, source, process, capability, goal, agent) carry
 * the owning record's uuid; 'term' and 'intervention' may instead carry a
 * stable name (there is no record yet); 'company' is company-wide.
 */
export type CompanyModelSubjectKind =
  | 'company'
  | 'term'
  | 'employee'
  | 'team'
  | 'role'
  | 'source'
  | 'process'
  | 'capability'
  | 'goal'
  | 'intervention'
  | 'agent';

/** The resolved subject of one learned assertion (view shape). */
export interface CompanyModelSubject {
  kind: CompanyModelSubjectKind;
  /** The normalized stable key: '<kind>:<uuid>' | '<kind>:<slug>' | 'company'. */
  key: string;
  label: string | null;
}

/** Input shape of `CompanyModelSubject` (exactly one of id/name, per kind). */
export interface CompanyModelSubjectInput {
  kind: CompanyModelSubjectKind;
  /** The owning record's uuid (record-backed subjects). */
  id?: string | null;
  /** A stable name for record-less subjects (terms, intervention patterns). */
  name?: string | null;
  label?: string | null;
}

/** Whether an assertion version states knowledge or retracts it. */
export type AssertionDisposition = 'asserted' | 'retracted';

/**
 * Provenance kinds of a learned assertion: the W040 evidence kinds plus
 * 'interaction' (a validated interaction, e.g. a confirmed exchange) and
 * 'contribution' (an employee knowledge contribution — W042's records,
 * referenced opaquely until that item lands).
 */
export type AssertionProvenanceKind =
  | 'observation'
  | 'event'
  | 'document'
  | 'report'
  | 'system'
  | 'metric'
  | 'interaction'
  | 'contribution';

/** One provenance reference of a learned assertion (traceable: id and/or label). */
export interface AssertionProvenanceRef {
  kind: AssertionProvenanceKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `AssertionProvenanceRef`. */
export interface AssertionProvenanceRefInput {
  kind: AssertionProvenanceKind;
  id?: string | null;
  label?: string | null;
}

/**
 * The DERIVED lifecycle status of one assertion version (never stored):
 *  * 'active'    — the chain's current head, asserted, valid now (a member
 *                  of the effective CompanyModel and of every score);
 *  * 'pending'   — current head, asserted, but valid_from is in the future;
 *  * 'expired'   — current head, asserted, but valid_until has passed;
 *  * 'retracted' — current head whose disposition closes the chain;
 *  * 'superseded'— a historical version: a newer version exists in its chain.
 */
export type CompanyModelAssertionStatus =
  | 'active'
  | 'pending'
  | 'expired'
  | 'retracted'
  | 'superseded';

/** One change of a learning update: a new version of one assertion chain. */
export interface AssertionDeltaInput {
  area: CompanyModelArea;
  subject: CompanyModelSubjectInput;
  /** The specific dimension of the subject, e.g. 'reliability', 'definition'. */
  topic: string;
  /** The learned assertion payload (bounded JSON object). */
  statement: Record<string, unknown>;
  /** 0..1 — how confident Aurum is in this assertion. */
  confidence: number;
  /** Defaults to 'asserted'; 'retracted' closes the chain. */
  disposition?: AssertionDisposition;
  /** ISO 8601; defaults to the service clock's now. */
  validFrom?: string | null;
  /** ISO 8601, exclusive; null = open-ended. */
  validUntil?: string | null;
  /** Opaque evidence references supporting the assertion. */
  evidence?: AssertionProvenanceRefInput[];
  /** The W040 outcome this assertion was learned from (optional per delta). */
  outcomeId?: string | null;
}

/** Input shape of `recordLearningUpdate` — the ONE CompanyModel mutation. */
export interface RecordLearningUpdateInput {
  /** 1..16 assertion deltas; two deltas may not touch the same chain. */
  changes: AssertionDeltaInput[];
  /** Required: what changed and why (ADR-0016's learning invariant). */
  rationale: string;
  /** Who is recording the update (audit trail). */
  actor: OutcomePartyInput;
}

/** One learned assertion version — the full ADR-0016 record. */
export interface CompanyModelAssertion {
  id: string;
  tenantId: string;
  area: CompanyModelArea;
  subject: CompanyModelSubject;
  topic: string;
  statement: Record<string, unknown>;
  confidence: number;
  disposition: AssertionDisposition;
  /** Derived (never stored): see `CompanyModelAssertionStatus`. */
  status: CompanyModelAssertionStatus;
  /** ISO 8601 — active during [validFrom, validUntil). */
  validFrom: string;
  validUntil: string | null;
  /** Learning/version metadata: the chain position of this version. */
  version: number;
  supersedesId: string | null;
  updateId: string;
  /** Provenance: evidence refs and/or the outcome this was learned from. */
  provenance: {
    evidence: AssertionProvenanceRef[];
    outcomeId: string | null;
  };
  /** The authenticated TenantContext principal that committed the version. */
  recordedByPrincipal: string;
  /** ISO 8601 — when this version was committed (service clock). */
  recordedAt: string;
  /** The recorded learning update that minted this version. */
  change: {
    updateId: string;
    modelVersion: number;
    rationale: string;
    actor: OutcomeActor;
    changedByPrincipal: string;
    recordedAt: string;
  };
}

/** One recorded learning update (the change-set view). */
export interface LearningUpdate {
  id: string;
  tenantId: string;
  /** The tenant-monotonic CompanyModel version this update minted. */
  modelVersion: number;
  rationale: string;
  actor: OutcomeActor;
  recordedByPrincipal: string;
  recordedAt: string;
  /** The assertion versions this update appended. */
  changes: Array<{
    assertionId: string;
    area: CompanyModelArea;
    subject: CompanyModelSubject;
    topic: string;
    version: number;
    disposition: AssertionDisposition;
  }>;
  /** The distinct W040 outcomes this update's assertions were learned from. */
  linkedOutcomeIds: string[];
}

/** The current CompanyModel of a tenant (the derived effective view). */
export interface CompanyModel {
  tenantId: string;
  /** The latest minted model version (0 when nothing has been learned). */
  modelVersion: number;
  /** How many assertions the returned view holds. */
  assertionCount: number;
  /** The distinct areas present in the returned view. */
  areas: CompanyModelArea[];
  assertions: CompanyModelAssertion[];
  /** ISO 8601 — when the view was derived (service clock). */
  generatedAt: string;
}

/** Query shape of `getCompanyModel`. */
export interface GetCompanyModelQuery {
  /** Narrow the view to these areas; omitted = every area. */
  areas?: CompanyModelArea[];
  /**
   * Include current-head assertions that are not effective right now
   * (pending, expired, retracted); default false — only 'active'.
   */
  includeInactive?: boolean;
}

/** Query shape of `listCompanyModelAssertions`. */
export interface ListCompanyAssertionsQuery {
  area?: CompanyModelArea;
  subjectKind?: CompanyModelSubjectKind;
  /** Exact subject-key match, e.g. 'source:0b2f…'. */
  subjectKey?: string;
  /** Exact topic match. */
  topic?: string;
  status?: CompanyModelAssertionStatus;
  /** Assertions learned from this W040 outcome. */
  outcomeId?: string;
  /** Assertions appended by this learning update. */
  updateId?: string;
  /** Case-insensitive substring on topic or subject label. */
  search?: string;
=======
// ---------------------------------------------------------------------------
// W041 — Company Learning (versioned usefulness/preferences)
// ---------------------------------------------------------------------------
//
// The work item: "Version company-specific usefulness/preferences from
// explicit, behavioral and outcome feedback without mutating policy
// silently." (DAG: W040 → W041; ADR-0016 normative.)
//
// A CompanyLearning is ONE company-specific version chain: the subject is a
// (target, aspect) pair — an opaque forward reference to the entity the
// usefulness/preference is about (a source, a person, an agent, an
// extension, a mission, a channel, a process or a capability — the owning
// module stays the verification point, no cross-module FK, the W040 subject
// precedent) plus the aspect being versioned ('source-reliability',
// 'preferred-channel', 'usefulness', ... an open slug vocabulary; W053's
// CompanyModel owns the taxonomy). Each recorded feedback event appends ONE
// version — the learned assertion — and never rewrites history: "what
// changed" is the retained previous version, "why" is the required reason
// (ADR-0016's learning invariant). The current version of a chain is the
// maximum version, DERIVED (never stored, the W040 discipline).
//
// Feedback legs (the item's three channels):
//  * 'explicit'    — a stated usefulness/preference by an actor;
//  * 'behavioral'  — observed behavior, which MUST cite at least one
//                    evidence reference (behavior is only learnable from
//                    evidence);
//  * 'outcome'     — feedback grounded in a SETTLED outcome (W040, this
//                    module): the outcome id is validated same-tenant at
//                    write time and the frozen met/exceeded/missed
//                    assessment is snapshotted onto the version, so the
//                    feedback signal stays self-contained. This is the W040
//                    → W041 dependency made behavioral, not just declared.
//
// POLICY NON-AUTHORITY (lock 14; ADR-0016 "Explicit policy remains
// authoritative over learned preference"): every version read exposes
// `authoritative: false` — a system-minted constant. There is no input
// field that could set it (validation rejects unknown keys), no operation
// in this module touches any policy surface, and versions are append-only:
// a learned preference can never silently override or mutate policy.

/** Which leg produced one version: the item's three feedback channels. */
export type LearningFeedbackChannel = 'explicit' | 'behavioral' | 'outcome';

/**
 * What a company-specific usefulness/preference is versioned FOR: an
 * opaque uuid forward reference to the entity — the target module
 * (sources, people, agents, extensions, missions, channels, processes,
 * capabilities) remains the verification point. Company-specific means
 * tenant-scoped: the same target in two tenants is two chains.
 */
export type LearningTargetKind =
  | 'source'
  | 'person'
  | 'agent'
  | 'extension'
  | 'mission'
  | 'channel'
  | 'process'
  | 'capability';

/** The subject a usefulness/preference is versioned for (opaque forward reference). */
export interface LearningTarget {
  kind: LearningTargetKind;
  id: string;
  label?: string | null;
}

/** Input shape of `LearningTarget`. */
export interface LearningTargetInput {
  kind: LearningTargetKind;
  id: string;
  label?: string | null;
}

/** The actor that supplied one feedback event (the module's party vocabulary). */
export type LearningActor = OutcomeParty;

/** One evidence reference cited by a feedback event (the module's vocabulary). */
export type LearningEvidenceRef = OutcomeEvidenceRef;

/**
 * The validity of a chain's current version at read time, derived from the
 * current version's validity interval: 'active' while valid_until is null
 * or not yet elapsed, 'expired' afterwards. An expired chain is not dead —
 * new feedback appends a new version (the W040 "tie to a new outcome"
 * precedent; there is no terminal transition because a preference has no
 * terminal state, only superseded and expired versions).
 */
export type LearningStatus = 'active' | 'expired';

/**
 * One learned assertion — one append-only version of a company learning
 * chain (ADR-0016: "Each learned assertion has provenance, confidence,
 * validity interval and learning/version metadata").
 */
export interface CompanyLearningVersion {
  id: string;
  tenantId: string;
  /** The chain this version belongs to. */
  learningId: string;
  /** 1-based, monotonic per chain; the current version is the maximum. */
  version: number;
  /** Derived: this is the chain's maximum version. */
  isCurrent: boolean;
  /** Which feedback leg produced this version. */
  channel: LearningFeedbackChannel;
  /** The learned assertion's content — any plain JSON value (a score, a preference object, ...). */
  value: unknown;
  /** 0..1 — how much to trust this assertion (ADR-0016 confidence metadata). */
  confidence: number;
  /** Where the feedback came from (opaque references; required non-empty for behavioral feedback). */
  evidence: LearningEvidenceRef[];
  /** The settled outcome this version's feedback is grounded in (outcome channel only). */
  outcomeId: string | null;
  /** The outcome's frozen assessment, snapshotted at version time (outcome channel only). */
  outcomeAssessment: OutcomeAssessment | null;
  /** REQUIRED: why this learning update happened (ADR-0016's learning invariant). */
  reason: string;
  /** ISO 8601 — when this version became valid (the service clock's stamp). */
  validFrom: string;
  /** Optional ISO date (YYYY-MM-DD) through which the assertion holds; null = no stated end. */
  validUntil: string | null;
  /** Who supplied the feedback (domain provenance). */
  actor: LearningActor;
  /** The authenticated TenantContext principal that committed this version. */
  recordedByPrincipal: string;
  /** ISO 8601 — when Aurum committed this version (service clock). */
  recordedAt: string;
  /**
   * ALWAYS false (system-minted): a learned assertion is never authoritative
   * — explicit policy remains authoritative over learned preference
   * (lock 14, ADR-0016). Consumers must defer to policy.
   */
  authoritative: false;
}

/** Input shape of `recordCompanyLearning` — one feedback event → one new version. */
export interface RecordCompanyLearningInput {
  /** The company-specific subject this feedback is about. */
  target: LearningTargetInput;
  /** The aspect of the target being versioned (open slug vocabulary, e.g. 'source-reliability'). */
  aspect: string;
  /** The learned assertion's content — any plain JSON value. */
  value: unknown;
  /** 0..1 confidence in the assertion. */
  confidence: number;
  /** Which feedback leg produced this version. */
  channel: LearningFeedbackChannel;
  /** REQUIRED: why this learning update happened ("what changed" is the retained previous version). */
  reason: string;
  /**
   * Opaque evidence references. REQUIRED non-empty for behavioral feedback
   * (observed behavior is only learnable from evidence); optional otherwise.
   */
  evidence?: LearningEvidenceRef[];
  /**
   * REQUIRED for channel='outcome': the SETTLED W040 outcome the feedback
   * is grounded in (validated same-tenant at write time). Must be absent
   * for the other channels.
   */
  outcomeId?: string | null;
  /** Optional ISO date (YYYY-MM-DD) through which the learned assertion holds. */
  validUntil?: string | null;
  /** Who supplied the feedback (audit trail). */
  actor: OutcomePartyInput;
}

/**
 * The current view of one company learning chain: the immutable subject
 * (target + aspect), the derived validity status, the current version (the
 * maximum), the previous version (so "what changed and why" is visible in
 * one read) and the version count.
 */
export interface CompanyLearning {
  id: string;
  tenantId: string;
  target: LearningTarget;
  aspect: string;
  /** Derived at read time from the current version's validity interval. */
  status: LearningStatus;
  /** How many versions the chain holds (append-only history). */
  versionCount: number;
  /** The chain's maximum version — the current learned assertion. */
  currentVersion: CompanyLearningVersion;
  /** The version the current one superseded — the "what changed" half of the learning invariant; null on version 1. */
  previousVersion: CompanyLearningVersion | null;
  /** ISO 8601 — when the chain was created (its first version). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  lastUpdatedAt: string;
}

/** Query shape of `listCompanyLearnings` (over the derived current views). */
export interface ListCompanyLearningsQuery {
  targetKind?: LearningTargetKind;
  /** Requires `targetKind` (an id is meaningless without its kind). */
  targetId?: string;
  /** Exact aspect match (aspects are slugs). */
  aspect?: string;
  /** Filters on the CURRENT version's channel. */
  channel?: LearningFeedbackChannel;
  /** Filters on the derived current validity. */
  validity?: LearningStatus;  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listLearningUpdates`. */
export interface ListLearningUpdatesQuery {
  /** Case-insensitive substring on the rationale. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * The application domains of `rankCandidates` — the two canonical learned
 * prior families (both machine-readable through statement.score in [0,1]):
 *  * 'source_selection' — investigation source selection: applies
 *    ('source_reliability', 'reliability') assertions to candidate sources;
 *  * 'intervention'     — intervention recommendation: applies
 *    ('intervention_prior', 'effectiveness') assertions to candidate
 *    intervention patterns.
 */
export type CandidateDomain = 'source_selection' | 'intervention';

/** One candidate the CompanyModel's learned priors are applied to. */
export interface RankCandidateInput {
  kind: CompanyModelSubjectKind;
  /** The owning record's uuid (record-backed kinds). */
  id?: string | null;
  /** A stable name (record-less kinds, e.g. intervention patterns). */
  name?: string | null;
  label?: string | null;
  /** The caller's policy/workflow-level base score in [0,1]; default 0.5. */
  baseScore?: number;
}

/**
 * The explicit policy constraints the learned preference must respect —
 * the lock-14 mechanism made concrete. Learned priors can NEVER override
 * these: candidates of a kind policy does not allow are excluded from the
 * ranking no matter how reliable they have learned to be, and the policy's
 * kind precedence is a hard sort key ahead of every learned score.
 */
export interface RankPolicyConstraints {
  /** Candidate kinds explicit policy permits; omitted = no kind filter. */
  allowedKinds?: readonly string[];
  /** Hard policy ordering of kinds; omitted = a single tier. */
  kindPrecedence?: readonly string[];
}

/** Input shape of `rankCandidates`. */
export interface RankCandidatesInput {
  domain: CandidateDomain;
  /** 1..32 policy-vetted candidates; the surface never adds or removes any. */
  candidates: RankCandidateInput[];
  /** Explicit policy constraints; learned preference never overrides them. */
  policy?: RankPolicyConstraints;
}

/** The learned prior that was applied to one ranked candidate (attribution). */
export interface AppliedPrior {
  assertionId: string;
  version: number;
  confidence: number;
  learnedScore: number;
}

/** One scored + ordered candidate (the deterministic result row). */
export interface RankedCandidate {
  /** 1-based position in the deterministic order. */
  rank: number;
  key: string;
  kind: CompanyModelSubjectKind;
  label: string | null;
  /** The caller's base score (default 0.5 when not supplied). */
  baseScore: number;
  /** The combined score: base blended with the learned prior by confidence. */
  score: number;
  /** The learned prior's score, or null when no prior applied. */
  learnedScore: number | null;
  /** Which recorded assertion version produced `learnedScore` (audit trail). */
  appliedPrior: AppliedPrior | null;
  /** The policy precedence tier (0 when no precedence given). */
  policyTier: number;
  /** True when explicit policy excludes this candidate kind — always last. */
  policyExcluded: boolean;
}

/** Result shape of `rankCandidates`. */
export interface CompanyModelRanking {
  /** The CompanyModel version the ranking was derived from. */
  modelVersion: number;
  domain: CandidateDomain;
  candidates: RankedCandidate[];
/** Query shape of `listCompanyLearningVersions` (the chain's audit trail). */
export interface ListCompanyLearningVersionsQuery {
  learningId: string;}
