// Integration tests for the platform admin surface (W116) — the
// (platform) group's API handlers and the waitlist page's pure view-model
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db
// port.
//
// Proves the admin surface end to end:
//   * the review queue API is platform-admin-gated — anonymous is a
//     uniform 401, a regular principal a uniform 403 (no leak about
//     which part failed);
//   * accept through the API makes the request an account (the person
//     signs in with the request's own password through the REAL auth
//     surface and flows into onboarding);
//   * decline with a note settles the request auditable;
//   * the page's gating decision (waitlistPageAccess) bounces anonymous
//     and regular visitors to the shell's ordinary targets — never an
//     access-denied page — while the platform admin renders;
//   * the messenger view-model: status labels pair tones, initials and
//     hues are stable, the empty state is honest.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.AURUM_PLATFORM_ADMIN_EMAILS;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../../scripts/migrate';
import {
  acceptWaitlistRequest,
  AUTH_AUTHORITY_ADMINISTER,
  registerUser,
  setPlatformAdminFlag,
  submitWaitlistRequest,
} from '@/modules/auth/contract';
import { SESSION_COOKIE } from '@/app/lib/session';
import {
  handleSignIn,
  handleSessionGet,
} from '@/app/(auth)/lib/api';
import { sessionTokenFromCookieHeader } from '@/app/lib/session';
import {
  handleWaitlistAcceptPost,
  handleWaitlistDeclinePost,
  handleWaitlistListGet,
} from '../lib/api';
import {
  WAITLIST_EMPTY_MESSAGE,
  WAITLIST_PAGE_COPY,
  waitlistDecidedLabel,
  waitlistHue,
  waitlistInitial,
  waitlistPageAccess,
  waitlistRequestedLabel,
  waitlistStatusLabel,
  waitlistStatusTone,
} from '../lib/waitlist-views';

const BASE = 'https://aurum.test/api/platform';

const password = (): string => ['ma', 'ple', '-loo', 'p-55'].join('');
const emailOf = (local: string): string => [local, '.', newId().slice(0, 8), '@example', '.test'].join('');

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

