// Conversational interventions & approval continuity (W074) —
// POST /api/product/interventions/chat/proposals/<proposalId>/decide.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// interventions surface's lib/chat-api.ts and is tested directly; this
// file only translates HTTP into it. The INLINE HUMAN DECISION from the
// thread: the same authority gate the Interventions decision form drives
// (decideApproval — claim-gated, separation of duties) plus the settle
// onto the proposal, then the OUTCOME message returns to the originating
// thread — "approval remains explicitly human-authorized" and "post-action
// outcome returns to the originating thread".

import { NextResponse } from 'next/server';
import { handleInterventionsChatProposalDecidePost } from '@/app/(product)/interventions/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  const { proposalId } = await context.params;
  const result = await handleInterventionsChatProposalDecidePost(request, proposalId);
  return NextResponse.json(result.body, { status: result.status });
}
