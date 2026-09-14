// Integration tests for the world module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W005 acceptance:
//
//  * extensible entities/relationships for company, people, processes,
//    capabilities and environment — built-in vocabulary + tenant-registered
//    custom kinds/types + JSON attributes;
//  * RELATIONSHIPS ARE TENANT-SCOPED — proven at BOTH boundaries:
//      - service level: cross-tenant endpoints/ids are indistinguishable
//        from missing ones (`entity_not_found` / `relationship_not_found`),
//        lists never leak, custom vocabulary is per tenant;
//      - storage level: the composite (id, tenant_id) endpoint foreign keys
//        make a cross-tenant relationship UNREPRESENTABLE in SQL — a direct
//        INSERT bypassing the service fails with a 23503 FK violation;
//  * entity/relationship lifecycle (create/read/update/delete/list) with
//    system-minted identity, tenancy and timestamps.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as worldContract from '../contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

const {
  createEntity,
  createRelationship,
  deleteEntity,
  deleteRelationship,
  getEntity,
  getRelationship,
  listEntities,
  listEntityKinds,
  listRelationshipTypes,
  listRelationships,
  registerEntityKind,
  registerRelationshipType,
  updateEntity,
  updateRelationship,
} = worldContract;

const tenantA = newId();
const tenantB = newId();
const tenantList = newId(); // dedicated tenant so list tests see only their
const tenantRel = newId(); // own data
const tenantAdj = newId(); // adjacency/listing in isolation

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function baseEntity(): Parameters<typeof createEntity>[1] {
  return { kind: 'person', name: 'Ada Lovelace' };
}

