// ============================================================================
// capabilities — the ONLY public surface of the capabilities module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W017 — Capability Graph:
// "Model capabilities supplied by employees, teams, agents, software,
//  suppliers and partners; identify gaps and available alternatives."
//
//   Capabilities (the graph nodes)
//     registerCapability — register a named capability (version 1 'created',
//        status minted 'active'). The name is the tenant-unique IMMUTABLE
//        graph key: registering an existing name fails with
//        `capability_name_conflict` — revise the winner instead.
//     reviseCapability   — append the next version. Omitted fields carry
//        over; `null` clears; a `status` change must be the only change
//        (surgical lifecycle); a retired capability accepts nothing but a
//        reactivation.
//     getCapability      — the current view: identity + current content +
//        audit summary + supply/requirement summaries of the current
//        versions (active supplies grouped by the six supplier kinds).
//     listCapabilities   — current views, filtered (exact name, name
//        search, status), ordered by name.
//     getCapabilityVersion / listCapabilityVersions — the audit deep links.
//
//   Supplies (who supplies what, at which strength)
//     registerSupply     — assert one supplier's supply of one capability
//        (version 1 'asserted', status minted 'active'). The supplier is
//        one of the six kinds the work item names — employee, team, agent,
//        software, supplier, partner — and is IMMUTABLE identity content:
//        (capability, supplier) is the graph key, so a different supplier
//        is a different supply. Level defaults to 1 (full strength);
//        capacity is optional; evidence observation ids are opaque forward
//        references to the observations module (W004).
//     reviseSupply       — append the next version (level, capacity,
//        evidence list, note; surgical status transitions).
//     getSupply / listSupplies — current views, filtered (capability,
//        supplier kind, supplier id, status), in canonical capability/
//        kind/key order. The workforce (W019) and supplier (W020)
//        intelligence modules read a person's or supplier's capabilities
//        through THIS surface.
//     getSupplyVersion / listSupplyVersions — the audit deep links.
//
//   Requirements (what demands which capability, at which minimum)
//     registerRequirement — declare one demand (version 1 'declared',
//        status minted 'active'). The source is one of goal, process,
//        project, opportunity, manual — an opaque forward reference to the
//        owning module's record (the events/observations precedent) or a
//        directly declared need. Level defaults to 0 (presence suffices);
//        capacity is optional. (capability, source) is the immutable graph
//        key.
//     reviseRequirement  — append the next version (level, capacity, note;
//        surgical status transitions).
//     getRequirement / listRequirements — current views, filtered
//        (capability, source kind, source id, status).
//     getRequirementVersion / listRequirementVersions — the audit deep
//        links.
//
//   Gap analysis (the derived intelligence — never persisted)
//     analyzeGaps        — for every ACTIVE capability with at least one
//        ACTIVE requirement: the deterministic gap status (uncovered /
//        level_shortfall / capacity_shortfall / covered), the unmet
//        requirements with their exact shortfalls, and the AVAILABLE
//        ALTERNATIVES — the active supplies (each an available alternative
//        to the others, grouped by supplier kind) and the retired supplies
//        (reactivation candidates). Filterable by capability and status;
//        bounded to the first 500 demand-bearing capabilities in canonical
//        (name, id) order. The automation module (W018) connects process
//        findings to acquisition options through THIS contract (lock 19;
//        `processes + capabilities → automation`).
//
// There is deliberately NO operation to update or delete a version, a
// supply, a requirement or a capability, and NO way to rewrite a supplier,
// a source or a name: the capability graph is versioned understanding in
// the goals (W008) discipline — revisions append, retirements retire
// (versioned status change, no erasure) — and PostgreSQL itself rejects
// UPDATE/DELETE/TRUNCATE on the version tables and DELETE/TRUNCATE on the
// identity tables via migration 001 triggers. Gaps and alternatives are
// never stored at all: they are recomputed from the current records on
// every read (lock 10).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's capability
// graph (including versions, supplies and requirements) is reported as
// `capability_not_found` / `capability_version_not_found` /
// `supply_not_found` / `supply_version_not_found` / `requirement_not_found`
// / `requirement_version_not_found` — no existence leak.
// ============================================================================

