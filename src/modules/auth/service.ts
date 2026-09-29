// Implementation of the auth module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps are timestamptz written from the
// injectable clock; the raw session/invite tokens are NEVER stored — only
// their SHA-256 digests (tokens.ts).
//
// Tenant isolation (ADR-0001, W058 acceptance "tenant switching cannot
// cross scope"):
//   * the session's `tenant_id` column is a SELECTION, not an
//     authorization: every authentication re-verifies membership through
//     the organizations contract (getTenantMembership) and silently
//     de-selects when the principal no longer verifies;
//   * switching requires the membership to verify BEFORE the session row
//     is touched;
//   * company/workspace ids that do not verify are uniform errors
//     (company_not_available / workspace_not_available) — no existence
//     leaks, the house doctrine of organizations and identity.
//
// The organizations module stays the sole membership authority: the auth
// module never reads tenant_members directly; every grant (invite
// redemption) and every check goes through its contract.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  addTenantMember,
  addWorkspaceMember,
  getTenant,
  getTenantMembership,
  getWorkspace,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
} from '@/modules/organizations/contract';
import { OrganizationsError } from '@/modules/organizations/contract';
import type { PlatformContext, Tenant } from '@/modules/organizations/contract';
import { AUTH_AUTHORITY_ADMINISTER, isDesignatedPlatformAdmin } from './platform-admin';
import { claimsForRole } from './claims';
import { AuthError } from './errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './passwords';
import { initialExpiry, inviteExpiry, isInviteExpired, isLive, renewal } from './policy';
import { hashToken, mintInviteCode, mintToken } from './tokens';
import {
  assertDisplayName,
  assertEmail,
  assertInvitableRole,
  assertOptionalWorkspaceId,
  assertTokenShape,
  assertUuid,
} from './validation';
import type {
  AuthInvite,
  AuthenticatedSession,
  AuthPrincipal,
  ChangePasswordInput,
  CreateCompanyInput,
  CreateInviteInput,
  DecideWaitlistInput,
  GetInviteByCodeInput,
  IssuedSession,
  IssuedInvite,
  ListInvitesInput,
  ListUserCompaniesInput,
  ListWaitlistInput,
  RedeemInviteInput,
  RegisterUserInput,
  RevokeInviteInput,
  SelectCompanyInput,
  SelectWorkspaceInput,
  SetPlatformAdminInput,
  SignInInput,
  SignOutEverywhereInput,
  SignOutInput,
  SubmitWaitlistInput,
  UserCompany,
  WaitlistRequest,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface UserRow extends DbRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_platform_admin: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionRow extends DbRow {
  id: string;
  user_id: string;
  token_hash: string;
  active_tenant_id: string | null;
  active_workspace_id: string | null;
  created_at: Date | string;
  last_seen_at: Date | string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

interface UserCompanyRow extends DbRow {
  id: string;
  user_id: string;
  tenant_id: string;
  added_via: string;
  added_at: Date | string;
  last_selected_at: Date | string;
}

interface InviteRow extends DbRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  email: string;
  role: string;
  token_hash: string;
  status: string;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  accepted_by: string | null;
}

interface WaitlistRow extends DbRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  note: string | null;
  requested_at: Date | string;
  updated_at: Date | string;
  decided_at: Date | string | null;
  decided_by: string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505' && candidate?.constraint === constraint;
}

function toPrincipal(row: UserRow): AuthPrincipal {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

function toInvite(row: InviteRow): AuthInvite {
  const status = row.status as AuthInvite['status'];
  const role = row.role as AuthInvite['role'];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    email: row.email,
    role,
    status,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    acceptedAt: row.accepted_at === null ? null : toIso(row.accepted_at),
    acceptedBy: row.accepted_by,
  };
}

function toWaitlistRequest(row: WaitlistRow): WaitlistRequest {
  const status = row.status as WaitlistRequest['status'];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status,
    note: row.note,
    requestedAt: toIso(row.requested_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    decidedBy: row.decided_by,
  };
}

// ---------------------------------------------------------------------------
// Session plumbing (internal)
// ---------------------------------------------------------------------------

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await getDb().query<UserRow>(
    `SELECT id, email, display_name, password_hash, is_platform_admin, created_at, updated_at FROM auth_users WHERE email = $1`,
    [email],
  );
  return rows.rows[0] ?? null;
}

async function findSessionRow(token: string): Promise<SessionRow | null> {
  const rows = await getDb().query<SessionRow>(
    `SELECT id, user_id, token_hash, active_tenant_id, active_workspace_id, created_at, last_seen_at, expires_at, revoked_at
       FROM auth_sessions WHERE token_hash = $1`,
    [hashToken(token)],
  );
  return rows.rows[0] ?? null;
}

async function findUserById(userId: string): Promise<UserRow | null> {
  const rows = await getDb().query<UserRow>(
    `SELECT id, email, display_name, password_hash, is_platform_admin, created_at, updated_at FROM auth_users WHERE id = $1`,
    [userId],
  );
  return rows.rows[0] ?? null;
}

/**
 * The session floor: resolve a LIVE session (not revoked, not expired) plus
 * its user, or throw the uniform `unauthenticated`. Every session-scoped
 * operation starts here; no caller ever learns WHY a token failed.
 */
