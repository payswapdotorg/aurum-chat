// Management Control Tower API — GET /api/tower/<surface>.
//
// Thin adapter (IMPLEMENTATION-STACK §5): resolve tenant context, build
// the surface's view through module contracts only, return JSON. The
// /api/v1 public API is W038's scope; these routes are the tower's own
// programmatic surface (also exercised by the approvals UI).

import { NextResponse } from 'next/server';
import { handleTowerSurfaceGet } from '@/app/(tower)/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ surface: string }> },
): Promise<NextResponse> {
  const { surface } = await context.params;
  const result = await handleTowerSurfaceGet(request, surface);
  return NextResponse.json(result.body, { status: result.status });
}
