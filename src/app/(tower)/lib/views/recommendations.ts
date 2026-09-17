// Management Control Tower (W033) — the Recommendations view.
//
// The proposal feed of the authority matrix (W009, ARCHITECTURE.md §20):
// every consequential action Aurum (or anyone) routed through the gate —
// OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE/EXECUTE — with the deterministic
// evaluation snapshot that routed it. Requests are immutable history the
// moment they are recorded; the tower reads them through the actions
// contract only and decides nothing here (decisions are the Approvals
// surface).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listActionRequests } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';

const CAP = 200;

export interface RecommendationItem {
  id: string;
  actionKind: string;
  authorityLevel: ActionRequest['authorityLevel'];
  status: ActionRequest['status'];
  requestedAt: string;
  decidedAt: string | null;
  justification: string | null;
  requestedBy: string;
  evaluation: ActionRequest['evaluation'];
}

export interface RecommendationsView {
  generatedAt: string;
  total: number;
  capped: boolean;
  byStatus: { status: ActionRequest['status']; count: number }[];
  items: RecommendationItem[];
}

/** Build the Recommendations view (the routed action feed). */
export async function buildRecommendationsView(
  ctx: TenantContext,
): Promise<RecommendationsView> {
  const requests = await listActionRequests(ctx, { limit: CAP });
  const statuses: ActionRequest['status'][] = ['pending', 'approved', 'rejected'];
  const byStatus = statuses.map((status) => ({
    status,
    count: requests.filter((request) => request.status === status).length,
  }));
  return {
    generatedAt: now().toISOString(),
    total: requests.length,
    capped: requests.length >= CAP,
    byStatus,
    items: requests.map((request: ActionRequest) => ({
      id: request.id,
      actionKind: request.actionKind,
      authorityLevel: request.authorityLevel,
      status: request.status,
      requestedAt: request.requestedAt,
      decidedAt: request.decidedAt,
      justification: request.justification,
      requestedBy: request.requestedBy,
      evaluation: request.evaluation,
    })),
  };
}
