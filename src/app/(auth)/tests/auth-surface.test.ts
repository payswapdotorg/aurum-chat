// Integration tests for the auth surfaces (W058) — the (auth) group's API
// handlers and session resolution against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port, composed with REAL
// organizations contracts.
//
// The work item's acceptance core, proven end to end:
//   * the FULL first-manager journey: register → create company → invite
//     an employee → the employee signs up with the invite code → both
//     land with verified company scope (usable Aurum chat state);
//   * unauthenticated requests cannot reach tenant data (uniform 401s —
//     no scope parameter exists that could help);
//   * tenant switching cannot cross scope (a foreign company is a 404);
//   * session revocation through the cookie surface;
//   * cookie serialization (httpOnly, SameSite=Lax, the absolute cap).
//
// Fake credentials are assembled from fragments at runtime (never a
// realistic full literal in source — GitHub push protection).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../../scripts/migrate';
import { getTenantMembership } from '@/modules/organizations/contract';
import { registerUser } from '@/modules/auth/contract';
import { SESSION_COOKIE, sessionTokenFromCookieHeader } from '@/app/lib/session';
import {
  SESSION_COOKIE_MAX_AGE,
  clearSessionCookieHeader,
  sessionCookieHeader,
} from '../lib/cookies';
import {
  handleCompanyCreatePost,
  handleInviteCreatePost,
  handleInviteListGet,
  handleInviteRedeemPost,
  handleInviteRevokePost,
  handlePasswordChangePost,
  handleSelectionPost,
  handleSessionGet,
  handleSignIn,
  handleSignOut,
  handleSignOutEverywherePost,
  handleSignUp,
  mapAuthApiError,
} from '../lib/api';
import { handleWaitlistDecidePost } from '@/app/(platform)/lib/api';

const BASE = 'https://aurum.test/api/auth';

// ---------------------------------------------------------------------------
// Fragments (push protection)
// ---------------------------------------------------------------------------

const managerPassword = (): string => ['clo', 'ud', '-for', 'ge-12'].join('');
const employeePassword = (): string => ['sa', 'nd', '-sto', 'ne-7'].join('');
const adminPassword = (): string => ['ope', 'ra', 'tor-', 'gold-31'].join('');
const emailOf = (local: string): string => [local, '.', newId().slice(0, 8), '@example', '.test'].join('');
const journeyManagerEmail = emailOf('manager');

/** A request carrying one session cookie. */
function cookieRequest(token: string | null, path: string, method: 'GET' | 'POST' = 'POST'): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

/** A JSON POST body (optionally with the session cookie attached). */
function jsonRequest(path: string, body: Record<string, unknown>, token: string | null = null): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Cookie serialization (pure)
// ---------------------------------------------------------------------------

