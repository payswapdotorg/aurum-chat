// Public domain types of the epistemics module (W007 — Epistemics).
//
// The five first-class concepts (ARCHITECTURE.md §4/§11, locks 6, 7, 11, 12):
//
//   Claim        — a proposition derived from evidence. Immutable and
//                  append-only: a claim records WHAT was derived from WHICH
//                  evidence (≥1 readable observation) with what confidence,
//                  at commit time. A corrected or re-derived proposition is a
//                  NEW claim; claims never overwrite one another (this is
//                  what makes "conflicting evidence is retained" provable at
//                  the storage level — see migrations/001).
//
//   Belief       — the versioned CURRENT working understanding. A belief is
//                  an anchor record owned by this module (subject, lifecycle
//                  active→retired) whose statement is VERSIONED through the
//                  freshness module's temporal-revision machinery (W006)
//                  under the subject kind `epistemics.belief` — exactly the
//                  wiring the freshness contract anticipates ("W005/W007
//                  drive these operations with their own subject kinds").
//                  Every belief version (lock 11) carries provenance (its
//                  supporting observations — ≥1, readable) and exposes
//                  uncertainty (confidence), alternatives (alternative
//                  explanations) and what evidence could change the
//                  conclusion (disconfirmation), plus the claims it weighs
//                  (`supportingClaimIds`).
//
//   Hypothesis   — an UNRESOLVED explanation: a candidate proposition that
//                  has not been confirmed or refuted yet. Open hypotheses
//                  may cite supporting observations; resolution is one-way
//                  (open → confirmed | refuted) with a required note and
//                  optional resolution evidence.
//
//   Unknown      — a CONSEQUENTIAL gap in knowledge (lock 7): a question
//                  Aurum cannot answer plus the consequence of not being
//                  able to answer it (both required — an unknown without a
//                  consequence is not consequential and does not belong
//                  here). Resolution is one-way (open → resolved) and
//                  records how the gap was closed.
//
//   Contradiction— an explicit, retained record that two pieces of evidence
//                  (observations and/or claims) conflict. Contradictions are
//                  never merged away (lock 12): the record, and both evidence
//                  sides it references, are retained permanently; resolving a
//                  contradiction only annotates HOW it was weighed.
//
// Shared vocabulary:
//   * `EvidenceRef`   — a reference to one piece of evidence: an observation
//     (W004) or a claim (this module). Cross-module references are validated
//     through the owning module's contract and deliberately carry no
//     cross-module foreign keys.
//   * `SubjectRef`    — an opaque forward reference to the record owning the
//     topic a claim/belief/hypothesis/unknown is about (e.g. a world-model
//     entity, a person). Like the freshness module's subjects, subject ids
//     are deliberately unverified here: the owning module's contract is the
//     verification point when it drives these records.
//   * `EpistemicConfidence` — calibrated confidence in a PROPOSITION (how
//     strongly the proposition is held), distinct from the observations
//     module's evidence-reliability confidence.

import type { TemporalStateFreshness } from '@/modules/freshness/contract';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Lifecycle of a belief anchor: active understanding, or retired (terminal). */
export type BeliefStatus = 'active' | 'retired';

/** Lifecycle of a hypothesis: unresolved, or terminally resolved. */
export type HypothesisStatus = 'open' | 'confirmed' | 'refuted';

/** Lifecycle of an unknown: open gap, or resolved (terminal). */
export type UnknownStatus = 'open' | 'resolved';

/** Lifecycle of a contradiction: open conflict, or resolved (terminal). */
export type ContradictionStatus = 'open' | 'resolved';

/** The two kinds of evidence an epistemic record can reference. */
export type EvidenceRefKind = 'observation' | 'claim';

/** What may resolve a contradiction / unknown: a belief, claim or observation. */
export type ResolutionRefKind = 'belief' | 'claim' | 'observation';

/** A reference to one piece of evidence (observation or claim). */
export interface EvidenceRef {
  kind: EvidenceRefKind;
  id: string;
}

/** A reference to what closed a contradiction/unknown (any evidence-like record). */
export interface ResolutionRef {
  kind: ResolutionRefKind;
  id: string;
}

/**
 * Opaque topic reference: what a claim/belief/hypothesis/unknown is about.
 * `kind` is a canonical slug from the owning module's vocabulary (e.g.
 * `world.entity`); `id` is that module's record uuid. Unverified here on
 * purpose (the freshness module's subject precedent).
 */
