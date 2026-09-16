// Public domain types of the capabilities module (W017 — Capability Graph).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W017):
// "Model capabilities supplied by employees, teams, agents, software,
//  suppliers and partners; identify gaps and available alternatives."
//
// ARCHITECTURE.md §13 (frozen) continues the chain W016 started:
// `process → capability → gap → acquisition option → authorization →
//  deployment → outcome` — this module owns the middle links the chain is
//  built on: WHAT the company can do (capabilities), WHO supplies each one
// (the six supplier kinds the work item names verbatim: employees, teams,
// agents, software, suppliers, partners), WHAT DEMANDS each one (requirements
// sourced from goals, processes, projects, opportunities or a directly
// declared need) and the derived intelligence: where supply falls short of
// demand (gaps) and who else could supply a capability (alternatives).
//
// A capability graph is UNDERSTANDING, not reality (ARCHITECTURE.md §4:
// "Reality is immutable; understanding is mutable"). The immutable facts live
// in the events (W003) and observations (W004) modules; supplies, requirements
// and capability records are curated, versioned understanding in the goals
// (W008) discipline: every record is an identity (uuid) plus an append-only
// chain of full-snapshot versions — changing a record appends the next
// version and never rewrites history, so what Aurum believed about the
// capability graph at any time stays reconstructable (§24 decision evidence).
// The derived layer (gaps, alternatives) is NEVER persisted: it is a
// deterministic pure function of the current records (gap.ts), so it can
// never drift from the evidence-shaped state it summarizes (lock 10 —
// derived intelligence, never authoritative truth).
//
// The three record kinds:
//
//   Capability        — a named thing a company can do or needs (e.g.
//                       "German-language support", "Invoice processing").
//                       Identity-keyed by a tenant-unique IMMUTABLE name (the
//                       graph key: registering the same name twice is a
//                       conflict, renaming would fragment the graph — revise
//                       the description instead). Content: description,
//                       opaque world-entity forward reference, lifecycle
//                       status.
//
//   CapabilitySupply  — one supplier's supply of one capability: proficiency
//                       level in [0, 1] (default 1 — full strength), optional
//                       capacity (unit-less quantity, null = undeclared),
//                       lifecycle status, evidence observation references and
//                       a free-text note. Identity-keyed by (capability,
//                       supplier) — the supplier party (kind + opaque id
//                       and/or label) is immutable identity content: a
//                       different supplier is a different supply, expressed by
//                       a new record, never by rewriting one.
//
//   CapabilityRequirement — one demand for one capability: minimum acceptable
//                       level in [0, 1] (default 0 — presence suffices),
//                       optional minimum capacity, lifecycle status, note.
//                       Identity-keyed by (capability, source) — the source
//                       party (goal | process | project | opportunity |
//                       manual + opaque id and/or label) is immutable
//                       identity content for the same reason.
//
// Gap analysis (gap.ts, surfaced by `analyzeGaps`) considers ACTIVE
// capabilities with at least one ACTIVE requirement, aggregates the ACTIVE
// supplies (best level = max, total capacity = sum of declared capacities)
// and classifies each capability:
//
//   uncovered          — active demand, no active supply at all;
//   level_shortfall    — some requirement's minimum level exceeds the best
//                        active supply level;
//   capacity_shortfall — some requirement's minimum capacity exceeds the
//                        total declared active capacity;
//   covered            — every active requirement satisfied on both dims.
//
// AVAILABLE ALTERNATIVES (the second half of the work item) are reported with
// every gap: the active supplies (each one is an available alternative to the
// others, grouped by supplier kind so the six supply channels are visible)
// and the retired supplies (known suppliers not currently active —
// reactivation candidates). Acquisition options beyond that (train, hire,
// recruit agents, install extensions, outsource) are deliberately NOT built
// here: they are W018/W022's scope, consuming this contract (lock 19;
// `processes + capabilities → automation`).
//
// Provider neutrality (lock 16): suppliers, requirement sources and audit
// actors are provider-neutral party references — kind + opaque id and/or
// human label — owned by their respective modules (people for employees,
// world for teams, agents for agents, goals/processes for their records).
// None of those modules is a dependency of this one, so the references are
// deliberately unverified here (the events/observations precedent);
// `worldEntityId` and `evidenceObservationIds` are opaque forward references
// the same way (the missions module's affected-goals precedent). No
// cross-module foreign keys, no contract imports.

/** The six supplier kinds the W017 work item names verbatim (TEXT + CHECK in storage). */
export type CapabilitySupplierKind =
  | 'employee'
  | 'team'
  | 'agent'
  | 'software'
  | 'supplier'
  | 'partner';

