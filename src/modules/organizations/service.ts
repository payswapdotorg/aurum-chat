// Implementation of the organizations module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps are timestamptz written from the
// injectable clock; every statement on a tenant-scoped table pins
// `tenant_id` to the explicit TenantContext (ADR-0001) — cross-tenant access
// is indistinguishable from `tenant_not_found` / `workspace_not_found`.
//
// Row/query isolation doctrine (W001):
//   * `tenants` is the platform root table (allow-listed); tenant_members,
//     workspaces and workspace_members all carry tenant_id and every
//     SELECT/INSERT/UPDATE/DELETE below filters by ctx.tenantId;
//   * writes resolve ownership FIRST: a workspace id from another tenant
//     never reaches an INSERT or UPDATE (requireWorkspace scopes the lookup
//     to the calling tenant before any mutation runs);
//   * UNIQUE constraints are the race-proof backstop; Postgres 23505 is
//     translated into typed errors (same error shape on the PGlite and
//     node-postgres backends).
//
// Tenant context propagation: every tenant-scoped operation validates the
// context (assertTenantContext), proves the acting principal is a member of
// the context tenant (requireTenantScope) and then threads ctx.tenantId into
// every statement — no ambient state, ever.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  assertPlatformContext,
  assertTenantContext,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  requireClaim,
} from './access';
import { OrganizationsError } from './errors';
import {
  assertTenantRole,
  assertWorkspaceRole,
  canAssignTenantRole,
  canManageTenantMember,
  canManageWorkspace,
  canViewWorkspace,
} from './roles';
import { deriveSlug, isValidSlug, normalizeSlug } from './slug';
import type {
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

/** Name of the workspace provisioned together with a tenant. */
export const DEFAULT_WORKSPACE_NAME = 'Default';
/** Slug of the default workspace (unique within every tenant by construction). */
export const DEFAULT_WORKSPACE_SLUG = 'default';

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TenantRow extends DbRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TenantMemberRow extends DbRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  role: string;
  created_at: Date | string;
}

interface WorkspaceRow extends DbRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkspaceMemberRow extends DbRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  principal_id: string;
  role: string;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505' && candidate?.constraint === constraint;
}

function assertUuidInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new OrganizationsError('invalid_input', `${field} must be a uuid`);
  }
  return value;
}

function assertNameInput(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new OrganizationsError('invalid_input', `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new OrganizationsError(
      'invalid_input',
      `${field} must be 1–${NAME_MAX_LENGTH} characters after trimming`,
    );
  }
  return trimmed;
}

function assertDescriptionInput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new OrganizationsError('invalid_input', 'description must be a string or null');
  }
  const trimmed = value.trim();
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw new OrganizationsError(
      'invalid_input',
      `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the slug of a new tenant/workspace: an explicit slug is normalized
 * and must validate; otherwise one is derived from the name, and a name that
 * derives to nothing is an input error.
 */
function resolveSlugInput(name: string, slug: unknown): string {
  if (slug !== undefined && slug !== null) {
    if (typeof slug !== 'string') {
      throw new OrganizationsError('invalid_input', 'slug must be a string');
    }
    const normalized = normalizeSlug(slug);
    if (!isValidSlug(normalized)) {
      throw new OrganizationsError(
        'invalid_input',
        'slug must be 1–63 chars of lowercase letters, digits and inner dashes',
      );
    }
    return normalized;
  }
  const derived = deriveSlug(name);
  if (derived === null) {
    throw new OrganizationsError(
      'invalid_input',
      'the name cannot derive a slug; provide an explicit slug',
    );
  }
  return derived;
}

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapTenantMembership(row: TenantMemberRow): TenantMembership {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    role: assertTenantRole(row.role),
    createdAt: toIso(row.created_at),
  };
}

function mapWorkspaceMembership(row: WorkspaceMemberRow): WorkspaceMembership {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    role: assertWorkspaceRole(row.role),
    createdAt: toIso(row.created_at),
  };
}

interface TenantScope {
  tenant: TenantRow;
  memberRole: TenantRole;
}

