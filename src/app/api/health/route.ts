// Health/readiness endpoint (W069 — plan §7 acceptance: "health/
// readiness"; deployment pipeline: "post-deploy smoke + runtime health +
// queue health"). See lib.ts for the contract; this file is the thin
// NextResponse adapter (the handling logic is tested directly without
// booting Next.js, the same discipline the other API surfaces follow).

import { NextResponse } from 'next/server';
import { handleHealthGet } from './lib';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const result = await handleHealthGet();
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}
