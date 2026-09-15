// ============================================================================
// epistemics — the ONLY public surface of the epistemics module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W007 — Epistemics (spec/work-items/WORK-ITEM-CATALOG.md):
// "Implement claims, beliefs, hypotheses, unknowns and contradictions with
//  evidence links. Verify conflicting evidence is retained."
//
//   Claims (immutable propositions derived from evidence — §4)
//     recordClaim / getClaim / listClaims
//        — a claim records WHAT was derived from WHICH evidence (≥1
//          observation that exists in this tenant and is readable by the
//          recording principal) with what confidence, at commit time.
//          There is deliberately NO update/delete/correct operation: a
//          re-derivation is a NEW claim, and PostgreSQL triggers reject
//          UPDATE/DELETE/TRUNCATE outright (migrations/001) — conflicting
//          derivations therefore coexist forever (lock 12).
//
//   Contradictions (retained, never merged — §11, lock 12)
//     registerContradiction / getContradiction / listContradictions /
//     resolveContradiction
//        — an explicit record that two pieces of evidence (observations
//          and/or claims, both readable in-tenant) conflict. The pair is
//          canonicalized, one row per pair per tenant (re-registration is
//          `contradiction_conflict`), the evidence links are FROZEN at
//          registration, and the only legal mutation is the one-way
//          open → resolved annotation of HOW the conflict was weighed —
//          the record, the note and both evidence sides are retained.
//
//   Hypotheses (unresolved explanations — §4)
//     recordHypothesis / getHypothesis / listHypotheses / resolveHypothesis
//        — a candidate explanation that may cite supporting observations;
//          resolution is one-way open → confirmed | refuted with a required
//          note and optional resolution evidence. A refuted hypothesis is
//          retained as negative evidence.
//
//   Unknowns (consequential gaps in knowledge — §4, lock 7)
//     recordUnknown / getUnknown / listUnknowns / resolveUnknown
//        — a question Aurum cannot answer PLUS the consequence of the gap
//          (both required: an unknown without consequence is not
//          first-class). May relate to existing observations, claims and
//          beliefs; resolution is one-way open → resolved and records how
//          the gap was closed.
//
//   Beliefs (versioned current working understanding — §4, lock 11)
//     formBelief / reviseBelief / retireBelief / getBelief / listBeliefs /
//     listBeliefHistory / evaluateBeliefFreshness
//        — a belief is an anchor (subject + active→retired lifecycle)
//          owned by this module whose STATEMENT is versioned through the
//          freshness module's temporal-revision machinery (W006) under the
//          subject kind `epistemics.belief` — exactly the wiring the
//          freshness contract anticipates ("W005/W007 drive these
//          operations with their own subject kinds"). Every version
//          carries provenance (≥1 supporting observation, the revision's
//          provenance) and exposes uncertainty (confidence), alternatives
//          and what evidence could change the conclusion (§11), plus the
//          claims it weighs. Superseding a belief appends the next version
//          (strictly increasing validFrom — history is never rewritten);
//          retirement is a one-way anchor transition that changes nothing
//          about the retained versions. `evaluateBeliefFreshness` delegates
//          to the freshness contract so a belief's understanding can be
//          current/aging/stale against tenant stale-after policies keyed
//          by `epistemics.belief` (lock 11 freshness metadata).
//
// Evidence links are validated at write time through the observations
// contract (and this module's own claim/belief lookups) — cross-module
// table references are deliberately not foreign keys (the freshness
// provenance precedent). Evidence that is missing, cross-tenant or
// principal-restricted is uniformly `invalid_evidence` — no existence
// leak.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's claims,
// contradictions, hypotheses, unknowns or beliefs are indistinguishable
// from missing ones — no existence leak.
//
// Cross-module reads/writes: observations ONLY through its public contract
// (getObservation), belief versioning ONLY through the freshness contract
// (recordTemporalRevision / getTemporalState / listTemporalHistory /
// evaluateTemporalStateFreshness). Error propagation policy: see errors.ts.
// ============================================================================

