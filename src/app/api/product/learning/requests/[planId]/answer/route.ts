// Learning missions, contributions & rewards (W062) —
// POST /api/product/learning/requests/<planId>/answer.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// learning surface's lib/api.ts and is tested directly; this file only
// translates HTTP into it. The answer becomes acquisition evidence (an
// immutable observation) and records the contribution anchored to the
// plan — one contribution per plan, terminal outcome first-write-wins
// (the domain's own guards, surfaced honestly as 409).

import { NextResponse } from 'next/server';
import { handleAnswerPost } from '@/app/(product)/learning/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
): Promise<NextResponse> {
  const { planId } = await context.params;
  const result = await handleAnswerPost(request, planId);
  return NextResponse.json(result.body, { status: result.status });
}