/** A small company world used by the relationship tests. */
async function companyWorld(ctx: TenantContext): Promise<{
  company: string;
  ada: string;
  team: string;
  process: string;
  capability: string;
  market: string;
}> {
  const company = await createEntity(ctx, { kind: 'company', name: 'Acme Manufacturing' });
  const ada = await createEntity(ctx, {
    kind: 'person',
    name: 'Ada Lovelace',
    attributes: { role: 'engineer' },
  });
  const team = await createEntity(ctx, { kind: 'team', name: 'Field Engineering' });
  const process = await createEntity(ctx, {
    kind: 'process',
    name: 'Invoice reconciliation',
    description: 'Monthly close process',
  });
  const capability = await createEntity(ctx, {
    kind: 'capability',
    name: 'French language support',
  });
  const market = await createEntity(ctx, { kind: 'market', name: 'EU industrial tools' });
  return { company: company.id, ada: ada.id, team: team.id, process: process.id, capability: capability.id, market: market.id };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe('entity lifecycle', () => {
  it('persists and returns every recorded attribute unchanged', async () => {
    const ctx = member(tenantA);
    const created = await createEntity(ctx, {
      kind: 'person',
      name: '  Grace Hopper  ',
      description: 'Rear admiral, engineer',
      attributes: { seniority: 'staff', skills: ['compilers', 'naval'], active: true },
      externalRef: { module: 'people', id: 'person-1' },
    });

    expect(created.tenantId).toBe(tenantA);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.kind).toBe('person');
    expect(created.category).toBe('people'); // resolved from the built-in registry
    expect(created.name).toBe('Grace Hopper');
    expect(created.description).toBe('Rear admiral, engineer');
    expect(created.attributes).toEqual({ seniority: 'staff', skills: ['compilers', 'naval'], active: true });
    expect(created.externalRef).toEqual({ module: 'people', id: 'person-1' });
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const read = await getEntity(ctx, created.id);
    expect(read).toEqual(created);
  });

  it('mints identity, tenancy and timestamps itself — smuggled fields are rejected', async () => {
    const ctx = member(tenantA);
    const before = new Date();
    const created = await createEntity(ctx, baseEntity());
    const after = new Date();
    expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(created.createdAt)).toBeLessThanOrEqual(after.getTime());

    for (const smuggled of ['id', 'tenantId', 'createdAt', 'updatedAt', 'category']) {
      await expect(
        createEntity(ctx, { ...baseEntity(), [smuggled]: newId() } as never),
      ).rejects.toMatchObject({ code: 'invalid_entity_input' });
    }
  });

  it('resolves built-in kinds across all five work-item areas', async () => {
    const ctx = member(tenantA);
    const cases: Array<[string, string]> = [
      ['company', 'company'],
      ['team', 'company'],
      ['person', 'people'],
      ['process', 'process'],
      ['capability', 'capability'],
      ['competitor', 'environment'],
    ];
    for (const [kind, category] of cases) {
      const entity = await createEntity(ctx, { kind, name: `${kind} entity` });
      expect(entity.category).toBe(category);
    }
  });

  it('rejects unknown kinds and malformed contexts', async () => {
    const ctx = member(tenantA);
    await expect(createEntity(ctx, { kind: 'waldo', name: 'X' })).rejects.toMatchObject({
      code: 'unknown_entity_kind',
    });
    await expect(
      createEntity({ tenantId: '', principalId: 'p', authority: [] }, baseEntity()),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    await expect(getEntity(ctx, 'not-a-uuid')).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(getEntity(ctx, newId())).rejects.toMatchObject({ code: 'entity_not_found' });
  });

  it('updates name/description/attributes with three-state description and bumped updatedAt', async () => {
    const ctx = member(tenantA);
    const entity = await createEntity(ctx, {
      kind: 'process',
      name: 'Onboarding',
      description: 'old',
      attributes: { steps: 3 },
    });

    const renamed = await updateEntity(ctx, { entityId: entity.id, name: 'Employee onboarding' });
    expect(renamed.name).toBe('Employee onboarding');
    expect(renamed.description).toBe('old'); // untouched
    expect(renamed.attributes).toEqual({ steps: 3 }); // untouched
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(entity.createdAt) - 1);

    const cleared = await updateEntity(ctx, { entityId: entity.id, description: null });
    expect(cleared.description).toBeNull();

    const rewritten = await updateEntity(ctx, {
      entityId: entity.id,
      attributes: { steps: 5, automated: false },
    });
    expect(rewritten.attributes).toEqual({ steps: 5, automated: false });

    await expect(updateEntity(ctx, { entityId: entity.id })).rejects.toMatchObject({
      code: 'invalid_entity_input',
    });
    await expect(updateEntity(ctx, { entityId: newId(), name: 'ghost' })).rejects.toMatchObject({
      code: 'entity_not_found',
    });
  });

  it('lists with kind/category/search/external-ref filters and a limit', async () => {
    const ctx = member(tenantList);
    await createEntity(ctx, { kind: 'person', name: 'Ada Lovelace' });
    await createEntity(ctx, { kind: 'person', name: 'grace hopper' });
    await createEntity(ctx, { kind: 'person', name: 'Nadia Comaneci' });
    await createEntity(ctx, { kind: 'market', name: 'EU industrial tools' });
    await createEntity(ctx, {
      kind: 'employee',
      name: 'Linked Employee',
      externalRef: { module: 'people', id: 'person-42' },
    });

    const people = await listEntities(ctx, { kind: 'person' });
    expect(people.map((e) => e.name).sort()).toEqual(['Ada Lovelace', 'Nadia Comaneci', 'grace hopper']);

    const peopleCategory = await listEntities(ctx, { category: 'people' });
    expect(peopleCategory).toHaveLength(4); // 3 persons + 1 employee

    // case-insensitive substring, sorted by name
    const search = await listEntities(ctx, { search: 'aD' });
    expect(search.map((e) => e.name)).toEqual(['Ada Lovelace', 'Nadia Comaneci']);

    // LIKE metacharacters are literal, never wildcards
    await createEntity(ctx, { kind: 'asset', name: 'mainframe_100%' });
    // '%' literal: the name really contains '100%'
    expect((await listEntities(ctx, { search: '100%' })).map((e) => e.name)).toEqual(['mainframe_100%']);
    // '_' literal: '100_' does not occur (unescaped it would match '100%')
    expect(await listEntities(ctx, { search: '100_' })).toEqual([]);

    const byRef = await listEntities(ctx, { externalModule: 'people', externalId: 'person-42' });
    expect(byRef.map((e) => e.name)).toEqual(['Linked Employee']);

    expect((await listEntities(ctx, { limit: 2 })).length).toBeLessThanOrEqual(2);
    await expect(listEntities(ctx, { limit: 0 })).rejects.toMatchObject({ code: 'invalid_world_query' });
  });

  it('enforces external-ref uniqueness within the tenant but not across tenants', async () => {
    const ref = { module: 'people', id: 'person-7' };
    const ctxA = member(tenantA);
    await createEntity(ctxA, { kind: 'person', name: 'A Person', externalRef: ref });
    await expect(createEntity(ctxA, { kind: 'person', name: 'Another', externalRef: ref })).rejects.toMatchObject({
      code: 'external_ref_in_use',
    });
    // the same authoritative record may have a world entity in EVERY tenant
    const ctxB = member(tenantB);
    await expect(createEntity(ctxB, { kind: 'person', name: 'B Person', externalRef: ref })).resolves.toBeTruthy();
  });

  it('deletes an entity; its relationships are cascade-removed', async () => {
    const ctx = member(tenantRel);
    const world = await companyWorld(ctx);
    await createRelationship(ctx, { type: 'member_of', fromEntityId: world.ada, toEntityId: world.team });
    await createRelationship(ctx, { type: 'employed_by', fromEntityId: world.ada, toEntityId: world.company });

    await deleteEntity(ctx, world.ada);
    await expect(getEntity(ctx, world.ada)).rejects.toMatchObject({ code: 'entity_not_found' });
    expect(await listRelationships(ctx, { entityId: world.ada })).toEqual([]);
    expect(await listRelationships(ctx, { entityId: world.team })).toEqual([]);
    // deletion is idempotent-per-tenant: gone is gone
    await expect(deleteEntity(ctx, world.ada)).rejects.toMatchObject({ code: 'entity_not_found' });
  });
});

