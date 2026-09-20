// W058 — the authenticated-routing proxy (Next 16's middleware convention).
//
// Fast path only: when a PAGE navigation carries no session cookie at all,
// redirect to /signin with the destination preserved. The REAL enforcement
// happens per request (page-session.ts / request-session.ts verify the
// token against the database through the auth contract) — this proxy
// exists so unauthenticated visitors never see a half-rendered product.
//
// Excluded: the public routes (sign-in, invite links), every /api route
// (API handlers answer 401 JSON themselves — a 302 would be wrong), the
// public v1 API, and Next's static assets.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/app/lib/session-cookie';

export default function proxy(request: NextRequest) {
  const hasSession = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (hasSession !== undefined && hasSession !== '') {
    return NextResponse.next();
  }
  const url = request.nextUrl.clone();
  const pathWithQuery = `${url.pathname}${url.search}`;
  url.pathname = '/signin';
  url.search = `?next=${encodeURIComponent(pathWithQuery)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except: api routes, Next internals, static files, the
    // public sign-in/invite pages. Onboarding IS protected (it redirects
    // to sign-in itself when the session is missing).
    '/((?!api/|_next/|favicon.ico|signin|invite/|.*\\.).*)',
  ],
};
