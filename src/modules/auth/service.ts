// Implementation of the auth module's public operations (see contract.ts).
//
// W058 — Authentication, Sessions & Tenant Onboarding:
//   * sign-in / sign-up / sign-out / session resolution & renewal;
//   * company (tenant) creation and selection, workspace selection;
//   * membership invitations (issue / list / revoke / inspect / accept);
//   * the ready-made TenantContext a session resolves to.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL through the db port
// with $n placeholders; uuids minted by PostgreSQL; timestamps written
// from the injectable clock; tokens stored ONLY as sha-256 hashes; every
// organizations interaction goes through its contract (never its tables).
//
// Scope safety (the W058 acceptance core):
//   * a session's active company/workspace is NAVIGATION state — before
//     any TenantContext is handed out, membership is re-verified LIVE
//     through organizations.getTenant/getTenantMembership (ADR-0001: a
//     removed member's session degrades to "no active company", never to
//     data access);
//   * switching to a company the principal is not a member of fails as
//     `tenant_unavailable` (organizations makes "no such tenant" and "not
//     a member" indistinguishable on purpose — no existence leak);
//   * acceptance grants run through organizations.addTenantMember with the
//     INVITER's context, so the organizations contract re-checks the
//     inviter's CURRENT authority at acceptance time (an invitation can
//     never outlive its inviter's role).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  addTenantMember,
  addWorkspaceMember,
  DEFAULT_WORKSPACE_SLUG,
  getTenant,
  getTenantMembership,
  getWorkspace,
  listWorkspaces,
  OrganizationsError,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
} from '@/modules/organizations/contract';
import type { Tenant, TenantRole, Workspace, WorkspaceRole } from '@/modules/organizations/contract';
import { sessionAuthorityForRole } from './authority';
import { AuthError } from './errors';
import { hashPassword, verifyPassword } from './passwords';
import { hashToken, mintToken } from './tokens';
import type {
  AcceptInvitationInput,
  AcceptInvitationResult,
  ActiveTenant,
  ActiveWorkspace,
  AuthPrincipal,
  CreateCompanyInput,
  CreatedInvitation,
  CreateInvitationInput,
  InspectedInvitation,
  InvitationRecord,
  InvitationStatus,
  ReachableTenant,
  ResolvedSession,
  RevokeInvitationInput,
  SessionResolution,
  SignInInput,
  SignInResult,
  SignUpInput,
  SwitchTenantInput,
  SelectWorkspaceInput,
} from './types';
import {
  assertCompanyName,
  assertDisplayName,
  assertEmail,
  assertObject,
  assertPassword,
  assertToken,
  assertUuidInput,
} from './validation';

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

/** Session lifetime (14 days). */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A session auto-renews (sliding) once less than this remains. */
export const SESSION_RENEWAL_WINDOW_MS = SESSION_TTL_MS / 2;
/** Invitation lifetime (7 days). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface PrincipalRow extends DbRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionRow extends DbRow {
  id: string;
  principal_id: string;
  token_hash: string;
  active_tenant_id: string | null;
  active_workspace_id: string | null;
  created_at: Date | string;
  last_renewed_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_user_agent: string | null;
}

interface ActivationRow extends DbRow {
  principal_id: string;
  tenant_id: string;
  activated_at: Date | string;
  last_workspace_id: string | null;
}

interface InvitationRow extends DbRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  tenant_name: string;
  email: string;
  tenant_role: string;
  workspace_role: string | null;
  token_hash: string;
  invited_by: string;
  created_at: Date | string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  accepted_principal_id: string | null;
  revoked_at: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapPrincipal(row: PrincipalRow): AuthPrincipal {
  const status = row.status === 'disabled' ? 'disabled' : 'active';
  return { id: row.id, email: row.email, displayName: row.display_name, status };
}

function invitationStatus(row: InvitationRow, at: Date): InvitationStatus {
  if (row.accepted_at !== null) return 'accepted';
  if (row.revoked_at !== null) return 'revoked';
  if (toDate(row.expires_at).getTime() <= at.getTime()) return 'expired';
  return 'pending';
}

function mapInvitation(row: InvitationRow, at: Date): InvitationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    email: row.email,
    tenantRole: row.tenant_role as TenantRole,
    workspaceId: row.workspace_id,
    workspaceRole: row.workspace_role === null ? null : (row.workspace_role as WorkspaceRole),
    invitedBy: row.invited_by,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    acceptedAt: row.accepted_at === null ? null : toIso(row.accepted_at),
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    status: invitationStatus(row, at),
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505' && candidate?.constraint === constraint;
}

/** Translate organizations' no-existence-leak failures into auth's vocabulary. */
function isOrganizationsCode(error: unknown, code: string): boolean {
  return error instanceof OrganizationsError && error.code === code;
}

