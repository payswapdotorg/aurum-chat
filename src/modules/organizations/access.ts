// Tenant-context validation and the platform authority claim (ADR-0001).
//
// IMPLEMENTATION-STACK §8: every contract call receives an explicit
// TenantContext (tenant id + principal + authority claims) — never an
// ambient global. These helpers are the organizations module's gatekeepers;
// they are stricter than the generic infra shape because this module's ids
// are database uuid keys: tenant/principal ids must be uuid-shaped so a
// malformed context fails as `invalid_context` instead of a Postgres cast
// error, and authority must be an array of claim strings.

import type { TenantContext } from '@/infra/tenant';
import { OrganizationsError } from './errors';
import type { PlatformContext } from './types';

/** Authority claim required by the one platform-level operation (provisionTenant). */
export const ORGANIZATIONS_AUTHORITY_PROVISION = 'organizations:provision';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertAuthority(authority: unknown): void {
  if (!Array.isArray(authority) || !authority.every((claim) => typeof claim === 'string')) {
    throw new OrganizationsError('invalid_context', 'context.authority must be an array of claim strings');
  }
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new OrganizationsError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || !UUID_PATTERN.test(ctx.tenantId)) {
    throw new OrganizationsError('invalid_context', 'TenantContext.tenantId must be a uuid');
  }
  if (typeof ctx.principalId !== 'string' || !UUID_PATTERN.test(ctx.principalId)) {
    throw new OrganizationsError('invalid_context', 'TenantContext.principalId must be a uuid');
  }
  assertAuthority(ctx.authority);
}

/**
 * Validates the shape of an explicit platform context — the actor context of
 * operations that run before any tenant exists (throws `invalid_context`).
 */
export function assertPlatformContext(actor: PlatformContext): void {
  if (actor === null || typeof actor !== 'object') {
    throw new OrganizationsError('invalid_context', 'PlatformContext must be an object');
  }
  if (typeof actor.principalId !== 'string' || !UUID_PATTERN.test(actor.principalId)) {
    throw new OrganizationsError('invalid_context', 'PlatformContext.principalId must be a uuid');
  }
  assertAuthority(actor.authority);
}

/** Requires an exact authority claim on a validated context (throws `forbidden`). */
export function requireClaim(ctx: TenantContext | PlatformContext, claim: string): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new OrganizationsError('invalid_context', 'context must be an object');
  }
  if ('tenantId' in ctx) {
    assertTenantContext(ctx);
  } else {
    assertPlatformContext(ctx);
  }
  if (!ctx.authority.includes(claim)) {
    throw new OrganizationsError('forbidden', `this operation requires the '${claim}' authority claim`);
  }
}
