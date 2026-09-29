// W070 — Journey A: first-run onboarding (the "first-run onboarding"
// acceptance bullet), walked as a REAL first-time user would:
//
//   anonymous → the route gate redirects to /signin → the sign-in page
//   renders → W116: registration lands on the WAITLIST (no session) →
//   the sign-in attempt shows the honest waiting state → a platform
//   admin accepts the request → sign-in issues a real session → a
//   company-less session is routed to /onboarding → the onboarding page
//   offers company creation → the create-company API activates the
//   company → the product renders (usable Aurum chat).
//
// Also proven here, because they are the first-run surface's own rules:
//   * the middleware route gate (the real edge middleware function):
//     anonymous page hits redirect to /signin?next=…, public paths pass,
//     a session cookie passes;
//   * the root URL forwards to the conversation-first product;
//   * the invitation landing renders for its public code.
//
// No demo world needed: this journey is exactly the FRESH user, so the
// file boots migrations only and registers its own principal (and its
// own platform admin, through the contract's claim-gated designation).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The harness MUST be the first non-vitest import: its next/headers /
// next/navigation mocks register during its module evaluation, and any app
// module statically imported before it would cache the real modules.
import { apiRequest, renderOk, renderRoute } from './harness';
import { getDb, closeDb } from '../../../src/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import { newId } from '../../../src/infra/ids';
import { handleCompanyCreatePost, handleSignIn, handleSignUp } from '../../../src/app/(auth)/lib/api';
import { handleWaitlistDecidePost } from '../../../src/app/(platform)/lib/api';
import {
  AUTH_AUTHORITY_PLATFORM_ADMIN,
  createInvite,
  listInvites,
  registerUser,
  setPlatformAdmin,
} from '../../../src/modules/auth/contract';
import {
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
} from '../../../src/modules/organizations/contract';

