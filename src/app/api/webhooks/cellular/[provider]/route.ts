// The carrier-facing cellular webhook route (W108) — the thin NextResponse
// adapter over lib.ts (the house convention: no logic here, the handler
// is tested directly). See lib.ts for the full route contract (carrier
// configuration, signature verification, response semantics).

import { NextResponse } from 'next/server';
import { handleCellularWebhookPost } from './lib';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await context.params;
  const result = await handleCellularWebhookPost(provider, request);
  return NextResponse.json(result.body, { status: result.status });
}
