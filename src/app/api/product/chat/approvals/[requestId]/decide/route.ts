// Aurum chat API (W060) — POST /api/product/chat/approvals/<id>/decide.
//
// The human decision on a pending action request, straight through the
// actions contract (decideApproval — claim-gated, separation of duties,
// first decision wins, append-only trail) so a manager can resolve an
// approval card without leaving the conversation. Thin adapter — the
// handling logic is the chat surface's lib/chat-api.ts and is tested
// directly.

import { NextResponse } from 'next/server';
import { handleChatApprovalDecidePost } from '@/app/(product)/chat/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<NextResponse> {
  const { requestId } = await context.params;
  const result = await handleChatApprovalDecidePost(request, requestId);
  return NextResponse.json(result.body, { status: result.status });
}
