// ============================================================================
// opportunities — the ONLY public surface of the opportunities module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W015 — Opportunity Engine:
// "Convert external/internal signals into evidence-backed opportunities
//  with estimated value, confidence, affected goals and required
//  capabilities."
//
// MODULE PLACEMENT: `opportunities` is the frozen module map's L3 member
// (ARCHITECTURE.md §26; IMPLEMENTATION-STACK §10; MODULE-DEPENDENCY-MAP
// L3 "environment, opportunities, presence, processes, capabilities,
// automation, workforce, suppliers"). ARCHITECTURE.md §12 makes Opportunity
// a first-class concept (lock 18) with the frozen field list, and no other
// catalog work item claims this module; W015 owns it.
//
//   convertSignals — the engine's ONE explicit, durable conversion pass:
//      a trigger (what started it — a 'cognitive-execution' trigger is
//      validated readable through the cognition contract, W013), the
//      run's actor, a snapshotted recordability policy and a bounded batch
//      of signal CANDIDATES at the bounded-reasoning seam (the signals —
//      observation/claim references, validated readable through their
//      contracts — plus the impact-analysis judgment: title, description,
//      estimated value, affected goals, required capabilities, world
//      entities and the recommended next action). The application derives
//      every confidence deterministically from the cited evidence
//      (derivation.ts — lock 10: no caller and no LLM asserts the
//      confidence of its own output), applies the policy gate
//      (below-threshold and currency-mismatched candidates are recorded,
//      never silently dropped), detects duplicates by the deterministic
//      evidence-set fingerprint (a live opportunity already carrying the
//      exact signals is a REVISION target, not a second record —
//      continuous conversion does not spam), and persists what survives as
//      evidence-backed opportunities (version 1, status minted 'open').
//
//   reviseOpportunity — append the next version: omitted fields carry
//      over; arrays replace wholesale; a `status` change must be the only
//      change (surgical open→pursued / open→dismissed / dismissed→open;
//      'pursued' is terminal — outcome measurement is W040's territory).
//      The evidence set is re-validated and the confidence re-derived on
//      every version; `signalOrigin` is conversion-time classification and
//      never revisable. `expectedVersion` guards stale writers.
//
//   getOpportunity / getOpportunityVersion / listOpportunityVersions —
//      the current view (identity + current content + audit summary), one
//      audit record deep-linked by version, and the append-only history.
//
//   listOpportunities — the management surface's current views (lock 33):
//      filtered by status, signal origin, minimum derived confidence,
//      affected goal, required capability, world entity and title search,
//      newest first.
//
//   getConversionRun / listConversionRuns / getConversionCandidate — the
//      conversion audit surface: one run with its full decided candidate
//      chain, the run feed (filtered by trigger kind and originating
//      execution, newest first, disposition counts included), and one
//      candidate deep-linked by id.
//
// There is deliberately NO operation to update or erase a version, re-decide
// a candidate, un-convert, un-duplicate or delete anything: the opportunity
// audit chain and the conversion decision trail are append-only evidence of
// what Aurum understood and decided (PostgreSQL triggers reject
// UPDATE/DELETE/TRUNCATE on versions, runs and candidates, and DELETE/
// TRUNCATE on identities — migration 001). There is also deliberately no
// mission-launching or action-taking operation: §12's chain hands the
// opportunity's RECOMMENDED next action to the attention decision — acting
// on it belongs to attention/cognition/actions, not to this module.
//
// Cross-module integration: evidence is read ONLY through the observations
// (W004) and epistemics (W007) contracts (getObservation / getClaim);
// affected goals are validated readable through the goals contract (W008);
// the loop linkage through the cognition contract (W013) — never sibling
// tables. Required capabilities and world entities are opaque forward
// references (the capabilities module's requirement-source design and the
// processes module's worldEntityId precedent — no cross-module foreign
// keys, and W017 is not in this module's declared dependency set).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's
// opportunity intelligence (including versions, runs and candidates) is
// reported as `opportunity_not_found` / `opportunity_version_not_found` /
// `run_not_found` / `candidate_not_found` — no existence leak — and the
// validated cross-module references (evidence, goals, the originating
// execution) are uniformly `invalid_*` for the same reason.
// ============================================================================

