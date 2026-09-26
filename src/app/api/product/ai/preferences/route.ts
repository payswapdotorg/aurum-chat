// AI preferences (W091) API — /api/product/ai/preferences.
//
// GET  — the whole outcome-oriented preferences view (the same read
//        model the /ai/preferences page renders; jargon-free).
// POST — one surface action (set/clear the personal preference, set the
//        company preference, set/clear a technical override), executed
//        through the provider-preferences module's contract only (locks
//        31/32: application capabilities, never raw persistence).
//
// The route stays a thin adapter; the handling logic lives in the
// surface's lib/api.ts and is tested directly without booting Next.js
// (the same discipline every product surface follows).

import { NextResponse } from 'next/server';
import { handlePreferencesAction, handlePreferencesGet } from '@/app/(product)/ai/preferences/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handlePreferencesGet(request);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null; // a non-JSON body parses to the invalid-body error path
  }
  const result = await handlePreferencesAction(request, body);
  return NextResponse.json(result.body, { status: result.status });
}
