// W044 — Tenant Isolation Verification · application-boundary sweep for the
// L0 foundation modules: organizations (W001), identity (W002), people
// (W002), events (W003) and world (W005).
//
// Two REAL tenants are provisioned through the organizations contract (the
// platform operation), then every module contract is driven for both tenants
// (cross-module imports go through `@/modules/<m>/contract` only). The sweep
// proves, per ADR-0001:
//
//   * cross-tenant reads are uniform not-found (foreign id ≡ missing id —
//     no existence leaks);
//   * cross-tenant writes fail BEFORE mutating (A's rows are unchanged);
//   * listings stay per-tenant and disjoint;
//   * per-tenant namespaces hold for natural keys (slugs, provider
//     accounts, employee numbers, idempotency keys, custom vocabulary);
//   * authority claims never bypass tenant scope (the omnipotent principal
//     of tenant B is still blind to tenant A);
//   * a forged tenant context (B's principal claiming tenant A) is
//     rejected by the membership gate as a missing tenant;
//   * the storage-level composite (id, tenant_id) FKs reject cross-tenant
//     edges even when SQL bypasses every contract.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getEvent, appendEvent, listEvents, getEventCausationChain } from '@/modules/events/contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  completeVerificationChallenge,
  findExternalIdentityByProviderKey,
  getExternalIdentity,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  issueVerificationChallenge,
  listSubjectIdentities,
  registerExternalIdentity,
  revokeVerification,
} from '@/modules/identity/contract';
import {
  createEmployee,
  createPerson,
  getEmployeeByPerson,
  getPerson,
  linkExternalIdentity,
  listPersonIdentities,
  setEmployeeStatus,
} from '@/modules/people/contract';
import {
  addTenantMember,
  createWorkspace,
  getTenant,
  getTenantMembership,
  getWorkspace,
  getWorkspaceMembership,
  listTenantMembers,
  listWorkspaces,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
  removeTenantMember,
  updateWorkspace,
  addWorkspaceMember,
  changeTenantMemberRole,
} from '@/modules/organizations/contract';
import {
  createEntity,
  createRelationship,
  deleteEntity,
  getEntity,
  getRelationship,
  listEntities,
  listEntityKinds,
  listRelationships,
  listRelationshipTypes,
  registerEntityKind,
  updateEntity,
} from '@/modules/world/contract';
import { assertTenantPartition, expectUniformNotFound, member, omnipotent, runMigrations } from './harness';

const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

interface TenantFixture {
  tenantId: string;
  owner: TenantContext;
  plain: TenantContext;
}

let tenantA: TenantFixture;
let tenantB: TenantFixture;

