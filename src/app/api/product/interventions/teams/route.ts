// The interventions surface's team-compose route (W063) — a thin
// adapter over the handler in the surface's lib/api.ts.

import { NextResponse } from 'next/server';
import { handleTeamCreatePost } from '@/app/(product)/interventions/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleTeamCreatePost(request);
  return NextResponse.json(result.body, { status: result.status });
}
