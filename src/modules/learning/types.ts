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
