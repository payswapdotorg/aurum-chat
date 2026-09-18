// Management Control Tower (W033) — the surface registry.
//
// The fifteen management surfaces ARCHITECTURE-LOCK #33 names ("goals,
// situation, unknowns, missions, risks, opportunities, capabilities,
// workforce, agents, automation, evidence and approvals" plus the
// catalog's "Today" and "Recommendations"): one canonical slug each,
// mapped to its view builder. The (tower) pages and the /api/tower
// routes share exactly this registry, so the UI and the API can never
// drift apart.

import type { TenantContext } from '@/infra/tenant';
import { buildAgentsView } from './views/agents';
import type { AgentsView } from './views/agents';
import { buildApprovalsView } from './views/approvals';
import type { ApprovalsView } from './views/approvals';
import { buildAutomationView } from './views/automation';
import type { AutomationView } from './views/automation';
import { buildCapabilitiesView } from './views/capabilities';
import type { CapabilitiesView } from './views/capabilities';
import { buildEvidenceView } from './views/evidence';
import type { EvidenceView } from './views/evidence';
import { buildGoalsView } from './views/goals';
import type { GoalsView } from './views/goals';
import { buildMissionsView } from './views/missions';
import type { MissionsView } from './views/missions';
import { buildOpportunitiesView } from './views/opportunities';
import type { OpportunitiesView } from './views/opportunities';
import { buildProcessesView } from './views/processes';
import type { ProcessesView } from './views/processes';
import { buildRecommendationsView } from './views/recommendations';
import type { RecommendationsView } from './views/recommendations';
import { buildRisksView } from './views/risks';
import type { RisksView } from './views/risks';
import { buildSituationView } from './views/situation';
import type { SituationView } from './views/situation';
import { buildTodayView } from './views/today';
import type { TodayView } from './views/today';
import { buildUnknownsView } from './views/unknowns';
import type { UnknownsView } from './views/unknowns';
import { buildWorkforceView } from './views/workforce';
import type { WorkforceView } from './views/workforce';

/** The tower's surfaces, in navigation order. */
export const TOWER_SURFACES = [
  'today',
  'goals',
  'situation',
  'unknowns',
  'missions',
  'risks',
  'opportunities',
  'capabilities',
  'processes',
  'automation',
  'workforce',
  'agents',
  'evidence',
  'recommendations',
  'approvals',
] as const;

export type TowerSurface = (typeof TOWER_SURFACES)[number];

/** Any tower view model (the discriminated union of all surfaces). */
export type TowerView =
  | TodayView
  | GoalsView
  | SituationView
  | UnknownsView
  | MissionsView
  | RisksView
  | OpportunitiesView
  | CapabilitiesView
  | ProcessesView
  | AutomationView
  | WorkforceView
  | AgentsView
  | EvidenceView
  | RecommendationsView
  | ApprovalsView;

export function isTowerSurface(value: string): value is TowerSurface {
  return (TOWER_SURFACES as readonly string[]).includes(value);
}

/** Build one surface's view model (contracts only; no persistence). */
export async function buildTowerView(
  ctx: TenantContext,
  surface: TowerSurface,
): Promise<TowerView> {
  switch (surface) {
    case 'today':
      return buildTodayView(ctx);
    case 'goals':
      return buildGoalsView(ctx);
    case 'situation':
      return buildSituationView(ctx);
    case 'unknowns':
      return buildUnknownsView(ctx);
    case 'missions':
      return buildMissionsView(ctx);
    case 'risks':
      return buildRisksView(ctx);
    case 'opportunities':
      return buildOpportunitiesView(ctx);
    case 'capabilities':
      return buildCapabilitiesView(ctx);
    case 'processes':
      return buildProcessesView(ctx);
    case 'automation':
      return buildAutomationView(ctx);
    case 'workforce':
      return buildWorkforceView(ctx);
    case 'agents':
      return buildAgentsView(ctx);
    case 'evidence':
      return buildEvidenceView(ctx);
    case 'recommendations':
      return buildRecommendationsView(ctx);
    case 'approvals':
      return buildApprovalsView(ctx);
  }
}
