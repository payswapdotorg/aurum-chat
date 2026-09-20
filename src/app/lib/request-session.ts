// W058 — request-side session resolution for every authenticated surface.
//
// This is the REPLACEMENT for the query/header tenant seam: the browser
// surfaces (product shell, tower, connections hub, marketplace) resolve
// their TenantContext from the SESSION COOKIE, never from client-supplied
// scope parameters. The explicit TenantContext discipline is untouched —
// this module only changes WHERE the context comes from: the auth module
// verifies the session and hands out a context whose principal and
// authority are EARNED (membership role), not claimed.
//
// PURE core + a Request adapter (no next/headers here — pages use the
// sibling page-session.ts adapter so this file stays testable without a
// request scope).

import type { TenantContext } from '@/infra/tenant';
import type { AuthPrincipal, ResolvedSession } from '@/modules/auth/contract';
import { resolveSession } from '@/modules/auth/contract';
import { SESSION_COOKIE_NAME, sessionTokenFromCookieHeader } from './session-cookie';

/** What an authenticated surface needs to know about one request. */
export type RequestScope =
  | { phase: 'unauthenticated' }
  | {
      phase: 'no_active_tenant';
      principal: AuthPrincipal;
      /**
       * The session token — SERVER-ONLY (onboarding needs it to offer
       * company switching/creation for a session without an active
       * company). Never render it, never embed it in a client payload.
       */
      token: string;
    }
  | {
      phase: 'ready';
      principal: AuthPrincipal;
      context: TenantContext;
      /** Active workspace slug, or null (the company default applies). */
      workspace: string | null;
      resolved: ResolvedSession;
      /**
       * The session token — SERVER-ONLY. Never render it, never embed it
       * in a client payload; it exists so session-scoped auth operations
       * (tenant switch, invites) can act for this request.
       */
      token: string;
    };

/** The session token a Request carries (its cookie header), or null. */
export function sessionTokenFromRequest(request: Request): string | null {
  return sessionTokenFromCookieHeader(request.headers.get('cookie'));
}

/** A Request carrying a session cookie (test/fixture convenience). */
export function requestWithSession(url: string, token: string): Request {
  return new Request(url, { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
}

/**
 * Resolve the authenticated scope of a request through the auth contract.
 * Never throws for auth reasons — the phases say everything the caller
 * needs (401 / onboarding-redirect / ready).
 */
export async function resolveRequestScope(request: Request): Promise<RequestScope> {
  const token = sessionTokenFromRequest(request);
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
