// Connection & Integration Hub (W059) — product-surface context resolution.
//
// Every contract call the hub makes carries an explicit TenantContext
// (IMPLEMENTATION-STACK §8 — no ambient global), so the surface resolves one
// context per request and threads it through the view builders and action
// handlers.
//
// AUTHENTICATION IS NOT THIS WORK ITEM'S SCOPE (W058 owns it). Until the
// auth/session domain lands, the hub — exactly like the Management Control
// Tower (W033) — resolves an EXPLICIT context from request headers or query
// parameters and performs no authentication of its own. The seam is
// deliberately narrow, documented, and identical in shape to the tower's:
//
//   x-aurum-tenant     (header)   or ?tenant=     (query)  — tenant id (uuid, required)
//   x-aurum-principal  (header)   or ?principal=  (query)  — principal id (uuid, optional;
//                                 defaults to the well-known connections operator below)
//   x-aurum-authority  (header)   or ?authority=  (query)  — comma-separated authority
//                                 claims (optional; needed to ATT/LINK identities —
//                                 'identity:attest' / 'identity:link' — and to approve
//                                 gated exports, e.g. 'actions:approve')
//
// W058 will replace this seam with authenticated sessions; the resolver stays
// a single pure function so the swap is one adapter change.

import type { TenantContext } from '@/infra/tenant';

/** Well-known principal used when a request names none (documented dev seam). */
export const CONNECTIONS_OPERATOR_PRINCIPAL = '00000000-0000-4000-8000-000000000059';

/** Header names the hub reads (documented above). */
export const TENANT_HEADER = 'x-aurum-tenant';
export const PRINCIPAL_HEADER = 'x-aurum-principal';
export const AUTHORITY_HEADER = 'x-aurum-authority';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Explicit inputs from one request (headers and/or query parameters). */
export interface ConnectionsContextInput {
  tenant?: string | null;
  principal?: string | null;
  /** Comma-separated claims (one source string) or a pre-split list. */
  authority?: string | string[] | null;
}

/** Why a context could not be resolved (the caller renders/returns guidance). */
export type ConnectionsContextFailure =
  | 'missing_tenant'
  | 'invalid_tenant'
  | 'invalid_principal';

export type ConnectionsContextResolution =
  | { ok: true; context: TenantContext; principalExplicit: boolean }
  | { ok: false; failure: ConnectionsContextFailure; detail: string };

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function parseAuthority(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const parts = Array.isArray(value) ? value : value.split(',');
  const claims: string[] = [];
  for (const part of parts) {
    const claim = part.trim();
    if (claim !== '' && !claims.includes(claim)) claims.push(claim);
  }
  return claims;
}

/**
 * Resolve the hub's TenantContext from explicit inputs. Pure: no request
 * objects, no I/O — the header, query and search-param adapters all funnel
 * through here, and the rules are unit-testable.
 */
export function resolveConnectionsContext(
  input: ConnectionsContextInput,
): ConnectionsContextResolution {
  const tenant = (input.tenant ?? '').trim();
  if (tenant === '') {
    return {
      ok: false,
      failure: 'missing_tenant',
      detail: `name a tenant via the '${TENANT_HEADER}' header or the '?tenant=' query parameter`,
    };
  }
  if (!isUuid(tenant)) {
    return {
      ok: false,
      failure: 'invalid_tenant',
      detail: `'${tenant}' is not a tenant id (uuid)`,
    };
  }
  const principal = (input.principal ?? '').trim();
  let principalId: string;
  let principalExplicit = true;
  if (principal === '') {
    principalId = CONNECTIONS_OPERATOR_PRINCIPAL;
    principalExplicit = false;
  } else if (!isUuid(principal)) {
    return {
      ok: false,
      failure: 'invalid_principal',
      detail: `'${principal}' is not a principal id (uuid)`,
    };
  } else {
    principalId = principal;
  }
  return {
    ok: true,
    principalExplicit,
    context: {
      tenantId: tenant.toLowerCase(),
      principalId: principalId.toLowerCase(),
      authority: parseAuthority(input.authority),
    },
  };
}

/** First non-empty value of a possibly-array query parameter. */
export function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Adapter: Next.js App Router page `searchParams` (query parameters). */
export function connectionsContextFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): ConnectionsContextResolution {
  return resolveConnectionsContext({
    tenant: firstValue(params['tenant']),
    principal: firstValue(params['principal']),
    authority: firstValue(params['authority']),
  });
}

/** Adapter: fetch `Headers` (case-insensitive lookup). */
export function connectionsContextFromHeaders(
  headers: Headers,
): ConnectionsContextResolution {
  return resolveConnectionsContext({
    tenant: headers.get(TENANT_HEADER),
    principal: headers.get(PRINCIPAL_HEADER),
    authority: headers.get(AUTHORITY_HEADER),
  });
}

/** The scoping query parameters, forwarded to every client action target. */
export interface ScopeParams {
  tenant: string | null;
  principal: string | null;
  authority: string | null;
}

/** Extract the scoping parameters from page search params (first value wins). */
export function scopeParamsOf(
  params: Record<string, string | string[] | undefined>,
): ScopeParams {
  return {
    tenant: firstValue(params['tenant']),
    principal: firstValue(params['principal']),
    authority: firstValue(params['authority']),
  };
}

/** Serialize the scope into a URL query string (leading '?' when non-empty). */
export function scopeQuery(scope: ScopeParams, extra: Record<string, string | null> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...scope, ...extra })) {
    if (typeof value === 'string' && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
