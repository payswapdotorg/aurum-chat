// Management Control Tower (W033) — the Processes view.
//
// Process intelligence (W016): reconstructed flows with their
// deterministic findings (bottlenecks, duplication, handoffs, manual
// effort, errors), each citing the event/observation evidence that
// justifies it. Read through the processes contract only — the tower
// never reconstructs and never writes findings.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  listProcessFindings,
  listProcesses,
} from '@/modules/processes/contract';
import type {
  Process,
  ProcessFinding,
  ProcessFindingCounts,
  ProcessStats,
} from '@/modules/processes/contract';

const PROCESS_CAP = 100;
const FINDINGS_PER_PROCESS = 50;
/** How many processes get their findings deep-listed (busiest first). */
const FINDING_DETAIL_PROCESSES = 10;

export interface ProcessCard {
  id: string;
  name: string;
  version: number;
  stats: ProcessStats;
  findingCounts: ProcessFindingCounts;
  updatedAt: string;
}

export interface ProcessFindingItem {
  processId: string;
  processName: string;
  finding: ProcessFinding;
}

export interface ProcessesView {
  generatedAt: string;
  total: number;
  capped: boolean;
  processes: ProcessCard[];
  latestFindings: ProcessFindingItem[];
}

/** Build the Processes view (current reconstructions + latest findings). */
export async function buildProcessesView(ctx: TenantContext): Promise<ProcessesView> {
  const processes: Process[] = await listProcesses(ctx, { limit: PROCESS_CAP });

  const totalFindings = (p: Process): number =>
    p.findingCounts.bottleneck +
    p.findingCounts.duplication +
    p.findingCounts.handoff +
    p.findingCounts.manualEffort +
    p.findingCounts.error;

  const busiest = [...processes]
    .sort((a, b) => totalFindings(b) - totalFindings(a))
    .slice(0, FINDING_DETAIL_PROCESSES);

  const findingLists = await Promise.all(
    busiest.map((process) =>
      listProcessFindings(ctx, { processId: process.id, limit: FINDINGS_PER_PROCESS })
        .then((findings: ProcessFinding[]) => findings.map((finding) => ({
          processId: process.id,
          processName: process.name,
          finding,
        })))
        .catch(() => [] as ProcessFindingItem[]),
    ),
  );

  const latestFindings = findingLists
    .flat()
    .sort((a, b) => b.finding.detectedAt.localeCompare(a.finding.detectedAt))
    .slice(0, 15);

  return {
    generatedAt: now().toISOString(),
    total: processes.length,
    capped: processes.length >= PROCESS_CAP,
    processes: processes.map((process) => ({
      id: process.id,
      name: process.name,
      version: process.version,
      stats: process.stats,
      findingCounts: process.findingCounts,
      updatedAt: process.updatedAt,
    })),
    latestFindings,
  };
}
