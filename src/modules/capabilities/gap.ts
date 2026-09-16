// Pure gap-analysis logic of the capabilities module (no database) — the
// deterministic function from current capability-graph records to gaps and
// available alternatives (W017's second half). Never persisted: recomputed
// on every read, so the derived layer can never drift from the records it
// summarizes (lock 10 — derived intelligence, never authoritative truth).
//
// Scope (documented invariants, all tested):
//  * Only ACTIVE capabilities participate. Retired capabilities are out of
//    the graph's operating scope; their (possibly still-active) supplies and
//    requirements remain listable through the record contracts but never
//    produce gaps — a retired capability must not demand attention.
//  * Only ACTIVE requirements count as demand. Retired requirements are
//    historical declarations; a capability whose every requirement retired
//    has no demand and therefore no gap.
//  * Only ACTIVE supplies count as coverage. Retired supplies are still
//    reported as ALTERNATIVES (known suppliers not currently active —
//    reactivation candidates), which is exactly the "available
//    alternatives" the work item asks to identify.
//  * Level dimension: the best (max) active supply level must reach each
//    requirement's minimum level. Requirement level 0 (the default) is
//    always reached — presence suffices.
//  * Capacity dimension: the SUM of declared active capacities must reach
//    each requirement's minimum capacity. An undeclared supply capacity
//    contributes 0 (conservative in the gap-detection direction — missing
//    data never hides a gap); `activeSuppliesWithKnownCapacity` reports the
//    honest denominator so a reader can tell a real shortfall from missing
//    declarations.
//  * Status severity rank: uncovered > level_shortfall > capacity_shortfall
//    > covered. Both shortfall lists are always computed and reported in
//    `unmet`, so the scalar status never discards a dimension.
//  * Deterministic ordering: gaps sort by capability name then id; unmet
//    requirements sort by requirement id; supplies sort by supplier kind,
//    then key, then id (the service's listing orders).

import type {
  Capability,
  CapabilityAlternatives,
  CapabilityRequirement,
  CapabilitySupply,
  CapabilitySupplierKind,
  GapStatus,
  UnmetRequirement,
} from './types';

/** Canonical severity rank of the gap statuses (lower = more severe). */
export const GAP_STATUS_RANK: Record<GapStatus, number> = {
  uncovered: 0,
  level_shortfall: 1,
  capacity_shortfall: 2,
  covered: 3,
};

/** The six supplier kinds in canonical (alphabetical) order — matches the SQL string ordering of the listings. */
export const SUPPLIER_KIND_ORDER: readonly CapabilitySupplierKind[] = [
  'agent',
  'employee',
  'partner',
  'software',
  'supplier',
  'team',
];

export function emptySuppliersByKind(): Record<CapabilitySupplierKind, number> {
  return { employee: 0, team: 0, agent: 0, software: 0, supplier: 0, partner: 0 };
}

