// Implementation of the world module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); bookkeeping timestamps (`created_at`/`updated_at`)
// come from the injectable clock and are never caller-supplied; every
// statement is scoped by the explicit TenantContext (ADR-0001) —
// cross-tenant access is indistinguishable from a missing record
// (`entity_not_found` / `relationship_not_found`, no existence leak).
//
// W005 acceptance — "verify relationships are tenant-scoped" — is carried by
// three deliberate properties, all tested:
//   1. the service resolves BOTH endpoints of a relationship within the
//      calling tenant before inserting (a foreign-tenant endpoint is
//      reported as `entity_not_found`, never as "belongs to another tenant");
//   2. PostgreSQL itself enforces endpoint/tenant consistency through the
//      composite (id, tenant_id) foreign keys of world_relationships
//      (migrations/002) — a cross-tenant edge is unrepresentable in SQL,
//      even for a caller that bypasses the service;
//   3. tenant-scoped reads/updates/deletes filter by ctx.tenantId, and the
//      tenant's custom vocabulary (kinds/types) is itself tenant-scoped —
//      one tenant's custom kind is invisible and unusable in another.
//
// The world model is the UNDERSTANDING side of "reality is immutable;
// understanding is mutable" (ARCHITECTURE.md §4): entities and relationships
// are mutable current state. Temporal versioning of that state is W006's
// scope — W005 keeps plain created/updated timestamps.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { WorldError } from './errors';
import {
  BUILTIN_ENTITY_KINDS,
  BUILTIN_RELATIONSHIP_TYPES,
  builtinEntityKindCategory,
  isBuiltinRelationshipType,
  type EntityKindCategory,
} from './kinds';
import {
  assertWorldTenantContext,
  escapeLike,
  isUuid,
  validateCreateEntityInput,
  validateCreateRelationshipInput,
  validateListEntitiesQuery,
  validateListRelationshipsQuery,
  validateRegisterEntityKindInput,
  validateRegisterRelationshipTypeInput,
  validateUpdateEntityInput,
  validateUpdateRelationshipInput,
  type ValidatedCreateEntityInput,
  type ValidatedCreateRelationshipInput,
  type ValidatedRegisterEntityKindInput,
  type ValidatedRegisterRelationshipTypeInput,
  type ValidatedUpdateEntityInput,
} from './validation';
import type {
  CreateWorldEntityInput,
  CreateWorldRelationshipInput,
  EntityKindEntry,
  ListWorldEntitiesQuery,
  ListWorldRelationshipsQuery,
  RegisterEntityKindInput,
  RegisterRelationshipTypeInput,
  RelationshipTypeEntry,
  UpdateWorldEntityInput,
  UpdateWorldRelationshipInput,
  WorldEntity,
  WorldRelationship,
} from './types';

