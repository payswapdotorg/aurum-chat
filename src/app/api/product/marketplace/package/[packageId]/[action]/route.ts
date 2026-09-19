// Product marketplace API — POST /api/product/marketplace/package/<id>/<action>.
//
// Thin adapter (IMPLEMENTATION-STACK §5, the /api/tower discipline): the
// handler logic lives in the marketplace area's lib/api.ts and is tested
// directly; this file only translates HTTP into it. Actions: submit,
// verify, review, publish, make-installable, install.

import { NextResponse } from 'next/server';
import {
  handlePackageAction,
  isPackageAction,
} from '@/app/(product)/marketplace/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ packageId: string; action: string }> },
): Promise<NextResponse> {
  const { packageId, action } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  if (!isPackageAction(action)) {
    return NextResponse.json(
      { error: 'unknown_action', message: `'${action}' is not a marketplace package action` },
      { status: 404 },
    );
  }
  const result = await handlePackageAction(request, packageId, action, body);
  return NextResponse.json(result.body, { status: result.status });
}
