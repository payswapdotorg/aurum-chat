// The interventions surface's proposal-decision route (W063) — a thin
// adapter over the handler in the surface's lib/api.ts (the
// learning-surface discipline: no logic here, so the route stays
// untestable-free and the handler is testable without Next.js).

import { NextResponse } from 'next/server';
import { handleProposalDecidePost } from '@/app/(product)/interventions/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  const { proposalId } = await context.params;
  const result = await handleProposalDecidePost(request, proposalId);
  return NextResponse.json(result.body, { status: result.status });
}
