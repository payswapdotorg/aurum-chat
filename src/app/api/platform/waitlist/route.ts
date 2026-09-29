// Platform API (W116) — GET /api/platform/waitlist.
//
// Thin adapter: all logic lives in the (platform) group's lib/api.ts. The
// admin's JSON roster read (the operator's programmatic view of the same
// list the desk renders).

import { handleWaitlistListGet } from '@/app/(platform)/lib/api';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const result = await handleWaitlistListGet(request);
  return NextResponse.json(result.body, { status: result.status });
}