async function requireLiveSession(
  token: string,
): Promise<{ session: SessionRow; user: UserRow }> {
  const shapeChecked = assertTokenShape(token, 'token');
  const session = await findSessionRow(shapeChecked);
  if (session === null) {
    throw new AuthError('unauthenticated', 'no session for this token');
  }
  if (!isLive(toDate(session.expires_at), session.revoked_at === null ? null : toDate(session.revoked_at), now())) {
    throw new AuthError('unauthenticated', 'no session for this token');
  }
  const user = await findUserById(session.user_id);
  if (user === null) {
    // A session whose user vanished (defensive; rows cascade never deletes users).
    throw new AuthError('unauthenticated', 'no session for this token');
  }
  return { session, user };
}

/** A TenantContext for internal, pre-claim verification reads (membership checks). */
function contextFor(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/**
 * Verify the session's active selection through the organizations contract.
 * Returns the verified company block, or null when nothing is selected.
 * A selection that no longer verifies is CLEARED on the session row — the
 * next navigation lands in onboarding instead of leaking stale scope.
 */
async function verifyActiveSelection(
  session: SessionRow,
): Promise<AuthenticatedSession['company']> {
  if (session.active_tenant_id === null) return null;
  const ctx = contextFor(session.active_tenant_id, session.user_id);
  let membership;
  try {
    membership = await getTenantMembership(ctx, { principalId: session.user_id });
  } catch {
    await getDb().query(
      `UPDATE auth_sessions SET active_tenant_id = NULL, active_workspace_id = NULL WHERE id = $1`,
      [session.id],
    );
    session.active_tenant_id = null;
    session.active_workspace_id = null;
    return null;
  }
  let workspaceId: string | null = session.active_workspace_id;
  if (workspaceId !== null) {
    try {
      const workspace = await getWorkspace(ctx, workspaceId);
      if (workspace.tenantId !== session.active_tenant_id) workspaceId = null;
    } catch {
      workspaceId = null;
      await getDb().query(
        `UPDATE auth_sessions SET active_workspace_id = NULL WHERE id = $1`,
        [session.id],
      );
      session.active_workspace_id = null;
    }
  }
  return {
    tenantId: session.active_tenant_id,
    workspaceId,
    role: membership.role,
    authority: claimsForRole(membership.role),
  };
}

/** Persist the idle-sliding renewal when the policy says the write is due. */
async function applyRenewal(session: SessionRow): Promise<void> {
  const decision = renewal(
    toDate(session.created_at),
    session.last_seen_at === null ? null : toDate(session.last_seen_at),
    now(),
  );
  if (!decision.write) return;
  await getDb().query(
    `UPDATE auth_sessions SET expires_at = $2, last_seen_at = $3 WHERE id = $1`,
    [session.id, decision.expiresAt.toISOString(), decision.lastSeenAt.toISOString()],
  );
  session.expires_at = decision.expiresAt;
  session.last_seen_at = decision.lastSeenAt;
}

/** Build the contract view of one live session (verification + renewal included). */
async function buildSessionView(
  session: SessionRow,
  user: UserRow,
): Promise<AuthenticatedSession> {
  const company = await verifyActiveSelection(session);
  await applyRenewal(session);
  return {
    sessionId: session.id,
    principalId: user.id,
    principal: toPrincipal(user),
    platformAdmin: user.is_platform_admin === true,
    createdAt: toIso(session.created_at),
    expiresAt: toIso(session.expires_at),
    lastSeenAt: session.last_seen_at === null ? null : toIso(session.last_seen_at),
    company,
  };
}

/** Record (or refresh) a company in the principal's directory. */
async function recordUserCompany(
  userId: string,
  tenantId: string,
  addedVia: 'created' | 'invite' | 'switch',
): Promise<void> {
  const timestamp = now().toISOString();
  if (addedVia === 'switch') {
    await getDb().query(
      `INSERT INTO auth_user_companies (user_id, tenant_id, added_via, added_at, last_selected_at)
         VALUES ($1, $2, 'switch', $3, $3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET last_selected_at = EXCLUDED.last_selected_at`,
      [userId, tenantId, timestamp],
    );
    return;
  }
  await getDb().query(
    `INSERT INTO auth_user_companies (user_id, tenant_id, added_via, added_at, last_selected_at)
       VALUES ($1, $2, $3, $4, $4)`,
    [userId, tenantId, addedVia, timestamp],
  );
}

/** Create a fresh session row and return its raw token (shown once). */
async function issueSession(userId: string): Promise<string> {
  const token = mintToken();
  const createdAt = now();
  await getDb().query(
    `INSERT INTO auth_sessions (user_id, token_hash, active_tenant_id, active_workspace_id, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, NULL, NULL, $3, NULL, $4)`,
    [userId, hashToken(token), createdAt.toISOString(), initialExpiry(createdAt).toISOString()],
  );
  return token;
}

/**
 * Auto-select the principal's most recently used company on fresh sign-in
 * (a returning manager lands straight back in their company). Fails quiet:
 * a company that no longer verifies is pruned and the session stays
 * unscoped (onboarding).
 */
async function autoSelectMostRecentCompany(session: SessionRow): Promise<void> {
  const rows = await getDb().query<{ tenant_id: string }>(
    `SELECT tenant_id FROM auth_user_companies WHERE user_id = $1
       ORDER BY last_selected_at DESC, added_at DESC LIMIT 1`,
    [session.user_id],
  );
  const candidate = rows.rows[0];
  if (candidate === undefined) return;
  try {
    await getTenantMembership(contextFor(candidate.tenant_id, session.user_id), {
      principalId: session.user_id,
    });
  } catch {
    await getDb().query(
      `DELETE FROM auth_user_companies WHERE user_id = $1 AND tenant_id = $2`,
      [session.user_id, candidate.tenant_id],
    );
    return;
  }
  await getDb().query(
    `UPDATE auth_sessions SET active_tenant_id = $2, active_workspace_id = NULL WHERE id = $1`,
    [session.id, candidate.tenant_id],
  );
  session.active_tenant_id = candidate.tenant_id;
  session.active_workspace_id = null;
  await recordUserCompany(session.user_id, candidate.tenant_id, 'switch');
}

// ---------------------------------------------------------------------------
// Registration and sign-in
// ---------------------------------------------------------------------------

/**
 * Register a principal AND sign it in (the product entry flow): the
 * account is created and a fresh session is issued in one operation —
 * the password is transmitted once and never re-sent through sign-in.
 */
export async function registerUser(input: RegisterUserInput): Promise<IssuedSession> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const displayName = assertDisplayName(input.displayName, 'displayName');
  const email = assertEmail(input.email, 'email');
  const password = assertPasswordPolicy(input.password);
  const passwordHash = hashPassword(password);
  try {
    await getDb().query(
      `INSERT INTO auth_users (email, display_name, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
      [email, displayName, passwordHash, now().toISOString()],
    );
  } catch (error) {
    if (isUniqueViolation(error, 'auth_users_email_unique')) {
      throw new AuthError('email_taken', `the email '${email}' is already registered`);
    }
    throw error;
  }
  const token = await issueSessionFor(email);
  return token;
}

/** Issue a session for a registered user (internal helper for registerUser). */
async function issueSessionFor(email: string): Promise<IssuedSession> {
  const token = await issueSession((await findUserByEmail(email))!.id);
  const { session, user } = await requireLiveSession(token);
  await autoSelectMostRecentCompany(session);
  const view = await buildSessionView(session, user);
  return { session: view, token };
}

/**
 * The env-designated platform-admin grant (W116): on sign-in, an email
 * listed in AURUM_PLATFORM_ADMIN_EMAILS is granted the flag — the
 * production bootstrap. Fail closed (the list is empty when the variable
 * is unset) and sticky (an already-granted principal is never demoted
 * here). Idempotent and quiet: the write only happens on the transition.
 */
async function applyPlatformAdminGrant(user: UserRow): Promise<UserRow> {
  if (user.is_platform_admin === true) return user;
  if (!isDesignatedPlatformAdmin(user.email)) return user;
  const timestamp = now().toISOString();
  await getDb().query(
    `UPDATE auth_users SET is_platform_admin = true, updated_at = $2 WHERE id = $1`,
    [user.id, timestamp],
  );
  user.is_platform_admin = true;
  return user;
}

/**
 * Sign in with email + password. Unknown email and wrong password are the
 * SAME error (invalid_credentials) — account existence never leaks.
 *
 * W116 waitlist states: when the credentials match a waitlist REQUEST the
 * person has proven password knowledge, so the honest, non-leaking states
 * surface — `request_pending` ("awaiting admin approval") and
 * `request_declined` (with the admin's note). A wrong password against a
 * request is the same uniform `invalid_credentials` as any other miss:
 * knowledge was NOT proven, so nothing about the email's queue state is
 * revealed.
 *
 * W116 production bootstrap: a PENDING request for an
 * AURUM_PLATFORM_ADMIN_EMAILS-designated email self-accepts at sign-in
 * (the designation is the operator's pre-granted trust; the password
 * proof keeps it takeover-proof — the response is an ordinary successful
 * sign-in). This closes the fresh-deployment chicken-and-egg (the first
 * admin cannot be accepted by an admin who does not exist yet) without
 * any seed or database edit. Fail closed: unset means no self-acceptance.
 */
export async function signIn(input: SignInInput): Promise<IssuedSession> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const email = assertEmail(input.email, 'email');
  const password = assertPasswordPolicy(input.password);
  const user = await findUserByEmail(email);
  if (user !== null) {
    if (!verifyPassword(password, user.password_hash)) {
      throw new AuthError('invalid_credentials', 'email or password is incorrect');
    }
    const admin = await applyPlatformAdminGrant(user);
    return issueSessionForUser(admin);
  }
  // No ACTIVE principal for the email: a waitlist request may still
  // verify (the person proved knowledge of the request's password).
  const request = await findWaitlistRowByEmail(email);
  if (request === null || !verifyPassword(password, request.password_hash)) {
    throw new AuthError('invalid_credentials', 'email or password is incorrect');
  }
  if (request.status === 'pending') {
    if (isDesignatedPlatformAdmin(email)) {
      return issueSessionForUser(await selfAcceptRequest(request));
    }
    throw new AuthError('request_pending', 'Your request is awaiting admin approval');
  }
  if (request.status === 'declined') {
    const note = request.note === null ? '' : ` ${request.note}`;
    throw new AuthError('request_declined', `Your request was declined.${note}`);
  }
  // status 'accepted' with no principal row: the account was accepted
  // but the principal vanished (defensive) — the uniform miss below,
  // never a half-state session.
  throw new AuthError('invalid_credentials', 'email or password is incorrect');
}

/** Issue a session for a verified active principal (the signIn tail). */
async function issueSessionForUser(user: UserRow): Promise<IssuedSession> {
  const token = await issueSession(user.id);
  const { session } = await requireLiveSession(token);
  await autoSelectMostRecentCompany(session);
  const view = await buildSessionView(session, user);
  return { session: view, token };
}

/**
 * The env-designated self-acceptance (W116 production bootstrap): the
 * pending request becomes an active, ALREADY platform-admin principal
 * (the designation grants the flag), and the waitlist row settles with
 * decided_by = the principal's own id — the designation IS the decision,
 * recorded auditable like every other acceptance.
 */
async function selfAcceptRequest(request: WaitlistRow): Promise<UserRow> {
  const timestamp = now().toISOString();
  let userId: string;
  try {
    const inserted = await getDb().query<{ id: string }>(
      `INSERT INTO auth_users (email, display_name, password_hash, is_platform_admin, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, $4)
       RETURNING id`,
      [request.email, request.display_name, request.password_hash, timestamp],
    );
    userId = inserted.rows[0]!.id;
  } catch (error) {
    if (!isUniqueViolation(error, 'auth_users_email_unique')) throw error;
    // The principal exists after all (concurrent acceptance) — use it.
    const existing = await findUserByEmail(request.email);
    if (existing === null) throw error;
    userId = existing.id;
    await applyPlatformAdminGrant(existing);
  }
  await getDb().query(
    `UPDATE auth_waitlist SET status = 'accepted', decided_at = $2, decided_by = $3, updated_at = $2
       WHERE id = $1 AND status = 'pending'`,
    [request.id, timestamp, userId],
  );
  const user = await findUserById(userId);
  if (user === null) {
    throw new AuthError('unauthenticated', 'no session for this token');
  }
  return user;
}

/**
 * Sign out: revoke the session. Deliberately idempotent and uniformly
 * quiet — an unknown or already-revoked token is still "signed out" (no
 * information about session state leaks through the sign-out response).
 */
export async function signOut(input: SignOutInput): Promise<void> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const token = assertTokenShape(input.token, 'token');
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token), now().toISOString()],
  );
}

// ---------------------------------------------------------------------------
// W116 — the access waitlist
// ---------------------------------------------------------------------------

async function findWaitlistRowByEmail(email: string): Promise<WaitlistRow | null> {
  const rows = await getDb().query<WaitlistRow>(
    `SELECT id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by
       FROM auth_waitlist WHERE email = $1`,
    [email],
  );
  return rows.rows[0] ?? null;
}

async function findWaitlistRowById(id: string): Promise<WaitlistRow | null> {
  const rows = await getDb().query<WaitlistRow>(
    `SELECT id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by
       FROM auth_waitlist WHERE id = $1`,
    [id],
  );
  return rows.rows[0] ?? null;
}

/**
 * The platform-admin floor (W116): resolve the live session AND require
 * the principal's platform-admin flag, or throw — anonymous/expired
 * tokens stay the uniform `unauthenticated` (the surface never learns
 * why), everyone else gets the same `forbidden` (tenant role is
 * irrelevant: platform administration is never a tenant fact).
 */
async function requirePlatformAdmin(
  token: string,
): Promise<{ session: SessionRow; user: UserRow }> {
  const { session, user } = await requireLiveSession(token);
  if (user.is_platform_admin !== true) {
    throw new AuthError('forbidden', 'this operation requires a platform administrator');
  }
  return { session, user };
}

/**
 * The public sign-up request (W116): record (or refresh) a waitlist
 * request — email, display name and the scrypt verifier captured NOW so
 * acceptance needs no second password transmission. NO principal is
 * created and NO session is issued; the person stays signed out.
 *
 * Idempotent re-request, one row per email (UNIQUE): a pending request
 * is updated in place (fresh material, fresh requested_at); a DECLINED
 * request resets to pending — the admin reviews the new request (the
 * decision fields are cleared; nothing carries stale audit marks). An
 * ACCEPTED request is a live account: the uniform `email_taken` of
 * registration, never a waitlist state.
 */
export async function submitWaitlistRequest(input: SubmitWaitlistInput): Promise<WaitlistRequest> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const displayName = assertDisplayName(input.displayName, 'displayName');
  const email = assertEmail(input.email, 'email');
  const password = assertPasswordPolicy(input.password);
  // A REGISTERED email is the ordinary email_taken of registration —
  // checked BEFORE any row is written (an active account never acquires
  // a waitlist shadow).
  if ((await findUserByEmail(email)) !== null) {
    throw new AuthError('email_taken', `the email '${email}' is already registered`);
  }
  const passwordHash = hashPassword(password);
  const timestamp = now().toISOString();
  const existing = await findWaitlistRowByEmail(email);
  let row: WaitlistRow;
  if (existing === null) {
    const inserted = await getDb().query<WaitlistRow>(
      `INSERT INTO auth_waitlist (email, display_name, password_hash, status, requested_at, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, $4)
       ON CONFLICT (email) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash,
         status = 'pending',
         note = NULL,
         requested_at = EXCLUDED.requested_at,
         updated_at = EXCLUDED.updated_at,
         decided_at = NULL,
         decided_by = NULL
       WHERE auth_waitlist.status <> 'accepted'
       RETURNING id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by`,
      [email, displayName, passwordHash, timestamp],
    );
    if (inserted.rows[0] === undefined) {
      // A concurrent acceptance settled the row between the reads and
      // this write — the account exists; the honest answer is email_taken.
      throw new AuthError('email_taken', `the email '${email}' is already registered`);
    }
    row = inserted.rows[0];
  } else if (existing.status === 'accepted') {
    throw new AuthError('email_taken', `the email '${email}' is already registered`);
  } else {
    // pending (refresh in place) or declined (re-request → pending again).
    const updated = await getDb().query<WaitlistRow>(
      `UPDATE auth_waitlist SET
         display_name = $2, password_hash = $3, status = 'pending', note = NULL,
         requested_at = $4, updated_at = $4, decided_at = NULL, decided_by = NULL
       WHERE email = $1
       RETURNING id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by`,
      [email, displayName, passwordHash, timestamp],
    );
    row = updated.rows[0]!;
  }
  return toWaitlistRequest(row);
}

/**
 * Every waitlist request, newest first (the platform admin's review
 * queue: pending requests AND the settled audit trail, status pills
 * included). Platform-admin-gated.
 */
export async function listWaitlistRequests(input: ListWaitlistInput): Promise<WaitlistRequest[]> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const token = assertTokenShape(input.token, 'token');
  await requirePlatformAdmin(token);
  const rows = await getDb().query<WaitlistRow>(
    `SELECT id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by
       FROM auth_waitlist
       ORDER BY (status = 'pending') DESC, requested_at DESC, id`,
  );
  return rows.rows.map(toWaitlistRequest);
}

/**
 * Accept a pending request (W116): the principal row is created FROM the
 * request's captured material — the account becomes active with exactly
 * the password the person chose at request time — and the request flips
 * to `accepted` with decided_at/decided_by (the deciding admin's
 * principal id — every decision is auditable). The person can now sign
 * in and flows into onboarding exactly like a fresh registration.
 *
 * Uniform `waitlist_not_found` for an unknown id, an already-decided
 * request, or a vanished row — the caller learns nothing beyond "no
 * pending request for this id". The principal insert tolerates the race
 * where the email already has an account (concurrent acceptance or a
 * legacy row): the request still settles — acceptance is idempotent.
 */
export async function acceptWaitlistRequest(input: DecideWaitlistInput): Promise<WaitlistRequest> {
  const { user } = await requireDecidedRequest(input);
  const request = await findWaitlistRowById(assertUuid(input.requestId, 'requestId'));
  if (request === null || request.status !== 'pending') {
    throw new AuthError('waitlist_not_found', 'no pending request for this id');
  }
  const timestamp = now().toISOString();
  try {
    await getDb().query(
      `INSERT INTO auth_users (email, display_name, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
      [request.email, request.display_name, request.password_hash, timestamp],
    );
  } catch (error) {
    if (!isUniqueViolation(error, 'auth_users_email_unique')) throw error;
    // The principal already exists (concurrent accept / legacy state) —
    // settle the request anyway; the account is active either way.
  }
  const updated = await getDb().query<WaitlistRow>(
    `UPDATE auth_waitlist SET status = 'accepted', decided_at = $2, decided_by = $3, updated_at = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by`,
    [request.id, timestamp, user.id],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    // Settled concurrently between the read and the write.
    throw new AuthError('waitlist_not_found', 'no pending request for this id');
  }
  return toWaitlistRequest(row);
}

/**
 * Decline a pending request (W116): the request flips to `declined` with
 * the optional one-line note (shown to the requester on their next
 * sign-in attempt — they prove password knowledge there, so the note
 * reveals nothing they are not entitled to) and decided_at/decided_by.
 * No principal is ever created. Uniform `waitlist_not_found` for every
 * non-pending shape, exactly like acceptance.
 */
export async function declineWaitlistRequest(input: DecideWaitlistInput): Promise<WaitlistRequest> {
  const { user } = await requireDecidedRequest(input);
  const requestId = assertUuid(input.requestId, 'requestId');
  const note =
    input.note === undefined || input.note === null
      ? null
      : assertWaitlistNote(input.note);
  const timestamp = now().toISOString();
  const updated = await getDb().query<WaitlistRow>(
    `UPDATE auth_waitlist SET status = 'declined', note = $2, decided_at = $3, decided_by = $4, updated_at = $3
       WHERE id = $1 AND status = 'pending'
       RETURNING id, email, display_name, password_hash, status, note, requested_at, updated_at, decided_at, decided_by`,
    [requestId, note, timestamp, user.id],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new AuthError('waitlist_not_found', 'no pending request for this id');
  }
  return toWaitlistRequest(row);
}

/** The shared gate of the two decision operations (admin + input shape). */
async function requireDecidedRequest(
  input: DecideWaitlistInput,
): Promise<{ session: SessionRow; user: UserRow }> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  return requirePlatformAdmin(assertTokenShape(input.token, 'token'));
}

