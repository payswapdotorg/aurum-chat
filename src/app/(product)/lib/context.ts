// Product shell (W057/W058) — the product area's shared context module.
//
// HISTORY: until W058 this file defined the EXPLICIT development seam
// (x-aurum-tenant / ?tenant= headers+query, with a well-known operator
// principal and raw authority claims). W058 (Authentication, Sessions &
// Tenant Onboarding) REMOVED that seam from normal user navigation: the
// browser surfaces now resolve their TenantContext from the SESSION
// COOKIE through the auth contract (see @/app/lib/request-session.ts and
// @/app/lib/page-session.ts) — the principal and its authority claims
// are EARNED by verified membership, never typed into a URL.
//
// What remains here:
//   * PageSearchParams — the searchParams shape every product page takes
//     (non-scope parameters like the chat starter `?q=` still exist);
//   * PRODUCT_OPERATOR_PRINCIPAL — the fixed, claim-less principal the
//     marketplace's PUBLIC catalog browsing context uses (that context is
//     a well-formed nobody by design — see marketplace/lib/views.ts).

/** The App Router searchParams shape the product pages receive. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/**
 * The fixed, claim-less principal of the marketplace's public catalog
 * browsing context (W064): the catalog itself is public, and this
 * principal can read exactly the PUBLISHED/INSTALLABLE catalog, install
 * nothing, and own nothing.
 */
export const PRODUCT_OPERATOR_PRINCIPAL = '00000000-0000-4000-8000-000000000057';
