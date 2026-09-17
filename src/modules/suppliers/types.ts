// Public domain types of the suppliers module (W020 — Supplier Intelligence).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W020):
// "Score suppliers/subcontractors on price, quality, reliability, capacity,
//  compliance, geography, switching cost and alternatives."
//
// ARCHITECTURE.md §4 names Supplier and Subcontractor among the core world
// entities; §26 makes `suppliers` a core module. The dependency DAG places
// W020 after W017 (Capability Graph), and the capabilities contract's own
// documentation states that the supplier intelligence module reads a
// supplier's capabilities through the capabilities contract — the
// `alternatives` half of this work item is grounded there.
//
// A supplier record is UNDERSTANDING, not reality (ARCHITECTURE.md §4:
// "Reality is immutable; understanding is mutable"). The immutable facts
// live in events (W003) and observations (W004); the supplier registry and
// its scorecards are curated, versioned understanding in the goals (W008)
// discipline: every record is an identity (uuid) plus an append-only chain
// of full-snapshot versions — changing a record appends the next version
// and never rewrites history, so what Aurum believed about a supplier at
// any time stays reconstructable (§24 decision evidence). The derived layer
// (the weighted overall score, the ranking, the alternatives analysis) is
// NEVER persisted: it is a deterministic pure function of the current
// records (scoring.ts), so it can never drift from the state it summarizes
// (lock 10 — derived intelligence, never authoritative truth).
//
// The two record kinds:
//
//   Supplier          — a supplier or subcontractor of the tenant: a
//                       tenant-unique IMMUTABLE name (the graph key:
//                       registering the same name twice is a conflict —
//                       revise the winner instead), an IMMUTABLE kind
//                       (supplier | subcontractor, the work item's two
//                       flavors — what an external party IS does not drift
//                       with understanding), a versioned description, an
//                       opaque world-entity forward reference and a
//                       versioned lifecycle status.
//
//   SupplierScorecard — ONE assessment chain per supplier (UNIQUE
//                       (tenant_id, supplier_id)): append-only versions,
//                       each a full self-contained snapshot scoring the
//                       supplier on the EIGHT dimensions the work item names
//                       verbatim — price, quality, reliability, capacity,
//                       compliance, geography, switching cost, alternatives
//                       — each in [0, 1] where 1 is most favorable, or null
//                       (unscored: missing data never masquerades as an
//                       assessment). Every version must score at least one
//                       dimension (a fully-null snapshot is meaningless);
//                       `completeness` in the derived layer reports how many
//                       of the eight are actually scored, so a reader can
//                       always tell a strong overall from a thin one.
//
// The overall score, ranking and alternatives analysis are DERIVED
// (scoring.ts / the service's analysis operations): the weighted mean over
// the SCORED dimensions (weights are read-time parameters, default 1 each —
// a scorecard never silently embeds a policy), never stored.
//
// The `alternatives` dimension is also grounded structurally: through the
// capabilities contract (W017) the intelligence view reports, per capability
// the supplier supplies, the OTHER parties supplying it — alternative
// suppliers (resolvable back to this module's registry by the documented
// linkage convention), internal suppliers (employees, teams, agents,
// software, partners — the six W017 supply channels) and retired supplies
// (reactivation candidates). Richer supplier attributes (locations,
// contracts, payment terms) live in the world model (W005) behind
// `worldEntityId` — opaque here by design (the capabilities precedent: no
// cross-module foreign keys, no contract imports for attribute storage).

/** The two record flavors the W020 work item names verbatim (TEXT + CHECK in storage). */
export type SupplierKind = 'supplier' | 'subcontractor';

/**
 * Kinds of parties that can make a supplier-registry or scorecard change
 * (the audit actor). The events envelope's actor vocabulary minus `source`,
 * the same five kinds the capabilities and processes modules use.
 */
export type SupplierPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/** Lifecycle status of a supplier (versioned content). */
export type SupplierRecordStatus = 'active' | 'retired';

/**
 * What kind of change one supplier version represents — service-minted,
 * never caller-supplied (the goals module's discipline):
 *  * 'created'     — version 1 (the supplier was registered);
 *  * 'revised'     — content change on an active supplier;
 *  * 'retired'     — lifecycle transition active → retired;
 *  * 'reactivated' — lifecycle transition retired → active.
 */
export type SupplierChangeKind = 'created' | 'revised' | 'retired' | 'reactivated';

/**
 * What kind of change one scorecard version represents — service-minted:
 *  * 'assessed'   — version 1 (the first assessment of the supplier);
 *  * 'reassessed' — every subsequent appended assessment snapshot.
 * A scorecard has no lifecycle of its own: it is the supplier's current
 * assessment understanding, and its history is the audit trail.
 */
