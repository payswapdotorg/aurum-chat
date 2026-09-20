// Integration tests for the W058 auth app surface: the /api/auth handlers
// (thin adapters over the auth contract) and the request-side session
// resolution every authenticated surface shares. Runs against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port.
//
// Covers the W058 acceptance at the PRODUCT boundary:
//   * sign-in/sign-up set an HttpOnly session cookie; bad credentials are
//     uniform 401s (no enumeration);
//   * the session cookie is the ONLY scope source — requests without one
//     get 401 and never tenant data;
//   * company creation + tenant switching through the API, with the
//     membership gate (cross-scope switching is a 403);
//   * the invitation loop: create (token shown once) → inspect (public,
//     possession doctrine) → accept (email-bound) → the session lands in
//     the joined company;
//   * sign-out revokes and clears.
//
// CREDENTIAL HYGIENE: fake credentials are assembled from fragments at
// runtime — never a realistic full literal in source.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { runMigrations } from '../../../../scripts/migrate';
import { SESSION_COOKIE_NAME } from '@/app/lib/session-cookie';
import { AuthError } from '@/modules/auth/contract';
import {
  requestWithSession,
  resolveRequestScope,
} from '@/app/lib/request-session';
import {
  authApiError,
  handleCompanyCreate,
  handleInvitationAccept,
  handleInvitationCreate,
  handleInvitationInspect,
  handleInvitationsGet,
  handleSessionGet,
  handleSignIn,
  handleSignOut,
  handleSignUp,
  handleTenantSwitch,
  handleWorkspaceSelect,
} from '../lib/auth-api';

const BASE = 'https://aurum.test';

function fakeEmail(): string {
  return [newId().slice(0, 8), 'authapi', 'test'].join('.') + '@example.invalid';
}

function fakePassword(): string {
  return ['auth', 'api', newId().slice(0, 6)].join('-');
}

