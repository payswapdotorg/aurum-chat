// Pure validation/normalization logic of the events module (no database).
// Everything a caller may put into an event crosses these guards first;
// the SQL CHECK constraints in migrations/001-events.sql mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `recordedAt`, `sequence` or `envelopeVersion` into an append
// call — the event's identity, tenancy, commit time, position in history
// and envelope shape are minted by the system (part of the W003
// acceptance: the envelope is system-owned, immutable history).

import type { TenantContext } from '@/infra/tenant';
import { EventsError } from './errors';
import type {
  AppendEventInput,
  EventActorKind,
  EventSourceKind,
  ListEventsQuery,
} from './types';

/** Current version of the event envelope shape (stamped on every append). */
export const ENVELOPE_VERSION = 1;

/** Canonical actor kinds (mirrored by the `actor_kind` CHECK constraint). */
export const EVENT_ACTOR_KINDS = ['person', 'agent', 'system', 'external', 'source'] as const;

/** Canonical source kinds (mirrored by the `source_kind` CHECK constraint). */
export const EVENT_SOURCE_KINDS = ['source', 'channel', 'system', 'api', 'external'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB — jsonb payloads stay modest; large artifacts belong to object storage

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
// Strict ISO 8601 with an explicit offset — event timestamps are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const APPEND_INPUT_KEYS = [
  'type',
  'typeVersion',
  'payload',
  'occurredAt',
  'actor',
  'source',
  'correlationId',
  'causationId',
  'idempotencyKey',
] as const;
// The actor and the source share the { kind, id, label } shape.
const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const QUERY_KEYS = [
  'type',
  'typeVersion',
  'actorKind',
  'actorId',
  'sourceKind',
  'sourceId',
  'correlationId',
  'causationId',
  'idempotencyKey',
  'occurredFrom',
  'occurredTo',
  'sequenceFrom',
  'sequenceTo',
  'order',
  'limit',
] as const;

export function isEventActorKind(value: unknown): value is EventActorKind {
  return (
    typeof value === 'string' &&
    (EVENT_ACTOR_KINDS as readonly string[]).includes(value)
  );
}

