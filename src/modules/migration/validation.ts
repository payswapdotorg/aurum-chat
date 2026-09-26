// Pure validation/normalization logic of the migration module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, timestamps, snapshot references,
// dispositions or conflict links into records — identity, tenancy and
// the per-phase outcome links are minted by the system from validated
// cross-module state.

import type { TenantContext } from '@/infra/tenant';
import { MigrationError } from './errors';
import type {
  ImportRoundKind,
  ImportRoundStatus,
  ImportedRecordDisposition,
  ImportedRecordState,
  IdentityConflictKind,
  IdentityConflictStatus,
  MigrationEventType,
  MigrationStatus,
  RoundVerification,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const MIGRATION_STATUSES = [
  'dual-running',
  'compare-clean',
  'incumbent-read-only',
  'incumbent-retired',
  'sequestered',
] as const;

export const IMPORT_ROUND_KINDS = ['full', 'delta'] as const;

export const IMPORT_ROUND_STATUSES = [
  'snapshotted',
  'staged',
  'reviewed',
  'committed',
  'abandoned',
] as const;

export const IMPORTED_RECORD_STATES = [
  'snapshotted',
  'staged',
  'committed',
  'abandoned',
] as const;

export const IMPORTED_RECORD_DISPOSITIONS = [
  'new',
  'update',
  'matched',
  'conflicted',
  'resolved',
  'tombstone',
] as const;

export const ROUND_VERIFICATIONS = ['not-wired', 'verified', 'divergent'] as const;

export const IDENTITY_CONFLICT_KINDS = ['cross-system-collision', 'ambiguous-match'] as const;

export const IDENTITY_CONFLICT_STATUSES = ['open', 'resolved'] as const;

export const MIGRATION_EVENT_TYPES = [
  'created',
  'snapshot-captured',
  'transformed',
  'reviewed',
  'committed',
  'round-abandoned',
  'identity-conflict-raised',
  'identity-conflict-resolved',
  'comparison-completed',
  'compare-clean-checkpoint',
  'incumbent-read-only-checkpoint',
  'incumbent-retired',
  'sequestered',
  'verification-divergence',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/** Canonical payload size cap (256 KiB — modest jsonb; the W004 discipline). */
export const MAX_VALUE_BYTES = 262_144;
/** One import round's record cap (a larger incumbent must batch windows). */
export const MAX_ROUND_RECORDS = 5_000;
export const MIN_SYSTEM_KEY_LENGTH = 3;
export const MAX_SYSTEM_KEY_LENGTH = 312;
export const MAX_EXTERNAL_ID_LENGTH = 200;
export const MAX_MATCH_KEY_LENGTH = 200;
export const MAX_ENTITY_TYPE_LENGTH = 100;
export const MAX_CAPABILITY_KEY_LENGTH = 128;
export const MAX_KIT_KEY_LENGTH = 128;
export const MAX_KIT_VERSION_LENGTH = 64;
export const MAX_KIT_INTEGRATION_KEY_LENGTH = 128;
export const MAX_SNAPSHOT_REF_LENGTH = 200;
export const MIN_REASON_LENGTH = 1;
export const MAX_REASON_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_ENTITY_ID_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isMigrationStatus(value: unknown): value is MigrationStatus {
  return typeof value === 'string' && (MIGRATION_STATUSES as readonly string[]).includes(value);
}

export function isImportRoundKind(value: unknown): value is ImportRoundKind {
  return typeof value === 'string' && (IMPORT_ROUND_KINDS as readonly string[]).includes(value);
}

export function isImportRoundStatus(value: unknown): value is ImportRoundStatus {
  return (
    typeof value === 'string' && (IMPORT_ROUND_STATUSES as readonly string[]).includes(value)
  );
}

export function isImportedRecordState(value: unknown): value is ImportedRecordState {
  return (
    typeof value === 'string' && (IMPORTED_RECORD_STATES as readonly string[]).includes(value)
  );
}

export function isImportedRecordDisposition(
  value: unknown,
): value is ImportedRecordDisposition {
  return (
    typeof value === 'string' &&
    (IMPORTED_RECORD_DISPOSITIONS as readonly string[]).includes(value)
  );
}

export function isRoundVerification(value: unknown): value is RoundVerification {
  return typeof value === 'string' && (ROUND_VERIFICATIONS as readonly string[]).includes(value);
}

export function isIdentityConflictKind(value: unknown): value is IdentityConflictKind {
  return (
    typeof value === 'string' && (IDENTITY_CONFLICT_KINDS as readonly string[]).includes(value)
  );
}

export function isIdentityConflictStatus(value: unknown): value is IdentityConflictStatus {
  return (
    typeof value === 'string' &&
    (IDENTITY_CONFLICT_STATUSES as readonly string[]).includes(value)
  );
}

export function isMigrationEventType(value: unknown): value is MigrationEventType {
  return (
    typeof value === 'string' && (MIGRATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertMigrationTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new MigrationError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new MigrationError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new MigrationError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

// ---------------------------------------------------------------------------
// Primitive helpers (house pattern)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  if (Array.isArray(value)) return value.every((entry) => isPlainJsonValue(entry));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isPlainJsonValue(entry));
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new MigrationError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new MigrationError('invalid_input', `'${field}' must be a uuid`);
  }
  return value;
}

function requireString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minLength ||
    value.length > maxLength
  ) {
    throw new MigrationError(
      'invalid_input',
      `'${field}' must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, minLength, maxLength);
}

function optionalLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MigrationError('invalid_input', `'${field}' must be an integer`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new MigrationError(
      'invalid_input',
      `'${field}' must be between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  guard: (candidate: unknown) => candidate is T,
): T | null {
  if (value === undefined || value === null) return null;
  if (!guard(value)) {
    throw new MigrationError('invalid_input', `'${field}' must be a recognized value`);
  }
  return value;
}

function requirePlainJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', `'${field}' must be a plain JSON object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new MigrationError(
      'invalid_input',
      `'${field}' must be JSON-serializable (a provider object, class instance or cycle cannot cross the module)`,
    );
  }
  if (serialized === undefined) {
    throw new MigrationError('invalid_input', `'${field}' must be JSON-serializable`);
  }
  if (serialized.length > MAX_VALUE_BYTES) {
    throw new MigrationError(
      'invalid_input',
      `'${field}' exceeds the maximum of ${MAX_VALUE_BYTES} bytes (${serialized.length}); large artifacts belong in object storage`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Validated input shapes
// ---------------------------------------------------------------------------

export interface ValidatedCreateInput {
  incumbentSystemId: string;
  incumbentConnectionId: string;
  incumbentReadCapabilityKey: string;
  kitInstallationId: string | null;
  kitIntegrationKey: string | null;
}

const CREATE_KEYS = [
  'incumbentSystemId',
  'incumbentConnectionId',
  'incumbentReadCapabilityKey',
  'kitBinding',
] as const;
const KIT_BINDING_KEYS = ['installationId', 'integrationKey'] as const;

export function validateCreateMigrationInput(value: unknown): ValidatedCreateInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, CREATE_KEYS, 'input');
  let kitInstallationId: string | null = null;
  let kitIntegrationKey: string | null = null;
  if (value.kitBinding !== undefined && value.kitBinding !== null) {
    if (!isPlainObject(value.kitBinding)) {
      throw new MigrationError('invalid_input', 'input.kitBinding must be an object');
    }
    rejectUnknownKeys(value.kitBinding, KIT_BINDING_KEYS, 'input.kitBinding');
    kitInstallationId = requireUuid(value.kitBinding.installationId, 'input.kitBinding.installationId');
    kitIntegrationKey = requireString(
      value.kitBinding.integrationKey,
      'input.kitBinding.integrationKey',
      3,
      MAX_KIT_INTEGRATION_KEY_LENGTH,
    );
  }
  return {
    incumbentSystemId: requireUuid(value.incumbentSystemId, 'input.incumbentSystemId'),
    incumbentConnectionId: requireUuid(
      value.incumbentConnectionId,
      'input.incumbentConnectionId',
    ),
    incumbentReadCapabilityKey: requireString(
      value.incumbentReadCapabilityKey,
      'input.incumbentReadCapabilityKey',
      3,
      MAX_CAPABILITY_KEY_LENGTH,
    ),
    kitInstallationId,
    kitIntegrationKey,
  };
}

export interface ValidatedMigrationIdInput {
  migrationId: string;
}

const MIGRATION_ID_KEYS = ['migrationId'] as const;

export function validateMigrationIdInput(value: unknown): ValidatedMigrationIdInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, MIGRATION_ID_KEYS, 'input');
  return { migrationId: requireUuid(value.migrationId, 'input.migrationId') };
}

