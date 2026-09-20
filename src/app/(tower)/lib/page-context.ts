// Management Control Tower (W033/W058) — page-side context resolution.
//
// HISTORY: until W058 every tower page resolved an EXPLICIT development
// context from ?tenant=/x-aurum-tenant (documented seam). W058 removed
// that seam: the tower — management mode inside the same authenticated
// product — resolves its TenantContext from the SESSION COOKIE through
// @/app/lib/page-session. Unauthenticated visitors are redirected to
// sign-in (W058 acceptance: unauthenticated users cannot reach tenant
// data); sessions without an active company go to onboarding.
//
// The explicit TenantContext discipline is untouched: every view builder
// still receives the context as its first argument (no ambient global).

import { requirePageScope } from '@/app/lib/page-session';
import type { RequestScope } from '@/app/lib/request-session';

export type PageSearchParams = Record<string, string | string[] | undefined>;

/** The ready scope a tower page renders with (redirects otherwise). */
export async function requireTowerScope(
  pathname: string,
): Promise<Extract<RequestScope, { phase: 'ready' }>> {
  return requirePageScope(pathname);
}

/** First non-empty value of a possibly-array query parameter. */
export function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Build a query string from a page's NON-scope parameters plus overrides
 * (e.g. the Goals surface's `?status=archived` filter). Scope parameters
 * no longer exist in tower URLs — the session carries them (W058).
 */
export function withQuery(
  params: PageSearchParams,
  overrides: Record<string, string | null> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...overrides })) {
    if (value === null) continue;
    const first = firstValue(value);
    if (first !== null && first !== '') query.set(key, first);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
