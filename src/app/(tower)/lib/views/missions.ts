// Management Control Tower (W033) — the Missions view.
//
// LearningMission is the loop's knowledge-investment vehicle (lock 8):
// what knowledge is missing, why it matters, how sure it must become,
// what it may cost and where it may come from. Read through the missions
// contract only, grouped by lifecycle (active / completed / abandoned —
// terminal states are dead ends by design, a returning need is a NEW
// mission).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listMissions } from '@/modules/missions/contract';
import type { Mission, MissionStatus } from '@/modules/missions/contract';

const CAP = 200;

export interface MissionCard {
  id: string;
  version: number;
  title: string;
  knowledgeObjective: string;
  urgency: Mission['content']['urgency'];
  informationValue: number;
  currentConfidence: number;
  targetConfidence: number;
  investigationBudget: Mission['content']['investigationBudget'];
  rewardBudget: Mission['content']['rewardBudget'];
  affectedGoals: Mission['content']['affectedGoals'];
  unknownCount: number;
  candidateCount: number;
  completionCriteria: string;
  completion: Mission['completion'];
  lastChange: Mission['lastChange'];
  updatedAt: string;
}

export interface MissionsView {
  generatedAt: string;
  active: { total: number; capped: boolean; items: MissionCard[] };
  completed: { total: number; items: MissionCard[] };
  abandoned: { total: number; items: MissionCard[] };
}

function card(mission: Mission): MissionCard {
  return {
    id: mission.id,
    version: mission.version,
    title: mission.content.title,
    knowledgeObjective: mission.content.knowledgeObjective,
    urgency: mission.content.urgency,
    informationValue: mission.content.informationValue,
    currentConfidence: mission.content.currentConfidence,
    targetConfidence: mission.content.targetConfidence,
    investigationBudget: mission.content.investigationBudget,
    rewardBudget: mission.content.rewardBudget,
    affectedGoals: mission.content.affectedGoals,
    unknownCount: mission.content.unknownIds.length,
    candidateCount: mission.content.candidateSources.length,
    completionCriteria: mission.content.completionCriteria,
    completion: mission.completion,
    lastChange: mission.lastChange,
    updatedAt: mission.updatedAt,
  };
}

async function byStatus(
  ctx: TenantContext,
  status: MissionStatus,
  limit: number,
): Promise<Mission[]> {
  return listMissions(ctx, { status, limit });
}

/** Build the Missions view grouped by lifecycle state. */
export async function buildMissionsView(ctx: TenantContext): Promise<MissionsView> {
  const [active, completed, abandoned] = await Promise.all([
    byStatus(ctx, 'active', CAP),
    byStatus(ctx, 'completed', 20),
    byStatus(ctx, 'abandoned', 20),
  ]);
  return {
    generatedAt: now().toISOString(),
    active: {
      total: active.length,
      capped: active.length >= CAP,
      items: active.map(card),
    },
    completed: { total: completed.length, items: completed.map(card) },
    abandoned: { total: abandoned.length, items: abandoned.map(card) },
  };
}
