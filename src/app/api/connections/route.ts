// Connection & Integration Hub (W059) API — /api/connections.
//
// GET  — the whole hub view (the same read model the /connections page
//        renders), for programmatic/verification access.
// POST — one hub action (connect/disconnect/configure, poll/replay, retry/
//        replay deliveries, identity verification/linking), executed through
//        the domain contracts only (locks 31/32: application capabilities,
//        never raw persistence).
//
// The route stays a thin adapter; the handling logic lives in the surface's
// lib/api.ts and is tested directly without booting Next.js (the same
// discipline the tower API follows).

import { NextResponse } from 'next/server';
import {
  handleConnectionsAction,
  handleConnectionsGet,
} from '@/app/(product)/connections/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleConnectionsGet(request);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  const result = await handleConnectionsAction(request, body);
  return NextResponse.json(result.body, { status: result.status });
}
