// The interventions surface's termination-settle route (W063) — a thin
// adapter over the handler in the surface's lib/api.ts.

import { NextResponse } from 'next/server';
import { handleDecisionSettlePost } from '@/app/(product)/interventions/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ decisionId: string }> },
): Promise<NextResponse> {
  const { decisionId } = await context.params;
  const result = await handleDecisionSettlePost(request, decisionId);
  return NextResponse.json(result.body, { status: result.status });
}
