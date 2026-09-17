// ============================================================================
// outcomes — the ONLY public surface of the outcomes module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W054 — Capability Outcome Learning:
// "Implement intervention outcome learning per ADR-0019: interventions
//  establish baseline/expected/observed/realized outcome; realized value and
//  variance are recorded; failed interventions are retained as negative
//  evidence; later similar recommendations use learned intervention priors;
//  no hidden outcome labels may leak into recommendations."
//
// THE INTERVENTION RECORD (ADR-0019's chain on one object): an Intervention
// is one material capability-change act — the `authorization → deployment`
// stretch of the frozen §13 chain `process → capability → gap → acquisition
// option → authorization → deployment → outcome` — tied to exactly ONE
// measurable outcome owned by the learning module (W040):
//
//   baseline → expected → intervention record → observed → realized →
//   variance/realized value → learning update (prior)
//
//   recordIntervention — commit the intervention against an OPEN learning
//      outcome (the ONE validated cross-module link, checked readable
//      through the learning contract — the sanctioned W040 → W054
//      dependency; the UNIQUE (tenant_id, outcome_id) makes the 1:1
//      measuring tie unrepresentable any other way). The service snapshots
//      the outcome's immutable definition (metric, direction, baseline,
//      EXPECTED) onto the record: the prediction is committed BEFORE
//      realization, the hygiene that keeps expected-versus-realized honest.
//      ADR-0019's originating links (goals, recommendation, authorization,
//      execution) and the acted-on target are opaque forward references —
//      at least one must be present, so every intervention is traceable to
//      its origin.
//   realizeIntervention — the one-way active → realized transition and
//      THE LEARNING UPDATE: requires the measuring outcome to have settled;
//      consumes the learning module's FROZEN realization (realized value,
//      variance vs expected, improvement vs baseline, assessment, grounding
//      measurement) — never a re-derivation — freezes it plus the evidence
//      polarity (positive ⇔ met/exceeded; negative ⇔ missed) onto the
//      terminal record, and atomically appends ONE versioned
//      intervention_priors row: the explicit, evidence-linked aggregate
//      over every realized intervention of the (kind, capability key).
//   abandonIntervention — the one-way active → abandoned transition with
//      a required reason. Only possible while the measuring outcome has
//      NOT settled: a settled outcome means the evidence exists, and
//      abandoning then would suppress it (failed interventions are
//      retained as negative evidence — there is no other delete or exclude
//      path, and the storage layer rejects UPDATE/DELETE/TRUNCATE on all
//      three tables outright).
//   getIntervention / listInterventions — the derived current views
//      (definition ⊕ terminal record ⊕ live observed-outcome summary
//      composed through the learning contract), filtered by kind,
//      capability key, status, evidence polarity (negative evidence stays
//      first-class queryable), measuring outcome and capability-label
//      search.
//
// THE LEARNED PRIORS (the only outcome→behavior channel):
//   getInterventionPriors — the RECOMMENDATION-FACING read: the current
//      prior per (intervention kind, capability key). A key with no
//      realized interventions has NO prior row at all — the cold,
//      no-evidence state. The rows carry aggregates (sample size,
//      successes, failures, success rate, expected/realized sums, net and
//      mean variance) and evidence REFERENCES (the contributing
//      intervention ids) — deliberately NOT per-intervention outcome
//      labels: hidden outcome labels may never leak into recommendations,
//      and those labels live on the evidence surfaces above.
//   listInterventionPriorVersions — the append-only version history of one
//      prior (the audit surface of the learning updates).
//   priorRecommendationSignal — the PURE deterministic derivation a later
//      similar recommendation applies to a recorded prior (stance by
//      success rate, evidence strength by sample size, the learned
//      mean-variance expected-value correction). Advisory only: learning
//      informs recommendation quality and never overrides policy (lock 14
//      — the W009 authority matrix stays the gate).
//
// NO-LEAK GUARANTEE (ADR-0019: "The learning update path is the ONLY
// channel from outcomes to future behavior"): the prior table has exactly
// one writer — realizeIntervention — and one recommendation-facing reader.
// Settling an outcome, recording measurements, abandoning outcomes: none
// of it moves the recommendation surface. Only the explicit, recorded
// learning update does, and each version row carries its provenance (the
// triggering intervention, the evidence ids, the acting principal). The
// ADR-0019 Required-verification fixture (tests/intervention-learning-
// fixture.test.ts) proves a successful and a failed intervention each
// change future recommendation quality without changing policy, and that
// no direct path from outcome labels to recommendations bypasses the
// recorded learning update.
//
// There is deliberately NO operation to redefine an intervention, rewrite
// a realization, un-realize, un-abandon or delete anything, and NO
// operation that writes priors outside a realization: predictions that
// could be edited after realization are worthless for calibration, failed
// evidence must stay retained, and the learning update path must stay the
// only outcome→behavior channel.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's
// interventions or priors (including realizing and abandoning by
// foreign-tenant intervention id) is reported as `intervention_not_found`
// — no existence leak. The measuring-outcome reference is uniformly
// `invalid_outcome_ref` for missing, malformed and foreign-tenant outcome
// ids.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W018 + W022 + W023 +
// W027 + W040 → W054): this module imports ONLY the learning contract
// (W040, delivered) — the measuring-outcome link the learning module's
// header explicitly anticipates ("W054 capability outcome learning …
// consume these records"). The W027 extension builder is delivered and is
// referenced opaquely (extension builds are targets, kind 'extension_
// build'); no acceptance criterion requires validating builder artifacts
// here. W018 (automation opportunities), W022 (agent recruitment) and
// W023 (agent teams) are NOT present in repository state at this base —
// their records are likewise opaque forward references (kind + id/label),
// which is the established cross-module discipline (the learning module's
// subject references); no dependency contract was consumed, so no
// escalation is required. The intervention-kind vocabulary itself is
// frozen architecture (ARCHITECTURE.md §13's acquisition options), not a
// dependency contract.
// ============================================================================

