// ============================================================================
// world — the ONLY public surface of the world module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W005 — World Model (spec/work-items/WORK-ITEM-CATALOG.md):
// "Implement extensible entities/relationships for company, people,
//  processes, capabilities and environment. Verify relationships are
//  tenant-scoped."
//
//   Entities
//     createEntity / getEntity / updateEntity / deleteEntity / listEntities
//        — the tenant's mutable current picture of one thing in the world
//        (company, person, team, process, capability, market, …), classified
//        by an entity kind from the built-in core vocabulary
//        (ARCHITECTURE.md §4) or a tenant-registered custom kind, with
//        free-form attributes and an optional binding to the authoritative
//        record of the module owning the underlying thing (externalRef).
//   Relationships
//     createRelationship / getRelationship / updateRelationship /
//     deleteRelationship / listRelationships
//        — directed typed edges between two entities of the SAME tenant
//        (person -member_of→ team, process -requires→ capability,
//        company -operates_in→ market) with their own attributes.
//   Extensible vocabulary
//     registerEntityKind / listEntityKinds
//     registerRelationshipType / listRelationshipTypes
//        — tenants extend their own world vocabulary at runtime; custom
//        kinds/types are tenant-scoped rows, invisible to other tenants.
//
// Tenant scoping (ADR-0001) — the W005 acceptance — is enforced twice:
//   * service level: every operation takes an explicit TenantContext and
//     resolves entities/relationships within ctx.tenantId only; a
//     foreign-tenant endpoint or id is reported as `entity_not_found` /
//     `relationship_not_found` (no existence leak), and one tenant's custom
//     kind/type is unusable in another tenant;
//   * storage level: world_relationships' endpoint foreign keys reference
//     the composite (id, tenant_id) of world_entities, so a cross-tenant
//     relationship is unrepresentable in SQL even for a caller that bypasses
//     the service entirely (migrations/002).
//
// The world model is the UNDERSTANDING side of ARCHITECTURE.md §4 ("reality
// is immutable; understanding is mutable"): entities/relationships are
// mutable current state. Immutable evidence is observations' (W004)
// territory; temporal versioning of this state is W006's.
// ============================================================================

export {
  createEntity,
  deleteEntity,
  getEntity,
  listEntities,
  listEntityKinds,
  listRelationshipTypes,
  registerEntityKind,
  registerRelationshipType,
  updateEntity,
} from './service';

export {
  createRelationship,
  deleteRelationship,
  getRelationship,
  listRelationships,
  updateRelationship,
} from './service';

export { WorldError } from './errors';
export type { WorldErrorCode } from './errors';

export {
  BUILTIN_ENTITY_KINDS,
  BUILTIN_RELATIONSHIP_TYPES,
  ENTITY_KIND_CATEGORIES,
  builtinEntityKindCategory,
  builtinEntityKindDescription,
  builtinRelationshipTypeDescription,
  isBuiltinEntityKind,
  isBuiltinRelationshipType,
} from './kinds';
export type {
  BuiltinEntityKind,
  BuiltinRelationshipType,
  EntityKindCategory,
} from './kinds';

export {
  DEFAULT_LIST_LIMIT,
  MAX_ATTRIBUTES_BYTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXTERNAL_ID_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NAME_LENGTH,
  isEntityKindCategory,
  isUuid,
} from './validation';

export type {
  ValidatedCreateEntityInput,
  ValidatedCreateRelationshipInput,
  ValidatedListEntitiesQuery,
  ValidatedListRelationshipsQuery,
  ValidatedRegisterEntityKindInput,
  ValidatedRegisterRelationshipTypeInput,
  ValidatedUpdateEntityInput,
  ValidatedUpdateRelationshipInput,
} from './validation';

export type {
  CreateWorldEntityInput,
  CreateWorldRelationshipInput,
  EntityExternalRef,
  EntityKindEntry,
  ListWorldEntitiesQuery,
  ListWorldRelationshipsQuery,
  RegisterEntityKindInput,
  RegisterRelationshipTypeInput,
  RelationshipTypeEntry,
  UpdateWorldEntityInput,
  UpdateWorldRelationshipInput,
  VocabularyOrigin,
  WorldEntity,
  WorldRelationship,
} from './types';
