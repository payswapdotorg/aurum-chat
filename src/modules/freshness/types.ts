// Public domain types of the freshness module (W006 — Temporal State and
// Freshness).
//
// W006 owns two halves of one foundation:
//
//  1. TEMPORAL STATE — versioning of mutable understanding. "Reality is
//     immutable; understanding is mutable" (ARCHITECTURE.md §4): world-model
//     relationships (W005) and beliefs (W007) are *versioned* rather than
//     overwritten. W006 provides the generic machinery — a `TemporalRevision`
//     chain per (tenant, subject) — that those modules will drive with their
//     own subject kinds (`world.relationship`, `epistemics.belief`, …). Each
//     revision is an append-only assertion with:
//       * valid time   — `validFrom` … derived `validTo`: when the asserted
//                        state holds in reality;
//       * transaction  — `recordedAt` (service-minted): when Aurum committed
//                        the revision;
//       * provenance   — the observation ids supporting the assertion
//                        (lock 11: consequential understanding carries
//                        provenance — no versioned state without evidence).
//
//  2. FRESHNESS — whether Aurum's understanding is current, aging or stale
//     (ARCHITECTURE.md §11). A `FreshnessPolicy` (stale-after policy) is a
//     tenant-scoped rule keyed by subject kind (+ optional subject id); the
//     evaluation operations derive observation latency (observedAt vs the
//     service-set recordedAt), source freshness (age of a source's newest
//     evidence) and temporal-state freshness (age of the newest readable
//     evidence behind the current version), then classify them against the
//     applicable policy.
//
// Types stay provider-neutral and tenant-scoped; `sourceKind` reuses the
// observations module's canonical vocabulary through its public contract.

import type { ObservationSourceKind } from '@/modules/observations/contract';

/**
 * Whether understanding/evidence is current, aging or stale — the three
 * states ARCHITECTURE.md §11 names — plus `unknown`: no applicable
 * stale-after policy (or no evidence to age), so Aurum cannot yet say.
 */
export type FreshnessStatus = 'current' | 'aging' | 'stale' | 'unknown';

/**
 * Thresholds of a stale-after policy, as consumed by the pure classifier.
 * `agingAfterSeconds` (when set) must be strictly below
 * `staleAfterSeconds`.
 */
export interface FreshnessThresholds {
  staleAfterSeconds: number;
  agingAfterSeconds?: number | null;
}

/**
 * A tenant-scoped stale-after policy (ARCHITECTURE.md §11).
 *
 * Keyed by subject:
 *  * `subjectKind` — a canonical slug naming what the policy governs. The
 *    namespace is shared by all consumers: freshness itself uses `'source'`
 *    for source policies; observation kinds (e.g. `metric.sample`) key
 *    per-kind observation policies; W005/W007 will bring
 *    `world.relationship` / `epistemics.belief` kinds; W014 its watch rules.
 *  * `subjectId` — a specific subject (uuid) the policy refines, or `null`
 *    for the kind-wide default. Resolution: exact (kind + id) first, then
 *    the kind default, then no policy.
 *
 * Classification (see `classifyFreshness`):
 *  * age <= agingAfterSeconds (or <= staleAfterSeconds when no aging
 *    threshold)            → `current`
 *  * agingAfterSeconds < age <= staleAfterSeconds → `aging`
 *  * age > staleAfterSeconds                        → `stale`
 *
 * `maxLatencySeconds` is the ingestion-latency alarm: an observation whose
 * recordedAt − observedAt exceeds it is flagged `latencyExceeded`.
 *
 * Policies are management controls, not evidence: they are updatable
 * (`setFreshnessPolicy` upserts; `updatedAt` moves) and deliberately NOT
 * append-only. Full change history of policy edits belongs to the audit
 * module (W046), not W006.
 */
