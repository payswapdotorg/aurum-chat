// Pure validation/normalization logic of the memory module (no database).
// Everything a caller may put into organizational memory crosses these
// guards first; the SQL CHECK constraints in migrations/001 and /002 mirror
// the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId` or `recordedAt` into a record call — the entry's identity,
// tenancy and commit time are minted by the system (organizational memory
// is append-only; entries cannot be rewritten into something else, and the
// storage-level immutability triggers back this up).
//
// Canonicalization on storage (deterministic rows, mirroring the freshness
// module's provenance discipline): topics and evidence observation ids are
// deduplicated and sorted; entity references are deduplicated and sorted by
// (kind, id, label). Retrieval semantics are unaffected — topic filters are
// any-of, and evidence resolution iterates the id set.
//
// Error codes: the record validators throw the input code of THEIR concept
// (`invalid_knowledge_input` / `invalid_transactive_input`), the list
// validators their query code. The low-level guards are code-parameterized
// so every error a caller can catch carries one of the public codes
// documented in errors.ts — no remapping layers.

import type { TenantContext } from '@/infra/tenant';
import { MemoryError, type MemoryErrorCode } from './errors';
import type {
  KnowledgeEntryKind,
  ListKnowledgeEntriesQuery,
  ListTransactiveEntriesQuery,
  MemoryEntityRef,
  RecordKnowledgeEntryInput,
  RecordTransactiveEntryInput,
  TransactiveActorKind,
  TransactiveRelation,
} from './types';

/** Canonical knowledge-entry classifications (mirrored by the `kind` CHECK constraint). */
export const KNOWLEDGE_ENTRY_KINDS = [
  'fact',
  'procedure',
  'decision',
  'preference',
  'insight',
  'context',
] as const;

/** Canonical transactive-memory actor kinds (mirrored by the `actor_kind` CHECK constraint). */
export const TRANSACTIVE_ACTOR_KINDS = ['person', 'agent', 'team'] as const;

/** ARCHITECTURE.md §7 relation vocabulary (mirrored by the `relation` CHECK constraint). */
export const TRANSACTIVE_RELATIONS = [
  'knows',
  'owns',
  'decides',
  'has_experience_with',
  'influences',
  'can_perform',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_TOPICS = 16;
export const MAX_ENTITIES = 16;
export const MAX_EVIDENCE_OBSERVATIONS = 16;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SUMMARY_LENGTH = 4_000;
export const MAX_NOTES_LENGTH = 2_000;
export const MAX_TEXT_QUERY_LENGTH = 200;
export const MAX_LABEL_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Strict ISO 8601 with an explicit offset — evidence-adjacent timestamps
// are unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const KNOWLEDGE_INPUT_KEYS = [
  'kind',
  'title',
  'summary',
  'topics',
  'entities',
  'evidenceObservationIds',
  'notes',
] as const;
const TRANSACTIVE_INPUT_KEYS = [
  'actor',
  'relation',
  'subjectLabel',
  'topics',
  'entities',
  'evidenceObservationIds',
  'notes',
] as const;
const KNOWLEDGE_QUERY_KEYS = [
  'kind',
  'topics',
  'entityKind',
  'entityId',
  'evidenceObservationId',
  'text',
  'recordedFrom',
  'recordedTo',
  'limit',
] as const;
const TRANSACTIVE_QUERY_KEYS = [
  'topics',
  'relation',
  'actorKind',
  'actorId',
  'evidenceObservationId',
  'text',
  'recordedFrom',
  'recordedTo',
  'limit',
] as const;
const ENTITY_REF_KEYS = ['kind', 'id', 'label'] as const;
const ACTOR_REF_KEYS = ['kind', 'id', 'label'] as const;

export function isKnowledgeEntryKind(value: unknown): value is KnowledgeEntryKind {
  return (
    typeof value === 'string' && (KNOWLEDGE_ENTRY_KINDS as readonly string[]).includes(value)
  );
}

