// Management Control Tower (W033) — the Approvals view.
//
// The §21 approvals gate (W009): pending action requests waiting for
// exactly one human decision, with their append-only decision trails,
// plus the recently decided requests. The tower READS here; the decision
// write goes through the same actions contract (decideApproval) via the
// tower API route — a management decision, recorded immutably, never
// un-decidable.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  listActionRequests,
  listApprovalDecisions,
} from '@/modules/actions/contract';
import type {
  ActionRequest,
  ApprovalDecision,
} from '@/modules/actions/contract';

const CAP = 100;
/** How many pending requests get their decision trail deep-listed. */
const TRAIL_DETAIL = 10;

export interface PendingApprovalItem {
  request: ActionRequest;
  decisions: ApprovalDecision[];
}

export interface ApprovalsView {
  generatedAt: string;
  pendingTotal: number;
  capped: boolean;
  pending: PendingApprovalItem[];
  recentlyDecided: ActionRequest[];
}

/** Build the Approvals view (the human gate, with decision trails). */
export async function buildApprovalsView(ctx: TenantContext): Promise<ApprovalsView> {
  const [pending, approved, rejected] = await Promise.all([
    listActionRequests(ctx, { status: 'pending', limit: CAP }),
    listActionRequests(ctx, { status: 'approved', limit: 10 }),
    listActionRequests(ctx, { status: 'rejected', limit: 10 }),
  ]);

  const trails = await Promise.all(
    pending.slice(0, TRAIL_DETAIL).map(async (request) => ({
      request,
      decisions: await listApprovalDecisions(ctx, { requestId: request.id }),
    })),
  );

  const recentlyDecided = [...approved, ...rejected].sort((a, b) =>
    (b.decidedAt ?? b.requestedAt).localeCompare(a.decidedAt ?? a.requestedAt),
  );

  return {
    generatedAt: now().toISOString(),
    pendingTotal: pending.length,
    capped: pending.length >= CAP,
    pending: trails,
    recentlyDecided,
  };
}
