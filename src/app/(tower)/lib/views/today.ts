// Management Control Tower (W033) — the Today view.
//
// "Today" is the attention dashboard: what needs a manager's decision or
// awareness right now — pending approvals (the §21 gate), urgent active
// missions, open unknowns, live cognitive executions, the loop's latest
// findings, the newest goal-gap discovery pass and the freshest
// evidence. Everything is read through module contracts only; nothing is
// persisted here (lock 34: derived intelligence, not authoritative
// state).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listActionRequests } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { listDiscoveryRuns } from '@/modules/attention/contract';
import type { DiscoveryRunSummary } from '@/modules/attention/contract';
import { listExecutions } from '@/modules/cognition/contract';
import type { CognitiveExecution } from '@/modules/cognition/contract';
import { listGoals } from '@/modules/goals/contract';
import type { GoalPriority } from '@/modules/goals/contract';
import { listMissions } from '@/modules/missions/contract';
import type { Mission, MissionUrgency } from '@/modules/missions/contract';
import { listObservations } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { listUnknowns } from '@/modules/epistemics/contract';
import type { Unknown } from '@/modules/epistemics/contract';
import { PRIORITY_ORDER } from '../format';
import { collectTraceFindings } from './findings';
import type { TraceFinding } from './findings';

const COUNT_CAP = 200;

export interface BoundedCount {
  count: number;
  /** True when the read hit its bound — the real count may be higher. */
  capped: boolean;
}

function bounded(rows: unknown[], cap: number = COUNT_CAP): BoundedCount {
  return { count: rows.length, capped: rows.length >= cap };
}

export interface TodayApprovalItem {
  id: string;
  actionKind: string;
  authorityLevel: string;
  requestedAt: string;
  justification: string | null;
}

export interface TodayMissionItem {
  id: string;
  title: string;
  urgency: MissionUrgency;
  informationValue: number;
  currentConfidence: number;
  targetConfidence: number;
}

export interface TodayUnknownItem {
  id: string;
  question: string;
  recordedAt: string;
}

export interface TodayExecutionItem {
  id: string;
  state: string;
  nextStage: string | null;
  triggerKind: string;
  triggerLabel: string | null;
  updatedAt: string;
}

export interface TodayFindingItem {
  kind: TraceFinding['kind'];
  statement: string;
  executionId: string;
  detectedAt: string;
  /** The goals the finding affects (W061 — the workflow drill-down link). */
  affectedGoalIds: string[];
}

export interface TodayDiscovery {
  runId: string;
  triggerKind: string;
  recordedAt: string;
  counts: { total: number; promoted: number; dismissed: number; alreadyCovered: number };
}

export interface TodayView {
  generatedAt: string;
  goals: {
    active: BoundedCount;
    byPriority: { priority: GoalPriority; count: number }[];
    latest: { id: string; updatedAt: string; title: string; priority: GoalPriority }[];
  };
  approvals: { pending: BoundedCount; latest: TodayApprovalItem[] };
  missions: {
    active: BoundedCount;
    byUrgency: { urgency: MissionUrgency; count: number }[];
    urgent: TodayMissionItem[];
  };
  unknowns: { open: BoundedCount; latest: TodayUnknownItem[] };
  cognition: {
    live: BoundedCount;
    awaitingApproval: BoundedCount;
    latest: TodayExecutionItem[];
  };
  findings: TodayFindingItem[];
  discovery: TodayDiscovery | null;
  evidence: { latest: { kind: string; observedAt: string; channel: string }[] };
}

