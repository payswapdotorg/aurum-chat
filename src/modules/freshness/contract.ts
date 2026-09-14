// ============================================================================
// freshness — the ONLY public surface of the freshness module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W006 — Temporal State and Freshness:
// "Version mutable relationships/beliefs and track observation latency,
//  source freshness and stale-after policy."
//
// TEMPORAL STATE (versioning of mutable understanding — ARCHITECTURE.md
// §4 "Reality is immutable; understanding is mutable"):
//   recordTemporalRevision — append the next version of a subject's state
//      (valid-time start, JSON state, REQUIRED provenance: ≥1 supporting
//      observation readable in this tenant, rationale). Superseding is
//      appending: history is never rewritten (storage-level append-only
//      triggers). `version`/`recordedAt` are system-minted; the valid-time
//      chain is strictly increasing.
//   getTemporalState     — resolve the version valid at `asOf` (default
//      now), with the derived valid interval [validFrom, validTo) and the
//      `current` flag. asOf queries = "what did we believe as of <time>".
//   listTemporalHistory  — the full version chain, ascending.
//
//   The subject (kind + uuid id) is opaque here: world-model relationships
//   (W005) and beliefs (W007) do not exist yet, so — like the observations
//   module's source references — subject ids are deliberately unverified
//   forward references. W005/W007 drive these operations with their own
//   subject kinds (`world.relationship`, `epistemics.belief`, …).
//
// STALE-AFTER POLICIES + FRESHNESS EVALUATION (ARCHITECTURE.md §11 "Aurum
// must be able to say whether its understanding is current, aging or
// stale"; lock 11):
//   setFreshnessPolicy / getFreshnessPolicy / resolveFreshnessPolicy /
//   listFreshnessPolicies — tenant-scoped stale-after rules keyed by
//      (subjectKind, optional subjectId); resolution is exact-first, then
//      the kind default. Policies are updatable management controls, not
//      evidence (their change history belongs to audit, W046).
//   evaluateObservationFreshness — observation latency (recordedAt −
//      observedAt, the derivation the observations module left to W006),
//      evidence age, and classification against the applicable policy
//      (source-specific first, then the observation-kind default);
//      `latencyExceeded` flags a breached max-latency threshold.
//   evaluateSourceFreshness     — freshness of a source's evidence stream:
//      the newest observed evidence (not just the newest commit), its age,
//      per-window latency aggregates, classification against the source's
//      policy (specific, else the 'source' kind default). No evidence →
//      status 'unknown'.
//   evaluateTemporalStateFreshness — freshness of the CURRENT
//      understanding: the version valid at `asOf`, the age of its newest
//      READABLE supporting evidence (partial view — restricted provenance
//      is skipped, never leaked), classified against the subject's policy.
//   classifyFreshness / observationLatencySeconds / evidenceAgeSeconds —
//      the pure, deterministic classifiers for downstream modules (W014
//      environment watch, W052 source ranking) to use without a DB.
//
// Status vocabulary: 'current' | 'aging' | 'stale' per §11, plus 'unknown'
// (no applicable policy, or no evidence to age).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's temporal state and
// policies are indistinguishable from missing ones — no existence leak.
//
// Cross-module reads: this module consumes the observations module ONLY
// through its public contract (getObservation/listObservations). Error
// propagation policy (see errors.ts): recordTemporalRevision maps
// unavailable supporting evidence to `invalid_provenance`;
// evaluateObservationFreshness/evaluateSourceFreshness propagate the
// observations module's own ObservationsError for the observation being
// evaluated; evaluateTemporalStateFreshness skips unreadable provenance
// (partial view). Label-only observation sources cannot be filtered by the
// observations list contract — evaluate them via the pure classifiers with
// the caller's own timestamps.
// ============================================================================

export {
  evaluateObservationFreshness,
  evaluateSourceFreshness,
  evaluateTemporalStateFreshness,
  getFreshnessPolicy,
  getTemporalState,
  listFreshnessPolicies,
  listTemporalHistory,
  recordTemporalRevision,
  resolveFreshnessPolicy,
  setFreshnessPolicy,
} from './service';

export { FreshnessError } from './errors';
export type { FreshnessErrorCode } from './errors';

export {
  classifyFreshness,
  evidenceAgeSeconds,
  observationLatencySeconds,
} from './classification';

export {
  DEFAULT_POLICY_LIST_LIMIT,
  FRESHNESS_STATUSES,
  MAX_POLICY_LIST_LIMIT,
  MAX_PROVENANCE_OBSERVATIONS,
  MAX_STATE_BYTES,
  SOURCE_SUBJECT_KIND,
  isFreshnessStatus,
} from './validation';

export type {
  ValidatedPolicyInput,
  ValidatedPolicyListQuery,
  ValidatedPolicySubjectQuery,
  ValidatedRevisionInput,
} from './validation';

export type {
  FreshnessPolicy,
  FreshnessStatus,
  FreshnessThresholds,
  GetTemporalStateQuery,
  ListFreshnessPoliciesQuery,
  ListTemporalHistoryQuery,
  ObservationFreshness,
  ObservationFreshnessQuery,
  PolicySubjectQuery,
  RecordTemporalRevisionInput,
  SetFreshnessPolicyInput,
  SourceFreshness,
  SourceFreshnessQuery,
  TemporalRevision,
  TemporalRevisionProvenance,
  TemporalStateFreshness,
  TemporalStateFreshnessQuery,
} from './types';
