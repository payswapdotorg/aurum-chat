// Unit tests for the pure logic of the organizations module: membership
// roles and their capability rules, slug derivation/validation, and the
// context gatekeepers (ADR-0001). No database, no migrations.

import { describe, expect, it } from 'vitest';
import {
  ORGANIZATIONS_AUTHORITY_PROVISION,
  assertPlatformContext,
  assertTenantContext,
  requireClaim,
} from '../access';
import { OrganizationsError } from '../errors';
import {
  TENANT_ROLES,
  WORKSPACE_ROLES,
  assertTenantRole,
  assertWorkspaceRole,
  canAssignTenantRole,
  canManageTenantMember,
  canManageWorkspace,
  canViewWorkspace,
  isTenantRole,
  isWorkspaceRole,
} from '../roles';
import { SLUG_MAX_LENGTH, deriveSlug, isValidSlug, normalizeSlug } from '../slug';
import type { TenantContext } from '@/infra/tenant';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';
const OTHER_UUID = '00000000-0000-4000-8000-000000000002';

function validCtx(): TenantContext {
  return { tenantId: VALID_UUID, principalId: OTHER_UUID, authority: [] };
}

describe('role vocabulary', () => {
  it('knows the tenant and workspace roles', () => {
    expect(TENANT_ROLES).toEqual(['owner', 'admin', 'member']);
    expect(WORKSPACE_ROLES).toEqual(['admin', 'member']);
    expect(isTenantRole('owner')).toBe(true);
    expect(isTenantRole('admin')).toBe(true);
    expect(isTenantRole('member')).toBe(true);
    expect(isTenantRole('root')).toBe(false);
    expect(isTenantRole(42)).toBe(false);
    expect(isWorkspaceRole('admin')).toBe(true);
    expect(isWorkspaceRole('member')).toBe(true);
    expect(isWorkspaceRole('owner')).toBe(false); // tenant-level role, not a workspace role
    expect(isWorkspaceRole(null)).toBe(false);
  });

  it('assertTenantRole/assertWorkspaceRole validate inputs with invalid_input', () => {
    expect(assertTenantRole('admin')).toBe('admin');
    expect(assertWorkspaceRole('member')).toBe('member');
    expect(() => assertTenantRole('superuser')).toThrowError(OrganizationsError);
    expect(() => assertTenantRole('superuser')).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    expect(() => assertWorkspaceRole('owner')).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    expect(() => assertWorkspaceRole(undefined)).toThrowError(OrganizationsError);
  });
});

describe('tenant role capabilities', () => {
  it('owners grant any tenant role; admins grant plain membership only', () => {
    for (const role of TENANT_ROLES) {
      expect(canAssignTenantRole('owner', role)).toBe(true);
    }
    expect(canAssignTenantRole('admin', 'member')).toBe(true);
    expect(canAssignTenantRole('admin', 'admin')).toBe(false);
    expect(canAssignTenantRole('admin', 'owner')).toBe(false);
    expect(canAssignTenantRole('member', 'member')).toBe(false);
    expect(canAssignTenantRole('member', 'admin')).toBe(false);
  });

  it('owners manage everyone; admins manage plain members only', () => {
    for (const target of TENANT_ROLES) {
      expect(canManageTenantMember('owner', target)).toBe(true);
    }
    expect(canManageTenantMember('admin', 'member')).toBe(true);
    expect(canManageTenantMember('admin', 'admin')).toBe(false);
    expect(canManageTenantMember('admin', 'owner')).toBe(false);
    expect(canManageTenantMember('member', 'member')).toBe(false);
  });
});

describe('workspace capabilities (layered under tenant authority)', () => {
  it('workspace admins and tenant owners/admins manage; others do not', () => {
    expect(canManageWorkspace('owner', null)).toBe(true);
    expect(canManageWorkspace('admin', null)).toBe(true);
    expect(canManageWorkspace('member', 'admin')).toBe(true);
    expect(canManageWorkspace('member', null)).toBe(false);
    expect(canManageWorkspace('member', 'member')).toBe(false);
    expect(canManageWorkspace(null, 'admin')).toBe(true);
    expect(canManageWorkspace(null, 'member')).toBe(false);
    expect(canManageWorkspace(null, null)).toBe(false);
  });

  it('any workspace member or tenant owner/admin can view', () => {
    expect(canViewWorkspace('owner', null)).toBe(true);
    expect(canViewWorkspace('admin', null)).toBe(true);
    expect(canViewWorkspace('member', 'member')).toBe(true);
    expect(canViewWorkspace('member', null)).toBe(false);
    expect(canViewWorkspace(null, 'member')).toBe(true);
    expect(canViewWorkspace(null, null)).toBe(false);
  });
});

