// Health/readiness endpoint (W069 — plan §7 acceptance: "health/
// readiness"; deployment pipeline: "post-deploy smoke + runtime health +
// queue health"). See lib.ts for the contract; this file is the thin
// NextResponse adapter (the handling logic is tested directly without
// booting Next.js, the same discipline the other API surfaces follow).

import { NextResponse } from 'next/server';
import { handleHealthGet } from './lib';

export const dynamic = 'force-dynamic';

// The desktop power client (clients/desktop, W139 cross-platform contract)
// boots from its own origin — tauri://localhost on Linux — and probes this
// endpoint with a cross-origin fetch before handing the window to the
// canonical web app. Without CORS headers the webview rejects the response
// and the client can never leave its offline screen. Health data is
// deployment-shape only (the test suite asserts no tenant data), so any
// origin may read it.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
} as const;

export async function GET(): Promise<NextResponse> {
  const result = await handleHealthGet();
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}

// Preflight support so future client probes with custom headers (auth,
// telemetry) are not gated on a missing OPTIONS surface.
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
