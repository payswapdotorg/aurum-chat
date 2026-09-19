// Product marketplace API — POST /api/product/marketplace/extension/<key>/<action>.
//
// Thin adapter: the handler logic lives in the marketplace area's
// lib/api.ts and is tested directly. Actions: deploy, rollback,
// activate, suspend, resume, deprecate.

import { NextResponse } from 'next/server';
import {
  handleExtensionAction,
  isExtensionAction,
} from '@/app/(product)/marketplace/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ extensionKey: string; action: string }> },
): Promise<NextResponse> {
  const { extensionKey, action } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!isExtensionAction(action)) {
    return NextResponse.json(
      { error: 'unknown_action', message: `'${action}' is not an extension governance action` },
      { status: 404 },
    );
  }
  const result = await handleExtensionAction(request, extensionKey, action, body);
  return NextResponse.json(result.body, { status: result.status });
}
