// W058 — the auth API surface's handler logic.
//
// The /api/auth/* route handlers are thin adapters (IMPLEMENTATION-STACK
// §5); everything lives here so the whole surface is testable without
// booting Next.js (the tower/product discipline). Handlers take a
// `Request` (+ parsed body) and return `{ status, body, setCookie? }` —
// the route wraps it in a NextResponse and applies the Set-Cookie.
//
// The API is the product's ONLY write path for accounts, sessions,
// company selection and invitations — and the seam the client chrome uses
// to switch company/workspace without any URL scope parameter (the W058
// acceptance: no development tenant parameter in authenticated UX).

import {
  acceptInvitation,
  AuthError,
  createCompany,
  createInvitation,
  inspectInvitation,
  listInvitations,
  listReachableTenants,
  renewSession,
  resolveSession,
  revokeInvitation,
  selectWorkspace,
  SESSION_TTL_SECONDS,
  signIn,
  signOut,
  signOutEverywhere,
  signUp,
  switchTenant,
} from '@/modules/auth/contract';
import type { ResolvedSession } from '@/modules/auth/contract';
import {
  requestWithSession,
  resolveRequestScope,
  sessionTokenFromRequest,
} from '@/app/lib/request-session';
import { clearedSessionCookie, sessionCookie } from '@/app/lib/session-cookie';

export interface AuthApiResult {
  status: number;
  body: unknown;
  setCookie?: string;
}

function ok(body: Record<string, unknown>, setCookie?: string): AuthApiResult {
  return setCookie === undefined ? { status: 200, body } : { status: 200, body, setCookie };
}

function error(status: number, code: string, message: string): AuthApiResult {
  return { status, body: { error: code, message } };
}

/** Map an AuthError to an HTTP-ish outcome (code-carrying errors only). */
export function authApiError(failure: unknown): AuthApiResult {
  if (failure instanceof AuthError) {
    switch (failure.code) {
      case 'invalid_input':
        return error(400, failure.code, failure.message);
      case 'unauthorized':
      case 'session_expired':
      case 'principal_disabled':
      case 'invalid_credentials':
        return error(401, failure.code, failure.message);
      case 'forbidden':
      case 'invitation_email_mismatch':
      case 'grant_failed':
      case 'tenant_unavailable':
      case 'workspace_unavailable':
        return error(403, failure.code, failure.message);
      case 'email_taken':
      case 'slug_taken':
      case 'invitation_not_pending':
      case 'invitation_expired':
      case 'no_active_tenant':
        return error(409, failure.code, failure.message);
      case 'invitation_not_found':
        return error(404, failure.code, failure.message);
    }
  }
  const message = failure instanceof Error ? failure.message : 'unexpected auth failure';
  return error(500, 'internal', message);
}

/** The 401 answer for a request without a usable session. */
function unauthenticated(): AuthApiResult {
  return error(401, 'unauthenticated', 'sign in to use Aurum');
}

/** The 409 answer for a session without an active company. */
function noActiveTenant(): AuthApiResult {
  return error(409, 'no_active_tenant', 'choose or create a company first');
}

/** Parse a JSON object body ({} for empty bodies; null for bad JSON). */
export async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Accounts & sessions
// ---------------------------------------------------------------------------

/** POST /api/auth/sign-up {email, password, displayName} */
export async function handleSignUp(request: Request, body: unknown): Promise<AuthApiResult> {
  try {
    const result = await signUp(body as { email: string; password: string; displayName: string });
    return ok(
      {
        principal: {
          email: result.principal.email,
          displayName: result.principal.displayName,
        },
      },
      sessionCookie(result.token, SESSION_TTL_SECONDS),
    );
  } catch (failure) {
    return authApiError(failure);
  }
}

/** POST /api/auth/sign-in {email, password} */
export async function handleSignIn(request: Request, body: unknown): Promise<AuthApiResult> {
  try {
    const result = await signIn(body as { email: string; password: string });
    return ok(
      {
        principal: {
          email: result.principal.email,
          displayName: result.principal.displayName,
        },
      },
      sessionCookie(result.token, SESSION_TTL_SECONDS),
    );
  } catch (failure) {
    return authApiError(failure);
  }
}

/** POST /api/auth/sign-out (revokes this session and clears the cookie). */
export async function handleSignOut(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token !== null) {
    try {
      await signOut(token);
    } catch {
      // An unknown/expired token signs out just as well (cookie cleared).
    }
  }
  return ok({ signedOut: true }, clearedSessionCookie());
}

/** POST /api/auth/sign-out-all (revokes EVERY session of the account). */
export async function handleSignOutAll(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token !== null) {
    try {
      await signOutEverywhere(token);
    } catch {
      // Same quiet treatment as sign-out.
    }
  }
  return ok({ signedOut: true }, clearedSessionCookie());
}

/** The session summary the client chrome renders. */
export interface SessionApiView {
  authenticated: true;
  principal: { email: string; displayName: string };
  tenant: { id: string; name: string; slug: string; role: string } | null;
  workspace: { id: string; name: string; slug: string } | null;
  sessionExpiresAt: string;
  tenants: { id: string; name: string; slug: string; role: string }[];
}

function sessionView(resolved: ResolvedSession): Omit<SessionApiView, 'tenants'> {
  return {
    authenticated: true,
    principal: {
      email: resolved.principal.email,
      displayName: resolved.principal.displayName,
    },
    tenant: resolved.tenant,
    workspace: resolved.workspace,
    sessionExpiresAt: resolved.session.expiresAt,
  };
}

