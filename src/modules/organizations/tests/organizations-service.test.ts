// Integration tests for the organizations module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W001
// acceptance surface: tenant provisioning, workspace entities, membership
// roles and lifecycle, tenant context propagation, and — the acceptance
// core — cross-tenant reads/writes failing (ADR-0001).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '../access';
import {
  addTenantMember,
  addWorkspaceMember,
  changeTenantMemberRole,
  changeWorkspaceMemberRole,
  createWorkspace,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
  getTenant,
  getTenantMembership,
  getWorkspace,
  getWorkspaceMembership,
  listTenantMembers,
  listWorkspaces,
  listWorkspaceMembers,
  provisionTenant,
  removeTenantMember,
  removeWorkspaceMember,
  updateTenant,
  updateWorkspace,
  type Tenant,
  type TenantRole,
} from '../contract';

const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };
const platformWithoutClaim = { principalId: newId(), authority: [] };

interface TenantFixture {
  tenant: Tenant;
  ownerPrincipalId: string;
  owner: TenantContext;
}

async function provisionFixture(name: string, slug?: string): Promise<TenantFixture> {
  const ownerPrincipalId = newId();
  const tenant = await provisionTenant(platform, { name, slug, ownerPrincipalId });
  const owner: TenantContext = { tenantId: tenant.id, principalId: ownerPrincipalId, authority: [] };
  return { tenant, ownerPrincipalId, owner };
}

/** Fresh tenants with uuid-suffixed names (globally unique derived slugs). */
function freshTenantName(label: string): string {
  return `${label} ${newId().slice(0, 8)}`;
}

interface MemberFixture {
  principalId: string;
  ctx: TenantContext;
}

async function tenantMemberWith(
  owner: TenantContext,
  role: TenantRole,
): Promise<MemberFixture> {
  const principalId = newId();
  await addTenantMember(owner, { principalId, role });
  return { principalId, ctx: { tenantId: owner.tenantId, principalId, authority: [] } };
}

async function workspaceMemberRows(workspaceId: string): Promise<
  { principal_id: string; tenant_id: string; role: string }[]