/** A fresh principal's sign-in materials (password assembled from fragments). */
function freshUser(): { displayName: string; email: string; password: string } {
  return {
    displayName: 'Odessa Ran',
    email: ['odessa', '.', newId().slice(0, 8), '@first-run', '.test'].join(''),
    password: ['qu', 'artz-', 'fa', 'll-7'].join(''),
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The route gate (the real middleware function)
// ---------------------------------------------------------------------------

describe('the route gate (middleware)', () => {
  it('redirects anonymous page hits to /signin with a next parameter', async () => {
    const { middleware } = await import('../../../src/middleware');
    const { NextRequest } = await import('next/server');
    const response = middleware(new NextRequest('https://aurum.test/chat'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/signin');
    expect(location).toContain('next=%2Fchat');
  });

  it('passes public paths (the marketplace catalog browses anonymously)', async () => {
    const { middleware } = await import('../../../src/middleware');
    const { NextRequest } = await import('next/server');
    for (const path of ['/signin', '/signup', '/marketplace', '/marketplace/package/x']) {
      const response = middleware(new NextRequest(`https://aurum.test${path}`));
      expect(response.status, path).toBeLessThan(300);
    }
  });

  it('passes a request carrying the session cookie', async () => {
    const { middleware } = await import('../../../src/middleware');
    const { NextRequest } = await import('next/server');
    const request = new NextRequest('https://aurum.test/chat');
    request.cookies.set('aurum_session', 'any-opaque-token');
    const response = middleware(request);
    expect(response.status).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// The first-run journey
// ---------------------------------------------------------------------------

describe('Journey A — first-run onboarding', () => {
  let user: ReturnType<typeof freshUser>;
  let token: string;

  it('an anonymous visitor cannot reach the product (no tenant surface renders)', async () => {
    const rendered = await renderRoute('/chat', null);
    expect(rendered.status).toBe('redirect');
    expect(rendered.redirect).toBe('/signin');
  });

  it('the root URL forwards to the conversation-first product', async () => {
    const rendered = await renderRoute('/', null);
    expect(rendered.status).toBe('redirect');
    expect(rendered.redirect).toBe('/chat');
  });

  it('the sign-in page renders with a labeled, actionable form', async () => {
    const { html } = await renderOk('/signin', null);
    expect(html).toContain('Sign in');
    expect(html.toLowerCase()).toContain('type="email"');
    expect(html.toLowerCase()).toContain('type="password"');
  });

  it('the sign-up page renders for the registration path (the waitlist wording)', async () => {
    const { html } = await renderOk('/signup', null);
    expect(html).toContain('Request access');
    expect(html).toContain('reviewed');
  });

  it('registration lands on the waitlist — no session exists yet (W116)', async () => {
    user = freshUser();
    const response = await handleSignUp(
      apiRequest('/api/auth/sign-up', null, { body: user }),
    );
    expect(response.status).toBe(200);
    expect(response.body['waitlisted']).toBe(true);
    expect(response.setCookie).toBeUndefined();
  });

  it('sign-in before acceptance shows the honest waiting state', async () => {
    const response = await handleSignIn(apiRequest('/api/auth/sign-in', null, { body: user }));
    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('account_pending');
  });

  it('a platform admin accepts the request through the decide endpoint (a POST form action)', async () => {
    // The journey's own operator: an activated account designated through
    // the contract's claim-gated setPlatformAdmin (the seed-time path —
    // the env bootstrap is exercised in the auth suites).
    const adminEmail = ['operator', '.', newId().slice(0, 8), '@first-run', '.test'].join('');
    const admin = await registerUser({
      displayName: 'First Run Operator',
      email: adminEmail,
      password: ['go', 'ld-', 'lea', 'f-9'].join(''),
    });
    await setPlatformAdmin(
      { principalId: admin.session.principalId, authority: [AUTH_AUTHORITY_PLATFORM_ADMIN] },
      { email: adminEmail, platformAdmin: true },
    );
    const rows = await getDb().query<{ id: string }>(
      `SELECT id FROM auth_waitlist WHERE email = $1 AND status = 'pending'`,
      [user.email],
    );
    const requestId = rows.rows[0]!.id;
    const decided = await handleWaitlistDecidePost(
      new Request('https://aurum.test/api/platform/waitlist/decide', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `aurum_session=${admin.token}`,
        },
        body: new URLSearchParams({ requestId, decision: 'accept' }).toString(),
      }),
    );
    expect(decided.location).toBe('/platform/waitlist?done=accepted');
  });

  it('the accepted account signs in — the journey continues with a real session', async () => {
    const response = await handleSignIn(apiRequest('/api/auth/sign-in', null, { body: user }));
    expect(response.status).toBe(200);
    const cookie = response.setCookie;
    expect(cookie).toBeDefined();
    token = /aurum_session=([^;]+)/.exec(cookie ?? '')?.[1] ?? '';
    expect(token).not.toBe('');
  });

  it('a company-less session is routed to onboarding (never an empty shell)', async () => {
    const persona = { role: 'manager' as const, displayName: user.displayName, email: user.email, token };
    const rendered = await renderRoute('/chat', persona);
    expect(rendered.status).toBe('redirect');
    expect(rendered.redirect).toBe('/onboarding');
  });

  it('the onboarding page offers company creation, joining and sign-in guidance', async () => {
    const persona = { role: 'manager' as const, displayName: user.displayName, email: user.email, token };
    const { html } = await renderOk('/onboarding', persona);
    expect(html).toContain('Create a company');
    expect(html.toLowerCase()).toContain('invitation');
  });

  it('creating the company activates the session company', async () => {
    const response = await handleCompanyCreatePost(
      apiRequest(
        '/api/auth/onboarding/company',
        { role: 'manager' as const, displayName: user.displayName, email: user.email, token },
        { body: { name: 'First Run Coffee', slug: `first-run-${newId().slice(0, 8)}` } },
      ),
    );
    expect(response.status).toBe(200);
    if (response.status === 200) {
      const tenant = response.body['tenant'] as { name?: string } | undefined;
      expect(tenant?.name).toBe('First Run Coffee');
    }
  });

  it('onboarding reaches usable Aurum chat', async () => {
    const persona = { role: 'manager' as const, displayName: user.displayName, email: user.email, token };
    const { html } = await renderOk('/chat', persona);
    expect(html).toContain('Aurum');
    expect(html).toContain('New conversation');
  });

  it('sign-in works for the created account (the second visit)', async () => {
    const response = await handleSignIn(apiRequest('/api/auth/sign-in', null, { body: user }));
    expect(response.status).toBe(200);
    expect(response.setCookie).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The invitation landing (the membership entry of the first-run surface)
// ---------------------------------------------------------------------------

describe('the invitation landing', () => {
  it('renders the invitation preview for a live code, and the quiet state for a dead one', async () => {
    // A platform provisioner creates a tenant + invite through the real
    // contracts (the issuer's own flow).
    const owner = await registerUser({
      displayName: 'Invite Issuer',
      email: ['issuer', '.', newId().slice(0, 8), '@first-run', '.test'].join(''),
      password: ['ro', 'se-', 'qu', 'artz-3'].join(''),
    });
    const platform = {
      principalId: owner.session.principalId,
      authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
    };
    const tenant = await provisionTenant(platform, {
      name: 'Invitation Co',
      ownerPrincipalId: owner.session.principalId,
    });
    const invites = await listInvites(
      { tenantId: tenant.id, principalId: owner.session.principalId, authority: [] },
      {},
    );
    expect(Array.isArray(invites)).toBe(true);
    const invite = await createInvite(
      { tenantId: tenant.id, principalId: owner.session.principalId, authority: [] },
      { email: ['new', '.', newId().slice(0, 6), '@first-run', '.test'].join(''), role: 'member' },
    );
    const live = await renderRoute(`/invite/${invite.code}`, null);
    expect(live.status).toBe('ok');
    expect(live.html).toContain('Invitation');

    const dead = await renderRoute('/invite/not-a-real-code', null);
    expect(dead.status).toBe('ok');
    expect(dead.html).toContain('no longer usable');
  });
});
