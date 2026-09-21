// The interventions surface's agent-lifecycle route (W063) — a thin
// adapter over the handler in the surface's lib/api.ts.

import { NextResponse } from 'next/server';
import { handleAgentLifecyclePost } from '@/app/(product)/interventions/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
  const { agentId } = await context.params;
  const result = await handleAgentLifecyclePost(request, agentId);
  return NextResponse.json(result.body, { status: result.status });
}