interface EntityRow extends DbRow {
  id: string;
  tenant_id: string;
  kind: string;
  category: string;
  name: string;
  description: string | null;
  attributes: unknown;
  external_module: string | null;
  external_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RelationshipRow extends DbRow {
  id: string;
  tenant_id: string;
  type: string;
  from_entity_id: string;
  to_entity_id: string;
  attributes: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapEntity(row: EntityRow): WorldEntity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    category: row.category as EntityKindCategory, // CHECK-constrained by migration 001
    name: row.name,
    description: row.description,
    attributes: row.attributes,
    externalRef:
      row.external_module === null || row.external_id === null
        ? null
        : { module: row.external_module, id: row.external_id },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapRelationship(row: RelationshipRow): WorldRelationship {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    attributes: row.attributes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505' && candidate?.constraint === constraint;
}

function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23503' && candidate?.constraint === constraint;
}

function entityNotFound(entityId: string): WorldError {
  return new WorldError(
    'entity_not_found',
    `entity '${entityId}' does not exist in this tenant`,
  );
}

function relationshipNotFound(relationshipId: string): WorldError {
  return new WorldError(
    'relationship_not_found',
    `relationship '${relationshipId}' does not exist in this tenant`,
  );
}

/**
 * Category of a kind within the calling tenant's effective vocabulary:
 * built-in core kinds resolve from the code registry, custom kinds from the
 * tenant's registrations; anything else is `unknown_entity_kind`.
 */
async function requireEntityKindCategory(
  db: Queryable,
  ctx: TenantContext,
  kind: string,
): Promise<EntityKindCategory> {
  const builtin = builtinEntityKindCategory(kind);
  if (builtin !== undefined) return builtin;
  const result = await db.query<{ category: string }>(
    `SELECT category FROM world_entity_kinds WHERE tenant_id = $1 AND kind = $2`,
    [ctx.tenantId, kind],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WorldError(
      'unknown_entity_kind',
      `entity kind '${kind}' is neither a built-in core kind nor registered in this tenant`,
    );
  }
  return row.category as EntityKindCategory; // CHECK-constrained by migration 001
}

/**
 * A relationship type must come from the built-in vocabulary or the calling
 * tenant's registrations — one tenant's custom type is not usable in another.
 */
async function requireRelationshipTypeRegistered(
  db: Queryable,
  ctx: TenantContext,
  type: string,
): Promise<void> {
  if (isBuiltinRelationshipType(type)) return;
  const result = await db.query(`SELECT 1 FROM world_relationship_types WHERE tenant_id = $1 AND type = $2`, [
    ctx.tenantId,
    type,
  ]);
  if (result.rows[0] === undefined) {
    throw new WorldError(
      'unknown_relationship_type',
      `relationship type '${type}' is neither a built-in type nor registered in this tenant`,
    );
  }
}

async function loadEntityRow(ctx: TenantContext, entityId: string): Promise<EntityRow> {
  if (!isUuid(entityId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw entityNotFound(entityId);
  }
  const result = await getDb().query<EntityRow>(
    `SELECT * FROM world_entities WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, entityId],
  );
  const row = result.rows[0];
  if (row === undefined) throw entityNotFound(entityId);
  return row;
}

// ===========================================================================
// Entities
// ===========================================================================

export async function createEntity(
  ctx: TenantContext,
  input: CreateWorldEntityInput,
): Promise<WorldEntity> {
  assertWorldTenantContext(ctx);
  const valid: ValidatedCreateEntityInput = validateCreateEntityInput(input);
  const db = getDb();
  const category = await requireEntityKindCategory(db, ctx, valid.kind);
  const at = now();
  try {
    const result = await db.query<EntityRow>(
      `INSERT INTO world_entities (
         tenant_id, kind, category, name, description, attributes,
         external_module, external_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
      [
        ctx.tenantId,
        valid.kind,
        category,
        valid.name,
        valid.description,
        JSON.stringify(valid.attributes),
        valid.externalRef?.module ?? null,
        valid.externalRef?.id ?? null,
        at,
      ],
    );
    return mapEntity(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error, 'world_entities_external_ref_unique')) {
      throw new WorldError(
        'external_ref_in_use',
        `an entity of this tenant already references '${valid.externalRef!.module}:${valid.externalRef!.id}'`,
      );
    }
    throw error;
  }
}

export async function getEntity(ctx: TenantContext, entityId: string): Promise<WorldEntity> {
  assertWorldTenantContext(ctx);
  return mapEntity(await loadEntityRow(ctx, entityId));
}

export async function updateEntity(
  ctx: TenantContext,
  input: UpdateWorldEntityInput,
): Promise<WorldEntity> {
  assertWorldTenantContext(ctx);
  const valid: ValidatedUpdateEntityInput = validateUpdateEntityInput(input);
  if (!isUuid(valid.entityId)) throw entityNotFound(valid.entityId);

  const assignments: string[] = [];
  const values: unknown[] = [];
  if (valid.name !== null) {
    values.push(valid.name);
    assignments.push(`name = $${values.length}`);
  }
  if (valid.setDescription) {
    values.push(valid.description);
    assignments.push(`description = $${values.length}`);
  }
  if (valid.attributes !== null) {
    values.push(JSON.stringify(valid.attributes));
    assignments.push(`attributes = $${values.length}`);
  }
  const updatedAt = now();
  values.push(updatedAt);
  assignments.push(`updated_at = $${values.length}`);
  values.push(ctx.tenantId, valid.entityId);
  const tenantPlaceholder = `$${values.length - 1}`;
  const idPlaceholder = `$${values.length}`;

  const result = await getDb().query<EntityRow>(
    `UPDATE world_entities SET ${assignments.join(', ')}
       WHERE tenant_id = ${tenantPlaceholder} AND id = ${idPlaceholder} RETURNING *`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) throw entityNotFound(valid.entityId);
  return mapEntity(row);
}

export async function deleteEntity(ctx: TenantContext, entityId: string): Promise<void> {
  assertWorldTenantContext(ctx);
  if (!isUuid(entityId)) throw entityNotFound(entityId);
  // Relationships of a deleted entity are removed by the storage layer
  // (world_relationships_from/to_fk ON DELETE CASCADE) — inside the same
  // statement's transaction, so an entity never outlives its edges.
  const result = await getDb().query(
    `DELETE FROM world_entities WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, entityId],
  );
  if (result.rowCount !== 1) throw entityNotFound(entityId);
}

export async function listEntities(
  ctx: TenantContext,
  query: ListWorldEntitiesQuery,
): Promise<WorldEntity[]> {
  assertWorldTenantContext(ctx);
  const valid = validateListEntitiesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace(/\$#/g, `$${params.length}`));
  };

  if (valid.kind !== null) add('kind = $#', valid.kind);
  if (valid.category !== null) add('category = $#', valid.category);
  if (valid.externalModule !== null) {
    add('external_module = $#', valid.externalModule);
    add('external_id = $#', valid.externalId);
  }
  if (valid.search !== null) {
    // escaped substring match — caller text is never a wildcard pattern
    add(`name ILIKE '%' || $# || '%' ESCAPE '\\'`, escapeLike(valid.search));
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<EntityRow>(
    `SELECT * FROM world_entities WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC, id ASC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapEntity);
}

// ===========================================================================
// Relationships
// ===========================================================================

export async function createRelationship(
  ctx: TenantContext,
  input: CreateWorldRelationshipInput,
): Promise<WorldRelationship> {
  assertWorldTenantContext(ctx);
  const valid: ValidatedCreateRelationshipInput = validateCreateRelationshipInput(input);
  const db = getDb();
  await requireRelationshipTypeRegistered(db, ctx, valid.type);

  // Both endpoints must resolve within the CALLING tenant — a foreign-tenant
  // endpoint is indistinguishable from a missing one (no existence leak),
  // and the composite FKs of world_relationships backstop this at the
  // storage layer regardless.
  const endpoints = await db.query<{ id: string }>(
    `SELECT id FROM world_entities WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [ctx.tenantId, [valid.fromEntityId, valid.toEntityId]],
  );
  const found = new Set(endpoints.rows.map((row) => row.id));
  for (const endpointId of [valid.fromEntityId, valid.toEntityId]) {
    if (!found.has(endpointId)) throw entityNotFound(endpointId);
  }

  const at = now();
  try {
    const result = await db.query<RelationshipRow>(
      `INSERT INTO world_relationships (
         tenant_id, type, from_entity_id, to_entity_id, attributes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
      [
        ctx.tenantId,
        valid.type,
        valid.fromEntityId,
        valid.toEntityId,
        JSON.stringify(valid.attributes),
        at,
      ],
    );
    return mapRelationship(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error, 'world_relationships_pair_type_unique')) {
      throw new WorldError(
        'duplicate_relationship',
        `a '${valid.type}' relationship from '${valid.fromEntityId}' to '${valid.toEntityId}' already exists in this tenant`,
      );
    }
    if (
      isForeignKeyViolation(error, 'world_relationships_from_fk') ||
      isForeignKeyViolation(error, 'world_relationships_to_fk')
    ) {
      // Endpoint vanished between the check and the insert (concurrent delete).
      throw new WorldError(
        'entity_not_found',
        'a relationship endpoint does not exist in this tenant',
      );
    }
    throw error;
  }
}

export async function getRelationship(
  ctx: TenantContext,
  relationshipId: string,
): Promise<WorldRelationship> {
  assertWorldTenantContext(ctx);
  if (!isUuid(relationshipId)) throw relationshipNotFound(relationshipId);
  const result = await getDb().query<RelationshipRow>(
    `SELECT * FROM world_relationships WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, relationshipId],
  );
  const row = result.rows[0];
  if (row === undefined) throw relationshipNotFound(relationshipId);
  return mapRelationship(row);
}

export async function updateRelationship(
  ctx: TenantContext,
  input: UpdateWorldRelationshipInput,
): Promise<WorldRelationship> {
  assertWorldTenantContext(ctx);
  const valid = validateUpdateRelationshipInput(input);
  if (!isUuid(valid.relationshipId)) throw relationshipNotFound(valid.relationshipId);
  const result = await getDb().query<RelationshipRow>(
    `UPDATE world_relationships SET attributes = $1, updated_at = $2
       WHERE tenant_id = $3 AND id = $4 RETURNING *`,
    [JSON.stringify(valid.attributes), now(), ctx.tenantId, valid.relationshipId],
  );
  const row = result.rows[0];
  if (row === undefined) throw relationshipNotFound(valid.relationshipId);
  return mapRelationship(row);
}

export async function deleteRelationship(
  ctx: TenantContext,
  relationshipId: string,
): Promise<void> {
  assertWorldTenantContext(ctx);
  if (!isUuid(relationshipId)) throw relationshipNotFound(relationshipId);
  const result = await getDb().query(
    `DELETE FROM world_relationships WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, relationshipId],
  );
  if (result.rowCount !== 1) throw relationshipNotFound(relationshipId);
}

export async function listRelationships(
  ctx: TenantContext,
  query: ListWorldRelationshipsQuery,
): Promise<WorldRelationship[]> {
  assertWorldTenantContext(ctx);
  const valid = validateListRelationshipsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace(/\$#/g, `$${params.length}`));
  };

  if (valid.type !== null) add('type = $#', valid.type);
  if (valid.entityId !== null) {
    // adjacency: the entity at EITHER endpoint
    add('(from_entity_id = $# OR to_entity_id = $#)', valid.entityId);
  } else {
    if (valid.fromEntityId !== null) add('from_entity_id = $#', valid.fromEntityId);
    if (valid.toEntityId !== null) add('to_entity_id = $#', valid.toEntityId);
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<RelationshipRow>(
    `SELECT * FROM world_relationships WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapRelationship);
}

// ===========================================================================
// Extensible vocabulary (tenant-scoped registrations)
// ===========================================================================

export async function registerEntityKind(
  ctx: TenantContext,
  input: RegisterEntityKindInput,
): Promise<EntityKindEntry> {
  assertWorldTenantContext(ctx);
  const valid: ValidatedRegisterEntityKindInput = validateRegisterEntityKindInput(input);
  const db = getDb();
  const at = now();

  return db.transaction(async (tx) => {
    // Idempotent re-registration: same kind + same category is a no-op (the
    // description is refreshed when supplied); a DIFFERENT category is a
    // conflict — a kind never silently changes meaning mid-world-model.
    const existing = await tx.query<{ category: string; description: string | null }>(
      `SELECT category, description FROM world_entity_kinds WHERE tenant_id = $1 AND kind = $2 FOR UPDATE`,
      [ctx.tenantId, valid.kind],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.category !== valid.category) {
        throw new WorldError(
          'entity_kind_conflict',
          `custom kind '${valid.kind}' is already registered in this tenant with category '${row.category}' (requested '${valid.category}')`,
        );
      }
      if (valid.description !== null) {
        await tx.query(
          `UPDATE world_entity_kinds SET description = $1, updated_at = $2 WHERE tenant_id = $3 AND kind = $4`,
          [valid.description, at, ctx.tenantId, valid.kind],
        );
      }
      return {
        kind: valid.kind,
        category: valid.category,
        description: valid.description ?? row.description,
        origin: 'registered',
      };
    }
    await tx.query(
      `INSERT INTO world_entity_kinds (tenant_id, kind, category, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
      [ctx.tenantId, valid.kind, valid.category, valid.description, at],
    );
    return {
      kind: valid.kind,
      category: valid.category,
      description: valid.description,
      origin: 'registered',
    };
  });
}

export async function listEntityKinds(ctx: TenantContext): Promise<EntityKindEntry[]> {
  assertWorldTenantContext(ctx);
  const customs = await getDb().query<{ kind: string; category: string; description: string | null }>(
    `SELECT kind, category, description FROM world_entity_kinds WHERE tenant_id = $1 ORDER BY kind`,
    [ctx.tenantId],
  );
  const byKind = new Map<string, EntityKindEntry>();
  for (const builtin of BUILTIN_ENTITY_KINDS) {
    byKind.set(builtin.kind, {
      kind: builtin.kind,
      category: builtin.category,
      description: builtin.description,
      origin: 'builtin',
    });
  }
  for (const row of customs.rows) {
    // disjoint from built-ins by construction (registerEntityKind rejects
    // built-in names with `entity_kind_reserved`)
    byKind.set(row.kind, {
      kind: row.kind,
      category: row.category as EntityKindCategory,
      description: row.description,
      origin: 'registered',
    });
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export async function registerRelationshipType(
  ctx: TenantContext,
  input: RegisterRelationshipTypeInput,
): Promise<RelationshipTypeEntry> {
  assertWorldTenantContext(ctx);
  const valid: ValidatedRegisterRelationshipTypeInput = validateRegisterRelationshipTypeInput(input);
  const db = getDb();
  const at = now();

  return db.transaction(async (tx) => {
    // Idempotent re-registration: refreshes the description when supplied.
    const existing = await tx.query<{ description: string | null }>(
      `SELECT description FROM world_relationship_types WHERE tenant_id = $1 AND type = $2 FOR UPDATE`,
      [ctx.tenantId, valid.type],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      if (valid.description !== null) {
        await tx.query(
          `UPDATE world_relationship_types SET description = $1, updated_at = $2 WHERE tenant_id = $3 AND type = $4`,
          [valid.description, at, ctx.tenantId, valid.type],
        );
      }
      return { type: valid.type, description: valid.description ?? row.description, origin: 'registered' };
    }
    await tx.query(
      `INSERT INTO world_relationship_types (tenant_id, type, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
      [ctx.tenantId, valid.type, valid.description, at],
    );
    return { type: valid.type, description: valid.description, origin: 'registered' };
  });
}

export async function listRelationshipTypes(ctx: TenantContext): Promise<RelationshipTypeEntry[]> {
  assertWorldTenantContext(ctx);
  const customs = await getDb().query<{ type: string; description: string | null }>(
    `SELECT type, description FROM world_relationship_types WHERE tenant_id = $1 ORDER BY type`,
    [ctx.tenantId],
  );
  const byType = new Map<string, RelationshipTypeEntry>();
  for (const builtin of BUILTIN_RELATIONSHIP_TYPES) {
    byType.set(builtin.type, {
      type: builtin.type,
      description: builtin.description,
      origin: 'builtin',
    });
  }
  for (const row of customs.rows) {
    byType.set(row.type, { type: row.type, description: row.description, origin: 'registered' });
  }
  return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
}
