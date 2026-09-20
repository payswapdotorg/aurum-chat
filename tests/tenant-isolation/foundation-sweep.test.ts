// W044 — Tenant Isolation Verification · application-boundary sweep for the
// L0 foundation modules: organizations (W001), identity (W002), people
// (W002), events (W003), world (W005), audit (W046, the append-only
// decision-evidence trail), simulator (W056, the synthetic company) and
// auth (W058 — the session boundary: invitations are tenant-scoped and a
// session can only ever point at a LIVE-VERIFIED member company).
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
import { authorizeAction } from '@/modules/actions/contract';
import {
  getAuditRecord,
  listAuditRecords,
  recordAudit,
  reconstructDecision,
} from '@/modules/audit/contract';
import type { RecordAuditInput } from '@/modules/audit/contract';
import { startExecution } from '@/modules/cognition/contract';
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
import { recordObservation } from '@/modules/observations/contract';
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
  advanceMonth,
  getCompany,
  listMonthReports,
  materializeCompany,
  revealGroundTruth,
  TOTAL_MONTHS,
} from '@/modules/simulator/contract';
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
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  omnipotent,
  runMigrations,
  storedTenantId,
} from './harness';
import {
  createInvitation,
  listInvitations,
  resolveSession,
  revokeInvitation,
  signUp,
  switchTenant,
} from '@/modules/auth/contract';

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
// audit (W046)
// ---------------------------------------------------------------------------

