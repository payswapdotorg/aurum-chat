// Management Control Tower (W033) — the Capabilities view.
//
// The capability graph (W017): what the tenant can do, who supplies it
// (the six supplier kinds), what demands it and where the gaps are. Gaps
// and alternatives are recomputed by the capabilities module on every
// read (never persisted, lock 10) — the tower joins the capability list
// with the deterministic gap analysis through the contract only.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { analyzeGaps, listCapabilities } from '@/modules/capabilities/contract';
import type {
  Capability,
  CapabilityAlternatives,
  CapabilityRecordStatus,
  GapStatus,
} from '@/modules/capabilities/contract';

const CAP = 200;

export interface CapabilityCard {
  id: string;
  name: string;
  status: CapabilityRecordStatus;
  version: number;
  updatedAt: string;
  /** Deterministic gap status; 'no_demand' when nothing actively requires it. */
  gapStatus: GapStatus | 'no_demand';
  activeRequirementCount: number;
  activeSupplyCount: number;
  bestActiveLevel: number | null;
  unmetCount: number;
  alternatives: CapabilityAlternatives;
}

export interface CapabilitiesView {
  generatedAt: string;
  total: number;
  capped: boolean;
  capabilities: CapabilityCard[];
}

/** Build the Capabilities view (graph + live gap analysis). */
export async function buildCapabilitiesView(
  ctx: TenantContext,
): Promise<CapabilitiesView> {
  const [capabilities, gaps] = await Promise.all([
    listCapabilities(ctx, { status: 'active', limit: CAP }),
    analyzeGaps(ctx, {}),
  ]);
  const gapsByCapability = new Map(gaps.map((gap) => [gap.capability.id, gap]));

  return {
    generatedAt: now().toISOString(),
    total: capabilities.length,
    capped: capabilities.length >= CAP,
    capabilities: capabilities.map((capability: Capability) => {
      const gap = gapsByCapability.get(capability.id);
      return {
        id: capability.id,
        name: capability.name,
        status: capability.status,
        version: capability.version,
        updatedAt: capability.updatedAt,
        gapStatus: gap === undefined ? 'no_demand' : gap.status,
        activeRequirementCount: gap?.activeRequirementCount ?? 0,
        activeSupplyCount: gap?.activeSupplyCount ?? 0,
        bestActiveLevel: gap?.bestActiveLevel ?? null,
        unmetCount: gap?.unmet.length ?? 0,
        alternatives:
          gap?.alternatives ?? {
            activeByKind: {
              employee: 0,
              team: 0,
              agent: 0,
              software: 0,
              supplier: 0,
              partner: 0,
            },
            activeSupplies: [],
            retiredSupplies: [],
          },
      };
    }),
  };
}
