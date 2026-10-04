// Public domain types of the coverage module (W125 — Company Coverage
// Registry and Measurement Model).
//
// The work item (spec/POST-W123-COVERAGE-DAG-2026-10-04.md, W125):
// "Introduce the provider-neutral coverage contract." Acceptance:
// tenant-scoped CoverageSurface/CoverageSource/CoverageClaim/CoverageGap/
// CoverageSnapshot semantics; separate breadth/depth/freshness/identity/
// provenance/temporal/outcome/permission/goal dimensions; the
// COVERED/PARTIAL/STALE/UNAVAILABLE/UNAUTHORIZED/EXCLUDED/UNKNOWN states;
// evidence/connection-based derivation; no credentials in coverage state;
// coverage never becomes a second source of organizational truth.
//
// COMPANY-COVERAGE-ARCHITECTURE.md (approved additive architecture) is the
// source of this vocabulary. §3 defines the object model, §4 the coverage
// dimensions ("Never compress all of them into one percentage"), §5 the
// provider-neutral state vocabulary. The W124 reconciliation froze THIS
// file as the shared TL contract: W125 owns the coverage module and may
// only extend it additively; W126 (Company Query Plane) builds on it in
// parallel.
//
// §2 (frozen in spirit and enforced by design here): "Coverage is a
// derived, tenant-scoped view over existing Aurum state. It MUST NOT
// become another organizational database." Everything below is therefore
// either (a) provider-neutral vocabulary, (b) opaque references into the
// REAL registries (source/channel/meeting/integration ids — never
// credentials), or (c) derived statements that carry their own observation
// basis. No domain object is copied into coverage state.
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's surfaces, sources, claims, gaps and snapshots are
// indistinguishable from missing ones (uniform not-found, no existence
// leak).

// ---------------------------------------------------------------------------
// §5 — the coverage-state vocabulary (frozen)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral coverage states — COMPANY-COVERAGE-ARCHITECTURE.md
 * §5, in documented order:
 *
 *  COVERED     — sufficient authorized evidence exists and freshness is
 *                within policy.
 *  PARTIAL     — some expected evidence exists, but material portions are
 *                missing.
 *  STALE       — evidence exists but has exceeded its freshness policy.
 *  UNAVAILABLE — source/provider cannot currently be accessed.
 *  UNAUTHORIZED— coverage is intentionally absent because authorization is
 *                missing/revoked.
 *  EXCLUDED    — policy explicitly excludes this information.
 *  UNKNOWN     — Aurum lacks enough evidence to classify the surface.
 *
 * These are not provider states and never expose raw provider error codes.
 */
export const COVERAGE_STATES = [
  'COVERED',
  'PARTIAL',
  'STALE',
  'UNAVAILABLE',
  'UNAUTHORIZED',
  'EXCLUDED',
  'UNKNOWN',
] as const;

export type CoverageState = (typeof COVERAGE_STATES)[number];

/** §5 states that record an INTENTIONAL absence (policy, not blindness). */
export const POLICY_COVERAGE_STATES: readonly CoverageState[] = ['UNAUTHORIZED', 'EXCLUDED'];

/** §5 states that describe EVIDENCE (present but possibly deficient). */
export const EVIDENCE_COVERAGE_STATES: readonly CoverageState[] = [
  'COVERED',
  'PARTIAL',
  'STALE',
  'UNAVAILABLE',
];

// ---------------------------------------------------------------------------
// §4 — the coverage dimensions (frozen, never one percentage)
// ---------------------------------------------------------------------------

/**
 * The coverage dimensions — COMPANY-COVERAGE-ARCHITECTURE.md §4, in
 * documented order:
 *
 *  breadth                   — what company domains are represented at all;
 *  depth                     — how much of the relevant object graph is
 *                              observable for a covered domain;
 *  freshness                 — how current the latest usable observation is
 *                              relative to the source freshness policy;
 *  identity-continuity       — can records be joined confidently to the
 *                              same organizational person/entity;
 *  provenance-completeness   — can material claims trace back to evidence;
 *  temporal-completeness     — sufficient history, not only latest state;
 *  outcome-completeness      — can observed actions connect to measurable
 *                              outcomes;
 *  permission-completeness   — is the data actually authorized for the
 *                              requested purpose;
 *  goal-sufficiency          — is coverage sufficient for the tenant's
 *                              current important goals/decisions.
 */
