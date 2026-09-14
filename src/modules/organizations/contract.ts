// ============================================================================
// organizations — the ONLY public surface of the organizations module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W001 — Tenant and Workspace (spec/work-items/WORK-ITEM-CATALOG.md):
// "Create tenant/workspace entities, membership roles, row/query isolation
//  and tenant context propagation. Verify cross-tenant reads/writes fail."
//
// ADR-0001 — Tenant Isolation and Workspace Authority. Aurum is a
// multi-tenant company workspace: tenant identity is mandatory context for
// every business operation and every information-bearing record; workspaces
// partition tenant experience without weakening isolation.
//
// Entities
//   * Tenant     — one company; the platform-level root of every
//                  tenant-scoped ownership chain (the `tenants` table is the
//                  platform table listed in scripts/arch-allowlist.json; all
//                  other tables of this module carry tenant_id).
//   * Workspace  — a tenant-scoped partition of experience; slugs are unique
//                  per tenant (independent namespaces).
//   * TenantMembership / WorkspaceMembership — a principal's membership with
//                  its role (principals are opaque uuids — TenantContext
//                  carries principalId; the auth module (later) owns
//                  principals, the people module (downstream per
//                  MODULE-DEPENDENCY-MAP: organizations → identity → people)
//                  owns persons, so membership rows deliberately carry no
//                  cross-module foreign key).
//
// Roles
//   Tenant:    owner > admin > member — owners grant any role and manage
//              everyone; admins manage plain members and workspaces; a
//              tenant always keeps ≥ 1 owner (last-owner invariant).
//   Workspace: admin > member — workspace admins manage their workspace;
//              tenant owners/admins retain authority over every workspace of
//              their tenant (so a workspace is never locked by losing its
//              last admin). Workspace members must be tenant members.
//
// Tenant context propagation (no ambient globals)
//   * Every tenant-scoped operation takes an explicit `TenantContext`
//     (tenant id + principal + authority claims) as its first argument,
//     validates its shape, proves the acting principal is a member of the
//     context tenant, and pins `tenant_id` in every SQL statement to
//     ctx.tenantId.
//   * `provisionTenant` is the one platform-level operation: it cannot carry
//     a TenantContext because the tenant does not exist yet, so it takes an
//     explicit `PlatformContext` requiring the `organizations:provision`
//     authority claim (ARCHITECTURE §3 — platform-level operations are
//     explicit).
//
// Row/query isolation (ADR-0001)
//   * Cross-tenant ids are indistinguishable from missing records:
//     `workspace_not_found` for workspaces, `tenant_not_found` otherwise —
//     no existence leaks. A principal without membership in the calling
//     tenant is also `tenant_not_found`.
//   * Writes resolve ownership before mutating: a foreign workspace id is
//     rejected before any INSERT/UPDATE runs; every DELETE/UPDATE filters
//     by ctx.tenantId; UNIQUE constraints backstop races.
//   * Authority claims NEVER bypass tenant scope: only membership roles
//     authorize tenant-scoped operations (claims gate the platform op
//     only). Interim model — W009 folds it into the authority matrix.
//
// Dependencies: none — organizations is the most upstream domain module
// (MODULE-DEPENDENCY-MAP.md L0); it imports only src/infra ports.
// ============================================================================

export {
  addTenantMember,
  addWorkspaceMember,
  changeTenantMemberRole,
  changeWorkspaceMemberRole,
  createWorkspace,
  getTenant,
  getTenantMembership,
  getWorkspace,
  getWorkspaceMembership,
  listTenantMembers,
  listWorkspaces,
  listWorkspaceMembers,
  provisionTenant,
  removeTenantMember,
  removeWorkspaceMember,
  updateTenant,
  updateWorkspace,
} from './service';

export { DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_SLUG } from './service';

export { OrganizationsError } from './errors';
export type { OrganizationsErrorCode } from './errors';

export {
  ORGANIZATIONS_AUTHORITY_PROVISION,
} from './access';

export { isTenantRole, isWorkspaceRole, TENANT_ROLES, WORKSPACE_ROLES } from './roles';

export type {
  AddTenantMemberInput,
  AddWorkspaceMemberInput,
  ChangeTenantMemberRoleInput,
  ChangeWorkspaceMemberRoleInput,
  CreateWorkspaceInput,
  GetTenantMembershipInput,
  GetWorkspaceMembershipInput,
  PlatformContext,
  ProvisionTenantInput,
  RemoveTenantMemberInput,
  RemoveWorkspaceMemberInput,
  Tenant,
  TenantMembership,
  TenantRole,
  UpdateTenantInput,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
} from './types';
