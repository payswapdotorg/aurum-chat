// Pure validation/normalization logic of the freshness module (no
// database). Everything a caller may put into a policy, a temporal
// revision or a query crosses these guards first; the SQL CHECK
// constraints in migrations/001 and /002 mirror the load-bearing rules as
// defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `version`, `recordedAt`, `validTo` or `current` into a
// record call — a revision's identity, tenancy, version number and commit
// time are minted by the system (part of the "history is never rewritten"
// acceptance of W006).

import type { TenantContext } from '@/infra/tenant';
import {
  OBSERVATION_SOURCE_KINDS,
  type ObservationSourceKind,
} from '@/modules/observations/contract';
import { FreshnessError } from './errors';
import type {
  GetTemporalStateQuery,
  ListFreshnessPoliciesQuery,
  ListTemporalHistoryQuery,
  ObservationFreshnessQuery,
  PolicySubjectQuery,
  RecordTemporalRevisionInput,
  SetFreshnessPolicyInput,
  SourceFreshnessQuery,
  TemporalStateFreshnessQuery,
} from './types';

/** Canonical freshness statuses (ARCHITECTURE.md §11 + `unknown`). */
export const FRESHNESS_STATUSES = ['current', 'aging', 'stale', 'unknown'] as const;

/**
 * The subject kind freshness itself uses for source-scoped policies —
 * `evaluateSourceFreshness` and `evaluateObservationFreshness` resolve
 * policies under this kind. Exported so W036/W014 key their source
 * policies identically.
 */
export const SOURCE_SUBJECT_KIND = 'source';

export const MAX_PROVENANCE_OBSERVATIONS = 16;
export const MAX_STATE_BYTES = 1_048_576; // 1 MiB — jsonb payloads stay modest; large artifacts belong to object storage
export const DEFAULT_POLICY_LIST_LIMIT = 100;
export const MAX_POLICY_LIST_LIMIT = 500;
/** PostgreSQL `integer` bound — policy seconds must fit the column. */
const MAX_POLICY_SECONDS = 2_147_483_647;
const MAX_NOTE_CHARS = 512;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Strict ISO 8601 with an explicit offset — temporal instants are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const POLICY_INPUT_KEYS = [
  'subjectKind',
  'subjectId',
  'staleAfterSeconds',
  'agingAfterSeconds',
  'maxLatencySeconds',
  'note',
] as const;
const REVISION_INPUT_KEYS = [
  'subjectKind',
  'subjectId',
  'state',
  'validFrom',
  'observationIds',
  'rationale',
] as const;
const TEMPORAL_STATE_QUERY_KEYS = ['subjectKind', 'subjectId', 'asOf'] as const;
const HISTORY_QUERY_KEYS = ['subjectKind', 'subjectId'] as const;
const POLICY_SUBJECT_QUERY_KEYS = ['subjectKind', 'subjectId'] as const;
const POLICY_LIST_QUERY_KEYS = ['subjectKind', 'limit'] as const;
const OBSERVATION_FRESHNESS_QUERY_KEYS = ['observationId', 'asOf'] as const;
const SOURCE_FRESHNESS_QUERY_KEYS = ['sourceKind', 'sourceId', 'asOf'] as const;

