// Management Control Tower (W033) — shared derivation over the cognition
// trace surface.
//
// The risk/opportunity/capability-gap ANALYSIS FINDINGS of the canonical
// loop (ARCHITECTURE.md §19; cognition W013) are recorded as derived
// intelligence on execution traces — "W015/W016/W017 formalize the
// first-class objects" (the cognition contract's own words). The
// first-class opportunity (W015) and automation (W018) modules are not
// delivered at this base, so the tower's Risks / Opportunities /
// Automation surfaces present the loop's recorded findings through the
// cognition contract — derived intelligence, never authoritative source
// state (lock 34).

import { getExecution, listExecutions } from '@/modules/cognition/contract';
import type {
  CognitiveExecution,
  RecordedAnalysisFinding,
} from '@/modules/cognition/contract';
import type { TenantContext } from '@/infra/tenant';

/** The finding kinds the loop records (mirrors the cognition vocabulary). */
export type TowerFindingKind = RecordedAnalysisFinding['kind'];

/** One analysis finding, located on the trace that recorded it. */
export interface TraceFinding {
  kind: TowerFindingKind;
  statement: string;
  evidenceObservationIds: string[];
  affectedGoalIds: string[];
  /** The execution whose analysis stage recorded the finding. */
  executionId: string;
  /** When the analysis step was committed (service clock). */
  detectedAt: string;
}

/** Bound on how many recent executions the tower scans for findings. */
export const FINDING_SCAN_EXECUTIONS = 25;

/**
 * Collect the analysis findings of the most recent cognitive executions
 * (newest execution first). Bounded: the newest FINDING_SCAN_EXECUTIONS
 * executions, one trace read each — a management view, not an archive.
 */
export async function collectTraceFindings(
  ctx: TenantContext,
  scan: number = FINDING_SCAN_EXECUTIONS,
): Promise<TraceFinding[]> {
  const executions: CognitiveExecution[] = await listExecutions(ctx, { limit: scan });
  const findings: TraceFinding[] = [];
  for (const execution of executions) {
    const trace = await getExecution(ctx, { executionId: execution.id });
    for (const step of trace.steps) {
      if (step.stage !== 'risk-opportunity-capability-analysis') continue;
      const result = step.result;
      if (result.stage !== 'risk-opportunity-capability-analysis') continue;
      for (const finding of result.findings) {
        findings.push({
          kind: finding.kind,
          statement: finding.statement,
          evidenceObservationIds: [...finding.evidenceObservationIds],
          affectedGoalIds: [...finding.affectedGoalIds],
          executionId: execution.id,
          detectedAt: step.recordedAt,
        });
      }
    }
  }
  return findings;
}
