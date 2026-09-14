// Membership roles and the pure role-capability rules of the organizations
// module (W001 — "membership roles"). All logic here is pure: no db, no
// context — unit-testable in isolation.
//
// Tenant roles (power order owner > admin > member):
//   - owner  — root tenant authority: manages admins, members and owners
//              (a tenant always keeps at least one owner; the service layer
//              enforces the last-owner invariant on demotion/removal);
//   - admin  — manages plain members and workspaces;
//   - member — basic tenant access.
//
// Workspace roles (power order admin > member), layered under tenant
// authority: tenant owners/admins retain management authority over every
// workspace of their tenant, so removing a workspace's last admin never
// locks it. Workspace members must be tenant members (service invariant).

import { OrganizationsError } from './errors';
import type { TenantRole, WorkspaceRole } from './types';

export const TENANT_ROLES: readonly TenantRole[] = ['owner', 'admin', 'member'];
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'member'];

export function isTenantRole(value: unknown): value is TenantRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === 'admin' || value === 'member';
}

/** Validates an input tenant role (throws `invalid_input`). */
export function assertTenantRole(value: unknown): TenantRole {
  if (!isTenantRole(value)) {
    throw new OrganizationsError('invalid_input', `invalid tenant role '${String(value)}'`);
  }
  return value;
}

/** Validates an input workspace role (throws `invalid_input`). */
export function assertWorkspaceRole(value: unknown): WorkspaceRole {
  if (!isWorkspaceRole(value)) {
    throw new OrganizationsError('invalid_input', `invalid workspace role '${String(value)}'`);
  }
  return value;
}

/**
 * May `actorRole` grant `roleToAssign` (on add or role change)?
 * Owners grant any tenant role; admins grant plain membership only; plain
 * members grant nothing.
 */
export function canAssignTenantRole(actorRole: TenantRole, roleToAssign: TenantRole): boolean {
  return actorRole === 'owner' || (actorRole === 'admin' && roleToAssign === 'member');
}

/**
 * May `actorRole` manage (change/remove) a member currently holding
 * `targetRole`? Owners manage everyone; admins manage plain members only.
 */
export function canManageTenantMember(actorRole: TenantRole, targetRole: TenantRole): boolean {
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && targetRole === 'member';
}

/**
 * May the acting principal manage a workspace, given their tenant role and
 * (possibly absent) workspace role? Workspace admins and tenant
 * owners/admins can; plain members cannot.
 */
export function canManageWorkspace(
  tenantRole: TenantRole | null,
  workspaceRole: WorkspaceRole | null,
): boolean {
  return (
    workspaceRole === 'admin' ||
    tenantRole === 'owner' ||
    tenantRole === 'admin'
  );
}

/**
 * May the acting principal view a workspace (and its membership roster)?
 * Any workspace member or tenant owner/admin can.
 */
export function canViewWorkspace(
  tenantRole: TenantRole | null,
  workspaceRole: WorkspaceRole | null,
): boolean {
  return workspaceRole !== null || tenantRole === 'owner' || tenantRole === 'admin';
}