describe('slug derivation', () => {
  it('normalizes messy names into valid slugs', () => {
    expect(normalizeSlug('  My--Workspace!!  ')).toBe('my-workspace');
    expect(normalizeSlug('Acme Corp')).toBe('acme-corp');
    expect(normalizeSlug('R&D / "labs"')).toBe('r-d-labs');
    expect(normalizeSlug('Élan')).toBe('lan'); // non-ascii is stripped, not transliterated
    expect(normalizeSlug('---___---')).toBe('');
    expect(normalizeSlug('a')).toBe('a');
  });

  it('caps length at SLUG_MAX_LENGTH without trailing dashes', () => {
    const long = `${'a'.repeat(40)}-${'b'.repeat(40)}-${'c'.repeat(40)}`;
    const normalized = normalizeSlug(long);
    expect(normalized.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(normalized.endsWith('-')).toBe(false);
    expect(isValidSlug(normalized)).toBe(true);
  });

  it('validates the slug shape strictly', () => {
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('acme-corp')).toBe(true);
    expect(isValidSlug('a'.repeat(63))).toBe(true);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('-acme')).toBe(false);
    expect(isValidSlug('acme-')).toBe(false);
    expect(isValidSlug('ac me')).toBe(false);
    expect(isValidSlug('a'.repeat(64))).toBe(false);
    expect(isValidSlug('acme--corp')).toBe(true); // normalize collapses, isValid only checks shape
  });

  it('derives slugs from names, or null when nothing usable remains', () => {
    expect(deriveSlug('Acme Corp')).toBe('acme-corp');
    expect(deriveSlug('Contoso LLC.')).toBe('contoso-llc');
    expect(deriveSlug('!?')).toBeNull();
    expect(deriveSlug('')).toBeNull();
    expect(deriveSlug('42')).toBe('42');
  });
});

describe('context gatekeepers (tenant context propagation, ADR-0001)', () => {
  it('accepts a well-formed TenantContext', () => {
    expect(() => assertTenantContext(validCtx())).not.toThrow();
  });

  it('rejects malformed TenantContext with invalid_context', () => {
    expect(() => assertTenantContext({ ...validCtx(), tenantId: 'not-a-uuid' })).toThrowError(
      expect.objectContaining({ code: 'invalid_context' }),
    );
    expect(() => assertTenantContext({ ...validCtx(), tenantId: '' })).toThrowError(
      OrganizationsError,
    );
    expect(() => assertTenantContext({ ...validCtx(), principalId: 'nope' })).toThrowError(
      OrganizationsError,
    );
    expect(() =>
      assertTenantContext({ ...validCtx(), principalId: 7 as unknown as string }),
    ).toThrowError(OrganizationsError);
    expect(() =>
      assertTenantContext({ ...validCtx(), authority: 'organizations:provision' as unknown as string[] }),
    ).toThrowError(OrganizationsError);
    expect(() =>
      assertTenantContext({ ...validCtx(), authority: ['ok', 5 as unknown as string] }),
    ).toThrowError(OrganizationsError);
    expect(() => assertTenantContext(null as unknown as TenantContext)).toThrowError(
      OrganizationsError,
    );
  });

  it('validates PlatformContext the same way (platform ops are explicit too)', () => {
    expect(() => assertPlatformContext({ principalId: VALID_UUID, authority: [] })).not.toThrow();
    expect(() => assertPlatformContext({ principalId: 'nope', authority: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid_context' }),
    );
    expect(() =>
      assertPlatformContext({ principalId: VALID_UUID, authority: null as unknown as string[] }),
    ).toThrowError(OrganizationsError);
  });

  it('requireClaim enforces exact claims with forbidden, after context validation', () => {
    const platform = { principalId: VALID_UUID, authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };
    expect(() => requireClaim(platform, ORGANIZATIONS_AUTHORITY_PROVISION)).not.toThrow();
    expect(() =>
      requireClaim({ principalId: VALID_UUID, authority: [] }, ORGANIZATIONS_AUTHORITY_PROVISION),
    ).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    // TenantContext-shaped input validates through the tenant path
    expect(() => requireClaim({ ...validCtx(), authority: ['some-claim'] }, 'some-claim')).not.toThrow();
    expect(() => requireClaim(validCtx(), 'some-claim')).toThrowError(
      expect.objectContaining({ code: 'forbidden' }),
    );
    // malformed context fails as invalid_context even before the claim check
    expect(() =>
      requireClaim({ tenantId: 'bad', principalId: 'bad', authority: [] }, 'x'),
    ).toThrowError(expect.objectContaining({ code: 'invalid_context' }));
  });
});

describe('typed errors', () => {
  it('carry a stable code and name', () => {
    const error = new OrganizationsError('workspace_not_found', 'gone');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('OrganizationsError');
    expect(error.code).toBe('workspace_not_found');
    expect(error.message).toBe('gone');
  });
});
