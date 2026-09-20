// Connection & Integration Hub (W059) — query-param helpers.
//
// HISTORY: before W058 this module resolved the hub's TenantContext from
// a documented development seam (`x-aurum-tenant` header / `?tenant=`
// query parameters). W058 removed that seam: the hub's page and API
// handlers resolve their EXPLICIT TenantContext from the authenticated
// session (`@/app/lib/session` → the auth contract → the organizations
// contract, membership re-verified per request). The resolver functions
// are gone on purpose — a URL parameter can no longer scope (or smuggle)
// a company.
//
// What remains are the small query helpers the page and its client
// components still use for NON-scope parameters (the identity lookup
// fields). Scope never appears in a URL — the session carries it.

/** First non-empty value of a possibly-array query parameter. */
export function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** The scope parameters, all permanently null post-W058 (kept for typing). */
export interface ScopeParams {
  tenant: string | null;
  principal: string | null;
  authority: string | null;
}

/**
 * The scope of a connections request. The seam is gone: scope lives in
 * the session, so this is always the null triple — client action targets
 * therefore carry no scope query at all.
 */
export function scopeParamsOf(
  _params: Record<string, string | string[] | undefined>,
): ScopeParams {
  return { tenant: null, principal: null, authority: null };
}
