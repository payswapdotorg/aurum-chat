// Pure validation/normalization logic of the deep-actions module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, timestamps, system descriptors,
// receipts or evidence links into records — identity, tenancy and the
// per-phase outcome links are minted by the system from validated
// cross-module state.

import type { TenantContext } from '@/infra/tenant';
import { DeepActionsError } from './errors';
import type {
  DeepActionEventType,
  DeepActionOperationState,
  DeepActionReceiptStatus,
  DeepActionStatus,
  DeepActionTaskContext,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const DEEP_ACTION_STATUSES = [
  'draft',
  'discovered',
  'inspected',
  'proposed',
  'authorized',
  'executed',
  'verified',
  'reconciled',
  'mismatched',
  'rejected',
  'failed',
] as const;

export const DEEP_ACTION_OPERATION_STATES = [
  'pending',
  'authorized',
  'denied',
  'executed',
  'verified',
  'matched',
  'mismatched',
  'failed',
] as const;

export const DEEP_ACTION_RECEIPT_STATUSES = ['accepted', 'rejected', 'failed'] as const;

export const DEEP_ACTION_EVENT_TYPES = [
  'created',
  'surface-discovered',
  'targets-inspected',
  'proposed',
  'gate-rejected',
  'authorized',
  'operation-denied',
  'operation-executed',
  'execution-failed',
  'executed',
  'verified',
  'reconciled',
  'mismatch-detected',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_OPERATIONS = 16;
export const MAX_OPERATION_KEY_LENGTH = 128;
export const MAX_TARGET_LENGTH = 200;
export const MAX_CAPABILITY_KEY_LENGTH = 128;
export const MIN_TASK_DESCRIPTION_LENGTH = 1;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MAX_REQUESTED_FOR_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_RECEIPT_ID_LENGTH = 200;
export const MAX_RECEIPT_DETAIL_LENGTH = 500;
/** Canonical payload/expectation size cap (256 KiB — modest jsonb). */
export const MAX_VALUE_BYTES = 262_144;

/** The write-capability prefix convention of the W081 vocabulary. */
const WRITE_CAPABILITY_PREFIX = 'write.';
/** The read-capability prefix convention of the W081 vocabulary. */
const READ_CAPABILITY_PREFIX = 'read.';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isDeepActionStatus(value: unknown): value is DeepActionStatus {
  return (
    typeof value === 'string' && (DEEP_ACTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeepActionOperationState(value: unknown): value is DeepActionOperationState {
  return (
    typeof value === 'string' &&
    (DEEP_ACTION_OPERATION_STATES as readonly string[]).includes(value)
  );
}

export function isDeepActionReceiptStatus(value: unknown): value is DeepActionReceiptStatus {
  return (
    typeof value === 'string' &&
    (DEEP_ACTION_RECEIPT_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeepActionEventType(value: unknown): value is DeepActionEventType {
  return (
    typeof value === 'string' && (DEEP_ACTION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertDeepActionsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new DeepActionsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new DeepActionsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new DeepActionsError(
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

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new DeepActionsError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new DeepActionsError('invalid_input', `'${field}' must be a uuid`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' must match ${IDEMPOTENCY_KEY_PATTERN.source}`,
    );
  }
  return value;
}

function optionalLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DeepActionsError('invalid_input', `'${field}' must be an integer`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' must be between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

/**
 * A bounded plain JSON value: JSON-serializable, non-null, and within the
 * module's canonical value cap (payloads and expectations stay modest;
 * large artifacts belong in object storage — the W004 discipline).
 */
function requireBoundedJsonValue(value: unknown, field: string): unknown {
  if (value === undefined || value === null) {
    throw new DeepActionsError('invalid_input', `'${field}' must be a non-null JSON value`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' must be JSON-serializable (a provider object, class instance or cycle cannot cross the gateway)`,
    );
  }
  if (serialized === undefined) {
    throw new DeepActionsError('invalid_input', `'${field}' must be JSON-serializable`);
  }
  if (serialized.length > MAX_VALUE_BYTES) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' exceeds the maximum of ${MAX_VALUE_BYTES} bytes (${serialized.length}); large artifacts belong in object storage`,
    );
  }
  return value;
}

function requirePlainJsonObject(value: unknown, field: string): Record<string, unknown> {
  const bounded = requireBoundedJsonValue(value, field);
  if (!isPlainObject(bounded)) {
    throw new DeepActionsError('invalid_input', `'${field}' must be a plain JSON object`);
  }
  return bounded;
}

// ---------------------------------------------------------------------------
// Task contexts (mirrors the W083 shape — the frozen what-and-why)
// ---------------------------------------------------------------------------

const TASK_CONTEXT_KEYS = ['description', 'requestedFor'] as const;

export interface ValidatedTaskContext {
  description: string;
  requestedFor: string | null;
}

/** Validates a concrete-task context (the what-and-why every gate sees). */
export function validateDeepActionTaskContext(
  value: unknown,
  field: string,
): ValidatedTaskContext {
  if (!isPlainObject(value)) {
    throw new DeepActionsError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, TASK_CONTEXT_KEYS, field);
  const description = value.description;
  if (
    typeof description !== 'string' ||
    description.trim().length < MIN_TASK_DESCRIPTION_LENGTH ||
    description.trim().length > MAX_TASK_DESCRIPTION_LENGTH
  ) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}.description' must be a non-empty string of at most ${MAX_TASK_DESCRIPTION_LENGTH} characters`,
    );
  }
  let requestedFor: string | null = null;
  if (value.requestedFor !== undefined && value.requestedFor !== null) {
    if (
      typeof value.requestedFor !== 'string' ||
      value.requestedFor.trim().length === 0 ||
      value.requestedFor.length > MAX_REQUESTED_FOR_LENGTH
    ) {
      throw new DeepActionsError(
        'invalid_input',
        `'${field}.requestedFor' must be a non-empty string of at most ${MAX_REQUESTED_FOR_LENGTH} characters`,
      );
    }
    requestedFor = value.requestedFor.trim();
  }
  return { description: description.trim(), requestedFor };
}

/** Re-freezes a validated task context into its persisted shape. */
export function taskContextToRecord(task: ValidatedTaskContext): DeepActionTaskContext {
  return { description: task.description, requestedFor: task.requestedFor };
}

// ---------------------------------------------------------------------------
// Operations (the plan — frozen at creation)
// ---------------------------------------------------------------------------

const OPERATION_INPUT_KEYS = [
  'key',
  'connectionId',
  'capabilityKey',
  'target',
  'payload',
  'expectation',
] as const;

export interface ValidatedOperationInput {
  key: string;
  connectionId: string;
  capabilityKey: string;
  target: string;
  payload: Record<string, unknown>;
  expectation: Record<string, unknown>;
}

function requireOperationKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPERATION_KEY_PATTERN.test(value)) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' must match ${OPERATION_KEY_PATTERN.source}`,
    );
  }
  return value;
}

function requireTarget(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TARGET_LENGTH) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' must be a non-empty string of at most ${MAX_TARGET_LENGTH} characters (the opaque external entity reference)`,
    );
  }
  return value.trim();
}

