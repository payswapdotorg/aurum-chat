// W058 — the route gate. Every page under the product shell and the
// Management Control Tower is authenticated; the gate exists so an
// unauthenticated hit never renders a surface that expects tenant scope.
//
// The middleware is deliberately CHEAP: it only checks that the session
// cookie exists (edge runtime — no database, no crypto, no I/O). The real
// authentication (token verification, membership re-verification) happens
// in every page/handler through the auth contract — defense in depth, not
// a single gate. Public surfaces: the auth pages themselves and the
// bearer-authenticated public API/MCP paths.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'aurum_session';

/**
 * Paths that render without a session: the auth flows themselves, and the
 * marketplace CATALOG (W064's public browsing surface — platform data,
 * never tenant data; the package pages render read-only for anonymous
 * visitors and every write path self-gates on the session).
 */
const PUBLIC_PATH_PREFIXES = ['/signin', '/signup', '/invite'];
const PUBLIC_PATH_EXACT = ['/marketplace'];
const PUBLIC_PATH_PREFIXES_READONLY = ['/marketplace/package/'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATH_EXACT.includes(pathname)) return true;
  if (PUBLIC_PATH_PREFIXES_READONLY.some((prefix) => pathname.startsWith(prefix))) return true;
  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const target = request.nextUrl.clone();
  target.pathname = '/signin';
  target.search = '';
  target.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(target);
}

export const config = {
  matcher: [
    // All pages except Next internals, the API (self-authenticating via
    // session/bearer), and static assets.
    '/((?!_next/static|_next/image|api/|favicon.ico).*)',
  ],
};
