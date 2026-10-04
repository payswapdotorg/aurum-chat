// ============================================================================
// company-query — the ONLY public surface of the company-query module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W126 — Company Query Plane (spec/POST-W123-COVERAGE-DAG-2026-10-04.md;
// spec/COMPANY-COVERAGE-ARCHITECTURE.md §6/§7):
//
//   runCompanyQuery — ONE provider-independent question about the company,
//      answered over authorized evidence through the existing module
//      contracts (world W005, epistemics W007, memory W010, observations
//      W004, sources W036, channels W030, freshness W006, goals W008, llm
//      W034). The pipeline is the ten §6 steps, and the response is the
//      two-layer shape:
//
//        Answer          — material claims with claim-level provenance and
//                          freshness, retained contradictions (provenance
//                          on BOTH sides), surfaced unknowns, and an
//                          optional LLM-generated PRESENTATION that is never
//                          authoritative (lock 10: it is stored nowhere and
//                          feeds no domain record — a test locks that the
//                          whole structured answer is identical with the
//                          LLM unused);
//        CoverageContext — per-surface observability (§5 states, source
//                          contributions, freshness), caveats, the material
//                          gaps that could change THIS answer (§6 step 7),
//                          and the §7 honesty answer for "how much can you
//                          see"-class questions.
//
// The structured representation stays machine-readable for API/MCP
// consumers; the product UI may summarize it. There is deliberately NO
// write, update or delete operation on this surface: the query plane is a
// read/composition plane. Its only persistence is the append-only query
// audit (migrations/001) — what was asked and how strong the answer was,
// never answer content as domain truth.
//
// INTEGRATION NOTE (W125 — the coverage registry): the coverage vocabulary
// exported below (COMPANY_SURFACES / COVERAGE_STATES and the coverage
// context types) is the query-side LOCAL mirror of the TL-frozen coverage
// vocabulary. When W125's registry lands, the Tech Lead re-points this
// module's derivation at `@/modules/coverage/contract`; until then the
// derivation is conservative and query-side (see coverage.ts).
//
// Tenancy (ADR-0001): runCompanyQuery takes an explicit TenantContext and
// every composed read is tenant-scoped by the owning module's SQL layer —
// another tenant's evidence, epistemics or sources are indistinguishable
// from missing ones, and the audit row lands in the asking tenant only.
// ============================================================================

export { runCompanyQuery } from './service';

export { CompanyQueryError } from './errors';
export type { CompanyQueryErrorCode } from './errors';

export {
  // guards + limits
  isCompanySurface,
  MAX_QUESTION_LENGTH,
  MAX_SURFACES,
} from './validation';
export type { ValidatedCompanyQueryInput } from './validation';

// The frozen vocabularies (types.ts is their single home).
export { COMPANY_CLAIM_KINDS, COMPANY_SURFACES, COVERAGE_STATES } from './types';

// The pure coverage derivation (unit-testable without a database; the
// deterministic core behind the CoverageContext layer).
export {
  CHANNEL_PROVIDER_SURFACES,
  DEFAULT_EVIDENCE_THRESHOLDS,
  OBSERVATION_KIND_SURFACES,
  SOURCE_PROVIDER_SURFACES,
  SURFACE_QUESTION_KEYWORDS,
  answerCoverageQuestion,
  deriveCaveats,
  deriveMaterialGaps,
  deriveSurfaceCoverage,
  isCoverageQuestion,
  observationFreshness,
  surfacesForObservationKind,
  surfacesForQuestion,
} from './coverage';
export type {
  CoverageDerivationInput,
  CoverageEvidenceCensus,
  CoverageSourceCandidate,
} from './coverage';

export type {
  CompanyClaimKind,
  CompanyClaimProvenance,
  CompanyCoverageGap,
  CompanyCoverageSourceSummary,
  CompanyCoverageSurfaceSummary,
  CompanyHonestyAnswer,
  CompanyQueryAnswer,
  CompanyQueryClaim,
  CompanyQueryContradiction,
  CompanyQueryContradictionSide,
  CompanyQueryCoverageContext,
  CompanyQueryInput,
  CompanyQueryLlmPresentation,
  CompanyQueryResponse,
  CompanyQueryUnknown,
  CompanySurface,
  CoverageState,
} from './types';