export interface ValidatedCaptureSnapshotInput {
  migrationId: string;
  kind: ImportRoundKind | null;
}

const CAPTURE_KEYS = ['migrationId', 'kind'] as const;

export function validateCaptureSnapshotInput(value: unknown): ValidatedCaptureSnapshotInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, CAPTURE_KEYS, 'input');
  const kind =
    value.kind === undefined || value.kind === null ? null : optionalEnum(value.kind, 'input.kind', isImportRoundKind);
  if (kind === undefined) {
    throw new MigrationError('invalid_input', `'input.kind' must be 'full' or 'delta'`);
  }
  return { migrationId: requireUuid(value.migrationId, 'input.migrationId'), kind };
}

export interface ValidatedRoundIdInput {
  roundId: string;
}

const ROUND_ID_KEYS = ['roundId'] as const;

export function validateRoundIdInput(value: unknown): ValidatedRoundIdInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, ROUND_ID_KEYS, 'input');
  return { roundId: requireUuid(value.roundId, 'input.roundId') };
}

export interface ValidatedResolveConflictInput {
  conflictId: string;
  aurumEntityId: string;
  note: string | null;
}

const RESOLVE_CONFLICT_KEYS = ['conflictId', 'aurumEntityId', 'note'] as const;

export function validateResolveConflictInput(value: unknown): ValidatedResolveConflictInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, RESOLVE_CONFLICT_KEYS, 'input');
  return {
    conflictId: requireUuid(value.conflictId, 'input.conflictId'),
    aurumEntityId: requireString(
      value.aurumEntityId,
      'input.aurumEntityId',
      1,
      MAX_ENTITY_ID_LENGTH,
    ),
    note: optionalString(value.note, 'input.note', 1, MAX_NOTE_LENGTH),
  };
}