// ---------------------------------------------------------------------------
// Extensible vocabulary (custom kinds / relationship types)
// ---------------------------------------------------------------------------

describe('extensible vocabulary', () => {
  it('registers custom entity kinds, uses them, and re-registers idempotently', async () => {
    const ctx = member(tenantA);
    const first = await registerEntityKind(ctx, {
      kind: 'profit_center',
      category: 'company',
      description: 'A P&L unit',
    });
    expect(first).toEqual({ kind: 'profit_center', category: 'company', description: 'A P&L unit', origin: 'registered' });

    const entity = await createEntity(ctx, { kind: 'profit_center', name: 'EMEA Hardware' });
    expect(entity.category).toBe('company');

    const again = await registerEntityKind(ctx, { kind: 'profit_center', category: 'company' });
    expect(again.origin).toBe('registered');
    expect(again.description).toBe('A P&L unit'); // kept from the first registration

    await expect(
      registerEntityKind(ctx, { kind: 'profit_center', category: 'process' }),
    ).rejects.toMatchObject({ code: 'entity_kind_conflict' });
    await expect(registerEntityKind(ctx, { kind: 'person', category: 'people' })).rejects.toMatchObject({
      code: 'entity_kind_reserved',
    });
  });

  it('lists the effective vocabulary (built-ins + customs)', async () => {
    const ctx = member(tenantList);
    await registerEntityKind(ctx, { kind: 'profit_center', category: 'company' });
    const kinds = await listEntityKinds(ctx);
    const byKind = new Map(kinds.map((entry) => [entry.kind, entry]));
    expect(byKind.get('person')).toMatchObject({ category: 'people', origin: 'builtin' });
    expect(byKind.get('profit_center')).toMatchObject({ category: 'company', origin: 'registered' });
    expect(kinds.map((k) => k.kind)).toEqual([...new Set(kinds.map((k) => k.kind))].sort());
  });

  it('registers custom relationship types and lists them', async () => {
    const ctx = member(tenantA);
    await registerRelationshipType(ctx, { type: 'mentored_by', description: 'Subject is mentored by object' });
    const world = await companyWorld(ctx);
    const rel = await createRelationship(ctx, {
      type: 'mentored_by',
      fromEntityId: world.ada,
      toEntityId: world.team,
    });
    expect(rel.type).toBe('mentored_by');

    const types = await listRelationshipTypes(ctx);
    const byType = new Map(types.map((entry) => [entry.type, entry]));
    expect(byType.get('member_of')).toMatchObject({ origin: 'builtin' });
    expect(byType.get('mentored_by')).toMatchObject({ origin: 'registered' });

    await expect(registerRelationshipType(ctx, { type: 'member_of' })).rejects.toMatchObject({
      code: 'relationship_type_reserved',
    });
  });
});

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