export function isFreshnessStatus(value: unknown): value is (typeof FRESHNESS_STATUSES)[number] {
  return (
    typeof value === 'string' &&
    (FRESHNESS_STATUSES as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertFreshnessTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new FreshnessError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new FreshnessError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new FreshnessError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

/** Uuid shape guard; malformed subject/observation ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
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
      throw new FreshnessError(
        'invalid_query',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxChars = MAX_NOTE_CHARS): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > maxChars) {
    throw inputError(`${field} must be at most ${maxChars} characters`);
  }
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

/** Optional strict ISO instant → Date | null (null = "use the service clock"). */
function optionalAsOf(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  return new Date(requireIsoInstant(value, field));
}

function requireSubjectKind(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!KIND_PATTERN.test(text)) {
    throw inputError(
      `${field} must be a canonical subject kind matching ${KIND_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
}

function requirePositiveSeconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw inputError(`${field} must be a positive integer of seconds (got ${String(value)})`);
  }
  if (value > MAX_POLICY_SECONDS) {
    throw inputError(`${field} must not exceed ${MAX_POLICY_SECONDS} seconds`);
  }
  return value;
}

function inputError(message: string): FreshnessError {
  return new FreshnessError('invalid_policy_input', message);
}

function revisionError(message: string): FreshnessError {
  return new FreshnessError('invalid_revision_input', message);
}

function queryError(message: string): FreshnessError {
  return new FreshnessError('invalid_query', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite numbers,
 * booleans, null, arrays, plain objects) — same discipline the observations
 * module applies to payloads.
 */
function checkJsonValue(value: unknown, where: string, depth: number): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw revisionError(`${where} must be finite (got ${String(value)})`);
    return;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    throw revisionError(`${where} contains a non-JSON value of type ${type}`);
  }
  if (depth > 64) {
    throw revisionError(`${where} exceeds the maximum nesting depth of 64`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkJsonValue(entry, `${where}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw revisionError(`${where} must be a plain JSON value (no class instances)`);
  }
  for (const key of Object.keys(value)) {
    checkJsonValue(value[key], `${where}.${key}`, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `SetFreshnessPolicyInput`. */
export interface ValidatedPolicyInput {
  subjectKind: string;
  subjectId: string | null;
  staleAfterSeconds: number;
  agingAfterSeconds: number | null;
  maxLatencySeconds: number | null;
  note: string | null;
}

export function validateSetFreshnessPolicyInput(input: SetFreshnessPolicyInput): ValidatedPolicyInput {
  if (!isPlainObject(input)) {
    throw inputError('policy input must be an object');
  }
  rejectPolicyKeys(input);

  const subjectKind = requireSubjectKind(input.subjectKind, 'subjectKind');
  const subjectId =
    input.subjectId === undefined || input.subjectId === null
      ? null
      : requireUuid(input.subjectId, 'subjectId');

  const staleAfterSeconds = requirePositiveSeconds(input.staleAfterSeconds, 'staleAfterSeconds');

  const agingAfterSeconds =
    input.agingAfterSeconds === undefined || input.agingAfterSeconds === null
      ? null
      : requirePositiveSeconds(input.agingAfterSeconds, 'agingAfterSeconds');
  if (agingAfterSeconds !== null && agingAfterSeconds >= staleAfterSeconds) {
    throw inputError(
      `agingAfterSeconds must be strictly below staleAfterSeconds (${agingAfterSeconds} >= ${staleAfterSeconds})`,
    );
  }

  const maxLatencySeconds =
    input.maxLatencySeconds === undefined || input.maxLatencySeconds === null
      ? null
      : requirePositiveSeconds(input.maxLatencySeconds, 'maxLatencySeconds');

  const note = optionalTrimmed(input.note, 'note');

  return { subjectKind, subjectId, staleAfterSeconds, agingAfterSeconds, maxLatencySeconds, note };
}

function rejectPolicyKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!(POLICY_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the policy input (allowed: ${POLICY_INPUT_KEYS.join(', ')})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Temporal revisions
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RecordTemporalRevisionInput`. */
export interface ValidatedRevisionInput {
  subjectKind: string;
  subjectId: string;
  state: unknown;
  validFrom: string;
  observationIds: string[];
  rationale: string | null;
}

export function validateRecordRevisionInput(
  input: RecordTemporalRevisionInput,
): ValidatedRevisionInput {
  if (!isPlainObject(input)) {
    throw revisionError('revision input must be an object');
  }
  return wrapRevisionError(() => validateRecordRevisionInputInner(input));
}

function validateRecordRevisionInputInner(
  input: Record<string, unknown>,
): ValidatedRevisionInput {
  for (const key of Object.keys(input)) {
    if (!(REVISION_INPUT_KEYS as readonly string[]).includes(key)) {
      throw revisionError(
        `unknown field '${key}' on the revision input (allowed: ${REVISION_INPUT_KEYS.join(', ')})`,
      );
    }
  }

  const subjectKind = requireSubjectKind(input.subjectKind, 'subjectKind');
  const subjectId = requireUuid(input.subjectId, 'subjectId');

  if (input.state === undefined || input.state === null) {
    throw revisionError('state must be a non-null JSON value');
  }
  checkJsonValue(input.state, 'state', 0);
  const serializedLength = JSON.stringify(input.state)?.length ?? 0;
  if (serializedLength > MAX_STATE_BYTES) {
    throw revisionError(
      `state exceeds the maximum of ${MAX_STATE_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }

  const validFrom = requireIsoInstant(input.validFrom, 'validFrom');

  // Provenance is REQUIRED (lock 11): a version of mutable understanding
  // never enters without supporting evidence.
  if (!Array.isArray(input.observationIds)) {
    throw revisionError('observationIds must be an array of observation uuids');
  }
  if (input.observationIds.length === 0) {
    throw revisionError(
      'observationIds must carry at least one supporting observation — understanding never versions without evidence',
    );
  }
  if (input.observationIds.length > MAX_PROVENANCE_OBSERVATIONS) {
    throw revisionError(
      `observationIds supports at most ${MAX_PROVENANCE_OBSERVATIONS} observations`,
    );
  }
  const observationIds: string[] = [];
  for (const [index, id] of input.observationIds.entries()) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw revisionError(`observationIds[${index}] must be an observation uuid`);
    }
    const normalized = id.toLowerCase();
    if (!observationIds.includes(normalized)) observationIds.push(normalized);
  }
  observationIds.sort();

  const rationale = optionalTrimmed(input.rationale, 'rationale');

  return { subjectKind, subjectId, state: input.state, validFrom, observationIds, rationale };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Shared (subjectKind, subjectId) parsing with unknown-key rejection. */
function requireSubjectRef(
  query: Record<string, unknown>,
  allowedKeys: readonly string[],
): { subjectKind: string; subjectId: string } {
  rejectUnknownKeys(query, allowedKeys, 'the query');
  return {
    subjectKind: requireSubjectKind(query.subjectKind, 'query.subjectKind'),
    subjectId: requireUuid(query.subjectId, 'query.subjectId'),
  };
}

function wrapQueryError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FreshnessError && error.code === 'invalid_policy_input') {
      throw queryError(error.message);
    }
    if (error instanceof FreshnessError && error.code === 'invalid_revision_input') {
      throw queryError(error.message);
    }
    throw error;
  }
}

/** The string guards throw `invalid_policy_input`; a revision input deserves `invalid_revision_input`. */
function wrapRevisionError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FreshnessError && error.code === 'invalid_policy_input') {
      throw revisionError(error.message);
    }
    throw error;
  }
}

