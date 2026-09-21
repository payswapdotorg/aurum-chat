// AI/BYOA & Provider Routing UX (W066) API — /api/product/ai.
//
// GET  — the whole AI-providers view (the same read model the /ai page
//        renders), optionally resolving one hot-swap verification record
//        via ?verification=<uuid>.
// POST — one surface action (add/update/revoke/restore an account, test a
//        connection, set availability, run a hot-swap verification),
//        executed through the llm module's contract only (locks 28/31/32:
//        application capabilities, never raw persistence).
//
// The route stays a thin adapter; the handling logic lives in the surface's
// lib/api.ts and is tested directly without booting Next.js (the same
// discipline every product surface follows).

import { NextResponse } from 'next/server';
import { handleAiAction, handleAiGet } from '@/app/(product)/ai/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleAiGet(request);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  const result = await handleAiAction(request, body);
  return NextResponse.json(result.body, { status: result.status });
}
