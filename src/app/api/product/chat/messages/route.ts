// Aurum chat API (W060) — POST /api/product/chat/messages.
//
// One full chat turn: the member's message is recorded, the Aurum
// workflow runs (a complete, traceable cognition execution + the
// evidence-backed reply), and both turns return as renderer views.
// Thin adapter — the handling logic is the chat surface's lib/chat-api.ts
// and is tested directly.

import { NextResponse } from 'next/server';
import { handleChatSendPost } from '@/app/(product)/chat/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleChatSendPost(request);
  return NextResponse.json(result.body, { status: result.status });
}