export interface ValidatedRunComparisonInput {
  migrationId: string;
  note: string | null;
}

const RUN_COMPARISON_KEYS = ['migrationId', 'note'] as const;

export function validateRunComparisonInput(value: unknown): ValidatedRunComparisonInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, RUN_COMPARISON_KEYS, 'input');
  return {
    migrationId: requireUuid(value.migrationId, 'input.migrationId'),
    note: optionalString(value.note, 'input.note', 1, MAX_NOTE_LENGTH),
  };
}

export interface ValidatedSequesterInput {
  migrationId: string;
  reason: string;
}

const SEQUESTER_KEYS = ['migrationId', 'reason'] as const;

export function validateSequesterInput(value: unknown): ValidatedSequesterInput {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_input', 'input must be an object');
  }
  rejectUnknownKeys(value, SEQUESTER_KEYS, 'input');
  return {
    migrationId: requireUuid(value.migrationId, 'input.migrationId'),
    reason: requireString(value.reason, 'input.reason', MIN_REASON_LENGTH, MAX_REASON_LENGTH),
  };
}

export interface ValidatedResolveExternalIdQuery {
  sourceSystemKey: string;
  externalId: string;
}

const RESOLVE_EXTERNAL_KEYS = ['sourceSystemKey', 'externalId'] as const;

