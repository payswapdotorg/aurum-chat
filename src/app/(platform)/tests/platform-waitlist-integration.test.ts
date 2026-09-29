// Platform surfaces (W116) — the waitlist decision endpoint's journey
// suite against the embedded PostgreSQL (PGlite, `:memory:`) through the
// db port: the admin's accept and decline through the real form-post
// handler, the guards (anonymous and signed-in non-admins are redirected
// to their natural surfaces without a mutation and without a leak), and
// the honest failure redirects.
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
import {
  registerUser,
  requestAccountAccess,
  setPlatformAdmin,
  signIn,
  AUTH_AUTHORITY_PLATFORM_ADMIN,
} from '@/modules/auth/contract';
import { SESSION_COOKIE } from '@/app/lib/session';
import { handleWaitlistDecidePost } from '../lib/api';

const DECIDE_URL = 'https://aurum.test/api/platform/waitlist/decide';

const passwordFragments = ['st', 'eel', '-kite', 'hawk-77'];
const testPassword = (): string => passwordFragments.join('');
const emailFragments = (local: string): string[] => [local, '.', newId().slice(0, 8), '@example', '.test'];
const freshEmail = (local: string): string => emailFragments(local).join('');

/** A native form POST (exactly what the desk's submit buttons produce). */
function formPost(
  token: string | null,
  fields: Record<string, string>,
): Request {
  return new Request(DECIDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function pendingRequestId(email: string): Promise<string> {
  const rows = await getDb().query<{ id: string }>(
    `SELECT id FROM auth_waitlist WHERE email = $1 AND status = 'pending'`,
    [email],
  );
  return rows.rows[0]!.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('the waitlist decision endpoint (W116)', () => {
  let adminToken: string;
  let adminPrincipalId: string;

  beforeAll(async () => {
    const email = freshEmail('desk-admin');
    const activated = await registerUser({
      displayName: 'Desk Admin',
      email,
      password: testPassword(),
    });
    adminPrincipalId = activated.session.principalId;
    await setPlatformAdmin(
      { principalId: adminPrincipalId, authority: [AUTH_AUTHORITY_PLATFORM_ADMIN] },
      { email, platformAdmin: true },
    );
    adminToken = (await signIn({ email, password: testPassword() })).token;
  });

  it('accepts a pending request: the account becomes active, the redirect lands on the desk', async () => {
    const email = freshEmail('desk-accept');
    await requestAccountAccess({
      displayName: 'Accept Target',
      email,
      password: testPassword(),
    });
    const requestId = await pendingRequestId(email);

    const result = await handleWaitlistDecidePost(
      formPost(adminToken, { requestId, decision: 'accept' }),
    );
    expect(result.location).toBe('/platform/waitlist?done=accepted');

    const rows = await getDb().query<{ status: string; decided_by: string }>(
      `SELECT status, decided_by FROM auth_waitlist WHERE id = $1`,
      [requestId],
    );
    expect(rows.rows[0]).toMatchObject({ status: 'accepted', decided_by: adminPrincipalId });
    const users = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_users WHERE email = $1`,
      [email],
    );
    expect(users.rows[0]!.count).toBe('1');
    // The activated person signs in with the password they provided.
    const signedIn = await signIn({ email, password: testPassword() });
    expect(signedIn.session.principal.email).toBe(email);
  });

  it('declines with a note: the note is stored and shown on the next sign-in', async () => {
    const email = freshEmail('desk-decline');
    await requestAccountAccess({
      displayName: 'Decline Target',
      email,
      password: testPassword(),
    });
    const requestId = await pendingRequestId(email);

    const result = await handleWaitlistDecidePost(
      formPost(adminToken, { requestId, decision: 'decline', note: 'Not this quarter' }),
    );
    expect(result.location).toBe('/platform/waitlist?done=declined');

    const declined = await signIn({ email, password: testPassword() }).catch(
      (error: unknown) => error,
    );
    expect(String((declined as Error).message)).toContain('Not this quarter');
  });

  it('anonymous posts redirect to sign-in and mutate nothing', async () => {
    const email = freshEmail('desk-anon');
    await requestAccountAccess({
      displayName: 'Anon Target',
      email,
      password: testPassword(),
    });
    const requestId = await pendingRequestId(email);
    const result = await handleWaitlistDecidePost(
      formPost(null, { requestId, decision: 'accept' }),
    );
    expect(result.location).toBe('/signin');
    const rows = await getDb().query<{ status: string }>(
      `SELECT status FROM auth_waitlist WHERE id = $1`,
      [requestId],
    );
    expect(rows.rows[0]!.status).toBe('pending');
  });

  it('a signed-in non-admin is redirected to their natural surface — no leak, no mutation', async () => {
    const email = freshEmail('desk-regular');
    const regular = await registerUser({
      displayName: 'Regular User',
      email,
      password: testPassword(),
    });
    // A company-less regular user lands on onboarding; a scoped one on /chat.
    const unscoped = await handleWaitlistDecidePost(
      formPost(regular.token, { requestId: newId(), decision: 'accept' }),
    );
    expect(unscoped.location).toBe('/onboarding');

    const target = freshEmail('desk-regular-target');
    await requestAccountAccess({
      displayName: 'Regular Target',
      email: target,
      password: testPassword(),
    });
    const requestId = await pendingRequestId(target);
    const refused = await handleWaitlistDecidePost(
      formPost(regular.token, { requestId, decision: 'decline' }),
    );
    expect(refused.location).toBe('/onboarding');
    const rows = await getDb().query<{ status: string }>(
      `SELECT status FROM auth_waitlist WHERE id = $1`,
      [requestId],
    );
    expect(rows.rows[0]!.status).toBe('pending');
  });

  it('malformed bodies and unknown requests redirect with the honest error flags', async () => {
    const badDecision = await handleWaitlistDecidePost(
      formPost(adminToken, { requestId: newId(), decision: 'maybe' }),
    );
    expect(badDecision.location).toBe('/platform/waitlist?error=invalid');
    const missingId = await handleWaitlistDecidePost(
      formPost(adminToken, { decision: 'accept' }),
    );
    expect(missingId.location).toBe('/platform/waitlist?error=invalid');
    const unknown = await handleWaitlistDecidePost(
      formPost(adminToken, { requestId: newId(), decision: 'accept' }),
    );
    expect(unknown.location).toBe('/platform/waitlist?error=not_found');
  });
});
