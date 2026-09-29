// Platform API (W116) — POST /api/platform/waitlist/decide.
//
// Thin adapter: all logic lives in the (platform) group's lib/api.ts. The
// outcome is always a 303 redirect (the admin surface's forms navigate);
// the location is framed against the request URL.

import { handleWaitlistDecidePost } from '@/app/(platform)/lib/api';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const result = await handleWaitlistDecidePost(request);
  return NextResponse.redirect(new URL(result.location, request.url), 303);
}