/**
 * Kinds of demand sources that can require a capability. The authoritative
 * records of goals (W008) and processes (W016) live in their modules — this
 * vocabulary only classifies the opaque reference; 'manual' is a need
 * declared directly by management/operator without another module's record
 * behind it.
 */
export type RequirementSourceKind = 'goal' | 'process' | 'project' | 'opportunity' | 'manual';

/**
 * Kinds of parties that can make a capability-graph change (the audit
 * actor). Mirrors the events envelope's actor vocabulary minus `source` (a
 * source connector does not curate the capability graph; the cognition
 * loop, a manager or a system does) — the same five kinds the processes
 * module uses.
 */
export type CapabilityPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/** Lifecycle status of a capability, supply or requirement (versioned content). */
export type CapabilityRecordStatus = 'active' | 'retired';

/**
 * What kind of change one capability version represents — service-minted,
 * never caller-supplied (the goals module's discipline):
 *  * 'created'     — version 1 (the capability was registered);
 *  * 'revised'     — content change on an active capability;
 *  * 'retired'     — lifecycle transition active → retired;
 *  * 'reactivated' — lifecycle transition retired → active.
 */
export type CapabilityChangeKind = 'created' | 'revised' | 'retired' | 'reactivated';

/**
 * What kind of change one supply version represents — service-minted:
 *  * 'asserted'    — version 1 (the supplier's supply was first asserted);
 *  * 'revised'     — content change on an active supply;
 *  * 'retired'     — lifecycle transition active → retired;
 *  * 'reactivated' — lifecycle transition retired → active.
 */
export type SupplyChangeKind = 'asserted' | 'revised' | 'retired' | 'reactivated';

/**
 * What kind of change one requirement version represents — service-minted:
 *  * 'declared'    — version 1 (the demand was first declared);
 *  * 'revised'     — content change on an active requirement;
 *  * 'retired'     — lifecycle transition active → retired;
 *  * 'reactivated' — lifecycle transition retired → active.
 */
export type RequirementChangeKind = 'declared' | 'revised' | 'retired' | 'reactivated';

/** Gap classification of one capability (deterministic; see gap.ts). */
export type GapStatus = 'uncovered' | 'level_shortfall' | 'capacity_shortfall' | 'covered';

/**
 * A provider-neutral party reference (lock 16): an opaque `id` owned by the
 * respective module (people for `employee`, world for `team`, agents for
 * `agent`, goals/processes for their records — free-form text, uuids where
 * the owning module uses them), a human-readable `label`, or both. At least
 * one must be present — suppliers and demand sources are traceable.
 */
export interface CapabilityParty {
  kind: CapabilityPartyKind | CapabilitySupplierKind | RequirementSourceKind;
  id?: string | null;
  label?: string | null;
}

/** A capability supplier party (kind is always one of the six supplier kinds). */
export type CapabilitySupplier = CapabilityParty;

/** A requirement source party (kind is always one of the five source kinds). */
export type RequirementSource = CapabilityParty;

/** The audit actor of one capability-graph change (`CapabilityParty`; separate name for readers). */
export type CapabilityActor = CapabilityParty;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Input shape of `registerCapability`. */
export interface RegisterCapabilityInput {
  /** Tenant-unique graph key; immutable after registration (1..200 chars). */
  name: string;
  /** Optional human description (≤ 2000 chars). */
  description?: string | null;
  /** Opaque forward reference to a world-model (W005) `capability` entity. */
  worldEntityId?: string | null;
  /** Who registered the capability (audit trail). */
  actor: CapabilityActorInput;
  /** Why, if stated — recorded on version 1. */
  rationale?: string | null;
}

/** Patch shape of `reviseCapability` (undefined = carry over, null = clear). */
export interface ReviseCapabilityInput {
  capabilityId: string;
  description?: string | null;
  worldEntityId?: string | null;
  /** Lifecycle change; must be the only change in its revision (surgical). */
  status?: CapabilityRecordStatus;
  actor: CapabilityActorInput;
  rationale?: string | null;
}

