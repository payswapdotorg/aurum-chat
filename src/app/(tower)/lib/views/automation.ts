// Management Control Tower (W033) — the Automation view.
//
// Lock 19: "Process intelligence can create explicit
// AutomationOpportunity findings." The automation module (W018) that
// formalizes AutomationOpportunity records (with candidate solution
// types, expected ROI, outcome measurement) is NOT delivered at this
// base. What exists — and what this surface presents, labeled by source
// — are the W016 process findings that automation candidates are built
// from (manual effort, duplication, bottlenecks; the processes contract
// documents W018 as their consumer) plus the uncovered capabilities
// automation could supply. Evidence-only: every candidate cites the
// event/observation evidence that justifies it.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { analyzeGaps } from '@/modules/capabilities/contract';
import type { CapabilityGap } from '@/modules/capabilities/contract';
import {
  listProcessFindings,
  listProcesses,
} from '@/modules/processes/contract';
import type {
  Process,
  ProcessFinding,
  ProcessFindingKind,
} from '@/modules/processes/contract';

const PROCESS_CAP = 100;
/** Finding kinds that make automation candidates (lock 19 evidence base). */
export const AUTOMATION_FINDING_KINDS: readonly ProcessFindingKind[] = [
  'manual_effort',
  'duplication',
  'bottleneck',
];
const FINDING_DETAIL_PROCESSES = 10;

export interface AutomationCandidateItem {
  processId: string;
  processName: string;
  finding: ProcessFinding;
}

export interface AutomationGapItem {
  capability: { id: string; name: string };
  status: CapabilityGap['status'];
  unmetCount: number;
}

export interface AutomationView {
  generatedAt: string;
  candidates: AutomationCandidateItem[];
  totalsByKind: Record<ProcessFindingKind, number>;
  capabilityGaps: AutomationGapItem[];
  notices: string[];
}

/** Build the Automation view (W016 evidence W018 will formalize). */
export async function buildAutomationView(ctx: TenantContext): Promise<AutomationView> {
  const [processes, gaps] = await Promise.all([
    listProcesses(ctx, { limit: PROCESS_CAP }),
    analyzeGaps(ctx, {}),
  ]);

  const relevant = (p: Process): number =>
    p.findingCounts.manualEffort + p.findingCounts.duplication + p.findingCounts.bottleneck;

  const withAutomationFindings = processes
    .filter((process) => relevant(process) > 0)
    .sort((a, b) => relevant(b) - relevant(a))
    .slice(0, FINDING_DETAIL_PROCESSES);

  const findingLists = await Promise.all(
    withAutomationFindings.map((process) =>
      listProcessFindings(ctx, { processId: process.id, limit: 50 })
        .then((findings: ProcessFinding[]) =>
          findings
            .filter((finding) =>
              (AUTOMATION_FINDING_KINDS as readonly string[]).includes(finding.kind),
            )
            .map((finding) => ({
              processId: process.id,
              processName: process.name,
              finding,
            })),
        )
        .catch(() => [] as AutomationCandidateItem[]),
    ),
  );

  const candidates = findingLists.flat();
  const totalsByKind: Record<ProcessFindingKind, number> = {
    bottleneck: 0,
    duplication: 0,
    handoff: 0,
    manual_effort: 0,
    error: 0,
  };
  for (const candidate of candidates) {
    totalsByKind[candidate.finding.kind] += 1;
  }

  return {
    generatedAt: now().toISOString(),
    candidates,
    totalsByKind,
    capabilityGaps: gaps
      .filter((gap) => gap.status !== 'covered')
      .map((gap) => ({
        capability: { id: gap.capability.id, name: gap.capability.name },
        status: gap.status,
        unmetCount: gap.unmet.length,
      })),
    notices: [
      'AutomationOpportunity records (W018 — candidate solution types, expected ROI, outcome measurement) are not delivered at this base; these are the W016 process findings they are built from, with their evidence.',
    ],
  };
}
