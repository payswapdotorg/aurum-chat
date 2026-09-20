// Auth API (W058) — the request handling for /api/auth/**.
//
// The same thin-adapter discipline the tower and the product shell follow
// (IMPLEMENTATION-STACK §5): the route.ts files do nothing but translate
// HTTP; all logic lives here and is testable without booting Next.js.
// Authentication is the SESSION COOKIE (resolved through the app-layer
// session module → the auth contract → the organizations contract), never
// a query parameter or a header seam.
//
// Outcomes:
//   * anonymous requests are uniformly 401 (no leak about which part failed);
//   * a live session without an active company is 409 no_active_company
//     (the client routes to onboarding);
//   * module errors map to honest HTTP-ish codes (mapAuthApiError).

import { SESSION_COOKIE, resolveSessionRequest, sessionTokenFromCookieHeader } from '@/app/lib/session';
import {
  authenticateSession,
  createCompanyForSession,
  createInvite,
  listInvites,
  redeemInvite,
  registerUser,
  revokeInvite,
  selectCompany,
  selectWorkspace,
  signIn,
  signOut,
} from '@/modules/auth/contract';
import { AuthError } from '@/modules/auth/contract';
import type { AuthenticatedSession } from '@/modules/auth/contract';
import { sessionCookieHeader } from './cookies';

export interface AuthApiResult {
  status: number;
  body: Record<string, unknown>;
  /** Set-Cookie value to attach (sign-in/sign-up). */
  setCookie?: string;
  /** Attach the cookie-clearing Set-Cookie (sign-out). */
  clearCookie?: boolean;
}

function ok(body: Record<string, unknown>, extra?: Partial<AuthApiResult>): AuthApiResult {
  return { status: 200, body, ...extra };
}

function fail(
  status: number,
  error: string,
  message: string,
): AuthApiResult {
  return { status, body: { error, message } };
}

/** Map a module error to an API outcome (code-carrying errors only). */
export function mapAuthApiError(error: unknown): AuthApiResult {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected auth failure';
  if (code === null) {
    return fail(500, 'internal', message);
  }
  switch (code) {
    case 'unauthenticated':
    case 'invalid_credentials':
      return fail(401, code, message);
    case 'forbidden':
      return fail(403, code, message);
    case 'no_active_company':
    case 'email_taken':
    case 'tenant_slug_taken':
    case 'invite_email_mismatch':
    case 'invite_already_accepted':
    case 'already_a_member':
      return fail(409, code, message);
    case 'company_not_available':
    case 'workspace_not_available':
    case 'invite_not_found':
      return fail(404, code, message);
    default:
      if (code.endsWith('_not_found')) return fail(404, code, message);
      return fail(400, code, message);
  }
}