/**
 * The gate every tenant-scoped operation passes: validate the explicit
 * context, prove the tenant exists, prove the acting principal is one of its
 * members. A missing tenant and a non-member principal are deliberately the
 * SAME error (`tenant_not_found`) so neither tenant existence nor membership
 * leaks through error differences (ADR-0001 — same doctrine as the identity
 * module's `identity_not_found`).
 */
async function requireTenantScope(ctx: TenantContext): Promise<TenantScope> {
  assertTenantContext(ctx);
  const db = getDb();
  const tenantRows = await db.query<TenantRow>(
    `SELECT id, name, slug, created_at, updated_at FROM tenants WHERE id = $1`,
    [ctx.tenantId],
  );
  const tenant = tenantRows.rows[0];
  if (tenant === undefined) {
    throw new OrganizationsError('tenant_not_found', 'no tenant for this context');
  }
  const memberRows = await db.query<TenantMemberRow>(
    `SELECT id, tenant_id, principal_id, role, created_at FROM tenant_members
       WHERE tenant_id = $1 AND principal_id = $2`,
    [ctx.tenantId, ctx.principalId],
  );
  const member = memberRows.rows[0];
  if (member === undefined) {
    throw new OrganizationsError(
      'tenant_not_found',
      'the acting principal is not a member of this tenant',
    );
  }
  return { tenant, memberRole: assertTenantRole(member.role) };
}

/**
 * Resolve a workspace id inside the calling tenant — cross-tenant ids are
 * indistinguishable from missing ones (`workspace_not_found`). Every
 * workspace mutation runs this BEFORE writing, so a foreign workspace id can
 * never reach an INSERT/UPDATE.
 */