export function validateResolveExternalIdQuery(
  value: unknown,
): ValidatedResolveExternalIdQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, RESOLVE_EXTERNAL_KEYS, 'query');
  return {
    sourceSystemKey: requireString(
      value.sourceSystemKey,
      'query.sourceSystemKey',
      MIN_SYSTEM_KEY_LENGTH,
      MAX_SYSTEM_KEY_LENGTH,
    ),
    externalId: requireString(value.externalId, 'query.externalId', 1, MAX_EXTERNAL_ID_LENGTH),
  };
}

export interface ValidatedGetQuery {
  migrationId: string;
}

export function validateGetMigrationQuery(value: unknown): ValidatedGetQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, MIGRATION_ID_KEYS, 'query');
  return { migrationId: requireUuid(value.migrationId, 'query.migrationId') };
}

export interface ValidatedListMigrationsQuery {
  status: MigrationStatus | null;
  limit: number;
}

const LIST_MIGRATIONS_KEYS = ['status', 'limit'] as const;

export function validateListMigrationsQuery(value: unknown): ValidatedListMigrationsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_MIGRATIONS_KEYS, 'query');
  return {
    status: optionalEnum(value.status, 'query.status', isMigrationStatus),
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedListRoundsQuery {
  migrationId: string;
  status: ImportRoundStatus | null;
  limit: number;
}

const LIST_ROUNDS_KEYS = ['migrationId', 'status', 'limit'] as const;

export function validateListImportRoundsQuery(value: unknown): ValidatedListRoundsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_ROUNDS_KEYS, 'query');
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    status: optionalEnum(value.status, 'query.status', isImportRoundStatus),
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedListRecordsQuery {
  migrationId: string;
  roundId: string | null;
  includeSequestered: boolean;
  limit: number;
}

const LIST_RECORDS_KEYS = ['migrationId', 'roundId', 'includeSequestered', 'limit'] as const;

export function validateListImportedRecordsQuery(value: unknown): ValidatedListRecordsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_RECORDS_KEYS, 'query');
  const includeSequestered = value.includeSequestered;
  if (includeSequestered !== undefined && typeof includeSequestered !== 'boolean') {
    throw new MigrationError('invalid_query', 'query.includeSequestered must be a boolean');
  }
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    roundId:
      value.roundId === undefined || value.roundId === null
        ? null
        : requireUuid(value.roundId, 'query.roundId'),
    includeSequestered: includeSequestered === true,
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedListMappingsQuery {
  migrationId: string | null;
  limit: number;
}

const LIST_MAPPINGS_KEYS = ['migrationId', 'limit'] as const;

export function validateListIdentifierMappingsQuery(
  value: unknown,
): ValidatedListMappingsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_MAPPINGS_KEYS, 'query');
  return {
    migrationId:
      value.migrationId === undefined || value.migrationId === null
        ? null
        : requireUuid(value.migrationId, 'query.migrationId'),
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedListConflictsQuery {
  migrationId: string | null;
  status: IdentityConflictStatus | null;
  limit: number;
}

const LIST_CONFLICTS_KEYS = ['migrationId', 'status', 'limit'] as const;

export function validateListIdentityConflictsQuery(value: unknown): ValidatedListConflictsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_CONFLICTS_KEYS, 'query');
  return {
    migrationId:
      value.migrationId === undefined || value.migrationId === null
        ? null
        : requireUuid(value.migrationId, 'query.migrationId'),
    status: optionalEnum(value.status, 'query.status', isIdentityConflictStatus),
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedConflictIdQuery {
  conflictId: string;
}

const CONFLICT_ID_KEYS = ['conflictId'] as const;

export function validateGetIdentityConflictQuery(value: unknown): ValidatedConflictIdQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, CONFLICT_ID_KEYS, 'query');
  return { conflictId: requireUuid(value.conflictId, 'query.conflictId') };
}

export interface ValidatedComparisonIdQuery {
  comparisonRoundId: string;
}

const COMPARISON_ID_KEYS = ['comparisonRoundId'] as const;