/** A decision note: one line, 1–280 characters after trimming (null clears). */
function assertWaitlistNote(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', 'note must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 280) {
    throw new AuthError('invalid_input', 'note must be 1–280 characters after trimming');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// W116 — account operations (password change, sign out everywhere)
// ---------------------------------------------------------------------------

/**
 * Change the signed-in principal's password: the CURRENT password must
 * verify (uniform `invalid_credentials` on a miss — never which half
 * failed), the new one passes the same policy as registration, and the
 * verifier is re-hashed with a fresh salt.
 *
 * Session policy (documented choice): every OTHER session of the
 * principal is revoked — this device stays signed in, every other
 * browser is signed out. A password change should invalidate the
 * credentials everywhere else without lockout drama here.
 */
export async function changePassword(input: ChangePasswordInput): Promise<void> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const token = assertTokenShape(input.token, 'token');
  const { session, user } = await requireLiveSession(token);
  const currentPassword = assertPasswordPolicy(input.currentPassword);
  const newPassword = assertPasswordPolicy(input.newPassword);
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw new AuthError('invalid_credentials', 'the current password is incorrect');
  }
  const timestamp = now().toISOString();
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $3
       WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
    [user.id, session.id, timestamp],
  );
  await getDb().query(
    `UPDATE auth_users SET password_hash = $2, updated_at = $3 WHERE id = $1`,
    [user.id, hashPassword(newPassword), timestamp],
  );
}