async function requireWorkspace(ctx: TenantContext, workspaceId: unknown): Promise<WorkspaceRow> {
  const id = assertUuidInput(workspaceId, 'workspaceId');
  const rows = await getDb().query<WorkspaceRow>(
    `SELECT id, tenant_id, name, slug, description, created_by, created_at, updated_at
       FROM workspaces WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId],
  );
  const workspace = rows.rows[0];
  if (workspace === undefined) {
    throw new OrganizationsError(
      'workspace_not_found',
      'no workspace for this id in the calling tenant',
    );
  }
  return workspace;
}

/** The acting principal's workspace role in `workspaceId`, or null when not a member. */
async function workspaceRoleOf(
  ctx: TenantContext,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const rows = await getDb().query<WorkspaceMemberRow>(
    `SELECT id, tenant_id, workspace_id, principal_id, role, created_at FROM workspace_members
       WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3`,
    [ctx.tenantId, workspaceId, ctx.principalId],
  );
  const membership = rows.rows[0];
  return membership === undefined ? null : assertWorkspaceRole(membership.role);
}

// ---------------------------------------------------------------------------
// Platform-level operation
// ---------------------------------------------------------------------------

/**
 * Provision a tenant (platform operation — the one contract call that runs
 * before any tenant exists, hence an explicit PlatformContext carrying the
 * `organizations:provision` claim). Creates, atomically:
 *   1. the tenant row,
 *   2. its default workspace,
 *   3. the owner's tenant membership (role `owner`),
 *   4. the owner's membership of the default workspace (role `admin`).
 */
export async function provisionTenant(
  actor: PlatformContext,
  input: ProvisionTenantInput,
): Promise<Tenant> {
  assertPlatformContext(actor);
  requireClaim(actor, ORGANIZATIONS_AUTHORITY_PROVISION);
  if (input === null || typeof input !== 'object') {
    throw new OrganizationsError('invalid_input', 'input must be an object');
  }
  const name = assertNameInput(input.name, 'name');
  const ownerPrincipalId = assertUuidInput(input.ownerPrincipalId, 'ownerPrincipalId');
  const slug = resolveSlugInput(name, input.slug);
  const defaultWorkspaceName = assertNameInput(
    input.defaultWorkspaceName ?? DEFAULT_WORKSPACE_NAME,
    'defaultWorkspaceName',
  );
  const timestamp = now().toISOString();

  try {
    return await getDb().transaction(async (tx) => {
      const tenantRows = await tx.query<TenantRow>(
        `INSERT INTO tenants (name, slug, created_at, updated_at)
           VALUES ($1, $2, $3, $3)
           RETURNING id, name, slug, created_at, updated_at`,
        [name, slug, timestamp],
      );
      const tenantRow = tenantRows.rows[0]!;

      const workspaceRows = await tx.query<WorkspaceRow>(
        `INSERT INTO workspaces (tenant_id, name, slug, description, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, NULL, $4, $5, $5)
           RETURNING id, tenant_id, name, slug, description, created_by, created_at, updated_at`,
        [tenantRow.id, defaultWorkspaceName, DEFAULT_WORKSPACE_SLUG, ownerPrincipalId, timestamp],
      );
      const workspaceRow = workspaceRows.rows[0]!;

      await tx.query(
        `INSERT INTO tenant_members (tenant_id, principal_id, role, created_at)
           VALUES ($1, $2, 'owner', $3)`,
        [tenantRow.id, ownerPrincipalId, timestamp],
      );
      await tx.query(
        `INSERT INTO workspace_members (tenant_id, workspace_id, principal_id, role, created_at)
           VALUES ($1, $2, $3, 'admin', $4)`,
        [tenantRow.id, workspaceRow.id, ownerPrincipalId, timestamp],
      );
      return mapTenant(tenantRow);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'tenants_slug_unique')) {
      throw new OrganizationsError('tenant_slug_taken', `tenant slug '${slug}' is already taken`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tenant reads / writes
// ---------------------------------------------------------------------------

/** The calling principal's own tenant (requires any tenant membership). */
export async function getTenant(ctx: TenantContext): Promise<Tenant> {
  const scope = await requireTenantScope(ctx);
  return mapTenant(scope.tenant);
}

/** Rename the tenant (requires the tenant owner or admin role). */
export async function updateTenant(ctx: TenantContext, input: UpdateTenantInput): Promise<Tenant> {
  if (input === null || typeof input !== 'object' || input.name === undefined) {
    throw new OrganizationsError('invalid_input', 'updateTenant requires a name');
  }
  const scope = await requireTenantScope(ctx);
  if (scope.memberRole !== 'owner' && scope.memberRole !== 'admin') {
    throw new OrganizationsError('forbidden', 'updating the tenant requires the owner or admin role');
  }
  const name = assertNameInput(input.name, 'name');
  const rows = await getDb().query<TenantRow>(
    `UPDATE tenants SET name = $2, updated_at = $3 WHERE id = $1
       RETURNING id, name, slug, created_at, updated_at`,
    [ctx.tenantId, name, now().toISOString()],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OrganizationsError('tenant_not_found', 'no tenant for this context');
  }
  return mapTenant(row);
}

/** The full tenant roster (visible to any tenant member). */
export async function listTenantMembers(ctx: TenantContext): Promise<TenantMembership[]> {
  await requireTenantScope(ctx);
  const rows = await getDb().query<TenantMemberRow>(
    `SELECT id, tenant_id, principal_id, role, created_at FROM tenant_members
       WHERE tenant_id = $1 ORDER BY created_at, id`,
    [ctx.tenantId],
  );
  return rows.rows.map(mapTenantMembership);
}

/** One membership of the calling tenant (visible to any tenant member). */
export async function getTenantMembership(
  ctx: TenantContext,
  input: GetTenantMembershipInput,
): Promise<TenantMembership> {
  await requireTenantScope(ctx);
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const rows = await getDb().query<TenantMemberRow>(
    `SELECT id, tenant_id, principal_id, role, created_at FROM tenant_members
       WHERE tenant_id = $1 AND principal_id = $2`,
    [ctx.tenantId, principalId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OrganizationsError('tenant_member_not_found', 'no such member in this tenant');
  }
  return mapTenantMembership(row);
}

/**
 * Add a principal to the tenant roster. Owners grant any tenant role; admins
 * grant plain membership only.
 */
export async function addTenantMember(
  ctx: TenantContext,
  input: AddTenantMemberInput,
): Promise<TenantMembership> {
  const scope = await requireTenantScope(ctx);
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const role = assertTenantRole(input?.role);
  if (!canAssignTenantRole(scope.memberRole, role)) {
    throw new OrganizationsError(
      'forbidden',
      `the '${scope.memberRole}' role cannot grant the '${role}' tenant role`,
    );
  }
  const existing = await getDb().query<{ id: string }>(
    `SELECT id FROM tenant_members WHERE tenant_id = $1 AND principal_id = $2`,
    [ctx.tenantId, principalId],
  );
  if (existing.rows.length > 0) {
    throw new OrganizationsError('tenant_member_exists', 'the principal is already a member of this tenant');
  }
  try {
    const rows = await getDb().query<TenantMemberRow>(
      `INSERT INTO tenant_members (tenant_id, principal_id, role, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, principal_id, role, created_at`,
      [ctx.tenantId, principalId, role, now().toISOString()],
    );
    return mapTenantMembership(rows.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_members_unique')) {
      throw new OrganizationsError('tenant_member_exists', 'the principal is already a member of this tenant');
    }
    throw error;
  }
}

/** Change a tenant member's role (managers of the target's current role only). */
export async function changeTenantMemberRole(
  ctx: TenantContext,
  input: ChangeTenantMemberRoleInput,
): Promise<TenantMembership> {
  const scope = await requireTenantScope(ctx);
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const newRole = assertTenantRole(input?.role);
  const rows = await getDb().query<TenantMemberRow>(
    `SELECT id, tenant_id, principal_id, role, created_at FROM tenant_members
       WHERE tenant_id = $1 AND principal_id = $2`,
    [ctx.tenantId, principalId],
  );
  const target = rows.rows[0];
  if (target === undefined) {
    throw new OrganizationsError('tenant_member_not_found', 'no such member in this tenant');
  }
  const currentRole = assertTenantRole(target.role);
  if (currentRole === newRole) {
    throw new OrganizationsError('invalid_input', `the member already has the '${newRole}' role`);
  }
  if (!canManageTenantMember(scope.memberRole, currentRole) || !canAssignTenantRole(scope.memberRole, newRole)) {
    throw new OrganizationsError(
      'forbidden',
      `the '${scope.memberRole}' role cannot change a '${currentRole}' member to '${newRole}'`,
    );
  }
  if (currentRole === 'owner' && newRole !== 'owner') {
    const owners = await getDb().query<{ count: string }>(
      `SELECT count(*) AS count FROM tenant_members WHERE tenant_id = $1 AND role = 'owner'`,
      [ctx.tenantId],
    );
    if (Number(owners.rows[0]?.count ?? '0') <= 1) {
      throw new OrganizationsError('last_tenant_owner', 'a tenant must keep at least one owner');
    }
  }
  const updated = await getDb().query<TenantMemberRow>(
    `UPDATE tenant_members SET role = $3 WHERE tenant_id = $1 AND principal_id = $2
       RETURNING id, tenant_id, principal_id, role, created_at`,
    [ctx.tenantId, principalId, newRole],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new OrganizationsError('tenant_member_not_found', 'no such member in this tenant');
  }
  return mapTenantMembership(row);
}

/**
 * Remove a principal from the tenant — their workspace memberships inside
 * this tenant end with the tenant membership (single transaction). A tenant
 * always keeps at least one owner.
 */
export async function removeTenantMember(
  ctx: TenantContext,
  input: RemoveTenantMemberInput,
): Promise<void> {
  const scope = await requireTenantScope(ctx);
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const rows = await getDb().query<TenantMemberRow>(
    `SELECT id, tenant_id, principal_id, role, created_at FROM tenant_members
       WHERE tenant_id = $1 AND principal_id = $2`,
    [ctx.tenantId, principalId],
  );
  const target = rows.rows[0];
  if (target === undefined) {
    throw new OrganizationsError('tenant_member_not_found', 'no such member in this tenant');
  }
  const targetRole = assertTenantRole(target.role);
  if (!canManageTenantMember(scope.memberRole, targetRole)) {
    throw new OrganizationsError(
      'forbidden',
      `the '${scope.memberRole}' role cannot remove a '${targetRole}' member`,
    );
  }
  if (targetRole === 'owner') {
    const owners = await getDb().query<{ count: string }>(
      `SELECT count(*) AS count FROM tenant_members WHERE tenant_id = $1 AND role = 'owner'`,
      [ctx.tenantId],
    );
    if (Number(owners.rows[0]?.count ?? '0') <= 1) {
      throw new OrganizationsError('last_tenant_owner', 'a tenant must keep at least one owner');
    }
  }
  await getDb().transaction(async (tx) => {
    const removed = await tx.query(
      `DELETE FROM tenant_members WHERE tenant_id = $1 AND principal_id = $2`,
      [ctx.tenantId, principalId],
    );
    if ((removed.rowCount ?? 0) === 0) {
      throw new OrganizationsError('tenant_member_not_found', 'no such member in this tenant');
    }
    await tx.query(`DELETE FROM workspace_members WHERE tenant_id = $1 AND principal_id = $2`, [
      ctx.tenantId,
      principalId,
    ]);
  });
}

// ---------------------------------------------------------------------------
// Workspace reads / writes
// ---------------------------------------------------------------------------

/**
 * Create a workspace (tenant owner/admin only). The workspace slug is unique
 * within the tenant; the creating principal joins as the workspace's first
 * admin. Creation is one transaction (workspace + creator membership).
 */
export async function createWorkspace(
  ctx: TenantContext,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const scope = await requireTenantScope(ctx);
  if (scope.memberRole !== 'owner' && scope.memberRole !== 'admin') {
    throw new OrganizationsError('forbidden', 'creating a workspace requires the owner or admin tenant role');
  }
  const name = assertNameInput(input?.name, 'name');
  const slug = resolveSlugInput(name, input?.slug);
  const description = assertDescriptionInput(input?.description);
  const timestamp = now().toISOString();

  try {
    return await getDb().transaction(async (tx) => {
      const workspaceRows = await tx.query<WorkspaceRow>(
        `INSERT INTO workspaces (tenant_id, name, slug, description, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING id, tenant_id, name, slug, description, created_by, created_at, updated_at`,
        [ctx.tenantId, name, slug, description, ctx.principalId, timestamp],
      );
      const workspace = workspaceRows.rows[0]!;
      await tx.query(
        `INSERT INTO workspace_members (tenant_id, workspace_id, principal_id, role, created_at)
           VALUES ($1, $2, $3, 'admin', $4)`,
        [ctx.tenantId, workspace.id, ctx.principalId, timestamp],
      );
      return mapWorkspace(workspace);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'workspaces_tenant_slug_unique')) {
      throw new OrganizationsError(
        'workspace_slug_taken',
        `workspace slug '${slug}' is already taken in this tenant`,
      );
    }
    throw error;
  }
}

/**
 * Read one workspace. Visible to its members and to tenant owners/admins;
 * a workspace id from another tenant is `workspace_not_found`.
 */
export async function getWorkspace(ctx: TenantContext, workspaceId: string): Promise<Workspace> {
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canViewWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'viewing this workspace requires membership or the tenant owner/admin role',
    );
  }
  return mapWorkspace(workspace);
}

/**
 * Rename / re-describe a workspace. Manageable by workspace admins and by
 * tenant owners/admins (even when they are not workspace members). The
 * description key replaces the stored value (null clears it); an absent key
 * leaves it untouched.
 */
export async function updateWorkspace(
  ctx: TenantContext,
  input: UpdateWorkspaceInput,
): Promise<Workspace> {
  if (input === null || typeof input !== 'object') {
    throw new OrganizationsError('invalid_input', 'input must be an object');
  }
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, input.workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canManageWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'updating this workspace requires the workspace admin or tenant owner/admin role',
    );
  }
  const hasName = input.name !== undefined;
  const hasDescription = input.description !== undefined;
  if (!hasName && !hasDescription) {
    throw new OrganizationsError('invalid_input', 'updateWorkspace requires a name and/or description');
  }
  const name = hasName ? assertNameInput(input.name, 'name') : null;
  const description = hasDescription ? assertDescriptionInput(input.description) : null;
  const timestamp = now().toISOString();
  const rows = hasDescription
    ? await getDb().query<WorkspaceRow>(
        `UPDATE workspaces SET name = COALESCE($2, name), description = $3, updated_at = $4
           WHERE id = $1 AND tenant_id = $5
           RETURNING id, tenant_id, name, slug, description, created_by, created_at, updated_at`,
        [workspace.id, name, description, timestamp, ctx.tenantId],
      )
    : await getDb().query<WorkspaceRow>(
        `UPDATE workspaces SET name = COALESCE($2, name), updated_at = $3
           WHERE id = $1 AND tenant_id = $4
           RETURNING id, tenant_id, name, slug, description, created_by, created_at, updated_at`,
        [workspace.id, name, timestamp, ctx.tenantId],
      );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OrganizationsError('workspace_not_found', 'no workspace for this id in the calling tenant');
  }
  return mapWorkspace(row);
}

/**
 * The calling tenant's workspaces. Owners/admins see all of them; plain
 * members see only the workspaces they belong to (row-level scoping by
 * membership — ADR-0001 "workspaces partition tenant experience").
 */
export async function listWorkspaces(ctx: TenantContext): Promise<Workspace[]> {
  const scope = await requireTenantScope(ctx);
  const db = getDb();
  const rows =
    scope.memberRole === 'owner' || scope.memberRole === 'admin'
      ? await db.query<WorkspaceRow>(
          `SELECT id, tenant_id, name, slug, description, created_by, created_at, updated_at
             FROM workspaces WHERE tenant_id = $1 ORDER BY created_at, id`,
          [ctx.tenantId],
        )
      : await db.query<WorkspaceRow>(
          `SELECT w.id, w.tenant_id, w.name, w.slug, w.description, w.created_by, w.created_at, w.updated_at
             FROM workspaces w
             WHERE w.tenant_id = $1
               AND EXISTS (
                 SELECT 1 FROM workspace_members m
                   WHERE m.tenant_id = $1 AND m.workspace_id = w.id AND m.principal_id = $2
               )
             ORDER BY w.created_at, w.id`,
          [ctx.tenantId, ctx.principalId],
        );
  return rows.rows.map(mapWorkspace);
}

/** The workspace's membership roster (same visibility as the workspace). */
export async function listWorkspaceMembers(
  ctx: TenantContext,
  workspaceId: string,
): Promise<WorkspaceMembership[]> {
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canViewWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'viewing this workspace requires membership or the tenant owner/admin role',
    );
  }
  const rows = await getDb().query<WorkspaceMemberRow>(
    `SELECT id, tenant_id, workspace_id, principal_id, role, created_at FROM workspace_members
       WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY created_at, id`,
    [ctx.tenantId, workspace.id],
  );
  return rows.rows.map(mapWorkspaceMembership);
}

/** One workspace membership (same visibility as the workspace). */
export async function getWorkspaceMembership(
  ctx: TenantContext,
  input: GetWorkspaceMembershipInput,
): Promise<WorkspaceMembership> {
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, input?.workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canViewWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'viewing this workspace requires membership or the tenant owner/admin role',
    );
  }
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const rows = await getDb().query<WorkspaceMemberRow>(
    `SELECT id, tenant_id, workspace_id, principal_id, role, created_at FROM workspace_members
       WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3`,
    [ctx.tenantId, workspace.id, principalId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OrganizationsError('workspace_member_not_found', 'no such member in this workspace');
  }
  return mapWorkspaceMembership(row);
}

/**
 * Add a principal to a workspace. Manageable by workspace admins and tenant
 * owners/admins. Workspace members must first be members of the tenant.
 */
export async function addWorkspaceMember(
  ctx: TenantContext,
  input: AddWorkspaceMemberInput,
): Promise<WorkspaceMembership> {
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, input?.workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canManageWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'managing this workspace requires the workspace admin or tenant owner/admin role',
    );
  }
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const role = assertWorkspaceRole(input?.role);
  const tenantMembership = await getDb().query<{ id: string }>(
    `SELECT id FROM tenant_members WHERE tenant_id = $1 AND principal_id = $2`,
    [ctx.tenantId, principalId],
  );
  if (tenantMembership.rows.length === 0) {
    throw new OrganizationsError(
      'not_a_tenant_member',
      'workspace members must be members of the tenant',
    );
  }
  const existing = await getDb().query<{ id: string }>(
    `SELECT id FROM workspace_members WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3`,
    [ctx.tenantId, workspace.id, principalId],
  );
  if (existing.rows.length > 0) {
    throw new OrganizationsError('workspace_member_exists', 'the principal is already a member of this workspace');
  }
  try {
    const rows = await getDb().query<WorkspaceMemberRow>(
      `INSERT INTO workspace_members (tenant_id, workspace_id, principal_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, workspace_id, principal_id, role, created_at`,
      [ctx.tenantId, workspace.id, principalId, role, now().toISOString()],
    );
    return mapWorkspaceMembership(rows.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error, 'workspace_members_unique')) {
      throw new OrganizationsError('workspace_member_exists', 'the principal is already a member of this workspace');
    }
    throw error;
  }
}

/** Change a workspace member's role (workspace admins / tenant owners+admins). */
export async function changeWorkspaceMemberRole(
  ctx: TenantContext,
  input: ChangeWorkspaceMemberRoleInput,
): Promise<WorkspaceMembership> {
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, input?.workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canManageWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'managing this workspace requires the workspace admin or tenant owner/admin role',
    );
  }
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const newRole = assertWorkspaceRole(input?.role);
  const rows = await getDb().query<WorkspaceMemberRow>(
    `SELECT id, tenant_id, workspace_id, principal_id, role, created_at FROM workspace_members
       WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3`,
    [ctx.tenantId, workspace.id, principalId],
  );
  const target = rows.rows[0];
  if (target === undefined) {
    throw new OrganizationsError('workspace_member_not_found', 'no such member in this workspace');
  }
  if (assertWorkspaceRole(target.role) === newRole) {
    throw new OrganizationsError('invalid_input', `the member already has the '${newRole}' role`);
  }
  const updated = await getDb().query<WorkspaceMemberRow>(
    `UPDATE workspace_members SET role = $4 WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3
       RETURNING id, tenant_id, workspace_id, principal_id, role, created_at`,
    [ctx.tenantId, workspace.id, principalId, newRole],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new OrganizationsError('workspace_member_not_found', 'no such member in this workspace');
  }
  return mapWorkspaceMembership(row);
}

/**
 * Remove a workspace member (workspace admins / tenant owners+admins).
 * Removing the last workspace admin is allowed: tenant owners/admins retain
 * management authority, so the workspace is never locked.
 */
export async function removeWorkspaceMember(
  ctx: TenantContext,
  input: RemoveWorkspaceMemberInput,
): Promise<void> {
  const scope = await requireTenantScope(ctx);
  const workspace = await requireWorkspace(ctx, input?.workspaceId);
  const workspaceRole = await workspaceRoleOf(ctx, workspace.id);
  if (!canManageWorkspace(scope.memberRole, workspaceRole)) {
    throw new OrganizationsError(
      'forbidden',
      'managing this workspace requires the workspace admin or tenant owner/admin role',
    );
  }
  const principalId = assertUuidInput(input?.principalId, 'principalId');
  const existing = await getDb().query<{ id: string }>(
    `SELECT id FROM workspace_members WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3`,
    [ctx.tenantId, workspace.id, principalId],
  );
  if (existing.rows.length === 0) {
    throw new OrganizationsError('workspace_member_not_found', 'no such member in this workspace');
  }
  const removed = await getDb().query(
    `DELETE FROM workspace_members WHERE tenant_id = $1 AND workspace_id = $2 AND principal_id = $3`,
    [ctx.tenantId, workspace.id, principalId],
  );
  if ((removed.rowCount ?? 0) === 0) {
    throw new OrganizationsError('workspace_member_not_found', 'no such member in this workspace');
  }
}
