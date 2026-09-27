// Product marketplace API — POST /api/product/marketplace/kit/<key>/<action>.
//
// Thin adapter (IMPLEMENTATION-STACK §5, the /api/tower discipline): the
// handler logic lives in the marketplace area's lib/kit-api.ts and is
// tested directly; this file only translates HTTP into it. Actions:
// install, review, activate, suspend, resume, remove — the W092
// vertical-kit lifecycle's own writes (the kit install flow composes
// register → verify → install over the vertical-kits contract).

import { NextResponse } from 'next/server';
import { handleKitAction, isKitAction } from '@/app/(product)/marketplace/lib/kit-api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ kitKey: string; action: string }> },
): Promise<NextResponse> {
  const { kitKey, action } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  if (!isKitAction(action)) {
    return NextResponse.json(
      { error: 'unknown_action', message: `'${action}' is not a vertical-kit action` },
      { status: 404 },
    );
  }
  const result = await handleKitAction(request, kitKey, action, body);
  return NextResponse.json(result.body, { status: result.status });
}
