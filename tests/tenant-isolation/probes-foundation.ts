// W044 — Tenant Isolation Verification: probes for the foundation/evidence
// modules (organizations, identity, people, world, events, observations).
//
// Every probe seeds TWO tenants through the public contracts only, then
// hands the runner a scene of read/list/write attempts plus module-specific
// checks. The uniform protocol the runner enforces is documented in
// tests/tenant-isolation/harness.ts; probe-local comments only call out the
// module-specific sharp edges (e.g. authority-gated writes carry their
// claims so the not-found discipline — not a claim failure — is what the
// probe exercises).

import { expect } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  addWorkspaceMember,
  changeWorkspaceMemberRole,
  createWorkspace,
  getTenant,
  getTenantMembership,
  getWorkspace,
  getWorkspaceMembership,
  listTenantMembers,
  listWorkspaceMembers,
  listWorkspaces,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
  removeWorkspaceMember,
  updateWorkspace,
} from '@/modules/organizations/contract';
import {
  attachVerifiedSubject,
  attestIdentity,
  findExternalIdentityByProviderKey,
  getExternalIdentity,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
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
  resolveIdentity,
  setEmployeeStatus,
} from '@/modules/people/contract';
import {
  createEntity,
  createRelationship,
  deleteEntity,
  deleteRelationship,
  getEntity,
  getRelationship,
  listEntities,
  listEntityKinds,
  listRelationships,
  registerEntityKind,
  updateEntity,
  updateRelationship,
} from '@/modules/world/contract';
import { appendEvent, getEvent, getEventCausationChain, listEvents } from '@/modules/events/contract';
import {
  getObservation,
  getObservationLineage,
  listObservations,
  recordObservation,
} from '@/modules/observations/contract';
import { member, t0Plus, W044_T0, type ModuleProbe } from './harness';

// ---------------------------------------------------------------------------
// organizations
// ---------------------------------------------------------------------------