export {
  // claims
  getClaim,
  listClaims,
  recordClaim,
  // contradictions
  getContradiction,
  listContradictions,
  registerContradiction,
  resolveContradiction,
  // hypotheses
  getHypothesis,
  listHypotheses,
  recordHypothesis,
  resolveHypothesis,
  // unknowns
  getUnknown,
  listUnknowns,
  recordUnknown,
  resolveUnknown,
  // beliefs
  evaluateBeliefFreshness,
  formBelief,
  getBelief,
  listBeliefHistory,
  listBeliefs,
  retireBelief,
  reviseBelief,
} from './service';

export { EpistemicsError } from './errors';
export type { EpistemicsErrorCode } from './errors';

export {
  // vocabularies + guards
  BELIEF_STATUSES,
  BELIEF_SUBJECT_KIND,
  CONTRADICTION_STATUSES,
  EVIDENCE_REF_KINDS,
  HYPOTHESIS_STATUSES,
  RESOLUTION_REF_KINDS,
  UNKNOWN_STATUSES,
  isBeliefStatus,
  isContradictionStatus,
  isEvidenceRefKind,
  isHypothesisStatus,
  isResolutionRefKind,
  isUnknownStatus,
  isUuid,
  // limits
  DEFAULT_LIST_LIMIT,
  MAX_ALTERNATIVES,
  MAX_ALTERNATIVE_CHARS,
  MAX_BELIEF_STATE_BYTES,
  MAX_DISCONFIRMATION_CHARS,
  MAX_EVIDENCE_CLAIMS,
  MAX_EVIDENCE_OBSERVATIONS,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_PROPOSITION_CHARS,
  MAX_RATIONALE_CHARS,
} from './validation';

export type {
  ValidatedBeliefInput,
  ValidatedGetBeliefQuery,
  ValidatedGetClaimQuery,
  ValidatedGetContradictionQuery,
  ValidatedGetHypothesisQuery,
  ValidatedGetUnknownQuery,
  ValidatedListBeliefsQuery,
  ValidatedListBeliefHistoryQuery,
  ValidatedListClaimsQuery,
  ValidatedListContradictionsQuery,
  ValidatedListHypothesesQuery,
  ValidatedListUnknownsQuery,
  ValidatedRecordClaimInput,
  ValidatedRecordHypothesisInput,
  ValidatedRecordUnknownInput,
  ValidatedRegisterContradictionInput,
  ValidatedResolveContradictionInput,
  ValidatedResolveHypothesisInput,
  ValidatedResolveUnknownInput,
  ValidatedRetireBeliefInput,
  ValidatedReviseBeliefInput,
} from './validation';

export type {
  Belief,
  BeliefAnchor,
  BeliefFreshness,
  BeliefInput,
  BeliefStatement,
  BeliefStatus,
  BeliefVersion,
  Claim,
  Contradiction,
  ContradictionStatus,
  EpistemicConfidence,
  EpistemicConfidenceInput,
  EvaluateBeliefFreshnessQuery,
  EvidenceRef,
  EvidenceRefKind,
  GetBeliefQuery,
  GetClaimQuery,
  GetContradictionQuery,
  GetHypothesisQuery,
  GetUnknownQuery,
  Hypothesis,
  HypothesisStatus,
  ListBeliefHistoryQuery,
  ListBeliefsQuery,
  ListClaimsQuery,
  ListContradictionsQuery,
  ListHypothesesQuery,
  ListUnknownsQuery,
  RecordClaimInput,
  RecordHypothesisInput,
  RecordUnknownInput,
  RegisterContradictionInput,
  ResolutionRef,
  ResolutionRefKind,
  ResolveContradictionInput,
  ResolveHypothesisInput,
  ResolveUnknownInput,
  RetireBeliefInput,
  ReviseBeliefInput,
  SubjectRef,
  Unknown,
  UnknownStatus,
} from './types';

// The catalog names the first-version input `FormBeliefInput`; the shared
// statement input type is `BeliefInput` (revisions add `beliefId`).
export type { BeliefInput as FormBeliefInput } from './types';
