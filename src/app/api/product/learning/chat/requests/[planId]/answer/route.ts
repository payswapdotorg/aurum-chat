// Chat-based learning requests (W073) —
// POST /api/product/learning/chat/requests/<planId>/answer.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// learning surface's lib/chat-api.ts and is tested directly; this file
// only translates HTTP into it. Captures the employee's thread reply as
// the SAME domain workflow the Learning form drives (evidence capture →
// contribution acknowledgement → reward state → evidence links), then
// records the member's turn and Aurum's acknowledgement in the same
// conversation — "an employee can complete a knowledge request without
// discovering the Learning route first."

import { NextResponse } from 'next/server';
import { handleChatAnswerPost } from '@/app/(product)/learning/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
): Promise<NextResponse> {
  const { planId } = await context.params;
  const result = await handleChatAnswerPost(request, planId);
  return NextResponse.json(result.body, { status: result.status });
}
