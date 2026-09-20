// Product shell (W057) — link-query helpers.
//
// HISTORY: before W058 this module also resolved the shell's tenant
// context from a documented development seam (`x-aurum-tenant` header /
// `?tenant=` query parameters). W058 removed that seam: every page and
// API handler now resolves its EXPLICIT TenantContext from the
// authenticated session (`@/app/lib/session` → the auth contract → the
// organizations contract, membership re-verified per request). The
// resolver functions are gone on purpose — a URL parameter can no longer
// scope (or smuggle) a company.
//
// What remains is the one job links still need: building query strings
// for NON-scope parameters (kind tabs, starter selections, status
// filters). Scope never appears in a URL — the session carries it.

/** Page search params (Next.js App Router `searchParams` shape). */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/**
 * Build a query string from `overrides` only. With no overrides the
 * result is '' (a plain link). The old scope-preservation behavior is
 * gone with the seam: stray `?tenant=`-style parameters are dropped by
 * navigation instead of being carried forward.
 */
export function withProductScope(
  _params: PageSearchParams,
  overrides: Record<string, string | null> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