> {
  const rows = await getDb().query<{ principal_id: string; tenant_id: string; role: string }>(
    `SELECT principal_id, tenant_id, role FROM workspace_members WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows.rows;
}

async function tenantMemberCount(tenantId: string): Promise<number> {
  const rows = await getDb().query<{ id: string }>(
    `SELECT id FROM tenant_members WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.rows.length;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('provisioning tenants (platform operation)', () => {
  it('creates the tenant, its default workspace, the owner membership and the owner workspace-admin membership', async () => {
    const { tenant, ownerPrincipalId, owner } = await provisionFixture(freshTenantName('Acme'));

    expect(tenant.name.startsWith('Acme')).toBe(true);
    expect(tenant.slug).toMatch(/^acme-[0-9a-f]{8}$/);
    expect(tenant.createdAt).toBe(tenant.updatedAt);

    const read = await getTenant(owner);
    expect(read.id).toBe(tenant.id);
    expect(read.name).toBe(tenant.name);

    const workspaces = await listWorkspaces(owner);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(workspaces[0]!.slug).toBe(DEFAULT_WORKSPACE_SLUG);
    expect(workspaces[0]!.tenantId).toBe(tenant.id);

    const ownerMembership = await getTenantMembership(owner, { principalId: ownerPrincipalId });
    expect(ownerMembership.role).toBe('owner');
    expect(ownerMembership.tenantId).toBe(tenant.id);

    const ownerWorkspaceMembership = await getWorkspaceMembership(owner, {
      workspaceId: workspaces[0]!.id,
      principalId: ownerPrincipalId,
    });
    expect(ownerWorkspaceMembership.role).toBe('admin');
    expect(ownerWorkspaceMembership.workspaceId).toBe(workspaces[0]!.id);
  });

  it('honors an explicit slug and a custom default workspace name', async () => {
    const ownerPrincipalId = newId();
    const tenant = await provisionTenant(platform, {
      name: 'Globex',
      slug: 'Globex International', // normalized, then validated
      ownerPrincipalId,
      defaultWorkspaceName: 'Operations',
    });
    expect(tenant.slug).toBe('globex-international');

    const owner: TenantContext = { tenantId: tenant.id, principalId: ownerPrincipalId, authority: [] };
    const workspaces = await listWorkspaces(owner);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.name).toBe('Operations');
    expect(workspaces[0]!.slug).toBe(DEFAULT_WORKSPACE_SLUG);
  });

  it('requires the organizations:provision claim and rejects malformed inputs', async () => {
    await expect(
      provisionTenant(platformWithoutClaim, { name: 'Nope', ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      provisionTenant({ ...platform, principalId: 'not-a-uuid' }, { name: 'Nope', ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'invalid_context' });

    await expect(
      provisionTenant(platform, { name: '   ', ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      provisionTenant(platform, { name: 'X'.repeat(201), ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      provisionTenant(platform, { name: 'Okname', ownerPrincipalId: 'nope' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // a name that cannot derive a slug needs an explicit slug
    await expect(
      provisionTenant(platform, { name: '###', ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects duplicate tenant slugs (platform namespace is global)', async () => {
    await provisionTenant(platform, { name: 'Initech', slug: 'initech', ownerPrincipalId: newId() });
    await expect(
      provisionTenant(platform, { name: 'Initech Two', slug: 'initech', ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'tenant_slug_taken' });
    // same derived slug via identical names collides too
    await provisionTenant(platform, { name: 'Unique Co', slug: 'unique-co', ownerPrincipalId: newId() });
    await expect(
      provisionTenant(platform, { name: 'Unique Co', ownerPrincipalId: newId() }),
    ).rejects.toMatchObject({ code: 'tenant_slug_taken' });
  });
});

describe('tenant reads, updates and membership roles', () => {
  it('lets the owner rename the tenant; admins too; plain members and outsiders cannot', async () => {
    const { tenant, owner } = await provisionFixture(freshTenantName('Initro'));
    const admin = await tenantMemberWith(owner, 'admin');
    const member = await tenantMemberWith(owner, 'member');

    const renamed = await updateTenant(owner, { name: 'Initro Global' });
    expect(renamed.name).toBe('Initro Global');

    const byAdmin = await updateTenant(admin.ctx, { name: 'Initro Worldwide' });
    expect(byAdmin.name).toBe('Initro Worldwide');

    await expect(updateTenant(member.ctx, { name: 'Hijacked' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await getTenant(member.ctx)).name).toBe('Initro Worldwide');

    // an outsider: valid uuid tenant, but the principal has no membership
    const outsider: TenantContext = { tenantId: tenant.id, principalId: newId(), authority: [] };
    await expect(updateTenant(outsider, { name: 'Hijacked' })).rejects.toMatchObject({
      code: 'tenant_not_found',
    });

    // a random tenant id is indistinguishable
    const ghost: TenantContext = { tenantId: newId(), principalId: newId(), authority: [] };
    await expect(getTenant(ghost)).rejects.toMatchObject({ code: 'tenant_not_found' });
  });

  it('requires a name to update a tenant', async () => {
    const { owner } = await provisionFixture(freshTenantName('Umbra'));
    await expect(updateTenant(owner, { name: undefined } as unknown as { name: string })).rejects.toMatchObject(
      { code: 'invalid_input' },
    );
  });

  it('grants roles by power: owners grant any role, admins only membership', async () => {
    const { owner } = await provisionFixture(freshTenantName('Stark'));
    const admin = await tenantMemberWith(owner, 'admin');

    const member = await addTenantMember(owner, { principalId: newId(), role: 'member' });
    expect(member.role).toBe('member');

    const promoted = await addTenantMember(owner, { principalId: newId(), role: 'admin' });
    expect(promoted.role).toBe('admin');

    // admins may add plain members
    const viaAdmin = await addTenantMember(admin.ctx, { principalId: newId(), role: 'member' });
    expect(viaAdmin.role).toBe('member');

    // admins may NOT grant admin (or owner)
    await expect(addTenantMember(admin.ctx, { principalId: newId(), role: 'admin' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      addTenantMember(admin.ctx, { principalId: newId(), role: 'owner' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // duplicates are rejected
    await expect(
      addTenantMember(owner, { principalId: member.principalId, role: 'member' }),
    ).rejects.toMatchObject({ code: 'tenant_member_exists' });

    // bad role values are input errors
    await expect(
      addTenantMember(owner, { principalId: newId(), role: 'boss' as unknown as TenantRole }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      addTenantMember(owner, { principalId: 'not-a-uuid', role: 'member' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('lists the roster and resolves single memberships', async () => {
    const { owner, ownerPrincipalId } = await provisionFixture(freshTenantName('Wayne'));
    const member = await tenantMemberWith(owner, 'member');

    const roster = await listTenantMembers(owner);
    expect(roster.map((m) => m.principalId).sort()).toEqual(
      [ownerPrincipalId, member.principalId].sort(),
    );

    const found = await getTenantMembership(owner, { principalId: member.principalId });
    expect(found.role).toBe('member');

    await expect(
      getTenantMembership(owner, { principalId: newId() }),
    ).rejects.toMatchObject({ code: 'tenant_member_not_found' });
  });

  it('changes roles: owner promotes/demotes, admins cannot, no-op is an input error', async () => {
    const { owner } = await provisionFixture(freshTenantName('Oscorp'));
    const admin = await tenantMemberWith(owner, 'admin');
    const member = await tenantMemberWith(owner, 'member');

    const promoted = await changeTenantMemberRole(owner, {
      principalId: member.principalId,
      role: 'admin',
    });
    expect(promoted.role).toBe('admin');

    const demoted = await changeTenantMemberRole(owner, {
      principalId: member.principalId,
      role: 'member',
    });
    expect(demoted.role).toBe('member');

    await expect(
      changeTenantMemberRole(admin.ctx, { principalId: member.principalId, role: 'admin' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      changeTenantMemberRole(owner, { principalId: member.principalId, role: 'member' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      changeTenantMemberRole(owner, { principalId: newId(), role: 'admin' }),
    ).rejects.toMatchObject({ code: 'tenant_member_not_found' });
  });

  it('never lets a tenant lose its last owner (demotion and removal)', async () => {
    const { owner, ownerPrincipalId, tenant } = await provisionFixture(freshTenantName('Sole'));
    await expect(
      changeTenantMemberRole(owner, { principalId: ownerPrincipalId, role: 'admin' }),
    ).rejects.toMatchObject({ code: 'last_tenant_owner' });
    await expect(removeTenantMember(owner, { principalId: ownerPrincipalId })).rejects.toMatchObject({
      code: 'last_tenant_owner',
    });

    // with a second owner, the first may step down and be removed by a fellow owner
    const secondPrincipalId = newId();
    const secondOwner = await addTenantMember(owner, { principalId: secondPrincipalId, role: 'owner' });
    expect(secondOwner.role).toBe('owner');
    const steppedDown = await changeTenantMemberRole(owner, {
      principalId: ownerPrincipalId,
      role: 'member',
    });
    expect(steppedDown.role).toBe('member');
    const secondOwnerCtx: TenantContext = {
      tenantId: tenant.id,
      principalId: secondPrincipalId,
      authority: [],
    };
    await expect(
      removeTenantMember(secondOwnerCtx, { principalId: ownerPrincipalId }),
    ).resolves.toBeUndefined();
    expect(await tenantMemberCount(tenant.id)).toBe(1);
  });

  it('removing a member also removes their workspace memberships in that tenant', async () => {
    const { owner } = await provisionFixture(freshTenantName('Gotham'));
    const member = await tenantMemberWith(owner, 'member');
    const workspace = await createWorkspace(owner, { name: 'Batcave Ops' });
    await addWorkspaceMember(owner, {
      workspaceId: workspace.id,
      principalId: member.principalId,
      role: 'member',
    });
    expect((await workspaceMemberRows(workspace.id)).length).toBe(2); // owner + member

    await removeTenantMember(owner, { principalId: member.principalId });
    const remaining = await workspaceMemberRows(workspace.id);
    expect(remaining.map((r) => r.principal_id)).toEqual([owner.principalId]);

    await expect(
      getWorkspaceMembership(owner, { workspaceId: workspace.id, principalId: member.principalId }),
    ).rejects.toMatchObject({ code: 'workspace_member_not_found' });
  });

  it('role-shaped removal rules: admins remove plain members only', async () => {
    const { owner } = await provisionFixture(freshTenantName('Lex'));
    const admin = await tenantMemberWith(owner, 'admin');
    const member = await tenantMemberWith(owner, 'member');

    await expect(
      removeTenantMember(admin.ctx, { principalId: owner.principalId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      removeTenantMember(admin.ctx, { principalId: admin.principalId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(removeTenantMember(admin.ctx, { principalId: member.principalId })).resolves.toBeUndefined();
    await expect(
      removeTenantMember(owner, { principalId: member.principalId }),
    ).rejects.toMatchObject({ code: 'tenant_member_not_found' });
  });
});

describe('workspace entities', () => {
  it('creates workspaces with derived or explicit slugs and joins the creator as admin', async () => {
    const { owner, tenant } = await provisionFixture(freshTenantName('Tyrell'));
    const created = await createWorkspace(owner, { name: 'Nexus Ops', description: 'ops floor' });
    expect(created.tenantId).toBe(tenant.id);
    expect(created.slug).toBe('nexus-ops');
    expect(created.description).toBe('ops floor');

    const membership = await getWorkspaceMembership(owner, {
      workspaceId: created.id,
      principalId: owner.principalId,
    });
    expect(membership.role).toBe('admin');

    const explicit = await createWorkspace(owner, { name: 'Voight-Kampff', slug: 'VK' });
    expect(explicit.slug).toBe('vk');

    const blank = await createWorkspace(owner, { name: 'Esp', description: '   ' });
    expect(blank.description).toBeNull();
  });

  it('keeps workspace slug namespaces per tenant (same slug, different tenants: both succeed)', async () => {
    const a = await provisionFixture(freshTenantName('Pied'));
    const b = await provisionFixture(freshTenantName('Hooli'));
    const wa = await createWorkspace(a.owner, { name: 'Analytics', slug: 'analytics' });
    const wb = await createWorkspace(b.owner, { name: 'Analytics', slug: 'analytics' });
    expect(wa.slug).toBe('analytics');
    expect(wb.slug).toBe('analytics');
    expect(wa.id).not.toBe(wb.id);

    // within one tenant the slug must be unique
    await expect(createWorkspace(a.owner, { name: 'Analytics Two', slug: 'analytics' })).rejects.toMatchObject(
      { code: 'workspace_slug_taken' },
    );
  });

  it('only tenant owners/admins may create workspaces', async () => {
    const { owner } = await provisionFixture(freshTenantName('Vandelay'));
    const member = await tenantMemberWith(owner, 'member');
    await expect(createWorkspace(member.ctx, { name: 'Smuggled' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(createWorkspace(owner, { name: '   ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('updates name and description (null clears), enforces the manager gate', async () => {
    const { owner } = await provisionFixture(freshTenantName('Paper'));
    const workspace = await createWorkspace(owner, { name: 'Sales', description: 'old' });

    const renamed = await updateWorkspace(owner, {
      workspaceId: workspace.id,
      name: 'Revenue',
    });
    expect(renamed.name).toBe('Revenue');
    expect(renamed.description).toBe('old');

    const reDescribed = await updateWorkspace(owner, {
      workspaceId: workspace.id,
      description: 'new',
    });
    expect(reDescribed.name).toBe('Revenue');
    expect(reDescribed.description).toBe('new');

    const cleared = await updateWorkspace(owner, {
      workspaceId: workspace.id,
      description: null,
    });
    expect(cleared.description).toBeNull();

    await expect(
      updateWorkspace(owner, { workspaceId: workspace.id }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // a plain tenant member who is a workspace admin may update ...
    const member = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: member.principalId, role: 'admin' });
    const viaWorkspaceAdmin = await updateWorkspace(member.ctx, {
      workspaceId: workspace.id,
      name: 'Revenue Intl',
    });
    expect(viaWorkspaceAdmin.name).toBe('Revenue Intl');

    // ... a plain workspace member may not
    const spectator = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: spectator.principalId, role: 'member' });
    await expect(
      updateWorkspace(spectator.ctx, { workspaceId: workspace.id, name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // a tenant admin who is not a workspace member still may (tenant authority)
    const admin = await tenantMemberWith(owner, 'admin');
    const viaTenantAdmin = await updateWorkspace(admin.ctx, {
      workspaceId: workspace.id,
      description: 'managed from tenant level',
    });
    expect(viaTenantAdmin.description).toBe('managed from tenant level');
  });

  it('reads are visibility-gated: members and tenant owners/admins see the workspace', async () => {
    const { owner } = await provisionFixture(freshTenantName('Bluth'));
    const workspace = await createWorkspace(owner, { name: 'Model Home' });
    const member = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: member.principalId, role: 'member' });

    expect((await getWorkspace(member.ctx, workspace.id)).id).toBe(workspace.id);

    const admin = await tenantMemberWith(owner, 'admin'); // tenant admin, not a member
    expect((await getWorkspace(admin.ctx, workspace.id)).id).toBe(workspace.id);

    const stranger = await tenantMemberWith(owner, 'member'); // plain tenant member, not a member
    await expect(getWorkspace(stranger.ctx, workspace.id)).rejects.toMatchObject({ code: 'forbidden' });

    await expect(getWorkspace(owner, 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(getWorkspace(owner, newId())).rejects.toMatchObject({ code: 'workspace_not_found' });
  });

  it('lists all workspaces for owners/admins, only joined ones for plain members', async () => {
    const { owner } = await provisionFixture(freshTenantName('Dunder'));
    const w1 = await createWorkspace(owner, { name: 'Scranton One' });
    const w2 = await createWorkspace(owner, { name: 'Scranton Two' });
    const member = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, { workspaceId: w2.id, principalId: member.principalId, role: 'member' });

    const all = await listWorkspaces(owner); // default workspace + w1 + w2
    expect(all).toHaveLength(3);
    expect(all.map((w) => w.id)).toContain(w1.id);
    expect(all.map((w) => w.id)).toContain(w2.id);

    const mine = await listWorkspaces(member.ctx);
    expect(mine.map((w) => w.id)).toEqual([w2.id]);
  });
});

describe('workspace membership', () => {
  async function fixture() {
    const { owner } = await provisionFixture(freshTenantName('Parks'));
    const workspace = await createWorkspace(owner, { name: 'Ranger HQ' });
    return { owner, workspace };
  }

  it('adds members with both roles; targets must be tenant members first', async () => {
    const { owner, workspace } = await fixture();
    const member = await tenantMemberWith(owner, 'member');

    const added = await addWorkspaceMember(owner, {
      workspaceId: workspace.id,
      principalId: member.principalId,
      role: 'member',
    });
    expect(added.role).toBe('member');
    expect(added.workspaceId).toBe(workspace.id);
    expect(added.tenantId).toBe(owner.tenantId);

    const other = await tenantMemberWith(owner, 'member');
    const addedAdmin = await addWorkspaceMember(owner, {
      workspaceId: workspace.id,
      principalId: other.principalId,
      role: 'admin',
    });
    expect(addedAdmin.role).toBe('admin');

    // a principal from nowhere — and one from ANOTHER tenant — cannot join
    await expect(
      addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: newId(), role: 'member' }),
    ).rejects.toMatchObject({ code: 'not_a_tenant_member' });
    const foreign = await provisionFixture(freshTenantName('Foreign'));
    const foreignMember = await tenantMemberWith(foreign.owner, 'member');
    await expect(
      addWorkspaceMember(owner, {
        workspaceId: workspace.id,
        principalId: foreignMember.principalId,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'not_a_tenant_member' });

    // duplicates are rejected
    await expect(
      addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: member.principalId, role: 'admin' }),
    ).rejects.toMatchObject({ code: 'workspace_member_exists' });
  });

  it('workspace admins manage members even when they are plain tenant members; tenant admins too', async () => {
    const { owner, workspace } = await fixture();
    const tenantPlainAdmin = await tenantMemberWith(owner, 'member'); // tenant 'member'
    await addWorkspaceMember(owner, {
      workspaceId: workspace.id,
      principalId: tenantPlainAdmin.principalId,
      role: 'admin',
    });
    const target = await tenantMemberWith(owner, 'member');

    const added = await addWorkspaceMember(tenantPlainAdmin.ctx, {
      workspaceId: workspace.id,
      principalId: target.principalId,
      role: 'member',
    });
    expect(added.role).toBe('member');

    const changed = await changeWorkspaceMemberRole(tenantPlainAdmin.ctx, {
      workspaceId: workspace.id,
      principalId: target.principalId,
      role: 'admin',
    });
    expect(changed.role).toBe('admin');

    // a plain workspace member cannot manage (fresh spectator with role member)
    const spectator = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, {
      workspaceId: workspace.id,
      principalId: spectator.principalId,
      role: 'member',
    });
    await expect(
      addWorkspaceMember(spectator.ctx, { workspaceId: workspace.id, principalId: newId(), role: 'member' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      changeWorkspaceMemberRole(spectator.ctx, {
        workspaceId: workspace.id,
        principalId: target.principalId,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // a tenant admin who never joined the workspace still can (tenant authority)
    const tenantAdmin = await tenantMemberWith(owner, 'admin');
    await expect(
      removeWorkspaceMember(tenantAdmin.ctx, { workspaceId: workspace.id, principalId: target.principalId }),
    ).resolves.toBeUndefined();
  });

  it('role change no-ops and missing targets are typed errors', async () => {
    const { owner, workspace } = await fixture();
    const member = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: member.principalId, role: 'member' });

    await expect(
      changeWorkspaceMemberRole(owner, {
        workspaceId: workspace.id,
        principalId: member.principalId,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      changeWorkspaceMemberRole(owner, { workspaceId: workspace.id, principalId: newId(), role: 'member' }),
    ).rejects.toMatchObject({ code: 'workspace_member_not_found' });
    await expect(
      removeWorkspaceMember(owner, { workspaceId: workspace.id, principalId: newId() }),
    ).rejects.toMatchObject({ code: 'workspace_member_not_found' });
    await expect(
      removeWorkspaceMember(owner, { workspaceId: newId(), principalId: member.principalId }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
  });

  it('removing the last workspace admin is allowed — tenant authority keeps the workspace manageable', async () => {
    const { owner, workspace } = await fixture();
    // remove the owner's own (last) workspace-admin membership
    await expect(
      removeWorkspaceMember(owner, { workspaceId: workspace.id, principalId: owner.principalId }),
    ).resolves.toBeUndefined();
    expect(await workspaceMemberRows(workspace.id)).toEqual([]);

    // the tenant owner can still manage and re-join
    const reAdded = await addWorkspaceMember(owner, {
      workspaceId: workspace.id,
      principalId: owner.principalId,
      role: 'admin',
    });
    expect(reAdded.role).toBe('admin');
  });

  it('lists the roster and resolves single memberships with the same visibility gate', async () => {
    const { owner, workspace } = await fixture();
    const member = await tenantMemberWith(owner, 'member');
    await addWorkspaceMember(owner, { workspaceId: workspace.id, principalId: member.principalId, role: 'member' });

    const roster = await listWorkspaceMembers(member.ctx, workspace.id);
    expect(roster).toHaveLength(2);
    expect(roster.map((m) => m.principalId).sort()).toEqual(
      [owner.principalId, member.principalId].sort(),
    );

    const found = await getWorkspaceMembership(member.ctx, {
      workspaceId: workspace.id,
      principalId: owner.principalId,
    });
    expect(found.role).toBe('admin');

    const stranger = await tenantMemberWith(owner, 'member');
    await expect(listWorkspaceMembers(stranger.ctx, workspace.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('cross-tenant isolation (W001 acceptance: reads AND writes fail)', () => {
  // Tenant A with a workspace and a member inside it; tenant B with its own.
  let tenantA: TenantFixture;
  let workspaceA: { id: string };
  let memberA: MemberFixture;
  let tenantB: TenantFixture;
  let memberB: MemberFixture;
  let omnipotentB: TenantContext; // B's principal carrying every authority claim

  beforeAll(async () => {
    tenantA = await provisionFixture(freshTenantName('Alpha'));
    workspaceA = await createWorkspace(tenantA.owner, { name: 'Alpha Secrets' });
    memberA = await tenantMemberWith(tenantA.owner, 'member');
    await addWorkspaceMember(tenantA.owner, {
      workspaceId: workspaceA.id,
      principalId: memberA.principalId,
      role: 'member',
    });

    tenantB = await provisionFixture(freshTenantName('Beta'));
    memberB = await tenantMemberWith(tenantB.owner, 'member');
    omnipotentB = {
      tenantId: tenantB.tenant.id,
      principalId: tenantB.ownerPrincipalId,
      authority: [ORGANIZATIONS_AUTHORITY_PROVISION, 'organizations:admin', 'everything'],
    };
  });

  it('cross-tenant reads fail as workspace_not_found (no existence leak)', async () => {
    await expect(getWorkspace(tenantB.owner, workspaceA.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(
      getWorkspaceMembership(tenantB.owner, { workspaceId: workspaceA.id, principalId: memberA.principalId }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    await expect(listWorkspaceMembers(tenantB.owner, workspaceA.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
  });

  it('cross-tenant writes fail and leave the data untouched', async () => {
    // rename attempt from tenant B
    await expect(
      updateWorkspace(tenantB.owner, { workspaceId: workspaceA.id, name: 'Pwned' }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    expect((await getWorkspace(tenantA.owner, workspaceA.id)).name).toBe('Alpha Secrets');

    // membership injection attempt from tenant B
    await expect(
      addWorkspaceMember(tenantB.owner, {
        workspaceId: workspaceA.id,
        principalId: memberB.principalId,
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    const rows = await workspaceMemberRows(workspaceA.id);
    expect(rows.map((r) => r.principal_id).sort()).toEqual(
      [tenantA.ownerPrincipalId, memberA.principalId].sort(),
    );

    // role hijack attempt from tenant B
    await expect(
      changeWorkspaceMemberRole(tenantB.owner, {
        workspaceId: workspaceA.id,
        principalId: memberA.principalId,
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    expect(
      (await getWorkspaceMembership(tenantA.owner, { workspaceId: workspaceA.id, principalId: memberA.principalId }))
        .role,
    ).toBe('member');

    // eviction attempt from tenant B
    await expect(
      removeWorkspaceMember(tenantB.owner, { workspaceId: workspaceA.id, principalId: memberA.principalId }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    expect((await workspaceMemberRows(workspaceA.id)).length).toBe(2);
  });

  it('cross-tenant lists never contain the other tenant workspaces', async () => {
    const bWorkspaces = await listWorkspaces(tenantB.owner);
    expect(bWorkspaces.map((w) => w.id)).not.toContain(workspaceA.id);
    const aWorkspaces = await listWorkspaces(tenantA.owner);
    expect(aWorkspaces.map((w) => w.id)).toContain(workspaceA.id);
  });

  it('a context claiming tenant A with a tenant B principal fails opaquely (tenant_not_found)', async () => {
    const forged: TenantContext = {
      tenantId: tenantA.tenant.id,
      principalId: tenantB.ownerPrincipalId,
      authority: [],
    };
    await expect(getTenant(forged)).rejects.toMatchObject({ code: 'tenant_not_found' });
    await expect(updateTenant(forged, { name: 'Pwned Corp' })).rejects.toMatchObject({
      code: 'tenant_not_found',
    });
    expect((await getTenant(tenantA.owner)).name).toBe(tenantA.tenant.name);
    await expect(
      addTenantMember(forged, { principalId: memberB.principalId, role: 'owner' }),
    ).rejects.toMatchObject({ code: 'tenant_not_found' });
    expect(await tenantMemberCount(tenantA.tenant.id)).toBe(2); // owner + memberA only
  });

  it('authority claims never bypass tenant scope (claims gate the platform op only)', async () => {
    await expect(getWorkspace(omnipotentB, workspaceA.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(
      updateWorkspace(omnipotentB, { workspaceId: workspaceA.id, name: 'Pwned' }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    const forgedWithClaims: TenantContext = {
      tenantId: tenantA.tenant.id,
      principalId: tenantB.ownerPrincipalId,
      authority: omnipotentB.authority,
    };
    await expect(getTenant(forgedWithClaims)).rejects.toMatchObject({ code: 'tenant_not_found' });
  });

  it('every persisted membership row of workspace A is stamped with tenant A', async () => {
    const rows = await workspaceMemberRows(workspaceA.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(tenantA.tenant.id);
    }
  });
});

describe('tenant context propagation (explicit context on every call)', () => {
  it('rejects malformed contexts with invalid_context before any data access', async () => {
    const { owner } = await provisionFixture(freshTenantName('Context'));
    const badTenantId: TenantContext = { ...owner, tenantId: 'not-a-uuid' };
    const badPrincipalId: TenantContext = { ...owner, principalId: 'not-a-uuid' };
    const badAuthority: TenantContext = { ...owner, authority: 'nope' as unknown as string[] };

    for (const ctx of [badTenantId, badPrincipalId, badAuthority]) {
      await expect(getTenant(ctx)).rejects.toMatchObject({ code: 'invalid_context' });
      await expect(createWorkspace(ctx, { name: 'X' })).rejects.toMatchObject({ code: 'invalid_context' });
      await expect(addTenantMember(ctx, { principalId: newId(), role: 'member' })).rejects.toMatchObject({
        code: 'invalid_context',
      });
      await expect(listWorkspaces(ctx)).rejects.toMatchObject({ code: 'invalid_context' });
    }
  });

  it('workspace ids are validated as uuids before any lookup', async () => {
    const { owner } = await provisionFixture(freshTenantName('Shapes'));
    await expect(getWorkspace(owner, 'definitely-not-a-uuid')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      updateWorkspace(owner, { workspaceId: 'nope', name: 'X' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