export interface SubjectRef {
  kind: string;
  id: string;
}

/**
 * Calibrated confidence in a proposition (inclusive [0, 1]) — how strongly
 * the proposition is held, NOT the reliability of a piece of evidence
 * (that is the observations module's confidence).
 */
export interface EpistemicConfidence {
  /** Inclusive [0, 1]. */
  value: number;
  /** How the value was produced (vocabulary of the recording path). */
  method: string;
  basis: string | null;
}

/** Input shape of a confidence (basis optional; normalized to null). */
export interface EpistemicConfidenceInput {
  value: number;
  method: string;
  basis?: string | null;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** One recorded claim — an immutable, evidence-derived proposition. */
export interface Claim {
  id: string;
  tenantId: string;
  /** The derived proposition (trimmed, 1..2048 chars). */
  proposition: string;
  /** What the claim is about, when known (opaque forward reference). */
  subject: SubjectRef | null;
  confidence: EpistemicConfidence;
  /**
   * The evidence this proposition was derived from: observation uuids,
   * sorted and deduplicated, validated to exist in this tenant and be
   * readable by the recording principal (≥1 — a claim is never derived from
   * nothing). Observations are immutable, so the links stay resolvable.
   */
  evidenceObservationIds: string[];
  rationale: string | null;
  /** Transaction time (service-minted, strict ISO 8601). */
  recordedAt: string;
}

/** Input shape of `recordClaim`. */
export interface RecordClaimInput {
  proposition: string;
  subject?: SubjectRef | null;
  confidence: EpistemicConfidenceInput;
  /** 1..16 supporting observation uuids (required — claims are derived FROM evidence). */
  evidenceObservationIds: string[];
  rationale?: string | null;
}

/** Query shape of `getClaim`. */
export interface GetClaimQuery {
  claimId: string;
}

/** Query shape of `listClaims`. */
export interface ListClaimsQuery {
  subjectKind?: string;
  /** Requires nothing — an id alone filters across kinds (uuids do not overlap in practice). */
  subjectId?: string;
  /** Filter to claims whose evidence includes this observation. */
  evidenceObservationId?: string;
  /** 1..500, default 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

/**
 * One retained contradiction between two pieces of evidence.
 *
 * The pair is stored in canonical order (evidenceA < evidenceB
 * lexicographically by (kind, id)) and is unique per tenant: one
 * contradiction record per evidence pair — re-registration is a
 * `contradiction_conflict`, forcing the caller to look at what is already
 * recorded. Aspects of the conflict go in `note`.
 *
 * Resolution (`status = 'resolved'`) is one-way and retains everything: the
 * pair, the note and the detection time stay untouched; only the resolution
 * annotation is added. The evidence itself is never touched at all
 * (observations are immutable by W004; claims are immutable here).
 */
export interface Contradiction {
  id: string;
  tenantId: string;
  evidenceA: EvidenceRef;
  evidenceB: EvidenceRef;
  /** In what respect the two pieces of evidence conflict (required). */
  note: string;
  status: ContradictionStatus;
  /** When the contradiction was detected (service-minted, strict ISO 8601). */
  detectedAt: string;
  resolvedAt: string | null;
  /** What resolved it (a weighing belief, a correcting claim, newer evidence) — optional. */
  resolvedBy: ResolutionRef | null;
  resolutionNote: string | null;
}

/** Input shape of `registerContradiction`. */
export interface RegisterContradictionInput {
  /** The two conflicting pieces of evidence (order-insensitive; must differ). */
  left: EvidenceRef;
  right: EvidenceRef;
  note: string;
}

/** Input shape of `resolveContradiction`. */
export interface ResolveContradictionInput {
  contradictionId: string;
  resolvedBy?: ResolutionRef | null;
  /** Required: how the conflict was weighed. */
  note: string;
}

/** Query shape of `getContradiction`. */
export interface GetContradictionQuery {
  contradictionId: string;
}

/** Query shape of `listContradictions`. */
export interface ListContradictionsQuery {
  /** Filter to contradictions involving this piece of evidence (either side). */
  evidenceRef?: EvidenceRef;
  status?: ContradictionStatus;
  /** 1..500, default 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

/** One hypothesis — an unresolved explanation. */
export interface Hypothesis {
  id: string;
  tenantId: string;
  /** The candidate explanation (trimmed, 1..2048 chars). */
  proposition: string;
  subject: SubjectRef | null;
  status: HypothesisStatus;
  /**
   * Observations that motivated the hypothesis (0..16, sorted, deduplicated,
   * validated readable). May be empty: a hypothesis may be posed purely as a
   * candidate explanation before any supporting evidence exists — unlike a
   * claim, it is not an evidence-derived assertion.
   */
  supportingObservationIds: string[];
  note: string | null;
  /** Transaction time (service-minted, strict ISO 8601). */
  recordedAt: string;
  resolvedAt: string | null;
  /** Resolution evidence (present only once resolved). */
  resolutionEvidenceObservationIds: string[];
  resolutionEvidenceClaimIds: string[];
  resolutionNote: string | null;
}

/** Input shape of `recordHypothesis`. */
export interface RecordHypothesisInput {
  proposition: string;
  subject?: SubjectRef | null;
  /** 0..16 supporting observation uuids. */
  supportingObservationIds?: string[];
  note?: string | null;
}

/** Input shape of `resolveHypothesis`. */
export interface ResolveHypothesisInput {
  hypothesisId: string;
  outcome: 'confirmed' | 'refuted';
  /** 0..16 confirming/refuting observation uuids. */
  evidenceObservationIds?: string[];
  /** 0..16 confirming/refuting claim uuids. */
  evidenceClaimIds?: string[];
  /** Required: why this outcome. */
  note: string;
}

/** Query shape of `getHypothesis`. */
export interface GetHypothesisQuery {
  hypothesisId: string;
}

/** Query shape of `listHypotheses`. */
export interface ListHypothesesQuery {
  status?: HypothesisStatus;
  subjectKind?: string;
  subjectId?: string;
  /** 1..500, default 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Unknowns
// ---------------------------------------------------------------------------

/** One unknown — a consequential gap in knowledge (lock 7). */
export interface Unknown {
  id: string;
  tenantId: string;
  /** The question Aurum cannot answer (trimmed, 1..2048 chars). */
  question: string;
  /**
   * Why the gap matters (required, 1..2048 chars) — this is what makes the
   * unknown CONSEQUENTIAL. A gap without consequence is not first-class.
   */
  consequence: string;
  subject: SubjectRef | null;
  status: UnknownStatus;
  /**
   * What is already known that bounds the gap: related observations, claims
   * and beliefs (validated to exist in this tenant at record time).
   */
  relatedObservationIds: string[];
  relatedClaimIds: string[];
  relatedBeliefIds: string[];
  note: string | null;
  /** Transaction time (service-minted, strict ISO 8601). */
  recordedAt: string;
  resolvedAt: string | null;
  /** What closed the gap (a belief, a claim, an observation) — optional. */
  resolution: ResolutionRef | null;
  /** Required once resolved: how the gap was closed. */
  resolutionNote: string | null;
}

/** Input shape of `recordUnknown`. */
export interface RecordUnknownInput {
  question: string;
  consequence: string;
  subject?: SubjectRef | null;
  relatedObservationIds?: string[];
  relatedClaimIds?: string[];
  relatedBeliefIds?: string[];
  note?: string | null;
}

/** Input shape of `resolveUnknown`. */
export interface ResolveUnknownInput {
  unknownId: string;
  resolution?: ResolutionRef | null;
  /** Required: how the gap was closed. */
  note: string;
}

/** Query shape of `getUnknown`. */
export interface GetUnknownQuery {
  unknownId: string;
}

/** Query shape of `listUnknowns`. */
export interface ListUnknownsQuery {
  status?: UnknownStatus;
  subjectKind?: string;
  subjectId?: string;
  /** 1..500, default 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Beliefs
// ---------------------------------------------------------------------------

/**
 * The statement a belief version asserts — the content of one version of the
 * working understanding. Stored as the temporal revision's `state` JSON
 * (subject kind `epistemics.belief`, W006 machinery); the supporting
 * OBSERVATIONS of the same version live on the revision's provenance and are
 * surfaced as `provenance.observationIds` on the belief/version types.
 */
export interface BeliefStatement {
  /** The working-understanding proposition (1..2048 chars). */
  proposition: string;
  /** Uncertainty (lock 11). */
  confidence: EpistemicConfidence;
  /**
   * Alternative explanations of the same evidence (lock 11 / §11). May be
   * empty when no alternative is known — that is itself an assertion the
   * caller is responsible for.
   */
  alternatives: string[];
  /**
   * What evidence could change the conclusion (§11). Null when the caller
   * asserts none is known.
   */
  disconfirmation: string | null;
  /**
   * The claims this version weighs (0..16, sorted, deduplicated, validated
   * to exist in this tenant at record time).
   */
  supportingClaimIds: string[];
}

/** One version of a belief, as returned by `listBeliefHistory`. */
export interface BeliefVersion {
  /** 1-based, minted by the temporal machinery; strictly increasing with validFrom. */
  version: number;
  statement: BeliefStatement;
  /** Supporting observations of this version (the revision's provenance). */
  provenance: { observationIds: string[] };
  /** Valid-time start (strict ISO 8601). */
  validFrom: string;
  /** Valid-time end (derived): the next version's validFrom; null = open. */
  validTo: string | null;
  /** Transaction time (service-minted, strict ISO 8601). */
  recordedAt: string;
  /** True when this is the latest RECORDED version (not necessarily valid now). */
  current: boolean;
  rationale: string | null;
}

/**
 * The belief anchor as returned by `listBeliefs` / `retireBelief` — the
 * management record without the versioned statement (use `getBelief` /
 * `listBeliefHistory` to resolve statements).
 */
export interface BeliefAnchor {
  id: string;
  tenantId: string;
  subject: SubjectRef | null;
  status: BeliefStatus;
  retireReason: string | null;
  createdAt: string;
  retiredAt: string | null;
}

/** A belief: the anchor plus the version of its statement valid at `asOf`. */
export interface Belief extends BeliefAnchor {
  /** The version of the working understanding resolved by the query. */
  version: number;
  statement: BeliefStatement;
  /** Supporting observations of the resolved version. */
  provenance: { observationIds: string[] };
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  current: boolean;
  rationale: string | null;
}

/**
 * Input shape of `formBelief` (first version) and `reviseBelief` (next
 * version). `beliefId` applies to revisions only.
 */
export interface BeliefInput {
  proposition: string;
  confidence: EpistemicConfidenceInput;
  /** 1..16 supporting observation uuids — every version carries provenance (lock 11). */
  supportingObservationIds: string[];
  /** 0..16 claim uuids this version weighs. */
  supportingClaimIds?: string[];
  alternatives?: string[];
  disconfirmation?: string | null;
  subject?: SubjectRef | null;
  /** Valid-time start of this version (strict ISO 8601; must strictly increase per belief). */
  validFrom: string;
  rationale?: string | null;
}

/** Input shape of `reviseBelief`. */
export interface ReviseBeliefInput extends BeliefInput {
  beliefId: string;
}

/** Input shape of `retireBelief`. */
export interface RetireBeliefInput {
  beliefId: string;
  /** Required: why the belief is being retired. */
  rationale: string;
}

/** Query shape of `getBelief` / `evaluateBeliefFreshness`. */
export interface GetBeliefQuery {
  beliefId: string;
  /**
   * Resolve the version valid at this instant (strict ISO 8601); defaults to
   * now — "what did we believe as of <time>".
   */
  asOf?: string;
}

/** Query shape of `listBeliefs`. */
export interface ListBeliefsQuery {
  status?: BeliefStatus;
  subjectKind?: string;
  subjectId?: string;
  /** 1..500, default 100. */
  limit?: number;
}

/** Query shape of `listBeliefHistory`. */
export interface ListBeliefHistoryQuery {
  beliefId: string;
}

/** Query shape of `evaluateBeliefFreshness` (same resolution semantics as `getBelief`). */
export type EvaluateBeliefFreshnessQuery = GetBeliefQuery;

/**
 * Freshness of a belief's current understanding (lock 11: consequential
 * beliefs carry freshness metadata): the freshness module's evaluation of the
 * temporal state (subject kind `epistemics.belief`) — the resolved version,
 * the age of its newest readable supporting evidence and its classification
 * against the tenant's stale-after policy for beliefs.
 */
export type BeliefFreshness = TemporalStateFreshness;
