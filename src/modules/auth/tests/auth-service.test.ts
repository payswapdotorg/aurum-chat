// Integration tests for the auth module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. The W058 acceptance surface:
//
//   * sign-up / sign-in / sign-out / session renewal;
//   * company (tenant) creation and selection — a session may only ever
//     point at a company its principal is a LIVE-VERIFIED member of
//     ("tenant switching cannot cross scope");
//   * workspace selection inside the active company;
//   * membership invitations: issue / list / revoke / inspect / accept,
//     including the inviter-authority re-check at acceptance time;
//   * a revoked membership degrades a session to "no active company"
//     (never to data access) — ADR-0001 at the session boundary.
//
// Cross-tenant coverage deliberately mirrors the organizations module's
// no-existence-leak doctrine: a foreign company id and a company the
// principal was removed from are the SAME `tenant_unavailable`.
//
// CREDENTIAL HYGIENE: fake credentials are assembled from fragments at
// runtime — never a realistic full literal in source.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import {
  addTenantMember,
  changeTenantMemberRole,
  createWorkspace,
  getTenantMembership,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
  removeTenantMember,
} from '@/modules/organizations/contract';
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
  SESSION_TTL_MS,
  SESSION_RENEWAL_WINDOW_MS,
  signIn,
  signOut,
  signOutEverywhere,
  signUp,
  switchTenant,
} from '../contract';

// ---------------------------------------------------------------------------
// Fake credentials (assembled from fragments at runtime)
// ---------------------------------------------------------------------------

function fakeEmail(): string {
  return [newId().slice(0, 8), 'aurum', 'test'].join('.') + '@example.invalid';
}

function fakePassword(): string {
  return ['correct', 'horse', 'battery', newId().slice(0, 4)].join('-');
}

// ---------------------------------------------------------------------------
// Clock control
// ---------------------------------------------------------------------------

let clockMs = Date.parse('2026-09-20T09:00:00Z');
const clockSpy = vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));