beforeAll(async () => {
  await runMigrations(getDb());
  const provision = async (name: string): Promise<TenantFixture> => {
    const ownerPrincipalId = newId();
    const tenant = await provisionTenant(platform, {
      name: `${name} ${newId().slice(0, 8)}`,
      ownerPrincipalId,
    });
    const owner: TenantContext = { tenantId: tenant.id, principalId: ownerPrincipalId, authority: [] };
    // A second, plain member so role probes have a low-privilege principal.
    const plainPrincipalId = newId();
    await addTenantMember(owner, { principalId: plainPrincipalId, role: 'member' });
    return { tenantId: tenant.id, owner, plain: { tenantId: tenant.id, principalId: plainPrincipalId, authority: [] } };
  };
  tenantA = await provision('Alpha Isolation');
  tenantB = await provision('Beta Isolation');
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// organizations (W001)
// ---------------------------------------------------------------------------

describe('W044 organizations — tenant and workspace isolation', () => {
  it('keeps workspaces, memberships and rosters per-tenant and disjoint', async () => {
    const wsA = await createWorkspace(tenantA.owner, { name: 'Ops Floor', description: 'alpha ops' });
    const wsB = await createWorkspace(tenantB.owner, { name: 'Ops Floor', description: 'beta ops' });

    // Same natural key (name/slug) coexists in both tenants — per-tenant namespace.
    expect(wsA.id).not.toBe(wsB.id);
    expect(wsA.slug).toBe(wsB.slug);

    const aWorkspaces = await listWorkspaces(tenantA.owner);
    const bWorkspaces = await listWorkspaces(tenantB.owner);
    expect(aWorkspaces.map((workspace) => workspace.id)).toContain(wsA.id);
    expect(aWorkspaces.map((workspace) => workspace.id)).not.toContain(wsB.id);
    expect(bWorkspaces.map((workspace) => workspace.id)).toContain(wsB.id);
    expect(bWorkspaces.map((workspace) => workspace.id)).not.toContain(wsA.id);

    const aMembers = await listTenantMembers(tenantA.owner);
    const bMembers = await listTenantMembers(tenantB.owner);
    expect(aMembers.every((m) => m.tenantId === tenantA.tenantId)).toBe(true);
    expect(bMembers.every((m) => m.tenantId === tenantB.tenantId)).toBe(true);
    expect(
      aMembers.filter((m) => bMembers.some((other) => other.principalId === m.principalId)),
    ).toEqual([]);
  });

  it('makes cross-tenant workspace reads uniform not-found (foreign ≡ missing)', async () => {
    const wsA = await createWorkspace(tenantA.owner, { name: 'Vault A' });
    await expectUniformNotFound(
      'workspace_not_found',
      () => getWorkspace(tenantB.owner, wsA.id),
      () => getWorkspace(tenantB.owner, newId()),
    );
    await expectUniformNotFound(
      'workspace_not_found',
      () => getWorkspaceMembership(tenantB.owner, { workspaceId: wsA.id, principalId: tenantB.owner.principalId }),
      () => getWorkspaceMembership(tenantB.owner, { workspaceId: newId(), principalId: tenantB.owner.principalId }),
    );
  });

  it('rejects cross-tenant workspace writes before any mutation', async () => {
    const wsA = await createWorkspace(tenantA.owner, { name: 'Write Guard A' });
    const before = await getWorkspace(tenantA.owner, wsA.id);

    await expect(getWorkspace(tenantB.owner, wsA.id)).rejects.toMatchObject({ code: 'workspace_not_found' });
    await expect(
      updateWorkspace(tenantB.owner, { workspaceId: wsA.id, name: 'Pwned by B' }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    await expect(
      addWorkspaceMember(tenantB.owner, { workspaceId: wsA.id, principalId: tenantB.plain.principalId, role: 'admin' }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
    // B's owner cannot manage A's members: the target is not a member of
    // B's tenant, so the change is a member-not-found there — never a
    // mutation of A's roster.
    await expect(
      changeTenantMemberRole(tenantB.owner, { principalId: tenantA.plain.principalId, role: 'owner' }),
    ).rejects.toMatchObject({ code: 'tenant_member_not_found' });

    const after = await getWorkspace(tenantA.owner, wsA.id);
    expect(after.name).toBe(before.name);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('rejects a forged tenant context as a missing tenant (membership gate)', async () => {
    // B's owner principal claiming to act inside tenant A.
    const forged: TenantContext = { tenantId: tenantA.tenantId, principalId: tenantB.owner.principalId, authority: [] };
    await expectUniformNotFound(
      'tenant_not_found',
      () => getTenant(forged),
      () => getTenant({ tenantId: newId(), principalId: newId(), authority: [] }),
    );
    await expect(
      getTenantMembership(forged, { principalId: tenantA.owner.principalId }),
    ).rejects.toMatchObject({ code: 'tenant_not_found' });
    await expect(
      removeTenantMember(forged, { principalId: tenantA.plain.principalId }),
    ).rejects.toMatchObject({ code: 'tenant_not_found' });
  });

  it('never lets authority claims bypass tenant scope', async () => {
    const wsA = await createWorkspace(tenantA.owner, { name: 'Claim Guard A' });
    // A real ADMIN of tenant B holding EVERY claim in the repository
    // (including organizations:provision) — membership and authority both
    // pass inside B, and it is STILL blind to A's workspace.
    const omniPrincipalId = newId();
    await addTenantMember(tenantB.owner, { principalId: omniPrincipalId, role: 'admin' });
    const omniB: TenantContext = {
      tenantId: tenantB.tenantId,
      principalId: omniPrincipalId,
      authority: [
        ORGANIZATIONS_AUTHORITY_PROVISION,
        'identity:attest',
        'identity:link',
        'actions:administer',
        'actions:approve',
        'agents:administer',
        'extensions:administer',
        'llm:administer',
        'notifications:administer',
      ],
    };
    await expect(getWorkspace(omniB, wsA.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(
      updateWorkspace(omniB, { workspaceId: wsA.id, name: 'Claim Pwned' }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' });
  });
});

// ---------------------------------------------------------------------------
// identity (W002)
// ---------------------------------------------------------------------------

describe('W044 identity — external identities are tenant-scoped', () => {
  it('gives the same provider account independent identities per tenant', async () => {
    const provider = 'whatsapp' as const;
    const accountId = '+15550100';
    const inA = await registerExternalIdentity(member(tenantA.tenantId), {
      provider,
      providerAccountId: accountId,
      displayName: 'Alpha desk',
    });
    const inB = await registerExternalIdentity(member(tenantB.tenantId), {
      provider,
      providerAccountId: accountId,
      displayName: 'Beta desk',
    });
    expect(inA.identity.id).not.toBe(inB.identity.id);
    expect(inA.created).toBe(true);
    expect(inB.created).toBe(true);

    // Provider-key lookup resolves inside the CALLING tenant only.
    const foundA = await findExternalIdentityByProviderKey(member(tenantA.tenantId), {
      provider,
      providerAccountId: accountId,
    });
    expect(foundA?.id).toBe(inA.identity.id);
    const unknownInB = await findExternalIdentityByProviderKey(member(tenantB.tenantId), {
      provider: 'telegram',
      providerAccountId: 'never-registered',
    });
    expect(unknownInB).toBeNull();

    // Subject listing for another tenant's subject is simply empty.
    const foreignSubject = await listSubjectIdentities(member(tenantB.tenantId), newId());
    expect(foreignSubject).toEqual([]);
  });

  it('makes cross-tenant identity reads uniform not-found', async () => {
    const { identity } = await registerExternalIdentity(member(tenantA.tenantId), {
      provider: 'email',
      providerAccountId: 'grace@alpha.example',
    });
    await expectUniformNotFound(
      'identity_not_found',
      () => getExternalIdentity(member(tenantB.tenantId), identity.id),
      () => getExternalIdentity(member(tenantB.tenantId), newId()),
    );
  });

  it('keeps the challenge workflow, attestation and linking in-tenant', async () => {
    const ctxA = member(tenantA.tenantId);
    const ctxB = member(tenantB.tenantId);
    const managerA = {
      tenantId: tenantA.tenantId,
      principalId: newId(),
      authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK],
    };
    const managerB = {
      tenantId: tenantB.tenantId,
      principalId: newId(),
      authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK],
    };

    const { identity: alpha } = await registerExternalIdentity(ctxA, {
      provider: 'whatsapp',
      providerAccountId: '+15550200',
    });
    const challenge = await issueVerificationChallenge(ctxA, { identityId: alpha.id });
    const verified = await completeVerificationChallenge(ctxA, {
      identityId: alpha.id,
      code: challenge.code,
    });
    expect(verified.status).toBe('verified');

    // B cannot drive any part of the workflow on A's identity — even with
    // full attestation/linking claims.
    await expect(issueVerificationChallenge(ctxB, { identityId: alpha.id })).rejects.toMatchObject({
      code: 'identity_not_found',
    });
    await expect(
      completeVerificationChallenge(ctxB, { identityId: alpha.id, code: '000000' }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });
    await expect(
      attestIdentity(managerB, { identityId: alpha.id, evidence: 'B attests A identity' }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });
    await expect(
      attachVerifiedSubject(managerB, { identityId: alpha.id, subjectId: newId() }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });
    await expect(
      revokeVerification(managerB, { identityId: alpha.id, reason: 'cross-tenant pwn' }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });

    // The omnipotent principal of B is equally blind.
    await expect(
      getExternalIdentity(omnipotent(tenantB.tenantId), alpha.id),
    ).rejects.toMatchObject({ code: 'identity_not_found' });

    // A's linking continues to work inside A.
    const subjectId = newId();
    const linked = await attachVerifiedSubject(managerA, { identityId: alpha.id, subjectId });
    expect(linked.subjectId).toBe(subjectId);
    const identities = await listSubjectIdentities(ctxA, subjectId);
    expect(identities.map((identity) => identity.id)).toEqual([alpha.id]);
  });
});

// ---------------------------------------------------------------------------
// people (W002)
// ---------------------------------------------------------------------------

describe('W044 people — persons and employees are tenant-scoped', () => {
  it('gives the same person name and employee number independent rows per tenant', async () => {
    const personA = await createPerson(member(tenantA.tenantId), {
      fullName: 'Ada Lovelace',
      email: 'ada@alpha.example',
    });
    const personB = await createPerson(member(tenantB.tenantId), {
      fullName: 'Ada Lovelace',
      email: 'ada@alpha.example',
    });
    expect(personA.id).not.toBe(personB.id);

    const employeeA = await createEmployee(member(tenantA.tenantId), {
      personId: personA.id,
      employeeNumber: 'E-100',
      title: 'Alpha engineer',
    });
    const employeeB = await createEmployee(member(tenantB.tenantId), {
      personId: personB.id,
      employeeNumber: 'E-100',
      title: 'Beta engineer',
    });
    expect(employeeA.id).not.toBe(employeeB.id);
  });

  it('makes cross-tenant person/employee reads and writes uniform not-found', async () => {
    const personA = await createPerson(member(tenantA.tenantId), { fullName: 'Guard Person A' });
    const employeeA = await createEmployee(member(tenantA.tenantId), {
      personId: personA.id,
      employeeNumber: 'E-200',
    });

    await expectUniformNotFound(
      'person_not_found',
      () => getPerson(member(tenantB.tenantId), personA.id),
      () => getPerson(member(tenantB.tenantId), newId()),
    );
    // B cannot employ A's person, read A's person identities, or read A's
    // employment — all uniform not-found.
    await expect(
      createEmployee(member(tenantB.tenantId), { personId: personA.id, employeeNumber: 'E-B' }),
    ).rejects.toMatchObject({ code: 'person_not_found' });
    await expect(
      listPersonIdentities(member(tenantB.tenantId), personA.id),
    ).rejects.toMatchObject({ code: 'person_not_found' });
    expect(await getEmployeeByPerson(member(tenantB.tenantId), personA.id)).toBeNull();

    // Cross-tenant status mutation fails and leaves A's employee active.
    await expect(
      setEmployeeStatus(member(tenantB.tenantId), { employeeId: employeeA.id, status: 'terminated' }),
    ).rejects.toMatchObject({ code: 'employee_not_found' });
    const stillA = await getEmployeeByPerson(member(tenantA.tenantId), personA.id);
    expect(stillA?.status).toBe('active');
  });

  it('rejects linking a person to another tenant identity even with linking claims', async () => {
    const personB = await createPerson(member(tenantB.tenantId), { fullName: 'Link Guard B' });
    const { identity: alpha } = await registerExternalIdentity(member(tenantA.tenantId), {
      provider: 'slack',
      providerAccountId: 'alpha-slack-1',
    });
    const managerB = {
      tenantId: tenantB.tenantId,
      principalId: newId(),
      authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK],
    };
    await expect(
      linkExternalIdentity(managerB, { personId: personB.id, identityId: alpha.id }),
    ).rejects.toMatchObject({ code: 'identity_not_found' });
  });
});

// ---------------------------------------------------------------------------
// events (W003)
// ---------------------------------------------------------------------------

describe('W044 events — immutable envelopes are tenant-scoped', () => {
  const baseInput = () => ({
    type: 'channel.message.received',
    payload: { text: 'alpha-only secret' },
    occurredAt: '2026-09-14T09:15:00Z',
    actor: { kind: 'person' as const, label: 'office-manager' },
    source: { kind: 'channel' as const, label: 'whatsapp' },
  });

  it('scopes idempotency keys, sequences and queries per tenant', async () => {
    const eventA = await appendEvent(member(tenantA.tenantId), {
      ...baseInput(),
      idempotencyKey: 'shared-idem-key',
    });
    const eventB = await appendEvent(member(tenantB.tenantId), {
      ...baseInput(),
      payload: { text: 'beta-only secret' },
      idempotencyKey: 'shared-idem-key',
    });
    expect(eventA.id).not.toBe(eventB.id);
    expect(eventA.sequence).toBe(eventB.sequence); // independent per-tenant sequences
    expect(eventA.tenantId).toBe(tenantA.tenantId);
    expect(eventB.tenantId).toBe(tenantB.tenantId);

    // Each tenant's idempotency replay window only sees its own event.
    const aByKey = await listEvents(member(tenantA.tenantId), { idempotencyKey: 'shared-idem-key' });
    expect(aByKey.map((event) => event.id)).toEqual([eventA.id]);
    const bByKey = await listEvents(member(tenantB.tenantId), { idempotencyKey: 'shared-idem-key' });
    expect(bByKey.map((event) => event.id)).toEqual([eventB.id]);
  });

  it('makes cross-tenant event reads and causation uniform not-found', async () => {
    const eventA = await appendEvent(member(tenantA.tenantId), baseInput());
    await expectUniformNotFound(
      'event_not_found',
      () => getEvent(member(tenantB.tenantId), eventA.id),
      () => getEvent(member(tenantB.tenantId), newId()),
    );
    await expect(
      getEventCausationChain(member(tenantB.tenantId), eventA.id),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  it('rejects appending an event caused by another tenant event', async () => {
    const causeB = await appendEvent(member(tenantB.tenantId), baseInput());
    await expect(
      appendEvent(member(tenantA.tenantId), { ...baseInput(), causationId: causeB.id }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  it('keeps payload confidentiality per tenant in listings', async () => {
    await appendEvent(member(tenantA.tenantId), { ...baseInput(), payload: { text: 'alpha-payload' } });
    await appendEvent(member(tenantB.tenantId), { ...baseInput(), payload: { text: 'beta-payload' } });
    const bFeed = await listEvents(member(tenantB.tenantId), {});
    expect(JSON.stringify(bFeed)).not.toContain('alpha-payload');
    const aFeed = await listEvents(member(tenantA.tenantId), {});
    expect(JSON.stringify(aFeed)).not.toContain('beta-payload');
  });
});

// ---------------------------------------------------------------------------
// world (W005)
// ---------------------------------------------------------------------------

describe('W044 world — entities, relationships and vocabulary are tenant-scoped', () => {
  it('isolates entities, custom vocabulary and relationships per tenant', async () => {
    const ctxA = member(tenantA.tenantId);
    const ctxB = member(tenantB.tenantId);

    // A registers a custom kind; B cannot use it (unknown in B's vocabulary).
    await registerEntityKind(ctxA, { kind: 'profit_center', category: 'company', description: 'A P&L unit' });
    await expect(
      createEntity(ctxB, { kind: 'profit_center', name: 'B Profit Center' }),
    ).rejects.toMatchObject({ code: 'unknown_entity_kind' });
    expect((await listEntityKinds(ctxB)).map((kind) => kind.kind)).not.toContain('profit_center');

    // B may register the SAME kind name independently (per-tenant vocabulary).
    await registerEntityKind(ctxB, { kind: 'profit_center', category: 'direction' });
    expect((await listEntityKinds(ctxB)).map((kind) => kind.kind)).toContain('profit_center');

    const ada = await createEntity(ctxA, { kind: 'person', name: 'Ada Lovelace' });
    const team = await createEntity(ctxA, { kind: 'team', name: 'Field Engineering' });
    const edge = await createRelationship(ctxA, {
      type: 'member_of',
      fromEntityId: ada.id,
      toEntityId: team.id,
    });

    await expectUniformNotFound(
      'entity_not_found',
      () => getEntity(ctxB, ada.id),
      () => getEntity(ctxB, newId()),
    );
    await expectUniformNotFound(
      'relationship_not_found',
      () => getRelationship(ctxB, edge.id),
      () => getRelationship(ctxB, newId()),
    );

    // Cross-tenant writes fail and never mutate A.
    await expect(
      updateEntity(ctxB, { entityId: ada.id, name: 'Hijacked' }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(deleteEntity(ctxB, ada.id)).rejects.toMatchObject({ code: 'entity_not_found' });
    expect((await getEntity(ctxA, ada.id)).name).toBe('Ada Lovelace');

    // A relationship cannot span tenants in either direction.
    const bTeam = await createEntity(ctxB, { kind: 'team', name: 'Beta Team' });
    await expect(
      createRelationship(ctxA, { type: 'member_of', fromEntityId: ada.id, toEntityId: bTeam.id }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(
      createRelationship(ctxB, { type: 'member_of', fromEntityId: ada.id, toEntityId: bTeam.id }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });

    // Listings and adjacency stay per-tenant.
    expect((await listEntities(ctxB, {})).map((entity) => entity.id)).not.toContain(ada.id);
    expect(await listRelationships(ctxB, { entityId: ada.id })).toEqual([]);
    expect((await listRelationshipTypes(ctxB)).map((type) => type.type)).not.toContain('mentored_by_a');
  });

  it('lets the same external reference exist in both tenants independently', async () => {
    const ref = { module: 'people', id: 'person-42' };
    const inA = await createEntity(member(tenantA.tenantId), {
      kind: 'person',
      name: 'Ref Person A',
      externalRef: ref,
    });
    const inB = await createEntity(member(tenantB.tenantId), {
      kind: 'person',
      name: 'Ref Person B',
      externalRef: ref,
    });
    expect(inA.id).not.toBe(inB.id);
  });
});

describe('W044 world — storage-level backstop', () => {
  it('rejects cross-tenant edges and employments at the composite (id, tenant_id) FKs', async () => {
    const ctxA = member(tenantA.tenantId);
    const ctxB = member(tenantB.tenantId);
    const entityA = await createEntity(ctxA, { kind: 'person', name: 'Backstop A' });
    const entityB = await createEntity(ctxB, { kind: 'person', name: 'Backstop B' });

    const db = getDb();
    // Raw SQL bypassing every contract: a B-tenant edge pointing at A's entity.
    await expect(
      db.query(
        `INSERT INTO world_relationships (tenant_id, type, from_entity_id, to_entity_id)
           VALUES ($1, 'member_of', $2, $3)`,
        [tenantB.tenantId, entityA.id, entityB.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const personA = await createPerson(ctxA, { fullName: 'Backstop Person A' });
    // Raw SQL: a B-tenant employment row pointing at A's person (defaults
    // cover status/timestamps, so only the partition-relevant columns are
    // supplied).
    await expect(
      db.query(`INSERT INTO employees (tenant_id, person_id) VALUES ($1, $2)`, [
        tenantB.tenantId,
        personA.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

// ---------------------------------------------------------------------------
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA.tenantId, tenantB.tenantId]);
  });
});
