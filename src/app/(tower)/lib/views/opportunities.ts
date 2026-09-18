// Management Control Tower (W033) — the Opportunities view.
//
// Evidence-backed opportunities, assembled from the surfaces that exist
// at this base (the first-class Opportunity objects are W015's scope and
// are not delivered yet):
//   * the loop's recorded 'opportunity' analysis findings on cognition
//     traces (W013), each citing its evidence and affected goals;
//   * the capability graph's available ALTERNATIVES (W017 — "identify
//     gaps and available alternatives"): for every capability with unmet
//     demand, the active supplies that could fill it and the retired
//     supplies that are reactivation candidates.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { analyzeGaps } from '@/modules/capabilities/contract';
import type { CapabilityGap, CapabilitySupply } from '@/modules/capabilities/contract';
import { collectTraceFindings } from './findings';
import type { TraceFinding } from './findings';

export interface OpportunityFindingItem {
  statement: string;
  executionId: string;
  detectedAt: string;
  evidenceObservationIds: string[];
  affectedGoalIds: string[];
}

export interface OpportunityAlternativesItem {
  capability: { id: string; name: string };
  gapStatus: CapabilityGap['status'];
  unmetCount: number;
  /** Active supplies — each an available alternative to the others (W017). */
  activeSupplies: CapabilitySupply[];
  /** Retired supplies — known suppliers not currently active. */
  retiredSupplies: CapabilitySupply[];
}

export interface OpportunitiesView {
  generatedAt: string;
  findings: OpportunityFindingItem[];
  alternatives: OpportunityAlternativesItem[];
}

/** Build the Opportunities view (loop findings + capability alternatives). */
export async function buildOpportunitiesView(
  ctx: TenantContext,
): Promise<OpportunitiesView> {
  const [traceFindings, gaps] = await Promise.all([
    collectTraceFindings(ctx),
    analyzeGaps(ctx, {}),
  ]);

  const opportunities: TraceFinding[] = traceFindings.filter(
    (f) => f.kind === 'opportunity',
  );

  return {
    generatedAt: now().toISOString(),
    findings: opportunities.map((finding) => ({
      statement: finding.statement,
      executionId: finding.executionId,
      detectedAt: finding.detectedAt,
      evidenceObservationIds: finding.evidenceObservationIds,
      affectedGoalIds: finding.affectedGoalIds,
    })),
    alternatives: gaps
      .filter((gap) => gap.status !== 'covered')
      .map((gap) => ({
        capability: { id: gap.capability.id, name: gap.capability.name },
        gapStatus: gap.status,
        unmetCount: gap.unmet.length,
        activeSupplies: gap.alternatives.activeSupplies,
        retiredSupplies: gap.alternatives.retiredSupplies,
      })),
  };
}
