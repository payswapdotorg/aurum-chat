// Public domain types of the opportunities module (W015 — Opportunity
// Engine).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W015):
// "Convert external/internal signals into evidence-backed opportunities
//  with estimated value, confidence, affected goals and required
//  capabilities."
//
// ARCHITECTURE.md §12 (frozen) decides the semantics:
//
//   "External intelligence follows:
//    `external signal → observation → claim → company relationship →
//     impact analysis → opportunity/risk → attention decision → mission or
//     recommendation`."
//
//   "Opportunity is a first-class object with evidence, estimated value,
//    confidence, affected goals, required capability and recommended next
//    action."
//
// An Opportunity is therefore DERIVED INTELLIGENCE, never authoritative
// truth (lock 10): it is the output of IMPACT ANALYSIS over immutable
// evidence — the observations (W004) the signals were recorded as and the
// claims (W007) they were derived into. Like every other piece of
// understanding in this system (goals W008, missions W011, processes W016,
// capabilities W017), an opportunity is an IDENTITY plus an append-only
// chain of full-snapshot VERSIONS: what Aurum understood about the
// opportunity at any time stays reconstructable (§24 decision evidence),
// and revisions never rewrite history.
//
// What each field IS:
//   * evidence        — the signal chain's immutable links: observation ids
//                       and claim ids, validated readable through their
//                       contracts at write time, plus the confidence
//                       snapshot each carried at commit (self-contained
//                       versions). At least one reference is required: an
//                       opportunity is never derived from nothing.
//   * confidence      — DERIVED BY THE APPLICATION, never supplied by the
//                       caller (lock 10: no LLM asserts the confidence of
//                       its own output). The derivation (derivation.ts) is
//                       deterministic: the weakest cited evidence
//                       confidence, plus a bounded corroboration bonus per
//                       additional distinct evidence reference, capped
//                       below certainty.
//   * estimatedValue  — management's honest estimate of the value of
//                       pursuing the opportunity: integer minor units + ISO
//                       4217 currency (IMPLEMENTATION-STACK §8). This and
//                       the title/description/goal links/capability needs/
//                       next action are the bounded-reasoning seam — the
//                       judgment the loop's analysis stage supplies; the
//                       application validates, gates, derives, persists
//                       and audits it.
//   * affectedGoals   — opaque forward references to goals module (W008)
//                       records, validated readable through the goals
//                       contract at write time, with the goal's title
//                       snapshotted as the label.
//   * requiredCapabilities — opaque forward references to capabilities
//                       module (W017) records (that module's own
//                       requirement-source design expects exactly this
//                       shape from the opportunity side), deliberately
//                       unvalidated here: W017 is not in this module's
//                       declared dependency set (WORK-ITEM-DEPENDENCY-
//                       GRAPH.md: W005 + W013 → W015) and capability
//                       records are mutable understanding, not evidence.
//   * worldEntities   — opaque forward references to world module (W005)
//                       entities (the "company relationship" step of §12's
//                       chain), unvalidated for the same reason — the
//                       processes module's worldEntityId precedent.
//   * recommendedNextAction — what §12's chain hands to the attention
//                       decision: keep monitoring, investigate (a learning
//                       mission should be considered) or recommend (surface
//                       to management). Recording it is W015's job; acting
//                       on it belongs to attention/cognition/actions.
//
// THE ENGINE is the conversion pass (W015's "Convert"): ONE explicit,
// durable `convertSignals` run over a batch of signal candidates — the
// attention module's discovery-run discipline. Each candidate is the
// bounded-reasoning seam's unit (the signals + the impact-analysis
// judgment); the application validates every reference, derives every
// confidence deterministically, applies the run's snapshotted
// recordability policy gate (a candidate below the minimum confidence or
// value is recorded `below_threshold`, one whose value currency does not
// match the policy's is recorded `currency_mismatch`, one whose exact
// evidence fingerprint is already carried by a LIVE opportunity is
// recorded `duplicate` — continuous conversion does not spam; re-analysis
// of the same signals is a REVISION of the existing opportunity), and
// persists what survives as evidence-backed opportunities. Runs and
// candidate decisions are append-only evidence of what Aurum converted
// and why (§24).
//
// Provider neutrality (lock 16): actors are opaque party references — kind
// + uuid id and/or human label — owned by their respective modules. No
// provider object ever crosses this contract.