/** The session view the client consumes (company/role/claims included). */
function sessionBody(session: AuthenticatedSession): Record<string, unknown> {
  return {
    principal: session.principal,
    company: session.company,
    expiresAt: session.expiresAt,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new AuthError('invalid_input', `${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Try redeeming an invitation attached to a fresh sign-in/registration.
 * Failure is NOT fatal: the session is live, so the client receives a
 * notice and continues to onboarding (the honest state).
 */
async function tryRedeem(
  token: string,
  inviteCode: string | null,
): Promise<string | null> {
  if (inviteCode === null) return null;
  try {
    await redeemInvite({ token, code: inviteCode });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the invitation could not be redeemed';
    return message;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /api/auth/sign-up — register + sign in (+ optional invite redemption). */
export async function handleSignUp(request: Request): Promise<AuthApiResult> {
  const body = await readJson(request);
  try {
    const inviteCode = typeof body['inviteCode'] === 'string' && body['inviteCode'] !== ''
      ? (body['inviteCode'] as string)
      : null;
    const issued = await registerUser({
      displayName: requireString(body, 'displayName'),
      email: requireString(body, 'email'),
      password: requireString(body, 'password'),
    });
    const notice = await tryRedeem(issued.token, inviteCode);
    // The fresh view (redemption may have selected a company post-issue).
    const session = await authenticateSession({ token: issued.token });
    return ok(
      { session: sessionBody(session), ...(notice === null ? {} : { notice }) },
      { setCookie: sessionCookieHeader(issued.token) },
    );
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/auth/sign-in — sign in (+ optional invite redemption). */
export async function handleSignIn(request: Request): Promise<AuthApiResult> {
  const body = await readJson(request);
  try {
    const inviteCode = typeof body['inviteCode'] === 'string' && body['inviteCode'] !== ''
      ? (body['inviteCode'] as string)
      : null;
    const issued = await signIn({
      email: requireString(body, 'email'),
      password: requireString(body, 'password'),
    });
    const notice = await tryRedeem(issued.token, inviteCode);
    // The fresh view (redemption may have selected a company post-issue).
    const session = await authenticateSession({ token: issued.token });
    return ok(
      { session: sessionBody(session), ...(notice === null ? {} : { notice }) },
      { setCookie: sessionCookieHeader(issued.token) },
    );
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/auth/sign-out — revoke the session, clear the cookie. */
export async function handleSignOut(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token !== null) {
    try {
      await signOut({ token });
    } catch {
      // Uniformly quiet: an unknown/revoked token is still signed out.
    }
  }
  return ok({ signedOut: true }, { clearCookie: true });
}

/** GET /api/auth/session — the current session view (companies included). */
export async function handleSessionGet(request: Request): Promise<AuthApiResult> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  return ok({
    status: resolution.status,
    principal: resolution.principal,
    company:
      resolution.status === 'authenticated'
        ? {
            tenantId: resolution.context.tenantId,
            workspaceId: resolution.workspaceId,
            role: resolution.role,
            authority: resolution.context.authority,
          }
        : null,
    companies: resolution.companies,
  });
}

/** POST /api/auth/session/selection — switch the active company/workspace. */
export async function handleSelectionPost(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  const body = await readJson(request);
  try {
    let session: AuthenticatedSession;
    if (typeof body['tenantId'] === 'string' && body['tenantId'] !== '') {
      session = await selectCompany({ token, tenantId: body['tenantId'] });
    } else if (body['workspaceId'] === undefined || body['workspaceId'] === null) {
      session = await selectWorkspace({ token, workspaceId: null });
    } else {
      if (typeof body['workspaceId'] !== 'string') {
        throw new AuthError('invalid_input', 'workspaceId must be a uuid or null');
      }
      session = await selectWorkspace({ token, workspaceId: body['workspaceId'] });
    }
    return ok({ session: sessionBody(session) });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/auth/onboarding/company — create (and select) a company. */
export async function handleCompanyCreatePost(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  const body = await readJson(request);
  try {
    const { tenant, session } = await createCompanyForSession({
      token,
      name: requireString(body, 'name'),
      slug: typeof body['slug'] === 'string' && body['slug'] !== '' ? body['slug'] : undefined,
      defaultWorkspaceName:
        typeof body['defaultWorkspaceName'] === 'string' && body['defaultWorkspaceName'] !== ''
          ? body['defaultWorkspaceName']
          : undefined,
    });
    return ok({ tenant, session: sessionBody(session) });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/auth/invite — create an invitation (issuer view; code shown once). */
export async function handleInviteCreatePost(request: Request): Promise<AuthApiResult> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  if (resolution.status === 'no-company') {
    return fail(409, 'no_active_company', 'select a company before inviting people');
  }
  const body = await readJson(request);
  try {
    const issued = await createInvite(resolution.context, {
      email: requireString(body, 'email'),
      role: body['role'] === 'admin' ? 'admin' : 'member',
      workspaceId:
        typeof body['workspaceId'] === 'string' && body['workspaceId'] !== ''
          ? body['workspaceId']
          : null,
    });
    return ok({ invite: issued.invite, code: issued.code });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** GET /api/auth/invite — the company's invitation roster. */
export async function handleInviteListGet(request: Request): Promise<AuthApiResult> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  if (resolution.status === 'no-company') {
    return fail(409, 'no_active_company', 'select a company before listing invitations');
  }
  try {
    const url = new URL(request.url);
    const includeSettled = url.searchParams.get('includeSettled') === '1';
    const invites = await listInvites(resolution.context, { includeSettled });
    return ok({ invites });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/auth/invite/revoke — revoke a pending invitation. */
export async function handleInviteRevokePost(request: Request): Promise<AuthApiResult> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  if (resolution.status === 'no-company') {
    return fail(409, 'no_active_company', 'select a company before revoking invitations');
  }
  const body = await readJson(request);
  try {
    const invite = await revokeInvite(resolution.context, {
      inviteId: requireString(body, 'inviteId'),
    });
    return ok({ invite });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/auth/invite/redeem — redeem an invitation with the session. */
export async function handleInviteRedeemPost(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return fail(401, 'unauthenticated', 'no session for this request');
  }
  const body = await readJson(request);
  try {
    const session = await redeemInvite({
      token,
      code: requireString(body, 'code'),
    });
    return ok({ session: sessionBody(session) });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** Exported for route tests: the cookie name (kept in sync with the shell). */
export { SESSION_COOKIE };
