// Integration tests for the auth module (W058) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port — the module's
// acceptance surface, composed with REAL organizations contracts:
//
//   * register/sign-in/sign-out/renewal lifecycle (uniform failures,
//     token digests never raw);
//   * onboarding: createCompanyForSession provisions the company, owner
//     membership and default workspace and selects it — reaching a usable
//     TenantContext;
//   * company/workspace selection and the cross-scope guarantee: a switch
//     must verify membership first, a lost membership silently de-selects;
//   * invitations end to end: create → preview → redeem → membership,
//     idempotent redemption, revocation, expiry, email mismatch;
//   * the principal's company directory (re-verified, pruned).
//
// Fake credentials are assembled from fragments at runtime (never a
// realistic full literal in source — GitHub push protection).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { runMigrations } from '../../../../scripts/migrate';
import {
  addTenantMember,
  getTenantMembership,
  listWorkspaces,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
  removeTenantMember,
} from '@/modules/organizations/contract';
import {
  authenticateSession,
  createCompanyForSession,
  createInvite,
  getInviteByCode,
  listInvites,
  listUserCompanies,
  redeemInvite,
  registerUser,
  revokeInvite,
  selectCompany,
  selectWorkspace,
  signIn,
  signOut,
  AuthError,
  SESSION_IDLE_TTL_MS,
} from '../contract';

// ---------------------------------------------------------------------------
// Fragments (GitHub push protection: never a full literal in source)
// ---------------------------------------------------------------------------

const passwordFragments = ['st', 'eel', '-kite', 'hawk-77'];
const testPassword = (): string => passwordFragments.join('');
const otherPassword = (): string => ['br', 'onze', '-falcon-9'].join('');
const emailFragments = (local: string): string[] => [local, '@example', '.test'];
const testEmail = (local: string): string => emailFragments(local).join('');

/** Unique local part per test (the platform email namespace is global). */
function freshEmail(label: string): string {
  return testEmail(`${label}.${newId().slice(0, 8)}`);
}

let clockBase: number;

beforeAll(async () => {
  await runMigrations(getDb());
  clockBase = systemClock.now().getTime();
});

