// Public domain types of the outcomes module (W054 — Capability Outcome
// Learning).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W054):
// "Implement intervention outcome learning per ADR-0019: interventions
//  establish baseline/expected/observed/realized outcome; realized value and
//  variance are recorded; failed interventions are retained as negative
//  evidence; later similar recommendations use learned intervention priors;
//  no hidden outcome labels may leak into recommendations."
//
// An Intervention is ADR-0019's "intervention record": one material
// capability-change act — the `authorization → deployment` stretch of the
// frozen §13 chain `process → capability → gap → acquisition option →
// authorization → deployment → outcome` — tied to exactly ONE measurable
// outcome owned by the learning module (W040). The outcome carries the
// ADR-0019 measurement legs (baseline, expected — frozen at definition time;
// the append-only observed series; the terminal realized value and variance),
// and the intervention record snapshots the definition at record time so the
// full chain reads from one place:
//
//   baseline → expected → intervention record → observed → realized →
//   variance/realized value → learning update (prior)
//
// The LEARNING UPDATE is `InterventionPrior`: an append-only, versioned,
// evidence-linked aggregate over the REALIZED interventions of one
// (intervention kind, capability key) — the explicit channel ADR-0019
// sanctions ("Future recommendations may improve only through explicit,
// evidence-linked learning updates"). It is deliberately the ONLY content on
// this module's recommendation-facing surface; per-intervention outcome
// labels (assessments, realized values) live on the evidence surfaces
// (getIntervention / listInterventions) and never on the prior reads.
//
// Like an outcome (W040), an intervention is planned work — NOT a belief and
// NOT evidence — and its definition is immutable: there is no revision
// operation, because the intervention record must commit to what it expected
// BEFORE the outcome settles (the same prediction-hygiene reason the learning
// module freezes `expected` at definition time). Lifecycle is three derived
// states: 'active' (recorded against an open outcome), 'realized' (terminal:
// the outcome settled; realized value, variance and assessment frozen onto
// the intervention; positive or negative evidence) and 'abandoned'
// (terminal, with a required reason; contributes NO evidence to priors).
//
// Provider neutrality (lock 16): the intervention's target, originating
// goals, originating recommendation, authorization reference and originating
// execution are opaque forward references — kind + uuid id and/or human
// label — owned by their respective modules. The ONE validated cross-module
// link is the measuring outcome, checked readable (and open) through the
// learning contract at record time — the sanctioned W040 → W054 dependency
// the learning module's contract header anticipates.

/** The intervention kinds — ARCHITECTURE.md §13's acquisition options. */
export type InterventionKind =
  | 'train_employee'
  | 'reassign_work'
  | 'hire_human'
  | 'recruit_agent'
  | 'recruit_agent_team'
  | 'install_extension'
  | 'build_extension'
  | 'outsource';

/**
 * Lifecycle of an intervention, DERIVED from the terminal record (never
 * stored on the definition row): no terminal record = 'active'; a terminal
 * record is a dead end, exactly like a settled/abandoned outcome.
 */
export type InterventionStatus = 'active' | 'realized' | 'abandoned';

/**
 * The deterministic realized-versus-expected verdict, consumed from the
 * learning module's FROZEN outcome realization (never re-derived here) —
 * the same vocabulary W040 freezes at settle time.
 */
export type InterventionAssessment = 'met' | 'exceeded' | 'missed';

/**
 * The evidence polarity of a realized intervention: 'positive' when the
 * outcome's frozen assessment is met/exceeded, 'negative' when it is
 * missed. Failed interventions are RETAINED as negative evidence
 * (ADR-0019) — there is no operation to discard or exclude them.
 */
export type EvidencePolarity = 'positive' | 'negative';

/** Kinds of parties that can record, realize or abandon an intervention. */
export type InterventionPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — the party must be traceable (the missions actor rule).
 */
