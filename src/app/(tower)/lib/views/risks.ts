// Management Control Tower (W033) — the Risks view.
//
// Risk exposure, assembled from the three derived-intelligence surfaces
// that exist at this base (all read through contracts, lock 34 — derived
// intelligence, never authoritative state):
//   * the loop's recorded 'risk' analysis findings on cognition traces
//     (W013; the first-class objects arrive with W015–W019);
//   * retained open contradictions between evidence (W007, lock 12);
//   * capability gaps — unmet demand for capabilities (W017's analyzeGaps).
// Each section is labeled with its source module so a manager can always
// see WHERE a risk statement comes from.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listContradictions } from '@/modules/epistemics/contract';
import type { Contradiction } from '@/modules/epistemics/contract';
import { analyzeGaps } from '@/modules/capabilities/contract';
import type { CapabilityGap } from '@/modules/capabilities/contract';
import { collectTraceFindings } from './findings';
import type { TraceFinding } from './findings';

export interface RiskFindingItem {
  statement: string;
  executionId: string;
  detectedAt: string;
  evidenceObservationIds: string[];
  affectedGoalIds: string[];
}

export interface RiskContradictionItem {
  id: string;
  note: string;
  detectedAt: string;
  evidenceA: Contradiction['evidenceA'];
  evidenceB: Contradiction['evidenceB'];
}

export interface RiskGapItem {
  capability: { id: string; name: string };
  status: CapabilityGap['status'];
  unmetCount: number;
  activeRequirementCount: number;
  activeSupplyCount: number;
}

export interface RisksView {
  generatedAt: string;
  findings: RiskFindingItem[];
  contradictions: RiskContradictionItem[];
  capabilityGaps: RiskGapItem[];
}

/** Build the Risks view (loop findings + retained conflicts + unmet demand). */
export async function buildRisksView(ctx: TenantContext): Promise<RisksView> {
  const [traceFindings, openContradictions, gaps] = await Promise.all([
    collectTraceFindings(ctx),
    listContradictions(ctx, { status: 'open', limit: 100 }),
    analyzeGaps(ctx, {}),
  ]);

  const risks: TraceFinding[] = traceFindings.filter((f) => f.kind === 'risk');

  return {
    generatedAt: now().toISOString(),
    findings: risks.map((finding) => ({
      statement: finding.statement,
      executionId: finding.executionId,
      detectedAt: finding.detectedAt,
      evidenceObservationIds: finding.evidenceObservationIds,
      affectedGoalIds: finding.affectedGoalIds,
    })),
    contradictions: openContradictions.map((c: Contradiction) => ({
      id: c.id,
      note: c.note,
      detectedAt: c.detectedAt,
      evidenceA: c.evidenceA,
      evidenceB: c.evidenceB,
    })),
    capabilityGaps: gaps
      .filter((gap) => gap.status !== 'covered')
      .map((gap) => ({
        capability: { id: gap.capability.id, name: gap.capability.name },
        status: gap.status,
        unmetCount: gap.unmet.length,
        activeRequirementCount: gap.activeRequirementCount,
        activeSupplyCount: gap.activeSupplyCount,
      })),
  };
}