function requireWriteCapabilityKey(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(WRITE_CAPABILITY_PREFIX) ||
    value.length <= WRITE_CAPABILITY_PREFIX.length ||
    value.length > MAX_CAPABILITY_KEY_LENGTH
  ) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}' must be a WRITE capability key of the W081 vocabulary ('${WRITE_CAPABILITY_PREFIX}<class>', at most ${MAX_CAPABILITY_KEY_LENGTH} characters)`,
    );
  }
  return value;
}

/** Derives the READ capability key of a write capability's class. */
export function readCapabilityKeyOf(writeCapabilityKey: string): string {
  return READ_CAPABILITY_PREFIX + writeCapabilityKey.slice(WRITE_CAPABILITY_PREFIX.length);
}

/** Validates one planned operation of the task's plan. */
export function validateOperationInput(value: unknown, field: string): ValidatedOperationInput {
  if (!isPlainObject(value)) {
    throw new DeepActionsError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, OPERATION_INPUT_KEYS, field);
  const key = requireOperationKey(value.key, `${field}.key`);
  const connectionId = requireUuid(value.connectionId, `${field}.connectionId`);
  const capabilityKey = requireWriteCapabilityKey(value.capabilityKey, `${field}.capabilityKey`);
  const target = requireTarget(value.target, `${field}.target`);
  const payload = requirePlainJsonObject(value.payload, `${field}.payload`);
  const expectation = requirePlainJsonObject(value.expectation, `${field}.expectation`);
  if (Object.keys(expectation).length === 0) {
    throw new DeepActionsError(
      'invalid_input',
      `'${field}.expectation' must hold at least one expected field — an unverifiable write is not a deep action`,
    );
  }
  return { key, connectionId, capabilityKey, target, payload, expectation };
}