function getRequest(path: string, token: string | null = null): Request {
  return new Request(`${BASE}${path}`, {
    method: 'GET',
    headers: token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

interface Account {
  token: string;
  email: string;
  principalId: string;
}

async function account(local: string, admin: boolean): Promise<Account> {
  const email = emailOf(local);
  const issued = await registerUser({
    displayName: local.replace(/[.-]/g, ' '),
    email,
    password: password(),
  });
  if (admin) {
    await setPlatformAdminFlag(
      { principalId: issued.session.principalId, authority: [AUTH_AUTHORITY_ADMINISTER] },
      { email, platformAdmin: true },
    );
  }
  return { token: issued.token, email, principalId: issued.session.principalId };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The admin gate through the API
// ---------------------------------------------------------------------------

describe('the platform waitlist API gate', () => {
  it('refuses anonymous requests uniformly (401) and regular principals uniformly (403)', async () => {
    const regular = await account('platform-plain', false);
    const cases: { label: string; run: (token: string | null) => Promise<{ status: number; body: { error?: string } }> }[] = [
      { label: 'list', run: (token) => handleWaitlistListGet(getRequest('/waitlist', token)) },
      {
        label: 'accept',
        run: (token) => handleWaitlistAcceptPost(jsonRequest('/waitlist/accept', { requestId: newId() }, token)),
      },
      {
        label: 'decline',
        run: (token) => handleWaitlistDeclinePost(jsonRequest('/waitlist/decline', { requestId: newId() }, token)),
      },
    ];
    for (const { label, run } of cases) {
      const anonymous = await run(null);
      expect(anonymous.status, `${label} anonymous`).toBe(401);
      expect(anonymous.body['error'], `${label} anonymous`).toBe('unauthenticated');
      const refused = await run(regular.token);
      expect(refused.status, `${label} non-admin`).toBe(403);
      expect(refused.body['error'], `${label} non-admin`).toBe('forbidden');
    }
  });
});

// ---------------------------------------------------------------------------
// The review queue through the API
// ---------------------------------------------------------------------------

describe('the platform waitlist review API', () => {
  it('lists the queue for the admin (the request that is about to be decided)', async () => {
    const admin = await account('platform-admin-list', true);
    const email = emailOf('queue-person');
    await submitWaitlistRequest({ displayName: 'Quinn Queued', email, password: password() });
    const result = await handleWaitlistListGet(getRequest('/waitlist', admin.token));
    expect(result.status).toBe(200);
    const requests = result.body['requests'] as { email: string; status: string }[];
    const mine = requests.find((entry) => entry.email === email);
    expect(mine).toMatchObject({ email, status: 'pending' });
  });

  it('accept makes the account real: the person signs in through the auth API and reaches onboarding', async () => {
    const admin = await account('platform-admin-accept', true);
    const email = emailOf('accepted-person');
    const request = await submitWaitlistRequest({
      displayName: 'Ace Accepted',
      email,
      password: password(),
    });
    const accepted = await handleWaitlistAcceptPost(
      jsonRequest('/waitlist/accept', { requestId: request.id }, admin.token),
    );
    expect(accepted.status).toBe(200);
    expect((accepted.body['request'] as { status: string }).status).toBe('accepted');
    // The person signs in through the REAL auth surface.
    const signed = await handleSignIn(
      new Request('https://aurum.test/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: password() }),
      }),
    );
    expect(signed.status).toBe(200);
    const token = sessionTokenFromCookieHeader(signed.setCookie ?? null)!;
    // A fresh accepted account has no company yet — onboarding territory.
    const session = await handleSessionGet(
      new Request('https://aurum.test/api/auth/session', {
        method: 'GET',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(session.status).toBe(200);
    expect(session.body['status']).toBe('no-company');
  });

  it('decline settles with the note; the requester sees it at their next sign-in attempt', async () => {
    const admin = await account('platform-admin-decline', true);
    const email = emailOf('declined-person');
    const request = await submitWaitlistRequest({
      displayName: 'Dee Declined',
      email,
      password: password(),
    });
    const declined = await handleWaitlistDeclinePost(
      jsonRequest('/waitlist/decline', { requestId: request.id, note: 'Invitation only this quarter.' }, admin.token),
    );
    expect(declined.status).toBe(200);
    const body = declined.body['request'] as { status: string; note: string | null; decidedBy: string };
    expect(body.status).toBe('declined');
    expect(body.note).toBe('Invitation only this quarter.');
    expect(body.decidedBy).toBe(admin.principalId);
    const signed = await handleSignIn(
      new Request('https://aurum.test/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: password() }),
      }),
    );
    expect(signed.status).toBe(403);
    expect(signed.body['error']).toBe('request_declined');
    expect(signed.body['message']).toContain('Invitation only this quarter.');
  });

  it('deciding an unknown or settled id is the uniform 404 waitlist_not_found', async () => {
    const admin = await account('platform-admin-404', true);
    const unknown = await handleWaitlistAcceptPost(
      jsonRequest('/waitlist/accept', { requestId: newId() }, admin.token),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body['error']).toBe('waitlist_not_found');
    const email = emailOf('settled-person');
    const request = await submitWaitlistRequest({
      displayName: 'Settled Person',
      email,
      password: password(),
    });
    await acceptWaitlistRequest({ token: admin.token, requestId: request.id });
    const again = await handleWaitlistDeclinePost(
      jsonRequest('/waitlist/decline', { requestId: request.id }, admin.token),
    );
    expect(again.status).toBe(404);
    expect(again.body['error']).toBe('waitlist_not_found');
  });
});

// ---------------------------------------------------------------------------
// The page's gating decision + the messenger view-model (pure)
// ---------------------------------------------------------------------------

describe('waitlistPageAccess (the page gate)', () => {
  it('bounces anonymous visitors to /signin', () => {
    expect(waitlistPageAccess({ status: 'anonymous' })).toEqual({ decision: 'redirect', target: '/signin' });
  });

  it('bounces regular signed-in visitors to /chat — with or without a company', () => {
    expect(
      waitlistPageAccess({ status: 'authenticated', platformAdmin: false }),
    ).toEqual({ decision: 'redirect', target: '/chat' });
    expect(
      waitlistPageAccess({ status: 'no-company', platformAdmin: false }),
    ).toEqual({ decision: 'redirect', target: '/chat' });
    // A resolution that predates the flag (undefined) is treated as
    // non-admin — the gate fails closed, never open.
    expect(waitlistPageAccess({ status: 'authenticated' })).toEqual({ decision: 'redirect', target: '/chat' });
  });

  it('renders only for the platform admin', () => {
    expect(waitlistPageAccess({ status: 'authenticated', platformAdmin: true })).toEqual({ decision: 'render' });
    expect(waitlistPageAccess({ status: 'no-company', platformAdmin: true })).toEqual({ decision: 'render' });
  });
});

describe('the waitlist view-model', () => {
  it('status labels pair tones (color never carries meaning alone)', () => {
    expect(waitlistStatusLabel('pending')).toBe('Waiting');
    expect(waitlistStatusTone('pending')).toBe('neutral');
    expect(waitlistStatusLabel('accepted')).toBe('Accepted');
    expect(waitlistStatusTone('accepted')).toBe('positive');
    expect(waitlistStatusLabel('declined')).toBe('Declined');
    expect(waitlistStatusTone('declined')).toBe('risk');
  });

  it('the contact tile derives a stable initial and hue from the person', () => {
    expect(waitlistInitial('Dana Whitfield')).toBe('D');
    expect(waitlistInitial('  lower case ')).toBe('L');
    expect(waitlistInitial('')).toBe('?');
    const hue = waitlistHue('dana.whitfield@meridian-roasters.demo');
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(6);
    expect(waitlistHue('dana.whitfield@meridian-roasters.demo')).toBe(hue);
  });

  it('requested and decided labels carry the honest dates', () => {
    const requested = waitlistRequestedLabel('2026-10-08T09:12:00.000Z');
    expect(requested).toContain('Requested');
    expect(requested).toContain('Oct 8, 2026');
    expect(waitlistRequestedLabel('not-a-date')).toBe('');
    const decided = waitlistDecidedLabel({
      id: 'x',
      email: 'e@example.test',
      displayName: 'E',
      status: 'accepted',
      note: null,
      requestedAt: '2026-10-08T09:12:00.000Z',
      decidedAt: '2026-10-09T10:00:00.000Z',
      decidedBy: 'admin-id',
    });
    expect(decided).toBe('Accepted Oct 9');
    expect(
      waitlistDecidedLabel({
        id: 'x',
        email: 'e@example.test',
        displayName: 'E',
        status: 'pending',
        note: null,
        requestedAt: '2026-10-08T09:12:00.000Z',
        decidedAt: null,
        decidedBy: null,
      }),
    ).toBeNull();
  });

  it('the copy is messenger-toned and emoji-free', () => {
    expect(WAITLIST_EMPTY_MESSAGE).toBe('No requests waiting.');
    expect(WAITLIST_PAGE_COPY.title).toBe('Access requests');
    expect(WAITLIST_PAGE_COPY.blurb).toContain('Accept to create the account');
    for (const value of [WAITLIST_EMPTY_MESSAGE, WAITLIST_PAGE_COPY.title, WAITLIST_PAGE_COPY.blurb]) {
      expect(value).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});