/** Deterministic comparison of two supplies (kind, then key, then id). */
export function supplyCompare(a: CapabilitySupply, b: CapabilitySupply): number {
  if (a.supplier.kind !== b.supplier.kind) {
    return a.supplier.kind < b.supplier.kind ? -1 : 1;
  }
  const keyA = a.supplier.id ?? a.supplier.label ?? '';
  const keyB = b.supplier.id ?? b.supplier.label ?? '';
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The available alternatives of one capability over its current supplies. */
export function alternativesOf(supplies: CapabilitySupply[]): CapabilityAlternatives {
  const activeByKind = emptySuppliersByKind();
  const activeSupplies: CapabilitySupply[] = [];
  const retiredSupplies: CapabilitySupply[] = [];
  for (const supply of supplies) {
    if (supply.status === 'active') {
      activeSupplies.push(supply);
      activeByKind[supply.supplier.kind as CapabilitySupplierKind] += 1;
    } else {
      retiredSupplies.push(supply);
    }
  }
  activeSupplies.sort(supplyCompare);
  retiredSupplies.sort(supplyCompare);
  return { activeByKind, activeSupplies, retiredSupplies };
}

/**
 * Computes the gap of ONE capability from its current supplies and its
 * ACTIVE requirements. Returns null when the capability is retired or has
 * no active requirement (out of gap-analysis scope).
 */
export function computeCapabilityGap(
  capability: Capability,
  supplies: CapabilitySupply[],
  activeRequirements: CapabilityRequirement[],
): GapResult | null {
  if (capability.status !== 'active') return null;
  // Self-guarding: only ACTIVE requirements count as demand (the service
  // pre-filters in SQL; filtering again here keeps the pure function honest
  // for direct callers too).
  const demand = activeRequirements.filter((requirement) => requirement.status === 'active');
  if (demand.length === 0) return null;

  const activeSupplies = supplies.filter((supply) => supply.status === 'active');
  const bestActiveLevel =
    activeSupplies.length === 0
      ? null
      : Math.max(...activeSupplies.map((supply) => supply.level));
  const knownCapacities = activeSupplies.filter((supply) => supply.capacity !== null);
  const totalActiveCapacity = knownCapacities.reduce(
    (sum, supply) => sum + (supply.capacity ?? 0),
    0,
  );

  const unmet: UnmetRequirement[] = [];
  let hasLevelShortfall = false;
  let hasCapacityShortfall = false;
  for (const requirement of demand) {
    const levelShortfall =
      bestActiveLevel !== null && requirement.level > bestActiveLevel
        ? { required: requirement.level, bestAvailable: bestActiveLevel }
        : null;
    const capacityShortfall =
      requirement.capacity !== null && totalActiveCapacity < requirement.capacity
        ? { required: requirement.capacity, available: totalActiveCapacity }
        : null;
    // With no active supply at all, EVERY requirement is unmet (nothing
    // satisfies it); the shortfall details stay null because there is no
    // supply to compare against — the gap-level fields carry the why
    // (bestActiveLevel null, totalActiveCapacity 0).
    if (activeSupplies.length === 0 || levelShortfall !== null || capacityShortfall !== null) {
      unmet.push({ requirement, levelShortfall, capacityShortfall });
      if (levelShortfall !== null) hasLevelShortfall = true;
      if (capacityShortfall !== null) hasCapacityShortfall = true;
    }
  }
  unmet.sort((a, b) =>
    a.requirement.id < b.requirement.id ? -1 : a.requirement.id > b.requirement.id ? 1 : 0,
  );

  let status: GapStatus;
  if (activeSupplies.length === 0) status = 'uncovered';
  else if (hasLevelShortfall) status = 'level_shortfall';
  else if (hasCapacityShortfall) status = 'capacity_shortfall';
  else status = 'covered';

  return {
    capability: {
      id: capability.id,
      tenantId: capability.tenantId,
      name: capability.name,
      status: capability.status,
    },
    status,
    activeRequirementCount: demand.length,
    activeSupplyCount: activeSupplies.length,
    bestActiveLevel,
    totalActiveCapacity,
    activeSuppliesWithKnownCapacity: knownCapacities.length,
    unmet,
    alternatives: alternativesOf(supplies),
  };
}

/** The gap result type (structurally identical to `CapabilityGap`). */
export type GapResult = import('./types').CapabilityGap;

/**
 * Computes the gaps of MANY capabilities. `records` groups, per capability
 * id, the capability with its current supplies and active requirements;
 * capabilities out of scope (retired / no active requirements) are skipped.
 * Results sort by capability name, then id (deterministic).
 */
export function computeCapabilityGaps(
  records: {
    capability: Capability;
    supplies: CapabilitySupply[];
    activeRequirements: CapabilityRequirement[];
  }[],
): GapResult[] {
  const gaps: GapResult[] = [];
  for (const record of records) {
    const gap = computeCapabilityGap(
      record.capability,
      record.supplies,
      record.activeRequirements,
    );
    if (gap !== null) gaps.push(gap);
  }
  gaps.sort((a, b) =>
    a.capability.name !== b.capability.name
      ? a.capability.name < b.capability.name
        ? -1
        : 1
      : a.capability.id < b.capability.id
        ? -1
        : a.capability.id > b.capability.id
          ? 1
          : 0,
  );
  return gaps;
}
