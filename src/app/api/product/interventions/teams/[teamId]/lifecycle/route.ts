// The interventions surface's team-lifecycle route (W063) — a thin
// adapter over the handler in the surface's lib/api.ts.

import { NextResponse } from 'next/server';
import { handleTeamLifecyclePost } from '@/app/(product)/interventions/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await context.params;
  const result = await handleTeamLifecyclePost(request, teamId);
  return NextResponse.json(result.body, { status: result.status });
}
