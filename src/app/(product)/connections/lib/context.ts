// Connection & Integration Hub (W059/W058) — the hub's context module.
//
// HISTORY: until W058 this file defined the hub's EXPLICIT development
// seam (x-aurum-tenant / ?tenant= headers+query). W058 removed it: the
// hub — like every authenticated surface — resolves its TenantContext
// from the SESSION COOKIE (@/app/lib/request-session.ts for the API,
// @/app/lib/page-session.ts for the page), with membership-verified
// principal and role-derived authority claims.
//
// What remains: the small search-param helper the identity lookup uses.

/** First non-empty value of a possibly-array query parameter. */
export function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