/** A POST Request with a JSON body (and optional session cookie). */
function post(path: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['cookie'] = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('the auth API handlers', () => {
  it('sign-up opens a session and sets the HttpOnly cookie', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    const result = await handleSignUp(post('/api/auth/sign-up', { email, password, displayName: 'Dana' }), {
      email,
      password,
      displayName: 'Dana',
    });
    expect(result.status).toBe(200);
    expect(result.setCookie).toBeDefined();
    expect(result.setCookie!.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(result.setCookie!).toContain('HttpOnly');
    expect(result.setCookie!).toContain('SameSite=Lax');
  });

  it('sign-in with wrong credentials is a uniform 401 (no enumeration)', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    await handleSignUp(post('/api/auth/sign-up', { email, password, displayName: 'A' }), {
      email,
      password,
      displayName: 'A',
    });
    const wrong = await handleSignIn(
      post('/api/auth/sign-in', { email, password: `${password}!` }),
      { email, password: `${password}!` },
    );
    const unknown = await handleSignIn(
      post('/api/auth/sign-in', { email: fakeEmail(), password }),
      { email: fakeEmail(), password },
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    if (wrong.status === 401 && unknown.status === 401) {
      expect((wrong.body as { error: string }).error).toBe('invalid_credentials');
      expect((unknown.body as { error: string }).error).toBe('invalid_credentials');
    }
  });

  it('the full onboarding path: company → session → switch → workspace', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    const signUpResult = await handleSignUp(
      post('/api/auth/sign-up', { email, password, displayName: 'Founder' }),
      { email, password, displayName: 'Founder' },
    );
    const token = sessionCookieValue(signUpResult.setCookie);

    // No active company yet: the session endpoint says so, and the
    // switch/create surfaces see an unscoped session.
    const sessionBefore = await handleSessionGet(requestWithSession(`${BASE}/api/auth/session`, token));
    expect(sessionBefore.status).toBe(200);
    if (sessionBefore.status === 200) {
      const body = sessionBefore.body as { tenant: unknown; tenants: unknown[] };
      expect(body.tenant).toBeNull();
      expect(body.tenants).toEqual([]);
    }

    // Create the company through the API.
    const companyName = `Handler Co ${newId().slice(0, 6)}`;
    const created = await handleCompanyCreate(
      post('/api/auth/company', { name: companyName }, token),
      { name: companyName },
    );
    expect(created.status).toBe(200);
    const firstWorkspace = (created.body as { workspace: { id: string; slug: string } | null }).workspace;
    expect(firstWorkspace?.slug).toBe('default');

    const sessionAfter = await handleSessionGet(requestWithSession(`${BASE}/api/auth/session`, token));
    expect(sessionAfter.status).toBe(200);
    if (sessionAfter.status === 200) {
      const body = sessionAfter.body as {
        tenant: { name: string; role: string } | null;
        workspace: { slug: string } | null;
      };
      expect(body.tenant?.name).toBe(companyName);
      expect(body.tenant?.role).toBe('owner');
      expect(body.workspace?.slug).toBe('default');
    }

    // Workspace selection inside the active company.
    const selected = await handleWorkspaceSelect(
      post('/api/auth/workspace/select', { workspaceId: firstWorkspace!.id }, token),
      { workspaceId: firstWorkspace!.id },
    );
    expect(selected.status).toBe(200);

    // A second company; switching between them resets the workspace.
    const secondName = `Second Co ${newId().slice(0, 6)}`;
    const second = await handleCompanyCreate(
      post('/api/auth/company', { name: secondName }, token),
      { name: secondName },
    );
    expect(second.status).toBe(200);
    const secondTenantId = (second.body as { tenant: { id: string } }).tenant.id;
    const switched = await handleTenantSwitch(
      post('/api/auth/tenant/switch', { tenantId: secondTenantId }, token),
      { tenantId: secondTenantId },
    );
    expect(switched.status).toBe(200);
    if (switched.status === 200) {
      // Switching always clears the workspace selection.
      expect((switched.body as { workspace: unknown }).workspace).toBeNull();
    }
  });

  it('cross-scope tenant switching through the API is a 403', async () => {
    const strangerEmail = fakeEmail();
    const strangerPassword = fakePassword();
    const stranger = await handleSignUp(
      post('/api/auth/sign-up', { email: strangerEmail, password: strangerPassword, displayName: 'Stranger' }),
      { email: strangerEmail, password: strangerPassword, displayName: 'Stranger' },
    );
    const strangerToken = sessionCookieValue(stranger.setCookie);

    const ownerEmail = fakeEmail();
    const ownerPassword = fakePassword();
    const owner = await handleSignUp(
      post('/api/auth/sign-up', { email: ownerEmail, password: ownerPassword, displayName: 'Owner' }),
      { email: ownerEmail, password: ownerPassword, displayName: 'Owner' },
    );
    const ownerToken = sessionCookieValue(owner.setCookie);
    const companyName = `Fort Co ${newId().slice(0, 6)}`;
    const created = await handleCompanyCreate(
      post('/api/auth/company', { name: companyName }, ownerToken),
      { name: companyName },
    );
    const foreignTenant = (created.body as { tenant: { id: string } }).tenant.id;

    const denied = await handleTenantSwitch(
      post('/api/auth/tenant/switch', { tenantId: foreignTenant }, strangerToken),
      { tenantId: foreignTenant },
    );
    expect(denied.status).toBe(403);
  });

  it('the invitation loop through the API: create → inspect → accept', async () => {
    const ownerEmail = fakeEmail();
    const ownerPassword = fakePassword();
    const owner = await handleSignUp(
      post('/api/auth/sign-up', { email: ownerEmail, password: ownerPassword, displayName: 'Boss' }),
      { email: ownerEmail, password: ownerPassword, displayName: 'Boss' },
    );
    const ownerToken = sessionCookieValue(owner.setCookie);
    const companyName = `Invite Co ${newId().slice(0, 6)}`;
    await handleCompanyCreate(post('/api/auth/company', { name: companyName }, ownerToken), {
      name: companyName,
    });

    const colleagueEmail = fakeEmail();
    const created = await handleInvitationCreate(
      post('/api/auth/invitations', { email: colleagueEmail, tenantRole: 'member' }, ownerToken),
      { email: colleagueEmail, tenantRole: 'member' },
    );
    expect(created.status).toBe(200);
    const inviteToken = (created.body as { inviteToken: string }).inviteToken;
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Inspect is public (the token is the authorization).
    const inspected = await handleInvitationInspect(
      post('/api/auth/invitations/inspect', { token: inviteToken }),
      { token: inviteToken },
    );
    expect(inspected.status).toBe(200);
    expect((inspected.body as { invitation: { status: string; tenantName: string } }).invitation).toMatchObject({
      status: 'pending',
      tenantName: companyName,
    });

    // Accept requires the invited email's session.
    const wrongEmail = fakeEmail();
    const wrong = await handleSignUp(
      post('/api/auth/sign-up', { email: wrongEmail, password: fakePassword(), displayName: 'Wrong' }),
      { email: wrongEmail, password: fakePassword(), displayName: 'Wrong' },
    );
    const wrongToken = sessionCookieValue(wrong.setCookie);
    const mismatch = await handleInvitationAccept(
      post('/api/auth/invitations/accept', { invitationToken: inviteToken }, wrongToken),
      { invitationToken: inviteToken },
    );
    expect(mismatch.status).toBe(403);

    const colleague = await handleSignUp(
      post('/api/auth/sign-up', { email: colleagueEmail, password: fakePassword(), displayName: 'Colleague' }),
      { email: colleagueEmail, password: fakePassword(), displayName: 'Colleague' },
    );
    const colleagueToken = sessionCookieValue(colleague.setCookie);
    const accepted = await handleInvitationAccept(
      post('/api/auth/invitations/accept', { invitationToken: inviteToken }, colleagueToken),
      { invitationToken: inviteToken },
    );
    expect(accepted.status).toBe(200);

    // The colleague's session now sits in the joined company, as member.
    const session = await handleSessionGet(requestWithSession(`${BASE}/api/auth/session`, colleagueToken));
    expect(session.status).toBe(200);
    if (session.status === 200) {
      const body = session.body as { tenant: { name: string; role: string } | null };
      expect(body.tenant?.name).toBe(companyName);
      expect(body.tenant?.role).toBe('member');
    }

    // The roster shows the used invitation (owner-only surface).
    const roster = await handleInvitationsGet(requestWithSession(`${BASE}/api/auth/invitations`, ownerToken));
    expect(roster.status).toBe(200);
    const memberRoster = await handleInvitationsGet(
      requestWithSession(`${BASE}/api/auth/invitations`, colleagueToken),
    );
    expect(memberRoster.status).toBe(403); // members do not see the roster
  });

  it('sign-out revokes the session and clears the cookie', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    const up = await handleSignUp(
      post('/api/auth/sign-up', { email, password, displayName: 'Bye' }),
      { email, password, displayName: 'Bye' },
    );
    const token = sessionCookieValue(up.setCookie);
    const out = await handleSignOut(requestWithSession(`${BASE}/api/auth/sign-out`, token));
    expect(out.status).toBe(200);
    expect(out.setCookie).toContain('Max-Age=0');

    const after = await handleSessionGet(requestWithSession(`${BASE}/api/auth/session`, token));
    expect(after.status).toBe(401);
  });
});