describe('relationship lifecycle', () => {
  it('persists a typed directed edge with attributes across the five areas', async () => {
    const ctx = member(tenantRel);
    const world = await companyWorld(ctx);

    const edge = await createRelationship(ctx, {
      type: 'member_of',
      fromEntityId: world.ada,
      toEntityId: world.team,
      attributes: { since: '2026-01-01', share: 0.5 },
    });
    expect(edge.tenantId).toBe(tenantRel);
    expect(edge.type).toBe('member_of');
    expect(edge.fromEntityId).toBe(world.ada);
    expect(edge.toEntityId).toBe(world.team);
    expect(edge.attributes).toEqual({ since: '2026-01-01', share: 0.5 });
    expect(edge.createdAt).toBeTruthy();
    expect(edge.updatedAt).toBeTruthy();

    const read = await getRelationship(ctx, edge.id);
    expect(read).toEqual(edge);

    // process → capability (capabilities area), company → market (environment area)
    const requires = await createRelationship(ctx, {
      type: 'requires',
      fromEntityId: world.process,
      toEntityId: world.capability,
    });
    expect(requires.attributes).toEqual({}); // default
    const operates = await createRelationship(ctx, {
      type: 'operates_in',
      fromEntityId: world.company,
      toEntityId: world.market,
    });
    expect(operates.type).toBe('operates_in');
  });

  it('rejects unknown types, missing endpoints and self-loops', async () => {
    const ctx = member(tenantRel);
    const world = await companyWorld(ctx);
    await expect(
      createRelationship(ctx, { type: 'teleports_to', fromEntityId: world.ada, toEntityId: world.team }),
    ).rejects.toMatchObject({ code: 'unknown_relationship_type' });
    await expect(
      createRelationship(ctx, { type: 'member_of', fromEntityId: world.ada, toEntityId: newId() }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(
      createRelationship(ctx, { type: 'member_of', fromEntityId: world.ada, toEntityId: world.ada }),
    ).rejects.toMatchObject({ code: 'invalid_relationship_input' });
    await expect(
      createRelationship({ tenantId: '', principalId: 'p', authority: [] }, {
        type: 'member_of',
        fromEntityId: world.ada,
        toEntityId: world.team,
      }),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });

  it('allows one typed edge per pair but different types on the same pair', async () => {
    const ctx = member(tenantRel);
    const world = await companyWorld(ctx);
    await createRelationship(ctx, { type: 'member_of', fromEntityId: world.ada, toEntityId: world.team });
    await expect(
      createRelationship(ctx, { type: 'member_of', fromEntityId: world.ada, toEntityId: world.team }),
    ).rejects.toMatchObject({ code: 'duplicate_relationship' });
    await expect(
      createRelationship(ctx, { type: 'works_on', fromEntityId: world.ada, toEntityId: world.team }),
    ).resolves.toBeTruthy();
  });

  it('updates and deletes relationships; attributes are wholesale-replaced', async () => {
    const ctx = member(tenantRel);
    const world = await companyWorld(ctx);
    const edge = await createRelationship(ctx, {
      type: 'member_of',
      fromEntityId: world.ada,
      toEntityId: world.team,
      attributes: { since: '2026-01-01' },
    });

    const updated = await updateRelationship(ctx, {
      relationshipId: edge.id,
      attributes: { since: '2026-02-02', lead: true },
    });
    expect(updated.attributes).toEqual({ since: '2026-02-02', lead: true });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(edge.createdAt) - 1);
    expect((await getRelationship(ctx, edge.id)).attributes).toEqual({ since: '2026-02-02', lead: true });

    await deleteRelationship(ctx, edge.id);
    await expect(getRelationship(ctx, edge.id)).rejects.toMatchObject({ code: 'relationship_not_found' });
    await expect(deleteRelationship(ctx, edge.id)).rejects.toMatchObject({ code: 'relationship_not_found' });
    await expect(updateRelationship(ctx, { relationshipId: newId(), attributes: {} })).rejects.toMatchObject({
      code: 'relationship_not_found',
    });
  });

  it('lists by type, endpoint and adjacency (either direction)', async () => {
    const ctx = member(tenantAdj);
    const world = await companyWorld(ctx);
    const memberEdge = await createRelationship(ctx, {
      type: 'member_of',
      fromEntityId: world.ada,
      toEntityId: world.team,
    });
    const worksEdge = await createRelationship(ctx, {
      type: 'works_on',
      fromEntityId: world.ada,
      toEntityId: world.process,
    });
    await createRelationship(ctx, { type: 'requires', fromEntityId: world.process, toEntityId: world.capability });

    const fromAda = await listRelationships(ctx, { fromEntityId: world.ada });
    expect(new Set(fromAda.map((r) => r.id))).toEqual(new Set([memberEdge.id, worksEdge.id]));

    const toProcess = await listRelationships(ctx, { toEntityId: world.process });
    expect(toProcess.map((r) => r.id)).toEqual([worksEdge.id]);

    // adjacency: ada appears as `from` in two edges and never as `to`
    const adjacentToTeam = await listRelationships(ctx, { entityId: world.team });
    expect(adjacentToTeam.map((r) => r.id)).toEqual([memberEdge.id]);

    const byType = await listRelationships(ctx, { type: 'works_on' });
    expect(byType.map((r) => r.id)).toEqual([worksEdge.id]);

    expect((await listRelationships(ctx, { limit: 1 })).length).toBe(1);
    await expect(
      listRelationships(ctx, { entityId: world.ada, fromEntityId: world.ada }),
    ).rejects.toMatchObject({ code: 'invalid_world_query' });
  });
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE: relationships are tenant-scoped
// ---------------------------------------------------------------------------

describe('tenant scoping (W005 acceptance)', () => {
  it('service level: a cross-tenant endpoint is unrepresentable via the contract', async () => {
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const entityA = await createEntity(ctxA, { kind: 'team', name: 'A Team' });
    const entityB = await createEntity(ctxB, { kind: 'person', name: 'B Person' });

    // A's context cannot use B's entity as an endpoint (either direction) —
    // and the failure is indistinguishable from a missing record (no leak).
    await expect(
      createRelationship(ctxA, { type: 'member_of', fromEntityId: entityA.id, toEntityId: entityB.id }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(
      createRelationship(ctxA, { type: 'member_of', fromEntityId: entityB.id, toEntityId: entityA.id }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    // symmetric for B's context
    await expect(
      createRelationship(ctxB, { type: 'member_of', fromEntityId: entityA.id, toEntityId: entityB.id }),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
  });

  it('service level: entities, relationships and lists never cross tenants', async () => {
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const entityA = await createEntity(ctxA, { kind: 'person', name: 'A Person' });
    const relA = await createRelationship(ctxA, {
      type: 'employed_by',
      fromEntityId: entityA.id,
      toEntityId: (await createEntity(ctxA, { kind: 'company', name: 'A Co' })).id,
    });

    // reads
    await expect(getEntity(ctxB, entityA.id)).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(getRelationship(ctxB, relA.id)).rejects.toMatchObject({ code: 'relationship_not_found' });
    // mutations
    await expect(updateEntity(ctxB, { entityId: entityA.id, name: 'Hijack' })).rejects.toMatchObject({
      code: 'entity_not_found',
    });
    await expect(deleteEntity(ctxB, entityA.id)).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(
      updateRelationship(ctxB, { relationshipId: relA.id, attributes: { evil: true } }),
    ).rejects.toMatchObject({ code: 'relationship_not_found' });
    await expect(deleteRelationship(ctxB, relA.id)).rejects.toMatchObject({ code: 'relationship_not_found' });
    // lists
    expect(await listEntities(ctxB, { search: 'A Person' })).toEqual([]);
    expect(await listEntities(ctxB, {})).not.toContainEqual(expect.objectContaining({ id: entityA.id }));
    expect(await listRelationships(ctxB, { entityId: entityA.id })).toEqual([]);
    expect(await listRelationships(ctxB, { type: 'employed_by' })).toEqual([]);
  });

  it('storage level: a cross-tenant relationship cannot even be INSERTed (composite FKs)', async () => {
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const entityA = await createEntity(ctxA, { kind: 'team', name: 'A Team' });
    const entityB = await createEntity(ctxB, { kind: 'person', name: 'B Person' });

    // bypassing the service entirely: tenant B's tenant_id with A's entity
    await expect(
      getDb().query(
        `INSERT INTO world_relationships (tenant_id, type, from_entity_id, to_entity_id)
           VALUES ($1, 'member_of', $2, $3)`,
        [tenantB, entityA.id, entityB.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // and the mirror: tenant A's tenant_id with B's entity
    await expect(
      getDb().query(
        `INSERT INTO world_relationships (tenant_id, type, from_entity_id, to_entity_id)
           VALUES ($1, 'member_of', $2, $3)`,
        [tenantA, entityA.id, entityB.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // a same-tenant edge DOES insert (the FK is about tenant consistency,
    // not about rejecting legitimate rows)
    const memberA = await createEntity(ctxA, { kind: 'person', name: 'A Member' });
    const ok = await getDb().query(
      `INSERT INTO world_relationships (tenant_id, type, from_entity_id, to_entity_id)
         VALUES ($1, 'member_of', $2, $3) RETURNING id`,
      [tenantA, memberA.id, entityA.id],
    );
    expect(ok.rows).toHaveLength(1);
  });

  it('vocabulary is tenant-scoped: custom kinds/types do not leak across tenants', async () => {
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    await registerEntityKind(ctxA, { kind: 'profit_center', category: 'company' });

    // B cannot use A's custom kind…
    await expect(createEntity(ctxB, { kind: 'profit_center', name: 'B PC' })).rejects.toMatchObject({
      code: 'unknown_entity_kind',
    });
    // …does not see it in its vocabulary…
    expect((await listEntityKinds(ctxB)).find((entry) => entry.kind === 'profit_center')).toBeUndefined();
    // …and may register the SAME name with a DIFFERENT category (independent
    // tenant vocabularies, not a global namespace)
    await expect(
      registerEntityKind(ctxB, { kind: 'profit_center', category: 'process' }),
    ).resolves.toMatchObject({ category: 'process' });

    // same for custom relationship types
    await registerRelationshipType(ctxA, { type: 'mentored_by' });
    const worldB = await companyWorld(ctxB);
    await expect(
      createRelationship(ctxB, { type: 'mentored_by', fromEntityId: worldB.ada, toEntityId: worldB.team }),
    ).rejects.toMatchObject({ code: 'unknown_relationship_type' });
    expect((await listRelationshipTypes(ctxB)).find((entry) => entry.type === 'mentored_by')).toBeUndefined();
  });
});
