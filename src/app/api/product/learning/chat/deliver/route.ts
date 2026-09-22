// Chat-based learning requests (W073) —
// POST /api/product/learning/chat/deliver.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// learning surface's lib/chat-api.ts and is tested directly; this file
// only translates HTTP into it. Delivers the tenant's open knowledge
// requests into the persistent learning conversation (idempotent per
// plan) and converges answered asks with their acknowledgement — the
// "Aurum asks targeted knowledge questions in chat" acceptance.

import { NextResponse } from 'next/server';
import { handleChatDeliverPost } from '@/app/(product)/learning/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleChatDeliverPost(request);
  return NextResponse.json(result.body, { status: result.status });
}