/**
 * Sign out EVERYWHERE (W116): revoke every live session of the
 * principal, including the calling one — the surface clears the cookie
 * and routes to /signin. Idempotent and uniformly quiet, exactly like
 * signOut: the token still resolves the PRINCIPAL even when its own
 * session is already revoked or expired (the row persists), so a
 * re-invocation from a logged-out browser still kills the other
 * sessions; the response never reveals how many existed.
 */
export async function signOutEverywhere(input: SignOutEverywhereInput): Promise<void> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const token = assertTokenShape(input.token, 'token');
  const session = await findSessionRow(token);
  if (session === null) {
    // An unknown token is still "signed out" — uniformly quiet.
    return;
  }
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $2
       WHERE user_id = $1 AND revoked_at IS NULL`,
    [session.user_id, now().toISOString()],
  );
}

/**
 * The demo harness's explicit platform-admin write (W116): sets the flag
 * for one email. Gated on the `auth:administer` authority claim — a
 * claim that NEVER rides a session at this base (claims.ts keeps all
 * platform claims out of the interim role mapping), so only the
 * non-production harness's explicit contexts can reach it. The gate
 * refuses production runtimes at the seed entry point (demo gate).
 */
export async function setPlatformAdminFlag(
  actor: PlatformContext,
  input: SetPlatformAdminInput,
): Promise<void> {
  if (actor === null || typeof actor !== 'object' || !Array.isArray(actor.authority)) {
    throw new AuthError('forbidden', 'this operation requires the platform administration authority');
  }
  if (!actor.authority.includes(AUTH_AUTHORITY_ADMINISTER)) {
    throw new AuthError('forbidden', 'this operation requires the platform administration authority');
  }
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const email = assertEmail(input.email, 'email');
  const platformAdmin = input.platformAdmin === true;
  const rows = await getDb().query<{ id: string }>(
    `UPDATE auth_users SET is_platform_admin = $2, updated_at = $3 WHERE email = $1 RETURNING id`,
    [email, platformAdmin, now().toISOString()],
  );
  if (rows.rows[0] === undefined) {
    throw new AuthError('principal_not_found', 'no principal for this email');
  }
}

// ---------------------------------------------------------------------------
// Session authentication, renewal, selection
// ---------------------------------------------------------------------------

/**
 * Authenticate one session token: resolve the live session, re-verify the
 * active company selection through the organizations contract (de-selecting
 * silently when membership no longer holds), apply the idle-sliding
 * renewal, and return the contract view (role + derived claims included).
 *
 * This is the ONLY way the HTTP layer turns a cookie into a TenantContext.
 */
export async function authenticateSession(
  input: { token: string },
): Promise<AuthenticatedSession> {
  const { session, user } = await requireLiveSession(input.token);
  return buildSessionView(session, user);
}

/**
 * Switch the session's active company. The membership must verify through
 * the organizations contract BEFORE the session is touched — switching can
 * never cross scope. A company change always drops the workspace
 * selection (a workspace only means something inside its company).
 */
export async function selectCompany(input: SelectCompanyInput): Promise<AuthenticatedSession> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { session, user } = await requireLiveSession(input.token);
  const tenantId = assertUuid(input.tenantId, 'tenantId');
  if (session.active_tenant_id === tenantId) {
    return buildSessionView(session, user);
  }
  try {
    await getTenantMembership(contextFor(tenantId, user.id), { principalId: user.id });
  } catch {
    throw new AuthError(
      'company_not_available',
      'this company is not available for your account',
    );
  }
  await getDb().query(
    `UPDATE auth_sessions SET active_tenant_id = $2, active_workspace_id = NULL WHERE id = $1`,
    [session.id, tenantId],
  );
  session.active_tenant_id = tenantId;
  session.active_workspace_id = null;
  await recordUserCompany(user.id, tenantId, 'switch');
  return buildSessionView(session, user);
}

/**
 * Select the active workspace inside the session's active company (null
 * clears it). The workspace must remain viewable for the principal
 * (getWorkspace enforces canViewWorkspace) — selection can never smuggle
 * scope the organizations contract would refuse.
 */
export async function selectWorkspace(
  input: SelectWorkspaceInput,
): Promise<AuthenticatedSession> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { session, user } = await requireLiveSession(input.token);
  if (session.active_tenant_id === null) {
    throw new AuthError('no_active_company', 'select a company before selecting a workspace');
  }
  const workspaceId =
    input.workspaceId === undefined || input.workspaceId === null
      ? null
      : assertUuid(input.workspaceId, 'workspaceId');
  if (workspaceId !== null) {
    try {
      const workspace = await getWorkspace(contextFor(session.active_tenant_id, user.id), workspaceId);
      if (workspace.tenantId !== session.active_tenant_id) {
        throw new AuthError('workspace_not_available', 'the workspace is not in the active company');
      }
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('workspace_not_available', 'the workspace is not available in the active company');
    }
  }
  await getDb().query(
    `UPDATE auth_sessions SET active_workspace_id = $2 WHERE id = $1`,
    [session.id, workspaceId],
  );
  session.active_workspace_id = workspaceId;
  return buildSessionView(session, user);
}

/**
 * The principal's verified company directory (the switcher's candidate
 * list). Each row is re-verified through the organizations contract;
 * rows that no longer verify are pruned — the directory is derived
 * navigation state, never a second membership truth.
 */
export async function listUserCompanies(
  input: ListUserCompaniesInput,
): Promise<UserCompany[]> {
  const { session } = await requireLiveSession(input.token);
  const rows = await getDb().query<UserCompanyRow>(
    `SELECT id, user_id, tenant_id, added_via, added_at, last_selected_at FROM auth_user_companies
       WHERE user_id = $1 ORDER BY last_selected_at DESC, added_at DESC`,
    [session.user_id],
  );
  const companies: UserCompany[] = [];
  for (const row of rows.rows) {
    try {
      const tenant = await getTenant(contextFor(row.tenant_id, session.user_id));
      companies.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        addedVia: row.added_via as UserCompany['addedVia'],
        addedAt: toIso(row.added_at),
        lastSelectedAt: toIso(row.last_selected_at),
      });
    } catch {
      await getDb().query(
        `DELETE FROM auth_user_companies WHERE id = $1`,
        [row.id],
      );
    }
  }
  return companies;
}

// ---------------------------------------------------------------------------
// Onboarding: company creation
// ---------------------------------------------------------------------------

/**
 * Create the principal's company (first-manager onboarding). Provisions
 * the tenant + default workspace + owner membership through the
 * organizations contract — self-service provisioning is this module's
 * single explicit platform operation, so the PlatformContext carries the
 * `organizations:provision` claim for exactly this call (never ambient,
 * never session-wide). The new company becomes the session's active
 * selection so onboarding lands straight in Aurum chat.
 */
export async function createCompanyForSession(
  input: CreateCompanyInput,
): Promise<{ tenant: Tenant; session: AuthenticatedSession }> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { session, user } = await requireLiveSession(input.token);
  const actor: PlatformContext = {
    principalId: user.id,
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };
  const tenant = await provisionTenant(actor, {
    name: input.name,
    slug: input.slug,
    ownerPrincipalId: user.id,
    defaultWorkspaceName: input.defaultWorkspaceName,
  });
  await getDb().query(
    `UPDATE auth_sessions SET active_tenant_id = $2, active_workspace_id = NULL WHERE id = $1`,
    [session.id, tenant.id],
  );
  session.active_tenant_id = tenant.id;
  session.active_workspace_id = null;
  await recordUserCompany(user.id, tenant.id, 'created');
  const view = await buildSessionView(session, user);
  return { tenant, session: view };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** The caller's verified tenant role (the issuer check for invite flows). */
async function requireManagerRole(ctx: TenantContext): Promise<'owner' | 'admin'> {
  const membership = await getTenantMembership(ctx, { principalId: ctx.principalId });
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new AuthError('forbidden', 'invitations require the tenant owner or admin role');
  }
  return membership.role;
}

/**
 * Create an invitation for an email address. Requires the tenant
 * owner/admin role. A superseded pending invitation for the same email is
 * revoked first (one live invite per email per company). The raw code is
 * returned exactly once; only its digest is stored.
 */
export async function createInvite(
  ctx: TenantContext,
  input: CreateInviteInput,
): Promise<IssuedInvite> {
  await requireManagerRole(ctx);
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const email = assertEmail(input.email, 'email');
  const role = assertInvitableRole(input.role);
  const workspaceId = assertOptionalWorkspaceId(input.workspaceId);
  if (workspaceId !== null) {
    await getWorkspace(ctx, workspaceId);
  }
  const timestamp = now();
  await getDb().query(
    `UPDATE auth_invites SET status = 'revoked'
       WHERE tenant_id = $1 AND email = $2 AND status = 'pending'`,
    [ctx.tenantId, email],
  );
  const code = mintInviteCode();
  try {
    const rows = await getDb().query<InviteRow>(
      `INSERT INTO auth_invites (tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
         RETURNING id, tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at, accepted_at, accepted_by`,
      [
        ctx.tenantId,
        workspaceId,
        email,
        role,
        hashToken(code),
        ctx.principalId,
        timestamp.toISOString(),
        inviteExpiry(timestamp).toISOString(),
      ],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw new AuthError('invalid_input', 'the invitation could not be created');
    }
    return { invite: toInvite(row), code };
  } catch (error) {
    if (isUniqueViolation(error, 'auth_invites_pending_email')) {
      throw new AuthError('invalid_input', 'a pending invitation for this email already exists');
    }
    throw error;
  }
}

/**
 * The company's invitation roster (issuer view; the codes are never
 * returned). Pending invites past their expiry are lazily marked expired.
 * By default only live (pending) invitations are listed.
 */
export async function listInvites(
  ctx: TenantContext,
  input: ListInvitesInput = {},
): Promise<AuthInvite[]> {
  await requireManagerRole(ctx);
  const includeSettled = input?.includeSettled === true;
  const timestamp = now().toISOString();
  await getDb().query(
    `UPDATE auth_invites SET status = 'expired'
       WHERE tenant_id = $1 AND status = 'pending' AND expires_at <= $2`,
    [ctx.tenantId, timestamp],
  );
  const rows = await getDb().query<InviteRow>(
    `SELECT id, tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at, accepted_at, accepted_by
       FROM auth_invites WHERE tenant_id = $1 ${includeSettled ? '' : `AND status = 'pending'`}
       ORDER BY created_at DESC, id`,
    [ctx.tenantId],
  );
  return rows.rows.map(toInvite);
}

/** Revoke a pending invitation (issuer-side; terminal). */
export async function revokeInvite(ctx: TenantContext, input: RevokeInviteInput): Promise<AuthInvite> {
  await requireManagerRole(ctx);
  const inviteId = assertUuid(input?.inviteId, 'inviteId');
  const rows = await getDb().query<InviteRow>(
    `UPDATE auth_invites SET status = 'revoked'
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       RETURNING id, tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at, accepted_at, accepted_by`,
    [inviteId, ctx.tenantId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AuthError('invite_not_found', 'no pending invitation for this id in this company');
  }
  return toInvite(row);
}

/**
 * Redeem an invitation with the signed-in session: the invite's email must
 * match the session's principal, the membership grant executes through the
 * organizations contract acting AS the issuer (the invite is the issuer's
 * standing authorization), and the joined company becomes the session's
 * active selection so redemption lands straight in Aurum chat.
 * Redeeming an invite for a company the principal already belongs to is
 * idempotent (the membership grant is skipped, the invite still settles).
 */
export async function redeemInvite(
  input: RedeemInviteInput,
): Promise<AuthenticatedSession> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { session, user } = await requireLiveSession(input.token);
  const code = assertTokenShape(input.code, 'code');
  const rows = await getDb().query<InviteRow>(
    `SELECT id, tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at, accepted_at, accepted_by
       FROM auth_invites WHERE token_hash = $1`,
    [hashToken(code)],
  );
  const invite = rows.rows[0];
  if (invite === undefined || invite.status !== 'pending') {
    throw new AuthError('invite_not_found', 'this invitation is no longer usable');
  }
  if (isInviteExpired(toDate(invite.expires_at), now())) {
    await getDb().query(`UPDATE auth_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
    throw new AuthError('invite_not_found', 'this invitation is no longer usable');
  }
  if (invite.email !== user.email) {
    throw new AuthError(
      'invite_email_mismatch',
      'this invitation was issued to a different email address',
    );
  }

  // Membership grant — through the organizations contract, as the issuer.
  const invitableRole = assertInvitableRole(invite.role);
  const issuerContext = contextFor(invite.tenant_id, invite.created_by);
  try {
    await addTenantMember(issuerContext, { principalId: user.id, role: invitableRole });
  } catch (error) {
    if (error instanceof OrganizationsError && error.code === 'tenant_member_exists') {
      // Idempotent redemption: already a member — settle the invite anyway.
    } else {
      throw error;
    }
  }
  if (invite.workspace_id !== null) {
    try {
      await addWorkspaceMember(issuerContext, {
        workspaceId: invite.workspace_id,
        principalId: user.id,
        role: 'member',
      });
    } catch (error) {
      if (error instanceof OrganizationsError && error.code === 'workspace_member_exists') {
        // Idempotent: already a workspace member.
      } else {
        throw error;
      }
    }
  }

  await getDb().query(
    `UPDATE auth_invites SET status = 'accepted', accepted_at = $2, accepted_by = $3 WHERE id = $1`,
    [invite.id, now().toISOString(), user.id],
  );
  await getDb().query(
    `UPDATE auth_sessions SET active_tenant_id = $2, active_workspace_id = $3 WHERE id = $1`,
    [session.id, invite.tenant_id, invite.workspace_id],
  );
  session.active_tenant_id = invite.tenant_id;
  session.active_workspace_id = invite.workspace_id;
  await recordUserCompany(user.id, invite.tenant_id, 'invite');
  return buildSessionView(session, user);
}

