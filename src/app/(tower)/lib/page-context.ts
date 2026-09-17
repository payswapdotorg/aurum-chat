// Management Control Tower (W033) — page-side context resolution.
//
// Every (tower) page is an async server component that resolves its
// TenantContext from the request's query parameters (the documented dev
// seam until auth/W038) and either renders the surface or the honest
// not-scoped state. One helper, used by all fifteen pages.

import { towerContextFromSearchParams } from './tower-context';
import type { TowerContextResolution } from './tower-context';

export type PageSearchParams = Record<string, string | string[] | undefined>;

export async function resolvePageContext(
  searchParams: PageSearchParams,
): Promise<TowerContextResolution> {
  return towerContextFromSearchParams(await searchParams);
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
 * Build a query string that PRESERVES the scoping parameters (tenant,
 * principal, authority) and applies `overrides`. Pages use this so
 * navigation links never silently drop the tenant scope.
 */
export function withScope(
  params: PageSearchParams,
  overrides: Record<string, string | null> = {},
): string {
  const scope = scopeQuery(params);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({
    tenant: scope.tenant,
    principal: scope.principal,
    authority: scope.authority,
    ...overrides,
  })) {
    if (value !== null && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