/** GET /api/auth/session — the current session + reachable companies. */
export async function handleSessionGet(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return error(401, 'unauthenticated', 'sign in to use Aurum');
  try {
    const resolution = await resolveSession(token);
    if (resolution.status !== 'valid') {
      return error(401, 'unauthenticated', 'sign in to use Aurum');
    }
    const tenants = await listReachableTenants(token);
    return ok({
      ...sessionView(resolution.resolved),
      tenants: tenants.map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        role: tenant.role,
      })),
    });
  } catch (failure) {
    return authApiError(failure);
  }
}

/** POST /api/auth/session/renew — explicit renewal. */
export async function handleSessionRenew(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return error(401, 'unauthenticated', 'sign in to use Aurum');
  try {
    const renewed = await renewSession(token);
    return ok({ expiresAt: renewed.expiresAt }, sessionCookie(token, SESSION_TTL_SECONDS));
  } catch (failure) {
    return authApiError(failure);
  }
}

// ---------------------------------------------------------------------------
// Company onboarding & selection
// ---------------------------------------------------------------------------

/** POST /api/auth/company {name, slug?, defaultWorkspaceName?} */
export async function handleCompanyCreate(
  request: Request,
  body: unknown,
): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return error(401, 'unauthenticated', 'sign in to use Aurum');
  try {
    const { tenant, workspace } = await createCompany(
      token,
      body as { name: string; slug?: string; defaultWorkspaceName?: string },
    );
    return ok({ tenant, workspace });
  } catch (failure) {
    return authApiError(failure);
  }
}

/** POST /api/auth/tenant/switch {tenantId} */
export async function handleTenantSwitch(request: Request, body: unknown): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return error(401, 'unauthenticated', 'sign in to use Aurum');
  try {
    const resolved = await switchTenant(token, body as { tenantId: string });
    return ok({ tenant: resolved.tenant, workspace: resolved.workspace });
  } catch (failure) {
    return authApiError(failure);
  }
}

/** POST /api/auth/workspace/select {workspaceId} */
export async function handleWorkspaceSelect(
  request: Request,
  body: unknown,
): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return error(401, 'unauthenticated', 'sign in to use Aurum');
  try {
    const resolved = await selectWorkspace(token, body as { workspaceId: string });
    return ok({ tenant: resolved.tenant, workspace: resolved.workspace });
  } catch (failure) {
    return authApiError(failure);
  }
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** GET /api/auth/invitations — the active company's roster (owner/admin). */
export async function handleInvitationsGet(request: Request): Promise<AuthApiResult> {
  const scope = await resolveRequestScope(request);
  if (scope.phase === 'unauthenticated') return unauthenticated();
  if (scope.phase === 'no_active_tenant') return noActiveTenant();
  try {
    const invitations = await listInvitations(scope.context);
    return ok({ invitations });
  } catch (failure_) {
    return authApiError(failure_);
  }
}

/** POST /api/auth/invitations {email, tenantRole, workspaceId?, workspaceRole?} */
export async function handleInvitationCreate(
  request: Request,
  body: unknown,
): Promise<AuthApiResult> {
  const scope = await resolveRequestScope(request);
  if (scope.phase === 'unauthenticated') return unauthenticated();
  if (scope.phase === 'no_active_tenant') return noActiveTenant();
  try {
    const created = await createInvitation(
      scope.context,
      body as {
        email: string;
        tenantRole: 'owner' | 'admin' | 'member';
        workspaceId?: string;
        workspaceRole?: 'admin' | 'member';
      },
    );
    return ok({
      // The roster row carries no token; the invite link appears once.
      invitation: { ...created, token: undefined },
      inviteToken: created.token,
    });
  } catch (failure_) {
    return authApiError(failure_);
  }
}

/** POST /api/auth/invitations/revoke {invitationId} */
export async function handleInvitationRevoke(
  request: Request,
  body: unknown,
): Promise<AuthApiResult> {
  const scope = await resolveRequestScope(request);
  if (scope.phase === 'unauthenticated') return unauthenticated();
  if (scope.phase === 'no_active_tenant') return noActiveTenant();
  try {
    const revoked = await revokeInvitation(scope.context, body as { invitationId: string });
    return ok({ invitation: revoked });
  } catch (failure_) {
    return authApiError(failure_);
  }
}

/**
 * POST /api/auth/invitations/inspect {token} — PUBLIC (the invite token
 * itself is the authorization; possession doctrine). Used by the invite
 * page before sign-in.
 */
export async function handleInvitationInspect(
  request: Request,
  body: unknown,
): Promise<AuthApiResult> {
  try {
    const inspected = await inspectInvitation((body as { token?: string })?.token);
    return ok({ invitation: inspected });
  } catch (failure) {
    return authApiError(failure);
  }
}

/** POST /api/auth/invitations/accept {invitationToken} — session required. */
export async function handleInvitationAccept(
  request: Request,
  body: unknown,
): Promise<AuthApiResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return error(401, 'unauthenticated', 'sign in to accept an invitation');
  try {
    const accepted = await acceptInvitation(token, body as { invitationToken: string });
    return ok({
      tenant: accepted.tenant,
      workspace: accepted.workspace,
      workspaceAdded: accepted.workspaceAdded,
    });
  } catch (failure) {
    return authApiError(failure);
  }
}

// ---------------------------------------------------------------------------
// Fixture convenience (tests build cookie-carrying Requests through it)
// ---------------------------------------------------------------------------

export { requestWithSession };
