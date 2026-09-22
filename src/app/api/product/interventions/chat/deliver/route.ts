// Conversational interventions & approval continuity (W074) —
// POST /api/product/interventions/chat/deliver.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// interventions surface's lib/chat-api.ts and is tested directly; this
// file only translates HTTP into it. Delivers the tenant's awaiting
// capability-gap proposals into the persistent interventions
// conversation as recommendation messages (idempotent per proposal) and
// converges decided recommendations with their outcome messages — the
// "a manager can understand a recommendation from Chat" acceptance.

import { NextResponse } from 'next/server';
import { handleInterventionsChatDeliverPost } from '@/app/(product)/interventions/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleInterventionsChatDeliverPost(request);
  return NextResponse.json(result.body, { status: result.status });
}
