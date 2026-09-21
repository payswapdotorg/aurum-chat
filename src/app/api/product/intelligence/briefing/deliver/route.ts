// Intelligence discovery (W061) — POST /api/product/intelligence/briefing/deliver.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// intelligence surface's lib/api.ts and is tested directly; this file
// only translates HTTP into it. Delivers the tenant's current proactive
// findings into the persistent intelligence conversation (idempotent per
// findings digest — the "proactive findings enter chat" acceptance).

import { NextResponse } from 'next/server';
import { handleBriefingDeliverPost } from '@/app/(product)/intelligence/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleBriefingDeliverPost(request);
  return NextResponse.json(result.body, { status: result.status });
}
