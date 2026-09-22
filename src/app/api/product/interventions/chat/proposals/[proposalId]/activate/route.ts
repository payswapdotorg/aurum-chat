// Conversational interventions & approval continuity (W074) —
// POST /api/product/interventions/chat/proposals/<proposalId>/activate.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// interventions surface's lib/chat-api.ts and is tested directly; this
// file only translates HTTP into it. The ACTIVATION from the thread:
// registers the agent with EXACTLY the scopes the approved comparison
// proposed (the same activation the Interventions form drives —
// 'agents:administer' claim-gated), then the activation outcome (the
// agent card with its retain/modify/terminate lifecycle context) returns
// to the originating thread.

import { NextResponse } from 'next/server';
import { handleInterventionsChatProposalActivatePost } from '@/app/(product)/interventions/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  const { proposalId } = await context.params;
  const result = await handleInterventionsChatProposalActivatePost(request, proposalId);
  return NextResponse.json(result.body, { status: result.status });
}