/** Where the converted signals came from (the item's "external/internal"). */
export type SignalOrigin = 'external' | 'internal';

/**
 * Lifecycle status of an opportunity. Lifecycle is VERSIONED content like
 * every other field (the goals W008 discipline): transitions append a
 * surgical version, so lifecycle changes are auditable too.
 *  * 'open'     — minted on creation; the live management surface state;
 *  * 'pursued'  — management decided to act (terminal — follow-through and
 *                 outcome measurement are W040's territory, not the
 *                 opportunity record's);
 *  * 'dismissed'— rejected; may be reactivated when the evidence is
 *                 re-analyzed (a dismissed opportunity does not block a
 *                 later conversion of the same signals).
 */
export type OpportunityStatus = 'open' | 'pursued' | 'dismissed';

/**
 * What kind of change one opportunity version represents — service-derived,
 * never caller-supplied:
 *  * 'created'      — version 1 (the conversion pass);
 *  * 'revised'      — content change on an open opportunity;
 *  * 'pursued'      — surgical open → pursued;
 *  * 'dismissed'    — surgical open → dismissed;
 *  * 'reactivated'  — surgical dismissed → open.
 */
export type OpportunityChangeKind =
  | 'created'
  | 'revised'
  | 'pursued'
  | 'dismissed'
  | 'reactivated';

/**
 * What started one conversion pass (the attention module's trigger
 * vocabulary, reused for cross-engine consistency).
 */
export type ConversionTriggerKind =
  | 'cognitive-execution' // a canonical loop's analysis stage drove it (originatingExecutionId required)
  | 'scheduled' // the engine's periodic sweep over accumulated signals
  | 'manual'; // an operator/worker invoked a pass

/**
 * The application's decision on one candidate (the recordability policy
 * gate's output):
 *  * 'converted'        — an evidence-backed opportunity was created;
 *  * 'below_threshold'  — below the run's minimum confidence or value;
 *  * 'currency_mismatch'— a value gate is set but the candidate's value is
 *                         in a different currency (not comparable);
 *  * 'duplicate'        — the exact evidence fingerprint is already carried
 *                         by a live (open or pursued) opportunity —
 *                         re-analysis revises that record instead.
 */
export type CandidateDisposition =
  | 'converted'
  | 'below_threshold'
  | 'currency_mismatch'
  | 'duplicate';

/**
 * The recommended next action §12 puts on the opportunity — the input to
 * the downstream attention decision:
 *  * 'monitor'    — keep watching (no action yet);
 *  * 'investigate'- a learning mission should be considered to sharpen the
 *                   estimate before acting;
 *  * 'recommend'  — surface a recommendation to management.
 */
export type NextActionKind = 'monitor' | 'investigate' | 'recommend';

/** Kinds of parties that can drive a conversion pass or a revision. */
export type OpportunityPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

// ---------------------------------------------------------------------------
// Shared reference shapes
// ---------------------------------------------------------------------------

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module (people for `person`, world for `team`, agents
 * for `agent`), a human-readable `label`, or both. At least one must be
 * present — whoever drives a conversion or revision must be traceable.
 */
