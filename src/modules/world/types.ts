// Public domain types of the world module (W005 — World Model).
//
// The world model represents internal and external reality through
// EXTENSIBLE entities and relationships (ARCHITECTURE.md §4). This module
// owns the tenant's working picture of reality:
//
//   * WorldEntity   — one thing in the world: a company, person, team,
//                     process, capability, market, … classified by a kind
//                     from the built-in core vocabulary or a tenant-
//                     registered custom kind, carrying a name, free-form
//                     JSON attributes and an optional reference to the
//                     authoritative record of the module that owns the
//                     underlying thing (e.g. a people.persons row).
//   * WorldRelationship — one directed, typed edge between two entities
//                     (person -member_of→ team, process -requires→
//                     capability, company -operates_in→ market), carrying
//                     its own attributes.
//
// Reality is immutable; understanding is mutable (ARCHITECTURE.md §4) —
// the world model IS the understanding side: entities and relationships are
// current working state (create/update/delete), not immutable evidence.
// Events (W003) and observations (W004) are the immutable reality side;
// temporal versioning of this mutable state is W006's scope, so W005 keeps
// plain created/updated timestamps only.
//
// The vocabulary is two-layered: the frozen built-in kinds/types of kinds.ts
// (every tenant, code-defined) plus tenant-registered customs
// (world_entity_kinds / world_relationship_types rows) — that registry is
// the "extensible" of the work item. Entities/relationships are tenant-
// scoped (ADR-0001): a relationship's two endpoints can never live in
// different tenants (enforced by composite foreign keys, not just service
// discipline — see migrations/002).

import type { EntityKindCategory } from './kinds';

/**
 * Opaque reference from a world entity to the authoritative record of the
 * module that owns the underlying thing, e.g. `{ module: 'people', id:
 * <persons.id> }`. Mirrors the provenance-reference approach of the
 * observations module (W004): `module` is a neutral module slug, `id` is that
 * module's record id; both are deliberately unverified here — no
 * cross-module foreign keys are possible (MODULE-DEPENDENCY-MAP.md), and the
 * referenced module (people, organizations, goals, …) stays the owner of its
 * records. At most one entity per tenant may reference a given
 * (module, id) pair, so the world model never forks its picture of one
 * authoritative record.
 */
export interface EntityExternalRef {
  /** Owning module's slug, e.g. 'people', 'organizations'. */
  module: string;
  /** The referenced record's id within that module (opaque). */
  id: string;
}

/** One entity of the tenant's world model. */
export interface WorldEntity {
  id: string;
  tenantId: string;
  /** Built-in core kind or a tenant-registered custom kind. */
  kind: string;
  /** Coarse category of the kind, denormalized for filtered listing. */
  category: EntityKindCategory;
  name: string;
  description: string | null;
  /** Free-form JSON attributes (plain-JSON-checked, size-capped). */
  attributes: unknown;
  /** Binding to the authoritative record of another module, if any. */
  externalRef: EntityExternalRef | null;
  /** ISO 8601 — service-clock-set. */
  createdAt: string;
  /** ISO 8601 — service-clock-set. */
  updatedAt: string;
}

/** One directed, typed relationship between two entities of one tenant. */
export interface WorldRelationship {
  id: string;
  tenantId: string;
  /** Built-in core type or a tenant-registered custom type. */
  type: string;
  /** Subject endpoint (the entity the edge starts from). */
  fromEntityId: string;
  /** Object endpoint (the entity the edge points to). */
  toEntityId: string;
  /** Free-form JSON attributes (plain-JSON-checked, size-capped). */
  attributes: unknown;
  /** ISO 8601 — service-clock-set. */
  createdAt: string;
  /** ISO 8601 — service-clock-set. */
  updatedAt: string;
}

/** Where a vocabulary entry comes from. */
export type VocabularyOrigin = 'builtin' | 'registered';

/** One entry of a tenant's effective entity-kind vocabulary. */
export interface EntityKindEntry {
  kind: string;
  category: EntityKindCategory;
  description: string | null;
  origin: VocabularyOrigin;
}

/** One entry of a tenant's effective relationship-type vocabulary. */
export interface RelationshipTypeEntry {
  type: string;
  description: string | null;
  origin: VocabularyOrigin;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateWorldEntityInput {
  kind: string;
  name: string;
  description?: string | null;
  /** Defaults to `{}`. Must be a plain JSON object. */
  attributes?: unknown;
  externalRef?: EntityExternalRef | null;
}

export interface UpdateWorldEntityInput {
  entityId: string;
  /** New name; omit to leave unchanged. */
  name?: string;
  /** New description; `null` clears it; omit to leave unchanged. */
  description?: string | null;
  /** Replacement attributes (wholesale); omit to leave unchanged. */
  attributes?: unknown;
}

export interface ListWorldEntitiesQuery {
  kind?: string;
  category?: EntityKindCategory;
  /** Requires `externalId` — a module alone is not a unique reference. */
  externalModule?: string;
  externalId?: string;
  /** Case-insensitive substring on the entity name. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface CreateWorldRelationshipInput {
  type: string;
  fromEntityId: string;
  toEntityId: string;
  /** Defaults to `{}`. Must be a plain JSON object. */
  attributes?: unknown;
}

export interface UpdateWorldRelationshipInput {
  relationshipId: string;
  /** Replacement attributes (wholesale, required). Must be a plain JSON object. */
  attributes: unknown;
}

export interface ListWorldRelationshipsQuery {
  type?: string;
  fromEntityId?: string;
  toEntityId?: string;
  /**
   * Adjacency filter: relationships where the entity is EITHER endpoint.
   * Cannot combine with `fromEntityId`/`toEntityId`.
   */
  entityId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface RegisterEntityKindInput {
  kind: string;
  category: EntityKindCategory;
  description?: string | null;
}

export interface RegisterRelationshipTypeInput {
  type: string;
  description?: string | null;
}
