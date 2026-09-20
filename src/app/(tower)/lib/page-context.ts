// Management Control Tower (W033) — page-side context resolution (W058).
//
// The seam is gone: pages no longer read a tenant from the query string.
// Every (tower) page is an async server component that resolves its
// EXPLICIT TenantContext from the authenticated session (the auth module
// verified the principal AND re-verified the active company's membership
// through the organizations contract), or redirects:
//   * anonymous         → /signin;
//   * no active company → /onboarding.
//
// One helper, used by all fifteen pages — the same single-choke-point
// discipline the original seam used, now pointing at the session.
//
// scopeQuery/withScope remain for the pages' NON-scope query threading
// (status filters and the like); with no scope parameters in the URL they
// are inert — tower links are plain paths now.

import { requireAuthenticatedPage } from '@/app/lib/page-session';
import type { TenantContext } from '@/infra/tenant';
import type { TowerContextResolution } from './tower-context';

export type PageSearchParams = Record<string, string | string[] | undefined>;

/**
 * Resolve the tower page's TenantContext from the session. Never returns
 * a failure for a reachable request: anonymous and onboarding states
 * redirect before a surface renders.
 */
export async function resolvePageContext(): Promise<TowerContextResolution> {
  const session = await requireAuthenticatedPage();
  return {
    ok: true,
    principalExplicit: true,
    context: session.context,
  };
}

/** Forward the scoping query parameters to a client action target. */
export function scopeQuery(
  params: PageSearchParams,
): { tenant: string | null; principal: string | null; authority: string | null } {
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  return {
    tenant: first(params['tenant']),
    principal: first(params['principal']),
    authority: first(params['authority']),
  };
}

/**
 * Build a query string that applies `overrides` (the pages' non-scope
 * filters). The scope parameters no longer exist in tower URLs — the
 * session carries the scope — so only the overrides survive.
 */
export function withScope(
  params: PageSearchParams,
  overrides: Record<string, string | null> = {},
): string {
  void params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** The session-verified context the decision form posts with. */
export type { TenantContext };
