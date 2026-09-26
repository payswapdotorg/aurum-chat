// Validation vocabularies + guards of the migration-continuity module
// (the house pattern): runtime guards for contract inputs, honest
// limits, and the tenant-context assertion. Everything here is pure —
// no database, no clock, no network.

import type { TenantContext } from '@/infra/tenant';
import { isChannelProvider } from '@/modules/identity/contract';
// The W095 verification semantics this module re-uses for identifier
// preservation (verified / unverified — ambiguous never auto-merged);
// the W094 work order's state name for the unverified side is
// `unverified-external`, kept verbatim below.
import { UNIFIED_STATUSES } from '@/modules/unified-identity/contract';
import { MigrationContinuityError } from './errors';
import {
  MIGRATION_STATES,
  isMigrationState,
} from './lifecycle';
import type {
  IdentityMappingState,
  ImportManifestStatus,
  MigrationConflictStatus,
  MigrationConflictTaxonomy,
  MigrationEventType,
  MigrationState,
  MigrationTransitionKind,
  RetirementWindowStatus,
  SyncRunStatus,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

export const MIGRATION_TRANSITION_KINDS: readonly MigrationTransitionKind[] = [
  'forward',
  'rollback',
] as const;

export const MIGRATION_ENTITY_RESOLUTIONS = [
  'conversation',
  'person',
  'kit-kind',
  'raw-evidence',
] as const;

export const IMPORT_MANIFEST_STATUSES: readonly ImportManifestStatus[] = [
  'planned',
  'ok',
  'mismatch',
] as const;

/**
 * The identifier-preservation states — the W095 unified-identity
 * verification SEMANTICS re-used for cross-system mapping (verified /
 * unverified), with the W094 work order's `unverified-external` name
 * for the never-auto-merged side.
 */
export const IDENTITY_MAPPING_STATES: readonly IdentityMappingState[] = [
  'verified',
  'unverified-external',
] as const;

/** The W095 vocabulary this module's states are derived from (exported for the discipline probe). */
export const REUSED_UNIFIED_IDENTITY_STATUSES: readonly string[] = UNIFIED_STATUSES;

export const IDENTITY_MATCH_BASES = [
  'import-created',
  'sync-created',
  'ambiguous-candidates',
  'conflicting-attributes',
  'human-resolution',
] as const;

export const SYNC_RUN_STATUSES: readonly SyncRunStatus[] = ['completed', 'failed'] as const;

export const MIGRATION_CONFLICT_TAXONOMIES: readonly MigrationConflictTaxonomy[] = [
  'concurrent-update',
  'delete-vs-update',
  'back-write-refused',
] as const;

export const MIGRATION_CONFLICT_STATUSES: readonly MigrationConflictStatus[] = [
  'open',
  'resolved',
] as const;

export const RETIREMENT_WINDOW_STATUSES: readonly RetirementWindowStatus[] = [
  'open',
  'retired',
  'rolled-back',
] as const;

export const MIGRATION_EVENT_TYPES: readonly MigrationEventType[] = [
  'staged',
  'imported',
  'import-mismatch',
  'dual-run-started',
  'sync-completed',
  'conflict-detected',
  'conflict-resolved',
  'back-write-blocked',
  'comparison-recorded',
  'retirement-window-opened',
  'kind-retired',
  'authority-transferred',
  'rollback',
  'retired',
  'mapping-ambiguity-resolved',
] as const;

// ---------------------------------------------------------------------------
// Limits (honest bounds, mirrored where the SQL CHECKs can express them)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_BATCHES = 32;
export const MAX_RECORDS_PER_BATCH = 500;
export const MAX_TARGET_LENGTH = 256;
export const MIN_TARGET_LENGTH = 1;
export const MAX_ENTITY_KIND_LENGTH = 128;
export const MIN_ENTITY_KIND_LENGTH = 1;
export const MAX_INCUMBENT_ID_LENGTH = 200;
export const MIN_INCUMBENT_ID_LENGTH = 1;
export const MAX_CAPABILITY_KEY_LENGTH = 128;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MIN_TASK_DESCRIPTION_LENGTH = 4;
export const MAX_REQUESTED_FOR_LENGTH = 200;
export const MAX_REASON_LENGTH = 2000;
export const MIN_REASON_LENGTH = 4;
export const MAX_NOTE_LENGTH = 2000;
export const MIN_NOTE_LENGTH = 4;
export const MAX_DETAIL_LENGTH = 2000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MIN_IDEMPOTENCY_KEY_LENGTH = 2;
/** The canonical-value ceiling riding transport states (the W084 bound). */
export const MAX_VALUE_BYTES = 524_288;

// ---------------------------------------------------------------------------
// Primitives (the house shapes)
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

/** Structural plain-JSON check (a provider object never crosses — lock 16). */
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

function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new MigrationContinuityError('invalid_input', `'${field}' must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new MigrationContinuityError(
      'invalid_input',
      `'${field}' must be between ${min} and ${max} characters after trimming`,
    );
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, min, max);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new MigrationContinuityError('invalid_input', `'${field}' must be a uuid`);
  }
  return value;
}

function requireLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new MigrationContinuityError(
      'invalid_query',
      `'${field}' must be an integer between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new MigrationContinuityError(
        'invalid_input',
        `'${field}' has an unknown property '${key}' (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isMigrationTransitionKind(value: unknown): value is MigrationTransitionKind {
  return (
    typeof value === 'string' && (MIGRATION_TRANSITION_KINDS as readonly string[]).includes(value)
  );
}

export function isImportManifestStatus(value: unknown): value is ImportManifestStatus {
  return (
    typeof value === 'string' && (IMPORT_MANIFEST_STATUSES as readonly string[]).includes(value)
  );
}

export function isIdentityMappingState(value: unknown): value is IdentityMappingState {
  return typeof value === 'string' && (IDENTITY_MAPPING_STATES as readonly string[]).includes(value);
}

export function isSyncRunStatus(value: unknown): value is SyncRunStatus {
  return typeof value === 'string' && (SYNC_RUN_STATUSES as readonly string[]).includes(value);
}

export function isMigrationConflictTaxonomy(
  value: unknown,
): value is MigrationConflictTaxonomy {
  return (
    typeof value === 'string' &&
    (MIGRATION_CONFLICT_TAXONOMIES as readonly string[]).includes(value)
  );
}

export function isMigrationConflictStatus(value: unknown): value is MigrationConflictStatus {
  return (
    typeof value === 'string' &&
    (MIGRATION_CONFLICT_STATUSES as readonly string[]).includes(value)
  );
}

export function isRetirementWindowStatus(value: unknown): value is RetirementWindowStatus {
  return (
    typeof value === 'string' &&
    (RETIREMENT_WINDOW_STATUSES as readonly string[]).includes(value)
  );
}

export function isMigrationEventType(value: unknown): value is MigrationEventType {
  return typeof value === 'string' && (MIGRATION_EVENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The tenant-context assertion (the house pattern)
// ---------------------------------------------------------------------------

export function assertMigrationContinuityTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    !isUuid(ctx.tenantId) ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.length === 0 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new MigrationContinuityError(
      'invalid_context',
      'a valid TenantContext (tenantId, principalId, authority) is required',
    );
  }
}

/** Claim gate for the trust operations (the interim authority model). */
export function requireAdminister(ctx: TenantContext, operation: string): void {
  if (!ctx.authority.includes('migration-continuity:administer')) {
    throw new MigrationContinuityError(
      'forbidden',
      `'${operation}' requires the 'migration-continuity:administer' claim`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input validators
// ---------------------------------------------------------------------------

export interface ValidatedTaskContext {
  description: string;
  requestedFor: string | null;
}

export function validateTaskContext(value: unknown, field: string): ValidatedTaskContext {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, ['description', 'requestedFor'], field);
  const description = requireString(
    value.description,
    `${field}.description`,
    MIN_TASK_DESCRIPTION_LENGTH,
    MAX_TASK_DESCRIPTION_LENGTH,
  );
  const requestedFor = optionalString(
    value.requestedFor,
    `${field}.requestedFor`,
    1,
    MAX_REQUESTED_FOR_LENGTH,
  );
  return { description, requestedFor };
}

export interface ValidatedBatchPlan {
  target: string;
  entityKind: string;
}

function validateBatchPlan(value: unknown, field: string): ValidatedBatchPlan {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, ['target', 'entityKind'], field);
  const target = requireString(value.target, `${field}.target`, MIN_TARGET_LENGTH, MAX_TARGET_LENGTH);
  const entityKind = requireString(
    value.entityKind,
    `${field}.entityKind`,
    MIN_ENTITY_KIND_LENGTH,
    MAX_ENTITY_KIND_LENGTH,
  );
  return { target, entityKind };
}

export interface ValidatedStageInput {
  systemId: string;
  connectionId: string;
  readCapabilityKey: string;
  writeCapabilityKey: string | null;
  taskContext: ValidatedTaskContext;
  batches: ValidatedBatchPlan[];
  idempotencyKey: string | null;
}

export function validateStageMigrationInput(value: unknown): ValidatedStageInput {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', 'the staging input must be an object');
  }
  rejectUnknownKeys(
    value,
    [
      'systemId',
      'connectionId',
      'readCapabilityKey',
      'writeCapabilityKey',
      'taskContext',
      'batches',
      'idempotencyKey',
    ],
    'stageMigration input',
  );
  const systemId = requireUuid(value.systemId, 'systemId');
  const connectionId = requireUuid(value.connectionId, 'connectionId');
  const readCapabilityKey = requireString(
    value.readCapabilityKey,
    'readCapabilityKey',
    1,
    MAX_CAPABILITY_KEY_LENGTH,
  );
  const writeCapabilityKey = optionalString(
    value.writeCapabilityKey,
    'writeCapabilityKey',
    1,
    MAX_CAPABILITY_KEY_LENGTH,
  );
  const taskContext = validateTaskContext(value.taskContext, 'taskContext');
  if (!Array.isArray(value.batches) || value.batches.length < 1 || value.batches.length > MAX_BATCHES) {
    throw new MigrationContinuityError(
      'invalid_input',
      `'batches' must hold between 1 and ${MAX_BATCHES} drafted batches`,
    );
  }
  const batches = value.batches.map((batch, index) => validateBatchPlan(batch, `batches[${index}]`));
  const idempotencyKey = optionalString(
    value.idempotencyKey,
    'idempotencyKey',
    MIN_IDEMPOTENCY_KEY_LENGTH,
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  return { systemId, connectionId, readCapabilityKey, writeCapabilityKey, taskContext, batches, idempotencyKey };
}

export interface ValidatedMigrationTarget {
  migrationId: string;
}

export function validateMigrationTarget(value: unknown, field = 'input'): ValidatedMigrationTarget {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, ['migrationId'], field);
  return { migrationId: requireUuid(value.migrationId, `${field}.migrationId`) };
}

export interface ValidatedCompareInput {
  migrationId: string;
  entityKind: string;
}

export function validateCompareMigrationInput(value: unknown): ValidatedCompareInput {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', 'the comparison input must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'entityKind'], 'compareMigration input');
  const migrationId = requireUuid(value.migrationId, 'migrationId');
  const entityKind = requireString(
    value.entityKind,
    'entityKind',
    MIN_ENTITY_KIND_LENGTH,
    MAX_ENTITY_KIND_LENGTH,
  );
  return { migrationId, entityKind };
}

export function validateRetirementKindInput(value: unknown): ValidatedCompareInput {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', 'the retirement input must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'entityKind'], 'retirement input');
  const migrationId = requireUuid(value.migrationId, 'migrationId');
  const entityKind = requireString(
    value.entityKind,
    'entityKind',
    MIN_ENTITY_KIND_LENGTH,
    MAX_ENTITY_KIND_LENGTH,
  );
  return { migrationId, entityKind };
}

export interface ValidatedRollbackInput {
  migrationId: string;
  reason: string;
}

export function validateRollbackMigrationInput(value: unknown): ValidatedRollbackInput {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', 'the rollback input must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'reason'], 'rollbackMigration input');
  const migrationId = requireUuid(value.migrationId, 'migrationId');
  const reason = requireString(value.reason, 'reason', MIN_REASON_LENGTH, MAX_REASON_LENGTH);
  return { migrationId, reason };
}

export interface ValidatedResolveAmbiguityInput {
  mappingId: string;
  aurumId: string;
  note: string;
}

export function validateResolveMappingAmbiguityInput(value: unknown): ValidatedResolveAmbiguityInput {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', 'the resolution input must be an object');
  }
  rejectUnknownKeys(value, ['mappingId', 'aurumId', 'note'], 'resolveMappingAmbiguity input');
  const mappingId = requireUuid(value.mappingId, 'mappingId');
  const aurumId = requireUuid(value.aurumId, 'aurumId');
  const note = requireString(value.note, 'note', MIN_NOTE_LENGTH, MAX_NOTE_LENGTH);
  return { mappingId, aurumId, note };
}

export interface ValidatedResolveConflictInput {
  conflictId: string;
  resolution: 'incumbent' | 'aurum';
  note: string;
}

export function validateResolveConflictInput(value: unknown): ValidatedResolveConflictInput {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_input', 'the resolution input must be an object');
  }
  rejectUnknownKeys(value, ['conflictId', 'resolution', 'note'], 'resolveConflict input');
  const conflictId = requireUuid(value.conflictId, 'conflictId');
  if (value.resolution !== 'incumbent' && value.resolution !== 'aurum') {
    throw new MigrationContinuityError(
      'invalid_input',
      "'resolution' must be 'incumbent' or 'aurum' — a human decides, never the module",
    );
  }
  const note = requireString(value.note, 'note', MIN_NOTE_LENGTH, MAX_NOTE_LENGTH);
  return { conflictId, resolution: value.resolution, note };
}

// ---------------------------------------------------------------------------
// Query validators
// ---------------------------------------------------------------------------

export interface ValidatedGetQuery {
  migrationId: string;
}

export function validateGetMigrationQuery(value: unknown): ValidatedGetQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId'], 'query');
  return { migrationId: requireUuid(value.migrationId, 'query.migrationId') };
}

export interface ValidatedListMigrationsQuery {
  state: MigrationState | null;
  limit: number;
}

export function validateListMigrationsQuery(value: unknown): ValidatedListMigrationsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['state', 'limit'], 'query');
  let state: MigrationState | null = null;
  if (value.state !== undefined && value.state !== null) {
    if (!isMigrationState(value.state)) {
      throw new MigrationContinuityError(
        'invalid_query',
        `'state' must be one of ${MIGRATION_STATES.join(', ')}`,
      );
    }
    state = value.state;
  }
  return { state, limit: requireLimit(value.limit, 'limit') };
}

export interface ValidatedListTransitionsQuery {
  migrationId: string;
  limit: number;
}

export function validateListTransitionsQuery(value: unknown): ValidatedListTransitionsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'limit'], 'query');
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    limit: requireLimit(value.limit, 'limit'),
  };
}

export interface ValidatedListManifestsQuery {
  migrationId: string | null;
  status: ImportManifestStatus | null;
  limit: number;
}

export function validateListManifestsQuery(value: unknown): ValidatedListManifestsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'status', 'limit'], 'query');
  const migrationId =
    value.migrationId === undefined || value.migrationId === null
      ? null
      : requireUuid(value.migrationId, 'query.migrationId');
  let status: ImportManifestStatus | null = null;
  if (value.status !== undefined && value.status !== null) {
    if (!isImportManifestStatus(value.status)) {
      throw new MigrationContinuityError(
        'invalid_query',
        `'status' must be one of ${IMPORT_MANIFEST_STATUSES.join(', ')}`,
      );
    }
    status = value.status;
  }
  return { migrationId, status, limit: requireLimit(value.limit, 'limit') };
}

export interface ValidatedListMappingsQuery {
  migrationId: string | null;
  state: IdentityMappingState | null;
  limit: number;
}

export function validateListMappingsQuery(value: unknown): ValidatedListMappingsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'state', 'limit'], 'query');
  const migrationId =
    value.migrationId === undefined || value.migrationId === null
      ? null
      : requireUuid(value.migrationId, 'query.migrationId');
  let state: IdentityMappingState | null = null;
  if (value.state !== undefined && value.state !== null) {
    if (!isIdentityMappingState(value.state)) {
      throw new MigrationContinuityError(
        'invalid_query',
        `'state' must be one of ${IDENTITY_MAPPING_STATES.join(', ')}`,
      );
    }
    state = value.state;
  }
  return { migrationId, state, limit: requireLimit(value.limit, 'limit') };
}

export interface ValidatedGetByIdQuery {
  id: string;
}

export function validateGetByIdQuery(
  value: unknown,
  field: string,
): ValidatedGetByIdQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  const key = field === 'mappingId' ? 'mappingId' : field === 'conflictId' ? 'conflictId' : 'migrationId';
  rejectUnknownKeys(value, [key], 'query');
  return { id: requireUuid((value as Record<string, unknown>)[key], `query.${key}`) };
}

export interface ValidatedListSyncRunsQuery {
  migrationId: string | null;
  limit: number;
}

export function validateListSyncRunsQuery(value: unknown): ValidatedListSyncRunsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'limit'], 'query');
  const migrationId =
    value.migrationId === undefined || value.migrationId === null
      ? null
      : requireUuid(value.migrationId, 'query.migrationId');
  return { migrationId, limit: requireLimit(value.limit, 'limit') };
}

export interface ValidatedListConflictsQuery {
  migrationId: string | null;
  entityKind: string | null;
  status: MigrationConflictStatus | null;
  limit: number;
}

export function validateListConflictsQuery(value: unknown): ValidatedListConflictsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'entityKind', 'status', 'limit'], 'query');
  const migrationId =
    value.migrationId === undefined || value.migrationId === null
      ? null
      : requireUuid(value.migrationId, 'query.migrationId');
  const entityKind =
    value.entityKind === undefined || value.entityKind === null
      ? null
      : requireString(value.entityKind, 'query.entityKind', MIN_ENTITY_KIND_LENGTH, MAX_ENTITY_KIND_LENGTH);
  let status: MigrationConflictStatus | null = null;
  if (value.status !== undefined && value.status !== null) {
    if (!isMigrationConflictStatus(value.status)) {
      throw new MigrationContinuityError(
        'invalid_query',
        `'status' must be one of ${MIGRATION_CONFLICT_STATUSES.join(', ')}`,
      );
    }
    status = value.status;
  }
  return { migrationId, entityKind, status, limit: requireLimit(value.limit, 'limit') };
}

export interface ValidatedListReportsQuery {
  migrationId: string | null;
  entityKind: string | null;
  limit: number;
}

export function validateListReportsQuery(value: unknown, kindField: string): ValidatedListReportsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'entityKind', 'limit'], 'query');
  const migrationId =
    value.migrationId === undefined || value.migrationId === null
      ? null
      : requireUuid(value.migrationId, 'query.migrationId');
  const entityKind =
    value.entityKind === undefined || value.entityKind === null
      ? null
      : requireString(value.entityKind, `query.${kindField}`, MIN_ENTITY_KIND_LENGTH, MAX_ENTITY_KIND_LENGTH);
  return { migrationId, entityKind, limit: requireLimit(value.limit, 'limit') };
}

export interface ValidatedListEventsQuery {
  migrationId: string;
  limit: number;
}

export function validateListEventsQuery(value: unknown): ValidatedListEventsQuery {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(value, ['migrationId', 'limit'], 'query');
  return {
    migrationId: requireUuid(value.migrationId, 'query.migrationId'),
    limit: requireLimit(value.limit, 'limit'),
  };
}

// ---------------------------------------------------------------------------
// Incumbent-record shape validation (the landing ladder's entry guard)
// ---------------------------------------------------------------------------

/** The canonical conversation-thread record the incumbent serves. */
export interface ValidatedIncumbentConversationRecord {
  incumbentId: string;
  updatedAt: string | null;
  channel: string;
  subject: string | null;
  turns: {
    turnId: string;
    direction: 'inbound' | 'outbound';
    actorLabel: string | null;
    sentAt: string;
    payload: unknown;
  }[];
}

/** The canonical person record the incumbent serves. */
export interface ValidatedIncumbentPersonRecord {
  incumbentId: string;
  updatedAt: string | null;
  fullName: string;
  email: string | null;
}

/** Any incumbent record: an object carrying a stable opaque id. */
export interface ValidatedIncumbentRecord {
  incumbentId: string;
  updatedAt: string | null;
  record: Record<string, unknown>;
}

/** Parses the envelope every incumbent record shares (id + own clock). */
export function validateIncumbentRecord(value: unknown): ValidatedIncumbentRecord {
  if (!isPlainObject(value)) {
    throw new MigrationContinuityError(
      'invalid_transport_result',
      'an incumbent record must be a plain JSON object',
    );
  }
  const incumbentId = requireString(
    value.incumbentId,
    'record.incumbentId',
    MIN_INCUMBENT_ID_LENGTH,
    MAX_INCUMBENT_ID_LENGTH,
  );
  const updatedAt =
    typeof value.updatedAt === 'string' && value.updatedAt.length > 0 ? value.updatedAt : null;
  return { incumbentId, updatedAt, record: value };
}

/**
 * Parses a conversation-thread record; null when the record does not
 * carry the canonical shape (channel from the identity vocabulary,
 * turns with direction/sender clock) — the ladder then keeps it raw
 * evidence, never guessing semantics.
 */
export function parseConversationRecord(
  record: Record<string, unknown>,
): ValidatedIncumbentConversationRecord | null {
  if (typeof record.channel !== 'string' || !isChannelProvider(record.channel)) return null;
  if (!Array.isArray(record.turns) || record.turns.length === 0) return null;
  const turns: ValidatedIncumbentConversationRecord['turns'] = [];
  for (const entry of record.turns) {
    if (!isPlainObject(entry)) return null;
    if (entry.direction !== 'inbound' && entry.direction !== 'outbound') return null;
    if (typeof entry.turnId !== 'string' || entry.turnId.length === 0 || entry.turnId.length > MAX_INCUMBENT_ID_LENGTH) {
      return null;
    }
    if (typeof entry.sentAt !== 'string' || Number.isNaN(Date.parse(entry.sentAt))) return null;
    if (entry.payload === undefined) return null;
    turns.push({
      turnId: entry.turnId,
      direction: entry.direction,
      actorLabel:
        typeof entry.actorLabel === 'string' && entry.actorLabel.length > 0 ? entry.actorLabel : null,
      // Normalized to the canonical ISO form: the Aurum read-back of a
      // landed turn renders the same string, so the canonical versions
      // compare structurally (the checksum discipline).
      sentAt: new Date(entry.sentAt).toISOString(),
      payload: entry.payload,
    });
  }
  const subject =
    typeof record.subject === 'string' && record.subject.length > 0 && record.subject.length <= 200
      ? record.subject
      : null;
  return {
    incumbentId: String(record.incumbentId),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    channel: record.channel,
    subject,
    turns,
  };
}

/**
 * Parses a person record; null when the record does not carry the
 * canonical shape (a full name) — the ladder then keeps it raw
 * evidence, never guessing semantics.
 */
export function parsePersonRecord(
  record: Record<string, unknown>,
): ValidatedIncumbentPersonRecord | null {
  if (typeof record.fullName !== 'string' || record.fullName.trim().length === 0) return null;
  if (record.fullName.trim().length > 200) return null;
  const email =
    typeof record.email === 'string' && record.email.length > 0 && record.email.length <= 320
      ? record.email
      : null;
  return {
    incumbentId: String(record.incumbentId),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    fullName: record.fullName.trim(),
    email,
  };
}
