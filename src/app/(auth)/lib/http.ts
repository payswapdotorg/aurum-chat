// Auth API (W058) — HTTP framing for the /api/auth route handlers.
//
// The one place the handlers' pure results become Next responses (the
// handlers themselves stay framework-free, the tower/product discipline).

import { NextResponse } from 'next/server';
import type { AuthApiResult } from './api';
import { clearSessionCookieHeader } from './cookies';

/** Frame one handler result (attaching Set-Cookie when present). */
export function authApiResponse(result: AuthApiResult): NextResponse {
  const response = NextResponse.json(result.body, { status: result.status });
  if (result.setCookie !== undefined) response.headers.set('set-cookie', result.setCookie);
  if (result.clearCookie === true) response.headers.set('set-cookie', clearSessionCookieHeader());
  return response;
}
