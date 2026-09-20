// Auth API (W058) — session cookie serialization (pure, testable).
//
// The cookie is the ONLY credential the browser holds: httpOnly (no JS
// access), SameSite=Lax (cross-site POSTs don't ride it), Path=/ (one
// session for the whole app), Secure in production (the deployment is
// HTTPS; local dev stays plain http). Max-Age matches the session's
// absolute cap — a stale cookie is harmless: the server treats its token
// as uniformly unauthenticated.

import { SESSION_ABSOLUTE_TTL_MS } from '@/modules/auth/contract';
import { SESSION_COOKIE } from '@/app/lib/session';

/** Cookie lifetime (seconds) — the session's absolute cap. */
export const SESSION_COOKIE_MAX_AGE = Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);

/** The Set-Cookie header that establishes a session. */
export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}${secure}`;
}

/** The Set-Cookie header that clears the session (sign-out). */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