export interface OpportunityParty {
  kind: OpportunityPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `OpportunityParty`. */
export interface OpportunityPartyInput {
  kind: OpportunityPartyKind;
  id?: string | null;
  label?: string | null;
}

/**
 * Money as integer minor units + ISO 4217 currency code
 * (IMPLEMENTATION-STACK §8) — here the ESTIMATED VALUE of pursuing the
 * opportunity. An estimate, never a booked amount.
 */
export interface Money {
  amount: number;
  currency: string;
}

/** Input shape of `Money`. */
export interface MoneyInput {
  amount: number;
  currency: string;
}

/** One piece of cited evidence with the confidence it carried at commit. */
export interface EvidenceConfidenceSnapshot {
  kind: 'observation' | 'claim';
  id: string;
  /** Inclusive [0, 1] — the value the evidence record carries (immutable). */
  value: number;
}

/**
 * The evidence basis of an opportunity version: the signal chain's links,
 * the support count and the confidence snapshot that made the derived
 * confidence reconstructable without re-reading the (immutable, so
 * re-readable anyway) evidence.
 */
export interface OpportunityEvidence {
  /** Observation ids (W004), sorted; validated readable at write time. */
  observationIds: string[];
  /** Claim ids (W007), sorted; validated readable at write time. */
  claimIds: string[];
  /** Distinct evidence references (`observationIds + claimIds`). */
  support: number;
  /** Each cited reference's confidence, snapshotted at commit. */
  confidences: EvidenceConfidenceSnapshot[];
}

/** Input shape of the evidence basis (at least one reference required). */
export interface EvidenceInput {
  observationIds?: string[];
  claimIds?: string[];
}

/**
 * One affected-goal reference: an opaque forward reference to a goals
 * module (W008) record, validated readable through the goals contract at
 * write time. `label` is the caller's label or the goal's snapshotted
 * title, so any version decodes alone.
 */
export interface OpportunityGoalRef {
  goalId: string;
  label: string | null;
}

/** Input shape of `OpportunityGoalRef` (label defaults to the goal title). */
export interface OpportunityGoalRefInput {
  goalId: string;
  label?: string | null;
}

/**
 * One required-capability reference: an opaque forward reference to a
 * capabilities module (W017) record. Deliberately unvalidated here (see the
 * file header); the capabilities module's requirement sources accept this
 * module's records the same opaque way.
 */
export interface CapabilityRef {
  capabilityId: string;
  label: string | null;
}

/** Input shape of `CapabilityRef`. */
export interface CapabilityRefInput {
  capabilityId: string;
  label?: string | null;
}

/**
 * One world-entity reference: an opaque forward reference to a world model
 * (W005) entity — the "company relationship" the impact analysis connected
 * the signals to. Unvalidated (the processes module's worldEntityId
 * precedent: world entities are mutable understanding, not evidence).
 */
export interface WorldEntityRef {
  entityId: string;
  label: string | null;
}

/** Input shape of `WorldEntityRef`. */
export interface WorldEntityRefInput {
  entityId: string;
  label?: string | null;
}

/** The recommended next action (§12) — see `NextActionKind`. */
export interface RecommendedNextAction {
  kind: NextActionKind;
  statement: string;
}

/** Input shape of `RecommendedNextAction`. */
export interface RecommendedNextActionInput {
  kind: NextActionKind;
  statement: string;
}

// ---------------------------------------------------------------------------
// The versioned content of an opportunity
// ---------------------------------------------------------------------------

/**
 * The full versioned content of an opportunity — everything §12/W015 puts
 * in the object. Identical shape on the conversion candidate's judgment
 * input, on every stored version and on reads, so any version is
 * self-contained. `confidence` and the evidence support/confidences are
 * DERIVED (never caller-supplied); `status` is minted 'open' on creation.
 */
export interface OpportunityContent {
  /** Short human name, e.g. "Expand document processing into DACH". */
  title: string;
  /** What the opportunity is and why it is one (the impact analysis). */
  description: string;
  /** Where the converted signals came from. */
  signalOrigin: SignalOrigin;
  /** The signal chain's immutable links + derived support/confidences. */
  evidence: OpportunityEvidence;
  /** Derived by the application (derivation.ts) — never caller-supplied. */
  confidence: number;
  /** Estimated value of pursuing, minor units + currency. */
  estimatedValue: Money;
  /** Goals this opportunity would advance (validated W008 records). */
  affectedGoals: OpportunityGoalRef[];
  /** Capabilities pursuing it would require (opaque W017 records). */
  requiredCapabilities: CapabilityRef[];
  /** Company world entities the signals relate to (opaque W005 records). */
  worldEntities: WorldEntityRef[];
  /** What §12's chain hands to the attention decision. */
  recommendedNextAction: RecommendedNextAction;
  /** Lifecycle status (always 'open' on creation; versioned afterwards). */
  status: OpportunityStatus;
}

/** One append-only version of an opportunity — the audit record (self-contained). */
export interface OpportunityVersion {
  /** Version-row id (distinct from the opportunity identity). */
  id: string;
  tenantId: string;
  opportunityId: string;
  /** 1-based, strictly increasing per opportunity; service-minted. */
  version: number;
  changeKind: OpportunityChangeKind;
  content: OpportunityContent;
  /**
   * The deterministic fingerprint of the evidence basis (derivation.ts):
   * the canonical identity of the SIGNAL SET the version was derived from.
   * Duplicate conversion detection compares these.
   */
  evidenceFingerprint: string;
  /** Who made this change (domain provenance). */
  actor: OpportunityParty;
  /** The authenticated TenantContext principal that committed this version. */
  changedByPrincipal: string;
  /** Why this change was made, if stated. */
  rationale: string | null;
  /** ISO 8601 — when Aurum committed this version (service clock). */
  recordedAt: string;
}

/**
 * The current view of an opportunity: identity + the current version's
 * content and audit summary. `version`/`updatedAt`/`lastChange` always
 * reflect the version `opportunities.current_version` points at.
 */
export interface Opportunity {
  id: string;
  tenantId: string;
  /** Current version number. */
  version: number;
  content: OpportunityContent;
  evidenceFingerprint: string;
  /** ISO 8601 — when the opportunity identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: {
    kind: OpportunityChangeKind;
    actor: OpportunityParty;
    changedByPrincipal: string;
    rationale: string | null;
    recordedAt: string;
  };
}

// ---------------------------------------------------------------------------
// The conversion pass (the engine)
// ---------------------------------------------------------------------------

/**
 * The recordability policy of one conversion pass — the deterministic
 * gate deciding which candidates become opportunities. Snapshotted onto
 * every run, so each conversion/dismissal is reconstructable against the
 * thresholds that governed it (auditable policy, not a silent judgment —
 * the attention module's materiality-policy precedent).
 */
export interface ConversionPolicy {
  /** Minimum derived confidence, [0, 1]. Default 0.5. */
  minConfidence: number;
  /** Minimum estimated value, or null for no value gate. Default null. */
  minValue: Money | null;
}

/** Input shape of `ConversionPolicy` (both optional; defaults applied). */
export interface ConversionPolicyInput {
  minConfidence?: number;
  minValue?: MoneyInput | null;
}

/**
 * One signal candidate — the bounded-reasoning seam's unit: the signals
 * (evidence references) plus the impact-analysis judgment. The application
 * validates the references, derives the confidence and support, applies
 * the policy gate and persists the decision; the judgment fields are the
 * caller's (the loop's analysis stage — ARCHITECTURE.md §19 names this
 * seam explicitly).
 */
export interface SignalCandidateInput {
  title: string;
  description: string;
  signalOrigin: SignalOrigin;
  /** ≥1 observation and/or claim reference in total. */
  evidence: EvidenceInput;
  estimatedValue: MoneyInput;
  /** Defaults to `[]`. */
  affectedGoals?: OpportunityGoalRefInput[];
  /** Defaults to `[]`. */
  requiredCapabilities?: CapabilityRefInput[];
  /** Defaults to `[]`. */
  worldEntities?: WorldEntityRefInput[];
  recommendedNextAction: RecommendedNextActionInput;
}

/**
 * The validated/derived form of one candidate as it is decided and
 * recorded on the run — self-contained: what was proposed, what the
 * application derived, what it decided and what it produced.
 */
export interface ConversionCandidate {
  id: string;
  tenantId: string;
  runId: string;
  disposition: CandidateDisposition;
  /** The proposed judgment (self-contained audit of what was considered). */
  title: string;
  description: string;
  signalOrigin: SignalOrigin;
  evidence: OpportunityEvidence;
  /** The deterministic evidence-set identity (see OpportunityVersion). */
  evidenceFingerprint: string;
  /** Derived by the application (derivation.ts). */
  confidence: number;
  estimatedValue: Money;
  affectedGoals: OpportunityGoalRef[];
  requiredCapabilities: CapabilityRef[];
  worldEntities: WorldEntityRef[];
  recommendedNextAction: RecommendedNextAction;
  /** Set when 'converted' — the created opportunity. */
  createdOpportunityId: string | null;
  /** Set when 'duplicate' — the live opportunity already carrying the signals. */
  existingOpportunityId: string | null;
  /** The deterministic gate explanation (why not converted), or null. */
  reason: string | null;
  /** ISO 8601 — when the decision was committed (with its run). */
  recordedAt: string;
}

/** Disposition counts of one run. */
export interface ConversionRunCounts {
  converted: number;
  belowThreshold: number;
  currencyMismatch: number;
  duplicate: number;
}

/**
 * ONE explicit, durable conversion pass: the engine's unit of work. It
 * snapshots the policy gate, names its trigger and actor, optionally
 * links the cognitive execution (W013) whose analysis stage drove it, and
 * carries its decided candidate chain. Runs are append-only: a pass is
 * evidence of what Aurum converted (§24).
 */
export interface ConversionRun {
  id: string;
  tenantId: string;
  triggerKind: ConversionTriggerKind;
  /** The originating execution link (required for 'cognitive-execution'). */
  originatingExecutionId: string | null;
  policy: ConversionPolicy;
  actor: OpportunityParty;
  /** The authenticated TenantContext principal that committed the run. */
  changedByPrincipal: string;
  rationale: string | null;
  /** ISO 8601 — when the run was committed (service clock). */
  recordedAt: string;
  counts: ConversionRunCounts;
  /** The decided candidate chain, in input order. */
  candidates: ConversionCandidate[];
}

/** The run feed summary (no candidate chain — deep-link it via getConversionRun). */
export interface ConversionRunSummary {
  id: string;
  tenantId: string;
  triggerKind: ConversionTriggerKind;
  originatingExecutionId: string | null;
  policy: ConversionPolicy;
  actor: OpportunityParty;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
  counts: ConversionRunCounts;
}

/** Input shape of `convertSignals`. */
export interface ConvertSignalsInput {
  trigger: {
    kind: ConversionTriggerKind;
  };
  /**
   * The originating cognitive execution (W013) — required for
   * 'cognitive-execution' triggers, optional otherwise. Validated readable
   * through the cognition contract at write time.
   */
  originatingExecutionId?: string | null;
  /** Defaults applied to both policy fields when `policy` is omitted. */
  policy?: ConversionPolicyInput;
  /** 1..MAX_CANDIDATES_PER_RUN candidates — a pass converts signals, it is never a no-op. */
  candidates: SignalCandidateInput[];
  /** Who drove the pass (audit trail). */
  actor: OpportunityPartyInput;
  /** Why — optional, recorded on the run. */
  rationale?: string | null;
}

/**
 * Input shape of `reviseOpportunity` — a PATCH against the current
 * version: omitted fields carry over unchanged; present fields replace
 * (arrays wholesale). A patch that sets `status` must set NOTHING else —
 * lifecycle transitions are surgical, so the audit trail never conflates
 * a content revision with a pursuit/dismissal/reactivation. `signalOrigin`
 * is deliberately NOT revisable: it is the conversion-time classification
 * of the signals the opportunity was derived from (reclassification is a
 * re-analysis with new evidence — a new opportunity). The confidence is
 * always re-derived from the (possibly carried-over) evidence set.
 */
export interface ReviseOpportunityInput {
  opportunityId: string;
  title?: string;
  description?: string;
  /** Replacement (wholesale), like the goals module's arrays. */
  evidence?: EvidenceInput;
  estimatedValue?: MoneyInput;
  /** Replacement (wholesale); re-validated through the goals contract. */
  affectedGoals?: OpportunityGoalRefInput[];
  /** Replacement (wholesale). */
  requiredCapabilities?: CapabilityRefInput[];
  /** Replacement (wholesale). */
  worldEntities?: WorldEntityRefInput[];
  recommendedNextAction?: RecommendedNextActionInput;
  /** Lifecycle transition; must be the ONLY changed field when present. */
  status?: OpportunityStatus;
  /** Optimistic concurrency: must equal the current version when set. */
  expectedVersion?: number;
  /** Who is making this change (audit trail). */
  actor: OpportunityPartyInput;
  /** Why — optional, recorded on the new version. */
  rationale?: string | null;
}

// ---------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------

/** Query shape of `getOpportunityVersion`. */
export interface GetOpportunityVersionQuery {
  opportunityId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listOpportunityVersions`. */
export interface ListOpportunityVersionsQuery {
  opportunityId: string;
}

/** Query shape of `listOpportunities` (over CURRENT versions only). */
export interface ListOpportunitiesQuery {
  status?: OpportunityStatus;
  signalOrigin?: SignalOrigin;
  /** Only opportunities at or above this confidence, in [0, 1]. */
  minConfidence?: number;
  /** Only opportunities affecting this goal (W008 record id). */
  goalId?: string;
  /** Only opportunities requiring this capability (W017 record id). */
  capabilityId?: string;
  /** Only opportunities relating to this world entity (W005 record id). */
  worldEntityId?: string;
  /** Case-insensitive substring on the title. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getConversionRun`. */
export interface GetConversionRunQuery {
  runId: string;
}

/** Query shape of `listConversionRuns`. */
export interface ListConversionRunsQuery {
  triggerKind?: ConversionTriggerKind;
  /** Filters runs originating from this cognitive execution. */
  originatingExecutionId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getConversionCandidate`. */
export interface GetConversionCandidateQuery {
  candidateId: string;
}
