// W058 — the session cookie contract of the app surface.
//
// PURE module (no next/* imports) so route handlers, the middleware and
// the tests share one implementation:
//   * the cookie name (`aurum_session`);
//   * parsing the bearer token out of a `Cookie:` header;
//   * building `Set-Cookie` values for opening/clearing the session.
//
// Cookie posture: HttpOnly (no JS access), SameSite=Lax (normal
// navigation works, cross-site posts don't carry it), Path=/ (the session
// scopes the whole product), Secure in production, Max-Age = the session
// TTL (14 days) so browsers drop it when the server-side session dies.

export const SESSION_COOKIE_NAME = 'aurum_session';

/** Extract the session token from a raw `Cookie:` header value (first wins). */
export function sessionTokenFromCookieHeader(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    if (value === '') return null;
    return value;
  }
  return null;
}

/** Build the `Set-Cookie` value that opens (or refreshes) a session. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure,
  ].join('; ');
}

/** Build the `Set-Cookie` value that clears the session cookie. */
export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