// ---------------------------------------------------------------------------
// Session plumbing
// ---------------------------------------------------------------------------

interface ValidSession {
  principal: PrincipalRow;
  session: SessionRow;
}

/** The joined row requireValidSession selects (distinct aliases — no collisions). */
interface SessionWithPrincipalRow extends DbRow {
  session_id: string;
  principal_id: string;
  active_tenant_id: string | null;
  active_workspace_id: string | null;
  session_created_at: Date | string;
  last_renewed_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_user_agent: string | null;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  principal_created_at: Date | string;
  principal_updated_at: Date | string;
}

/** Load the live session a token names (throws unauthorized/expired/disabled). */
async function requireValidSession(token: unknown): Promise<ValidSession> {
  const raw = assertToken(token);
  const rows = await getDb().query<SessionWithPrincipalRow>(
    `SELECT s.id AS session_id, s.principal_id, s.active_tenant_id, s.active_workspace_id,
            s.created_at AS session_created_at, s.last_renewed_at, s.last_seen_at, s.expires_at,
            s.revoked_at, s.created_user_agent,
            p.email, p.display_name, p.password_hash, p.status,
            p.created_at AS principal_created_at, p.updated_at AS principal_updated_at
       FROM auth_sessions s
       JOIN auth_principals p ON p.id = s.principal_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    [hashToken(raw)],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AuthError('unauthorized', 'no session for this token');
  }
  if (row.status === 'disabled') {
    throw new AuthError('principal_disabled', 'this account is disabled');
  }
  if (toDate(row.expires_at).getTime() <= now().getTime()) {
    throw new AuthError('session_expired', 'this session has expired — sign in again');
  }
  const principal: PrincipalRow = {
    id: row.principal_id,
    email: row.email,
    display_name: row.display_name,
    password_hash: row.password_hash,
    status: row.status,
    created_at: row.principal_created_at,
    updated_at: row.principal_updated_at,
  };
  const session: SessionRow = {
    id: row.session_id,
    principal_id: row.principal_id,
    token_hash: '', // not needed past the lookup; never let it leak further
    active_tenant_id: row.active_tenant_id,
    active_workspace_id: row.active_workspace_id,
    created_at: row.session_created_at,
    last_renewed_at: row.last_renewed_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_user_agent: row.created_user_agent,
  };
  return { principal, session };
}

/**
 * The live-verified tenant + role of a principal, through the organizations
 * contract only. Returns null when the principal is not (or no longer) a
 * member — the caller treats that as "no active company", never as data
 * access (ADR-0001).
 */
async function verifyTenant(
  tenantId: string,
  principalId: string,
): Promise<{ tenant: Tenant; role: TenantRole } | null> {
  const ctx: TenantContext = { tenantId, principalId, authority: [] };
  try {
    const tenant = await getTenant(ctx);
    const membership = await getTenantMembership(ctx, { principalId });
    return { tenant, role: membership.role };
  } catch (error) {
    if (isOrganizationsCode(error, 'tenant_not_found')) return null;
    throw error;
  }
}

/** The live-verified workspace, or null when it is gone/not visible. */
async function verifyWorkspace(
  tenantId: string,
  principalId: string,
  workspaceId: string,
): Promise<Workspace | null> {
  const ctx: TenantContext = { tenantId, principalId, authority: [] };
  try {
    return await getWorkspace(ctx, workspaceId);
  } catch (error) {
    if (
      isOrganizationsCode(error, 'workspace_not_found') ||
      isOrganizationsCode(error, 'tenant_not_found') ||
      isOrganizationsCode(error, 'forbidden')
    ) {
      return null;
    }
    throw error;
  }
}

/** Record (or refresh) a principal's activation of a company. */
async function upsertActivation(
  principalId: string,
  tenantId: string,
  workspaceId: string | null,
): Promise<void> {
  const timestamp = now().toISOString();
  await getDb().query(
    `INSERT INTO auth_principal_tenants (principal_id, tenant_id, activated_at, last_workspace_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal_id, tenant_id)
       DO UPDATE SET activated_at = $3, last_workspace_id = $4`,
    [principalId, tenantId, timestamp, workspaceId],
  );
}

/** Point a session at a company (and optionally a workspace). */
async function setSessionScope(
  sessionId: string,
  tenantId: string,
  workspaceId: string | null,
): Promise<void> {
  await getDb().query(
    `UPDATE auth_sessions SET active_tenant_id = $2, active_workspace_id = $3
       WHERE id = $1`,
    [sessionId, tenantId, workspaceId],
  );
}

/** Mint and persist a session row; the raw token is returned exactly once. */
async function openSession(
  principalId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: string; sessionId: string }> {
  const token = mintToken();
  const at = now();
  const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);
  const rows = await getDb().query<{ id: string }>(
    `INSERT INTO auth_sessions
       (principal_id, token_hash, active_tenant_id, active_workspace_id,
        created_at, last_renewed_at, last_seen_at, expires_at, revoked_at, created_user_agent)
       VALUES ($1, $2, NULL, NULL, $3, $3, $3, $4, NULL, $5)
       RETURNING id`,
    [principalId, hashToken(token), at.toISOString(), expiresAt.toISOString(), userAgent],
  );
  return { token, expiresAt: expiresAt.toISOString(), sessionId: rows.rows[0]!.id };
}

/**
 * Preselect the most recently activated company on a brand-new session —
 * verified live, so a revoked membership simply leaves the session
 * unscoped (the product then shows onboarding, never data).
 */
async function preselectLastTenant(
  sessionId: string,
  principalId: string,
): Promise<void> {
  const rows = await getDb().query<ActivationRow>(
    `SELECT principal_id, tenant_id, activated_at, last_workspace_id
       FROM auth_principal_tenants WHERE principal_id = $1
       ORDER BY activated_at DESC, tenant_id LIMIT 1`,
    [principalId],
  );
  const latest = rows.rows[0];
  if (latest === undefined) return;
  const verified = await verifyTenant(latest.tenant_id, principalId);
  if (verified === null) return;
  let workspaceId: string | null = null;
  if (latest.last_workspace_id !== null) {
    const workspace = await verifyWorkspace(
      latest.tenant_id,
      principalId,
      latest.last_workspace_id,
    );
    workspaceId = workspace === null ? null : workspace.id;
  }
  await setSessionScope(sessionId, verified.tenant.id, workspaceId);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Create an account and its first session (the raw token appears once). */
export async function signUp(input: SignUpInput): Promise<SignInResult> {
  const record = assertObject(input, 'input');
  const email = assertEmail(record['email']);
  const password = assertPassword(record['password']);
  const displayName = assertDisplayName(record['displayName']);

  const existing = await getDb().query<{ id: string }>(
    `SELECT id FROM auth_principals WHERE email = $1`,
    [email],
  );
  if (existing.rows.length > 0) {
    throw new AuthError('email_taken', 'an account with this email already exists');
  }
  const passwordHash = await hashPassword(password);
  const timestamp = now().toISOString();
  let principalId: string;
  try {
    const inserted = await getDb().query<{ id: string }>(
      `INSERT INTO auth_principals (email, display_name, password_hash, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $4)
         RETURNING id`,
      [email, displayName, passwordHash, timestamp],
    );
    principalId = inserted.rows[0]!.id;
  } catch (error) {
    if (isUniqueViolation(error, 'auth_principals_email_unique')) {
      throw new AuthError('email_taken', 'an account with this email already exists');
    }
    throw error;
  }
  const session = await openSession(principalId, null);
  const principal: AuthPrincipal = { id: principalId, email, displayName, status: 'active' };
  return { principal, token: session.token, expiresAt: session.expiresAt };
}

/**
 * Verify credentials and open a session. Unknown email and wrong password
 * are the SAME error (`invalid_credentials`) — no account enumeration.
 */
export async function signIn(input: SignInInput): Promise<SignInResult> {
  const record = assertObject(input, 'input');
  const email = assertEmail(record['email']);
  const password = assertPassword(record['password']);

  const rows = await getDb().query<PrincipalRow>(
    `SELECT id, email, display_name, password_hash, status, created_at, updated_at
       FROM auth_principals WHERE email = $1`,
    [email],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    // Equalize the work so timing does not reveal account existence.
    await verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
    throw new AuthError('invalid_credentials', 'email or password is incorrect');
  }
  if (row.status === 'disabled') {
    throw new AuthError('principal_disabled', 'this account is disabled');
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    throw new AuthError('invalid_credentials', 'email or password is incorrect');
  }
  const session = await openSession(row.id, null);
  await preselectLastTenant(session.sessionId, row.id);
  return {
    principal: mapPrincipal(row),
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/** Revoke one session (idempotent). */
export async function signOut(token: unknown): Promise<void> {
  const raw = assertToken(token);
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(raw), now().toISOString()],
  );
}

/** Revoke every session of the token's principal (idempotent). */
export async function signOutEverywhere(token: unknown): Promise<void> {
  const { principal } = await requireValidSession(token);
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $2
       WHERE principal_id = $1 AND revoked_at IS NULL`,
    [principal.id, now().toISOString()],
  );
}