export function validateGetComparisonRoundQuery(value: unknown): ValidatedComparisonIdQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, COMPARISON_ID_KEYS, 'query');
  return {
    comparisonRoundId: requireUuid(value.comparisonRoundId, 'query.comparisonRoundId'),
  };
}

export interface ValidatedListComparisonsQuery {
  migrationId: string;
  limit: number;
}

const LIST_COMPARISONS_KEYS = ['migrationId', 'limit'] as const;

export function validateListComparisonRoundsQuery(value: unknown): ValidatedListComparisonsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_COMPARISONS_KEYS, 'query');
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedListEventsQuery {
  migrationId: string;
  limit: number;
}

const LIST_EVENTS_KEYS = ['migrationId', 'limit'] as const;

export function validateListMigrationEventsQuery(value: unknown): ValidatedListEventsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_EVENTS_KEYS, 'query');
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    limit: optionalLimit(value.limit, 'query.limit'),
  };
}

export interface ValidatedListCurrentStatesQuery {
  migrationId: string;
  includeTombstoned: boolean;
}

const LIST_CURRENT_KEYS = ['migrationId', 'includeTombstoned'] as const;

export function validateListCurrentImportedStatesQuery(
  value: unknown,
): ValidatedListCurrentStatesQuery {
  if (!isPlainObject(value)) {
    throw new MigrationError('invalid_query', 'query must be an object');
  }
  rejectUnknownKeys(value, LIST_CURRENT_KEYS, 'query');
  const includeTombstoned = value.includeTombstoned;
  if (includeTombstoned !== undefined && typeof includeTombstoned !== 'boolean') {
    throw new MigrationError('invalid_query', 'query.includeTombstoned must be a boolean');
  }
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    includeTombstoned: includeTombstoned === true,
  };
}

// ---------------------------------------------------------------------------
// Incumbent-reader result canonicalization (provider objects never cross)
// ---------------------------------------------------------------------------

/** Strict ISO 8601 with explicit offset (the observations discipline). */
export function isStrictIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value);
}

export interface ValidatedIncumbentRecord {
  externalId: string;
  matchKey: string | null;
  entityType: string | null;
  payload: Record<string, unknown> | null;
  tombstone: boolean;
}

/**
 * Canonicalizes one incumbent-reader record: plain JSON only, modest
 * size, external id a bounded string, a tombstone exactly when the
 * reader reported a deletion (payload null), a live record always with a
 * payload. A provider object (class instance, symbol, cycle, oversized
 * body) CANNOT cross — it is rejected loudly here.
 */
export function canonicalizeIncumbentRecord(
  value: unknown,
  position: number,
): ValidatedIncumbentRecord {
  if (!isPlainObject(value)) {
    throw new MigrationError(
      'invalid_reader_result',
      `the incumbent reader returned a non-object record at position ${position} — provider objects never cross the module`,
    );
  }
  rejectUnknownKeys(
    value,
    ['externalId', 'matchKey', 'entityType', 'payload', 'deletedAt'],
    `reader record at position ${position}`,
  );
  const externalId = requireString(
    value.externalId,
    `reader record at position ${position}: externalId`,
    1,
    MAX_EXTERNAL_ID_LENGTH,
  );
  const matchKey = optionalString(
    value.matchKey,
    `reader record at position ${position}: matchKey`,
    1,
    MAX_MATCH_KEY_LENGTH,
  );
  const entityType = optionalString(
    value.entityType,
    `reader record at position ${position}: entityType`,
    1,
    MAX_ENTITY_TYPE_LENGTH,
  );
  const deletedAt =
    value.deletedAt === undefined || value.deletedAt === null
      ? null
      : isStrictIsoTimestamp(value.deletedAt)
        ? value.deletedAt
        : null;
  if (value.deletedAt !== undefined && value.deletedAt !== null && deletedAt === null) {
    throw new MigrationError(
      'invalid_reader_result',
      `the incumbent reader returned a deletedAt that is not a strict ISO 8601 timestamp at position ${position}`,
    );
  }
  let payload: Record<string, unknown> | null = null;
  if (deletedAt === null) {
    if (value.payload === undefined || value.payload === null) {
      throw new MigrationError(
        'invalid_reader_result',
        `the incumbent reader returned a live record without a payload at position ${position}`,
      );
    }
    payload = requirePlainJsonObject(
      value.payload,
      `reader record at position ${position}: payload`,
    );
  } else if (value.payload !== undefined && value.payload !== null) {
    throw new MigrationError(
      'invalid_reader_result',
      `the incumbent reader returned a tombstone with a payload at position ${position}`,
    );
  }
  return {
    externalId,
    matchKey,
    entityType,
    payload,
    tombstone: deletedAt !== null,
  };
}