export type ScorecardChangeKind = 'assessed' | 'reassessed';

/**
 * The eight scoring dimensions the W020 work item names verbatim. Canonical
 * order (work-item order, mirrored by SCORE_DIMENSIONS in validation.ts):
 * price, quality, reliability, capacity, compliance, geography,
 * switching_cost, alternatives. Each is scored in [0, 1]:
 *  * price          — price competitiveness (1 = most favorable cost position);
 *  * quality        — delivered quality of goods/services;
 *  * reliability    — delivery/SLA dependability over time;
 *  * capacity       — ability to absorb the volume the tenant needs;
 *  * compliance     — regulatory/certification/policy standing;
 *  * geography      — geographic fit (proximity, timezone, jurisdiction risk);
 *  * switching_cost — ease of moving away (1 = low switching cost);
 *  * alternatives   — availability of substitutes for what they supply.
 */
export type ScoreDimension =
  | 'price'
  | 'quality'
  | 'reliability'
  | 'capacity'
  | 'compliance'
  | 'geography'
  | 'switching_cost'
  | 'alternatives';

/**
 * One supplier's scores on the eight dimensions (the scorecard's content):
 * each a finite number in [0, 1] (1 = most favorable) or null — unscored.
 * Missing data is null, never zero: an unscored dimension is excluded from
 * the derived overall (and counted by completeness), never silently read
 * as a failing grade.
 */
export interface SupplierDimensionScores {
  price: number | null;
  quality: number | null;
  reliability: number | null;
  capacity: number | null;
  compliance: number | null;
  geography: number | null;
  switchingCost: number | null;
  alternatives: number | null;
}

/**
 * Read-time weights for the derived overall score: one finite number ≥ 0
 * per dimension, omitted dimensions default to 1 (DEFAULT_SCORE_WEIGHTS).
 * Weights live ONLY in the derived layer — a scorecard never embeds a
 * weighting policy (lock 14's spirit; the weighting is an explicit,
 * auditable read parameter, never silently persisted state).
 */
export type ScoreWeightSet = Partial<Record<ScoreDimension, number>>;

