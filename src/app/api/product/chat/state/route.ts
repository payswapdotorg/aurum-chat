// Aurum chat API (W060) — GET /api/product/chat/state.
//
// The composed chat state (conversation list + open timeline): what the
// page hydrates from and the client polls for unread/new activity. Thin
// adapter — the handling logic is the chat surface's lib/chat-api.ts and
// is tested directly (the shell/tower discipline).

import { NextResponse } from 'next/server';
import { handleChatStateGet } from '@/app/(product)/chat/lib/chat-api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleChatStateGet(request);
  return NextResponse.json(result.body, { status: result.status });
}