export interface InterventionParty {
  kind: InterventionPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `InterventionParty`. */
export interface InterventionPartyInput {
  kind: InterventionPartyKind;
  id?: string | null;
  label?: string | null;
}

/** The party that made one intervention change (`InterventionParty`). */
export type InterventionActor = InterventionParty;

/**
 * The intervention's target: the module-owned record this capability change
 * acts on — an automation opportunity (W018), an agent-recruitment proposal
 * (W022), an agent team (W023), an extension build (W027), an agent
 * (W021), an extension (W025), a process, a person, a supplier, …
 * Deliberately an OPAQUE forward reference: those modules own the
 * verification point; this module creates no cross-module foreign keys and
 * imports no contract for targets. `kind` is an open slug (the owner's
 * vocabulary); at least one of `id`/`label` must be present when a target
 * is given, so the reference is traceable.
 */
export interface InterventionTarget {
  kind: string;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `InterventionTarget`. */
export interface InterventionTargetInput {
  kind: string;
  id?: string | null;
  label?: string | null;
}

/**
 * One originating-goal reference (the missions/learning precedent): an
 * opaque uuid forward reference to a goals module (W008) record plus an
 * optional human label. ADR-0019: outcomes (and therefore the interventions
 * they measure) are "linked to the originating goal".
 */
export interface InterventionGoalRef {
  goalId: string;
  label?: string | null;
}

/** Input shape of `InterventionGoalRef`. */
export interface InterventionGoalRefInput {
  goalId: string;
  label?: string | null;
}

/**
 * The authorization reference: the opaque record of the human/policy
 * decision that authorized this intervention — an actions module (W009)
 * approval request/decision, or any equivalent authorization artifact the
 * tenant uses. Opaque forward reference (actions is not a declared W054
 * dependency; no validated link), traceable like every other reference.
 */
export interface InterventionAuthorizationRef {
  kind: string;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `InterventionAuthorizationRef`. */
export interface InterventionAuthorizationRefInput {
  kind: string;
  id?: string | null;
  label?: string | null;
}

/**
 * The measuring-outcome definition snapshot, copied from the learning
 * module's IMMUTABLE outcome definition at record time — the baseline and
 * the expected outcome the intervention commits to (ADR-0019's first two
 * legs). System-minted: never caller-supplied, never editable afterwards.
 */
export interface InterventionMetric {
  metricName: string;
  metricUnit: string;
  direction: 'at_least' | 'at_most';
  baseline: number;
  expected: number;
}

/**
 * The frozen realized record on a terminal 'realized' intervention —
 * consumed from the learning module's FROZEN outcome realization (never
 * re-derived): realized value, variance vs expected, improvement vs
 * baseline, the deterministic assessment and the evidence polarity.
 */
export interface InterventionRealization {
  /** The realized metric value — the outcome's frozen realized value. */
  realizedValue: number;
  /** realized − expected (signed, in metric units). */
  varianceVsExpected: number;
  /** realized − baseline (signed, in metric units). */
  improvementVsBaseline: number;
  /** The learning module's frozen deterministic verdict. */
  assessment: InterventionAssessment;
  /** positive ⇔ met/exceeded; negative ⇔ missed (retained evidence). */
  polarity: EvidencePolarity;
  /** The outcome measurement this realization is grounded in. */
  fromMeasurementId: string;
  /** ISO 8601 — when the measuring outcome was settled (learning clock). */
  outcomeSettledAt: string;
  /** Optional context recorded at realize time. */
  note: string | null;
  /** Who realized (domain provenance). */
  actor: InterventionActor;
  /** The authenticated TenantContext principal that committed the realization. */
  realizedByPrincipal: string;
  /** ISO 8601 — when the realization was committed (service clock). */
  realizedAt: string;
}

/**
 * The live observed-outcome summary composed through the learning contract
 * (never the learning tables): the outcome's derived status and its
 * observation-series state — the "observed outcome" leg of the ADR-0019
 * chain, fresh at read time.
 */
export interface InterventionOutcomeSummary {
  outcomeId: string;
  /** The learning module's derived outcome status. */
  status: 'open' | 'settled' | 'abandoned';
  /** How many measurements the observation series holds. */
  measurementCount: number;
  /** The most recently observed value, if any. */
  latestObservedValue: number | null;
}

/**
 * The current view of an intervention: the immutable definition (kind,
 * capability, origin links, measuring outcome + snapshot), the derived
 * lifecycle state, the frozen realization (once terminal) and the live
 * observed-outcome summary.
 */
export interface Intervention {
  id: string;
  tenantId: string;
  kind: InterventionKind;
  /** The deterministic similarity key (see `normalizeCapabilityKey`). */
  capabilityKey: string;
  /** The human-readable capability label the key was derived from. */
  capabilityLabel: string;
  /** Opaque forward reference to the acted-on record, when precise. */
  target: InterventionTarget | null;
  /** Opaque originating-goal references (ADR-0019's goal link). */
  originGoalIds: InterventionGoalRef[];
  /** Opaque originating-recommendation reference (ADR-0019's recommendation link). */
  originRecommendationId: string | null;
  /** Opaque authorization reference (ADR-0019's authorization link). */
  authorizationRef: InterventionAuthorizationRef | null;
  /** Opaque originating cognitive-execution reference (ADR-0019's execution link). */
  originExecutionId: string | null;
  /** The learning module (W040) outcome that measures this intervention. */
  outcomeId: string;
  /** The definition snapshot (baseline/expected committed at record time). */
  metric: InterventionMetric;
  /** Derived: terminal ⇔ realization or abandonment is non-null. */
  status: InterventionStatus;
  /** The frozen realized record; null while active or abandoned. */
  realization: InterventionRealization | null;
  /** Why the intervention was abandoned, once it was (terminal audit). */
  abandonment: {
    reason: string;
    actor: InterventionActor;
    abandonedByPrincipal: string;
    abandonedAt: string;
  } | null;
  /** The live observed-outcome summary (composed via the learning contract). */
  outcomeSummary: InterventionOutcomeSummary;
  /** Why — recorded on the definition. */
  rationale: string | null;
  /** Who recorded the intervention (audit trail). */
  actor: InterventionActor;
  /** The authenticated TenantContext principal that recorded it. */
  recordedByPrincipal: string;
  /** ISO 8601 — when the definition was committed. */
  createdAt: string;
}

/**
 * One versioned INTERVENTION PRIOR — ADR-0019's explicit, evidence-linked
 * learning update: the aggregate learned experience over every REALIZED
 * intervention of one (intervention kind, capability key), appended by
 * `realizeIntervention` and never edited afterwards. This record (and only
 * this record) is the module's recommendation-facing content: aggregates
 * and evidence REFERENCES — never per-intervention outcome labels.
 */
export interface InterventionPrior {
  id: string;
  tenantId: string;
  interventionKind: InterventionKind;
  capabilityKey: string;
  /** 1-based, per (tenant, kind, key); every realization appends one version. */
  priorVersion: number;
  /** Realized interventions in the sample (abandoned ones never count). */
  sampleSize: number;
  /** Realized interventions whose outcome assessment was met/exceeded. */
  successes: number;
  /** Realized interventions whose outcome assessment was missed — retained negative evidence. */
  failures: number;
  /** successes / sampleSize, in [0, 1]. */
  successRate: number;
  /** Arithmetic sum of the sample's expected values (mixed metric units — the caller's interpretation). */
  expectedSum: number;
  /** Arithmetic sum of the sample's realized values. */
  realizedSum: number;
  /** Sum of (realized − expected) over the sample. */
  netVariance: number;
  /** netVariance / sampleSize — the learned expected-value correction. */
  meanVariance: number;
  /** The intervention whose realization triggered this update. */
  triggeredByInterventionId: string;
  /** Every realized intervention id in the sample, ascending by realization time — the evidence links. */
  evidenceInterventionIds: string[];
  /** Who realized the triggering intervention (the update's provenance). */
  actor: InterventionActor;
  /** The authenticated TenantContext principal that committed the update. */
  updatedByPrincipal: string;
  /** ISO 8601 — when the learning update was committed. */
  updatedAt: string;
}

/** Input shape of `recordIntervention` (status is minted 'active'). */
export interface RecordInterventionInput {
  /** The acquisition option this intervention executes (§13's vocabulary). */
  kind: InterventionKind;
  /** The capability being changed, human-readable (the key is derived). */
  capabilityLabel: string;
  /** Optional opaque reference to the acted-on record. */
  target?: InterventionTargetInput | null;
  /** Defaults to `[]` (opaque forward references to goals W008 records). */
  originGoalIds?: InterventionGoalRefInput[];
  /** Opaque reference to the recommendation that proposed this intervention. */
  originRecommendationId?: string | null;
  /** Opaque reference to the authorization that approved execution. */
  authorizationRef?: InterventionAuthorizationRefInput | null;
  /** Opaque reference to the originating cognitive execution (W013). */
  originExecutionId?: string | null;
  /**
   * The learning module (W040) outcome that measures this intervention —
   * the ONE validated cross-module link. Must exist, be readable in this
   * tenant and still be OPEN: the intervention record is committed before
   * realization (ADR-0019's chain), and the outcome's immutable definition
   * is what makes the prediction honest.
   */
  outcomeId: string;
  /** Who is recording the intervention (audit trail). */
  actor: InterventionPartyInput;
  /** Why — optional, recorded on the definition. */
  rationale?: string | null;
}

/** Input shape of `realizeIntervention` (active → realized, terminal). */
export interface RealizeInterventionInput {
  interventionId: string;
  /** Optional context recorded on the frozen realization. */
  note?: string | null;
  /** Who realizes (audit trail). */
  actor: InterventionPartyInput;
}

/** Input shape of `abandonIntervention` (active → abandoned, terminal). */
export interface AbandonInterventionInput {
  interventionId: string;
  /** Required: why — terminal transitions record their why. */
  reason: string;
  /** Who abandons (audit trail). */
  actor: InterventionPartyInput;
}

/** Query shape of `listInterventions` (over the derived current views). */
export interface ListInterventionsQuery {
  interventionKind?: InterventionKind;
  /** Normalized with the same deterministic normalizer at query time. */
  capabilityKey?: string;
  status?: InterventionStatus;
  /** Only meaningful with status='realized' (only realizations have polarity). */
  polarity?: EvidencePolarity;
  /** Interventions measured by this learning-module outcome. */
  outcomeId?: string;
  /** Case-insensitive substring on the capability label. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * Query shape of `getInterventionPriors` — the RECOMMENDATION-facing read:
 * the current prior per matching (intervention kind, capability key). A
 * key with no realized interventions has NO prior row at all (that is the
 * cold, no-evidence state).
 */
export interface GetInterventionPriorsQuery {
  /** Omitted = every kind with learned evidence for the key. */
  interventionKind?: InterventionKind;
  /** Normalized with the same deterministic normalizer at query time. */
  capabilityKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * Query shape of `listInterventionPriorVersions` — the append-only version
 * history of ONE prior (the evidence/audit surface of the learning
 * updates). Kind and key are required: a history is one prior's history.
 */
export interface ListInterventionPriorVersionsQuery {
  interventionKind: InterventionKind;
  /** Normalized with the same deterministic normalizer at query time. */
  capabilityKey: string;
  /** 1..500, default 50. */
  limit?: number;
}
