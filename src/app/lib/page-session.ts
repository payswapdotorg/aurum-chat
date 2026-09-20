// W058 — the page-level session gate shared by the product shell and the
// Management Control Tower pages.
//
// Every authenticated page resolves its EXPLICIT TenantContext from the
// session (see lib/session.ts) — the query/header seam is gone from
// navigation. The two redirect outcomes are the routing contract:
//   * anonymous            → /signin;
//   * no active company    → /onboarding (the entry flow);
// anything else renders with a verified company scope.

import { redirect } from 'next/navigation';
import { resolveSession } from './session';
import type { AuthPrincipal, UserCompany } from '@/modules/auth/contract';
import type { TenantContext } from '@/infra/tenant';

/** What an authenticated page renders with. */
export interface AuthenticatedPage {
  principal: AuthPrincipal;
  context: TenantContext;
  /** The verified tenant role behind the derived claims. */
  role: string;
  /** The active workspace id inside the company (null = tenant default). */
  workspaceId: string | null;
  /** The principal's verified companies (switchers, pickers). */
  companies: UserCompany[];
}

/**
 * Resolve the authenticated page context or redirect (never returns for
 * anonymous / onboarding states — the caller's types stay narrow).
 */
export async function requireAuthenticatedPage(): Promise<AuthenticatedPage> {
  const resolution = await resolveSession();
  if (resolution.status === 'anonymous') redirect('/signin');
  if (resolution.status === 'no-company') redirect('/onboarding');
  return resolution;
}
