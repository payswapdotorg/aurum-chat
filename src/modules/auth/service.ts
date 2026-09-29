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
//
// W116 — WAITLIST-GATED SIGNUP: the PUBLIC signup path records an access
// request on the platform waitlist (`auth_waitlist`) instead of creating a
// principal; a platform admin accepts or declines it. `registerUser`
// below is NOT the public signup path anymore — it is the activation
// primitive behind the two admin-granted doors (a verified invitation, an
// accepted waitlist request) and the demo harness's seeded personas.

import { now } from '@/infra/clock';
import { envString } from '@/infra/config';
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
import { claimsForRole } from './claims';
import { AuthError } from './errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './passwords';
import { initialExpiry, inviteExpiry, isInviteExpired, isLive, renewal } from './policy';
import { AUTH_AUTHORITY_PLATFORM_ADMIN, PLATFORM_ADMIN_EMAILS_ENV, platformAdminEmails } from './platform-admins';
import { hashToken, mintInviteCode, mintToken } from './tokens';
import {
  assertDecisionNote,
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
  RequestAccountAccessInput,
  RevokeInviteInput,
  SelectCompanyInput,
  SelectWorkspaceInput,
  SignInInput,
  SignOutEverywhereInput,
  SignOutInput,
  SignUpInput,
  SignUpOutcome,
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
  status: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
  decided_by: string | null;
  note: string | null;
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
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status as WaitlistRequest['status'],
    requestedAt: toIso(row.requested_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    decidedBy: row.decided_by,
    note: row.note,
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
// Registration, the waitlist, and sign-in
// ---------------------------------------------------------------------------

/**
 * The ACTIVATION primitive (W116): create an active principal AND sign it
 * in. This is NOT the public signup path anymore — public signup is
 * `signUp`/`requestAccountAccess` (the waitlist). It remains exactly what
 * it always was for the two admin-granted doors: invitation redemption
 * (an invite is admin-granted trust) and waitlist acceptance (the accept
 * path copies the captured verifier, so it does not re-transmit), plus
 * the demo harness's seeded personas.
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

// --- the waitlist (W116) ---------------------------------------------------

/**
 * Record (or idempotently refresh) one waitlist access request. The scrypt
 * verifier is captured NOW so acceptance never needs a second password
 * transmission. A duplicate PENDING request for the same email replaces
 * its own pending row (latest display name, verifier and requested_at
 * win) — never a crash, never a second row, and nothing in the outcome
 * reveals whether the email was already queued. An email that already
 * carries an ACTIVE principal keeps today's honest `email_taken` (the
 * person has an account; the waitlist is not for them). Returns the
 * pending request's id.
 */
export async function requestAccountAccess(
  input: RequestAccountAccessInput,
): Promise<string> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const displayName = assertDisplayName(input.displayName, 'displayName');
  const email = assertEmail(input.email, 'email');
  const password = assertPasswordPolicy(input.password);
  const passwordHash = hashPassword(password);
  const timestamp = now().toISOString();
  if ((await findUserByEmail(email)) !== null) {
    throw new AuthError('email_taken', `the email '${email}' is already registered`);
  }
  const refreshed = await getDb().query<{ id: string }>(
    `UPDATE auth_waitlist SET display_name = $2, password_hash = $3, requested_at = $4
       WHERE email = $1 AND status = 'pending' RETURNING id`,
    [email, displayName, passwordHash, timestamp],
  );
  if (refreshed.rows[0] !== undefined) return refreshed.rows[0].id;
  try {
    const inserted = await getDb().query<{ id: string }>(
      `INSERT INTO auth_waitlist (email, display_name, password_hash, requested_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, displayName, passwordHash, timestamp],
    );
    return inserted.rows[0]!.id;
  } catch (error) {
    if (isUniqueViolation(error, 'auth_waitlist_pending_email')) {
      // Raced a concurrent re-request — refresh the winner gracefully.
      const raced = await getDb().query<{ id: string }>(
        `UPDATE auth_waitlist SET display_name = $2, password_hash = $3, requested_at = $4
           WHERE email = $1 AND status = 'pending' RETURNING id`,
        [email, displayName, passwordHash, timestamp],
      );
      if (raced.rows[0] !== undefined) return raced.rows[0].id;
    }
    throw error;
  }
}

/**
 * The waitlist state an unregistered email may be in: the pending request
 * when one exists, else the most recent declined request. Purely internal
 * — only `signIn` consults it, and only after the password verifier
 * matched (the no-leak doctrine).
 */
async function findWaitlistStateByEmail(
  email: string,
): Promise<{ status: 'pending' | 'declined'; password_hash: string; note: string | null } | null> {
  const rows = await getDb().query<{
    status: string;
    password_hash: string;
    note: string | null;
  }>(
    `SELECT status, password_hash, note FROM auth_waitlist
       WHERE email = $1 AND status IN ('pending', 'declined')
       ORDER BY (status = 'pending') DESC, requested_at DESC, id
       LIMIT 1`,
    [email],
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  return {
    status: row.status === 'pending' ? 'pending' : 'declined',
    password_hash: row.password_hash,
    note: row.note,
  };
}

/** A live (pending, unexpired) invitation row for a raw code, or null. */
async function findLiveInviteRow(code: string): Promise<InviteRow | null> {
  const rows = await getDb().query<InviteRow>(
    `SELECT id, tenant_id, workspace_id, email, role, token_hash, status, created_by, created_at, expires_at, accepted_at, accepted_by
       FROM auth_invites WHERE token_hash = $1`,
    [hashToken(code)],
  );
  const invite = rows.rows[0];
  if (invite === undefined || invite.status !== 'pending') return null;
  if (isInviteExpired(toDate(invite.expires_at), now())) return null;
  return invite;
}

/**
 * The PUBLIC signup (W116). Without a usable invitation the request lands
 * on the waitlist — no principal, no session, the person sees the signed-
 * out waitlist confirmation. A LIVE invitation bound to the same email
 * bypasses the waitlist (an invite is already admin-granted trust) and
 * keeps today's immediate-access behavior exactly: register + redeem in
 * one operation. A live invitation bound to a DIFFERENT email is the
 * honest mismatch error; a dead code carries no trust and falls through
 * to the waitlist (the signup page has already said the link is unusable).
 */
export async function signUp(input: SignUpInput): Promise<SignUpOutcome> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const displayName = assertDisplayName(input.displayName, 'displayName');
  const email = assertEmail(input.email, 'email');
  const password = assertPasswordPolicy(input.password);
  const inviteCode =
    input.inviteCode === undefined || input.inviteCode === null || input.inviteCode === ''
      ? null
      : assertTokenShape(input.inviteCode, 'inviteCode');
  if (inviteCode !== null) {
    const invite = await findLiveInviteRow(inviteCode);
    if (invite !== null) {
      if (invite.email !== email) {
        throw new AuthError(
          'invite_email_mismatch',
          'this invitation was issued to a different email address',
        );
      }
      const issued = await registerUser({ displayName, email, password });
      let notice: string | null = null;
      try {
        await redeemInvite({ token: issued.token, code: inviteCode });
      } catch (error) {
        // Same honest semantics as the pre-W116 surface: the session is
        // live, the redemption failed — the client lands in onboarding
        // with the notice.
        notice = error instanceof Error ? error.message : 'the invitation could not be redeemed';
      }
      const session = await authenticateSession({ token: issued.token });
      return { outcome: 'session', session, token: issued.token, notice };
    }
  }
  await requestAccountAccess({ displayName, email, password });
  return { outcome: 'waitlisted', email, notice: null };
}

// --- platform admins (W116) ------------------------------------------------

/**
 * The env bootstrap grant: on SIGN-IN of an active account, a matching
 * AURUM_PLATFORM_ADMIN_EMAILS entry grants the platform-admin flag (fail
 * closed when the variable is unset). The write-through persists the
 * grant; the in-memory row is kept honest for the session view built in
 * the same sign-in.
 */
async function applyPlatformAdminEnvGrant(user: UserRow): Promise<void> {
  if (user.is_platform_admin === true) return;
  const emails = platformAdminEmails(envString(PLATFORM_ADMIN_EMAILS_ENV));
  if (!emails.has(user.email)) return;
  await getDb().query(
    `UPDATE auth_users SET is_platform_admin = true, updated_at = $2 WHERE id = $1`,
    [user.id, now().toISOString()],
  );
  user.is_platform_admin = true;
}

/**
 * The platform-admin floor for the waitlist operations: a live session
 * whose principal carries the platform-admin flag, or the uniform
 * `forbidden` (a signed-in regular user learns only that the operation
 * is not theirs — the same quiet the tenant role gates keep).
 */
async function requirePlatformAdmin(
  token: string,
): Promise<{ session: SessionRow; user: UserRow }> {
  const { session, user } = await requireLiveSession(token);
  if (user.is_platform_admin !== true) {
    throw new AuthError('forbidden', 'this operation requires the platform admin role');
  }
  return { session, user };
}

/**
 * Designate (or undesignate) a platform admin by email — the seed-time
 * path, claim-gated on 'auth:platform-admin' exactly like the
 * organizations module's provisioner claim: the claim never rides a
 * session, it exists only on an explicitly constructed PlatformContext
 * (the demo harness builds one while seeding). Idempotent per email.
 */
export async function setPlatformAdmin(
  ctx: PlatformContext,
  input: { email: string; platformAdmin: boolean },
): Promise<void> {
  if (ctx === null || typeof ctx !== 'object' || !Array.isArray(ctx.authority)) {
    throw new AuthError('invalid_input', 'ctx must be a PlatformContext');
  }
  assertUuid(ctx.principalId, 'ctx.principalId');
  if (!ctx.authority.includes(AUTH_AUTHORITY_PLATFORM_ADMIN)) {
    throw new AuthError(
      'forbidden',
      `this operation requires the '${AUTH_AUTHORITY_PLATFORM_ADMIN}' authority claim`,
    );
  }
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  if (typeof input.platformAdmin !== 'boolean') {
    throw new AuthError('invalid_input', 'platformAdmin must be a boolean');
  }
  const email = assertEmail(input.email, 'email');
  const rows = await getDb().query<{ id: string }>(
    `UPDATE auth_users SET is_platform_admin = $2, updated_at = $3
       WHERE email = $1 RETURNING id`,
    [email, input.platformAdmin, now().toISOString()],
  );
  if (rows.rows[0] === undefined) {
    throw new AuthError('invalid_input', `no principal exists for '${email}'`);
  }
}

/** The admin's waitlist roster: every request, pending first (FIFO). */
export async function listWaitlist(input: ListWaitlistInput): Promise<WaitlistRequest[]> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  await requirePlatformAdmin(input.token);
  const rows = await getDb().query<WaitlistRow>(
    `SELECT id, email, display_name, status, requested_at, decided_at, decided_by, note
       FROM auth_waitlist
       ORDER BY (status = 'pending') DESC, requested_at ASC, id`,
  );
  return rows.rows.map(toWaitlistRequest);
}

/**
 * One admin decision on a pending request. ACCEPT creates the principal
 * from the verifier captured at request time (an email that already
 * carries an active principal — an invite let the person in first —
 * settles without a duplicate); DECLINE records the optional one-line
 * note the requester sees on their next sign-in attempt. Both decisions
 * are auditable: decided_at + decided_by (the admin's principal id).
 */
export async function decideWaitlistRequest(
  input: DecideWaitlistInput,
): Promise<WaitlistRequest> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { user: admin } = await requirePlatformAdmin(input.token);
  const requestId = assertUuid(input.requestId, 'requestId');
  if (input.decision !== 'accept' && input.decision !== 'decline') {
    throw new AuthError('invalid_input', 'decision must be "accept" or "decline"');
  }
  const note = assertDecisionNote(input.note);
  const pendingRows = await getDb().query<WaitlistRow & { password_hash: string }>(
    `SELECT id, email, display_name, password_hash, status, requested_at, decided_at, decided_by, note
       FROM auth_waitlist WHERE id = $1 AND status = 'pending'`,
    [requestId],
  );
  const pending = pendingRows.rows[0];
  if (pending === undefined) {
    throw new AuthError('waitlist_not_found', 'no pending access request for this id');
  }
  if (input.decision === 'accept' && (await findUserByEmail(pending.email)) === null) {
    const timestamp = now().toISOString();
    try {
      await getDb().query(
        `INSERT INTO auth_users (email, display_name, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
        [pending.email, pending.display_name, pending.password_hash, timestamp],
      );
    } catch (error) {
      if (!isUniqueViolation(error, 'auth_users_email_unique')) throw error;
      // Raced an invite-path activation — the principal exists; settle.
    }
  }
  const decided = await getDb().query<WaitlistRow>(
    `UPDATE auth_waitlist
        SET status = $2, decided_at = $3, decided_by = $4, note = $5
      WHERE id = $1 AND status = 'pending'
      RETURNING id, email, display_name, status, requested_at, decided_at, decided_by, note`,
    [
      requestId,
      input.decision === 'accept' ? 'accepted' : 'declined',
      now().toISOString(),
      admin.id,
      note,
    ],
  );
  const row = decided.rows[0];
  if (row === undefined) {
    throw new AuthError('waitlist_not_found', 'no pending access request for this id');
  }
  return toWaitlistRequest(row);
}

// --- sign-in (with the W116 waitlist states) --------------------------------

/**
 * Sign in with email + password. Unknown email and wrong password are the
 * SAME error (invalid_credentials) — account existence never leaks. The
 * W116 waitlist states are visible ONLY after the requester proved
 * password knowledge against the captured verifier: a pending request
 * reads "awaiting admin approval", a declined one reads "declined" (with
 * the admin's note when present); without that proof everything stays the
 * uniform invalid-credentials error.
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
    await applyPlatformAdminEnvGrant(user);
    const token = await issueSession(user.id);
    const { session } = await requireLiveSession(token);
    await autoSelectMostRecentCompany(session);
    const view = await buildSessionView(session, user);
    return { session: view, token };
  }
  const request = await findWaitlistStateByEmail(email);
  if (request !== null && verifyPassword(password, request.password_hash)) {
    if (request.status === 'pending') {
      throw new AuthError(
        'account_pending',
        'your access request is awaiting admin approval',
      );
    }
    throw new AuthError(
      'account_declined',
      request.note === null
        ? 'your access request was declined'
        : `your access request was declined — ${request.note}`,
    );
  }
  throw new AuthError('invalid_credentials', 'email or password is incorrect');
}

// --- password change + sign out everywhere (W116) ---------------------------

/**
 * Change the password of the session's principal (current + new; the
 * current one must verify — a wrong current password is the uniform
 * invalid_credentials). Session doctrine (documented in the module
 * README): every OTHER session of the principal is revoked; the session
 * that performed the change stays signed in — the person is mid-flow,
 * and everyone else is honestly booted to sign in again.
 */
export async function changePassword(
  input: ChangePasswordInput,
): Promise<AuthenticatedSession> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { session, user } = await requireLiveSession(input.token);
  const currentPassword = assertPasswordPolicy(input.currentPassword);
  const newPassword = assertPasswordPolicy(input.newPassword);
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw new AuthError('invalid_credentials', 'the current password is incorrect');
  }
  await getDb().query(
    `UPDATE auth_users SET password_hash = $2, updated_at = $3 WHERE id = $1`,
    [user.id, hashPassword(newPassword), now().toISOString()],
  );
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $3
       WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
    [user.id, session.id, now().toISOString()],
  );
  return buildSessionView(session, user);
}

/**
 * Sign out everywhere: revoke EVERY session of the principal (including
 * the current one). Deliberately idempotent and uniformly quiet, exactly
 * like signOut.
 */
export async function signOutEverywhere(input: SignOutEverywhereInput): Promise<void> {
  if (input === null || typeof input !== 'object') {
    throw new AuthError('invalid_input', 'input must be an object');
  }
  const { session } = await requireLiveSession(input.token);
  await getDb().query(
    `UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [session.user_id, now().toISOString()],
  );
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