// ---------------------------------------------------------------------------
// Session resolution & renewal
// ---------------------------------------------------------------------------

/**
 * Resolve a token into the full session state: principal, session facts,
 * and — when the session carries an active company — the LIVE-VERIFIED
 * tenant/workspace plus the ready-made TenantContext (authority derived
 * from the verified role, never from client input).
 *
 * Sliding renewal: a session past half its lifetime is renewed on
 * resolution (the "session renewal" acceptance); every resolution also
 * refreshes last_seen_at.
 */
export async function resolveSession(token: unknown): Promise<SessionResolution> {
  let loaded: ValidSession;
  try {
    loaded = await requireValidSession(token);
  } catch (error) {
    if (
      error instanceof AuthError &&
      (error.code === 'unauthorized' ||
        error.code === 'session_expired' ||
        error.code === 'principal_disabled')
    ) {
      if (error.code === 'session_expired') return { status: 'expired' };
      if (error.code === 'principal_disabled') return { status: 'disabled' };
      return { status: 'invalid' };
    }
    throw error;
  }
  const { principal: principalRow, session } = loaded;
  const at = now();

  // Sliding renewal + last-seen touch.
  let expiresAt = toDate(session.expires_at);
  let lastRenewedAt = toDate(session.last_renewed_at);
  const remaining = expiresAt.getTime() - at.getTime();
  if (remaining < SESSION_RENEWAL_WINDOW_MS) {
    expiresAt = new Date(at.getTime() + SESSION_TTL_MS);
    lastRenewedAt = at;
    await getDb().query(
      `UPDATE auth_sessions SET expires_at = $2, last_renewed_at = $3, last_seen_at = $3
         WHERE id = $1`,
      [session.id, expiresAt.toISOString(), at.toISOString()],
    );
  } else {
    await getDb().query(
      `UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1`,
      [session.id, at.toISOString()],
    );
  }

  // Live verification of the active company/workspace.
  let tenant: ActiveTenant | null = null;
  let workspace: ActiveWorkspace | null = null;
  let context: TenantContext | null = null;
  if (session.active_tenant_id !== null) {
    const verified = await verifyTenant(session.active_tenant_id, principalRow.id);
    if (verified !== null) {
      tenant = {
        id: verified.tenant.id,
        name: verified.tenant.name,
        slug: verified.tenant.slug,
        role: verified.role,
      };
      context = {
        tenantId: verified.tenant.id,
        principalId: principalRow.id,
        authority: sessionAuthorityForRole(verified.role),
      };
      if (session.active_workspace_id !== null) {
        const ws = await verifyWorkspace(
          verified.tenant.id,
          principalRow.id,
          session.active_workspace_id,
        );
        if (ws !== null) {
          workspace = { id: ws.id, name: ws.name, slug: ws.slug };
        }
      }
    }
  }

  return {
    status: 'valid',
    resolved: {
      principal: mapPrincipal(principalRow),
      session: {
        id: session.id,
        createdAt: toIso(session.created_at),
        lastRenewedAt: lastRenewedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      tenant,
      workspace,
      context,
    },
  };
}

/** Explicitly renew a session (extends the lifetime). */
export async function renewSession(token: unknown): Promise<{ expiresAt: string }> {
  const { session } = await requireValidSession(token);
  const at = now();
  const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);
  await getDb().query(
    `UPDATE auth_sessions SET expires_at = $2, last_renewed_at = $2 WHERE id = $1`,
    [session.id, at.toISOString()],
  );
  return { expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Company onboarding & selection
// ---------------------------------------------------------------------------

/**
 * Create a company (tenant) for the signed-in principal: the platform
 * operation runs as the authenticated principal (the app boundary proves
 * them via the session; the organizations contract's provision claim is
 * minted HERE, at exactly this one platform seam). The principal becomes
 * the company's first owner, the session switches to the new company, and
 * the activation is recorded.
 */
export async function createCompany(
  token: unknown,
  input: CreateCompanyInput,
): Promise<{ tenant: ActiveTenant; workspace: ActiveWorkspace | null }> {
  const record = assertObject(input, 'input');
  const { principal, session } = await requireValidSession(token);
  const name = assertCompanyName(record['name']);
  const slug =
    record['slug'] === undefined || record['slug'] === null
      ? undefined
      : String(record['slug']);
  const defaultWorkspaceName =
    record['defaultWorkspaceName'] === undefined || record['defaultWorkspaceName'] === null
      ? undefined
      : assertCompanyName(record['defaultWorkspaceName'], 'defaultWorkspaceName');

  let tenant: Tenant;
  try {
    tenant = await provisionTenant(
      { principalId: principal.id, authority: [ORGANIZATIONS_AUTHORITY_PROVISION] },
      { name, slug, ownerPrincipalId: principal.id, defaultWorkspaceName },
    );
  } catch (error) {
    if (error instanceof OrganizationsError && error.code === 'tenant_slug_taken') {
      throw new AuthError('slug_taken', error.message);
    }
    if (error instanceof OrganizationsError && error.code === 'invalid_input') {
      throw new AuthError('invalid_input', error.message);
    }
    throw error;
  }

  const ctx: TenantContext = { tenantId: tenant.id, principalId: principal.id, authority: [] };
  const workspaces = await listWorkspaces(ctx);
  const defaultWorkspace =
    workspaces.find((candidate) => candidate.slug === DEFAULT_WORKSPACE_SLUG) ??
    workspaces[0];
  const workspaceId = defaultWorkspace === undefined ? null : defaultWorkspace.id;

  await setSessionScope(session.id, tenant.id, workspaceId);
  await upsertActivation(principal.id, tenant.id, workspaceId);

  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, role: 'owner' },
    workspace:
      defaultWorkspace === undefined
        ? null
        : {
            id: defaultWorkspace.id,
            name: defaultWorkspace.name,
            slug: defaultWorkspace.slug,
          },
  };
}