export interface FreshnessPolicy {
  id: string;
  tenantId: string;
  subjectKind: string;
  /** Specific subject the policy refines, or null for the kind default. */
  subjectId: string | null;
  staleAfterSeconds: number;
  agingAfterSeconds: number | null;
  maxLatencySeconds: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `setFreshnessPolicy` (upsert by subject key). */
export interface SetFreshnessPolicyInput {
  subjectKind: string;
  subjectId?: string | null;
  staleAfterSeconds: number;
  agingAfterSeconds?: number | null;
  maxLatencySeconds?: number | null;
  note?: string | null;
}

/** Provenance of one temporal revision: the evidence supporting it. */
export interface TemporalRevisionProvenance {
  /**
   * Observation ids supporting this version — validated to exist in the
   * tenant and be readable by the recording principal, deduplicated and
   * sorted. At least one is mandatory: understanding never versions itself
   * without evidence (lock 11).
   */
  observationIds: string[];
}

/**
 * One version of a subject's mutable state — an append-only assertion.
 *
 * `validTo` is DERIVED from the chain (the next revision's `validFrom`;
 * null = open-ended) and `current` flags the latest recorded version —
 * superseding never mutates history (storage-level append-only triggers in
 * migrations/002).
 */
export interface TemporalRevision {
  id: string;
  tenantId: string;
  subjectKind: string;
  /**
   * Opaque uuid of the subject record owned by its module (a world-model
   * relationship once W005 lands, a belief once W007 lands). The owning
   * module does not exist yet, so — like the observations module's source
   * references — the id is deliberately unverified here.
   */
  subjectId: string;
  /** 1-based, per (tenant, subject); minted by the service, never caller-set. */
  version: number;
  /** The versioned mutable payload — any plain JSON value. */
  state: unknown;
  /** Valid-time start (strict ISO 8601): when this state began holding. */
  validFrom: string;
  /** Valid-time end (derived): the next revision's validFrom; null = open. */
  validTo: string | null;
  /** Transaction time (service-minted, strict ISO 8601). */
  recordedAt: string;
  /** True when this is the latest recorded version of the subject. */
  current: boolean;
  provenance: TemporalRevisionProvenance;
  rationale: string | null;
}

/** Input shape of `recordTemporalRevision`. */
export interface RecordTemporalRevisionInput {
  subjectKind: string;
  subjectId: string;
  /** The asserted state — any plain JSON value (non-null). */
  state: unknown;
  /**
   * When the asserted state began holding in reality (strict ISO 8601).
   * Must be strictly after the latest revision's validFrom — a subject's
   * revisions form a strictly increasing valid-time chain.
   */
  validFrom: string;
  /** 1..16 observation uuids supporting this version (required, see above). */
  observationIds: string[];
  rationale?: string | null;
}

/** Query shape of `getTemporalState`. */
export interface GetTemporalStateQuery {
  subjectKind: string;
  subjectId: string;
  /**
   * Resolve the version valid at this instant (strict ISO 8601); defaults
   * to now. Lets callers ask "what did we believe as of <time>".
   */
  asOf?: string;
}

/** Query shape of `listTemporalHistory`. */
export interface ListTemporalHistoryQuery {
  subjectKind: string;
  subjectId: string;
}

/** Query shape of `getFreshnessPolicy` / `resolveFreshnessPolicy`. */
export interface PolicySubjectQuery {
  subjectKind: string;
  /**
   * Specific subject id, or null to address the kind default.
   * `resolveFreshnessPolicy` falls back from a given id to the kind default;
   * `getFreshnessPolicy` is an exact-key lookup.
   */
  subjectId?: string | null;
}

/** Query shape of `listFreshnessPolicies`. */
export interface ListFreshnessPoliciesQuery {
  subjectKind?: string;
  /** 1..500, default 100. */
  limit?: number;
}

/** Query shape of `evaluateObservationFreshness`. */
export interface ObservationFreshnessQuery {
  observationId: string;
  /** Evaluate as of this instant (strict ISO 8601); defaults to now. */
  asOf?: string;
}

/** Result of `evaluateObservationFreshness`. */
export interface ObservationFreshness {
  observationId: string;
  tenantId: string;
  /** The observation's canonical kind (e.g. `metric.sample`). */
  kind: string;
  observedAt: string;
  recordedAt: string;
  evaluatedAt: string;
  /**
   * Ingestion latency: recordedAt − observedAt, in seconds (fractional),
   * clamped at 0 — a negative difference means the source clock ran ahead
   * of Aurum's commit clock, which is skew, not latency.
   */
  latencySeconds: number;
  /** Evidence age: evaluatedAt − observedAt, seconds, clamped at 0. */
  ageSeconds: number;
  status: FreshnessStatus;
  /**
   * The applicable policy snapshot at evaluation time:
   * source-specific (`'source'`, observation.source.id) first, then the
   * observation-kind default. Null → status `unknown`.
   */
  policy: FreshnessPolicy | null;
  /** True when policy.maxLatencySeconds is set and the latency exceeded it. */
  latencyExceeded: boolean;
}

/** Query shape of `evaluateSourceFreshness`. */
export interface SourceFreshnessQuery {
  sourceKind: ObservationSourceKind;
  /** Uuid reference of the source record (label-only sources: see header). */
  sourceId: string;
  /** Evaluate as of this instant (strict ISO 8601); defaults to now. */
  asOf?: string;
}

/** Result of `evaluateSourceFreshness`. */
export interface SourceFreshness {
  sourceKind: ObservationSourceKind;
  sourceId: string;
  tenantId: string;
  evaluatedAt: string;
  latestObservationId: string | null;
  /** Newest observedAt among the source's considered observations. */
  latestObservedAt: string | null;
  latestRecordedAt: string | null;
  /** Age of the newest evidence; null when the source has delivered none. */
  ageSeconds: number | null;
  status: FreshnessStatus;
  /**
   * Policy resolved for (`'source'`, sourceId), falling back to the
   * `'source'` kind default; null → status `unknown`.
   */
  policy: FreshnessPolicy | null;
  /** How many of the source's observations the evaluation considered. */
  observationsConsidered: number;
  /** Latency aggregates over the considered window; null when empty. */
  maxObservedLatencySeconds: number | null;
  avgObservedLatencySeconds: number | null;
}

/** Query shape of `evaluateTemporalStateFreshness`. */
export interface TemporalStateFreshnessQuery {
  subjectKind: string;
  subjectId: string;
  /** Evaluate as of this instant (strict ISO 8601); defaults to now. */
  asOf?: string;
}

/** Result of `evaluateTemporalStateFreshness`. */
export interface TemporalStateFreshness {
  subjectKind: string;
  subjectId: string;
  tenantId: string;
  /** The version valid at `asOf` (the understanding being evaluated). */
  revision: TemporalRevision;
  evaluatedAt: string;
  /**
   * observedAt of the newest supporting observation the caller may read
   * (partial view — restricted evidence is skipped, never leaked); null
   * when no supporting observation is readable.
   */
  evidenceObservedAt: string | null;
  /** Supporting observations readable by the caller. */
  supportingObservations: number;
  /** Supporting observations recorded on the revision's provenance. */
  recordedObservations: number;
  /** Age of the newest readable evidence; null when there is none. */
  ageSeconds: number | null;
  status: FreshnessStatus;
  policy: FreshnessPolicy | null;
}