/** The current view of a capability: identity + current content + audit + graph summaries. */
export interface Capability {
  id: string;
  tenantId: string;
  /** Immutable graph key, unique per tenant. */
  name: string;
  /** Current version number. */
  version: number;
  description: string | null;
  worldEntityId: string | null;
  status: CapabilityRecordStatus;
  /** Supply summary over the CURRENT supply versions. */
  supplySummary: CapabilitySupplySummary;
  /** Requirement summary over the CURRENT requirement versions. */
  requirementSummary: CapabilityRequirementSummary;
  /** ISO 8601 — when the capability identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: CapabilityChangeSummary;
}

/** Audit summary shared by all current views. */
export interface CapabilityChangeSummary {
  kind: CapabilityChangeKind | SupplyChangeKind | RequirementChangeKind;
  actor: CapabilityActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

/** How many supplies of each status/kind a capability currently has. */
export interface CapabilitySupplySummary {
  activeCount: number;
  retiredCount: number;
  /** Active supplies per supplier kind (the six supply channels). */
  activeByKind: Record<CapabilitySupplierKind, number>;
}

/** How many requirements of each status a capability currently has. */
export interface CapabilityRequirementSummary {
  activeCount: number;
  retiredCount: number;
}

/** One append-only version of a capability — the audit record (self-contained). */
export interface CapabilityVersion {
  /** Version-row id (distinct from the capability identity). */
  id: string;
  tenantId: string;
  capabilityId: string;
  /** 1-based, strictly increasing per capability; service-minted. */
  version: number;
  changeKind: CapabilityChangeKind;
  /** Always the identity's immutable name (snapshotted for self-containment). */
  name: string;
  description: string | null;
  worldEntityId: string | null;
  status: CapabilityRecordStatus;
  actor: CapabilityActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Supplies
// ---------------------------------------------------------------------------

/** Input shape of `registerSupply`. */
export interface RegisterSupplyInput {
  capabilityId: string;
  /** The supplier — one of the six kinds, id and/or label. */
  supplier: CapabilitySupplierInput;
  /** Proficiency/strength in [0, 1]; default 1 (full strength). */
  level?: number;
  /** Optional capacity quantity ≥ 0; null/omitted = undeclared. */
  capacity?: number | null;
  /** Observation (W004) ids cited as evidence (≤ 32, opaque forward references). */
  evidenceObservationIds?: string[];
  /** Free-text note (≤ 2000 chars). */
  note?: string | null;
  actor: CapabilityActorInput;
  rationale?: string | null;
}

/** Patch shape of `reviseSupply` (undefined = carry over, null = clear; the supplier is immutable). */
export interface ReviseSupplyInput {
  supplyId: string;
  level?: number;
  capacity?: number | null;
  status?: CapabilityRecordStatus;
  /** Replaces the previous evidence list wholesale. */
  evidenceObservationIds?: string[];
  note?: string | null;
  actor: CapabilityActorInput;
  rationale?: string | null;
}

/** The current view of a supply: identity + current content + audit. */
export interface CapabilitySupply {
  id: string;
  tenantId: string;
  capabilityId: string;
  /** Immutable identity content: who supplies (kind + id and/or label). */
  supplier: CapabilitySupplier;
  /** Current version number. */
  version: number;
  level: number;
  capacity: number | null;
  status: CapabilityRecordStatus;
  evidenceObservationIds: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: CapabilityChangeSummary;
}

/** One append-only version of a supply — the audit record (self-contained). */
export interface CapabilitySupplyVersion {
  id: string;
  tenantId: string;
  supplyId: string;
  capabilityId: string;
  version: number;
  changeKind: SupplyChangeKind;
  supplier: CapabilitySupplier;
  level: number;
  capacity: number | null;
  status: CapabilityRecordStatus;
  evidenceObservationIds: string[];
  note: string | null;
  actor: CapabilityActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/** Input shape of `registerRequirement`. */
export interface RegisterRequirementInput {
  capabilityId: string;
  /** The demand source — one of the five kinds, id and/or label. */
  source: RequirementSourceInput;
  /** Minimum acceptable proficiency in [0, 1]; default 0 (presence suffices). */
  level?: number;
  /** Optional minimum capacity quantity ≥ 0; null/omitted = undeclared. */
  capacity?: number | null;
  note?: string | null;
  actor: CapabilityActorInput;
  rationale?: string | null;
}

/** Patch shape of `reviseRequirement` (undefined = carry over, null = clear; the source is immutable). */
export interface ReviseRequirementInput {
  requirementId: string;
  level?: number;
  capacity?: number | null;
  status?: CapabilityRecordStatus;
  note?: string | null;
  actor: CapabilityActorInput;
  rationale?: string | null;
}

/** The current view of a requirement: identity + current content + audit. */
export interface CapabilityRequirement {
  id: string;
  tenantId: string;
  capabilityId: string;
  /** Immutable identity content: what demands (kind + id and/or label). */
  source: RequirementSource;
  version: number;
  level: number;
  capacity: number | null;
  status: CapabilityRecordStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: CapabilityChangeSummary;
}

/** One append-only version of a requirement — the audit record (self-contained). */
export interface CapabilityRequirementVersion {
  id: string;
  tenantId: string;
  requirementId: string;
  capabilityId: string;
  version: number;
  changeKind: RequirementChangeKind;
  source: RequirementSource;
  level: number;
  capacity: number | null;
  status: CapabilityRecordStatus;
  note: string | null;
  actor: CapabilityActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Gap analysis
// ---------------------------------------------------------------------------

/** One unmet active requirement of a gap, with the deterministic shortfalls. */
export interface UnmetRequirement {
  requirement: CapabilityRequirement;
  /** Present when the requirement's minimum level exceeds the best active supply level. */
  levelShortfall: { required: number; bestAvailable: number } | null;
  /** Present when the requirement's minimum capacity exceeds the total declared active capacity. */
  capacityShortfall: { required: number; available: number } | null;
}

/** The available alternatives of one capability (the second half of W017). */
export interface CapabilityAlternatives {
  /** Active supplies per supplier kind (the six supply channels, currently available). */
  activeByKind: Record<CapabilitySupplierKind, number>;
  /** Every active supply — each one is an available alternative to the others. */
  activeSupplies: CapabilitySupply[];
  /** Retired supplies — known suppliers not currently active (reactivation candidates). */
  retiredSupplies: CapabilitySupply[];
}

/**
 * The gap analysis result for one capability: a deterministic summary of
 * active demand vs active supply plus the available alternatives. Never
 * persisted — recomputed from the current records on every read.
 */
export interface CapabilityGap {
  /** Lightweight capability reference (no recursion into summaries). */
  capability: { id: string; tenantId: string; name: string; status: CapabilityRecordStatus };
  status: GapStatus;
  /** Active requirements of the capability (the demand side). */
  activeRequirementCount: number;
  /** Active supplies of the capability (the supply side). */
  activeSupplyCount: number;
  /** Best (max) level among active supplies; null when there is no active supply. */
  bestActiveLevel: number | null;
  /** Sum of declared capacities over active supplies (undeclared capacities contribute 0). */
  totalActiveCapacity: number;
  /** Active supplies that declared a capacity (the honest denominator of the sum). */
  activeSuppliesWithKnownCapacity: number;
  /** The unmet active requirements with their shortfalls (empty when covered). */
  unmet: UnmetRequirement[];
  alternatives: CapabilityAlternatives;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Query shape of `listCapabilities` (over CURRENT versions only). */
export interface ListCapabilitiesQuery {
  /** Exact name match. */
  name?: string;
  /** Case-insensitive substring on the name. */
  search?: string;
  status?: CapabilityRecordStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getCapabilityVersion`. */
export interface GetCapabilityVersionQuery {
  capabilityId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listCapabilityVersions`. */
export interface ListCapabilityVersionsQuery {
  capabilityId: string;
}

/** Query shape of `getSupplyVersion`. */
export interface GetSupplyVersionQuery {
  supplyId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listSupplyVersions`. */
export interface ListSupplyVersionsQuery {
  supplyId: string;
}

/** Query shape of `getRequirementVersion`. */
export interface GetRequirementVersionQuery {
  requirementId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listRequirementVersions`. */
export interface ListRequirementVersionsQuery {
  requirementId: string;
}

/** Query shape of `listSupplies` (over CURRENT versions only). */
export interface ListSuppliesQuery {
  capabilityId?: string;
  supplierKind?: CapabilitySupplierKind;
  /** Exact match on the supplier party's opaque id. */
  supplierId?: string;
  status?: CapabilityRecordStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listRequirements` (over CURRENT versions only). */
export interface ListRequirementsQuery {
  capabilityId?: string;
  sourceKind?: RequirementSourceKind;
  /** Exact match on the source party's opaque id. */
  sourceId?: string;
  status?: CapabilityRecordStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `analyzeGaps`. */
export interface AnalyzeGapsQuery {
  /** Restrict the analysis to one capability (must exist in this tenant). */
  capabilityId?: string;
  /** Only return gaps with this status. */
  status?: GapStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Input party shapes (distinct names so contracts read clearly)
// ---------------------------------------------------------------------------

/** Input shape of `CapabilityActor` (audit actor). */
export interface CapabilityActorInput {
  kind: CapabilityPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `CapabilitySupplier`. */
export interface CapabilitySupplierInput {
  kind: CapabilitySupplierKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `RequirementSource`. */
export interface RequirementSourceInput {
  kind: RequirementSourceKind;
  id?: string | null;
  label?: string | null;
}
