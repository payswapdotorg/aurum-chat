// Typed errors of the organizations module. Consumers catch
// `OrganizationsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Isolation doctrine (ADR-0001, following the identity module): an id that
// belongs to another tenant is indistinguishable from a missing record
// (`tenant_not_found` / `workspace_not_found`), and a principal without
// membership in the calling tenant is likewise `tenant_not_found` — tenant
// existence and membership never leak through error differences.

export type OrganizationsErrorCode =
  /** Malformed TenantContext / PlatformContext. */
  | 'invalid_context'
  /** The acting principal's roles/claims do not allow the operation. */
  | 'forbidden'
  /** Malformed operation input (names, slugs, roles, uuid shapes). */
  | 'invalid_input'
  /** No tenant for this context (missing tenant, non-member principal, or another tenant's scope). */
  | 'tenant_not_found'
  /** The tenant slug is already taken (platform namespace). */
  | 'tenant_slug_taken'
  /** No such tenant member for this tenant. */
  | 'tenant_member_not_found'
  /** The principal is already a member of this tenant. */
  | 'tenant_member_exists'
  /** The principal is not a member of the calling tenant. */
  | 'not_a_tenant_member'
  /** The operation would leave the tenant without an owner. */
  | 'last_tenant_owner'
  /** No workspace for this id in the calling tenant (cross-tenant included). */
  | 'workspace_not_found'
  /** The workspace slug is already taken within the tenant. */
  | 'workspace_slug_taken'
  /** No such workspace member for this workspace. */
  | 'workspace_member_not_found'
  /** The principal is already a member of this workspace. */
  | 'workspace_member_exists';

export class OrganizationsError extends Error {
  constructor(
    public readonly code: OrganizationsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationsError';
  }
}