/** Advance the fake clock (ms). */
function advance(ms: number): void {
  clockMs += ms;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface AccountFixture {
  email: string;
  password: string;
  token: string;
  principalId: string;
}

async function freshAccount(displayName = 'Dana Okafor'): Promise<AccountFixture> {
  const email = fakeEmail();
  const password = fakePassword();
  const result = await signUp({ email, password, displayName });
  return { email, password, token: result.token, principalId: result.principal.id };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  clockSpy.mockRestore();
  await closeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function authErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  throw new Error('expected an AuthError');
}

// ---------------------------------------------------------------------------
// Accounts and sessions
// ---------------------------------------------------------------------------

describe('sign-up and sign-in', () => {
  it('creates an account and opens a session (the token appears exactly once)', async () => {
    const email = fakeEmail();
    const password = fakePassword();
    const up = await signUp({ email, password, displayName: 'Dana' });
    expect(up.principal.email).toBe(email);
    expect(up.principal.displayName).toBe('Dana');
    expect(up.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(up.expiresAt).toBe(new Date(clockMs + SESSION_TTL_MS).toISOString());

    const resolved = await resolveSession(up.token);
    expect(resolved.status).toBe('valid');
    if (resolved.status === 'valid') {
      expect(resolved.resolved.principal.email).toBe(email);
      expect(resolved.resolved.tenant).toBeNull(); // fresh account: no company yet
      expect(resolved.resolved.context).toBeNull();
    }
  });

  it('rejects duplicate emails, bad emails, weak passwords and blank names', async () => {
    const email = fakeEmail();
    await signUp({ email, password: fakePassword(), displayName: 'A' });
    expect(
      await authErrorCode(signUp({ email, password: fakePassword(), displayName: 'A' })),
    ).toBe('email_taken');
    expect(
      await authErrorCode(signUp({ email: 'garbage', password: fakePassword(), displayName: 'A' })),
    ).toBe('invalid_input');
    expect(
      await authErrorCode(signUp({ email: fakeEmail(), password: 'short', displayName: 'A' })),
    ).toBe('invalid_input');
    expect(
      await authErrorCode(signUp({ email: fakeEmail(), password: fakePassword(), displayName: '  ' })),
    ).toBe('invalid_input');
  });

  it('signs in with correct credentials and preselects the last activated company', async () => {
    const account = await freshAccount();
    const company = await createCompany(account.token, { name: `Acme ${newId().slice(0, 6)}` });

    const in_ = await signIn({ email: account.email, password: account.password });
    expect(in_.principal.id).toBe(account.principalId);
    const resolved = await resolveSession(in_.token);
    expect(resolved.status).toBe('valid');
    if (resolved.status === 'valid') {
      expect(resolved.resolved.tenant?.id).toBe(company.tenant.id);
    }
  });

  it('a wrong password and an unknown email are the SAME error (no enumeration)', async () => {
    const account = await freshAccount();
    const wrong = await authErrorCode(
      signIn({ email: account.email, password: `${account.password}x` }),
    );
    const unknown = await authErrorCode(
      signIn({ email: fakeEmail(), password: account.password }),
    );
    expect(wrong).toBe('invalid_credentials');
    expect(unknown).toBe('invalid_credentials');
  });

  it('a disabled account cannot sign in and its sessions die with it', async () => {
    const account = await freshAccount();
    await getDb().query(
      `UPDATE auth_principals SET status = 'disabled' WHERE id = $1`,
      [account.principalId],
    );
    expect(await authErrorCode(signIn({ email: account.email, password: account.password }))).toBe(
      'principal_disabled',
    );
    const resolved = await resolveSession(account.token);
    expect(resolved.status).toBe('disabled');
  });
});

describe('sign-out and renewal', () => {
  it('signOut revokes exactly one session; signOutEverywhere revokes all', async () => {
    const account = await freshAccount();
    const second = await signIn({ email: account.email, password: account.password });

    await signOut(account.token);
    expect((await resolveSession(account.token)).status).toBe('invalid');
    expect((await resolveSession(second.token)).status).toBe('valid');

    const third = await signIn({ email: account.email, password: account.password });
    await signOutEverywhere(third.token);
    expect((await resolveSession(second.token)).status).toBe('invalid');
    expect((await resolveSession(third.token)).status).toBe('invalid');
  });

  it('resolveSession renews sliding-window sessions and extends their lifetime', async () => {
    const account = await freshAccount();
    // Fresh session: far from the renewal window — no renewal.
    let resolved = await resolveSession(account.token);
    expect(resolved.status).toBe('valid');
    if (resolved.status !== 'valid') return;
    const originalExpiry = Date.parse(resolved.resolved.session.expiresAt);

    // Past the renewal window (less than half the TTL remains) → renewal.
    advance(SESSION_TTL_MS - SESSION_RENEWAL_WINDOW_MS + 60_000);
    resolved = await resolveSession(account.token);
    expect(resolved.status).toBe('valid');
    if (resolved.status !== 'valid') return;
    expect(Date.parse(resolved.resolved.session.expiresAt)).toBeGreaterThan(originalExpiry);

    // Explicit renewal extends from NOW, not from the old expiry.
    advance(60_000);
    const renewed = await renewSession(account.token);
    expect(Date.parse(renewed.expiresAt)).toBe(clockMs + SESSION_TTL_MS);
  });

  it('an expired session resolves as expired and cannot be renewed', async () => {
    const account = await freshAccount();
    advance(SESSION_TTL_MS + 1_000);
    expect((await resolveSession(account.token)).status).toBe('expired');
    expect(await authErrorCode(renewSession(account.token))).toBe('session_expired');
  });
});

// ---------------------------------------------------------------------------
// Company onboarding and selection — the scope-safety core
// ---------------------------------------------------------------------------

describe('company creation and tenant switching', () => {
  it('createCompany provisions the company, makes the principal its owner, and scopes the session', async () => {
    const account = await freshAccount();
    const { tenant, workspace } = await createCompany(account.token, {
      name: `Globex ${newId().slice(0, 6)}`,
    });
    expect(tenant.role).toBe('owner');
    expect(workspace?.slug).toBe('default');

    const resolved = await resolveSession(account.token);
    expect(resolved.status).toBe('valid');
    if (resolved.status !== 'valid') throw new Error('unresolved');
    expect(resolved.resolved.tenant?.id).toBe(tenant.id);
    expect(resolved.resolved.workspace?.id).toBe(workspace?.id);
    // The context is the ready-made TenantContext with ROLE-DERIVED claims.
    expect(resolved.resolved.context).toEqual({
      tenantId: tenant.id,
      principalId: account.principalId,
      authority: expect.arrayContaining(['actions:approve']),
    });
  });

  it('createCompany rejects duplicate slugs with a typed error', async () => {
    const account = await freshAccount();
    const slug = `dup-${newId().slice(0, 8)}`;
    await createCompany(account.token, { name: 'One', slug });
    expect(await authErrorCode(createCompany(account.token, { name: 'Two', slug }))).toBe(
      'slug_taken',
    );
  });

  it('a principal with two companies can switch between them; the workspace resets', async () => {
    const account = await freshAccount();
    const a = await createCompany(account.token, { name: `Alpha ${newId().slice(0, 6)}` });
    const b = await createCompany(account.token, { name: `Beta ${newId().slice(0, 6)}` });

    // The session now sits on company B (the newest). Select a workspace of
    // A AFTER switching back to it — selection is always inside the ACTIVE
    // company.
    const ctxA: TenantContext = {
      tenantId: a.tenant.id,
      principalId: account.principalId,
      authority: [],
    };
    const growth = await createWorkspace(ctxA, { name: 'Growth' });
    await switchTenant(account.token, { tenantId: a.tenant.id });
    const selected = await selectWorkspace(account.token, { workspaceId: growth.id });
    expect(selected.tenant?.id).toBe(a.tenant.id);
    expect(selected.workspace?.id).toBe(growth.id);

    const switched = await switchTenant(account.token, { tenantId: b.tenant.id });
    expect(switched.tenant?.id).toBe(b.tenant.id);
    expect(switched.workspace).toBeNull(); // switching always clears the workspace

    const back = await switchTenant(account.token, { tenantId: a.tenant.id });
    expect(back.tenant?.id).toBe(a.tenant.id);
    expect(back.workspace).toBeNull();
  });

  it('switching to a company the principal does not belong to fails (no cross-scope)', async () => {
    const account = await freshAccount();
    const stranger = await freshAccount('Someone Else');
    const foreign = await createCompany(stranger.token, { name: `Initech ${newId().slice(0, 6)}` });

    expect(await authErrorCode(switchTenant(account.token, { tenantId: foreign.tenant.id }))).toBe(
      'tenant_unavailable',
    );
    // The session is untouched by the failed attempt.
    const resolved = await resolveSession(account.token);
    if (resolved.status !== 'valid') throw new Error('unresolved');
    expect(resolved.resolved.tenant?.id).not.toBe(foreign.tenant.id);
  });

  it('a membership revoked mid-session degrades the session to no active company', async () => {
    const owner = await freshAccount('The Owner');
    const employee = await freshAccount('The Employee');
    const company = await createCompany(owner.token, { name: `Acme ${newId().slice(0, 6)}` });
    const ownerCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    await addTenantMember(ownerCtx, {
      principalId: employee.principalId,
      role: 'member',
    });
    await switchTenant(employee.token, { tenantId: company.tenant.id });
    let resolved = await resolveSession(employee.token);
    if (resolved.status !== 'valid') throw new Error('unresolved');
    expect(resolved.resolved.tenant?.id).toBe(company.tenant.id);

    // Revocation: the NEXT resolution must not hand out a context.
    await removeTenantMember(ownerCtx, { principalId: employee.principalId });
    resolved = await resolveSession(employee.token);
    if (resolved.status !== 'valid') throw new Error('unresolved');
    expect(resolved.resolved.tenant).toBeNull();
    expect(resolved.resolved.workspace).toBeNull();
    expect(resolved.resolved.context).toBeNull();

    // And re-switching to it fails like any other company the principal
    // is not a member of.
    expect(
      await authErrorCode(switchTenant(employee.token, { tenantId: company.tenant.id })),
    ).toBe('tenant_unavailable');
  });

  it('listReachableTenants verifies live and prunes dead activations', async () => {
    const owner = await freshAccount('Owner Two');
    const employee = await freshAccount('Employee Two');
    const company = await createCompany(owner.token, { name: `Umbrella ${newId().slice(0, 6)}` });
    const ownerCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    await addTenantMember(ownerCtx, { principalId: employee.principalId, role: 'member' });
    await switchTenant(employee.token, { tenantId: company.tenant.id });

    let reachable = await listReachableTenants(employee.token);
    expect(reachable.map((t) => t.id)).toContain(company.tenant.id);

    await removeTenantMember(ownerCtx, { principalId: employee.principalId });
    reachable = await listReachableTenants(employee.token);
    expect(reachable.map((t) => t.id)).not.toContain(company.tenant.id);
    // The dead activation row was pruned.
    const rows = await getDb().query<{ tenant_id: string }>(
      `SELECT tenant_id FROM auth_principal_tenants WHERE principal_id = $1`,
      [employee.principalId],
    );
    expect(rows.rows.map((r) => r.tenant_id)).not.toContain(company.tenant.id);
  });
});

describe('workspace selection', () => {
  it('selects a visible workspace and rejects foreign or invisible ones', async () => {
    const owner = await freshAccount('Ws Owner');
    const company = await createCompany(owner.token, { name: `Wayne ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const growth = await createWorkspace(ctx, { name: 'Growth' });

    const selected = await selectWorkspace(owner.token, { workspaceId: growth.id });
    expect(selected.workspace?.id).toBe(growth.id);

    // A workspace of ANOTHER company is unavailable (no existence leak).
    const stranger = await freshAccount('Ws Stranger');
    const other = await createCompany(stranger.token, { name: `Lex ${newId().slice(0, 6)}` });
    const otherCtx: TenantContext = {
      tenantId: other.tenant.id,
      principalId: stranger.principalId,
      authority: [],
    };
    const otherWorkspace = await createWorkspace(otherCtx, { name: 'Secret' });
    expect(
      await authErrorCode(selectWorkspace(owner.token, { workspaceId: otherWorkspace.id })),
    ).toBe('workspace_unavailable');
  });

  it('requires an active company first', async () => {
    const account = await freshAccount();
    expect(
      await authErrorCode(selectWorkspace(account.token, { workspaceId: newId() })),
    ).toBe('no_active_tenant');
  });

  it('a plain member cannot select a workspace they do not belong to', async () => {
    const owner = await freshAccount('Ws Owner Two');
    const member = await freshAccount('Ws Member');
    const company = await createCompany(owner.token, { name: `Stark ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const secret = await createWorkspace(ctx, { name: 'Board' });
    await addTenantMember(ctx, { principalId: member.principalId, role: 'member' });
    await switchTenant(member.token, { tenantId: company.tenant.id });

    expect(
      await authErrorCode(selectWorkspace(member.token, { workspaceId: secret.id })),
    ).toBe('workspace_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

describe('invitations', () => {
  it('an owner invites a colleague by email; the raw token appears exactly once', async () => {
    const owner = await freshAccount('Inv Owner');
    const company = await createCompany(owner.token, { name: `Hooli ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const email = fakeEmail();
    const created = await createInvitation(ctx, { email, tenantRole: 'member' });
    expect(created.status).toBe('pending');
    expect(created.email).toBe(email);
    expect(created.tenantName).toBe(company.tenant.name);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const listed = await listInvitations(ctx);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe('pending');
    expect(listed[0]).not.toHaveProperty('token');

    const inspected = await inspectInvitation(created.token);
    expect(inspected).toMatchObject({ status: 'pending', tenantName: company.tenant.name });
  });

  it('only owners/admins may invite; admins may only grant plain membership', async () => {
    const owner = await freshAccount('Inv Owner Two');
    const admin = await freshAccount('Inv Admin');
    const member = await freshAccount('Inv Member');
    const company = await createCompany(owner.token, { name: `Pied ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    await addTenantMember(ctx, { principalId: admin.principalId, role: 'admin' });
    await addTenantMember(ctx, { principalId: member.principalId, role: 'member' });

    const adminCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: admin.principalId,
      authority: [],
    };
    const memberCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: member.principalId,
      authority: [],
    };

    expect(await authErrorCode(createInvitation(memberCtx, { email: fakeEmail(), tenantRole: 'member' }))).toBe(
      'forbidden',
    );
    expect(await authErrorCode(createInvitation(adminCtx, { email: fakeEmail(), tenantRole: 'admin' }))).toBe(
      'forbidden',
    );
    await expect(
      createInvitation(adminCtx, { email: fakeEmail(), tenantRole: 'member' }),
    ).resolves.toBeTruthy();
    await expect(
      createInvitation(ctx, { email: fakeEmail(), tenantRole: 'admin' }),
    ).resolves.toBeTruthy();
    // Listing is also a manager-only surface.
    expect(await authErrorCode(listInvitations(memberCtx))).toBe('forbidden');
  });

  it('a foreign context cannot list or create invitations in the company', async () => {
    const owner = await freshAccount('Inv Owner Three');
    const stranger = await freshAccount('Inv Stranger');
    const company = await createCompany(owner.token, { name: `Gekko ${newId().slice(0, 6)}` });
    const strangerCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: stranger.principalId,
      authority: [],
    };
    expect(await authErrorCode(listInvitations(strangerCtx))).toBe('tenant_unavailable');
    expect(
      await authErrorCode(createInvitation(strangerCtx, { email: fakeEmail(), tenantRole: 'member' })),
    ).toBe('tenant_unavailable');
  });

  it('accepting with the invited email joins the company and scopes the session', async () => {
    const owner = await freshAccount('Inv Owner Four');
    const company = await createCompany(owner.token, { name: `Wonka ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const email = fakeEmail();
    const created = await createInvitation(ctx, { email, tenantRole: 'member' });

    const colleague = await signUp({
      email,
      password: fakePassword(),
      displayName: 'Colleague',
    });
    const accepted = await acceptInvitation(colleague.token, {
      invitationToken: created.token,
    });
    expect(accepted.tenant.id).toBe(company.tenant.id);
    expect(accepted.tenant.role).toBe('member');

    const resolved = await resolveSession(colleague.token);
    if (resolved.status !== 'valid') throw new Error('unresolved');
    expect(resolved.resolved.tenant?.id).toBe(company.tenant.id);
    // Membership role drives the context authority — a member has no
    // approve claim.
    expect(resolved.resolved.context?.authority).not.toContain('actions:approve');

    const listed = await listInvitations(ctx);
    expect(listed[0]!.status).toBe('accepted');
    expect(listed[0]!.acceptedAt).not.toBeNull();
  });

  it('an invitation link only works for the invited email and only while open', async () => {
    const owner = await freshAccount('Inv Owner Five');
    const company = await createCompany(owner.token, { name: `Duff ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const email = fakeEmail();
    const created = await createInvitation(ctx, { email, tenantRole: 'member' });

    // Wrong account email → not transferable.
    const other = await freshAccount('Wrong Account');
    expect(
      await authErrorCode(acceptInvitation(other.token, { invitationToken: created.token })),
    ).toBe('invitation_email_mismatch');

    // Revoked → not pending.
    await revokeInvitation(ctx, { invitationId: created.id });
    const rightAccount = await signUp({ email, password: fakePassword(), displayName: 'Right' });
    expect(
      await authErrorCode(
        acceptInvitation(rightAccount.token, { invitationToken: created.token }),
      ),
    ).toBe('invitation_not_pending');
    expect((await inspectInvitation(created.token)).status).toBe('revoked');

    // Expired → expired (invitation lifetime is 7 days).
    const email2 = fakeEmail();
    const created2 = await createInvitation(ctx, { email: email2, tenantRole: 'member' });
    advance(7 * 24 * 60 * 60 * 1000 + 1_000);
    expect((await inspectInvitation(created2.token)).status).toBe('expired');
    const late = await signUp({ email: email2, password: fakePassword(), displayName: 'Late' });
    expect(
      await authErrorCode(acceptInvitation(late.token, { invitationToken: created2.token })),
    ).toBe('invitation_expired');
  });

  it('a re-invite supersedes the previous open invitation (one open invite per email)', async () => {
    const owner = await freshAccount('Inv Owner Six');
    const company = await createCompany(owner.token, { name: `Vandelay ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const email = fakeEmail();
    const first = await createInvitation(ctx, { email, tenantRole: 'member' });
    const second = await createInvitation(ctx, { email, tenantRole: 'member' });
    expect(first.id).not.toBe(second.id);
    expect((await inspectInvitation(first.token)).status).toBe('revoked');
    expect((await inspectInvitation(second.token)).status).toBe('pending');
    const listed = await listInvitations(ctx);
    expect(listed.filter((invite) => invite.status === 'pending')).toHaveLength(1);
  });

  it('the grant runs with the INVITER authority — a demoted inviter can no longer grant', async () => {
    const owner = await freshAccount('Inv Owner Seven');
    const admin = await freshAccount('Inv Admin Seven');
    const company = await createCompany(owner.token, { name: `Oceanic ${newId().slice(0, 6)}` });
    const ownerCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    await addTenantMember(ownerCtx, { principalId: admin.principalId, role: 'admin' });
    const adminCtx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: admin.principalId,
      authority: [],
    };
    const email = fakeEmail();
    const created = await createInvitation(adminCtx, { email, tenantRole: 'member' });

    // The admin is demoted to plain member BEFORE acceptance: the
    // organizations contract must refuse the grant (invitations never
    // outlive their inviter's authority).
    await changeTenantMemberRole(ownerCtx, { principalId: admin.principalId, role: 'member' });
    const invitee = await signUp({ email, password: fakePassword(), displayName: 'Invitee' });
    expect(
      await authErrorCode(acceptInvitation(invitee.token, { invitationToken: created.token })),
    ).toBe('grant_failed');
  });

  it('a workspace invitation adds the workspace membership alongside the tenant grant', async () => {
    const owner = await freshAccount('Inv Owner Eight');
    const company = await createCompany(owner.token, { name: `Dunder ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: company.tenant.id,
      principalId: owner.principalId,
      authority: [],
    };
    const sales = await createWorkspace(ctx, { name: 'Sales' });
    const email = fakeEmail();
    const created = await createInvitation(ctx, {
      email,
      tenantRole: 'member',
      workspaceId: sales.id,
      workspaceRole: 'member',
    });
    const invitee = await signUp({ email, password: fakePassword(), displayName: 'Salesperson' });
    const accepted = await acceptInvitation(invitee.token, { invitationToken: created.token });
    expect(accepted.workspaceAdded).toBe(true);
    expect(accepted.workspace?.id).toBe(sales.id);

    const resolved = await resolveSession(invitee.token);
    if (resolved.status !== 'valid') throw new Error('unresolved');
    expect(resolved.resolved.workspace?.id).toBe(sales.id);
  });

  it('unknown invitation tokens are uniformly not_found (no probing)', async () => {
    const guesser = await freshAccount('Guesser');
    expect((await inspectInvitation(guesser.token.slice(0, 40))).status).toBe('not_found');
    expect(await authErrorCode(acceptInvitation(guesser.token, { invitationToken: newId() }))).toBe(
      'invitation_not_found',
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-check with the organizations contract (the composition is real)
// ---------------------------------------------------------------------------

describe('composition with the organizations contract', () => {
  it('a company created through auth is a first-class tenant for the organizations contract', async () => {
    const account = await freshAccount('Comp Owner');
    const { tenant } = await createCompany(account.token, { name: `Virtu ${newId().slice(0, 6)}` });
    const ctx: TenantContext = {
      tenantId: tenant.id,
      principalId: account.principalId,
      authority: [],
    };
    // The organizations contract sees the same membership/ownership.
    const membership = await getTenantMembership(ctx, { principalId: account.principalId });
    expect(membership.role).toBe('owner');
    // And a DIFFERENT provisioner cannot collide with auth-created tenants.
    const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };
    const other = await provisionTenant(platform, {
      name: `Other ${newId().slice(0, 6)}`,
      ownerPrincipalId: newId(),
    });
    expect(other.id).not.toBe(tenant.id);
  });
});
