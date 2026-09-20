// W058 — the page-side adapter of request-session.ts.
//
// Server components read cookies through next/headers (async in Next 16);
// this adapter funnels that into the same resolution result so EVERY page
// — product, tower, connections, marketplace, onboarding — enforces the
// authenticated route identically:
//
//   unauthenticated  → redirect to /signin?next=<path> (W058 acceptance:
//                      unauthenticated users cannot reach tenant data)
//   no active tenant → redirect to /onboarding (create or join a company)
//   ready            → the page renders with its TenantContext
//
// The middleware does the fast cookie-presence redirect; THIS is the real
// per-request enforcement (a stale/forged cookie still fails here because
// the auth contract verifies the token against the database).

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { resolveSession } from '@/modules/auth/contract';
import type { RequestScope } from './request-session';

/** The authenticated scope of the current page request (cookie-based). */
export async function pageScope(): Promise<RequestScope> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE_NAME);
  const token = cookie === undefined || cookie.value === '' ? null : cookie.value;
  if (token === null) return { phase: 'unauthenticated' };
  const resolution = await resolveSession(token);
  if (resolution.status !== 'valid') return { phase: 'unauthenticated' };
  const resolved = resolution.resolved;
  if (resolved.tenant === null || resolved.context === null) {
    return { phase: 'no_active_tenant', principal: resolved.principal, token };
  }
  return {
    phase: 'ready',
    principal: resolved.principal,
    context: resolved.context,
    workspace: resolved.workspace === null ? null : resolved.workspace.slug,
    resolved,
    token,
  };
}

/**
 * The scope a tenant-data page requires. Redirects:
 *   unauthenticated → /signin?next=<pathname>
 *   no active tenant → /onboarding
 * Callers pass their own pathname (server components know it).
 */
export async function requirePageScope(pathname: string): Promise<
  Extract<RequestScope, { phase: 'ready' }>
> {
  const scope = await pageScope();
  if (scope.phase === 'unauthenticated') {
    redirect(`/signin?next=${encodeURIComponent(pathname)}`);
  }
  if (scope.phase === 'no_active_tenant') {
    redirect('/onboarding');
  }
  return scope;
}
