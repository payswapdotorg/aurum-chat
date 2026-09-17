// Management Control Tower (W033) — the Goals view.
//
// The tenant's declared direction (goals W008, ARCHITECTURE.md §5, lock
// 13), read through the goals contract only: current views grouped by
// lifecycle status, with the version/audit summary the contract exposes.
// The tower never writes goals — defining direction is a management act
// that belongs to the goals module's own surface.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listGoals } from '@/modules/goals/contract';
import type { Goal, GoalContent, GoalStatus } from '@/modules/goals/contract';

const CAP = 200;

export interface GoalCard {
  id: string;
  version: number;
  content: GoalContent;
  createdAt: string;
  updatedAt: string;
  lastChange: Goal['lastChange'];
}

export interface GoalsView {
  generatedAt: string;
  status: GoalStatus;
  total: number;
  capped: boolean;
  goals: GoalCard[];
}

/** Build the Goals view for one lifecycle status (default: active). */
export async function buildGoalsView(
  ctx: TenantContext,
  status: GoalStatus = 'active',
): Promise<GoalsView> {
  const goals = await listGoals(ctx, { status, limit: CAP });
  return {
    generatedAt: now().toISOString(),
    status,
    total: goals.length,
    capped: goals.length >= CAP,
    goals: goals.map((goal) => ({
      id: goal.id,
      version: goal.version,
      content: goal.content,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      lastChange: goal.lastChange,
    })),
  };
}