// ---------------------------------------------------------------------------
// createDeepAction
// ---------------------------------------------------------------------------

const CREATE_INPUT_KEYS = ['taskContext', 'operations', 'idempotencyKey'] as const;

export interface ValidatedCreateInput {
  taskContext: ValidatedTaskContext;
  operations: ValidatedOperationInput[];
  idempotencyKey: string | null;
}

export function validateCreateDeepActionInput(
  input: unknown,
): ValidatedCreateInput {
  if (!isPlainObject(input)) {
    throw new DeepActionsError('invalid_input', 'the deep-action input must be an object');
  }
  rejectUnknownKeys(input, CREATE_INPUT_KEYS, 'the deep-action input');
  const taskContext = validateDeepActionTaskContext(input.taskContext, 'taskContext');
  if (!Array.isArray(input.operations) || input.operations.length < 1) {
    throw new DeepActionsError(
      'invalid_input',
      `'operations' must be an array of 1..${MAX_OPERATIONS} planned operations — a deep action writes at least once`,
    );
  }
  if (input.operations.length > MAX_OPERATIONS) {
    throw new DeepActionsError(
      'invalid_input',
      `'operations' must hold at most ${MAX_OPERATIONS} operations (got ${input.operations.length})`,
    );
  }
  const operations = input.operations.map((entry, index) =>
    validateOperationInput(entry, `operations[${index}]`),
  );
  const keys = new Set<string>();
  for (const operation of operations) {
    if (keys.has(operation.key)) {
      throw new DeepActionsError(
        'invalid_input',
        `duplicate operation key '${operation.key}' — operation keys are unique within a task`,
      );
    }
    keys.add(operation.key);
  }
  const idempotencyKey = optionalIdempotencyKey(input.idempotencyKey, 'idempotencyKey');
  return { taskContext, operations, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Phase-transition inputs (uniform taskId shape)
// ---------------------------------------------------------------------------

const TASK_ID_INPUT_KEYS = ['taskId'] as const;

export interface ValidatedTaskIdInput {
  taskId: string;
}

function validateTaskIdInput(input: unknown): ValidatedTaskIdInput {
  if (!isPlainObject(input)) {
    throw new DeepActionsError('invalid_input', 'the input must be an object');
  }
  rejectUnknownKeys(input, TASK_ID_INPUT_KEYS, 'the input');
  return { taskId: requireUuid(input.taskId, 'taskId') };
}

export function validateDiscoverSurfaceInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateInspectTargetsInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateProposeDeepActionInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateAuthorizeDeepActionInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateExecuteDeepActionInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateVerifyDeepActionInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

export function validateReconcileDeepActionInput(input: unknown): ValidatedTaskIdInput {
  return validateTaskIdInput(input);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ValidatedGetQuery {
  taskId: string;
}

export function validateGetDeepActionQuery(input: unknown): ValidatedGetQuery {
  if (!isPlainObject(input)) {
    throw new DeepActionsError('invalid_query', 'the query must be an object');
  }
  rejectUnknownKeys(input, ['taskId'], 'the query');
  return { taskId: requireUuid(input.taskId, 'taskId') };
}

export interface ValidatedListQuery {
  status: DeepActionStatus | null;
  limit: number;
}

export function validateListDeepActionsQuery(input: unknown): ValidatedListQuery {
  if (input === undefined || input === null) {
    return { status: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isPlainObject(input)) {
    throw new DeepActionsError('invalid_query', 'the list query must be an object');
  }
  rejectUnknownKeys(input, ['status', 'limit'], 'the list query');
  let status: DeepActionStatus | null = null;
  if (input.status !== undefined && input.status !== null) {
    if (!isDeepActionStatus(input.status)) {
      throw new DeepActionsError(
        'invalid_query',
        `'status' must be one of ${DEEP_ACTION_STATUSES.join(', ')}`,
      );
    }
    status = input.status;
  }
  return { status, limit: optionalLimit(input.limit, 'limit') };
}

export interface ValidatedListEventsQuery {
  taskId: string;
  limit: number;
}

export function validateListDeepActionEventsQuery(input: unknown): ValidatedListEventsQuery {
  if (!isPlainObject(input)) {
    throw new DeepActionsError('invalid_query', 'the events query must be an object');
  }
  rejectUnknownKeys(input, ['taskId', 'limit'], 'the events query');
  return {
    taskId: requireUuid(input.taskId, 'taskId'),
    limit: optionalLimit(input.limit, 'limit'),
  };
}
