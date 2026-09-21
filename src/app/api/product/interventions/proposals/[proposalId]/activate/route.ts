// The interventions surface's agent-activation route (W063) — a thin
// adapter over the handler in the surface's lib/api.ts.

import { NextResponse } from 'next/server';
import { handleProposalActivatePost } from '@/app/(product)/interventions/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  const { proposalId } = await context.params;
  const result = await handleProposalActivatePost(request, proposalId);
  return NextResponse.json(result.body, { status: result.status });
}