describe('request-side session resolution (the shared adapter)', () => {
  it('no cookie → unauthenticated (never tenant data)', async () => {
    const scope = await resolveRequestScope(new Request(`${BASE}/anything`));
    expect(scope.phase).toBe('unauthenticated');
  });

  it('a garbage cookie → unauthenticated', async () => {
    const scope = await resolveRequestScope(
      new Request(`${BASE}/anything`, { headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` } }),
    );
    expect(scope.phase).toBe('unauthenticated');
  });

  it('a session without a company → no_active_tenant', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    const up = await handleSignUp(
      post('/api/auth/sign-up', { email, password, displayName: 'Scope' }),
      { email, password, displayName: 'Scope' },
    );
    const token = sessionCookieValue(up.setCookie);
    const scope = await resolveRequestScope(requestWithSession(`${BASE}/today`, token));
    expect(scope.phase).toBe('no_active_tenant');
  });

  it('a scoped session → ready with the membership-verified context', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    const up = await handleSignUp(
      post('/api/auth/sign-up', { email, password, displayName: 'Scoped' }),
      { email, password, displayName: 'Scoped' },
    );
    const token = sessionCookieValue(up.setCookie);
    const companyName = `Scope Co ${newId().slice(0, 6)}`;
    await handleCompanyCreate(post('/api/auth/company', { name: companyName }, token), {
      name: companyName,
    });
    const scope = await resolveRequestScope(requestWithSession(`${BASE}/today`, token));
    expect(scope.phase).toBe('ready');
    if (scope.phase === 'ready') {
      expect(scope.context.tenantId).not.toBe('');
      // Authority is role-derived (owner), never client-supplied.
      expect(scope.context.authority).toContain('actions:approve');
      expect(scope.workspace).toBe('default');
    }
  });
});

describe('error mapping', () => {
  it('maps AuthError codes to HTTP-ish outcomes', () => {
    expect(authApiError(new AuthError('invalid_input', 'x')).status).toBe(400);
    expect(authApiError(new AuthError('invalid_credentials', 'x')).status).toBe(401);
    expect(authApiError(new AuthError('unauthorized', 'x')).status).toBe(401);
    expect(authApiError(new AuthError('session_expired', 'x')).status).toBe(401);
    expect(authApiError(new AuthError('forbidden', 'x')).status).toBe(403);
    expect(authApiError(new AuthError('tenant_unavailable', 'x')).status).toBe(403);
    expect(authApiError(new AuthError('email_taken', 'x')).status).toBe(409);
    expect(authApiError(new AuthError('no_active_tenant', 'x')).status).toBe(409);
    expect(authApiError(new AuthError('invitation_not_found', 'x')).status).toBe(404);
    expect(authApiError(new Error('boom')).status).toBe(500);
  });
});

/** Extract the token from a Set-Cookie value. */
function sessionCookieValue(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error('no cookie set');
  const match = /^aurum_session=([^;]+)/.exec(setCookie);
  if (match === null) throw new Error('malformed session cookie');
  return match[1]!;
}
