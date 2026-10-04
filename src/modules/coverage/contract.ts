// ============================================================================
// coverage — the ONLY public surface of the coverage module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W125 — Company Coverage Registry and Measurement Model:
// "Introduce the provider-neutral coverage contract" (spec/
// POST-W123-COVERAGE-DAG-2026-10-04.md; COMPANY-COVERAGE-ARCHITECTURE.md
// §2–§5, frozen vocabulary in ./types).
//
//   THE REGISTRY (§3):
//     registerSurface / listSurfaces
//     registerSource / listSources
//        — tenant-scoped, provider-neutral semantic surfaces
//          ("support-tickets", "meetings", "finance", ...) and opaque
//          references to the REAL source/channel/meeting/integration
//          registries. Credentials never enter coverage state (§13):
//          validation rejects credential-shaped keys and raw-credential
//          values, and the schema carries no credential-bearing column.
//     recordClaim / listClaims
//        — append-only derived statements about observability: surface,
//          source reference, observation basis (the evidence/connection
//          ids the statement was derived from), current §5 state,
//          freshness, confidence, evaluation time and reason. Claims may
//          only address REGISTERED surfaces and sources — the registry is
//          the authority on what is tracked (§2: coverage is a derived
//          view, never another organizational database). The latest claim
//          per (surface, source) is the current statement; history is
//          kept, never rewritten.
//
//   THE MEASUREMENT MODEL (§4) + THE SNAPSHOT (§3):
//     evaluateSnapshot
//        — assembles the immutable-at-evaluation-time CoverageSnapshot
//          from the current claims: per-surface rollups, ALL NINE §4
//          dimensions measured SEPARATELY (never one percentage), the §5
//          policy restrictions stated calmly, and the §3 CoverageGaps (an
//          attention input, not a dashboard warning). The dimensions this
//          registry layer cannot see yet (identity continuity → W095,
//          outcome completeness → W040, goal sufficiency → W127) read
//          honestly UNKNOWN with their basis saying exactly what is
//          missing. Snapshots and gaps are APPEND-ONLY: PostgreSQL
//          triggers reject UPDATE/DELETE/TRUNCATE outright — a later
//          snapshot never rewrites an earlier one (§3).
//     getSnapshot / listSnapshots / listGaps
//        — tenant-scoped reads of the derived history.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's surfaces, sources,
// claims, gaps and snapshots are indistinguishable from missing ones
// (`surface_not_found` / `source_not_found` / `claim_not_found` /
// `snapshot_not_found` — no existence leak).
//
// Cross-module reads: NONE by design. The declared W125 dependency world
// (W081 integration intelligence, W082 connection broker, W085 meeting
// gateway, W095 unified identity, W096 integration fixture — spec/
// WORK-ITEM-DEPENDENCY-GRAPH.md) is the DERIVATION world: evaluator
// surfaces (W129 interaction adapters, W127 goal attention) record claims
// derived from real connector/evidence state through THOSE modules'
// contracts; this registry stores, measures and snapshots what they
// record. The audit module's documented precedent for a
// verified-but-not-imported declared dependency applies. Error
// propagation policy: see errors.ts.
//
// W126 (Company Query Plane) builds on THIS contract; W127 (coverage-to-
// goal attention) extends CoverageGap.affectedGoalIds additively.
// ============================================================================

export {
  evaluateSnapshot,
  getSnapshot,
  listClaims,
  listGaps,
  listSnapshots,
  listSources,
  listSurfaces,
  recordClaim,
  registerSource,
  registerSurface,
} from './service';

export { CoverageError } from './errors';
export type { CoverageErrorCode } from './errors';

export {
  COVERAGE_DIMENSIONS,
  COVERAGE_SOURCE_REGISTRIES,
  COVERAGE_STATES,
  DEPTH_BASIS_TARGET,
  DEFAULT_LIST_LIMIT,
  MAX_BASIS_IDS,
  MAX_DESCRIPTION_CHARS,
  MAX_LABEL_CHARS,
  MAX_LIST_LIMIT,
  MAX_REASON_CHARS,
  deriveGaps,
  derivePolicyRestrictions,
  isCoverageDimension,
  isCoverageSourceRegistry,
  isCoverageState,
  isUuid,
  measureDimensions,
  rollupSurfaces,
} from './validation';

export type {
  ValidatedEvaluateSnapshotQuery,
  ValidatedGetSnapshotQuery,
  ValidatedListClaimsQuery,
  ValidatedListGapsQuery,
  ValidatedListSnapshotsQuery,
  ValidatedListSourcesQuery,
  ValidatedListSurfacesQuery,
  ValidatedRecordClaimInput,
  ValidatedRegisterSourceInput,
  ValidatedRegisterSurfaceInput,
} from './validation';

export type {
  CoverageClaim,
  CoverageDimension,
  CoverageGap,
  CoverageSnapshot,
  CoverageSnapshotSummary,
  CoverageSource,
  CoverageSourceRegistry,
  CoverageState,
  CoverageSurface,
  DimensionMeasurement,
  EvaluateSnapshotQuery,
  GetSnapshotQuery,
  ListClaimsQuery,
  ListGapsQuery,
  ListSnapshotsQuery,
  ListSourcesQuery,
  ListSurfacesQuery,
  RecordClaimInput,
  RegisterSourceInput,
  RegisterSurfaceInput,
  SurfaceSummary,
} from './types';