describe('W044 audit — the append-only decision-evidence trail is tenant-scoped', () => {
  it('keeps the trail per tenant: disjoint listings, same subject tuple coexisting', async () => {
    const ctxA = member(tenantA.tenantId);
    const ctxB = member(tenantB.tenantId);

    // A consequential decision of tenant A: a real observation (its payload
    // carries A's confidential marker) triggering a cognitive execution.
    const observation = await recordObservation(ctxA, {
      kind: 'channel.message',
      payload: { text: 'churn spiked 12% in Q3 (alpha-trail-secret)' },
      observedAt: '2026-09-14T09:15:00.000Z',
      source: { kind: 'source', label: 'slack' },
      channel: 'slack',
      confidence: { value: 0.8, method: 'test' },
    });
    const trace = await startExecution(ctxA, {
      trigger: { kind: 'observation', id: observation.id, label: null },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'w044-isolation-sweep' },
    });

    // The trail has NO tenant-unique natural key (surrogate ids; subjects
    // are opaque forward references by W046 design) — the namespace probe
    // is the strongest applicable analog: both tenants record the SAME
    // business tuple (subjectKind, subjectId, event, chainStage,
    // correlationId) and each row stays its own tenant's evidence.
    const inA = await recordAudit(ctxA, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      correlationId: trace.correlationId,
      summary: 'alpha trail event',
      detail: { note: 'alpha-trail-secret' },
    });
    const inB = await recordAudit(ctxB, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      correlationId: trace.correlationId,
      summary: 'beta trail event',
      detail: { note: 'beta-trail-secret' },
    });
    expect(inA.id).not.toBe(inB.id);
    expect(inA.tenantId).toBe(tenantA.tenantId);
    expect(inB.tenantId).toBe(tenantB.tenantId);

    // Listings are per-tenant and disjoint; payloads never cross.
    const aTrail = await listAuditRecords(ctxA, {});
    const bTrail = await listAuditRecords(ctxB, {});
    expect(aTrail.map((record) => record.id)).toContain(inA.id);
    expect(aTrail.map((record) => record.id)).not.toContain(inB.id);
    expect(bTrail.map((record) => record.id)).toContain(inB.id);
    expect(bTrail.map((record) => record.id)).not.toContain(inA.id);
    expect(JSON.stringify(bTrail)).not.toContain('alpha-trail-secret');
    expect(JSON.stringify(aTrail)).not.toContain('beta-trail-secret');

    // Subject- and correlation-scoped listings resolve inside the calling
    // tenant only — the SAME subject and correlation values yield each
    // tenant's own row, never the other's.
    const aBySubject = await listAuditRecords(ctxA, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
    });
    expect(aBySubject.map((record) => record.id)).toEqual([inA.id]);
    const bBySubject = await listAuditRecords(ctxB, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
    });
    expect(bBySubject.map((record) => record.id)).toEqual([inB.id]);
    const bByCorrelation = await listAuditRecords(ctxB, { correlationId: trace.correlationId });
    expect(bByCorrelation.map((record) => record.id)).toEqual([inB.id]);
  });

  it('makes cross-tenant reads and reconstructions uniform not-found', async () => {
    const ctxA = member(tenantA.tenantId);
    const ctxB = member(tenantB.tenantId);

    // A consequential decision of tenant A: an observation-triggered
    // cognitive execution plus a directly-authorized action request.
    const observation = await recordObservation(ctxA, {
      kind: 'channel.message',
      payload: { text: 'churn spiked 15% in Q4 (alpha-reconstruct-secret)' },
      observedAt: '2026-09-14T10:15:00.000Z',
      source: { kind: 'source', label: 'slack' },
      channel: 'slack',
      confidence: { value: 0.8, method: 'test' },
    });
    const trace = await startExecution(ctxA, {
      trigger: { kind: 'observation', id: observation.id, label: null },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'w044-isolation-sweep' },
    });
    const request = await authorizeAction(ctxA, {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { to: 'vp-cs', question: 'alpha-only request' },
    });
    const historyA = await recordAudit(ctxA, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      correlationId: trace.correlationId,
      summary: 'alpha reconstruction history',
    });

    // Reads: a foreign audit record ≡ a missing one.
    await expectUniformNotFound(
      'audit_record_not_found',
      () => getAuditRecord(ctxB, { recordId: historyA.id }),
      () => getAuditRecord(ctxB, { recordId: newId() }),
    );

    // Reconstructions: every anchor kind resolves inside the calling
    // tenant only — foreign ≡ missing, no existence leak of A's cognitive
    // executions, action requests or decision flows.
    await expectUniformNotFound(
      'execution_not_found',
      () => reconstructDecision(ctxB, { executionId: trace.id }),
      () => reconstructDecision(ctxB, { executionId: newId() }),
    );
    await expectUniformNotFound(
      'action_request_not_found',
      () => reconstructDecision(ctxB, { actionRequestId: request.id }),
      () => reconstructDecision(ctxB, { actionRequestId: newId() }),
    );
    await expectUniformNotFound(
      'execution_not_found',
      () => reconstructDecision(ctxB, { correlationId: trace.correlationId }),
      () => reconstructDecision(ctxB, { correlationId: newId() }),
    );

    // A's own reconstruction assembles the REAL chain (the acceptance
    // core): the §24 input link deep-links the trigger observation (its
    // payload confidential to A), the execution link carries the anchored
    // execution, and the decision's audit history contains A's record.
    const evidence = await reconstructDecision(ctxA, { executionId: trace.id });
    expect(evidence.tenantId).toBe(tenantA.tenantId);
    // The §24 input link deep-links the trigger observation (an unreadable
    // marker never applies here — the recording principal can read its own
    // observation), so the payload is asserted confidential to A.
    const inputObservation = evidence.chain.input.observation;
    if (inputObservation === null || inputObservation.unreadable) {
      throw new Error('expected a readable input observation in the reconstruction');
    }
    expect(inputObservation.id).toBe(observation.id);
    expect(JSON.stringify(inputObservation.payload)).toContain('alpha-reconstruct-secret');
    expect(evidence.chain.execution.executions.map((execution) => execution.id)).toEqual([
      trace.id,
    ]);
    expect(evidence.auditRecords.map((record) => record.id)).toContain(historyA.id);
    const directEvidence = await reconstructDecision(ctxA, { actionRequestId: request.id });
    expect(directEvidence.chain.recommendation.actionRequest?.id).toBe(request.id);
    expect(directEvidence.chain.execution.directAuthorization).toBe(true);

    // The omnipotent principal of tenant B — every claim in the repository,
    // and the audit module checks none for its own operations — is equally
    // blind to A's trail, anchors and subject-scoped history.
    const omniB = omnipotent(tenantB.tenantId);
    await expect(getAuditRecord(omniB, { recordId: historyA.id })).rejects.toMatchObject({
      code: 'audit_record_not_found',
    });
    await expect(reconstructDecision(omniB, { executionId: trace.id })).rejects.toMatchObject({
      code: 'execution_not_found',
    });
    expect(
      (await listAuditRecords(omniB, {
        subjectKind: 'cognition.execution',
        subjectId: trace.id,
      })).map((record) => record.id),
    ).not.toContain(historyA.id);
  });

  it("keeps cross-tenant appends in the caller's tenant — the other trail is never touched", async () => {
    const ctxA = member(tenantA.tenantId);
    const ctxB = member(tenantB.tenantId);

    // A real subject of tenant A (the contract's documented anchor kind).
    const observation = await recordObservation(ctxA, {
      kind: 'channel.message',
      payload: { text: 'the printer on floor 3 is broken (alpha-append-secret)' },
      observedAt: '2026-09-14T11:15:00.000Z',
      source: { kind: 'source', label: 'slack' },
      channel: 'slack',
      confidence: { value: 0.8, method: 'test' },
    });
    const trace = await startExecution(ctxA, {
      trigger: { kind: 'observation', id: observation.id, label: null },
      focus: { topics: ['facilities'], entities: [] },
      actor: { kind: 'system', label: 'w044-isolation-sweep' },
    });
    const own = await recordAudit(ctxA, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      correlationId: trace.correlationId,
      summary: 'alpha append guard',
    });

    // The contract validates subject ids as OPAQUE forward references (the
    // W046 design — subjects are owned by their modules, never FK-joined),
    // so B may append a record ABOUT A's subject id: the row lands under
    // the CALLER's tenant with the CALLER's principal. A's trail is not
    // extended, mutated or even readable through it.
    const foreign = await recordAudit(ctxB, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      correlationId: trace.correlationId,
      summary: 'beta append about an alpha subject',
    });
    expect(foreign.tenantId).toBe(tenantB.tenantId);
    expect(foreign.principalId).toBe(ctxB.principalId); // authorship minted from the context
    expect(await storedTenantId('audit_records', foreign.id)).toBe(tenantB.tenantId);
    expect(
      (await listAuditRecords(ctxA, {
        subjectKind: 'cognition.execution',
        subjectId: trace.id,
      })).map((record) => record.id),
    ).toEqual([own.id]);
    // Symmetric unreadability: neither tenant can read the other's row.
    await expect(getAuditRecord(ctxA, { recordId: foreign.id })).rejects.toMatchObject({
      code: 'audit_record_not_found',
    });
    await expect(getAuditRecord(ctxB, { recordId: own.id })).rejects.toMatchObject({
      code: 'audit_record_not_found',
    });

    // The input surface is the only way a caller could forge tenancy or
    // authorship into a record, and it rejects both outright (unknown
    // keys): WHERE the record lives and WHO recorded it are minted from
    // the TenantContext, never caller-supplied.
    const base: RecordAuditInput = {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      summary: 'forged tenancy',
    };
    await expect(
      recordAudit(ctxB, { ...base, tenantId: tenantA.tenantId } as RecordAuditInput),
    ).rejects.toMatchObject({ code: 'invalid_record_input' });
    await expect(
      recordAudit(ctxB, { ...base, principalId: newId() } as RecordAuditInput),
    ).rejects.toMatchObject({ code: 'invalid_record_input' });

    // The storage backstop: the trail is append-only for EVERYONE — a raw
    // UPDATE targeting A's row, bypassing every contract, is rejected by
    // the W046 immutability trigger and A's record reads back unchanged.
    await expect(
      getDb().query(`UPDATE audit_records SET summary = 'rewritten by B' WHERE id = $1`, [own.id]),
    ).rejects.toMatchObject({ code: 'P0001' });
    const reloaded = await getAuditRecord(ctxA, { recordId: own.id });
    expect(reloaded.summary).toBe('alpha append guard');
    expect(reloaded.principalId).toBe(ctxA.principalId);
  });
});

