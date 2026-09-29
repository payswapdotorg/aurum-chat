// Platform surfaces (W116) — the page-side access resolution of the
// (platform) route group, the operator's review desk.
//
// The gate is deliberately boring: platform pages render ONLY for a
// signed-in platform admin. Everyone else is redirected to their natural
// surface with the exact same routing the (auth) pages use — anonymous →
// /signin, a signed-in regular user → /chat (or /onboarding while no
// company is selected). The redirect never acknowledges the platform area
// exists: no 403 page, no 'next' parameter, nothing to probe (the house
// no-leak doctrine, applied to a route instead of an error).
//
// The pure half (`resolvePlatformPageAccess`) is unit-tested; the async
// half only adds the session read and the redirect.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveSession, SESSION_COOKIE } from '@/app/lib/session';
import type { SessionResolution } from '@/app/lib/session';

/** A signed-in session resolution (either onboarding or scoped). */
export type SignedInResolution = Extract<
  SessionResolution,
  { status: 'no-company' | 'authenticated' }
>;

/** What a platform page may render with. */
export interface PlatformPage {
  resolution: SignedInResolution;
  /** The live session token (module calls are session-scoped). */
  token: string;
}

/** The pure access decision: render, or where to redirect. */
export type PlatformPageAccess =
  | { ok: true; resolution: SignedInResolution }
  | { ok: false; redirectTo: string };

/**
 * Decide platform-page access from one resolved session — pure, no I/O:
 *   * anonymous            → /signin;
 *   * platform admin       → renders (a no-company admin included: the
 *                            waitlist is a PLATFORM operation, never
 *                            tenant-scoped);
 *   * anyone else          → their natural surface, exactly the routing
 *                            the (auth) pages apply (no existence leak).
 */
export function resolvePlatformPageAccess(resolution: SessionResolution): PlatformPageAccess {
  if (resolution.status === 'anonymous') {
    return { ok: false, redirectTo: '/signin' };
  }
  if (!resolution.platformAdmin) {
    return {
      ok: false,
      redirectTo: resolution.status === 'authenticated' ? '/chat' : '/onboarding',
    };
  }
  return { ok: true, resolution };
}

/**
 * Resolve the platform page's session or redirect (never returns for a
 * request the platform area will not serve).
 */
export async function requirePlatformAdminPage(): Promise<PlatformPage> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;
  const access = resolvePlatformPageAccess(await resolveSession());
  if (!access.ok) redirect(access.redirectTo);
  if (token === null) redirect('/signin');
  return { resolution: access.resolution, token };
}