describe('session cookie serialization', () => {
  it('establishes an httpOnly, SameSite=Lax, path-wide cookie with the absolute cap', () => {
    const header = sessionCookieHeader('a-token-value');
    expect(header).toContain(`${SESSION_COOKIE}=a-token-value`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE}`);
    expect(header).toContain('Path=/');
  });

  it('is Secure only in production', () => {
    const nodeEnv = process.env as { NODE_ENV?: string };
    const before = nodeEnv.NODE_ENV;
    nodeEnv.NODE_ENV = 'production';
    expect(sessionCookieHeader('t')).toContain('Secure');
    nodeEnv.NODE_ENV = 'development';
    expect(sessionCookieHeader('t')).not.toContain('Secure');
    if (before !== undefined) nodeEnv.NODE_ENV = before;
  });

  it('sign-out clears the cookie', () => {
    expect(clearSessionCookieHeader()).toContain(`${SESSION_COOKIE}=;`);
    expect(clearSessionCookieHeader()).toContain('Max-Age=0');
  });

  it('the cookie header parser extracts the session token only', () => {
    expect(sessionTokenFromCookieHeader(`${SESSION_COOKIE}=abc; other=x`)).toBe('abc');
    expect(sessionTokenFromCookieHeader(`other=x; ${SESSION_COOKIE}=abc`)).toBe('abc');
    expect(sessionTokenFromCookieHeader(`${SESSION_COOKIE}=`)).toBeNull();
    expect(sessionTokenFromCookieHeader(null)).toBeNull();
    expect(sessionTokenFromCookieHeader('unrelated=1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The first-manager journey (W116: waitlist-gated — accept before onboarding)
// ---------------------------------------------------------------------------

describe('the first-manager journey through the auth API', () => {
  let adminToken: string;
  let managerToken: string;
  let tenantId: string;
  let inviteCode: string;
  const adminEmail = emailOf('platform-admin');
  const managerEmail = journeyManagerEmail;
  const employeeEmail = emailOf('employee');

  beforeAll(async () => {
    // The operator bootstrap — the production path: an active account
    // whose email is designated through AURUM_PLATFORM_ADMIN_EMAILS
    // (granted at sign-in; fails closed when unset).
    await registerUser({
      displayName: 'Platform Operator',
      email: adminEmail,
      password: adminPassword(),
    });
    process.env.AURUM_PLATFORM_ADMIN_EMAILS = adminEmail;
    const signedIn = await handleSignIn(
      jsonRequest('/sign-in', { email: adminEmail, password: adminPassword() }),
    );
    expect(signedIn.status).toBe(200);
    expect((signedIn.body['session'] as { platformAdmin: boolean }).platformAdmin).toBe(true);
    adminToken = sessionTokenFromCookieHeader(signedIn.setCookie ?? null)!;
  });

  afterAll(() => {
    delete process.env.AURUM_PLATFORM_ADMIN_EMAILS;
  });

  it('signing up lands on the waitlist — no session, no cookie', async () => {
    const result = await handleSignUp(
      jsonRequest('/sign-up', {
        displayName: 'Ada Manager',
        email: managerEmail,
        password: managerPassword(),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body['waitlisted']).toBe(true);
    expect(result.setCookie).toBeUndefined();
    const users = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_users WHERE email = $1`,
      [managerEmail],
    );
    expect(users.rows[0]!.count).toBe('0');
  });

  it('sign-in on the pending request shows the honest waiting state (password proven)', async () => {
    const result = await handleSignIn(
      jsonRequest('/sign-in', { email: managerEmail, password: managerPassword() }),
    );
    expect(result.status).toBe(403);
    expect(result.body['error']).toBe('account_pending');
    // Without password knowledge the same request stays uniform.
    const stranger = await handleSignIn(
      jsonRequest('/sign-in', { email: managerEmail, password: employeePassword() }),
    );
    expect(stranger.status).toBe(401);
    expect(stranger.body['error']).toBe('invalid_credentials');
  });

  it('a duplicate signup is indistinguishable from the first (idempotent re-request)', async () => {
    const result = await handleSignUp(
      jsonRequest('/sign-up', {
        displayName: 'Ada Manager',
        email: managerEmail,
        password: managerPassword(),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body['waitlisted']).toBe(true);
    expect(result.setCookie).toBeUndefined();
    const rows = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_waitlist WHERE email = $1 AND status = 'pending'`,
      [managerEmail],
    );
    expect(rows.rows[0]!.count).toBe('1');
  });

  it('the operator accepts the request through the decide endpoint (a POST form action)', async () => {
    const rows = await getDb().query<{ id: string }>(
      `SELECT id FROM auth_waitlist WHERE email = $1 AND status = 'pending'`,
      [managerEmail],
    );
    const requestId = rows.rows[0]!.id;
    const body = new URLSearchParams({ requestId, decision: 'accept' });
    const result = await handleWaitlistDecidePost(
      new Request('https://aurum.test/api/platform/waitlist/decide', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `${SESSION_COOKIE}=${adminToken}`,
        },
        body: body.toString(),
      }),
    );
    expect(result.location).toBe('/platform/waitlist?done=accepted');
  });

  it('the accepted manager signs in, lands unscoped, and creates the company', async () => {
    const signedIn = await handleSignIn(
      jsonRequest('/sign-in', { email: managerEmail, password: managerPassword() }),
    );
    expect(signedIn.status).toBe(200);
    managerToken = sessionTokenFromCookieHeader(signedIn.setCookie ?? null)!;
    expect(managerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signedIn.body['session']).toMatchObject({
      principal: { email: managerEmail },
      company: null,
    });

    const unscoped = await handleSessionGet(cookieRequest(managerToken, '/session', 'GET'));
    expect(unscoped.body['status']).toBe('no-company');

    const created = await handleCompanyCreatePost(
      jsonRequest('/onboarding/company', { name: `Meridian Labs ${newId().slice(0, 6)}` }, managerToken),
    );
    expect(created.status).toBe(200);
    expect(created.body['session']).toMatchObject({
      company: { role: 'owner', workspaceId: null },
    });
    tenantId = (created.body['tenant'] as { id: string }).id;
  });

  it('the session view carries the verified company, role, claims and directory', async () => {
    const result = await handleSessionGet(cookieRequest(managerToken, '/session', 'GET'));
    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('authenticated');
    expect(result.body['company']).toMatchObject({ tenantId, role: 'owner' });
    const companies = result.body['companies'] as { tenantId: string; addedVia: string }[];
    expect(companies).toHaveLength(1);
    expect(companies[0]!.addedVia).toBe('created');
    const authority = (result.body['company'] as { authority: string[] }).authority;
    expect(authority).toContain('actions:approve');
    expect(authority).toContain('marketplace:submit');
    expect(authority).not.toContain('marketplace:administer');
  });

  it('invites the employee (code shown once; the anonymous attempt is refused)', async () => {
    const anonymous = await handleInviteCreatePost(jsonRequest('/invite', { email: employeeEmail }));
    expect(anonymous.status).toBe(401);
    const issued = await handleInviteCreatePost(
      jsonRequest('/invite', { email: employeeEmail, role: 'member' }, managerToken),
    );
    expect(issued.status).toBe(200);
    inviteCode = (issued.body['code'] as string) ?? '';
    expect(inviteCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('the employee signs up with the invite code and lands scoped (usable chat state)', async () => {
    const result = await handleSignUp(
      jsonRequest('/sign-up', {
        displayName: 'Eli Employee',
        email: employeeEmail,
        password: employeePassword(),
        inviteCode,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body['session']).toMatchObject({
      principal: { email: employeeEmail },
      company: { tenantId, role: 'member' },
    });
    // The organizations contract confirms the REAL membership.
    const principal = (result.body['session'] as { principal: { id: string } }).principal;
    const membership = await getTenantMembership(
      { tenantId, principalId: principal.id, authority: [] },
      { principalId: principal.id },
    );
    expect(membership.role).toBe('member');
    // A member carries no claims (the approve gate stays shut).
    const company = (result.body['session'] as { company: { authority: string[] } | null }).company;
    expect(company!.authority).toEqual([]);
  });

  it('the manager sees the settled invitation in the settled roster', async () => {
    // The default roster lists live (pending) invitations only; the
    // settled history arrives with ?includeSettled=1.
    const live = await handleInviteListGet(cookieRequest(managerToken, '/invite', 'GET'));
    expect(live.status).toBe(200);
    expect(
      (live.body['invites'] as { status: string }[]).every((invite) => invite.status === 'pending'),
    ).toBe(true);
    const settled = await handleInviteListGet(
      cookieRequest(managerToken, '/invite?includeSettled=1', 'GET'),
    );
    expect(settled.status).toBe(200);
    const invites = settled.body['invites'] as { email: string; status: string }[];
    expect(invites.some((invite) => invite.email === employeeEmail && invite.status === 'accepted')).toBe(true);
  });

  it('signing back in auto-selects the company (returning users skip onboarding)', async () => {
    const result = await handleSignIn(
      jsonRequest('/sign-in', { email: employeeEmail, password: employeePassword() }),
    );
    expect(result.status).toBe(200);
    expect(result.body['session']).toMatchObject({ company: { tenantId } });
  });
});

// ---------------------------------------------------------------------------
// The unauthenticated boundary (acceptance: no scope parameter exists)
// ---------------------------------------------------------------------------

describe('the unauthenticated boundary', () => {
  it('every handler refuses anonymous requests uniformly', async () => {
    const cases: { label: string; run: () => Promise<{ status: number; body: { error?: string } }> }[] = [
      { label: 'session', run: () => handleSessionGet(cookieRequest(null, '/session', 'GET')) },
      { label: 'selection', run: () => handleSelectionPost(jsonRequest('/session/selection', { tenantId: newId() })) },
      { label: 'company', run: () => handleCompanyCreatePost(jsonRequest('/onboarding/company', { name: 'Ghost Co' })) },
      { label: 'invite create', run: () => handleInviteCreatePost(jsonRequest('/invite', { email: emailOf('ghost') })) },
      { label: 'invite list', run: () => handleInviteListGet(cookieRequest(null, '/invite', 'GET')) },
      { label: 'invite revoke', run: () => handleInviteRevokePost(jsonRequest('/invite/revoke', { inviteId: newId() })) },
      { label: 'invite redeem', run: () => handleInviteRedeemPost(jsonRequest('/invite/redeem', { code: 'no-such-code' })) },
    ];
    for (const { label, run } of cases) {
      const result = await run();
      expect(result.status, label).toBe(401);
      expect(result.body['error'], label).toBe('unauthenticated');
    }
  });

  it('a wrong password is uniformly invalid_credentials (no account leak)', async () => {
    const email = emailOf('unknown-user');
    const result = await handleSignIn(
      jsonRequest('/sign-in', { email, password: managerPassword() }),
    );
    expect(result.status).toBe(401);
    expect(result.body['error']).toBe('invalid_credentials');
  });

  it('duplicate registration is a 409 email_taken (an ACTIVE account; a pending re-request is not)', async () => {
    // A pending request re-submits indistinguishably (the waitlist).
    const pendingEmail = emailOf('dupe');
    const first = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'One', email: pendingEmail, password: managerPassword() }),
    );
    expect(first.status).toBe(200);
    expect(first.body['waitlisted']).toBe(true);
    const second = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'Two', email: pendingEmail, password: managerPassword() }),
    );
    expect(second.status).toBe(200);
    expect(second.body['waitlisted']).toBe(true);
    // An ACTIVE account (the accepted manager above) keeps email_taken.
    const active = await handleSignUp(
      jsonRequest('/sign-up', {
        displayName: 'Three',
        email: journeyManagerEmail,
        password: managerPassword(),
      }),
    );
    expect(active.status).toBe(409);
    expect(active.body['error']).toBe('email_taken');
  });

  it('a declined request reads its state (and the admin note) on sign-in', async () => {
    const admin = await registerUser({
      displayName: 'Decline Admin',
      email: emailOf('decline-admin'),
      password: adminPassword(),
    });
    process.env.AURUM_PLATFORM_ADMIN_EMAILS = admin.session.principal.email;
    const adminSession = await handleSignIn(
      jsonRequest('/sign-in', {
        email: admin.session.principal.email,
        password: adminPassword(),
      }),
    );
    const adminToken = sessionTokenFromCookieHeader(adminSession.setCookie ?? null)!;
    delete process.env.AURUM_PLATFORM_ADMIN_EMAILS;

    const declinedEmail = emailOf('declined-request');
    await handleSignUp(
      jsonRequest('/sign-up', {
        displayName: 'Declined Person',
        email: declinedEmail,
        password: employeePassword(),
      }),
    );
    const rows = await getDb().query<{ id: string }>(
      `SELECT id FROM auth_waitlist WHERE email = $1 AND status = 'pending'`,
      [declinedEmail],
    );
    const decided = await handleWaitlistDecidePost(
      new Request('https://aurum.test/api/platform/waitlist/decide', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `${SESSION_COOKIE}=${adminToken}`,
        },
        body: new URLSearchParams({
          requestId: rows.rows[0]!.id,
          decision: 'decline',
          note: 'This round is internal only',
        }).toString(),
      }),
    );
    expect(decided.location).toBe('/platform/waitlist?done=declined');

    const result = await handleSignIn(
      jsonRequest('/sign-in', { email: declinedEmail, password: employeePassword() }),
    );
    expect(result.status).toBe(403);
    expect(result.body['error']).toBe('account_declined');
    expect(result.body['message']).toContain('This round is internal only');
  });
});

// ---------------------------------------------------------------------------
// Cross-scope guarantees through the API
// ---------------------------------------------------------------------------

describe('scope guarantees through the API', () => {
  let ownerToken: string;
  let foreignTenantId: string;
  let memberToken: string;

  beforeAll(async () => {
    // W116: the HTTP fixtures use the contract's activation primitive —
    // the waitlist gate is journey-tested above; these tests exercise
    // the session/company API surface itself.
    const owner = await registerUser({
      displayName: 'Scope Owner',
      email: emailOf('scope-owner'),
      password: managerPassword(),
    });
    ownerToken = owner.token;
    const created = await handleCompanyCreatePost(
      jsonRequest('/onboarding/company', { name: `Scope Co ${newId().slice(0, 6)}` }, ownerToken),
    );
    foreignTenantId = (created.body['tenant'] as { id: string }).id;

    const member = await registerUser({
      displayName: 'Scope Member',
      email: emailOf('scope-member'),
      password: employeePassword(),
    });
    memberToken = member.token;
  });

  it('switching to a company you are not a member of is a 404 company_not_available', async () => {
    const result = await handleSelectionPost(
      jsonRequest('/session/selection', { tenantId: foreignTenantId }, memberToken),
    );
    expect(result.status).toBe(404);
    expect(result.body['error']).toBe('company_not_available');
    // The member's session remains unscoped.
    const session = await handleSessionGet(cookieRequest(memberToken, '/session', 'GET'));
    expect(session.body['status']).toBe('no-company');
  });

  it('invite writes require an active company (409 before the contract)', async () => {
    const anonymous = await handleInviteCreatePost(jsonRequest('/invite', { email: emailOf('premature') }));
    expect(anonymous.status).toBe(401);
    const refused = await handleInviteCreatePost(
      jsonRequest('/invite', { email: emailOf('premature') }, memberToken),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toBe('no_active_company');
  });

  it('sign-out revokes; the cookie is cleared and the session is uniformly gone', async () => {
    const issued = await registerUser({
      displayName: 'Sign Out Flow',
      email: emailOf('signout-flow'),
      password: employeePassword(),
    });
    const token = issued.token;
    const before = await handleSessionGet(cookieRequest(token, '/session', 'GET'));
    expect(before.status).toBe(200);
    const out = await handleSignOut(cookieRequest(token, '/sign-out'));
    expect(out.status).toBe(200);
    expect(out.clearCookie).toBe(true);
    expect(clearSessionCookieHeader()).toContain('Max-Age=0');
    const after = await handleSessionGet(cookieRequest(token, '/session', 'GET'));
    expect(after.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Account settings through the API (W116) — password change + sign out everywhere
// ---------------------------------------------------------------------------

describe('account settings through the API', () => {
  it('password change: wrong current password is a uniform 401; success keeps this session and kills others', async () => {
    const email = emailOf('pw-change');
    const first = await registerUser({
      displayName: 'PW Changer',
      email,
      password: managerPassword(),
    });
    const second = await handleSignIn(
      jsonRequest('/sign-in', { email, password: managerPassword() }),
    );
    const secondToken = sessionTokenFromCookieHeader(second.setCookie ?? null)!;
    const newPassword = ['clo', 'ud', '-heron-', '55'].join('');

    const wrong = await handlePasswordChangePost(
      jsonRequest('/password/change', {
        currentPassword: employeePassword(),
        newPassword,
      }, first.token),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body['error']).toBe('invalid_credentials');

    const changed = await handlePasswordChangePost(
      jsonRequest('/password/change', {
        currentPassword: managerPassword(),
        newPassword,
      }, first.token),
    );
    expect(changed.status).toBe(200);
    expect(changed.body['session']).toMatchObject({ principal: { email } });

    const thisOne = await handleSessionGet(cookieRequest(first.token, '/session', 'GET'));
    expect(thisOne.status).toBe(200);
    const otherOne = await handleSessionGet(cookieRequest(secondToken, '/session', 'GET'));
    expect(otherOne.status).toBe(401);
    const renewed = await handleSignIn(
      jsonRequest('/sign-in', { email, password: newPassword }),
    );
    expect(renewed.status).toBe(200);
  });

  it('password change refuses anonymous requests uniformly', async () => {
    const result = await handlePasswordChangePost(
      jsonRequest('/password/change', { currentPassword: 'x'.repeat(9), newPassword: 'y'.repeat(9) }),
    );
    expect(result.status).toBe(401);
    expect(result.body['error']).toBe('unauthenticated');
  });

  it('sign-out-everywhere clears the cookie and every session is gone', async () => {
    const email = emailOf('soe-flow');
    const first = await registerUser({
      displayName: 'SOE Flow',
      email,
      password: employeePassword(),
    });
    const second = await handleSignIn(
      jsonRequest('/sign-in', { email, password: employeePassword() }),
    );
    const secondToken = sessionTokenFromCookieHeader(second.setCookie ?? null)!;

    const out = await handleSignOutEverywherePost(cookieRequest(first.token, '/sign-out-everywhere'));
    expect(out.status).toBe(200);
    expect(out.clearCookie).toBe(true);
    expect((await handleSessionGet(cookieRequest(first.token, '/session', 'GET'))).status).toBe(401);
    expect((await handleSessionGet(cookieRequest(secondToken, '/session', 'GET'))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Error mapping (pure)
// ---------------------------------------------------------------------------

describe('mapAuthApiError', () => {
  const cases: [string, number][] = [
    ['unauthenticated', 401],
    ['invalid_credentials', 401],
    ['forbidden', 403],
    ['account_pending', 403],
    ['account_declined', 403],
    ['no_active_company', 409],
    ['email_taken', 409],
    ['invite_email_mismatch', 409],
    ['tenant_slug_taken', 409],
    ['company_not_available', 404],
    ['workspace_not_available', 404],
    ['invite_not_found', 404],
    ['waitlist_not_found', 404],
    ['tenant_member_not_found', 404],
    ['invalid_input', 400],
  ];
  for (const [code, status] of cases) {
    it(`maps '${code}' to ${status}`, () => {
      const error = Object.assign(new Error(code), { code });
      expect(mapAuthApiError(error).status).toBe(status);
    });
  }
  it('maps unknown errors to 500', () => {
    expect(mapAuthApiError(new Error('boom')).status).toBe(500);
  });
});
