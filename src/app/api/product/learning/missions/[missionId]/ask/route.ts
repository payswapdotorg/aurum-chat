// Learning missions, contributions & rewards (W062) —
// POST /api/product/learning/missions/<missionId>/ask.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// learning surface's lib/api.ts and is tested directly; this file only
// translates HTTP into it. Requests the NEXT knowledge acquisition for
// one active mission: the W012 planner decides the source, composes the
// targeted question and records the ask-policy evaluation (asking is
// still the §7/§20 authority matrix's call).

import { NextResponse } from 'next/server';
import { handleAskPost } from '@/app/(product)/learning/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<NextResponse> {
  const { missionId } = await context.params;
  const result = await handleAskPost(request, missionId);
  return NextResponse.json(result.body, { status: result.status });
}
