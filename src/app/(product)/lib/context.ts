// Product shell (W057) — tenant-context resolution and scope threading.
//
// IMPLEMENTATION-STACK §8: "every contract call takes an explicit
// TenantContext ...; no ambient global". Until the auth/session experience
// (W058) replaces it, the product shell resolves its context from the same
// EXPLICIT development seam the Management Control Tower (W033) documents:
//
//   x-aurum-tenant     (header)  or ?tenant=     (query)  — tenant id (uuid, required)
//   x-aurum-principal  (header)  or ?principal=  (query)  — principal id (uuid, optional;
//                                 defaults to the well-known product operator below)
//   x-aurum-authority  (header)  or ?authority=  (query)  — comma-separated authority
//                                 claims (optional, e.g. 'actions:approve')
//   x-aurum-workspace  (header)  or ?workspace=  (query)  — workspace slug (optional;
//                                 a shell-level selection — TenantContext itself stays
//                                 tenant-scoped, workspaces partition tenant experience)
//
// The shell additionally threads the workspace selection through URLs
// (`withProductScope`) so navigation never silently drops it, exactly the
// way the tower preserves tenant scope.

import type { TenantContext } from '@/infra/tenant';

/** Well-known principal used when a request names none (documented dev seam). */
export const PRODUCT_OPERATOR_PRINCIPAL = '00000000-0000-4000-8000-000000000057';

/** Header names the product shell reads (documented above). */
export const TENANT_HEADER = 'x-aurum-tenant';
export const PRINCIPAL_HEADER = 'x-aurum-principal';
export const AUTHORITY_HEADER = 'x-aurum-authority';
export const WORKSPACE_HEADER = 'x-aurum-workspace';

/** Query-parameter names (the browser-friendly half of the seam). */
export const TENANT_PARAM = 'tenant';
export const PRINCIPAL_PARAM = 'principal';
export const AUTHORITY_PARAM = 'authority';
export const WORKSPACE_PARAM = 'workspace';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Explicit inputs from one request (headers and/or query parameters). */
export interface ProductContextInput {
  tenant?: string | null;
  principal?: string | null;
  /** Comma-separated claims (one source string) or a pre-split list. */
  authority?: string | string[] | null;
  /** Workspace slug (free-form, tenant-unique; optional shell selection). */
  workspace?: string | null;
}

/** Why a context could not be resolved (the caller renders/returns guidance). */
export type ProductContextFailure =
  | 'missing_tenant'
  | 'invalid_tenant'
  | 'invalid_principal';

/** A resolved context plus the shell-level workspace selection. */
export interface ProductContext {
  context: TenantContext;
  /** Selected workspace slug, or null when the tenant default applies. */
  workspace: string | null;
  principalExplicit: boolean;
}

export type ProductContextResolution =
  | { ok: true; resolved: ProductContext }
  | { ok: false; failure: ProductContextFailure; detail: string };

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