export function isEventSourceKind(value: unknown): value is EventSourceKind {
  return (
    typeof value === 'string' &&
    (EVENT_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertEventTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new EventsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new EventsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new EventsError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
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
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new EventsError(
        'invalid_event_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(message: string): EventsError {
  return new EventsError('invalid_event_input', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite
 * numbers, booleans, null, arrays, plain objects). Functions, symbols,
 * bigints, undefined, class instances (Date, Map, …) and over-deep
 * structures are rejected, as is anything whose serialized form exceeds
 * MAX_PAYLOAD_BYTES.
 */
function checkJsonValue(value: unknown, where: string, depth: number): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw inputError(`${where} must be finite (got ${String(value)})`);
    return;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    throw inputError(`${where} contains a non-JSON value of type ${type}`);
  }
  if (depth > 64) {
    throw inputError(`${where} exceeds the maximum nesting depth of 64`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkJsonValue(entry, `${where}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw inputError(`${where} must be a plain JSON value (no class instances)`);
  }
  for (const key of Object.keys(value)) {
    checkJsonValue(value[key], `${where}.${key}`, depth + 1);
  }
}

function requireString(value: unknown, field: string, options?: { trim?: boolean }): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = options?.trim === false ? value : value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  return text === '' ? null : text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIsoInstant(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw inputError(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

function requireIdempotencyKey(value: unknown): string {
  const text = requireString(value, 'idempotencyKey');
  if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw inputError(
      `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (got ${text.length})`,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw inputError(
      `idempotencyKey must match ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
}

/**
 * Shared shape guard for the actor and the source: a provider-neutral kind
 * plus an opaque id and/or a human-readable label (at least one —
 * provenance must be traceable).
 */
function validateEventParty<K extends string>(
  party: unknown,
  where: string,
  isKind: (value: unknown) => value is K,
  kindList: readonly string[],
): { kind: K; id: string | null; label: string | null } {
  if (!isPlainObject(party)) {
    throw inputError(`${where} must be an object`);
  }
  rejectUnknownKeys(party, PARTY_KEYS, where);
  const kind = party.kind;
  if (!isKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${kindList.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = optionalTrimmed(party.id, `${where}.id`);
  const label = optionalTrimmed(party.label, `${where}.label`);
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — provenance must be traceable`);
  }
  return { kind, id, label };
}

/** Fully validated + normalized form of `AppendEventInput`. */
export interface ValidatedAppendInput {
  type: string;
  typeVersion: number;
  payload: unknown;
  occurredAt: string;
  actor: { kind: EventActorKind; id: string | null; label: string | null };
  source: { kind: EventSourceKind; id: string | null; label: string | null };
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
}

export function validateAppendEventInput(input: AppendEventInput): ValidatedAppendInput {
  if (!isPlainObject(input)) {
    throw inputError('event input must be an object');
  }
  rejectUnknownKeys(input, APPEND_INPUT_KEYS, 'the event input');

  const type = requireString(input.type, 'type');
  if (!TYPE_PATTERN.test(type)) {
    throw inputError(
      `type must be a canonical classification matching ${TYPE_PATTERN.source} (got '${type}')`,
    );
  }

  const typeVersionRaw = input.typeVersion === undefined || input.typeVersion === null
    ? 1
    : input.typeVersion;
  if (
    typeof typeVersionRaw !== 'number' ||
    !Number.isInteger(typeVersionRaw) ||
    typeVersionRaw < 1
  ) {
    throw inputError(
      `typeVersion must be an integer >= 1 (got ${String(input.typeVersion)})`,
    );
  }

  if (input.payload === undefined || input.payload === null) {
    throw inputError('payload must be a non-null JSON value');
  }
  checkJsonValue(input.payload, 'payload', 0);
  const serializedLength = JSON.stringify(input.payload)?.length ?? 0;
  if (serializedLength > MAX_PAYLOAD_BYTES) {
    throw inputError(
      `payload exceeds the maximum of ${MAX_PAYLOAD_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }

  const occurredAt = requireIsoInstant(input.occurredAt, 'occurredAt');

  // --- provenance: actor (who caused it) + source (how it got here) ---
  const actor = validateEventParty(input.actor, 'actor', isEventActorKind, EVENT_ACTOR_KINDS);
  const source = validateEventParty(input.source, 'source', isEventSourceKind, EVENT_SOURCE_KINDS);

  // --- correlation / causation identities (ARCHITECTURE.md §25) ---
  const correlationId =
    input.correlationId === undefined || input.correlationId === null
      ? null
      : requireUuid(input.correlationId, 'correlationId');
  const causationId =
    input.causationId === undefined || input.causationId === null
      ? null
      : requireUuid(input.causationId, 'causationId');

  // --- idempotency key ---
  const idempotencyKey =
    input.idempotencyKey === undefined || input.idempotencyKey === null
      ? null
      : requireIdempotencyKey(input.idempotencyKey);

  return {
    type,
    typeVersion: typeVersionRaw,
    payload: input.payload,
    occurredAt,
    actor,
    source,
    correlationId,
    causationId,
    idempotencyKey,
  };
}

/** Fully validated + normalized form of `ListEventsQuery`. */
export interface ValidatedListQuery {
  type: string | null;
  typeVersion: number | null;
  actorKind: EventActorKind | null;
  actorId: string | null;
  sourceKind: EventSourceKind | null;
  sourceId: string | null;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  sequenceFrom: number | null;
  sequenceTo: number | null;
  order: 'asc' | 'desc';
  limit: number;
}

export function validateListEventsQuery(query: ListEventsQuery): ValidatedListQuery {
  try {
    return validateListEventsQueryInner(query);
  } catch (error) {
    // The shared string guards throw `invalid_event_input`; for a query
    // the correct code is `invalid_event_query`.
    if (error instanceof EventsError && error.code === 'invalid_event_input') {
      throw new EventsError('invalid_event_query', error.message);
    }
    throw error;
  }
}

function validateListEventsQueryInner(query: ListEventsQuery): ValidatedListQuery {
  if (!isPlainObject(query)) {
    throw new EventsError('invalid_event_query', 'query must be an object');
  }
  const unknown = Object.keys(query).filter((key) => !(QUERY_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new EventsError(
      'invalid_event_query',
      `unknown query field '${unknown[0]}' (allowed: ${QUERY_KEYS.join(', ')})`,
    );
  }
  const type = query.type === undefined ? null : requireString(query.type, 'query.type');
  if (type !== null && !TYPE_PATTERN.test(type)) {
    throw new EventsError(
      'invalid_event_query',
      `query.type must match ${TYPE_PATTERN.source} (got '${type}')`,
    );
  }
  const typeVersion = query.typeVersion === undefined || query.typeVersion === null
    ? null
    : query.typeVersion;
  if (typeVersion !== null && (typeof typeVersion !== 'number' || !Number.isInteger(typeVersion) || typeVersion < 1)) {
    throw new EventsError(
      'invalid_event_query',
      `query.typeVersion must be an integer >= 1 (got ${String(query.typeVersion)})`,
    );
  }
  if (typeVersion !== null && type === null) {
    throw new EventsError(
      'invalid_event_query',
      'query.typeVersion requires query.type (a version is meaningless without its type)',
    );
  }
  const actorKind = query.actorKind === undefined ? null : query.actorKind;
  if (actorKind !== null && !isEventActorKind(actorKind)) {
    throw new EventsError(
      'invalid_event_query',
      `query.actorKind must be one of ${EVENT_ACTOR_KINDS.join(', ')} (got '${String(actorKind)}')`,
    );
  }
  const actorId = query.actorId === undefined ? null : requireString(query.actorId, 'query.actorId');
  if (actorId !== null && actorKind === null) {
    throw new EventsError(
      'invalid_event_query',
      'query.actorId requires query.actorKind (an id is meaningless without its kind)',
    );
  }
  const sourceKind = query.sourceKind === undefined ? null : query.sourceKind;
  if (sourceKind !== null && !isEventSourceKind(sourceKind)) {
    throw new EventsError(
      'invalid_event_query',
      `query.sourceKind must be one of ${EVENT_SOURCE_KINDS.join(', ')} (got '${String(sourceKind)}')`,
    );
  }
  const sourceId = query.sourceId === undefined ? null : requireString(query.sourceId, 'query.sourceId');
  if (sourceId !== null && sourceKind === null) {
    throw new EventsError(
      'invalid_event_query',
      'query.sourceId requires query.sourceKind (an id is meaningless without its kind)',
    );
  }
  const correlationId =
    query.correlationId === undefined || query.correlationId === null
      ? null
      : requireUuid(query.correlationId, 'query.correlationId');
  const causationId =
    query.causationId === undefined || query.causationId === null
      ? null
      : requireUuid(query.causationId, 'query.causationId');
  const idempotencyKey =
    query.idempotencyKey === undefined || query.idempotencyKey === null
      ? null
      : requireIdempotencyKey(query.idempotencyKey);
  const occurredFrom =
    query.occurredFrom === undefined ? null : requireIsoInstant(query.occurredFrom, 'query.occurredFrom');
  const occurredTo =
    query.occurredTo === undefined ? null : requireIsoInstant(query.occurredTo, 'query.occurredTo');
  if (occurredFrom !== null && occurredTo !== null && Date.parse(occurredFrom) > Date.parse(occurredTo)) {
    throw new EventsError(
      'invalid_event_query',
      'query.occurredFrom must not be after query.occurredTo',
    );
  }
  const sequenceFrom = query.sequenceFrom === undefined ? null : query.sequenceFrom;
  if (
    sequenceFrom !== null &&
    (typeof sequenceFrom !== 'number' || !Number.isInteger(sequenceFrom) || sequenceFrom < 1)
  ) {
    throw new EventsError(
      'invalid_event_query',
      `query.sequenceFrom must be an integer >= 1 (got ${String(query.sequenceFrom)})`,
    );
  }
  const sequenceTo = query.sequenceTo === undefined ? null : query.sequenceTo;
  if (
    sequenceTo !== null &&
    (typeof sequenceTo !== 'number' || !Number.isInteger(sequenceTo) || sequenceTo < 1)
  ) {
    throw new EventsError(
      'invalid_event_query',
      `query.sequenceTo must be an integer >= 1 (got ${String(query.sequenceTo)})`,
    );
  }
  if (sequenceFrom !== null && sequenceTo !== null && sequenceFrom > sequenceTo) {
    throw new EventsError(
      'invalid_event_query',
      'query.sequenceFrom must not be after query.sequenceTo',
    );
  }
  const orderRaw = query.order === undefined ? 'asc' : query.order;
  if (orderRaw !== 'asc' && orderRaw !== 'desc') {
    throw new EventsError(
      'invalid_event_query',
      `query.order must be 'asc' or 'desc' (got '${String(query.order)}')`,
    );
  }
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw new EventsError(
      'invalid_event_query',
      `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`,
    );
  }
  return {
    type,
    typeVersion,
    actorKind,
    actorId,
    sourceKind,
    sourceId,
    correlationId,
    causationId,
    idempotencyKey,
    occurredFrom: occurredFrom === null ? null : new Date(occurredFrom),
    occurredTo: occurredTo === null ? null : new Date(occurredTo),
    sequenceFrom,
    sequenceTo,
    order: orderRaw,
    limit,
  };
}

/** Event-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