export const COVERAGE_DIMENSIONS = [
  'breadth',
  'depth',
  'freshness',
  'identity-continuity',
  'provenance-completeness',
  'temporal-completeness',
  'outcome-completeness',
  'permission-completeness',
  'goal-sufficiency',
] as const;

export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

// ---------------------------------------------------------------------------
// §3 — CoverageSource: an authorized source of observations
// ---------------------------------------------------------------------------

/**
 * The existing registries a coverage source may reference (§3: "It
 * references the existing source/channel/meeting/integration registries
 * through opaque IDs. Credentials never enter coverage state.").
 */
export const COVERAGE_SOURCE_REGISTRIES = [
  'source',
  'channel',
  'meeting',
  'integration',
] as const;

export type CoverageSourceRegistry = (typeof COVERAGE_SOURCE_REGISTRIES)[number];

// ---------------------------------------------------------------------------
// §3 — the coverage object model
// ---------------------------------------------------------------------------

/**
 * A logical area of company reality that Aurum may observe (§3) — a
 * provider-neutral semantic category ("support-tickets", "meetings",
 * "finance"); Jira/Linear/Zendesk and other systems are provider
 * implementations behind their own adapters and never appear here.
 */
export interface CoverageSurface {
  id: string;
  tenantId: string;
  /** Canonical surface key (slug grammar, stable per tenant). */
  key: string;
  /** Human label. */
  label: string;
  description: string | null;
  /** ISO 8601 — registration time (service clock). */
  createdAt: string;
}

/** Input shape of `registerSurface`. */
export interface RegisterSurfaceInput {
  key: string;
  label: string;
  description?: string | null;
}

/** Query shape of `listSurfaces`. */
export interface ListSurfacesQuery {
  limit?: number;
}

/**
 * An authorized source capable of contributing observations to surfaces
 * (§3). The reference into the real registry is opaque — the id the owning
 * registry already mints; coverage never stores credentials and never
 * learns provider secrets.
 */
export interface CoverageSource {
  id: string;
  tenantId: string;
  /** Which existing registry `ref` points into. */
  registry: CoverageSourceRegistry;
  /** Opaque registry id — never a credential. */
  ref: string;
  label: string | null;
  /** ISO 8601 — registration time (service clock). */
  createdAt: string;
}

/** Input shape of `registerSource`. */
export interface RegisterSourceInput {
  registry: CoverageSourceRegistry;
  ref: string;
  label?: string | null;
}

/** Query shape of `listSources`. */
export interface ListSourcesQuery {
  registry?: CoverageSourceRegistry;
  limit?: number;
}

/**
 * A derived statement about observability (§3). Retains: tenant, surface,
 * source reference, observation basis, current state, freshness,
 * confidence, evaluation time and reason/explanation. Claims are
 * append-only: a later evaluation appends a new claim; the latest claim
 * per (surface, source) is the current statement.
 */
export interface CoverageClaim {
  id: string;
  tenantId: string;
  surfaceKey: string;
  /** The source the claim is about (opaque forward reference). */
  source: { registry: CoverageSourceRegistry; ref: string };
  /** The evidence/connection basis the claim was derived from. */
  observationBasis: {
    /** What kind of basis ('connection-health', 'observation-set', ...). */
    kind: string;
    /** The basis' evidence ids (opaque observation/evidence references). */
    ids: string[];
    /** ISO 8601 — latest observation in the basis, when known. */
    lastObservedAt: string | null;
  };
  state: CoverageState;
  /** Freshness of the claim's evidence. */
  freshness: {
    /** ISO 8601 — latest USABLE observation, when known. */
    lastUsableAt: string | null;
    /** The source freshness policy's maximum age in seconds, when known. */
    policyMaxAgeSeconds: number | null;
  };
  /** 0..1 — the claim's confidence in its own state. */
  confidenceValue: number;
  /** Human explanation of the state (1..2048 chars). */
  reason: string;
  /** ISO 8601 — evaluation time (service clock). */
  evaluatedAt: string;
  /** The principal whose surface recorded the claim. */
  evaluatedBy: string;
}