/**
 * The companies this principal has activated in Aurum — each verified LIVE
 * through the organizations contract (memberships that ended drop out of
 * the list and their activation rows are pruned). This is a navigation
 * registry, not a membership source of truth.
 */
export async function listReachableTenants(token: unknown): Promise<ReachableTenant[]> {
  const { principal } = await requireValidSession(token);
  const rows = await getDb().query<ActivationRow>(
    `SELECT principal_id, tenant_id, activated_at, last_workspace_id
       FROM auth_principal_tenants WHERE principal_id = $1
       ORDER BY activated_at DESC, tenant_id`,
    [principal.id],
  );
  const reachable: ReachableTenant[] = [];
  const stale: string[] = [];
  for (const row of rows.rows) {
    const verified = await verifyTenant(row.tenant_id, principal.id);
    if (verified === null) {
      stale.push(row.tenant_id);
      continue;
    }
    reachable.push({
      id: verified.tenant.id,
      name: verified.tenant.name,
      slug: verified.tenant.slug,
      role: verified.role,
      activatedAt: toIso(row.activated_at),
    });
  }
  if (stale.length > 0) {
    // Best-effort prune; the live verification above is the real gate.
    await getDb().query(
      `DELETE FROM auth_principal_tenants
         WHERE principal_id = $1 AND tenant_id = ANY($2)`,
      [principal.id, stale],
    );
  }
  return reachable;
}