afterAll(async () => {
  await closeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Move the injectable clock forward by `ms` from the base. */
function advanceClock(ms: number): void {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockBase + ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function registeredUser(label: string): Promise<{ token: string; email: string; principalId: string }> {
  const email = freshEmail(label);
  const issued = await registerUser({
    displayName: label.replace(/[-.]/g, ' '),
    email,
    password: testPassword(),
  });
  return { token: issued.token, email, principalId: issued.session.principalId };
}

/** A second company provisioned through the organizations contract (foreign to any auth user). */
async function foreignCompany(name: string): Promise<{ tenantId: string; ownerId: string; adminCtx: { tenantId: string; principalId: string; authority: string[] } }> {
  const ownerId = newId();
  const tenant = await provisionTenant(
    { principalId: ownerId, authority: [ORGANIZATIONS_AUTHORITY_PROVISION] },
    { name: `${name} ${newId().slice(0, 8)}`, ownerPrincipalId: ownerId },
  );
  return {
    tenantId: tenant.id,
    ownerId,
    adminCtx: { tenantId: tenant.id, principalId: ownerId, authority: [] },
  };
}

// ---------------------------------------------------------------------------
// Registration and sign-in lifecycle
// ---------------------------------------------------------------------------

describe('registration and sign-in', () => {
  it('registers a principal and issues a session with no company yet', async () => {
    const issued = await registerUser({
      displayName: 'First Manager',
      email: freshEmail('first'),
      password: testPassword(),
    });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.session.principal.email).toBe(issued.session.principal.email.toLowerCase());
    expect(issued.session.company).toBeNull();

    const view = await authenticateSession({ token: issued.token });
    expect(view.principalId).toBe(issued.session.principalId);
    expect(view.company).toBeNull();
  });

  it('never stores the raw token (digest only)', async () => {
    const { token } = await registeredUser('digest');
    const rows = await getDb().query<{ token_hash: string }>(
      `SELECT token_hash FROM auth_sessions WHERE id = $1`,
      [(await authenticateSession({ token })).sessionId],
    );
    const stored = rows.rows[0]!.token_hash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(token);
    expect(stored.length).toBe(64);
  });

  it('rejects duplicate registration with email_taken', async () => {
    const email = freshEmail('dupe');
    await registerUser({ displayName: 'One', email, password: testPassword() });
    await expect(
      registerUser({ displayName: 'Two', email, password: testPassword() }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('sign-in: unknown email and wrong password are uniformly invalid_credentials', async () => {
    const { email } = await registeredUser('signin');
    await expect(
      signIn({ email: freshEmail('ghost'), password: testPassword() }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      signIn({ email, password: otherPassword() }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    const issued = await signIn({ email, password: testPassword() });
    expect(issued.session.principal.email).toBe(email);
  });

  it('sign-out revokes; the token is then uniformly unauthenticated', async () => {
    const { token } = await registeredUser('signout');
    await authenticateSession({ token });
    await signOut({ token });
    await expect(authenticateSession({ token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    // Idempotent and quiet — a second sign-out is still fine.
    await signOut({ token });
  });

  it('garbage and malformed tokens are uniformly unauthenticated', async () => {
    await expect(authenticateSession({ token: 'no-such-token' })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(authenticateSession({ token: '' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(authenticateSession({ token: 'bad token!' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

// ---------------------------------------------------------------------------
// Session renewal (idle-sliding under the absolute cap)
// ---------------------------------------------------------------------------

describe('session renewal', () => {
  it('slides the idle window once the write threshold passed', async () => {
    const { token } = await registeredUser('renew');
    const first = await authenticateSession({ token });
    advanceClock(SESSION_IDLE_TTL_MS / 2);
    const later = await authenticateSession({ token });
    expect(later.expiresAt).not.toBe(first.expiresAt);
    expect(later.lastSeenAt).not.toBeNull();
  });

  it('expires after the idle TTL of inactivity', async () => {
    const { token } = await registeredUser('idle');
    await authenticateSession({ token });
    advanceClock(SESSION_IDLE_TTL_MS + 60_000);
    await expect(authenticateSession({ token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('a signed-out session cannot be revived by renewal', async () => {
    const { token } = await registeredUser('dead');
    await signOut({ token });
    advanceClock(SESSION_IDLE_TTL_MS + 60_000);
    await expect(authenticateSession({ token })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});

// ---------------------------------------------------------------------------
// Onboarding: company creation (the journey to a usable TenantContext)
// ---------------------------------------------------------------------------

describe('onboarding — company creation', () => {
  it('creates the company, the owner membership and the default workspace, and selects it', async () => {
    const { token, principalId } = await registeredUser('founder');
    const { tenant, session } = await createCompanyForSession({
      token,
      name: `Lumen Works ${newId().slice(0, 6)}`,
    });
    expect(session.company).not.toBeNull();
    expect(session.company!.tenantId).toBe(tenant.id);
    expect(session.company!.role).toBe('owner');
    expect(session.company!.workspaceId).toBeNull();
    expect(session.company!.authority).toContain('actions:approve');

    // The organizations contract confirms the real membership/roles.
    const ctx = { tenantId: tenant.id, principalId, authority: session.company!.authority };
    const membership = await getTenantMembership(ctx, { principalId });
    expect(membership.role).toBe('owner');
    const workspaces = await listWorkspaces(ctx);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.slug).toBe('default');

    // The directory lists the created company.
    const companies = await listUserCompanies({ token });
    expect(companies.map((c) => c.tenantId)).toContain(tenant.id);
    expect(companies.find((c) => c.tenantId === tenant.id)!.addedVia).toBe('created');
  });

  it('propagates the provisioning contract errors (slug taken, invalid names)', async () => {
    const a = await registeredUser('slug-a');
    const b = await registeredUser('slug-b');
    const name = `Slug Clash ${newId().slice(0, 6)}`;
    const slug = `slug-${newId().slice(0, 8)}`;
    await createCompanyForSession({ token: a.token, name, slug });
    await expect(
      createCompanyForSession({ token: b.token, name: 'Other', slug }),
    ).rejects.toMatchObject({ code: 'tenant_slug_taken' });
    await expect(
      createCompanyForSession({ token: b.token, name: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('signing back in auto-selects the most recently used company', async () => {
    const { email } = await registeredUser('returning');
    const first = await signIn({ email, password: testPassword() });
    const { tenant } = await createCompanyForSession({
      token: first.token,
      name: `Returning Co ${newId().slice(0, 6)}`,
    });
    await signOut({ token: first.token });
    const second = await signIn({ email, password: testPassword() });
    expect(second.session.company).not.toBeNull();
    expect(second.session.company!.tenantId).toBe(tenant.id);
    expect(second.session.company!.role).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
// Company and workspace selection — the cross-scope guarantee
// ---------------------------------------------------------------------------

describe('company and workspace selection', () => {
  it('selects a second membership, and a company change drops the workspace', async () => {
    const owner = await registeredUser('switcher-owner');
    const { tenant: t1 } = await createCompanyForSession({
      token: owner.token,
      name: `Switch One ${newId().slice(0, 6)}`,
    });
    const joiner = await registeredUser('switcher-joiner');
    await addTenantMember(
      { tenantId: t1.id, principalId: owner.principalId, authority: [] },
      { principalId: joiner.principalId, role: 'admin' },
    );
    const { tenant: t2 } = await createCompanyForSession({
      token: joiner.token,
      name: `Switch Two ${newId().slice(0, 6)}`,
    });
    await selectCompany({ token: joiner.token, tenantId: t1.id });
    const workspaces = await listWorkspaces({
      tenantId: t1.id,
      principalId: joiner.principalId,
      authority: [],
    });
    await selectWorkspace({ token: joiner.token, workspaceId: workspaces[0]!.id });
    let view = await authenticateSession({ token: joiner.token });
    expect(view.company!.workspaceId).toBe(workspaces[0]!.id);

    await selectCompany({ token: joiner.token, tenantId: t2.id });
    view = await authenticateSession({ token: joiner.token });
    expect(view.company!.tenantId).toBe(t2.id);
    expect(view.company!.workspaceId).toBeNull();
  });

  it('refuses to select a company the principal is not a member of (no cross-scope)', async () => {
    const outsider = await registeredUser('outsider');
    const foreign = await foreignCompany('Initech');
    await expect(
      selectCompany({ token: outsider.token, tenantId: foreign.tenantId }),
    ).rejects.toMatchObject({ code: 'company_not_available' });
    const view = await authenticateSession({ token: outsider.token });
    expect(view.company).toBeNull();
  });

  it('silently de-selects when the membership is removed afterwards', async () => {
    const owner = await registeredUser('purge-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Purge Co ${newId().slice(0, 6)}`,
    });
    const member = await registeredUser('purged');
    await addTenantMember(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: member.principalId, role: 'member' },
    );
    await selectCompany({ token: member.token, tenantId: tenant.id });
    let view = await authenticateSession({ token: member.token });
    expect(view.company!.role).toBe('member');
    expect(view.company!.authority).toEqual([]);

    await removeTenantMember(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: member.principalId },
    );
    view = await authenticateSession({ token: member.token });
    expect(view.company).toBeNull();

    // The stale directory row is pruned on read.
    const companies = await listUserCompanies({ token: member.token });
    expect(companies.map((c) => c.tenantId)).not.toContain(tenant.id);
  });

  it('workspace selection verifies inside the active company only', async () => {
    const owner = await registeredUser('ws-owner');
    const { tenant: t1 } = await createCompanyForSession({
      token: owner.token,
      name: `Ws One ${newId().slice(0, 6)}`,
    });
    const foreign = await foreignCompany('Ws Foreign');
    const foreignWorkspaces = await listWorkspaces({
      tenantId: foreign.tenantId,
      principalId: foreign.ownerId,
      authority: [],
    });
    await expect(
      selectWorkspace({ token: owner.token, workspaceId: foreignWorkspaces[0]!.id }),
    ).rejects.toMatchObject({ code: 'workspace_not_available' });

    const own = await listWorkspaces({
      tenantId: t1.id,
      principalId: owner.principalId,
      authority: [],
    });
    const view = await selectWorkspace({ token: owner.token, workspaceId: own[0]!.id });
    expect(view.company!.workspaceId).toBe(own[0]!.id);
    const cleared = await selectWorkspace({ token: owner.token, workspaceId: null });
    expect(cleared.company!.workspaceId).toBeNull();
  });

  it('workspace selection requires an active company first', async () => {
    const { token } = await registeredUser('ws-no-company');
    const foreign = await foreignCompany('NoCo');
    const ws = await listWorkspaces({
      tenantId: foreign.tenantId,
      principalId: foreign.ownerId,
      authority: [],
    });
    await expect(
      selectWorkspace({ token, workspaceId: ws[0]!.id }),
    ).rejects.toMatchObject({ code: 'no_active_company' });
  });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

describe('invitations', () => {
  it('full lifecycle: create → preview → redeem → membership + selection', async () => {
    const owner = await registeredUser('inviter');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Invite Co ${newId().slice(0, 6)}`,
    });
    const email = freshEmail('invited');
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email },
    );
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const preview = await getInviteByCode({ code: issued.code });
    expect(preview.tenantName).toBe(tenant.name);
    expect(preview.email).toBe(email);
    expect(preview.role).toBe('member');

    const invited = await registerUser({
      displayName: 'Invited Member',
      email,
      password: testPassword(),
    });
    expect(invited.session.company).toBeNull();
    const view = await redeemInvite({ token: invited.token, code: issued.code });
    expect(view.company).not.toBeNull();
    expect(view.company!.tenantId).toBe(tenant.id);
    expect(view.company!.role).toBe('member');
    expect(view.company!.authority).toEqual([]);

    // Real membership through the organizations contract.
    const membership = await getTenantMembership(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: invited.session.principalId },
    );
    expect(membership.role).toBe('member');

    // The invite settled; a second redemption is uniformly not usable.
    await expect(
      redeemInvite({ token: invited.token, code: issued.code }),
    ).rejects.toMatchObject({ code: 'invite_not_found' });
    await expect(getInviteByCode({ code: issued.code })).rejects.toMatchObject({
      code: 'invite_not_found',
    });
  });

  it('workspace-scoped invitations grant the workspace membership too', async () => {
    const owner = await registeredUser('scoped-inviter');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Scoped Co ${newId().slice(0, 6)}`,
    });
    const workspaces = await listWorkspaces({
      tenantId: tenant.id,
      principalId: owner.principalId,
      authority: [],
    });
    const email = freshEmail('scoped');
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email, role: 'admin', workspaceId: workspaces[0]!.id },
    );
    const preview = await getInviteByCode({ code: issued.code });
    expect(preview.workspaceName).toBe(workspaces[0]!.name);
    expect(preview.role).toBe('admin');

    const invited = await registerUser({
      displayName: 'Scoped Member',
      email,
      password: testPassword(),
    });
    const view = await redeemInvite({ token: invited.token, code: issued.code });
    expect(view.company!.workspaceId).toBe(workspaces[0]!.id);
    expect(view.company!.role).toBe('admin');
  });

  it('only owners/admins may create and list invitations', async () => {
    const owner = await registeredUser('gate-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Gate Co ${newId().slice(0, 6)}`,
    });
    const member = await registeredUser('gate-member');
    await addTenantMember(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: member.principalId, role: 'member' },
    );
    const memberCtx = { tenantId: tenant.id, principalId: member.principalId, authority: [] };
    await expect(createInvite(memberCtx, { email: freshEmail('denied') })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(listInvites(memberCtx, {})).rejects.toMatchObject({ code: 'forbidden' });

    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email: freshEmail('ok') },
    );
    const roster = await listInvites(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      {},
    );
    expect(roster).toHaveLength(1);
    expect(roster[0]!.status).toBe('pending');
    expect(roster[0]!.email).toBe(issued.invite.email);
  });

  it('revocation makes a code uniformly unusable', async () => {
    const owner = await registeredUser('revoker');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Revoke Co ${newId().slice(0, 6)}`,
    });
    const email = freshEmail('revoked');
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email },
    );
    const revoked = await revokeInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { inviteId: issued.invite.id },
    );
    expect(revoked.status).toBe('revoked');
    await expect(getInviteByCode({ code: issued.code })).rejects.toMatchObject({
      code: 'invite_not_found',
    });
    const target = await registerUser({
      displayName: 'Too Late',
      email,
      password: testPassword(),
    });
    await expect(
      redeemInvite({ token: target.token, code: issued.code }),
    ).rejects.toMatchObject({ code: 'invite_not_found' });
  });

  it('expiry retires an invitation (lazily, uniformly)', async () => {
    const owner = await registeredUser('expiry-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Expiry Co ${newId().slice(0, 6)}`,
    });
    const email = freshEmail('expired');
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email },
    );
    advanceClock(7 * 24 * 60 * 60 * 1000 + 60_000);
    await expect(getInviteByCode({ code: issued.code })).rejects.toMatchObject({
      code: 'invite_not_found',
    });
    const target = await registerUser({
      displayName: 'Expired Invitee',
      email,
      password: testPassword(),
    });
    await expect(
      redeemInvite({ token: target.token, code: issued.code }),
    ).rejects.toMatchObject({ code: 'invite_not_found' });
    const rows = await getDb().query<{ status: string }>(
      `SELECT status FROM auth_invites WHERE id = $1`,
      [issued.invite.id],
    );
    expect(rows.rows[0]!.status).toBe('expired');
  });

  it('redemption requires the matching email', async () => {
    const owner = await registeredUser('mismatch-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Mismatch Co ${newId().slice(0, 6)}`,
    });
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email: freshEmail('intended') },
    );
    const other = await registeredUser('other-session');
    await expect(
      redeemInvite({ token: other.token, code: issued.code }),
    ).rejects.toMatchObject({ code: 'invite_email_mismatch' });
  });

  it('redeeming for a company you already joined is idempotent (invite still settles)', async () => {
    const owner = await registeredUser('idem-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Idem Co ${newId().slice(0, 6)}`,
    });
    const email = freshEmail('idem');
    const member = await registerUser({
      displayName: 'Already In',
      email,
      password: testPassword(),
    });
    await addTenantMember(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: member.session.principalId, role: 'member' },
    );
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email },
    );
    const view = await redeemInvite({ token: member.token, code: issued.code });
    expect(view.company!.tenantId).toBe(tenant.id);
    const rows = await getDb().query<{ status: string }>(
      `SELECT status FROM auth_invites WHERE id = $1`,
      [issued.invite.id],
    );
    expect(rows.rows[0]!.status).toBe('accepted');
  });

  it('re-inviting the same email supersedes the pending invitation', async () => {
    const owner = await registeredUser('reinvite-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Reinvite Co ${newId().slice(0, 6)}`,
    });
    const email = freshEmail('reinvite');
    const first = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email },
    );
    const second = await createInvite(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { email, role: 'admin' },
    );
    expect(second.code).not.toBe(first.code);
    const target = await registerUser({
      displayName: 'Reinvited',
      email,
      password: testPassword(),
    });
    const view = await redeemInvite({ token: target.token, code: second.code });
    expect(view.company!.role).toBe('admin');
    await expect(
      redeemInvite({ token: target.token, code: first.code }),
    ).rejects.toMatchObject({ code: 'invite_not_found' });
  });

  it('unknown codes are uniformly invite_not_found', async () => {
    await expect(getInviteByCode({ code: 'no-such-invite-code' })).rejects.toMatchObject({
      code: 'invite_not_found',
    });
    const { token } = await registeredUser('redeem-unknown');
    await expect(
      redeemInvite({ token, code: 'no-such-invite-code' }),
    ).rejects.toMatchObject({ code: 'invite_not_found' });
  });

  it('a demoted issuer cannot honor their outstanding invitation', async () => {
    const owner = await registeredUser('demote-owner');
    const { tenant } = await createCompanyForSession({
      token: owner.token,
      name: `Demote Co ${newId().slice(0, 6)}`,
    });
    const admin = await registeredUser('demoted-admin');
    await addTenantMember(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: admin.principalId, role: 'admin' },
    );
    const email = freshEmail('demoted-target');
    const issued = await createInvite(
      { tenantId: tenant.id, principalId: admin.principalId, authority: [] },
      { email },
    );
    await removeTenantMember(
      { tenantId: tenant.id, principalId: owner.principalId, authority: [] },
      { principalId: admin.principalId },
    );
    const target = await registerUser({
      displayName: 'Demoted Target',
      email,
      password: testPassword(),
    });
    await expect(
      redeemInvite({ token: target.token, code: issued.code }),
    ).rejects.toMatchObject({ code: 'tenant_not_found' });
  });
});

// ---------------------------------------------------------------------------
// The principal's company directory
// ---------------------------------------------------------------------------

describe('the company directory', () => {
  it('lists every verified company and marks how each was reached', async () => {
    const principal = await registeredUser('directory');
    const { tenant: own } = await createCompanyForSession({
      token: principal.token,
      name: `Directory Co ${newId().slice(0, 6)}`,
    });
    const other = await foreignCompany('Directory Other');
    await addTenantMember(
      { tenantId: other.tenantId, principalId: other.ownerId, authority: [] },
      { principalId: principal.principalId, role: 'member' },
    );
    await selectCompany({ token: principal.token, tenantId: other.tenantId });
    const companies = await listUserCompanies({ token: principal.token });
    expect(companies).toHaveLength(2);
    const byId = new Map(companies.map((c) => [c.tenantId, c]));
    expect(byId.get(own.id)!.addedVia).toBe('created');
    expect(byId.get(other.tenantId)!.addedVia).toBe('switch');
    expect(byId.get(other.tenantId)!.tenantName).toContain('Directory Other');
  });

  it('is scoped to the session principal (no cross-principal leakage)', async () => {
    const a = await registeredUser('dir-a');
    await createCompanyForSession({
      token: a.token,
      name: `Dir A Co ${newId().slice(0, 6)}`,
    });
    const b = await registeredUser('dir-b');
    const companies = await listUserCompanies({ token: b.token });
    expect(companies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error typing sanity (the contract's error surface)
// ---------------------------------------------------------------------------

describe('error surface', () => {
  it('throws typed AuthErrors', async () => {
    try {
      await authenticateSession({ token: 'definitely-not-a-live-token' });
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('unauthenticated');
    }
  });
});