// ---------------------------------------------------------------------------
// simulator (W056)
// ---------------------------------------------------------------------------

describe('W044 simulator — synthetic companies and hidden ground truth are tenant-scoped', () => {
  // materializeCompany links verified employee channel identities, so the
  // driving principal must hold the identity attest/link authorities (both
  // already in the harness's OMNIPOTENT_AUTHORITY — the blind probe below
  // reuses the full claim set through omnipotent()).
  const privileged = (tenantId: string): TenantContext =>
    memberWith(tenantId, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);
  // The minimal month driver: observable scenario behavior only, without
  // the optional learning update, oracle judgments or quality snapshot.
  const drive = { learning: false, judgments: false, snapshot: false } as const;

  // ONE synthetic company per tenant, shared by the probes below (the
  // simulator suite's own beforeAll precedent): the frozen reference
  // design's supplier names are template constants — only identities,
  // markers and the process name vary with the seed — so a tenant holds
  // at most one simulator company (the suppliers natural key
  // UNIQUE (tenant_id, name) is what a second materialization would hit).
  const SHARED_SEED = 60501;
  const alpha: { id: string } = { id: '' };
  const beta: { id: string } = { id: '' };

  beforeAll(async () => {
    const companyA = await materializeCompany(privileged(tenantA.tenantId), {
      seed: SHARED_SEED,
      name: 'Northwind Synthetic',
    });
    const companyB = await materializeCompany(privileged(tenantB.tenantId), {
      seed: SHARED_SEED,
      name: 'Northwind Synthetic',
    });
    alpha.id = companyA.id;
    beta.id = companyB.id;
  });

  it('gives the same scenario seed independent companies per tenant', async () => {
    const viewA = await getCompany(member(tenantA.tenantId), { companyId: alpha.id });
    const viewB = await getCompany(member(tenantB.tenantId), { companyId: beta.id });
    expect(viewA.id).not.toBe(viewB.id);
    expect(viewA.tenantId).toBe(tenantA.tenantId);
    expect(viewB.tenantId).toBe(tenantB.tenantId);
    expect(viewA.seed).toBe(SHARED_SEED);
    expect(viewB.seed).toBe(SHARED_SEED);
    expect(viewA.name).toBe(viewB.name);

    // UNIQUE (tenant_id, seed) — the scenario namespace is per-tenant: B's
    // same-seed company never collided with A's; only a SECOND company
    // with the same seed INSIDE one tenant is a duplicate.
    await expect(
      materializeCompany(privileged(tenantA.tenantId), { seed: SHARED_SEED, name: 'Northwind Dup' }),
    ).rejects.toMatchObject({ code: 'company_already_exists' });

    // The full hidden-facts timeline (one row per month) exists for A's
    // company and is stored ONLY under A — ground truth is born partitioned.
    const ownFacts = await getDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sim_hidden_facts WHERE company_id = $1 AND tenant_id = $2`,
      [alpha.id, tenantA.tenantId],
    );
    expect(Number(ownFacts.rows[0]?.n)).toBe(TOTAL_MONTHS);
    const misplaced = await getDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sim_hidden_facts WHERE company_id = $1 AND tenant_id <> $2`,
      [alpha.id, tenantA.tenantId],
    );
    expect(Number(misplaced.rows[0]?.n)).toBe(0);

    // Each tenant reveals its OWN ground truth through the evaluation
    // surface; the same seed yields the same deterministic design.
    const revealA = await revealGroundTruth(member(tenantA.tenantId), {
      companyId: alpha.id,
      month: 1,
    });
    const revealB = await revealGroundTruth(member(tenantB.tenantId), {
      companyId: beta.id,
      month: 1,
    });
    expect(revealA.tenantId).toBe(tenantA.tenantId);
    expect(revealB.tenantId).toBe(tenantB.tenantId);
    expect(revealA.marker).toBe(revealB.marker);
  });

  it('makes cross-tenant reads and ground-truth reveals uniform not-found', async () => {
    const ctxB = member(tenantB.tenantId);

    // The public company view: foreign ≡ missing.
    await expectUniformNotFound(
      'company_not_found',
      () => getCompany(ctxB, { companyId: alpha.id }),
      () => getCompany(ctxB, { companyId: newId() }),
    );

    // THE W056 no-hidden-ground-truth-leakage probe at the tenant boundary:
    // revealGroundTruth is the only surface exposing the hidden
    // consequential facts, and a foreign company is indistinguishable from
    // a missing one — from month 1 through the end of the timeline.
    await expectUniformNotFound(
      'company_not_found',
      () => revealGroundTruth(ctxB, { companyId: alpha.id, month: 1 }),
      () => revealGroundTruth(ctxB, { companyId: newId(), month: 1 }),
    );
    await expect(
      revealGroundTruth(ctxB, { companyId: alpha.id, month: TOTAL_MONTHS }),
    ).rejects.toMatchObject({ code: 'company_not_found' });

    // The recorded month history is equally invisible.
    await expectUniformNotFound(
      'company_not_found',
      () => listMonthReports(ctxB, { companyId: alpha.id }),
      () => listMonthReports(ctxB, { companyId: newId() }),
    );

    // A's own reveal works — the ground truth is readable inside A only.
    const reveal = await revealGroundTruth(member(tenantA.tenantId), {
      companyId: alpha.id,
      month: 1,
    });
    expect(reveal.marker).toMatch(/^gt-/);
    expect(reveal.answerText).toBeTruthy();

    // The omnipotent principal of tenant B holds every claim the module
    // checks (identity:attest + identity:link — it may materialize its OWN
    // companies) and is STILL blind to A's company, hidden truth and
    // lifecycle: authority authorizes operations, never tenant scope.
    const omniB = omnipotent(tenantB.tenantId);
    await expect(getCompany(omniB, { companyId: alpha.id })).rejects.toMatchObject({
      code: 'company_not_found',
    });
    await expect(
      revealGroundTruth(omniB, { companyId: alpha.id, month: 1 }),
    ).rejects.toMatchObject({ code: 'company_not_found' });
    await expect(
      advanceMonth(omniB, { companyId: alpha.id, learning: false }),
    ).rejects.toMatchObject({ code: 'company_not_found' });
  });

  it('rejects cross-tenant month advances and keeps month reports per tenant', async () => {
    // One month of synthetic life in each tenant — the scenario lifecycle
    // runs independently per tenant.
    const monthA = await advanceMonth(privileged(tenantA.tenantId), {
      companyId: alpha.id,
      ...drive,
    });
    const monthB = await advanceMonth(privileged(tenantB.tenantId), {
      companyId: beta.id,
      ...drive,
    });
    expect(monthA.month).toBe(1);
    expect(monthB.month).toBe(1);
    expect(monthA.tenantId).toBe(tenantA.tenantId);
    expect(monthB.tenantId).toBe(tenantB.tenantId);

    // Cross-tenant write: B advancing A's company is uniform not-found —
    // indistinguishable from advancing a company that never existed.
    await expectUniformNotFound(
      'company_not_found',
      () => advanceMonth(privileged(tenantB.tenantId), { companyId: alpha.id, ...drive }),
      () => advanceMonth(privileged(tenantB.tenantId), { companyId: newId(), ...drive }),
    );

    // A's company is unchanged by B's attempts: the month cursor was not
    // bumped and no phantom month report landed in A's history.
    const after = await getCompany(member(tenantA.tenantId), { companyId: alpha.id });
    expect(after.currentMonth).toBe(1);
    const aReports = await listMonthReports(member(tenantA.tenantId), { companyId: alpha.id });
    expect(aReports.map((report) => report.month)).toEqual([1]);
    expect(aReports.every((report) => report.tenantId === tenantA.tenantId)).toBe(true);
    expect(aReports.every((report) => report.companyId === alpha.id)).toBe(true);

    // Listings stay per-tenant and disjoint: each tenant's month history
    // holds only its own company's months.
    const bReports = await listMonthReports(member(tenantB.tenantId), { companyId: beta.id });
    expect(bReports.map((report) => report.month)).toEqual([1]);
    expect(bReports.every((report) => report.companyId === beta.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auth (W058)
// ---------------------------------------------------------------------------

describe('W058 auth — invitations are tenant-scoped and sessions cannot cross scope', () => {
  it('a forged context cannot list or create invitations in another tenant (membership gate)', async () => {
    // tenantA's principal claiming tenantB: the organizations contract
    // makes a non-member indistinguishable from a missing tenant, and
    // auth maps it to tenant_unavailable — no existence leak.
    const forged: TenantContext = {
      tenantId: tenantB.tenantId,
      principalId: tenantA.owner.principalId,
      authority: [],
    };
    await expect(listInvitations(forged)).rejects.toMatchObject({
      code: 'tenant_unavailable',
    });
    await expect(
      createInvitation(forged, {
        email: [newId().slice(0, 8), 'sweep'].join('.') + '@example.invalid',
        tenantRole: 'member',
      }),
    ).rejects.toMatchObject({ code: 'tenant_unavailable' });
  });

  it('invitation rosters stay per-tenant and disjoint; foreign ids are uniform not-found', async () => {
    const email = [newId().slice(0, 8), 'sweep', 'a'].join('.') + '@example.invalid';
    const created = await createInvitation(tenantA.owner, {
      email,
      tenantRole: 'member',
    });
    expect(created.tenantId).toBe(tenantA.tenantId);

    const aInvites = await listInvitations(tenantA.owner);
    expect(aInvites.map((invite) => invite.id)).toContain(created.id);
    expect(aInvites.every((invite) => invite.tenantId === tenantA.tenantId)).toBe(true);

    const bInvites = await listInvitations(tenantB.owner);
    expect(bInvites.map((invite) => invite.id)).not.toContain(created.id);
    expect(bInvites.every((invite) => invite.tenantId === tenantB.tenantId)).toBe(true);

    // A foreign revoke is uniform not-found (the UPDATE pins tenant_id).
    await expect(
      revokeInvitation(tenantB.owner, { invitationId: created.id }),
    ).rejects.toMatchObject({ code: 'invitation_not_found' });
  });

  it('a session can only switch to a company its principal is a verified member of', async () => {
    // Real accounts, granted membership through the organizations contract.
    const account = await signUp({
      email: [newId().slice(0, 8), 'sweep', 'member'].join('.') + '@example.invalid',
      password: ['sweep', 'member', newId().slice(0, 6)].join('-'),
      displayName: 'Sweep Member',
    });
    await addTenantMember(tenantA.owner, { principalId: account.principal.id, role: 'member' });

    const switched = await switchTenant(account.token, { tenantId: tenantA.tenantId });
    expect(switched.tenant?.id).toBe(tenantA.tenantId);

    // Cross-scope switching (tenantB) fails — membership is the gate, and
    // the failure is indistinguishable from a missing company.
    await expect(
      switchTenant(account.token, { tenantId: tenantB.tenantId }),
    ).rejects.toMatchObject({ code: 'tenant_unavailable' });

    // The session still points at tenantA after the failed attempt.
    const resolved = await resolveSession(account.token);
    expect(resolved.status).toBe('valid');
    if (resolved.status === 'valid') {
      expect(resolved.resolved.tenant?.id).toBe(tenantA.tenantId);
    }

    // Revoking the membership degrades the session to NO company — the
    // session boundary never hands out tenant data for a lost scope.
    await removeTenantMember(tenantA.owner, { principalId: account.principal.id });
    const after = await resolveSession(account.token);
    expect(after.status).toBe('valid');
    if (after.status === 'valid') {
      expect(after.resolved.tenant).toBeNull();
      expect(after.resolved.context).toBeNull();
    }
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