/** Input shape of `recordClaim`. */
export interface RecordClaimInput {
  surfaceKey: string;
  source: { registry: CoverageSourceRegistry; ref: string };
  observationBasis: {
    kind: string;
    ids?: string[];
    lastObservedAt?: string | null;
  };
  state: CoverageState;
  freshness?: {
    lastUsableAt?: string | null;
    policyMaxAgeSeconds?: number | null;
  };
  confidenceValue: number;
  reason: string;
}

/** Query shape of `listClaims`. All filters are optional and AND-combined. */
export interface ListClaimsQuery {
  surfaceKey?: string;
  state?: CoverageState;
  sourceRef?: string;
  limit?: number;
}

/**
 * A material missing or stale portion of company observability (§3) — an
 * attention input, not merely a dashboard warning. Gaps are derived by
 * snapshot evaluation and stay attached to the snapshot that detected
 * them; `affectedGoalIds` is the W127 (coverage-to-goal attention)
 * extension point and stays empty in W125.
 */
export interface CoverageGap {
  id: string;
  tenantId: string;
  /** The snapshot that detected the gap. */
  snapshotId: string;
  surfaceKey: string;
  /** The dimension the gap most implicates. */
  dimension: CoverageDimension;
  /** The surface state that produced the gap. */
  state: CoverageState;
  reason: string;
  /** True when the gap is material (evidence exists but is deficient). */
  material: boolean;
  /** Goals the gap affects — filled by W127; empty in W125. */
  affectedGoalIds: string[];
  /** ISO 8601 — detection time (snapshot evaluation time). */
  detectedAt: string;
}

/** Query shape of `listGaps`. All filters are optional and AND-combined. */
export interface ListGapsQuery {
  snapshotId?: string;
  surfaceKey?: string;
  dimension?: CoverageDimension;
  material?: boolean;
  limit?: number;
}

/**
 * An immutable-at-evaluation-time summary of the company's observable
 * surface (§3). Answers: what surfaces are covered, which sources provide
 * that coverage, approximate completeness, freshness, confidence, policy
 * restrictions, unresolved gaps and goal/decision impact. A later snapshot
 * never rewrites an earlier one (append-only at the storage level).
 */
export interface CoverageSnapshot {
  id: string;
  tenantId: string;
  /** ISO 8601 — evaluation time (service clock). */
  evaluatedAt: string;
  /** Per-surface rollup, one entry per considered surface. */
  surfaces: SurfaceSummary[];
  /** All nine §4 dimensions, measured separately — never one percentage. */
  dimensions: DimensionMeasurement[];
  /** Intentional absences (§5 UNAUTHORIZED/EXCLUDED), stated calmly. */
  policyRestrictions: { surfaceKey: string; note: string }[];
  /** The unresolved gaps this evaluation detected. */
  gaps: CoverageGap[];
}

/** One surface's rollup inside a snapshot. */
export interface SurfaceSummary {
  surfaceKey: string;
  state: CoverageState;
  /** How many distinct registered sources currently contribute claims. */
  contributingSources: number;
  /** Mean confidence of the contributing evidence claims (0 when none). */
  confidenceValue: number;
  /** Latest usable observation across contributing evidence claims. */
  lastUsableAt: string | null;
}

/**
 * One §4 dimension's measurement. `value` is a 0..1 fraction where the
 * registry can measure it and null when it cannot (the dimension stays
 * honestly UNKNOWN with its basis explaining what is missing — §15:
 * "coverage dimensions are independently measurable", which includes
 * honestly reporting not-yet-measurable).
 */
export interface DimensionMeasurement {
  dimension: CoverageDimension;
  /** 0..1 measured fraction, or null when not measurable at this layer. */
  value: number | null;
  state: CoverageState;
  /** Machine-readable explanation of exactly how this was computed. */
  basis: string;
}

/** `listSnapshots` summary row (full documents are fetched by id). */
export interface CoverageSnapshotSummary {
  id: string;
  tenantId: string;
  evaluatedAt: string;
  surfaceCount: number;
  gapCount: number;
}

/** Query shape of `evaluateSnapshot` — restrict evaluation to a subset. */
export interface EvaluateSnapshotQuery {
  /** Consider only these registered surfaces (default: all of them). */
  surfaceKeys?: string[];
}

/** Query shape of `getSnapshot`. */
export interface GetSnapshotQuery {
  snapshotId: string;
}

/** Query shape of `listSnapshots`. */
export interface ListSnapshotsQuery {
  limit?: number;
}