/** Normalize a workspace slug: trimmed, empty becomes null. */
export function normalizeWorkspaceSlug(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the product shell's context from explicit inputs. Pure: no
 * request objects, no I/O — the header and search-param adapters funnel
 * through here, so the rules stay unit-testable.
 */
export function resolveProductContext(
  input: ProductContextInput,
): ProductContextResolution {
  const tenant = (input.tenant ?? '').trim();
  if (tenant === '') {
    return {
      ok: false,
      failure: 'missing_tenant',
      detail: `name a company via the '${TENANT_HEADER}' header or the '?${TENANT_PARAM}=' query parameter`,
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
    principalId = PRODUCT_OPERATOR_PRINCIPAL;
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
    resolved: {
      principalExplicit,
      workspace: normalizeWorkspaceSlug(input.workspace),
      context: {
        tenantId: tenant.toLowerCase(),
        principalId: principalId.toLowerCase(),
        authority: parseAuthority(input.authority),
      },
    },
  };
}

/** First non-empty value of a possibly-array query parameter. */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Adapter: Next.js App Router page `searchParams` (query parameters). */
export function productContextFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): ProductContextResolution {
  return resolveProductContext({
    tenant: firstValue(params[TENANT_PARAM]),
    principal: firstValue(params[PRINCIPAL_PARAM]),
    authority: firstValue(params[AUTHORITY_PARAM]),
    workspace: firstValue(params[WORKSPACE_PARAM]),
  });
}

/** Adapter: fetch `Headers` (case-insensitive lookup). */
export function productContextFromHeaders(
  headers: Headers,
): ProductContextResolution {
  return resolveProductContext({
    tenant: headers.get(TENANT_HEADER),
    principal: headers.get(PRINCIPAL_HEADER),
    authority: headers.get(AUTHORITY_HEADER),
    workspace: headers.get(WORKSPACE_HEADER),
  });
}

/** Adapter: a `Request` — headers first, then query parameters. */
export function productContextFromRequest(
  request: Request,
): ProductContextResolution {
  const fromHeaders = productContextFromHeaders(request.headers);
  if (fromHeaders.ok) return fromHeaders;
  const url = new URL(request.url);
  const fromQuery = productContextFromSearchParams({
    tenant: url.searchParams.get(TENANT_PARAM) ?? undefined,
    principal: url.searchParams.get(PRINCIPAL_PARAM) ?? undefined,
    authority: url.searchParams.get(AUTHORITY_PARAM) ?? undefined,
    workspace: url.searchParams.get(WORKSPACE_PARAM) ?? undefined,
  });
  if (fromQuery.ok) return fromQuery;
  // Both failed: the more specific failure wins — an explicitly INVALID
  // value in one source must not be masked by the other source's absence
  // (a browser request carries its scope in the query, so "?tenant=globex"
  // deserves the invalid-tenant guidance, not a missing-tenant error).
  if (fromQuery.failure !== 'missing_tenant') return fromQuery;
  return fromHeaders;
}

export type PageSearchParams = Record<string, string | string[] | undefined>;

/** The scope parameters every product link must preserve. */
export interface ProductScope {
  tenant: string | null;
  principal: string | null;
  authority: string | null;
  workspace: string | null;
}

/** Extract the scope parameters from page search params. */
export function scopeFromSearchParams(params: PageSearchParams): ProductScope {
  return {
    tenant: firstValue(params[TENANT_PARAM]),
    principal: firstValue(params[PRINCIPAL_PARAM]),
    authority: firstValue(params[AUTHORITY_PARAM]),
    workspace: firstValue(params[WORKSPACE_PARAM]),
  };
}

/**
 * Build a query string that PRESERVES the scoping parameters (tenant,
 * principal, authority, workspace) and applies `overrides`. Product links
 * use this so navigation never silently drops the company scope.
 */
export function withProductScope(
  params: PageSearchParams,
  overrides: Record<string, string | null> = {},
): string {
  const scope = scopeFromSearchParams(params);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({
    tenant: scope.tenant,
    principal: scope.principal,
    authority: scope.authority,
    workspace: scope.workspace,
    ...overrides,
  })) {
    if (value !== null && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Extract the preserved scope from a raw query string (client side:
 * `window.location.search`). Returns the encoded `?...` prefix (or ''.
 */
export function scopeFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const key of [
    TENANT_PARAM,
    PRINCIPAL_PARAM,
    AUTHORITY_PARAM,
    WORKSPACE_PARAM,
  ]) {
    const value = params.get(key);
    if (value !== null && value !== '') out.set(key, value);
  }
  const text = out.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Build the target query for a tenant/workspace switch: scope parameters
 * replaced (`tenant` and/or `workspace` when provided), any other
 * parameters preserved. A company change always drops the workspace
 * selection (a workspace slug only means something inside its tenant).
 * Pure — the switcher navigates to the result.
 */
export function switchScopeTarget(
  search: string,
  change: { tenant?: string; workspace?: string | null },
): string {
  const params = new URLSearchParams(search);
  if (change.tenant !== undefined) {
    params.set(TENANT_PARAM, change.tenant);
    params.delete(WORKSPACE_PARAM);
  }
  if (change.workspace !== undefined) {
    if (change.workspace === null || change.workspace === '') {
      params.delete(WORKSPACE_PARAM);
    } else {
      params.set(WORKSPACE_PARAM, change.workspace);
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