export interface ValidatedSnapshotResult {
  snapshotRef: string;
  records: ValidatedIncumbentRecord[];
}

/**
 * Canonicalizes one incumbent-reader snapshot result (the
 * deep-actions transport-canonicalization discipline).
 */
export function canonicalizeSnapshotResult(
  value: unknown,
  label: string,
): ValidatedSnapshotResult {
  if (!isPlainObject(value)) {
    throw new MigrationError(
      'invalid_reader_result',
      `${label} returned a non-object result — provider objects never cross the module`,
    );
  }
  rejectUnknownKeys(value, ['snapshotRef', 'records'], `${label} result`);
  const snapshotRef = requireString(
    value.snapshotRef,
    `${label} result: snapshotRef`,
    1,
    MAX_SNAPSHOT_REF_LENGTH,
  );
  if (!Array.isArray(value.records)) {
    throw new MigrationError('invalid_reader_result', `${label} result: records must be an array`);
  }
  if (value.records.length > MAX_ROUND_RECORDS) {
    throw new MigrationError(
      'snapshot_too_large',
      `${label} returned ${value.records.length} records — the per-round cap is ${MAX_ROUND_RECORDS}; the adapter must batch smaller windows`,
    );
  }
  const records = value.records.map((record, index) =>
    canonicalizeIncumbentRecord(record, index + 1),
  );
  return { snapshotRef, records };
}

export interface ValidatedNativeStateReadResult {
  states: Array<{ aurumEntityId: string; state: Record<string, unknown> }>;
}

/** Canonicalizes one native-reader result (the same discipline). */
export function canonicalizeNativeStates(
  value: unknown,
  label: string,
): ValidatedNativeStateReadResult {
  if (!isPlainObject(value)) {
    throw new MigrationError(
      'invalid_reader_result',
      `${label} returned a non-object result — provider objects never cross the module`,
    );
  }
  rejectUnknownKeys(value, ['states'], `${label} result`);
  if (!Array.isArray(value.states)) {
    throw new MigrationError('invalid_reader_result', `${label} result: states must be an array`);
  }
  const seen = new Set<string>();
  const states: Array<{ aurumEntityId: string; state: Record<string, unknown> }> = [];
  for (const [index, entry] of value.states.entries()) {
    if (!isPlainObject(entry)) {
      throw new MigrationError(
        'invalid_reader_result',
        `${label} returned a non-object state entry at position ${index + 1}`,
      );
    }
    rejectUnknownKeys(entry, ['aurumEntityId', 'state'], `${label} state entry at position ${index + 1}`);
    const aurumEntityId = requireString(
      entry.aurumEntityId,
      `${label} state entry at position ${index + 1}: aurumEntityId`,
      1,
      MAX_ENTITY_ID_LENGTH,
    );
    if (seen.has(aurumEntityId)) {
      throw new MigrationError(
        'invalid_reader_result',
        `${label} returned a duplicate state for entity '${aurumEntityId}'`,
      );
    }
    seen.add(aurumEntityId);
    states.push({
      aurumEntityId,
      state: requirePlainJsonObject(
        entry.state,
        `${label} state entry at position ${index + 1}: state`,
      ),
    });
  }
  return { states };
}
