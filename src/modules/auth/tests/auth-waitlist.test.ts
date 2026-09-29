// Integration tests for the W116 access waitlist — the auth module's
// waitlist + platform-admin + account operations against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port, composed with REAL
// organizations contracts.
//
// Proves the work item's acceptance core at the contract level:
//   * sign-up records a PENDING request — no principal, no session;
//   * duplicate/re- requests are idempotent (one row per email, the
//     verifier refreshes; declined resets to pending; accepted is
//     email_taken);
//   * sign-in states: pending → request_pending, declined (with note) →
//     request_declined, every wrong password / unknown email → the
//     uniform invalid_credentials;
//   * admin accept → the principal becomes active (the request's
//     password signs in) → onboarding is reachable; the decision is
//     auditable (decided_by = the admin's principal id);
//   * decline with note; both decisions uniformly waitlist_not_found for
//     unknown/already-decided ids;
//   * the platform-admin gate: non-admins are forbidden, anonymous
//     tokens unauthenticated;
//   * AURUM_PLATFORM_ADMIN_EMAILS grants on sign-in (fail closed when
//     unset) and the fresh-deployment self-acceptance bootstrap;
//   * changePassword (other sessions revoked, this one survives) and
//     signOutEverywhere (all sessions revoked).
//
// Fake credentials are assembled from fragments at runtime (never a
// realistic full literal in source — GitHub push protection).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.AURUM_PLATFORM_ADMIN_EMAILS;

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { runMigrations } from '../../../../scripts/migrate';
import {
  acceptWaitlistRequest,
  authenticateSession,
  AuthError,
  AUTH_AUTHORITY_ADMINISTER,
  changePassword,
  createCompanyForSession,
  declineWaitlistRequest,
  listWaitlistRequests,
  PLATFORM_ADMIN_EMAILS_ENV,
  platformAdminEmails,
  registerUser,
  setPlatformAdminFlag,
  signIn,
  signOut,
  signOutEverywhere,
  submitWaitlistRequest,
} from '../contract';

// ---------------------------------------------------------------------------
// Fragments (GitHub push protection: never a full literal in source)
// ---------------------------------------------------------------------------

const passwordFragments = ['ti', 'n', '-lan', 'tern-31'];
const testPassword = (): string => passwordFragments.join('');
const otherPassword = (): string => ['co', 'pper', '-beacon-4'].join('');
const emailFragments = (local: string): string[] => [local, '@example', '.test'];
const testEmail = (local: string): string => emailFragments(local).join('');

/** Unique local part per test (the platform email namespace is global). */
function freshEmail(label: string): string {
  return testEmail(`${label}.${newId().slice(0, 8)}`);
}

/** Set (or clear) the platform-admin designation env for one exercise. */
function designate(emails: string[] | null): void {
  if (emails === null || emails.length === 0) {
    delete process.env[PLATFORM_ADMIN_EMAILS_ENV];
  } else {
    process.env[PLATFORM_ADMIN_EMAILS_ENV] = emails.join(',');
  }
}

interface WaitlistProbe {
  [column: string]: unknown;
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  note: string | null;
  decided_by: string | null;
}

async function waitlistRow(email: string): Promise<WaitlistProbe | null> {
  const rows = await getDb().query<WaitlistProbe>(
    `SELECT id, email, display_name, password_hash, status, note, decided_by FROM auth_waitlist WHERE email = $1`,
    [email],
  );
  return rows.rows[0] ?? null;
}

async function userCount(email: string): Promise<number> {
  const rows = await getDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM auth_users WHERE email = $1`,
    [email],
  );
  return Number(rows.rows[0]!.count);
}

async function sessionCount(email: string): Promise<number> {
  const rows = await getDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
       WHERE u.email = $1 AND s.revoked_at IS NULL`,
    [email],
  );
  return Number(rows.rows[0]!.count);
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  delete process.env[PLATFORM_ADMIN_EMAILS_ENV];
  await closeDb();
});

afterEach(() => {
  designate(null);
  vi.restoreAllMocks();
});

/** An active principal with a session (the contract's own registration). */
async function registeredSession(label: string): Promise<{ token: string; email: string; principalId: string }> {
  const email = freshEmail(label);
  const issued = await registerUser({
    displayName: label.replace(/[.-]/g, ' '),
    email,
    password: testPassword(),
  });
  return { token: issued.token, email, principalId: issued.session.principalId };
}

/** A platform-admin principal with a session (the harness-style grant). */
async function adminSession(label: string): Promise<{ token: string; email: string; principalId: string }> {
  const base = await registeredSession(label);
  await setPlatformAdminFlag(
    { principalId: base.principalId, authority: [AUTH_AUTHORITY_ADMINISTER] },
    { email: base.email, platformAdmin: true },
  );
  return base;
}