export {
  // The intervention record
  abandonIntervention,
  getIntervention,
  listInterventions,
  realizeIntervention,
  recordIntervention,
  // The learned priors
  getInterventionPriors,
  listInterventionPriorVersions,
} from './service';

export { OutcomesError } from './errors';
export type { OutcomesErrorCode } from './errors';

// The intervention-prior math and the recommendation-quality signal — the
// single deterministic definitions, pure and reusable by recommendation
// producers (W013 cognition, W053 CompanyModel, W056 simulator) and by
// verification (unit-tested in isolation; consumers read the RECORDED
// prior, the functions here derive what a recorded prior means).
export {
  computePriorUpdate,
  normalizeCapabilityKey,
  priorRecommendationSignal,
} from './validation';
export type {
  PriorAggregate,
  PriorRecommendationSignal,
  PriorSampleEntry,
} from './validation';

// Pure vocabularies and guards (no TenantContext needed).
export {
  EVIDENCE_POLARITIES,
  INTERVENTION_ASSESSMENTS,
  INTERVENTION_KINDS,
  INTERVENTION_PARTY_KINDS,
  INTERVENTION_STATUSES,
  isEvidencePolarity,
  isInterventionAssessment,
  isInterventionKind,
  isInterventionPartyKind,
  isInterventionStatus,
  isUuid,
} from './validation';

export {
  DEFAULT_LIST_LIMIT,
  MAX_AGGREGATE_VALUE,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_CAPABILITY_LABEL_LENGTH,
  MAX_GOAL_REFS,
  MAX_LIST_LIMIT,
  MAX_METRIC_VALUE,
  MAX_NOTE_LENGTH,
  MAX_PARTY_LABEL_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_REF_KIND_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_TARGET_LABEL_LENGTH,
} from './validation';

export type {
  ValidatedAbandonInput,
  ValidatedListInterventionsQuery,
  ValidatedParty,
  ValidatedPriorsQuery,
  ValidatedPriorVersionsQuery,
  ValidatedRealizeInput,
  ValidatedRecordInput,
} from './validation';

export type {
  AbandonInterventionInput,
  EvidencePolarity,
  GetInterventionPriorsQuery,
  Intervention,
  InterventionActor,
  InterventionAssessment,
  InterventionAuthorizationRef,
  InterventionAuthorizationRefInput,
  InterventionGoalRef,
  InterventionGoalRefInput,
  InterventionKind,
  InterventionMetric,
  InterventionOutcomeSummary,
  InterventionParty,
  InterventionPartyInput,
  InterventionPartyKind,
  InterventionPrior,
  InterventionRealization,
  InterventionStatus,
  InterventionTarget,
  InterventionTargetInput,
  ListInterventionPriorVersionsQuery,
  ListInterventionsQuery,
  RealizeInterventionInput,
  RecordInterventionInput,
} from './types';
