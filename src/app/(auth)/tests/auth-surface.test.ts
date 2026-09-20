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
  handleSelectionPost,
  handleSessionGet,
  handleSignIn,
  handleSignOut,
  handleSignUp,
  mapAuthApiError,
} from '../lib/api';

const BASE = 'https://aurum.test/api/auth';

// ---------------------------------------------------------------------------
// Fragments (push protection)
// ---------------------------------------------------------------------------

const managerPassword = (): string => ['clo', 'ud', '-for', 'ge-12'].join('');
const employeePassword = (): string => ['sa', 'nd', '-sto', 'ne-7'].join('');
const emailOf = (local: string): string => [local, '.', newId().slice(0, 8), '@example', '.test'].join('');

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
// The full first-manager journey (acceptance: onboarding → usable chat scope)
// ---------------------------------------------------------------------------

describe('the first-manager journey through the auth API', () => {
  let managerToken: string;
  let tenantId: string;
  let inviteCode: string;
  const managerEmail = emailOf('manager');
  const employeeEmail = emailOf('employee');

  it('signs up and lands unscoped (cookie established)', async () => {
    const result = await handleSignUp(
      jsonRequest('/sign-up', {
        displayName: 'Ada Manager',
        email: managerEmail,
        password: managerPassword(),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.setCookie).toBeDefined();
    managerToken = sessionTokenFromCookieHeader(result.setCookie ?? null)!;
    expect(managerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.body['session']).toMatchObject({
      principal: { email: managerEmail },
      company: null,
    });
  });

  it('the unscoped session reads as no-company (onboarding pending)', async () => {
    const result = await handleSessionGet(cookieRequest(managerToken, '/session', 'GET'));
    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('no-company');
    expect(result.body['companies']).toEqual([]);
  });

  it('creates the company through onboarding and selects it', async () => {
    const result = await handleCompanyCreatePost(
      jsonRequest('/onboarding/company', { name: `Meridian Labs ${newId().slice(0, 6)}` }, managerToken),
    );
    expect(result.status).toBe(200);
    expect(result.body['session']).toMatchObject({
      company: { role: 'owner', workspaceId: null },
    });
    tenantId = (result.body['tenant'] as { id: string }).id;
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

  it('duplicate registration is a 409 email_taken', async () => {
    const email = emailOf('dupe');
    const first = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'One', email, password: managerPassword() }),
    );
    expect(first.status).toBe(200);
    const second = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'Two', email, password: managerPassword() }),
    );
    expect(second.status).toBe(409);
    expect(second.body['error']).toBe('email_taken');
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
    const email = emailOf('scope-owner');
    const owner = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'Scope Owner', email, password: managerPassword() }),
    );
    ownerToken = sessionTokenFromCookieHeader(owner.setCookie ?? null)!;
    const created = await handleCompanyCreatePost(
      jsonRequest('/onboarding/company', { name: `Scope Co ${newId().slice(0, 6)}` }, ownerToken),
    );
    foreignTenantId = (created.body['tenant'] as { id: string }).id;

    const memberEmail = emailOf('scope-member');
    const member = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'Scope Member', email: memberEmail, password: employeePassword() }),
    );
    memberToken = sessionTokenFromCookieHeader(member.setCookie ?? null)!;
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
    const email = emailOf('signout-flow');
    const issued = await handleSignUp(
      jsonRequest('/sign-up', { displayName: 'Sign Out Flow', email, password: employeePassword() }),
    );
    const token = sessionTokenFromCookieHeader(issued.setCookie ?? null)!;
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
// Error mapping (pure)
// ---------------------------------------------------------------------------

describe('mapAuthApiError', () => {
  const cases: [string, number][] = [
    ['unauthenticated', 401],
    ['invalid_credentials', 401],
    ['forbidden', 403],
    ['no_active_company', 409],
    ['email_taken', 409],
    ['invite_email_mismatch', 409],
    ['tenant_slug_taken', 409],
    ['company_not_available', 404],
    ['workspace_not_available', 404],
    ['invite_not_found', 404],
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