const organizationsProbe: ModuleProbe = {
  module: 'organizations',
  setup: async () => {
    const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

    const provision = async (label: string) => {
      const ownerPrincipalId = newId();
      const tenant = await provisionTenant(platform, {
        name: `W044 ${label} ${newId().slice(0, 8)}`,
        ownerPrincipalId,
      });
      const owner: TenantContext = {
        tenantId: tenant.id,
        principalId: ownerPrincipalId,
        authority: [],
      };
      return { tenant, owner };
    };

    const a = await provision('Alpha');
    const b = await provision('Beta');
    const wsA = await createWorkspace(a.owner, { name: 'W044 Secrets' });
    const wsB = await createWorkspace(b.owner, { name: 'W044 Secrets' }); // same name, other tenant
    const membershipA = await getTenantMembership(a.owner, { principalId: a.owner.principalId });
    const membershipB = await getTenantMembership(b.owner, { principalId: b.owner.principalId });

    const ids = { tenant: a.tenant.id, workspace: wsA.id, ownerMembership: membershipA.id };
    const idsB = { tenant: b.tenant.id, workspace: wsB.id, ownerMembership: membershipB.id };
    const idKeys = ['tenant', 'workspace', 'ownerMembership'];
    const ownerPrincipalA = a.owner.principalId;

    return {
      module: 'organizations',
      ctxA: a.owner,
      ctxB: b.owner,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getTenant(ctx),
      reads: [
        {
          name: 'getWorkspace',
          code: 'workspace_not_found',
          run: (ctx, probeIds) => getWorkspace(ctx, probeIds.workspace!),
        },
        {
          name: 'getWorkspaceMembership',
          code: 'workspace_not_found',
          run: (ctx, probeIds) =>
            getWorkspaceMembership(ctx, {
              workspaceId: probeIds.workspace!,
              principalId: ownerPrincipalA,
            }),
        },
        {
          name: 'listWorkspaceMembers',
          code: 'workspace_not_found',
          run: (ctx, probeIds) => listWorkspaceMembers(ctx, probeIds.workspace!),
        },
        {
          // a context claiming tenant A with a tenant B principal fails opaquely
          name: 'getTenant with a forged tenant context',
          code: 'tenant_not_found',
          run: (ctx, probeIds) =>
            getTenant({ tenantId: probeIds.tenant!, principalId: ctx.principalId, authority: [] }),
        },
      ],
      lists: [
        { name: 'listWorkspaces', run: (ctx) => listWorkspaces(ctx) },
        { name: 'listTenantMembers', run: (ctx) => listTenantMembers(ctx) },
      ],
      writes: [
        {
          name: 'updateWorkspace',
          code: 'workspace_not_found',
          run: (ctx, probeIds) =>
            updateWorkspace(ctx, { workspaceId: probeIds.workspace!, name: 'w044 hijack' }),
        },
        {
          name: 'addWorkspaceMember',
          code: 'workspace_not_found',
          run: (ctx, probeIds) =>
            addWorkspaceMember(ctx, {
              workspaceId: probeIds.workspace!,
              principalId: newId(),
              role: 'member',
            }),
        },
        {
          name: 'changeWorkspaceMemberRole',
          code: 'workspace_not_found',
          run: (ctx, probeIds) =>
            changeWorkspaceMemberRole(ctx, {
              workspaceId: probeIds.workspace!,
              principalId: ownerPrincipalA,
              role: 'member',
            }),
        },
        {
          name: 'removeWorkspaceMember',
          code: 'workspace_not_found',
          run: (ctx, probeIds) =>
            removeWorkspaceMember(ctx, {
              workspaceId: probeIds.workspace!,
              principalId: ownerPrincipalA,
            }),
        },
      ],
      checks: [
        {
          name: 'the same workspace name is creatable in both tenants (per-tenant slug namespaces)',
          run: async () => {
            expect(wsA.name).toBe(wsB.name);
            expect(wsA.id).not.toBe(wsB.id);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

const identityProbe: ModuleProbe = {
  module: 'identity',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const key = '+15550440'; // same natural (provider, account) key in BOTH tenants

    const seed = async (tenantId: string, subjectId: string) => {
      const { identity } = await registerExternalIdentity(member(tenantId), {
        provider: 'whatsapp',
        providerAccountId: key,
        displayName: 'W044 Channel',
      });
      const manager = member(tenantId, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);
      await attestIdentity(manager, { identityId: identity.id, evidence: 'w044 attestation' });
      await attachVerifiedSubject(manager, { identityId: identity.id, subjectId });
      return identity;
    };

    const subjectA = newId();
    const subjectB = newId();
    const identityA = await seed(tenantA, subjectA);
    const identityB = await seed(tenantB, subjectB);

    const ids = { identity: identityA.id, subject: subjectA };
    const idsB = { identity: identityB.id, subject: subjectB };
    const idKeys = ['identity', 'subject'];
    // authority-carrying context of tenant B: the not-found discipline (not a
    // claim failure) is what the cross-tenant write probes must exercise.
    const managerB = member(tenantB, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);

    return {
      module: 'identity',
      ctxA: member(tenantA),
      ctxB: member(tenantB),
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getExternalIdentity(ctx, ids.identity!),
      reads: [
        {
          name: 'getExternalIdentity',
          code: 'identity_not_found',
          run: (ctx, probeIds) => getExternalIdentity(ctx, probeIds.identity!),
        },
      ],
      lists: [
        {
          name: 'findExternalIdentityByProviderKey',
          run: async (ctx) => [
            await findExternalIdentityByProviderKey(ctx, {
              provider: 'whatsapp',
              providerAccountId: key,
            }),
          ],
        },
        {
          name: 'listSubjectIdentities',
          run: (ctx, probeIds) => listSubjectIdentities(ctx, probeIds.subject!),
        },
      ],
      writes: [
        {
          name: 'attestIdentity',
          code: 'identity_not_found',
          run: (_ctx, probeIds) =>
            attestIdentity(managerB, { identityId: probeIds.identity!, evidence: 'w044 cross-tenant' }),
        },
        {
          name: 'revokeVerification',
          code: 'identity_not_found',
          run: (_ctx, probeIds) =>
            revokeVerification(managerB, { identityId: probeIds.identity!, reason: 'w044 cross-tenant' }),
        },
        {
          name: 'attachVerifiedSubject',
          code: 'identity_not_found',
          run: (_ctx, probeIds) =>
            attachVerifiedSubject(managerB, { identityId: probeIds.identity!, subjectId: subjectB }),
        },
      ],
      checks: [
        {
          name: 'the same (provider, account) key resolves to distinct per-tenant identities',
          run: async () => {
            expect(identityA.id).not.toBe(identityB.id);
            const inA = await findExternalIdentityByProviderKey(member(tenantA), {
              provider: 'whatsapp',
              providerAccountId: key,
            });
            const inB = await findExternalIdentityByProviderKey(member(tenantB), {
              provider: 'whatsapp',
              providerAccountId: key,
            });
            expect(inA?.id).toBe(identityA.id);
            expect(inB?.id).toBe(identityB.id);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// people
// ---------------------------------------------------------------------------

const peopleProbe: ModuleProbe = {
  module: 'people',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const employeeNumber = 'W044-E1'; // reused in both tenants
    const accountKey = '+15550441';

    const seed = async (tenantId: string) => {
      const person = await createPerson(member(tenantId), { fullName: 'W044 Person' });
      const employee = await createEmployee(member(tenantId), {
        personId: person.id,
        employeeNumber,
        title: 'W044 Title',
      });
      const { identity } = await registerExternalIdentity(member(tenantId), {
        provider: 'whatsapp',
        providerAccountId: accountKey,
      });
      const manager = member(tenantId, [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK]);
      const attested = await attestIdentity(manager, {
        identityId: identity.id,
        evidence: 'w044 attestation',
      });
      await linkExternalIdentity(manager, { personId: person.id, identityId: attested.id });
      return { person, employee };
    };

    const a = await seed(tenantA);
    const b = await seed(tenantB);

    const ids = { person: a.person.id, employee: a.employee.id };
    const idsB = { person: b.person.id, employee: b.employee.id };
    const idKeys = ['person', 'employee'];

    return {
      module: 'people',
      ctxA: member(tenantA),
      ctxB: member(tenantB),
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getPerson(ctx, ids.person!),
      reads: [
        {
          name: 'getPerson',
          code: 'person_not_found',
          run: (ctx, probeIds) => getPerson(ctx, probeIds.person!),
        },
        {
          name: 'listPersonIdentities',
          code: 'person_not_found',
          run: (ctx, probeIds) => listPersonIdentities(ctx, probeIds.person!),
        },
      ],
      lists: [
        {
          name: 'getEmployeeByPerson',
          run: async (ctx, probeIds) => [await getEmployeeByPerson(ctx, probeIds.person!)],
        },
        {
          name: 'resolveIdentity',
          run: async (ctx) => [
            await resolveIdentity(ctx, { provider: 'whatsapp', providerAccountId: accountKey }),
          ],
        },
      ],
      writes: [
        {
          name: 'createEmployee for another tenant\'s person',
          code: 'person_not_found',
          run: (ctx, probeIds) =>
            createEmployee(ctx, {
              personId: probeIds.person!,
              employeeNumber: 'W044-X1',
              title: 'w044 hijack',
            }),
        },
        {
          name: 'setEmployeeStatus',
          code: 'employee_not_found',
          run: (ctx, probeIds) =>
            setEmployeeStatus(ctx, { employeeId: probeIds.employee!, status: 'on_leave' }),
        },
      ],
      checks: [
        {
          name: 'the same employee number is reusable in another tenant',
          run: async () => {
            expect(a.employee.employeeNumber).toBe(employeeNumber);
            expect(b.employee.employeeNumber).toBe(employeeNumber);
            expect(a.employee.id).not.toBe(b.employee.id);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

const worldProbe: ModuleProbe = {
  module: 'world',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const customKind = 'w044_custom_kind';

    const seed = async (ctx: TenantContext, registerCustom: boolean) => {
      const person = await createEntity(ctx, {
        kind: 'person',
        name: 'W044 Alpha Person',
        externalRef: { module: 'w044', id: 'shared-ref' },
      });
      const team = await createEntity(ctx, { kind: 'team', name: 'W044 Alpha Team' });
      const relationship = await createRelationship(ctx, {
        type: 'member_of',
        fromEntityId: person.id,
        toEntityId: team.id,
      });
      if (registerCustom) {
        await registerEntityKind(ctx, { kind: customKind, category: 'company', description: 'w044' });
      }
      return { person, team, relationship };
    };

    const a = await seed(ctxA, true);
    const b = await seed(ctxB, false); // B deliberately lacks A's custom vocabulary

    const ids = { entity: a.person.id, entity2: a.team.id, relationship: a.relationship.id };
    const idsB = { entity: b.person.id, entity2: b.team.id, relationship: b.relationship.id };
    const idKeys = ['entity', 'entity2', 'relationship'];

    return {
      module: 'world',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getEntity(ctx, ids.entity!),
      reads: [
        {
          name: 'getEntity',
          code: 'entity_not_found',
          run: (ctx, probeIds) => getEntity(ctx, probeIds.entity!),
        },
        {
          name: 'getRelationship',
          code: 'relationship_not_found',
          run: (ctx, probeIds) => getRelationship(ctx, probeIds.relationship!),
        },
      ],
      lists: [
        {
          name: 'listEntities by search',
          run: (ctx) => listEntities(ctx, { search: 'W044 Alpha' }),
        },
        {
          name: 'listRelationships by entity adjacency',
          run: (ctx, probeIds) => listRelationships(ctx, { entityId: probeIds.entity! }),
        },
      ],
      writes: [
        {
          name: 'updateEntity',
          code: 'entity_not_found',
          run: (ctx, probeIds) =>
            updateEntity(ctx, { entityId: probeIds.entity!, name: 'w044 hijack' }),
        },
        {
          name: 'deleteEntity',
          code: 'entity_not_found',
          run: (ctx, probeIds) => deleteEntity(ctx, probeIds.entity!),
        },
        {
          name: 'createRelationship with a foreign endpoint',
          code: 'entity_not_found',
          run: (ctx, probeIds) =>
            createRelationship(ctx, {
              type: 'member_of',
              fromEntityId: probeIds.entity!,
              toEntityId: b.person.id,
            }),
        },
        {
          name: 'updateRelationship',
          code: 'relationship_not_found',
          run: (ctx, probeIds) =>
            updateRelationship(ctx, {
              relationshipId: probeIds.relationship!,
              attributes: { w044: true },
            }),
        },
        {
          name: 'deleteRelationship',
          code: 'relationship_not_found',
          run: (ctx, probeIds) => deleteRelationship(ctx, probeIds.relationship!),
        },
      ],
      checks: [
        {
          name: 'the same externalRef is registrable in both tenants',
          run: async () => {
            expect(a.person.id).not.toBe(b.person.id);
            expect((await getEntity(ctxA, a.person.id)).id).toBe(a.person.id);
            expect((await getEntity(ctxB, b.person.id)).id).toBe(b.person.id);
          },
        },
        {
          name: 'a custom entity kind registered in tenant A is invisible to tenant B',
          run: async () => {
            const kindsA = (await listEntityKinds(ctxA)).map((entry) => entry.kind);
            const kindsB = (await listEntityKinds(ctxB)).map((entry) => entry.kind);
            expect(kindsA).toContain(customKind);
            expect(kindsB).not.toContain(customKind);
            await expect(createEntity(ctxB, { kind: customKind, name: 'w044 sneaky' })).rejects.toMatchObject(
              { code: 'unknown_entity_kind' },
            );
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

const eventsProbe: ModuleProbe = {
  module: 'events',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const idempotencyKey = 'w044-shared-key'; // same key in both tenants

    const rootInput = () => ({
      type: 'w044.signal',
      payload: { text: 'w044 signal' },
      occurredAt: W044_T0,
      actor: { kind: 'person' as const, label: 'w044-probe' },
      source: { kind: 'channel' as const, label: 'whatsapp' },
      idempotencyKey,
    });

    const rootA = await appendEvent(ctxA, rootInput());
    const leafA = await appendEvent(ctxA, { ...rootInput(), causationId: rootA.id });
    const rootB = await appendEvent(ctxB, rootInput());
    const leafB = await appendEvent(ctxB, { ...rootInput(), causationId: rootB.id });

    const ids = { root: rootA.id, leaf: leafA.id };
    const idsB = { root: rootB.id, leaf: leafB.id };
    const idKeys = ['root', 'leaf'];

    return {
      module: 'events',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getEvent(ctx, ids.root!),
      reads: [
        {
          name: 'getEvent',
          code: 'event_not_found',
          run: (ctx, probeIds) => getEvent(ctx, probeIds.root!),
        },
        {
          name: 'getEventCausationChain',
          code: 'event_not_found',
          run: (ctx, probeIds) => getEventCausationChain(ctx, probeIds.leaf!),
        },
      ],
      lists: [{ name: 'listEvents', run: (ctx) => listEvents(ctx, {}) }],
      writes: [
        {
          name: 'appendEvent caused by another tenant\'s event',
          code: 'event_not_found',
          run: (ctx, probeIds) =>
            appendEvent(ctx, {
              type: 'w044.signal',
              payload: { text: 'w044 cross-tenant cause' },
              occurredAt: t0Plus(60),
              actor: { kind: 'person' as const, label: 'w044-probe' },
              source: { kind: 'channel' as const, label: 'whatsapp' },
              causationId: probeIds.root!,
            }),
        },
      ],
      checks: [
        {
          name: 'the same idempotency key is reusable across tenants without dedupe interference',
          run: async () => {
            expect(rootA.id).not.toBe(rootB.id);
            expect((await getEvent(ctxA, rootA.id)).id).toBe(rootA.id);
            expect((await getEvent(ctxB, rootB.id)).id).toBe(rootB.id);
            const feedA = await listEvents(ctxA, { idempotencyKey });
            const feedB = await listEvents(ctxB, { idempotencyKey });
            expect(feedA.map((event) => event.id)).toEqual([rootA.id]);
            expect(feedB.map((event) => event.id)).toEqual([rootB.id]);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// observations
// ---------------------------------------------------------------------------

const observationsProbe: ModuleProbe = {
  module: 'observations',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ownerA = newId();
    const ownerB = newId();
    const ctxA: TenantContext = { tenantId: tenantA, principalId: ownerA, authority: [] };
    const ctxB: TenantContext = { tenantId: tenantB, principalId: ownerB, authority: [] };

    const observationInput = () => ({
      kind: 'channel.message',
      payload: { text: 'w044 printer report' },
      observedAt: W044_T0,
      source: { kind: 'person' as const, label: 'w044-probe' },
      channel: 'whatsapp',
      confidence: { value: 0.9, method: 'source_trust', basis: 'w044' },
    });

    const observationA = await recordObservation(ctxA, observationInput());
    const childA = await recordObservation(ctxA, {
      ...observationInput(),
      kind: 'document.note',
      payload: { note: 'w044 derived' },
      lineage: { method: 'extraction', parents: [observationA.id] },
    });
    // principal-scoped evidence: only ownerA may read it inside tenant A
    const restrictedA = await recordObservation(ctxA, {
      ...observationInput(),
      payload: { text: 'w044 confidential' },
      permissions: { visibility: 'principal', principalId: ownerA },
    });

    const observationB = await recordObservation(ctxB, observationInput());
    const childB = await recordObservation(ctxB, {
      ...observationInput(),
      kind: 'document.note',
      payload: { note: 'w044 derived' },
      lineage: { method: 'extraction', parents: [observationB.id] },
    });
    const restrictedB = await recordObservation(ctxB, {
      ...observationInput(),
      payload: { text: 'w044 confidential' },
      permissions: { visibility: 'principal', principalId: ownerB },
    });

    const ids = { observation: observationA.id, child: childA.id, restricted: restrictedA.id };
    const idsB = { observation: observationB.id, child: childB.id, restricted: restrictedB.id };
    const idKeys = ['observation', 'child', 'restricted'];

    return {
      module: 'observations',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getObservation(ctx, ids.observation!),
      reads: [
        {
          name: 'getObservation',
          code: 'observation_not_found',
          run: (ctx, probeIds) => getObservation(ctx, probeIds.observation!),
        },
        {
          name: 'getObservationLineage',
          code: 'observation_not_found',
          run: (ctx, probeIds) => getObservationLineage(ctx, probeIds.child!),
        },
        {
          // restricted evidence of ANOTHER tenant is a uniform not-found (no visibility leak)
          name: 'getObservation of principal-scoped evidence',
          code: 'observation_not_found',
          run: (ctx, probeIds) => getObservation(ctx, probeIds.restricted!),
        },
      ],
      lists: [{ name: 'listObservations', run: (ctx) => listObservations(ctx, {}) }],
      writes: [
        {
          name: 'recordObservation derived from another tenant\'s evidence',
          code: 'observation_not_found',
          run: (ctx, probeIds) =>
            recordObservation(ctx, {
              ...observationInput(),
              kind: 'document.note',
              payload: { note: 'w044 cross-tenant derivation' },
              lineage: { method: 'extraction', parents: [probeIds.observation!] },
            }),
        },
      ],
      checks: [],
    };
  },
};

export const foundationProbes: ModuleProbe[] = [
  organizationsProbe,
  identityProbe,
  peopleProbe,
  worldProbe,
  eventsProbe,
  observationsProbe,
];
