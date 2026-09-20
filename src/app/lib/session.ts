// W058 — the app-layer session resolution shared by every authenticated
// surface (product shell, tower, connections, and the auth API handlers).
//
// This is the replacement for the query/header tenant seam: the browser
// carries ONE opaque session cookie; the server resolves the principal,
// re-verifies the active company through the auth module's contract
// (which re-verifies membership through the organizations contract), and
// hands the surface an EXPLICIT TenantContext — "preserve explicit
// TenantContext internally" (work item W058). No query string, no header,
// no ambient global.
//
// Two entry points, one core:
//   * `resolveSession()`      — server components (next/headers cookies);
//   * `resolveSessionRequest()` — route handlers/tests (Request cookie header).
//
// The dev seam (x-aurum-tenant / ?tenant= / ?principal= / ?authority=) is
// REMOVED from navigation: the session is the only scope source, so a
// query string can no longer smuggle a tenant id into a page.

import { cookies } from 'next/headers';
import {
  authenticateSession,
  listUserCompanies,
} from '@/modules/auth/contract';
import type {
  AuthPrincipal,
  UserCompany,
} from '@/modules/auth/contract';
import type { TenantContext } from '@/infra/tenant';

/** The single session cookie (httpOnly; the raw token lives only here). */
export const SESSION_COOKIE = 'aurum_session';

/** A resolved session as the surfaces consume it. */
export type SessionResolution =
  | { status: 'anonymous' }
  | {
      status: 'no-company';
      sessionId: string;
      principal: AuthPrincipal;
      /** The principal's verified companies (onboarding picks from these). */
      companies: UserCompany[];
    }
  | {
      status: 'authenticated';
      sessionId: string;
      principal: AuthPrincipal;
      context: TenantContext;
      /** The verified role behind the derived claims. */
      role: string;
      /** The active workspace id inside the company (null = tenant default). */
      workspaceId: string | null;
      /** The principal's verified companies (the switcher's data). */
      companies: UserCompany[];
    };

/** Extract the session token from a raw Cookie header value. */
export function sessionTokenFromCookieHeader(header: string | null): string | null {
  if (header === null || header === '') return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE) {
      const value = trimmed.slice(eq + 1);
      return value === '' ? null : value;
    }
  }
  return null;
}

/** Extract the session token from a Request's Cookie header. */
export function sessionTokenFromRequest(request: Request): string | null {
  return sessionTokenFromCookieHeader(request.headers.get('cookie'));
}

async function resolveSessionToken(token: string | null): Promise<SessionResolution> {
  if (token === null) return { status: 'anonymous' };
  try {
    const session = await authenticateSession({ token });
    if (session.company === null) {
      return {
        status: 'no-company',
        sessionId: session.sessionId,
        principal: session.principal,
        companies: await listUserCompanies({ token }).catch(() => []),
      };
    }
    return {
      status: 'authenticated',
      sessionId: session.sessionId,
      principal: session.principal,
      context: {
        tenantId: session.company.tenantId,
        principalId: session.principalId,
        authority: session.company.authority,
      },
      role: session.company.role,
      workspaceId: session.company.workspaceId,
      companies: await listUserCompanies({ token }).catch(() => []),
    };
  } catch {
    return { status: 'anonymous' };
  }
}

/** Resolve the session for a route handler (and for tests): Request → cookie. */
export async function resolveSessionRequest(request: Request): Promise<SessionResolution> {
  return resolveSessionToken(sessionTokenFromRequest(request));
}

/** Resolve the session for a server component: next/headers cookies. */
export async function resolveSession(): Promise<SessionResolution> {
  const jar = await cookies();
  return resolveSessionToken(jar.get(SESSION_COOKIE)?.value ?? null);
}