export {
  // the engine
  convertSignals,
  reviseOpportunity,
  // opportunity reads
  getOpportunity,
  getOpportunityVersion,
  listOpportunities,
  listOpportunityVersions,
  // conversion audit reads
  getConversionCandidate,
  getConversionRun,
  listConversionRuns,
} from './service';

export { OpportunitiesError } from './errors';
export type { OpportunitiesErrorCode } from './errors';

// The deterministic conversion core — pure vocabulary/derivation/gate logic
// for downstream modules (W040 outcome measurement, W049 the end-to-end
// fixture) and unit testing (the attention discovery.ts and processes
// detection.ts precedent).
export {
  CONFIDENCE_CAP,
  CORROBORATION_STEP,
  deriveConfidence,
  evaluateRecordability,
  evidenceFingerprintOf,
  round4,
} from './derivation';
export type { RecordabilityDecision } from './derivation';

export {
  // vocabularies + guards
  CANDIDATE_DISPOSITIONS,
  CONVERSION_TRIGGER_KINDS,
  NEXT_ACTION_KINDS,
  OPPORTUNITY_CHANGE_KINDS,
  OPPORTUNITY_PARTY_KINDS,
  OPPORTUNITY_STATUSES,
  SIGNAL_ORIGINS,
  isConversionTriggerKind,
  isNextActionKind,
  isOpportunityPartyKind,
  isOpportunityStatus,
  isSignalOrigin,
  isUuid,
  // defaults + limits
  DEFAULT_LIST_LIMIT,
  DEFAULT_MIN_CONFIDENCE,
  MAX_AFFECTED_GOALS,
  MAX_CANDIDATES_PER_RUN,
  MAX_CAPABILITY_REFS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_FINGERPRINT_LENGTH,
  MAX_LIST_LIMIT,
  MAX_PARTY_LABEL_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_STATEMENT_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_VALUE_AMOUNT,
  MAX_WORLD_ENTITY_REFS,
  escapeLike,
} from './validation';

export type {
  ValidatedCandidateInput,
  ValidatedEvidenceInput,
  ValidatedListQuery,
  ValidatedParty,
  ValidatedPolicy,
  ValidatedRevisionPatch,
  ValidatedRunInput,
  ValidatedRunListQuery,
} from './validation';

export type {
  CapabilityRef,
  CapabilityRefInput,
  CandidateDisposition,
  ConversionCandidate,
  ConversionPolicy,
  ConversionPolicyInput,
  ConversionRun,
  ConversionRunCounts,
  ConversionRunSummary,
  ConversionTriggerKind,
  ConvertSignalsInput,
  EvidenceConfidenceSnapshot,
  EvidenceInput,
  GetConversionCandidateQuery,
  GetConversionRunQuery,
  GetOpportunityVersionQuery,
  ListConversionRunsQuery,
  ListOpportunitiesQuery,
  ListOpportunityVersionsQuery,
  Money,
  MoneyInput,
  NextActionKind,
  Opportunity,
  OpportunityChangeKind,
  OpportunityContent,
  OpportunityEvidence,
  OpportunityGoalRef,
  OpportunityGoalRefInput,
  OpportunityParty,
  OpportunityPartyInput,
  OpportunityPartyKind,
  OpportunityStatus,
  OpportunityVersion,
  RecommendedNextAction,
  RecommendedNextActionInput,
  ReviseOpportunityInput,
  SignalCandidateInput,
  SignalOrigin,
  WorldEntityRef,
  WorldEntityRefInput,
} from './types';