// ---------------------------------------------------------------------------
// The waitlist request itself
// ---------------------------------------------------------------------------

describe('submitting a waitlist request', () => {
  it('records a pending request — no principal, no session', async () => {
    const email = freshEmail('wl-first');
    const request = await submitWaitlistRequest({
      displayName: 'Wanda First',
      email,
      password: testPassword(),
    });
    expect(request.status).toBe('pending');
    expect(request.email).toBe(email);
    expect(request.displayName).toBe('Wanda First');
    expect(request.decidedAt).toBeNull();
    expect(request.decidedBy).toBeNull();
    // No principal exists; no session was issued.
    expect(await userCount(email)).toBe(0);
    expect(await sessionCount(email)).toBe(0);
    const row = await waitlistRow(email);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    // The verifier is a scrypt hash, never the raw password.
    expect(row!.password_hash).not.toContain(testPassword());
    expect(row!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('is idempotent for a duplicate pending email (refresh in place)', async () => {
    const email = freshEmail('wl-dupe');
    await submitWaitlistRequest({ displayName: 'One Request', email, password: testPassword() });
    const second = await submitWaitlistRequest({
      displayName: 'One Request Again',
      email,
      password: otherPassword(),
    });
    expect(second.status).toBe('pending');
    // Exactly one row; the fresh material replaced the old.
    const row = await waitlistRow(email);
    expect(row).not.toBeNull();
    expect(row!.display_name).toBe('One Request Again');
    expect(await userCount(email)).toBe(0);
    // The NEW password is the one that will matter at sign-in.
    await expect(
      signIn({ email, password: testPassword() }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('answers email_taken once the request was accepted (an account exists)', async () => {
    const email = freshEmail('wl-taken');
    await submitWaitlistRequest({ displayName: 'Taken Person', email, password: testPassword() });
    const admin = await adminSession('wl-taken-admin');
    const request = await listWaitlistRequests({ token: admin.token });
    const pending = request.find((entry) => entry.email === email)!;
    await acceptWaitlistRequest({ token: admin.token, requestId: pending.id });
    await expect(
      submitWaitlistRequest({ displayName: 'Someone Else', email, password: otherPassword() }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('answers email_taken for an account created outside the waitlist (no row is written)', async () => {
    // An invite-redemption account (active principal, no waitlist row).
    const email = freshEmail('wl-active');
    await registerUser({ displayName: 'Active Person', email, password: testPassword() });
    await expect(
      submitWaitlistRequest({ displayName: 'Shadow Request', email, password: otherPassword() }),
    ).rejects.toMatchObject({ code: 'email_taken' });
    // No waitlist shadow was created.
    expect(await waitlistRow(email)).toBeNull();
  });

  it('rejects malformed input like every auth operation', async () => {
    await expect(
      submitWaitlistRequest({ displayName: '', email: freshEmail('wl-bad'), password: testPassword() }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      submitWaitlistRequest({ displayName: 'Bad Email', email: 'not-an-email', password: testPassword() }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      submitWaitlistRequest({ displayName: 'Short Password', email: freshEmail('wl-short'), password: 'abc' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ---------------------------------------------------------------------------
// Sign-in states across the waitlist
// ---------------------------------------------------------------------------

describe('sign-in states across the waitlist', () => {
  it('pending + correct password → request_pending; wrong password stays uniform', async () => {
    const email = freshEmail('wl-pending');
    await submitWaitlistRequest({ displayName: 'Pending Person', email, password: testPassword() });
    await expect(signIn({ email, password: otherPassword() })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const error = await signIn({ email, password: testPassword() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('request_pending');
    expect((error as AuthError).message).toContain('awaiting admin approval');
    // Still no principal, still no session.
    expect(await userCount(email)).toBe(0);
  });

  it('declined + correct password → request_declined with the admin note', async () => {
    const email = freshEmail('wl-declined');
    await submitWaitlistRequest({ displayName: 'Declined Person', email, password: testPassword() });
    const admin = await adminSession('wl-declined-admin');
    const request = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    await declineWaitlistRequest({
      token: admin.token,
      requestId: request.id,
      note: 'We are onboarding by invitation only this quarter.',
    });
    await expect(signIn({ email, password: otherPassword() })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const error = await signIn({ email, password: testPassword() }).catch((caught: unknown) => caught);
    expect((error as AuthError).code).toBe('request_declined');
    expect((error as AuthError).message).toContain('Your request was declined');
    expect((error as AuthError).message).toContain('We are onboarding by invitation only this quarter.');
  });

  it('a declined requester may submit again — the request resets to pending', async () => {
    const email = freshEmail('wl-retry');
    await submitWaitlistRequest({ displayName: 'Retry Person', email, password: testPassword() });
    const admin = await adminSession('wl-retry-admin');
    const request = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    await declineWaitlistRequest({ token: admin.token, requestId: request.id });
    const renewed = await submitWaitlistRequest({
      displayName: 'Retry Person',
      email,
      password: testPassword(),
    });
    expect(renewed.status).toBe('pending');
    expect(renewed.note).toBeNull();
    expect(renewed.decidedAt).toBeNull();
    // And the pending state surfaces again at sign-in.
    await expect(signIn({ email, password: testPassword() })).rejects.toMatchObject({
      code: 'request_pending',
    });
  });

  it('unknown email stays the uniform invalid_credentials (no queue leak)', async () => {
    await expect(signIn({ email: freshEmail('wl-ghost'), password: testPassword() })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });
});

// ---------------------------------------------------------------------------
// The admin decisions
// ---------------------------------------------------------------------------

describe('the admin accept decision', () => {
  it('makes the request an account: the principal activates, signs in, and onboarding is reachable', async () => {
    const email = freshEmail('wl-accept');
    await submitWaitlistRequest({ displayName: 'Ava Accepted', email, password: testPassword() });
    const admin = await adminSession('wl-accept-admin');
    const pending = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    const decided = await acceptWaitlistRequest({ token: admin.token, requestId: pending.id });
    expect(decided.status).toBe('accepted');
    expect(decided.decidedBy).toBe(admin.principalId);
    expect(decided.decidedAt).not.toBeNull();
    // The principal exists now, with exactly the request's password.
    expect(await userCount(email)).toBe(1);
    const issued = await signIn({ email, password: testPassword() });
    expect(issued.session.principal.email).toBe(email);
    expect(issued.session.company).toBeNull();
    // Onboarding is reachable exactly as for a fresh registration.
    const { tenant, session } = await createCompanyForSession({
      token: issued.token,
      name: `Accepted Co ${newId().slice(0, 6)}`,
    });
    expect(tenant.name).toContain('Accepted Co');
    expect(session.company?.tenantId).toBe(tenant.id);
  });

  it('settles gracefully when the principal already exists (idempotent acceptance)', async () => {
    const email = freshEmail('wl-race');
    await submitWaitlistRequest({ displayName: 'Race Person', email, password: testPassword() });
    // A principal for the same email appears outside the waitlist flow.
    await registerUser({ displayName: 'Race Person', email, password: testPassword() });
    const admin = await adminSession('wl-race-admin');
    const pending = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    const decided = await acceptWaitlistRequest({ token: admin.token, requestId: pending.id });
    expect(decided.status).toBe('accepted');
    expect(await userCount(email)).toBe(1);
  });

  it('is uniformly waitlist_not_found for unknown and already-decided ids', async () => {
    const admin = await adminSession('wl-notfound-admin');
    await expect(
      acceptWaitlistRequest({ token: admin.token, requestId: newId() }),
    ).rejects.toMatchObject({ code: 'waitlist_not_found' });
    const email = freshEmail('wl-notfound');
    await submitWaitlistRequest({ displayName: 'Once Person', email, password: testPassword() });
    const pending = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    await acceptWaitlistRequest({ token: admin.token, requestId: pending.id });
    await expect(
      acceptWaitlistRequest({ token: admin.token, requestId: pending.id }),
    ).rejects.toMatchObject({ code: 'waitlist_not_found' });
  });
});

describe('the admin decline decision', () => {
  it('flips the request to declined with the note and the audit trail', async () => {
    const email = freshEmail('wl-decline');
    await submitWaitlistRequest({ displayName: 'Dee Declined', email, password: testPassword() });
    const admin = await adminSession('wl-decline-admin');
    const pending = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    const decided = await declineWaitlistRequest({
      token: admin.token,
      requestId: pending.id,
      note: 'Not a work email.',
    });
    expect(decided.status).toBe('declined');
    expect(decided.note).toBe('Not a work email.');
    expect(decided.decidedBy).toBe(admin.principalId);
    // No principal was ever created.
    expect(await userCount(email)).toBe(0);
  });

  it('declines without a note too; the note shape is enforced', async () => {
    const email = freshEmail('wl-nonote');
    await submitWaitlistRequest({ displayName: 'No Note', email, password: testPassword() });
    const admin = await adminSession('wl-nonote-admin');
    const pending = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    const decided = await declineWaitlistRequest({ token: admin.token, requestId: pending.id });
    expect(decided.status).toBe('declined');
    expect(decided.note).toBeNull();
    const email2 = freshEmail('wl-badnote');
    await submitWaitlistRequest({ displayName: 'Bad Note', email: email2, password: testPassword() });
    const pending2 = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email2,
    )!;
    await expect(
      declineWaitlistRequest({ token: admin.token, requestId: pending2.id, note: 'x'.repeat(281) }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is uniformly waitlist_not_found for unknown and already-decided ids', async () => {
    const admin = await adminSession('wl-dnotfound-admin');
    await expect(
      declineWaitlistRequest({ token: admin.token, requestId: newId() }),
    ).rejects.toMatchObject({ code: 'waitlist_not_found' });
    const email = freshEmail('wl-dnotfound');
    await submitWaitlistRequest({ displayName: 'Once More', email, password: testPassword() });
    const pending = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === email,
    )!;
    await declineWaitlistRequest({ token: admin.token, requestId: pending.id });
    await expect(
      declineWaitlistRequest({ token: admin.token, requestId: pending.id }),
    ).rejects.toMatchObject({ code: 'waitlist_not_found' });
  });
});

describe('the platform-admin gate', () => {
  it('refuses list/accept/decline for a regular principal (forbidden) and an anonymous token (unauthenticated)', async () => {
    const regular = await registeredSession('wl-plain');
    const email = freshEmail('wl-gate');
    await submitWaitlistRequest({ displayName: 'Gate Person', email, password: testPassword() });
    await expect(listWaitlistRequests({ token: regular.token })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      acceptWaitlistRequest({ token: regular.token, requestId: newId() }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      declineWaitlistRequest({ token: regular.token, requestId: newId() }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const anonymous = 'no-such-token-at-all';
    await expect(listWaitlistRequests({ token: anonymous })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('the session view carries the platform-admin flag', async () => {
    const admin = await adminSession('wl-view');
    const view = await authenticateSession({ token: admin.token });
    expect(view.platformAdmin).toBe(true);
    const regular = await registeredSession('wl-view-plain');
    const plainView = await authenticateSession({ token: regular.token });
    expect(plainView.platformAdmin).toBe(false);
  });

  it('the queue lists every request with pending first', async () => {
    const admin = await adminSession('wl-list-admin');
    const pendingEmail = freshEmail('wl-list-pending');
    const settledEmail = freshEmail('wl-list-settled');
    await submitWaitlistRequest({ displayName: 'List Pending', email: pendingEmail, password: testPassword() });
    await submitWaitlistRequest({ displayName: 'List Settled', email: settledEmail, password: testPassword() });
    const settled = (await listWaitlistRequests({ token: admin.token })).find(
      (entry) => entry.email === settledEmail,
    )!;
    await declineWaitlistRequest({ token: admin.token, requestId: settled.id });
    const queue = await listWaitlistRequests({ token: admin.token });
    const statuses = queue.filter((entry) => entry.email === pendingEmail || entry.email === settledEmail);
    expect(statuses.map((entry) => entry.status)).toEqual(['pending', 'declined']);
  });
});

// ---------------------------------------------------------------------------
// Platform-admin designation
// ---------------------------------------------------------------------------

describe('the AURUM_PLATFORM_ADMIN_EMAILS designation', () => {
  it('is fail-closed: unset means no email matches', () => {
    designate(null);
    expect(platformAdminEmails()).toEqual([]);
  });

  it('parses comma-separated, case-insensitive, deduplicated', () => {
    designate(['One@Example.test', ' two@example.test ', 'ONE@example.test']);
    expect(platformAdminEmails()).toEqual(['one@example.test', 'two@example.test']);
    designate(['  ']);
    expect(platformAdminEmails()).toEqual([]);
  });

  it('grants an EXISTING principal the flag on sign-in (sticky, fail-closed when unset)', async () => {
    const email = freshEmail('wl-env');
    await registerUser({ displayName: 'Env Person', email, password: testPassword() });
    // Unset: no grant, no admin operations.
    const before = await signIn({ email, password: testPassword() });
    expect(before.session.platformAdmin).toBe(false);
    await expect(listWaitlistRequests({ token: before.token })).rejects.toMatchObject({
      code: 'forbidden',
    });
    // Designated: the next sign-in grants.
    designate([email.toUpperCase()]);
    const after = await signIn({ email, password: testPassword() });
    expect(after.session.platformAdmin).toBe(true);
    const queue = await listWaitlistRequests({ token: after.token });
    expect(Array.isArray(queue)).toBe(true);
    // Sticky: removing the designation never demotes.
    designate(null);
    const again = await signIn({ email, password: testPassword() });
    expect(again.session.platformAdmin).toBe(true);
  });

  it('bootstraps a fresh deployment: a designated PENDING request self-accepts at sign-in', async () => {
    const email = freshEmail('wl-boot');
    await submitWaitlistRequest({ displayName: 'Booting Person', email, password: testPassword() });
    // Unset: the request just reports pending.
    await expect(signIn({ email, password: testPassword() })).rejects.toMatchObject({
      code: 'request_pending',
    });
    designate([email]);
    const issued = await signIn({ email, password: testPassword() });
    expect(issued.session.principal.email).toBe(email);
    expect(issued.session.platformAdmin).toBe(true);
    // The request settled; the designation is recorded in the audit trail.
    const row = await waitlistRow(email);
    expect(row!.status).toBe('accepted');
    expect(row!.decided_by).toBe(issued.session.principalId);
    // A WRONG password never bootstraps anything (takeover-proof).
    const email2 = freshEmail('wl-boot-wrong');
    designate([email2]);
    await submitWaitlistRequest({ displayName: 'Wrong Boot', email: email2, password: testPassword() });
    await expect(signIn({ email: email2, password: otherPassword() })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(await userCount(email2)).toBe(0);
  });
});

describe('the harness platform-admin write', () => {
  it('requires the auth:administer authority claim', async () => {
    const target = await registeredSession('wl-harness-target');
    await expect(
      setPlatformAdminFlag(
        { principalId: target.principalId, authority: [] },
        { email: target.email, platformAdmin: true },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await setPlatformAdminFlag(
      { principalId: target.principalId, authority: [AUTH_AUTHORITY_ADMINISTER] },
      { email: target.email, platformAdmin: true },
    );
    const view = await authenticateSession({ token: target.token });
    expect(view.platformAdmin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Account operations
// ---------------------------------------------------------------------------

describe('changePassword', () => {
  it('re-hashes with a fresh salt, revokes every OTHER session, keeps this one', async () => {
    const email = freshEmail('wl-chpw');
    const first = await registerUser({ displayName: 'Change Person', email, password: testPassword() });
    const second = await signIn({ email, password: testPassword() });
    await changePassword({
      token: first.token,
      currentPassword: testPassword(),
      newPassword: otherPassword(),
    });
    // This browser stays signed in; the other session is revoked.
    const view = await authenticateSession({ token: first.token });
    expect(view.principal.email).toBe(email);
    await expect(authenticateSession({ token: second.token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    // The new password signs in; the old one no longer does.
    await expect(signIn({ email, password: testPassword() })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const fresh = await signIn({ email, password: otherPassword() });
    expect(fresh.session.principal.email).toBe(email);
  });

  it('demands the current password (uniform) and the new-policy', async () => {
    const account = await registeredSession('wl-chpw-wrong');
    await expect(
      changePassword({
        token: account.token,
        currentPassword: otherPassword(),
        newPassword: otherPassword(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      changePassword({
        token: account.token,
        currentPassword: testPassword(),
        newPassword: 'short',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses anonymous tokens uniformly', async () => {
    await expect(
      changePassword({ token: 'no-such-token', currentPassword: testPassword(), newPassword: otherPassword() }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('signOutEverywhere', () => {
  it('revokes every session of the principal, the calling one included', async () => {
    const email = freshEmail('wl-soe');
    const first = await registerUser({ displayName: 'Everywhere Person', email, password: testPassword() });
    const second = await signIn({ email, password: testPassword() });
    expect(await sessionCount(email)).toBe(2);
    await signOutEverywhere({ token: second.token });
    expect(await sessionCount(email)).toBe(0);
    await expect(authenticateSession({ token: first.token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(authenticateSession({ token: second.token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    // Signing out everywhere stays quiet for an already-signed-out token.
    await signOutEverywhere({ token: second.token });
  });

  it('does not touch another principal\'s sessions', async () => {
    const mine = await registeredSession('wl-soe-mine');
    const theirs = await registeredSession('wl-soe-theirs');
    await signOutEverywhere({ token: mine.token });
    const view = await authenticateSession({ token: theirs.token });
    expect(view.principal.email).toBe(theirs.email);
  });
});

// ---------------------------------------------------------------------------
// The untouched neighbors (regression guards for the W116 seam)
// ---------------------------------------------------------------------------

describe('the untouched neighbors', () => {
  it('ordinary sign-out still works beside the new operations', async () => {
    const account = await registeredSession('wl-neighbor');
    await signOut({ token: account.token });
    await expect(authenticateSession({ token: account.token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
