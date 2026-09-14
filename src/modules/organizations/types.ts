// Domain types of the organizations module (W001 — Tenant and Workspace).
//
// These types are the module's data vocabulary: tenants (companies, the
// platform-level roots of every tenant-scoped chain), workspaces (tenant
// experience partitions, ADR-0001), and the memberships that carry roles.
// Persistence shape (snake_case rows) is private to the service; contract
// consumers only ever see the camelCase entities below.

/** Roles a principal may hold in a tenant (power order: owner > admin > member). */
export type TenantRole = 'owner' | 'admin' | 'member';

/** Roles a principal may hold in a workspace (power order: admin > member). */
export type WorkspaceRole = 'admin' | 'member';

/** A tenant — one company. The platform-level root of tenant ownership chains. */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A workspace — a partition of one tenant's experience (ADR-0001: workspaces
 * never weaken tenant isolation; every row is directly tenant-scoped).
 */
export interface Workspace {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A principal's membership in a tenant, with its role. */
export interface TenantMembership {
  id: string;
  tenantId: string;
  principalId: string;
  role: TenantRole;
  createdAt: string;
}

/** A principal's membership in a workspace, with its role. */
export interface WorkspaceMembership {
  id: string;
  tenantId: string;
  workspaceId: string;
  principalId: string;
  role: WorkspaceRole;
  createdAt: string;
}

/**
 * Context for platform-level operations — the explicit actor context for the
 * one operation that cannot carry a TenantContext because the tenant does
 * not exist yet (ADR-0001: platform-level operations are explicit; no
 * ambient globals).
 */
export interface PlatformContext {
  principalId: string;
  authority: string[];
}

/** Provision a tenant: platform operation, creates the first owner member. */
export interface ProvisionTenantInput {
  name: string;
  /** Defaults to a slug derived from `name`. */
  slug?: string;
  /** The principal that becomes the tenant's first `owner` member. */
  ownerPrincipalId: string;
  /** Name of the default workspace created with the tenant. */
  defaultWorkspaceName?: string;
}

export interface UpdateTenantInput {
  name: string;
}

export interface CreateWorkspaceInput {
  name: string;
  /** Defaults to a slug derived from `name`; unique within the tenant. */
  slug?: string;
  description?: string | null;
}

export interface UpdateWorkspaceInput {
  workspaceId: string;
  /** When present (even null) the description is replaced; absent = untouched. */
  name?: string;
  description?: string | null;
}

export interface AddTenantMemberInput {
  principalId: string;
  role: TenantRole;
}

export interface ChangeTenantMemberRoleInput {
  principalId: string;
  role: TenantRole;
}

export interface RemoveTenantMemberInput {
  principalId: string;
}

export interface AddWorkspaceMemberInput {
  workspaceId: string;
  principalId: string;
  role: WorkspaceRole;
}

export interface ChangeWorkspaceMemberRoleInput {
  workspaceId: string;
  principalId: string;
  role: WorkspaceRole;
}

export interface RemoveWorkspaceMemberInput {
  workspaceId: string;
  principalId: string;
}

export interface GetTenantMembershipInput {
  principalId: string;
}

export interface GetWorkspaceMembershipInput {
  workspaceId: string;
  principalId: string;
}
