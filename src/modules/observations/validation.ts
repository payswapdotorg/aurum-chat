// Pure validation/normalization logic of the observations module (no
// database). Everything a caller may put into an observation crosses these
// guards first; the SQL CHECK constraints in migrations/001-observations.sql
// mirror the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId` or `recordedAt` into a record call — the observation's
// identity, tenancy and commit time are minted by the system (part of the
// "observation cannot be mutated into authoritative truth" acceptance).

import type { TenantContext } from '@/infra/tenant';
import { ObservationsError } from './errors';
import type {
  LineageMethod,
  ListObservationsQuery,
  ObservationSourceKind,
  ObservationVisibility,
  RecordObservationInput,
} from './types';

/** Canonical origin kinds (mirrored by the `source_kind` CHECK constraint). */
export const OBSERVATION_SOURCE_KINDS = [
  'source',
  'person',
  'agent',
  'system',
  'external',
] as const;

/** Canonical lineage methods (mirrored by the `lineage_method` CHECK constraint). */
export const LINEAGE_METHODS = [
  'direct',
  'connector',
  'extraction',
  'transformation',
  'inference',
] as const;

/** Canonical visibility scopes (mirrored by the `visibility` CHECK constraint). */
export const OBSERVATION_VISIBILITIES = ['tenant', 'workspace', 'principal'] as const;

/** Lineage methods that derive content from parent observations. */
export const DERIVING_LINEAGE_METHODS: readonly LineageMethod[] = [
  'extraction',
  'transformation',
  'inference',
];

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_LINEAGE_PARENTS = 16;
export const MAX_USAGE_TAGS = 16;
export const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB — jsonb payloads stay modest; large artifacts belong to object storage

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Strict ISO 8601 with an explicit offset — evidence timestamps are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const RECORD_INPUT_KEYS = [
  'kind',
  'payload',
  'observedAt',
  'source',
  'channel',
  'lineage',
  'permissions',
  'confidence',
] as const;
const SOURCE_KEYS = ['kind', 'id', 'label'] as const;
const LINEAGE_KEYS = ['method', 'parents', 'extractor'] as const;
const EXTRACTOR_KEYS = ['provider', 'model', 'notes'] as const;
const PERMISSIONS_KEYS = ['visibility', 'workspaceId', 'principalId', 'usage'] as const;
const CONFIDENCE_KEYS = ['value', 'method', 'basis'] as const;
const QUERY_KEYS = [
  'kind',
  'channel',
  'sourceKind',
  'sourceId',
  'observedFrom',
  'observedTo',
  'limit',
] as const;