/**
 * Switch the session's active company. The principal must be a member of
 * the target (verified live through the organizations contract — the
 * W058 acceptance "tenant switching cannot cross scope"); switching always
 * clears the workspace selection (a workspace only means something inside
 * its own company).
 */
export async function switchTenant(
  token: unknown,
  input: SwitchTenantInput,
): Promise<ResolvedSession> {
  const record = assertObject(input, 'input');
  const tenantId = assertUuidInput(record['tenantId'], 'tenantId');
  const { principal, session } = await requireValidSession(token);

  const verified = await verifyTenant(tenantId, principal.id);
  if (verified === null) {
    throw new AuthError(
      'tenant_unavailable',
      'that company does not exist, or you are not one of its members',
    );
  }
  await setSessionScope(session.id, verified.tenant.id, null);
  await upsertActivation(principal.id, verified.tenant.id, null);

  const resolved = await resolveSession(token);
  if (resolved.status !== 'valid') {
    throw new AuthError('unauthorized', 'the session ended while switching companies');
  }
  return resolved.resolved;
}

/**
 * Select the session's active workspace (inside the ACTIVE company; the
 * organizations contract enforces tenant scope + view rights).
 */
export async function selectWorkspace(
  token: unknown,
  input: SelectWorkspaceInput,
): Promise<ResolvedSession> {
  const record = assertObject(input, 'input');
  const workspaceId = assertUuidInput(record['workspaceId'], 'workspaceId');
  const { principal, session } = await requireValidSession(token);
  if (session.active_tenant_id === null) {
    throw new AuthError('no_active_tenant', 'select a company before selecting a workspace');
  }
  const workspace = await verifyWorkspace(
    session.active_tenant_id,
    principal.id,
    workspaceId,
  );
  if (workspace === null) {
    throw new AuthError(
      'workspace_unavailable',
      'that workspace does not exist in your active company, or is not visible to you',
    );
  }
  await getDb().query(
    `UPDATE auth_sessions SET active_workspace_id = $2 WHERE id = $1`,
    [session.id, workspace.id],
  );
  await getDb().query(
    `UPDATE auth_principal_tenants SET last_workspace_id = $3
       WHERE principal_id = $1 AND tenant_id = $2`,
    [principal.id, session.active_tenant_id, workspace.id],
  );
  const resolved = await resolveSession(token);
  if (resolved.status !== 'valid') {
    throw new AuthError('unauthorized', 'the session ended while selecting a workspace');
  }
  return resolved.resolved;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * May `inviterRole` grant `role`? Mirrors the organizations contract's own
 * rule one-to-one ("Owners grant any tenant role; admins grant plain
 * membership only"). This is a UX fast-fail only — the authoritative check
 * runs inside organizations.addTenantMember at ACCEPTANCE time, with the
 * inviter's current role.
 */
function mayInviteFor(inviterRole: TenantRole, role: TenantRole): boolean {
  return inviterRole === 'owner' || (inviterRole === 'admin' && role === 'member');
}

/**
 * Issue a membership invitation. The inviter must be an owner/admin of the
 * context tenant (their CURRENT role is read through the organizations
 * contract). The raw invite token is returned exactly once — the inviter
 * turns it into the invite link.
 */
export async function createInvitation(
  ctx: TenantContext,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const record = assertObject(input, 'input');
  const email = assertEmail(record['email']);
  const tenantRole = record['tenantRole'];
  if (tenantRole !== 'owner' && tenantRole !== 'admin' && tenantRole !== 'member') {
    throw new AuthError('invalid_input', "tenantRole must be 'owner', 'admin' or 'member'");
  }
  const workspaceIdRaw = record['workspaceId'];
  const workspaceRoleRaw = record['workspaceRole'];
  let workspaceId: string | null = null;
  let workspaceRole: WorkspaceRole | null = null;
  if (workspaceIdRaw !== undefined && workspaceIdRaw !== null) {
    workspaceId = assertUuidInput(workspaceIdRaw, 'workspaceId');
    if (workspaceRoleRaw !== 'admin' && workspaceRoleRaw !== 'member') {
      throw new AuthError(
        'invalid_input',
        "workspaceRole must be 'admin' or 'member' when workspaceId is given",
      );
    }
    workspaceRole = workspaceRoleRaw;
  } else if (workspaceRoleRaw !== undefined && workspaceRoleRaw !== null) {
    throw new AuthError('invalid_input', 'workspaceRole requires a workspaceId');
  }

  // The inviter's CURRENT membership + role, through the contract.
  let tenant: Tenant;
  let inviterRole: TenantRole;
  try {
    tenant = await getTenant(ctx);
    inviterRole = (await getTenantMembership(ctx, { principalId: ctx.principalId })).role;
  } catch (error) {
    if (isOrganizationsCode(error, 'tenant_not_found')) {
      throw new AuthError(
        'tenant_unavailable',
        'that company does not exist, or you are not one of its members',
      );
    }
    throw error;
  }
  if (!mayInviteFor(inviterRole, tenantRole)) {
    throw new AuthError(
      'forbidden',
      `the '${inviterRole}' role cannot invite a new '${tenantRole}'`,
    );
  }
  if (workspaceId !== null) {
    // Proves the workspace exists in this tenant and is visible to the
    // inviter (the manage-rights check runs at acceptance, in the contract).
    const workspace = await verifyWorkspace(ctx.tenantId, ctx.principalId, workspaceId);
    if (workspace === null) {
      throw new AuthError('workspace_unavailable', 'that workspace is not available here');
    }
  }

  const token = mintToken();
  const at = now();
  const expiresAt = new Date(at.getTime() + INVITATION_TTL_MS);
  const inserted = await getDb().transaction(async (tx) => {
    // One open invitation per (tenant, email): a new invite supersedes
    // the previous open row (the partial unique index enforces it).
    await tx.query(
      `UPDATE auth_invitations SET revoked_at = $3
         WHERE tenant_id = $1 AND email = $2
           AND accepted_at IS NULL AND revoked_at IS NULL`,
      [ctx.tenantId, email, at.toISOString()],
    );
    const rows = await tx.query<InvitationRow>(
      `INSERT INTO auth_invitations
         (tenant_id, workspace_id, tenant_name, email, tenant_role, workspace_role,
          token_hash, invited_by, created_at, expires_at, accepted_at, accepted_principal_id, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, NULL)
       RETURNING id, tenant_id, workspace_id, tenant_name, email, tenant_role, workspace_role,
                 token_hash, invited_by, created_at, expires_at, accepted_at,
                 accepted_principal_id, revoked_at`,
      [
        ctx.tenantId,
        workspaceId,
        tenant.name,
        email,
        tenantRole,
        workspaceRole,
        hashToken(token),
        ctx.principalId,
        at.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return rows.rows[0]!;
  });
  const record_ = mapInvitation(inserted, at);
  return { ...record_, token };
}

/** The context tenant's invitation roster (owner/admin only). */
export async function listInvitations(ctx: TenantContext): Promise<InvitationRecord[]> {
  let role: TenantRole;
  try {
    await getTenant(ctx);
    role = (await getTenantMembership(ctx, { principalId: ctx.principalId })).role;
  } catch (error) {
    if (isOrganizationsCode(error, 'tenant_not_found')) {
      throw new AuthError(
        'tenant_unavailable',
        'that company does not exist, or you are not one of its members',
      );
    }
    throw error;
  }
  if (role !== 'owner' && role !== 'admin') {
    throw new AuthError(
      'forbidden',
      'viewing invitations requires the owner or admin role',
    );
  }
  const rows = await getDb().query<InvitationRow>(
    `SELECT id, tenant_id, workspace_id, tenant_name, email, tenant_role, workspace_role,
            token_hash, invited_by, created_at, expires_at, accepted_at,
            accepted_principal_id, revoked_at
       FROM auth_invitations WHERE tenant_id = $1
       ORDER BY created_at DESC, id`,
    [ctx.tenantId],
  );
  const at = now();
  return rows.rows.map((row) => mapInvitation(row, at));
}

/** Revoke an open invitation (owner/admin only; tenant-scoped lookup). */
export async function revokeInvitation(
  ctx: TenantContext,
  input: RevokeInvitationInput,
): Promise<InvitationRecord> {
  const record = assertObject(input, 'input');
  const invitationId = assertUuidInput(record['invitationId'], 'invitationId');
  let role: TenantRole;
  try {
    await getTenant(ctx);
    role = (await getTenantMembership(ctx, { principalId: ctx.principalId })).role;
  } catch (error) {
    if (isOrganizationsCode(error, 'tenant_not_found')) {
      throw new AuthError(
        'tenant_unavailable',
        'that company does not exist, or you are not one of its members',
      );
    }
    throw error;
  }
  if (role !== 'owner' && role !== 'admin') {
    throw new AuthError('forbidden', 'revoking invitations requires the owner or admin role');
  }
  const rows = await getDb().query<InvitationRow>(
    `UPDATE auth_invitations SET revoked_at = $3
       WHERE id = $1 AND tenant_id = $2
         AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id, tenant_id, workspace_id, tenant_name, email, tenant_role, workspace_role,
                 token_hash, invited_by, created_at, expires_at, accepted_at,
                 accepted_principal_id, revoked_at`,
    [invitationId, ctx.tenantId, now().toISOString()],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AuthError(
      'invitation_not_found',
      'no open invitation for this id in your company',
    );
  }
  return mapInvitation(row, now());
}

/**
 * What an invitation LINK reveals to its holder. The raw token IS the
 * authorization to see this much (the possession doctrine of password
 * reset links); statuses are uniform so tokens cannot be probed.
 */
export async function inspectInvitation(invitationToken: unknown): Promise<InspectedInvitation> {
  const raw = assertToken(invitationToken);
  const rows = await getDb().query<InvitationRow>(
    `SELECT id, tenant_id, workspace_id, tenant_name, email, tenant_role, workspace_role,
            token_hash, invited_by, created_at, expires_at, accepted_at,
            accepted_principal_id, revoked_at
       FROM auth_invitations WHERE token_hash = $1`,
    [hashToken(raw)],
  );
  const row = rows.rows[0];
  if (row === undefined) return { status: 'not_found' };
  const status = invitationStatus(row, now());
  switch (status) {
    case 'pending':
      return {
        status: 'pending',
        tenantName: row.tenant_name,
        email: row.email,
        tenantRole: row.tenant_role as TenantRole,
        workspaceRole: row.workspace_role === null ? null : (row.workspace_role as WorkspaceRole),
        expiresAt: toIso(row.expires_at),
      };
    case 'accepted':
    case 'revoked':
    case 'expired':
      return { status };
  }
}

/**
 * Accept an invitation with the signed-in account. The account's email
 * must match the invited address (invite links are not transferable), the
 * invitation must be open, and the membership grant runs through
 * organizations.addTenantMember with the INVITER's context — so the
 * organizations contract re-checks the inviter's CURRENT authority. On
 * success the session switches to the joined company.
 */
export async function acceptInvitation(
  sessionToken: unknown,
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  const record = assertObject(input, 'input');
  const invitationToken = assertToken(record['invitationToken'], 'invitationToken');
  const { principal, session } = await requireValidSession(sessionToken);

  const rows = await getDb().query<InvitationRow>(
    `SELECT id, tenant_id, workspace_id, tenant_name, email, tenant_role, workspace_role,
            token_hash, invited_by, created_at, expires_at, accepted_at,
            accepted_principal_id, revoked_at
       FROM auth_invitations WHERE token_hash = $1`,
    [hashToken(invitationToken)],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AuthError('invitation_not_found', 'this invitation link is not valid');
  }
  if (row.accepted_at !== null) {
    throw new AuthError('invitation_not_pending', 'this invitation has already been used');
  }
  if (row.revoked_at !== null) {
    throw new AuthError('invitation_not_pending', 'this invitation was withdrawn');
  }
  if (toDate(row.expires_at).getTime() <= now().getTime()) {
    throw new AuthError('invitation_expired', 'this invitation has expired');
  }
  if (principal.email !== row.email) {
    throw new AuthError(
      'invitation_email_mismatch',
      'this invitation was issued for a different email address',
    );
  }

  // The grant: the organizations contract decides, with the inviter's
  // CURRENT authority (an invitation never outlives its inviter's role).
  const inviterCtx: TenantContext = {
    tenantId: row.tenant_id,
    principalId: row.invited_by,
    authority: [],
  };
  try {
    await addTenantMember(inviterCtx, { principalId: principal.id, role: row.tenant_role as TenantRole });
  } catch (error) {
    if (isOrganizationsCode(error, 'tenant_member_exists')) {
      // Already a member (e.g. a retry after a partially failed accept) —
      // the invitation's promise is already kept for the tenant grant.
    } else if (isOrganizationsCode(error, 'forbidden') || isOrganizationsCode(error, 'tenant_not_found')) {
      throw new AuthError(
        'grant_failed',
        'the person who invited you can no longer grant this membership',
      );
    } else {
      throw error;
    }
  }

  // The optional workspace grant degrades honestly: a failure here never
  // undoes the tenant grant (the invitation's core promise).
  let workspaceAdded = false;
  let workspace: ActiveWorkspace | null = null;
  if (row.workspace_id !== null) {
    try {
      await addWorkspaceMember(inviterCtx, {
        workspaceId: row.workspace_id,
        principalId: principal.id,
        role: (row.workspace_role ?? 'member') as WorkspaceRole,
      });
      workspaceAdded = true;
    } catch (error) {
      if (isOrganizationsCode(error, 'tenant_member_exists')) {
        workspaceAdded = true; // already a workspace member
      } else if (
        isOrganizationsCode(error, 'workspace_member_exists') ||
        isOrganizationsCode(error, 'forbidden') ||
        isOrganizationsCode(error, 'workspace_not_found')
      ) {
        workspaceAdded = false;
      } else {
        throw error;
      }
    }
    if (workspaceAdded) {
      const ws = await verifyWorkspace(row.tenant_id, principal.id, row.workspace_id);
      if (ws !== null) workspace = { id: ws.id, name: ws.name, slug: ws.slug };
    }
  }

  const at = now();
  await getDb().query(
    `UPDATE auth_invitations
        SET accepted_at = $2, accepted_principal_id = $3
      WHERE id = $1 AND accepted_at IS NULL`,
    [row.id, at.toISOString(), principal.id],
  );

  // Switch the session to the joined company.
  const verified = await verifyTenant(row.tenant_id, principal.id);
  if (verified === null) {
    // Should be unreachable (the grant just succeeded) — fail closed.
    throw new AuthError('grant_failed', 'the membership grant could not be verified');
  }
  const workspaceId = workspace === null ? null : workspace.id;
  await setSessionScope(session.id, verified.tenant.id, workspaceId);
  await upsertActivation(principal.id, verified.tenant.id, workspaceId);

  return {
    tenant: {
      id: verified.tenant.id,
      name: verified.tenant.name,
      slug: verified.tenant.slug,
      role: verified.role,
    },
    workspaceAdded,
    workspace,
  };
}
