// W058 — the one NextResponse adapter every /api/auth route uses.

import { NextResponse } from 'next/server';
import type { AuthApiResult } from './auth-api';

export function toAuthResponse(result: AuthApiResult): NextResponse {
  const response = NextResponse.json(result.body as never, { status: result.status });
  if (result.setCookie !== undefined) {
    response.headers.set('set-cookie', result.setCookie);
  }
  return response;
}
