// Pure validation/normalization logic of the world module (no database).
// Everything a caller may put into the world model crosses these guards
// first; the SQL CHECK constraints in migrations/001/002 mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `createdAt` or `updatedAt` into a create call — an entity's
// identity, tenancy and bookkeeping timestamps are minted by the system
// (same discipline as the observations module, W004).

import type { TenantContext } from '@/infra/tenant';
import { ENTITY_KIND_CATEGORIES, isBuiltinEntityKind, isBuiltinRelationshipType } from './kinds';
import { WorldError } from './errors';
import type {
  CreateWorldEntityInput,
  CreateWorldRelationshipInput,
  ListWorldEntitiesQuery,
  ListWorldRelationshipsQuery,
  RegisterEntityKindInput,
  RegisterRelationshipTypeInput,
  UpdateWorldEntityInput,
  UpdateWorldRelationshipInput,
} from './types';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_ATTRIBUTES_BYTES = 262_144; // 256 KiB — attributes are metadata, not content storage
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_EXTERNAL_ID_LENGTH = 128;

/**
 * Custom kind/type names (and the kind half of built-ins): lowercase
 * snake_case, 1..64 chars — stable, URL-safe, collision-resistant enough
 * against the built-in vocabulary.
 */
const KIND_OR_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Module slugs for external references (same shape as observation channels). */
const MODULE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for control characters (incl. DEL) — rejected in names/descriptions. */
function hasControlCharacters(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const CREATE_ENTITY_KEYS = ['kind', 'name', 'description', 'attributes', 'externalRef'] as const;
const UPDATE_ENTITY_KEYS = ['entityId', 'name', 'description', 'attributes'] as const;
const EXTERNAL_REF_KEYS = ['module', 'id'] as const;
const CREATE_RELATIONSHIP_KEYS = ['type', 'fromEntityId', 'toEntityId', 'attributes'] as const;
const UPDATE_RELATIONSHIP_KEYS = ['relationshipId', 'attributes'] as const;
const REGISTER_KIND_KEYS = ['kind', 'category', 'description'] as const;
const REGISTER_TYPE_KEYS = ['type', 'description'] as const;
const LIST_ENTITIES_KEYS = [
  'kind',
  'category',
  'externalModule',
  'externalId',
  'search',
  'limit',
] as const;
const LIST_RELATIONSHIPS_KEYS = ['type', 'fromEntityId', 'toEntityId', 'entityId', 'limit'] as const;

export function isEntityKindCategory(value: unknown): value is (typeof ENTITY_KIND_CATEGORIES)[number] {
  return (
    typeof value === 'string' &&
    (ENTITY_KIND_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertWorldTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new WorldError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new WorldError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new WorldError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  error: (message: string) => WorldError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw error(
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function entityInputError(message: string): WorldError {
  return new WorldError('invalid_entity_input', message);
}

function relationshipInputError(message: string): WorldError {
  return new WorldError('invalid_relationship_input', message);
}

function queryError(message: string): WorldError {
  return new WorldError('invalid_world_query', message);
}

function registrationError(message: string): WorldError {
  return new WorldError('invalid_registration_input', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite numbers,
 * booleans, null, arrays, plain objects) — the same doctrine as observations
 * payloads (W004). Class instances (Date, Map, …), functions, symbols,
 * bigints, undefined and over-deep structures are rejected.
 */
function checkJsonValue(
  value: unknown,
  where: string,
  depth: number,
  error: (message: string) => WorldError,
): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw error(`${where} must be finite (got ${String(value)})`);
    return;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    throw error(`${where} contains a non-JSON value of type ${type}`);
  }
  if (depth > 64) {
    throw error(`${where} exceeds the maximum nesting depth of 64`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkJsonValue(entry, `${where}[${index}]`, depth + 1, error);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw error(`${where} must be a plain JSON value (no class instances)`);
  }
  for (const key of Object.keys(value)) {
    checkJsonValue(value[key], `${where}.${key}`, depth + 1, error);
  }
}

/** Attributes must be a plain JSON object within the size cap. */
function validateAttributes(
  value: unknown,
  where: string,
  error: (message: string) => WorldError,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw error(`${where} must be a plain JSON object`);
  }
  checkJsonValue(value, where, 0, error);
  const serializedLength = JSON.stringify(value)?.length ?? 0;
  if (serializedLength > MAX_ATTRIBUTES_BYTES) {
    throw error(
      `${where} exceeds the maximum of ${MAX_ATTRIBUTES_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }
  return value;
}

function requireString(
  value: unknown,
  field: string,
  max: number,
  error: (message: string) => WorldError = entityInputError,
): string {
  if (typeof value !== 'string') throw error(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw error(`${field} must be a non-empty string`);
  if (text.length > max) {
    throw error(`${field} must be at most ${max} characters (got ${text.length})`);
  }
  if (hasControlCharacters(text)) {
    throw error(`${field} must not contain control characters`);
  }
  return text;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
  error: (message: string) => WorldError = entityInputError,
): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, max, error);
}

function requireUuid(value: unknown, field: string, error: (message: string) => WorldError): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw error(`${field} must be a uuid (got '${String(value)}')`);
  }
  return value.toLowerCase();
}

function requireKindOrTypeName(value: unknown, field: string, error: (message: string) => WorldError): string {
  if (typeof value !== 'string' || !KIND_OR_TYPE_PATTERN.test(value)) {
    throw error(
      `${field} must be a lowercase snake_case name matching ${KIND_OR_TYPE_PATTERN.source} (got '${String(value)}')`,
    );
  }
  return value;
}

/** Fully validated + normalized form of `CreateWorldEntityInput`. */
export interface ValidatedCreateEntityInput {
  kind: string;
  name: string;
  description: string | null;
  attributes: Record<string, unknown>;
  externalRef: { module: string; id: string } | null;
}

export function validateCreateEntityInput(input: CreateWorldEntityInput): ValidatedCreateEntityInput {
  if (!isPlainObject(input)) {
    throw entityInputError('entity input must be an object');
  }
  rejectUnknownKeys(input, CREATE_ENTITY_KEYS, 'the entity input', entityInputError);

  const kind = requireKindOrTypeName(input.kind, 'kind', entityInputError);

  const name = requireString(input.name, 'name', MAX_NAME_LENGTH);

  const description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);

  const attributes = validateAttributes(input.attributes, 'attributes', entityInputError);

  let externalRef: { module: string; id: string } | null = null;
  if (input.externalRef !== undefined && input.externalRef !== null) {
    if (!isPlainObject(input.externalRef)) {
      throw entityInputError('externalRef must be an object');
    }
    rejectUnknownKeys(input.externalRef, EXTERNAL_REF_KEYS, 'externalRef', entityInputError);
    const module = input.externalRef.module;
    if (typeof module !== 'string' || !MODULE_SLUG_PATTERN.test(module)) {
      throw entityInputError(
        `externalRef.module must be a module slug matching ${MODULE_SLUG_PATTERN.source} (got '${String(module)}')`,
      );
    }
    const id = input.externalRef.id;
    if (typeof id !== 'string' || id.trim() === '' || id.length > MAX_EXTERNAL_ID_LENGTH) {
      throw entityInputError(
        `externalRef.id must be a non-empty string of at most ${MAX_EXTERNAL_ID_LENGTH} characters`,
      );
    }
    externalRef = { module, id: id.trim() };
  }

  return { kind, name, description, attributes, externalRef };
}

/**
 * Fully validated + normalized form of `UpdateWorldEntityInput`. The
 * three-state description semantics are explicit: `setDescription` false =
 * leave unchanged, true + null = clear, true + string = replace.
 */
export interface ValidatedUpdateEntityInput {
  entityId: string;
  name: string | null;
  description: string | null;
  setDescription: boolean;
  attributes: Record<string, unknown> | null;
}

export function validateUpdateEntityInput(input: UpdateWorldEntityInput): ValidatedUpdateEntityInput {
  if (!isPlainObject(input)) {
    throw entityInputError('entity update must be an object');
  }
  rejectUnknownKeys(input, UPDATE_ENTITY_KEYS, 'the entity update', entityInputError);

  const entityId = requireUuid(input.entityId, 'entityId', entityInputError);

  let name: string | null = null;
  if (input.name !== undefined) {
    name = requireString(input.name, 'name', MAX_NAME_LENGTH);
  }

  let description: string | null = null;
  let setDescription = false;
  if (input.description !== undefined) {
    setDescription = true;
    description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  }

  let attributes: Record<string, unknown> | null = null;
  if (input.attributes !== undefined) {
    attributes = validateAttributes(input.attributes, 'attributes', entityInputError);
  }

  if (name === null && !setDescription && attributes === null) {
    throw entityInputError('entity update must change at least one of name, description, attributes');
  }

  return { entityId, name, description, setDescription, attributes };
}

/** Fully validated + normalized form of `ListWorldEntitiesQuery`. */
export interface ValidatedListEntitiesQuery {
  kind: string | null;
  category: (typeof ENTITY_KIND_CATEGORIES)[number] | null;
  externalModule: string | null;
  externalId: string | null;
  search: string | null;
  limit: number;
}

export function validateListEntitiesQuery(query: ListWorldEntitiesQuery): ValidatedListEntitiesQuery {
  if (!isPlainObject(query)) {
    throw queryError('entity query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_ENTITIES_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_ENTITIES_KEYS.join(', ')})`,
    );
  }

  const kind =
    query.kind === undefined ? null : requireKindOrTypeName(query.kind, 'query.kind', queryError);

  const category = query.category === undefined ? null : query.category;
  if (category !== null && !isEntityKindCategory(category)) {
    throw queryError(
      `query.category must be one of ${ENTITY_KIND_CATEGORIES.join(', ')} (got '${String(category)}')`,
    );
  }

  const externalModule =
    query.externalModule === undefined || query.externalModule === null
      ? null
      : requireKindOrTypeName(query.externalModule, 'query.externalModule', queryError);
  const externalId =
    query.externalId === undefined || query.externalId === null
      ? null
      : requireString(query.externalId, 'query.externalId', MAX_EXTERNAL_ID_LENGTH, queryError);
  if (externalId !== null && externalModule === null) {
    throw queryError('query.externalId requires query.externalModule (an id is meaningless without its module)');
  }
  if (externalModule !== null && externalId === null) {
    throw queryError('query.externalModule requires query.externalId (a module alone is not a unique reference)');
  }

  const search =
    query.search === undefined || query.search === null
      ? null
      : requireString(query.search, 'query.search', MAX_NAME_LENGTH, queryError);

  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw queryError(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }

  return { kind, category, externalModule, externalId, search, limit };
}

/** Fully validated + normalized form of `CreateWorldRelationshipInput`. */
export interface ValidatedCreateRelationshipInput {
  type: string;
  fromEntityId: string;
  toEntityId: string;
  attributes: Record<string, unknown>;
}

export function validateCreateRelationshipInput(
  input: CreateWorldRelationshipInput,
): ValidatedCreateRelationshipInput {
  if (!isPlainObject(input)) {
    throw relationshipInputError('relationship input must be an object');
  }
  rejectUnknownKeys(input, CREATE_RELATIONSHIP_KEYS, 'the relationship input', relationshipInputError);

  const type = requireKindOrTypeName(input.type, 'type', relationshipInputError);
  const fromEntityId = requireUuid(input.fromEntityId, 'fromEntityId', relationshipInputError);
  const toEntityId = requireUuid(input.toEntityId, 'toEntityId', relationshipInputError);
  if (fromEntityId === toEntityId) {
    throw relationshipInputError('a relationship cannot connect an entity to itself');
  }
  const attributes = validateAttributes(input.attributes, 'attributes', relationshipInputError);

  return { type, fromEntityId, toEntityId, attributes };
}

/** Fully validated + normalized form of `UpdateWorldRelationshipInput`. */
export interface ValidatedUpdateRelationshipInput {
  relationshipId: string;
  attributes: Record<string, unknown>;
}

export function validateUpdateRelationshipInput(
  input: UpdateWorldRelationshipInput,
): ValidatedUpdateRelationshipInput {
  if (!isPlainObject(input)) {
    throw relationshipInputError('relationship update must be an object');
  }
  rejectUnknownKeys(input, UPDATE_RELATIONSHIP_KEYS, 'the relationship update', relationshipInputError);

  const relationshipId = requireUuid(input.relationshipId, 'relationshipId', relationshipInputError);
  const attributes = validateAttributes(input.attributes, 'attributes', relationshipInputError);

  return { relationshipId, attributes };
}

/** Fully validated + normalized form of `ListWorldRelationshipsQuery`. */
export interface ValidatedListRelationshipsQuery {
  type: string | null;
  fromEntityId: string | null;
  toEntityId: string | null;
  entityId: string | null;
  limit: number;
}

export function validateListRelationshipsQuery(
  query: ListWorldRelationshipsQuery,
): ValidatedListRelationshipsQuery {
  if (!isPlainObject(query)) {
    throw queryError('relationship query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_RELATIONSHIPS_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_RELATIONSHIPS_KEYS.join(', ')})`,
    );
  }

  const type =
    query.type === undefined || query.type === null
      ? null
      : requireKindOrTypeName(query.type, 'query.type', queryError);

  const fromEntityId =
    query.fromEntityId === undefined || query.fromEntityId === null
      ? null
      : requireUuid(query.fromEntityId, 'query.fromEntityId', queryError);
  const toEntityId =
    query.toEntityId === undefined || query.toEntityId === null
      ? null
      : requireUuid(query.toEntityId, 'query.toEntityId', queryError);
  const entityId =
    query.entityId === undefined || query.entityId === null
      ? null
      : requireUuid(query.entityId, 'query.entityId', queryError);

  if (entityId !== null && (fromEntityId !== null || toEntityId !== null)) {
    throw queryError(
      'query.entityId (either endpoint) cannot combine with query.fromEntityId/query.toEntityId',
    );
  }

  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw queryError(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }

  return { type, fromEntityId, toEntityId, entityId, limit };
}

/** Fully validated + normalized form of `RegisterEntityKindInput`. */
export interface ValidatedRegisterEntityKindInput {
  kind: string;
  category: (typeof ENTITY_KIND_CATEGORIES)[number];
  description: string | null;
}

export function validateRegisterEntityKindInput(
  input: RegisterEntityKindInput,
): ValidatedRegisterEntityKindInput {
  if (!isPlainObject(input)) {
    throw registrationError('entity kind registration must be an object');
  }
  rejectUnknownKeys(input, REGISTER_KIND_KEYS, 'the entity kind registration', registrationError);

  const kind = requireKindOrTypeName(input.kind, 'kind', registrationError);
  if (isBuiltinEntityKind(kind)) {
    throw new WorldError(
      'entity_kind_reserved',
      `kind '${kind}' is a built-in core kind (ARCHITECTURE.md §4) and cannot be re-registered`,
    );
  }

  if (!isEntityKindCategory(input.category)) {
    throw registrationError(
      `category must be one of ${ENTITY_KIND_CATEGORIES.join(', ')} (got '${String(input.category)}')`,
    );
  }

  const description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  return { kind, category: input.category, description };
}

/** Fully validated + normalized form of `RegisterRelationshipTypeInput`. */
export interface ValidatedRegisterRelationshipTypeInput {
  type: string;
  description: string | null;
}

export function validateRegisterRelationshipTypeInput(
  input: RegisterRelationshipTypeInput,
): ValidatedRegisterRelationshipTypeInput {
  if (!isPlainObject(input)) {
    throw registrationError('relationship type registration must be an object');
  }
  rejectUnknownKeys(input, REGISTER_TYPE_KEYS, 'the relationship type registration', registrationError);

  const type = requireKindOrTypeName(input.type, 'type', registrationError);
  if (isBuiltinRelationshipType(type)) {
    throw new WorldError(
      'relationship_type_reserved',
      `relationship type '${type}' is built-in and cannot be re-registered`,
    );
  }

  const description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  return { type, description };
}

/** Entity/relationship-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Escapes LIKE/ILIKE metacharacters (`%`, `_`, `\`) in caller-supplied
 * search text so `search` is an exact substring, never a wildcard pattern.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