export {
  analyzeGaps,
  getCapability,
  getCapabilityVersion,
  getRequirement,
  getRequirementVersion,
  getSupply,
  getSupplyVersion,
  listCapabilities,
  listCapabilityVersions,
  listRequirements,
  listRequirementVersions,
  listSupplies,
  listSupplyVersions,
  registerCapability,
  registerRequirement,
  registerSupply,
  reviseCapability,
  reviseRequirement,
  reviseSupply,
} from './service';

export { CapabilitiesError } from './errors';
export type { CapabilitiesErrorCode } from './errors';

export {
  CAPABILITY_PARTY_KINDS,
  CAPABILITY_RECORD_STATUSES,
  CAPABILITY_SUPPLIER_KINDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_REQUIREMENT_LEVEL,
  DEFAULT_SUPPLY_LEVEL,
  GAP_STATUSES,
  MAX_ANALYSIS_CAPABILITIES,
  MAX_CAPACITY,
  MAX_EVIDENCE_REFS,
  MAX_LIST_LIMIT,
  MAX_NAME_LENGTH,
  MAX_PARTY_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_TEXT_LENGTH,
  REQUIREMENT_SOURCE_KINDS,
  escapeLike,
  isCapabilityPartyKind,
  isCapabilityRecordStatus,
  isCapabilitySupplierKind,
  isGapStatus,
  isRequirementSourceKind,
  isUuid,
} from './validation';

export type {
  ValidatedAnalyzeGapsQuery,
  ValidatedCapabilityPatch,
  ValidatedHistoryQuery,
  ValidatedListCapabilitiesQuery,
  ValidatedListRequirementsQuery,
  ValidatedListSuppliesQuery,
  ValidatedParty,
  ValidatedRegisterCapabilityInput,
  ValidatedRegisterRequirementInput,
  ValidatedRegisterSupplyInput,
  ValidatedRequirementPatch,
  ValidatedReviseCapabilityInput,
  ValidatedReviseRequirementInput,
  ValidatedReviseSupplyInput,
  ValidatedSupplyPatch,
  ValidatedVersionQuery,
} from './validation';

export {
  GAP_STATUS_RANK,
  SUPPLIER_KIND_ORDER,
  alternativesOf,
  computeCapabilityGap,
  computeCapabilityGaps,
  emptySuppliersByKind,
  supplyCompare,
} from './gap';
export type { GapResult } from './gap';

export type {
  AnalyzeGapsQuery,
  Capability,
  CapabilityActor,
  CapabilityActorInput,
  CapabilityAlternatives,
  CapabilityChangeKind,
  CapabilityChangeSummary,
  CapabilityGap,
  CapabilityParty,
  CapabilityPartyKind,
  CapabilityRecordStatus,
  CapabilityRequirement,
  CapabilityRequirementSummary,
  CapabilityRequirementVersion,
  CapabilitySupply,
  CapabilitySupplySummary,
  CapabilitySupplyVersion,
  CapabilitySupplier,
  CapabilitySupplierInput,
  CapabilitySupplierKind,
  CapabilityVersion,
  GapStatus,
  GetCapabilityVersionQuery,
  GetRequirementVersionQuery,
  GetSupplyVersionQuery,
  ListCapabilitiesQuery,
  ListCapabilityVersionsQuery,
  ListRequirementsQuery,
  ListRequirementVersionsQuery,
  ListSuppliesQuery,
  ListSupplyVersionsQuery,
  RegisterCapabilityInput,
  RegisterRequirementInput,
  RegisterSupplyInput,
  RequirementSource,
  RequirementSourceInput,
  RequirementSourceKind,
  ReviseCapabilityInput,
  ReviseRequirementInput,
  ReviseSupplyInput,
  SupplyChangeKind,
  UnmetRequirement,
} from './types';