/** Build the Today view from the tenant's current state (contracts only). */
export async function buildTodayView(ctx: TenantContext): Promise<TodayView> {
  const [
    activeGoals,
    pendingRequests,
    activeMissions,
    openUnknowns,
    runningExecutions,
    awaitingInputExecutions,
    awaitingApprovalExecutions,
    traceFindings,
    discoveryRuns,
    observations,
  ] = await Promise.all([
    listGoals(ctx, { status: 'active', limit: COUNT_CAP }),
    listActionRequests(ctx, { status: 'pending', limit: COUNT_CAP }),
    listMissions(ctx, { status: 'active', limit: COUNT_CAP }),
    listUnknowns(ctx, { status: 'open', limit: COUNT_CAP }),
    listExecutions(ctx, { state: 'running', limit: 100 }),
    listExecutions(ctx, { state: 'awaiting_input', limit: 100 }),
    listExecutions(ctx, { state: 'awaiting_approval', limit: 100 }),
    collectTraceFindings(ctx),
    listDiscoveryRuns(ctx, { limit: 1 }),
    listObservations(ctx, { limit: 5 }),
  ]);

  const byPriority = PRIORITY_ORDER.map((priority) => ({
    priority,
    count: activeGoals.filter((goal) => goal.content.priority === priority).length,
  }));

  const byUrgency = PRIORITY_ORDER.map((urgency) => ({
    urgency,
    count: activeMissions.filter((mission) => mission.content.urgency === urgency)
      .length,
  }));

  const liveExecutions: CognitiveExecution[] = [
    ...runningExecutions,
    ...awaitingInputExecutions,
  ];
  const live: BoundedCount = {
    count: liveExecutions.length,
    capped:
      runningExecutions.length >= 100 || awaitingInputExecutions.length >= 100,
  };

  const pendingRows: ActionRequest[] = pendingRequests;
  const missionItems = (mission: Mission): TodayMissionItem => ({
    id: mission.id,
    title: mission.content.title,
    urgency: mission.content.urgency,
    informationValue: mission.content.informationValue,
    currentConfidence: mission.content.currentConfidence,
    targetConfidence: mission.content.targetConfidence,
  });

  const latestRun: DiscoveryRunSummary | undefined = discoveryRuns[0];

  return {
    generatedAt: now().toISOString(),
    goals: {
      active: bounded(activeGoals),
      byPriority,
      latest: activeGoals.slice(0, 5).map((goal) => ({
        id: goal.id,
        updatedAt: goal.updatedAt,
        title: goal.content.title,
        priority: goal.content.priority,
      })),
    },
    approvals: {
      pending: bounded(pendingRows),
      latest: pendingRows.slice(0, 5).map((request) => ({
        id: request.id,
        actionKind: request.actionKind,
        authorityLevel: request.authorityLevel,
        requestedAt: request.requestedAt,
        justification: request.justification,
      })),
    },
    missions: {
      active: bounded(activeMissions),
      byUrgency,
      // listMissions returns urgency-rank order already.
      urgent: activeMissions.slice(0, 5).map(missionItems),
    },
    unknowns: {
      open: bounded(openUnknowns),
      latest: openUnknowns.slice(0, 5).map((unknown: Unknown) => ({
        id: unknown.id,
        question: unknown.question,
        recordedAt: unknown.recordedAt,
      })),
    },
    cognition: {
      live,
      awaitingApproval: bounded(awaitingApprovalExecutions, 100),
      latest: [...liveExecutions, ...awaitingApprovalExecutions]
        .slice(0, 5)
        .map((execution) => ({
          id: execution.id,
          state: execution.state,
          nextStage: execution.nextStage,
          triggerKind: execution.trigger.kind,
          triggerLabel: execution.trigger.label,
          updatedAt: execution.updatedAt,
        })),
    },
    findings: traceFindings.slice(0, 8).map((finding) => ({
      kind: finding.kind,
      statement: finding.statement,
      executionId: finding.executionId,
      detectedAt: finding.detectedAt,
      affectedGoalIds: [...finding.affectedGoalIds],
    })),
    discovery:
      latestRun === undefined
        ? null
        : {
            runId: latestRun.id,
            triggerKind: latestRun.trigger.kind,
            recordedAt: latestRun.recordedAt,
            counts: {
              total: latestRun.counts.total,
              promoted: latestRun.counts.promoted,
              dismissed: latestRun.counts.dismissed,
              alreadyCovered: latestRun.counts.alreadyCovered,
            },
          },
    evidence: {
      latest: observations.slice(0, 5).map((observation: Observation) => ({
        kind: observation.kind,
        observedAt: observation.observedAt,
        channel: observation.channel,
      })),
    },
  };
}