/**
 * The public preview of an invitation for a code-holder (the invite
 * landing page). Only a live invitation resolves; the company name is
 * readable through the issuer's context — when the issuer no longer
 * verifies, the preview degrades to nulls rather than leaking anything.
 */
export async function getInviteByCode(
  input: GetInviteByCodeInput,
): Promise<{
  tenantName: string | null;
  workspaceName: string | null;
  email: string;
  role: 'member' | 'admin';
}> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const code = assertTokenShape(input.code, 'code');
  const rows = await getDb().query<InviteRow>(
    `SELECT id, tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at, accepted_at, accepted_by
       FROM auth_invites WHERE token_hash = $1`,
    [hashToken(code)],
  );
  const invite = rows.rows[0];
  if (invite === undefined || invite.status !== 'pending' || isInviteExpired(toDate(invite.expires_at), now())) {
    throw new AuthError('invite_not_found', 'this invitation is no longer usable');
  }
  const issuerContext = contextFor(invite.tenant_id, invite.created_by);
  let tenantName: string | null = null;
  let workspaceName: string | null = null;
  try {
    const tenant = await getTenant(issuerContext);
    tenantName = tenant.name;
    if (invite.workspace_id !== null) {
      const workspace = await getWorkspace(issuerContext, invite.workspace_id);
      workspaceName = workspace.name;
    }
  } catch {
    // The issuer no longer verifies — degrade quietly (no leak).
  }
  return { tenantName, workspaceName, email: invite.email, role: invite.role as 'member' | 'admin' };
}