/** A provider-neutral audit actor (the capabilities module's party shape). */
export interface SupplierActor {
  kind: SupplierPartyKind;
  id?: string | null;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/** Input shape of `registerSupplier`. */
export interface RegisterSupplierInput {
  /** Tenant-unique graph key; immutable after registration (1..200 chars). */
  name: string;
  /** The work item's two flavors — immutable identity content. */
  kind: SupplierKind;
  /** Optional human description (≤ 2000 chars). */
  description?: string | null;
  /** Opaque forward reference to a world-model (W005) supplier/subcontractor entity. */
  worldEntityId?: string | null;
  /** Who registered the supplier (audit trail). */
  actor: SupplierActorInput;
  /** Why, if stated — recorded on version 1. */
  rationale?: string | null;
}

/** Patch shape of `reviseSupplier` (undefined = carry over, null = clear). */
export interface ReviseSupplierInput {
  supplierId: string;
  description?: string | null;
  worldEntityId?: string | null;
  /** Lifecycle change; must be the only change in its revision (surgical). */
  status?: SupplierRecordStatus;
  actor: SupplierActorInput;
  rationale?: string | null;
}

/**
 * The current assessment summary embedded in a supplier's current view —
 * computed with the DEFAULT weights (read-time weighting belongs to
 * `rankSuppliers` / `getSupplierIntelligence`, which accept weights).
 */
export interface SupplierAssessmentSummary {
  /** The scorecard identity (deep-linkable). */
  scorecardId: string;
  /** Current scorecard version number. */
  version: number;
  /** How many of the eight dimensions the current version scores. */
  scoredDimensions: number;
  /** Always 8 (the work item's verbatim dimension count). */
  totalDimensions: number;
  /** scoredDimensions / totalDimensions in [0, 1]. */
  completeness: number;
  /** Derived overall under DEFAULT weights; null when nothing is scored. */
  overall: number | null;
  /** ISO 8601 — when the current scorecard version was committed. */
  assessedAt: string;
}

/** The current view of a supplier: identity + current content + audit + assessment summary. */
export interface Supplier {
  id: string;
  tenantId: string;
  /** Immutable graph key, unique per tenant. */
  name: string;
  /** Immutable identity content: supplier | subcontractor. */
  kind: SupplierKind;
  /** Current version number. */
  version: number;
  description: string | null;
  worldEntityId: string | null;
  status: SupplierRecordStatus;
  /** Current assessment summary, or null when the supplier was never assessed. */
  assessment: SupplierAssessmentSummary | null;
  /** ISO 8601 — when the supplier identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: SupplierChangeSummary;
}

/** Audit summary shared by the current views. */
export interface SupplierChangeSummary {
  kind: SupplierChangeKind | ScorecardChangeKind;
  actor: SupplierActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

/** One append-only version of a supplier — the audit record (self-contained). */
export interface SupplierVersion {
  /** Version-row id (distinct from the supplier identity). */
  id: string;
  tenantId: string;
  supplierId: string;
  /** 1-based, strictly increasing per supplier; service-minted. */
  version: number;
  changeKind: SupplierChangeKind;
  /** Always the identity's immutable name and kind (snapshotted for self-containment). */
  name: string;
  kind: SupplierKind;
  description: string | null;
  worldEntityId: string | null;
  status: SupplierRecordStatus;
  actor: SupplierActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

/** Input shape of `recordScorecard` (the FIRST assessment of a supplier). */
export interface RecordScorecardInput {
  supplierId: string;
  /** Scores on the eight dimensions; each in [0, 1] or omitted (unscored); ≥ 1 required. */
  scores?: Partial<SupplierDimensionScores>;
  /** Observation (W004) ids cited as evidence (≤ 32, opaque forward references). */
  evidenceObservationIds?: string[];
  /** Free-text note (≤ 2000 chars). */
  note?: string | null;
  actor: SupplierActorInput;
  rationale?: string | null;
}

/**
 * Patch shape of `reviseScorecard` (the next appended assessment).
 * Tri-state per score: undefined = carry over the current score, null =
 * clear to unscored, number = set. The merged snapshot must score ≥ 1
 * dimension. `evidenceObservationIds` replaces the previous list wholesale.
 */
export interface ReviseScorecardInput {
  scorecardId: string;
  scores?: Partial<SupplierDimensionScores>;
  evidenceObservationIds?: string[];
  note?: string | null;
  actor: SupplierActorInput;
  rationale?: string | null;
}

/** The current view of a scorecard: identity + current content + audit. */
export interface SupplierScorecard {
  id: string;
  tenantId: string;
  supplierId: string;
  /** Current version number. */
  version: number;
  scores: SupplierDimensionScores;
  evidenceObservationIds: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: SupplierChangeSummary;
}

/** One append-only version of a scorecard — the audit record (self-contained). */
export interface SupplierScorecardVersion {
  id: string;
  tenantId: string;
  scorecardId: string;
  supplierId: string;
  version: number;
  changeKind: ScorecardChangeKind;
  scores: SupplierDimensionScores;
  evidenceObservationIds: string[];
  note: string | null;
  actor: SupplierActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Derived scoring
// ---------------------------------------------------------------------------

/** One dimension's derived view: the score, the effective weight and whether it is scored. */
export interface DimensionScore {
  dimension: ScoreDimension;
  /** The current score in [0, 1], or null (unscored). */
  score: number | null;
  /** The effective weight (read-time set, default 1). */
  weight: number;
}

/**
 * The derived scoring summary of one scorecard — never persisted. The
 * overall is the weighted mean over the dimensions that carry BOTH a score
 * and a positive weight; unscored dimensions are excluded from numerator
 * and denominator (missing data never drags an average down), and
 * `completeness` keeps the thinness visible.
 */
export interface ScoringSummary {
  /** The eight dimensions in canonical work-item order. */
  dimensions: DimensionScore[];
  /** Weighted mean over scored dimensions with positive weight; null when there is none. */
  overall: number | null;
  /** How many of the eight dimensions are scored. */
  scoredDimensions: number;
  /** Always 8. */
  totalDimensions: number;
  /** scoredDimensions / totalDimensions in [0, 1]. */
  completeness: number;
}

/** One entry of the derived ranking (`rankSuppliers`) — never persisted. */
export interface SupplierRanking {
  /** 1-based position in the deterministic ranking order. */
  rank: number;
  /** Lightweight supplier reference. */
  supplier: {
    id: string;
    tenantId: string;
    name: string;
    kind: SupplierKind;
    status: SupplierRecordStatus;
  };
  /** Lightweight current-scorecard reference (deep-linkable). */
  scorecard: { id: string; version: number; assessedAt: string };
  scoring: ScoringSummary;
}

// ---------------------------------------------------------------------------
// Supplier intelligence (the derived deep view)
// ---------------------------------------------------------------------------

/**
 * A capability the supplier supplies, read through the capabilities
 * contract (W017): the capability reference plus this supplier's supply of
 * it. `own` linkage convention: the capabilities supply's supplier party is
 * `{ kind: 'supplier', id: supplier.id }` or `{ kind: 'supplier', label: supplier.name }`.
 */
export interface SuppliedCapability {
  capability: {
    id: string;
    name: string;
    status: 'active' | 'retired';
  };
  supplyId: string;
  level: number;
  capacity: number | null;
  status: 'active' | 'retired';
}

/** One alternative supply of a capability (another party's supply). */
export interface AlternativeSupply {
  supplyId: string;
  /** The capabilities supplier party (opaque, provider-neutral — lock 16). */
  supplier: {
    kind: 'employee' | 'team' | 'agent' | 'software' | 'supplier' | 'partner';
    id: string | null;
    label: string | null;
  };
  level: number;
  capacity: number | null;
  status: 'active' | 'retired';
  /**
   * Present when the party resolves to a record in THIS module's registry
   * (kind 'supplier' with party id === supplier uuid or party label ===
   * supplier name): the alternative supplier with its derived overall under
   * the analysis's effective weights (null when unscored).
   */
  resolvedSupplier: {
    id: string;
    name: string;
    kind: SupplierKind;
    status: SupplierRecordStatus;
    overall: number | null;
  } | null;
}

/**
 * The alternatives of one capability the supplier (actively) supplies:
 * the other parties supplying it — the grounded `alternatives` dimension.
 */
export interface CapabilityAlternatives {
  capability: { id: string; name: string };
  /** The supplier's own supplies of this capability (one or more — the linkage convention can match several supply records). */
  ownSupplies: { supplyId: string; level: number; capacity: number | null; status: 'active' | 'retired' }[];
  /** How many ACTIVE alternative supplies exist (all six supply channels). */
  activeAlternativeCount: number;
  /** Active alternative supplies per supplier kind (the six supply channels). */
  activeByKind: Record<'employee' | 'team' | 'agent' | 'software' | 'supplier' | 'partner', number>;
  /** Other parties' ACTIVE supplies — the available alternatives. */
  activeAlternatives: AlternativeSupply[];
  /** Other parties' retired supplies — reactivation candidates. */
  retiredAlternatives: AlternativeSupply[];
}

/**
 * The derived per-supplier intelligence view (never persisted): the
 * supplier, its current scorecard, the derived scoring under the effective
 * weights, the capabilities it supplies and, per actively-supplied
 * capability, the alternatives grounded in the capability graph.
 */
export interface SupplierIntelligence {
  supplier: Supplier;
  scorecard: SupplierScorecard | null;
  /** Null when the supplier has no current scorecard. */
  scoring: ScoringSummary | null;
  /** Every supply linked to this supplier (any status), with its capability. */
  suppliedCapabilities: SuppliedCapability[];
  /** One entry per capability the supplier supplies with ≥ 1 ACTIVE supply. */
  alternatives: CapabilityAlternatives[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Query shape of `listSuppliers` (over CURRENT versions only). */
export interface ListSuppliersQuery {
  /** Exact name match. */
  name?: string;
  /** Case-insensitive substring on the name. */
  search?: string;
  kind?: SupplierKind;
  status?: SupplierRecordStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getSupplierVersion`. */
export interface GetSupplierVersionQuery {
  supplierId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listSupplierVersions`. */
export interface ListSupplierVersionsQuery {
  supplierId: string;
}

/** Query shape of `getScorecardVersion`. */
export interface GetScorecardVersionQuery {
  scorecardId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listScorecardVersions`. */
export interface ListScorecardVersionsQuery {
  scorecardId: string;
}

/**
 * Query shape of `rankSuppliers` — the derived ranking. Only ACTIVE
 * suppliers with a current scorecard participate (every stored scorecard
 * version scores ≥ 1 dimension by CHECK); entries whose overall is null
 * under the effective weights (no scored dimension carries a positive
 * weight) are skipped — they cannot be ranked.
 */
export interface RankSuppliersQuery {
  /** Restrict the ranking to suppliers or subcontractors. */
  kind?: SupplierKind;
  /** Read-time weights for the derived overall (defaults: 1 per dimension). */
  weights?: ScoreWeightSet;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getSupplierIntelligence`. */
export interface GetSupplierIntelligenceQuery {
  /** Must exist in this tenant. */
  supplierId: string;
  /** Read-time weights for the derived scoring (defaults: 1 per dimension). */
  weights?: ScoreWeightSet;
}

// ---------------------------------------------------------------------------
// Input shapes (distinct names so contracts read clearly)
// ---------------------------------------------------------------------------

/** Input shape of `SupplierActor` (audit actor). */
export interface SupplierActorInput {
  kind: SupplierPartyKind;
  id?: string | null;
  label?: string | null;
}
