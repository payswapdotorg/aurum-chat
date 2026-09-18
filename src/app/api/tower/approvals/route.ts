// Management Control Tower API — GET /api/tower/approvals.
//
// Static sibling of /[surface]: keeps the approvals surface readable at
// its canonical path even though the decide route occupies the
// /api/tower/approvals/... namespace.

import { NextResponse } from 'next/server';
import { handleTowerSurfaceGet } from '@/app/(tower)/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleTowerSurfaceGet(request, 'approvals');
  return NextResponse.json(result.body, { status: result.status });
}
