// Product shell API — GET /api/product/shell.
//
// Thin adapter (IMPLEMENTATION-STACK §5, the /api/tower discipline): resolve
// the explicit tenant context, build the chrome's composed state through
// module contracts only, return JSON. The shell chrome fetches this on
// mount and on demand (scope switches, opening the notification entry).

import { NextResponse } from 'next/server';
import { handleShellStateGet } from '@/app/(product)/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleShellStateGet(request);
  return NextResponse.json(result.body, { status: result.status });
}
