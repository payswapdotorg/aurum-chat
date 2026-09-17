// Management Control Tower API — POST /api/tower/approvals/<id>/decide.
//
// The one WRITE path of the tower: a human decision on a pending action
// request (W009 decideApproval — claim-gated, separation of duties,
// first decision wins, append-only trail). The route stays a thin
// adapter; the handling logic is lib/api.ts and is tested directly.

import { NextResponse } from 'next/server';
import { handleTowerApprovalDecision } from '@/app/(tower)/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<NextResponse> {
  const { requestId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  const result = await handleTowerApprovalDecision(request, requestId, body);
  return NextResponse.json(result.body, { status: result.status });
}
