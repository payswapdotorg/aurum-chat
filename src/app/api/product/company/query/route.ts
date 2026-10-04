// Company query plane (W126) — POST /api/product/company/query.
//
// Thin adapter (IMPLEMENTATION-STACK §5): the handling logic is the
// company surface's lib/api.ts and is tested directly; this file only
// translates HTTP into it. Runs one provider-independent company query and
// returns the two-layer response (Answer + CoverageContext) as structured
// JSON for the product UI and API/MCP consumers.

import { NextResponse } from 'next/server';
import { handleCompanyQueryPost } from '@/app/(product)/company/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleCompanyQueryPost(request);
  return NextResponse.json(result.body, { status: result.status });
}