export function isTransactiveActorKind(value: unknown): value is TransactiveActorKind {
  return (
    typeof value === 'string' &&
    (TRANSACTIVE_ACTOR_KINDS as readonly string[]).includes(value)
  );
}

export function isTransactiveRelation(value: unknown): value is TransactiveRelation {
  return (
    typeof value === 'string' && (TRANSACTIVE_RELATIONS as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertMemoryTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new MemoryError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new MemoryError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new MemoryError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** Entry-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Escapes ILIKE pattern metacharacters (`\`, `%`, `_`) so user text is
 * matched literally. Used with an explicit `ESCAPE '\'` clause.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function fail(code: MemoryErrorCode, message: string): never {
  throw new MemoryError(code, message);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  code: MemoryErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      fail(code, `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(value: unknown, field: string, code: MemoryErrorCode): string {
  if (typeof value !== 'string') fail(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') fail(code, `${field} must be a non-empty string`);
  return text;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  code: MemoryErrorCode,
): string {
  const text = requireString(value, field, code);
  if (text.length > maxLength) {
    fail(code, `${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  code: MemoryErrorCode,
): string | null {
  if (value === undefined || value === null) return null;
  return requireBoundedString(value, field, maxLength, code);
}

function requireSlug(value: unknown, field: string, code: MemoryErrorCode): string {
  const text = requireString(value, field, code);
  if (!SLUG_PATTERN.test(text)) {
    fail(code, `${field} must be a lowercase slug matching ${SLUG_PATTERN.source} (got '${text}')`);
  }
  return text;
}

function requireUuid(value: unknown, field: string, code: MemoryErrorCode): string {
  const text = requireString(value, field, code);
  if (!UUID_PATTERN.test(text)) {
    fail(code, `${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIsoInstant(value: unknown, field: string, code: MemoryErrorCode): string {
  const text = requireString(value, field, code);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    fail(
      code,
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

/** Canonical sort key of an entity reference — deterministic storage. */
function entityRefKey(ref: MemoryEntityRef): string {
  return `${ref.kind}\u0000${ref.id ?? ''}\u0000${ref.label ?? ''}`;
}

/**
 * Validates one opaque entity reference: a kind slug plus at least one of
 * an id (uuid, case-normalized) or a human-readable label. The reference is
 * deliberately unverified against the owning module (see types.ts).
 */
function validateEntityRef(
  value: unknown,
  where: string,
  code: MemoryErrorCode,
): MemoryEntityRef {
  if (!isPlainObject(value)) {
    fail(code, `${where} must be an object`);
  }
  rejectUnknownKeys(value, ENTITY_REF_KEYS, where, code);
  const kind = requireSlug(value.kind, `${where}.kind`, code);
  const id =
    value.id === undefined || value.id === null ? null : requireUuid(value.id, `${where}.id`, code);
  const label =
    value.label === undefined || value.label === null
      ? null
      : requireBoundedString(value.label, `${where}.label`, MAX_LABEL_LENGTH, code);
  if (id === null && label === null) {
    fail(code, `${where} must carry an id or a label — an entity reference must be traceable`);
  }
  return { kind, id, label };
}

function validateEntities(value: unknown, code: MemoryErrorCode): MemoryEntityRef[] {
  const entitiesRaw = value === undefined ? [] : value;
  if (!Array.isArray(entitiesRaw)) {
    fail(code, 'entities must be an array of entity references');
  }
  if (entitiesRaw.length > MAX_ENTITIES) {
    fail(code, `entities supports at most ${MAX_ENTITIES} references`);
  }
  const seen = new Set<string>();
  const entities: MemoryEntityRef[] = [];
  for (const [index, ref] of entitiesRaw.entries()) {
    const validated = validateEntityRef(ref, `entities[${index}]`, code);
    const key = entityRefKey(validated);
    if (!seen.has(key)) {
      seen.add(key);
      entities.push(validated);
    }
  }
  entities.sort((a, b) => entityRefKey(a).localeCompare(entityRefKey(b)));
  return entities;
}

/** Topics: 1..MAX_TOPICS lowercase slugs, deduplicated and sorted. */
function validateTopics(value: unknown, code: MemoryErrorCode): string[] {
  if (!Array.isArray(value)) {
    fail(code, 'topics must be an array of lowercase slugs');
  }
  if (value.length === 0) {
    fail(
      code,
      'topics must carry at least one retrieval key — organizational memory must be findable',
    );
  }
  if (value.length > MAX_TOPICS) {
    fail(code, `topics supports at most ${MAX_TOPICS} keys`);
  }
  const topics: string[] = [];
  for (const topic of value) {
    const normalized = requireSlug(topic, 'topics entry', code);
    if (!topics.includes(normalized)) topics.push(normalized);
  }
  topics.sort();
  return topics;
}

/** Evidence ids: 1..MAX_EVIDENCE_OBSERVATIONS uuids, deduplicated and sorted. */
function validateEvidenceObservationIds(value: unknown, code: MemoryErrorCode): string[] {
  if (!Array.isArray(value)) {
    fail(code, 'evidenceObservationIds must be an array of observation uuids');
  }
  if (value.length === 0) {
    fail(
      code,
      'evidenceObservationIds must carry at least one supporting observation — organizational memory is never recorded without evidence',
    );
  }
  if (value.length > MAX_EVIDENCE_OBSERVATIONS) {
    fail(code, `evidenceObservationIds supports at most ${MAX_EVIDENCE_OBSERVATIONS} observations`);
  }
  const ids: string[] = [];
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      fail(code, `evidenceObservationIds[${index}] must be an observation uuid`);
    }
    const normalized = id.toLowerCase();
    if (!ids.includes(normalized)) ids.push(normalized);
  }
  ids.sort();
  return ids;
}

// ---------------------------------------------------------------------------
// Record inputs
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RecordKnowledgeEntryInput`. */
export interface ValidatedKnowledgeInput {
  kind: KnowledgeEntryKind;
  title: string;
  summary: string;
  topics: string[];
  entities: MemoryEntityRef[];
  evidenceObservationIds: string[];
  notes: string | null;
}

/** Fully validated + normalized form of `RecordTransactiveEntryInput`. */
export interface ValidatedTransactiveInput {
  actor: { kind: TransactiveActorKind; id: string | null; label: string | null };
  relation: TransactiveRelation;
  subjectLabel: string;
  topics: string[];
  entities: MemoryEntityRef[];
  evidenceObservationIds: string[];
  notes: string | null;
}

export function validateRecordKnowledgeEntryInput(
  input: RecordKnowledgeEntryInput,
): ValidatedKnowledgeInput {
  const code: MemoryErrorCode = 'invalid_knowledge_input';
  if (!isPlainObject(input)) {
    fail(code, 'knowledge entry input must be an object');
  }
  rejectUnknownKeys(input, KNOWLEDGE_INPUT_KEYS, 'the knowledge entry input', code);
  if (!isKnowledgeEntryKind(input.kind)) {
    fail(code, `kind must be one of ${KNOWLEDGE_ENTRY_KINDS.join(', ')} (got '${String(input.kind)}')`);
  }
  return {
    kind: input.kind,
    title: requireBoundedString(input.title, 'title', MAX_TITLE_LENGTH, code),
    summary: requireBoundedString(input.summary, 'summary', MAX_SUMMARY_LENGTH, code),
    topics: validateTopics(input.topics, code),
    entities: validateEntities(input.entities, code),
    evidenceObservationIds: validateEvidenceObservationIds(input.evidenceObservationIds, code),
    notes: optionalBoundedString(input.notes, 'notes', MAX_NOTES_LENGTH, code),
  };
}

export function validateRecordTransactiveEntryInput(
  input: RecordTransactiveEntryInput,
): ValidatedTransactiveInput {
  const code: MemoryErrorCode = 'invalid_transactive_input';
  if (!isPlainObject(input)) {
    fail(code, 'transactive entry input must be an object');
  }
  rejectUnknownKeys(input, TRANSACTIVE_INPUT_KEYS, 'the transactive entry input', code);

  // --- actor (who the assertion is about) ---
  if (!isPlainObject(input.actor)) {
    fail(code, 'actor must be an object');
  }
  rejectUnknownKeys(input.actor, ACTOR_REF_KEYS, 'actor', code);
  if (!isTransactiveActorKind(input.actor.kind)) {
    fail(
      code,
      `actor.kind must be one of ${TRANSACTIVE_ACTOR_KINDS.join(', ')} (got '${String(input.actor.kind)}')`,
    );
  }
  const actorId =
    input.actor.id === undefined || input.actor.id === null
      ? null
      : requireUuid(input.actor.id, 'actor.id', code);
  const actorLabel =
    input.actor.label === undefined || input.actor.label === null
      ? null
      : requireBoundedString(input.actor.label, 'actor.label', MAX_LABEL_LENGTH, code);
  if (actorId === null && actorLabel === null) {
    fail(
      code,
      'actor must carry an id or a label — the subject of a transactive assertion must be traceable',
    );
  }
  const actor: ValidatedTransactiveInput['actor'] = {
    kind: input.actor.kind,
    id: actorId,
    label: actorLabel,
  };

  if (!isTransactiveRelation(input.relation)) {
    fail(
      code,
      `relation must be one of ${TRANSACTIVE_RELATIONS.join(', ')} (got '${String(input.relation)}')`,
    );
  }

  return {
    actor,
    relation: input.relation,
    subjectLabel: requireBoundedString(input.subjectLabel, 'subjectLabel', MAX_TITLE_LENGTH, code),
    topics: validateTopics(input.topics, code),
    entities: validateEntities(input.entities, code),
    evidenceObservationIds: validateEvidenceObservationIds(input.evidenceObservationIds, code),
    notes: optionalBoundedString(input.notes, 'notes', MAX_NOTES_LENGTH, code),
  };
}

// ---------------------------------------------------------------------------
// List queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ListKnowledgeEntriesQuery`. */
export interface ValidatedKnowledgeListQuery {
  kind: KnowledgeEntryKind | null;
  topics: string[] | null;
  entityKind: string | null;
  entityId: string | null;
  evidenceObservationId: string | null;
  text: string | null;
  recordedFrom: Date | null;
  recordedTo: Date | null;
  limit: number;
}

/** Fully validated + normalized form of `ListTransactiveEntriesQuery`. */
export interface ValidatedTransactiveListQuery {
  topics: string[] | null;
  relation: TransactiveRelation | null;
  actorKind: TransactiveActorKind | null;
  actorId: string | null;
  evidenceObservationId: string | null;
  text: string | null;
  recordedFrom: Date | null;
  recordedTo: Date | null;
  limit: number;
}

/** Query topics: 1..MAX_TOPICS lowercase slugs (any-of semantics), deduplicated. */
function validateQueryTopics(value: unknown, code: MemoryErrorCode): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    fail(code, 'topics must be an array of lowercase slugs');
  }
  if (value.length === 0) {
    fail(code, 'topics must carry at least one key (omit the field to not filter by topic)');
  }
  if (value.length > MAX_TOPICS) {
    fail(code, `topics supports at most ${MAX_TOPICS} keys`);
  }
  const topics: string[] = [];
  for (const topic of value) {
    const normalized = requireSlug(topic, 'topics entry', code);
    if (!topics.includes(normalized)) topics.push(normalized);
  }
  topics.sort();
  return topics;
}

/** Text/recorded-window/limit guards shared by both list queries. */
function validateQueryCommon(
  query: Record<string, unknown>,
  code: MemoryErrorCode,
): {
  text: string | null;
  recordedFrom: Date | null;
  recordedTo: Date | null;
  limit: number;
} {
  const text =
    query.text === undefined
      ? null
      : requireBoundedString(query.text, 'query.text', MAX_TEXT_QUERY_LENGTH, code);
  const recordedFrom =
    query.recordedFrom === undefined
      ? null
      : requireIsoInstant(query.recordedFrom, 'query.recordedFrom', code);
  const recordedTo =
    query.recordedTo === undefined
      ? null
      : requireIsoInstant(query.recordedTo, 'query.recordedTo', code);
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    fail(code, `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }
  if (recordedFrom !== null && recordedTo !== null && recordedFrom > recordedTo) {
    fail(code, 'query.recordedFrom must not be after query.recordedTo');
  }
  return {
    text,
    recordedFrom: recordedFrom === null ? null : new Date(recordedFrom),
    recordedTo: recordedTo === null ? null : new Date(recordedTo),
    limit,
  };
}

export function validateListKnowledgeEntriesQuery(
  query: ListKnowledgeEntriesQuery,
): ValidatedKnowledgeListQuery {
  const code: MemoryErrorCode = 'invalid_knowledge_query';
  if (!isPlainObject(query)) {
    fail(code, 'query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(KNOWLEDGE_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    fail(
      code,
      `unknown query field '${unknown[0]}' (allowed: ${KNOWLEDGE_QUERY_KEYS.join(', ')})`,
    );
  }
  let kind: KnowledgeEntryKind | null = null;
  if (query.kind !== undefined) {
    if (!isKnowledgeEntryKind(query.kind)) {
      fail(
        code,
        `query.kind must be one of ${KNOWLEDGE_ENTRY_KINDS.join(', ')} (got '${String(query.kind)}')`,
      );
    }
    kind = query.kind;
  }
  const topics = validateQueryTopics(query.topics, code);
  const entityKind =
    query.entityKind === undefined ? null : requireSlug(query.entityKind, 'query.entityKind', code);
  const entityId =
    query.entityId === undefined ? null : requireUuid(query.entityId, 'query.entityId', code);
  if (entityKind === null && entityId !== null) {
    fail(
      code,
      'query.entityId requires query.entityKind (an entity reference is meaningless without its kind)',
    );
  }
  const evidenceObservationId =
    query.evidenceObservationId === undefined
      ? null
      : requireUuid(query.evidenceObservationId, 'query.evidenceObservationId', code);
  const common = validateQueryCommon(query, code);
  return { kind, topics, entityKind, entityId, evidenceObservationId, ...common };
}

export function validateListTransactiveEntriesQuery(
  query: ListTransactiveEntriesQuery,
): ValidatedTransactiveListQuery {
  const code: MemoryErrorCode = 'invalid_transactive_query';
  if (!isPlainObject(query)) {
    fail(code, 'query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(TRANSACTIVE_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    fail(
      code,
      `unknown query field '${unknown[0]}' (allowed: ${TRANSACTIVE_QUERY_KEYS.join(', ')})`,
    );
  }
  const topics = validateQueryTopics(query.topics, code);
  let relation: TransactiveRelation | null = null;
  if (query.relation !== undefined) {
    if (!isTransactiveRelation(query.relation)) {
      fail(
        code,
        `query.relation must be one of ${TRANSACTIVE_RELATIONS.join(', ')} (got '${String(query.relation)}')`,
      );
    }
    relation = query.relation;
  }
  let actorKind: TransactiveActorKind | null = null;
  if (query.actorKind !== undefined) {
    if (!isTransactiveActorKind(query.actorKind)) {
      fail(
        code,
        `query.actorKind must be one of ${TRANSACTIVE_ACTOR_KINDS.join(', ')} (got '${String(query.actorKind)}')`,
      );
    }
    actorKind = query.actorKind;
  }
  const actorId =
    query.actorId === undefined ? null : requireUuid(query.actorId, 'query.actorId', code);
  if (actorKind === null && actorId !== null) {
    fail(
      code,
      'query.actorId requires query.actorKind (an actor id is meaningless without its kind)',
    );
  }
  const evidenceObservationId =
    query.evidenceObservationId === undefined
      ? null
      : requireUuid(query.evidenceObservationId, 'query.evidenceObservationId', code);
  const common = validateQueryCommon(query, code);
  return { topics, relation, actorKind, actorId, evidenceObservationId, ...common };
}
