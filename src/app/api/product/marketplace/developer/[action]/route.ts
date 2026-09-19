// Product marketplace API — POST /api/product/marketplace/developer/<action>.
//
// Thin adapter: the handler logic lives in the marketplace area's
// lib/api.ts and is tested directly. Actions: create-extension-package,
// create-agent-package, request-build, advance-build, cancel-build.

import { NextResponse } from 'next/server';
import {
  handleDeveloperAction,
  isDeveloperAction,
} from '@/app/(product)/marketplace/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const { action } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!isDeveloperAction(action)) {
    return NextResponse.json(
      { error: 'unknown_action', message: `'${action}' is not a marketplace developer action` },
      { status: 404 },
    );
  }
  const result = await handleDeveloperAction(request, action, body);
  return NextResponse.json(result.body, { status: result.status });
}
