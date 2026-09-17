// ============================================================================
// suppliers — the ONLY public surface of the suppliers module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W020 — Supplier Intelligence:
// "Score suppliers/subcontractors on price, quality, reliability, capacity,
//  compliance, geography, switching cost and alternatives."
//
//   Suppliers (the registry)
//     registerSupplier   — register a supplier or subcontractor (version 1
//        'created', status minted 'active'). The name is the tenant-unique
//        IMMUTABLE graph key: registering an existing name fails with
//        `supplier_name_conflict` — revise the winner instead. The kind
//        (supplier | subcontractor, the work item's two flavors) is
//        immutable identity content as well.
//     reviseSupplier     — append the next version. Omitted fields carry
//        over; `null` clears; a `status` change must be the only change
//        (surgical lifecycle); a retired supplier accepts nothing but a
//        reactivation.
//     getSupplier        — the current view: identity + current content +
//        audit summary + the current assessment summary (default weights).
//     listSuppliers      — current views, filtered (exact name, name
//        search, kind, status), ordered by name.
//     getSupplierVersion / listSupplierVersions — the audit deep links.
//
//   Scorecards (the scoring — the work item's first half)
//     recordScorecard   — the FIRST assessment of one supplier (version 1
//        'assessed'). ONE assessment chain per supplier — a second record
//        fails with `scorecard_conflict`; revise instead. Scores the EIGHT
//        dimensions the work item names verbatim (price, quality,
//        reliability, capacity, compliance, geography, switchingCost,
//        alternatives), each in [0, 1] or null (unscored — missing data is
//        never a grade); at least one dimension must be scored; evidence
//        observation ids are opaque forward references to the observations
//        module (W004).
//     reviseScorecard   — append the next assessment snapshot ('reassessed').
//        Tri-state per score: undefined = carry over, null = clear to
//        unscored, number = set; the merged snapshot must still score ≥ 1
//        dimension. An assessment cannot be recorded or revised against a
//        retired supplier.
//     getScorecard / getScorecardVersion / listScorecardVersions — the
//        current view and the audit deep links.
//
//   The derived layer (never persisted — lock 10)
//     rankSuppliers     — the deterministic ranking of ACTIVE assessed
//        suppliers by the derived weighted overall (read-time weights,
//        default 1 per dimension), with per-dimension breakdown and
//        completeness; overall DESC, then name, then id. Retired suppliers
//        and unscored suppliers do not rank.
//     getSupplierIntelligence — the per-supplier deep view: the supplier,
//        its current scorecard, the derived scoring under the effective
//        weights, the capabilities it supplies (read through the
//        capabilities contract — W017, this module's declared dependency)
//        and, per actively-supplied capability, the ALTERNATIVES grounded
//        in the capability graph: the other parties' supplies — alternative
//        suppliers (resolvable back to this registry by the documented
//        linkage convention, score-backed), internal channels
//        (employee/team/agent/software/partner) and retired supplies
//        (reactivation candidates).
//
// There is deliberately NO operation to update or delete a version, a
// scorecard or a supplier, and NO way to rewrite a name or a kind: the
// supplier registry is versioned understanding in the goals (W008)
// discipline — revisions append, retirements retire (versioned status
// change, no erasure) — and PostgreSQL itself rejects UPDATE/DELETE/
// TRUNCATE on the version tables and DELETE/TRUNCATE on the identity
// tables via migration 001 triggers. Overall scores, weights, ranks and
// alternatives are never stored at all: they are recomputed from the
// current records on every read (lock 10).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's supplier
// registry (including versions and scorecards) is reported as
// `supplier_not_found` / `supplier_version_not_found` /
// `scorecard_not_found` / `scorecard_version_not_found` — no existence
// leak.
// ============================================================================

export {
  // registry writes
  registerSupplier,
  reviseSupplier,
  // scorecard writes
  recordScorecard,
  reviseScorecard,
  // registry reads
  getSupplier,
  listSuppliers,
  getSupplierVersion,
  listSupplierVersions,
  // scorecard reads
  getScorecard,
  getScorecardVersion,
  listScorecardVersions,
  // derived intelligence
  rankSuppliers,
  getSupplierIntelligence,
} from './service';

export { SuppliersError } from './errors';
export type { SuppliersErrorCode } from './errors';

export {
  // vocabularies
  SUPPLIER_KINDS,
  SUPPLIER_PARTY_KINDS,
  SUPPLIER_RECORD_STATUSES,
  SUPPLIER_CHANGE_KINDS,
  SCORECARD_CHANGE_KINDS,
  SCORE_DIMENSIONS,
  DIMENSION_FIELD,
  // caps
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_PARTY_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_ANALYSIS_SUPPLIES,
  MAX_ANALYSIS_CAPABILITIES,
  MAX_RANK_CANDIDATES,
  MAX_WEIGHT,
  // guards / helpers
  assertSuppliersTenantContext,
  escapeLike,
  isSupplierKind,
  isSupplierPartyKind,
  isSupplierRecordStatus,
  isScoreDimension,
  isUuid,
  scoredDimensionCount,
  mergeScorePatch,
} from './validation';
export type {
  ValidatedParty,
  ValidatedRegisterSupplierInput,
  ValidatedReviseSupplierInput,
  ValidatedSupplierPatch,
  ValidatedRecordScorecardInput,
  ValidatedReviseScorecardInput,
  ValidatedScorePatch,
  ValidatedListSuppliersQuery,
  ValidatedVersionQuery,
  ValidatedHistoryQuery,
  ValidatedRankSuppliersQuery,
  ValidatedIntelligenceQuery,
} from './validation';

export {
  DEFAULT_SCORE_WEIGHTS,
  effectiveWeights,
  computeScoring,
  computeOverall,
  rankingCompare,
  buildRanking,
} from './scoring';
export type { RankingRecord } from './scoring';

export type {
  AlternativeSupply,
  CapabilityAlternatives,
  DimensionScore,
  GetScorecardVersionQuery,
  GetSupplierIntelligenceQuery,
  GetSupplierVersionQuery,
  ListScorecardVersionsQuery,
  ListSupplierVersionsQuery,
  ListSuppliersQuery,
  RankSuppliersQuery,
  RecordScorecardInput,
  RegisterSupplierInput,
  ReviseScorecardInput,
  ReviseSupplierInput,
  ScorecardChangeKind,
  ScoreDimension,
  ScoreWeightSet,
  ScoringSummary,
  Supplier,
  SupplierActor,
  SupplierActorInput,
  SupplierAssessmentSummary,
  SupplierChangeKind,
  SupplierChangeSummary,
  SupplierDimensionScores,
  SupplierIntelligence,
  SupplierKind,
  SupplierPartyKind,
  SupplierRanking,
  SupplierRecordStatus,
  SupplierScorecard,
  SupplierScorecardVersion,
  SupplierVersion,
  SuppliedCapability,
} from './types';