export function isObservationSourceKind(value: unknown): value is ObservationSourceKind {
  return (
    typeof value === 'string' &&
    (OBSERVATION_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isLineageMethod(value: unknown): value is LineageMethod {
  return typeof value === 'string' && (LINEAGE_METHODS as readonly string[]).includes(value);
}

export function isObservationVisibility(value: unknown): value is ObservationVisibility {
  return (
    typeof value === 'string' &&
    (OBSERVATION_VISIBILITIES as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertObservationTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ObservationsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ObservationsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ObservationsError(
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
      throw new ObservationsError(
        'invalid_observation_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(message: string): ObservationsError {
  return new ObservationsError('invalid_observation_input', message);
}

function lineageError(message: string): ObservationsError {
  return new ObservationsError('invalid_lineage', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite numbers,
 * booleans, null, arrays, plain objects). Functions, symbols, bigints,
 * undefined, class instances (Date, Map, …) and over-deep structures are
 * rejected, as is anything whose serialized form exceeds MAX_PAYLOAD_BYTES.
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

function requireSlug(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!SLUG_PATTERN.test(text)) {
    throw inputError(
      `${field} must be a lowercase slug matching ${SLUG_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
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

/** Fully validated + normalized form of `RecordObservationInput`. */
export interface ValidatedObservationInput {
  kind: string;
  payload: unknown;
  observedAt: string;
  source: { kind: ObservationSourceKind; id: string | null; label: string | null };
  channel: string;
  lineage: {
    method: LineageMethod;
    parents: string[];
    extractor: { provider: string; model: string; notes: string | null } | null;
  };
  permissions: {
    visibility: ObservationVisibility;
    workspaceId: string | null;
    principalId: string | null;
    usage: string[];
  };
  confidence: { value: number; method: string; basis: string | null };
}

export function validateRecordObservationInput(
  input: RecordObservationInput,
): ValidatedObservationInput {
  if (!isPlainObject(input)) {
    throw inputError('observation input must be an object');
  }
  rejectUnknownKeys(input, RECORD_INPUT_KEYS, 'the observation input');

  const kind = requireString(input.kind, 'kind');
  if (!KIND_PATTERN.test(kind)) {
    throw inputError(
      `kind must be a canonical classification matching ${KIND_PATTERN.source} (got '${kind}')`,
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

  const observedAt = requireIsoInstant(input.observedAt, 'observedAt');

  // --- source (provenance) ---
  if (!isPlainObject(input.source)) {
    throw inputError('source must be an object');
  }
  rejectUnknownKeys(input.source, SOURCE_KEYS, 'source');
  if (!isObservationSourceKind(input.source.kind)) {
    throw inputError(
      `source.kind must be one of ${OBSERVATION_SOURCE_KINDS.join(', ')} (got '${String(input.source.kind)}')`,
    );
  }
  const sourceId = optionalTrimmed(input.source.id, 'source.id');
  const sourceLabel = optionalTrimmed(input.source.label, 'source.label');
  if (sourceId === null && sourceLabel === null) {
    throw inputError('source must carry an id or a label — provenance must be traceable');
  }

  const channel = requireSlug(input.channel, 'channel');

  // --- lineage (extraction provenance) ---
  const lineageRaw = input.lineage === undefined ? {} : input.lineage;
  if (!isPlainObject(lineageRaw)) {
    throw inputError('lineage must be an object');
  }
  rejectUnknownKeys(lineageRaw, LINEAGE_KEYS, 'lineage');
  const rawMethod = lineageRaw.method === undefined ? 'direct' : lineageRaw.method;
  if (!isLineageMethod(rawMethod)) {
    throw inputError(
      `lineage.method must be one of ${LINEAGE_METHODS.join(', ')} (got '${String(rawMethod)}')`,
    );
  }
  const method: LineageMethod = rawMethod;
  const deriving = (DERIVING_LINEAGE_METHODS as readonly string[]).includes(method);
  const parentsRaw = lineageRaw.parents === undefined ? [] : lineageRaw.parents;
  if (!Array.isArray(parentsRaw)) {
    throw lineageError('lineage.parents must be an array of observation ids');
  }
  if (parentsRaw.length > MAX_LINEAGE_PARENTS) {
    throw lineageError(`lineage.parents supports at most ${MAX_LINEAGE_PARENTS} parents`);
  }
  const parents: string[] = [];
  for (const [index, parent] of parentsRaw.entries()) {
    if (typeof parent !== 'string' || !UUID_PATTERN.test(parent)) {
      throw lineageError(`lineage.parents[${index}] must be an observation uuid`);
    }
    const normalized = parent.toLowerCase();
    if (parents.includes(normalized)) {
      throw lineageError('lineage.parents contains a duplicate parent');
    }
    parents.push(normalized);
  }
  if (deriving && parents.length === 0) {
    throw lineageError(`lineage method '${method}' requires at least one parent observation`);
  }
  if (!deriving && parents.length > 0) {
    throw lineageError(`lineage method '${method}' cannot carry parent observations`);
  }
  let extractor: { provider: string; model: string; notes: string | null } | null = null;
  const extractorRaw = lineageRaw.extractor;
  if (extractorRaw !== undefined && extractorRaw !== null) {
    if (!isPlainObject(extractorRaw)) {
      throw inputError('lineage.extractor must be an object');
    }
    rejectUnknownKeys(extractorRaw, EXTRACTOR_KEYS, 'lineage.extractor');
    const provider = requireSlug(extractorRaw.provider, 'lineage.extractor.provider');
    const model = requireString(extractorRaw.model, 'lineage.extractor.model');
    if (model.length > 128) {
      throw inputError('lineage.extractor.model must be at most 128 characters');
    }
    extractor = { provider, model, notes: optionalTrimmed(extractorRaw.notes, 'lineage.extractor.notes') };
  }

  // --- permissions ---
  const permissionsRaw = input.permissions === undefined ? {} : input.permissions;
  if (!isPlainObject(permissionsRaw)) {
    throw inputError('permissions must be an object');
  }
  rejectUnknownKeys(permissionsRaw, PERMISSIONS_KEYS, 'permissions');
  const rawVisibility = permissionsRaw.visibility === undefined ? 'tenant' : permissionsRaw.visibility;
  if (!isObservationVisibility(rawVisibility)) {
    throw inputError(
      `permissions.visibility must be one of ${OBSERVATION_VISIBILITIES.join(', ')} (got '${String(permissionsRaw.visibility)}')`,
    );
  }
  const visibility: ObservationVisibility = rawVisibility;
  const workspaceId =
    permissionsRaw.workspaceId === undefined || permissionsRaw.workspaceId === null
      ? null
      : requireUuid(permissionsRaw.workspaceId, 'permissions.workspaceId');
  const principalId =
    permissionsRaw.principalId === undefined || permissionsRaw.principalId === null
      ? null
      : requireUuid(permissionsRaw.principalId, 'permissions.principalId');
  if (visibility === 'tenant' && (workspaceId !== null || principalId !== null)) {
    throw inputError("permissions.visibility 'tenant' must not carry workspaceId or principalId");
  }
  if (visibility === 'workspace' && workspaceId === null) {
    throw inputError("permissions.visibility 'workspace' requires permissions.workspaceId");
  }
  if (visibility === 'principal' && principalId === null) {
    throw inputError("permissions.visibility 'principal' requires permissions.principalId");
  }
  if (visibility === 'workspace' && principalId !== null) {
    throw inputError("permissions.visibility 'workspace' must not carry principalId");
  }
  if (visibility === 'principal' && workspaceId !== null) {
    throw inputError("permissions.visibility 'principal' must not carry workspaceId");
  }
  const usageRaw = permissionsRaw.usage === undefined ? [] : permissionsRaw.usage;
  if (!Array.isArray(usageRaw)) {
    throw inputError('permissions.usage must be an array of constraint tags');
  }
  if (usageRaw.length > MAX_USAGE_TAGS) {
    throw inputError(`permissions.usage supports at most ${MAX_USAGE_TAGS} tags`);
  }
  const usage: string[] = [];
  for (const tag of usageRaw) {
    const normalized = requireSlug(tag, 'permissions.usage tag');
    if (!usage.includes(normalized)) usage.push(normalized);
  }
  usage.sort();

  // --- confidence (required, explicit) ---
  if (!isPlainObject(input.confidence)) {
    throw inputError('confidence must be an object (evidence enters with explicit confidence)');
  }
  rejectUnknownKeys(input.confidence, CONFIDENCE_KEYS, 'confidence');
  const value = input.confidence.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw inputError(`confidence.value must be a finite number in [0, 1] (got ${String(value)})`);
  }
  const confidenceMethod = requireSlug(input.confidence.method, 'confidence.method');
  const confidenceBasis = optionalTrimmed(input.confidence.basis, 'confidence.basis');

  return {
    kind,
    payload: input.payload,
    observedAt,
    source: { kind: input.source.kind, id: sourceId, label: sourceLabel },
    channel,
    lineage: { method, parents, extractor },
    permissions: { visibility, workspaceId, principalId, usage },
    confidence: { value, method: confidenceMethod, basis: confidenceBasis },
  };
}

/** Fully validated + normalized form of `ListObservationsQuery`. */
export interface ValidatedListQuery {
  kind: string | null;
  channel: string | null;
  sourceKind: ObservationSourceKind | null;
  sourceId: string | null;
  observedFrom: Date | null;
  observedTo: Date | null;
  limit: number;
}

export function validateListObservationsQuery(
  query: ListObservationsQuery,
): ValidatedListQuery {
  try {
    return validateListObservationsQueryInner(query);
  } catch (error) {
    // The shared string guards throw `invalid_observation_input`; for a
    // query the correct code is `invalid_observation_query`.
    if (error instanceof ObservationsError && error.code === 'invalid_observation_input') {
      throw new ObservationsError('invalid_observation_query', error.message);
    }
    throw error;
  }
}

function validateListObservationsQueryInner(
  query: ListObservationsQuery,
): ValidatedListQuery {
  if (!isPlainObject(query)) {
    throw new ObservationsError('invalid_observation_query', 'query must be an object');
  }
  const unknown = Object.keys(query).filter((key) => !(QUERY_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new ObservationsError(
      'invalid_observation_query',
      `unknown query field '${unknown[0]}' (allowed: ${QUERY_KEYS.join(', ')})`,
    );
  }
  const kind = query.kind === undefined ? null : requireString(query.kind, 'query.kind');
  if (kind !== null && !KIND_PATTERN.test(kind)) {
    throw new ObservationsError(
      'invalid_observation_query',
      `query.kind must match ${KIND_PATTERN.source} (got '${kind}')`,
    );
  }
  const channel = query.channel === undefined ? null : requireSlug(query.channel, 'query.channel');
  const sourceKind = query.sourceKind === undefined ? null : query.sourceKind;
  if (sourceKind !== null && !isObservationSourceKind(sourceKind)) {
    throw new ObservationsError(
      'invalid_observation_query',
      `query.sourceKind must be one of ${OBSERVATION_SOURCE_KINDS.join(', ')} (got '${String(sourceKind)}')`,
    );
  }
  const sourceId = query.sourceId === undefined ? null : requireString(query.sourceId, 'query.sourceId');
  if (sourceId !== null && sourceKind === null) {
    throw new ObservationsError(
      'invalid_observation_query',
      'query.sourceId requires query.sourceKind (an id is meaningless without its kind)',
    );
  }
  const observedFrom =
    query.observedFrom === undefined ? null : requireIsoInstant(query.observedFrom, 'query.observedFrom');
  const observedTo =
    query.observedTo === undefined ? null : requireIsoInstant(query.observedTo, 'query.observedTo');
  if (observedFrom !== null && observedTo !== null && observedFrom > observedTo) {
    throw new ObservationsError(
      'invalid_observation_query',
      'query.observedFrom must not be after query.observedTo',
    );
  }
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw new ObservationsError(
      'invalid_observation_query',
      `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`,
    );
  }
  return {
    kind,
    channel,
    sourceKind,
    sourceId,
    observedFrom: observedFrom === null ? null : new Date(observedFrom),
    observedTo: observedTo === null ? null : new Date(observedTo),
    limit,
  };
}

/** Observation-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
