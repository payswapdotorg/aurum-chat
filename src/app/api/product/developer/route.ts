// Developer / API / MCP Console (W067) API — /api/product/developer.
//
// GET  — the whole developer-console view (the same read model the
//        /developer page renders), optionally resolving one webhook
//        delivery WITH its append-only attempt trail via ?delivery=<uuid>.
// POST — one surface action (key create/revoke/rotate, webhook
//        create/deactivate/test/redeliver/dispatch), executed through the
//        api module's contract only (locks 31/32: application capabilities,
//        never raw persistence).
//
// The route stays a thin adapter; the handling logic lives in the surface's
// lib/api.ts and is tested directly without booting Next.js (the same
// discipline every product surface follows).

import { NextResponse } from 'next/server';
import { handleDeveloperAction, handleDeveloperGet } from '@/app/(product)/developer/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleDeveloperGet(request);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  const result = await handleDeveloperAction(request, body);
  return NextResponse.json(result.body, { status: result.status });
}
