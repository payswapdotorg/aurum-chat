// Tenant-context validation and interim authority claims (ADR-0001).
//
// IMPLEMENTATION-STACK §8: every contract call receives an explicit
// TenantContext (tenant id + principal + authority claims) — never an
// ambient global. These helpers are the identity module's gatekeepers.
//
// The two authority claims below are this module's interim permission model:
// W009 (Policy and Action Authority) will fold them into the tenant-wide
// authority matrix; until then the claims are exact and explicit:
//   - identity:attest — grant (attest) or withdraw (revoke) account
//     verification, i.e. trust decisions;
//   - identity:link   — attach/detach identities to subjects, i.e.
//     association decisions.

import type { TenantContext } from '@/infra/tenant';
import { IdentityError } from './errors';

export const IDENTITY_AUTHORITY_ATTEST = 'identity:attest';
export const IDENTITY_AUTHORITY_LINK = 'identity:link';

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new IdentityError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new IdentityError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new IdentityError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** Requires an exact authority claim (throws `forbidden`). */
export function requireAuthority(ctx: TenantContext, claim: string): void {
  assertTenantContext(ctx);
  if (!ctx.authority.includes(claim)) {
    throw new IdentityError('forbidden', `this operation requires the '${claim}' authority claim`);
  }
}
