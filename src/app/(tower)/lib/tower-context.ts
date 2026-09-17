// Management Control Tower (W033) — tenant-context resolution.
//
// IMPLEMENTATION-STACK §5: "Control Tower (W033): src/app/(tower)/**
// React pages reading only module contracts via route handlers/server
// code." Every module contract call takes an explicit TenantContext
// (IMPLEMENTATION-STACK §8 — "no ambient global"), so the tower surfaces
// resolve one context per request and thread it through every view
// builder.
//
// AUTHENTICATION IS NOT THIS WORK ITEM'S SCOPE. The auth module and the
// public API (W038) own principals, sessions and tenant-scoped
// authentication. Until they land, the tower resolves an EXPLICIT context
// from request headers or query parameters and performs no
// authentication of its own — the same posture the module test suites
// use (they pass arbitrary TenantContexts straight into contracts). The
// seam is deliberately narrow and documented:
//
//   x-aurum-tenant     (header)   or ?tenant=     (query)  — tenant id (uuid, required)
//   x-aurum-principal  (header)   or ?principal=  (query)  — principal id (uuid, optional;
//                                 defaults to the well-known tower operator below)
//   x-aurum-authority  (header)   or ?authority=  (query)  — comma-separated authority
//                                 claims (optional; needed to DECIDE approvals, e.g.
//                                 'actions:approve' — the actions contract checks it)
//
// Reads work with the default operator principal because the
// information modules validate context shape, not membership. Tenant
// membership surfaces (organizations) additionally require the principal
// to be a member — the workforce view degrades gracefully for
// non-member principals instead of pretending.

import type { TenantContext } from '@/infra/tenant';

/** Well-known principal used when a request names none (documented dev seam). */
export const TOWER_OPERATOR_PRINCIPAL = '00000000-0000-4000-8000-000000000033';

/** Header names the tower reads (documented above). */
export const TENANT_HEADER = 'x-aurum-tenant';
export const PRINCIPAL_HEADER = 'x-aurum-principal';
export const AUTHORITY_HEADER = 'x-aurum-authority';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Explicit inputs from one request (headers and/or query parameters). */
export interface TowerContextInput {
  tenant?: string | null;
  principal?: string | null;
  /** Comma-separated claims (one source string) or a pre-split list. */
  authority?: string | string[] | null;
}

/** Why a context could not be resolved (the caller renders/returns guidance). */
export type TowerContextFailure =
  | 'missing_tenant'
  | 'invalid_tenant'
  | 'invalid_principal';

export type TowerContextResolution =
  | { ok: true; context: TenantContext; principalExplicit: boolean }
  | { ok: false; failure: TowerContextFailure; detail: string };

function isUuid(value: string): boolean {
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
 * Resolve the tower's TenantContext from explicit inputs. Pure: no
 * request objects, no I/O — both the header and the search-param
 * adapters funnel through here, and the rules are unit-testable.
 */
export function resolveTowerContext(
  input: TowerContextInput,
): TowerContextResolution {
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
    principalId = TOWER_OPERATOR_PRINCIPAL;
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
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Adapter: Next.js App Router page `searchParams` (query parameters). */
export function towerContextFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): TowerContextResolution {
  return resolveTowerContext({
    tenant: firstValue(params['tenant']),
    principal: firstValue(params['principal']),
    authority: firstValue(params['authority']),
  });
}

/** Adapter: fetch `Headers` (case-insensitive lookup). */
export function towerContextFromHeaders(headers: Headers): TowerContextResolution {
  return resolveTowerContext({
    tenant: headers.get(TENANT_HEADER),
    principal: headers.get(PRINCIPAL_HEADER),
    authority: headers.get(AUTHORITY_HEADER),
  });
}