/** Fully validated form of `GetTemporalStateQuery`. */
export interface ValidatedTemporalStateQuery {
  subjectKind: string;
  subjectId: string;
  asOf: Date | null;
}

export function validateGetTemporalStateQuery(
  query: GetTemporalStateQuery,
): ValidatedTemporalStateQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    const ref = requireSubjectRef(query, TEMPORAL_STATE_QUERY_KEYS);
    return { ...ref, asOf: optionalAsOf(query.asOf, 'query.asOf') };
  });
}

/** Fully validated form of `ListTemporalHistoryQuery`. */
export interface ValidatedHistoryQuery {
  subjectKind: string;
  subjectId: string;
}

export function validateHistoryQuery(query: ListTemporalHistoryQuery): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => requireSubjectRef(query, HISTORY_QUERY_KEYS));
}

/** Fully validated form of `TemporalStateFreshnessQuery`. */
export interface ValidatedTemporalStateFreshnessQuery {
  subjectKind: string;
  subjectId: string;
  asOf: Date | null;
}

export function validateTemporalStateFreshnessQuery(
  query: TemporalStateFreshnessQuery,
): ValidatedTemporalStateFreshnessQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    const ref = requireSubjectRef(query, TEMPORAL_STATE_QUERY_KEYS);
    return { ...ref, asOf: optionalAsOf(query.asOf, 'query.asOf') };
  });
}

/** Fully validated form of `PolicySubjectQuery` (subjectId nullable). */
export interface ValidatedPolicySubjectQuery {
  subjectKind: string;
  subjectId: string | null;
}

export function validatePolicySubjectQuery(
  query: PolicySubjectQuery,
): ValidatedPolicySubjectQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, POLICY_SUBJECT_QUERY_KEYS, 'the query');
    const subjectKind = requireSubjectKind(query.subjectKind, 'query.subjectKind');
    const subjectId =
      query.subjectId === undefined || query.subjectId === null
        ? null
        : requireUuid(query.subjectId, 'query.subjectId');
    return { subjectKind, subjectId };
  });
}

/** Fully validated form of `ListFreshnessPoliciesQuery`. */
export interface ValidatedPolicyListQuery {
  subjectKind: string | null;
  limit: number;
}

export function validateListPoliciesQuery(
  query: ListFreshnessPoliciesQuery,
): ValidatedPolicyListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, POLICY_LIST_QUERY_KEYS, 'the query');
    const subjectKind =
      query.subjectKind === undefined || query.subjectKind === null
        ? null
        : requireSubjectKind(query.subjectKind, 'query.subjectKind');
    const limit = query.limit === undefined ? DEFAULT_POLICY_LIST_LIMIT : query.limit;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_POLICY_LIST_LIMIT
    ) {
      throw queryError(
        `query.limit must be an integer in [1, ${MAX_POLICY_LIST_LIMIT}] (got ${String(limit)})`,
      );
    }
    return { subjectKind, limit };
  });
}

/** Fully validated form of `ObservationFreshnessQuery`. */
export interface ValidatedObservationFreshnessQuery {
  observationId: string;
  asOf: Date | null;
}

export function validateObservationFreshnessQuery(
  query: ObservationFreshnessQuery,
): ValidatedObservationFreshnessQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, OBSERVATION_FRESHNESS_QUERY_KEYS, 'the query');
    const observationId = requireUuid(query.observationId, 'query.observationId');
    return { observationId, asOf: optionalAsOf(query.asOf, 'query.asOf') };
  });
}

/** Fully validated form of `SourceFreshnessQuery`. */
export interface ValidatedSourceFreshnessQuery {
  sourceKind: ObservationSourceKind;
  sourceId: string;
  asOf: Date | null;
}

export function validateSourceFreshnessQuery(
  query: SourceFreshnessQuery,
): ValidatedSourceFreshnessQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, SOURCE_FRESHNESS_QUERY_KEYS, 'the query');
    const sourceKind = query.sourceKind;
    if (
      typeof sourceKind !== 'string' ||
      !(OBSERVATION_SOURCE_KINDS as readonly string[]).includes(sourceKind)
    ) {
      throw queryError(
        `query.sourceKind must be one of ${OBSERVATION_SOURCE_KINDS.join(', ')} (got '${String(sourceKind)}')`,
      );
    }
    const sourceId = requireUuid(query.sourceId, 'query.sourceId');
    return { sourceKind, sourceId, asOf: optionalAsOf(query.asOf, 'query.asOf') };
  });
}
