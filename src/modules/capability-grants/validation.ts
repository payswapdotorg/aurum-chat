// Pure validation/normalization logic of the capability-grants module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK constraints
// in migrations/001 mirror the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller can
// never smuggle `id`, `tenantId`, timestamps, reasons or scope content into
// records — identity, tenancy, scope detail and human-readable reasons are
// minted by the system from validated inventory surfaces and task contexts.

import type { TenantContext } from '@/infra/tenant';
import { CapabilityGrantsError } from './errors';
import type {
  CapabilityDescriptor,
  CapabilityMode,
  DecideGrantRequestInput,
  EstablishAccessInput,
  GetAccessQuery,
  GetGrantQuery,
  GetGrantRequestQuery,
  GetInvocationQuery,
  GrantEventType,
  GrantRequestStatus,
  GrantStatus,
  InvokeCapabilityInput,
  InvocationOutcome,
  ListGrantEventsQuery,
  ListGrantRequestsQuery,
  ListGrantsQuery,
  ListInvocationsQuery,
  RequestAuthorityInput,
  RevokeGrantInput,
  TaskContext,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const GRANT_REQUEST_STATUSES = ['pending_approval', 'approved', 'rejected'] as const;
export const GRANT_STATUSES = ['active', 'revoked'] as const;
export const INVOCATION_OUTCOMES = ['allowed', 'denied'] as const;
export const INVOCATION_BASES = ['read-only-floor', 'capability-grant', 'grant-missing'] as const;
export const CAPABILITY_MODES = ['read', 'write'] as const;
export const GRANT_EVENT_TYPES = [
  'access-established',
  'authority-requested',
  'authority-granted',
  'authority-rejected',
  'authority-revoked',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_CAPABILITY_KEYS = 32;
export const MIN_TASK_DESCRIPTION_LENGTH = 1;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MAX_REQUESTED_FOR_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_CAPABILITY_KEY_LENGTH = 128;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isGrantRequestStatus(value: unknown): value is GrantRequestStatus {
  return (
    typeof value === 'string' && (GRANT_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export function isGrantStatus(value: unknown): value is GrantStatus {
  return typeof value === 'string' && (GRANT_STATUSES as readonly string[]).includes(value);
}

export function isInvocationOutcome(value: unknown): value is InvocationOutcome {
  return (
    typeof value === 'string' && (INVOCATION_OUTCOMES as readonly string[]).includes(value)
  );
}

export function isCapabilityMode(value: unknown): value is CapabilityMode {
  return typeof value === 'string' && (CAPABILITY_MODES as readonly string[]).includes(value);
}

export function isGrantEventType(value: unknown): value is GrantEventType {
  return typeof value === 'string' && (GRANT_EVENT_TYPES as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertGrantsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new CapabilityGrantsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new CapabilityGrantsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new CapabilityGrantsError(
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
      throw new CapabilityGrantsError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new CapabilityGrantsError('invalid_input', `'${field}' must be a uuid`);
  }
  return value;
}

function requireCapabilityKey(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_CAPABILITY_KEY_LENGTH
  ) {
    throw new CapabilityGrantsError(
      'invalid_input',
      `'${field}' must be a non-empty string of at most ${MAX_CAPABILITY_KEY_LENGTH} characters`,
    );
  }
  return value.trim();
}

function optionalNote(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CapabilityGrantsError(
      'invalid_input',
      `'${field}' must be a non-empty string or null`,
    );
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new CapabilityGrantsError(
      'invalid_input',
      `'${field}' must be at most ${MAX_NOTE_LENGTH} characters`,
    );
  }
  return value;
}

function optionalLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CapabilityGrantsError('invalid_input', `'${field}' must be an integer`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new CapabilityGrantsError(
      'invalid_input',
      `'${field}' must be between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Task contexts
// ---------------------------------------------------------------------------

const TASK_CONTEXT_KEYS = ['description', 'requestedFor'] as const;

export interface ValidatedTaskContext {
  description: string;
  requestedFor: string | null;
}

/** Validates a concrete-task context (the "why" every ask/invocation carries). */
export function validateTaskContext(value: unknown, field: string): ValidatedTaskContext {
  if (!isPlainObject(value)) {
    throw new CapabilityGrantsError('invalid_input', `'${field}' must be an object`);
  }
  rejectUnknownKeys(value, TASK_CONTEXT_KEYS, field);
  const description = value.description;
  if (
    typeof description !== 'string' ||
    description.trim().length < MIN_TASK_DESCRIPTION_LENGTH ||
    description.trim().length > MAX_TASK_DESCRIPTION_LENGTH
  ) {
    throw new CapabilityGrantsError(
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
      throw new CapabilityGrantsError(
        'invalid_input',
        `'${field}.requestedFor' must be a non-empty string of at most ${MAX_REQUESTED_FOR_LENGTH} characters`,
      );
    }
    requestedFor = value.requestedFor.trim();
  }
  return { description: description.trim(), requestedFor };
}

/** Re-freezes a validated task context into its persisted shape. */
export function taskContextToRecord(task: ValidatedTaskContext): TaskContext {
  return { description: task.description, requestedFor: task.requestedFor };
}

// ---------------------------------------------------------------------------
// Capability key lists
// ---------------------------------------------------------------------------

/** Validates a caller-supplied capability-key list (deduplicated, ordered). */
export function validateCapabilityKeys(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPABILITY_KEYS) {
    throw new CapabilityGrantsError(
      'invalid_input',
      `'${field}' must be an array of 1..${MAX_CAPABILITY_KEYS} capability keys`,
    );
  }
  const keys: string[] = [];
  for (const entry of value) {
    const key = requireCapabilityKey(entry, `${field}[]`);
    if (keys.includes(key)) {
      throw new CapabilityGrantsError(
        'invalid_input',
        `'${field}' contains duplicate '${key}'`,
      );
    }
    keys.push(key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

const ESTABLISH_INPUT_KEYS = ['connectionId'] as const;
const GET_ACCESS_QUERY_KEYS = ['connectionId'] as const;

export function validateEstablishAccessInput(input: EstablishAccessInput): { connectionId: string } {
  if (!isPlainObject(input)) {
    throw new CapabilityGrantsError('invalid_input', 'establish input must be an object');
  }
  rejectUnknownKeys(input, ESTABLISH_INPUT_KEYS, 'establish input');
  return { connectionId: requireUuid(input.connectionId, 'connectionId') };
}

export function validateGetAccessQuery(query: GetAccessQuery): { connectionId: string } {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'access query must be an object');
  }
  rejectUnknownKeys(query, GET_ACCESS_QUERY_KEYS, 'access query');
  return { connectionId: requireUuid(query.connectionId, 'connectionId') };
}

// ---------------------------------------------------------------------------
// Authority requests
// ---------------------------------------------------------------------------

const REQUEST_AUTHORITY_INPUT_KEYS = ['connectionId', 'capabilityKeys', 'taskContext'] as const;
const DECIDE_INPUT_KEYS = ['requestId', 'decision', 'note'] as const;
const GET_REQUEST_QUERY_KEYS = ['requestId'] as const;
const LIST_REQUESTS_QUERY_KEYS = ['connectionId', 'status', 'limit'] as const;

export interface ValidatedRequestAuthorityInput {
  connectionId: string;
  capabilityKeys: string[];
  taskContext: ValidatedTaskContext;
}

export function validateRequestAuthorityInput(input: RequestAuthorityInput): ValidatedRequestAuthorityInput {
  if (!isPlainObject(input)) {
    throw new CapabilityGrantsError('invalid_input', 'authority request input must be an object');
  }
  rejectUnknownKeys(input, REQUEST_AUTHORITY_INPUT_KEYS, 'authority request input');
  return {
    connectionId: requireUuid(input.connectionId, 'connectionId'),
    capabilityKeys: validateCapabilityKeys(input.capabilityKeys, 'capabilityKeys'),
    taskContext: validateTaskContext(input.taskContext, 'taskContext'),
  };
}

export interface ValidatedDecideInput {
  requestId: string;
  decision: 'approve' | 'reject';
  note: string | null;
}

export function validateDecideGrantRequestInput(input: DecideGrantRequestInput): ValidatedDecideInput {
  if (!isPlainObject(input)) {
    throw new CapabilityGrantsError('invalid_input', 'decision input must be an object');
  }
  rejectUnknownKeys(input, DECIDE_INPUT_KEYS, 'decision input');
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    throw new CapabilityGrantsError('invalid_input', "'decision' must be 'approve' or 'reject'");
  }
  return {
    requestId: requireUuid(input.requestId, 'requestId'),
    decision: input.decision,
    note: optionalNote(input.note, 'note'),
  };
}

export function validateGetGrantRequestQuery(query: GetGrantRequestQuery): { requestId: string } {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'grant request query must be an object');
  }
  rejectUnknownKeys(query, GET_REQUEST_QUERY_KEYS, 'grant request query');
  return { requestId: requireUuid(query.requestId, 'requestId') };
}

export interface ValidatedListRequestsQuery {
  connectionId: string | null;
  status: GrantRequestStatus | null;
  limit: number;
}

export function validateListGrantRequestsQuery(query: ListGrantRequestsQuery): ValidatedListRequestsQuery {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'grant requests list query must be an object');
  }
  rejectUnknownKeys(query, LIST_REQUESTS_QUERY_KEYS, 'grant requests list query');
  let connectionId: string | null = null;
  if (query.connectionId !== undefined && query.connectionId !== null) {
    connectionId = requireUuid(query.connectionId, 'connectionId');
  }
  let status: GrantRequestStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isGrantRequestStatus(query.status)) {
      throw new CapabilityGrantsError(
        'invalid_input',
        `'status' must be one of ${GRANT_REQUEST_STATUSES.join('|')}`,
      );
    }
    status = query.status;
  }
  return { connectionId, status, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const REVOKE_INPUT_KEYS = ['grantId', 'note'] as const;
const GET_GRANT_QUERY_KEYS = ['grantId'] as const;
const LIST_GRANTS_QUERY_KEYS = ['connectionId', 'status', 'limit'] as const;

export function validateRevokeGrantInput(input: RevokeGrantInput): { grantId: string; note: string | null } {
  if (!isPlainObject(input)) {
    throw new CapabilityGrantsError('invalid_input', 'revoke input must be an object');
  }
  rejectUnknownKeys(input, REVOKE_INPUT_KEYS, 'revoke input');
  return {
    grantId: requireUuid(input.grantId, 'grantId'),
    note: optionalNote(input.note, 'note'),
  };
}

export function validateGetGrantQuery(query: GetGrantQuery): { grantId: string } {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'grant query must be an object');
  }
  rejectUnknownKeys(query, GET_GRANT_QUERY_KEYS, 'grant query');
  return { grantId: requireUuid(query.grantId, 'grantId') };
}

export interface ValidatedListGrantsQuery {
  connectionId: string | null;
  status: GrantStatus | null;
  limit: number;
}

export function validateListGrantsQuery(query: ListGrantsQuery): ValidatedListGrantsQuery {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'grants list query must be an object');
  }
  rejectUnknownKeys(query, LIST_GRANTS_QUERY_KEYS, 'grants list query');
  let connectionId: string | null = null;
  if (query.connectionId !== undefined && query.connectionId !== null) {
    connectionId = requireUuid(query.connectionId, 'connectionId');
  }
  let status: GrantStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isGrantStatus(query.status)) {
      throw new CapabilityGrantsError(
        'invalid_input',
        `'status' must be one of ${GRANT_STATUSES.join('|')}`,
      );
    }
    status = query.status;
  }
  return { connectionId, status, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Invocations
// ---------------------------------------------------------------------------

const INVOKE_INPUT_KEYS = ['connectionId', 'capabilityKey', 'taskContext'] as const;
const GET_INVOCATION_QUERY_KEYS = ['invocationId'] as const;
const LIST_INVOCATIONS_QUERY_KEYS = ['connectionId', 'capabilityKey', 'outcome', 'limit'] as const;

export interface ValidatedInvokeInput {
  connectionId: string;
  capabilityKey: string;
  taskContext: ValidatedTaskContext;
}

export function validateInvokeCapabilityInput(input: InvokeCapabilityInput): ValidatedInvokeInput {
  if (!isPlainObject(input)) {
    throw new CapabilityGrantsError('invalid_input', 'invocation input must be an object');
  }
  rejectUnknownKeys(input, INVOKE_INPUT_KEYS, 'invocation input');
  return {
    connectionId: requireUuid(input.connectionId, 'connectionId'),
    capabilityKey: requireCapabilityKey(input.capabilityKey, 'capabilityKey'),
    taskContext: validateTaskContext(input.taskContext, 'taskContext'),
  };
}

export function validateGetInvocationQuery(query: GetInvocationQuery): { invocationId: string } {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'invocation query must be an object');
  }
  rejectUnknownKeys(query, GET_INVOCATION_QUERY_KEYS, 'invocation query');
  return { invocationId: requireUuid(query.invocationId, 'invocationId') };
}

export interface ValidatedListInvocationsQuery {
  connectionId: string | null;
  capabilityKey: string | null;
  outcome: InvocationOutcome | null;
  limit: number;
}

export function validateListInvocationsQuery(query: ListInvocationsQuery): ValidatedListInvocationsQuery {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'invocations list query must be an object');
  }
  rejectUnknownKeys(query, LIST_INVOCATIONS_QUERY_KEYS, 'invocations list query');
  let connectionId: string | null = null;
  if (query.connectionId !== undefined && query.connectionId !== null) {
    connectionId = requireUuid(query.connectionId, 'connectionId');
  }
  let capabilityKey: string | null = null;
  if (query.capabilityKey !== undefined && query.capabilityKey !== null) {
    capabilityKey = requireCapabilityKey(query.capabilityKey, 'capabilityKey');
  }
  let outcome: InvocationOutcome | null = null;
  if (query.outcome !== undefined && query.outcome !== null) {
    if (!isInvocationOutcome(query.outcome)) {
      throw new CapabilityGrantsError(
        'invalid_input',
        `'outcome' must be one of ${INVOCATION_OUTCOMES.join('|')}`,
      );
    }
    outcome = query.outcome;
  }
  return { connectionId, capabilityKey, outcome, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Grant events
// ---------------------------------------------------------------------------

const LIST_EVENTS_QUERY_KEYS = ['connectionId', 'limit'] as const;

export function validateListGrantEventsQuery(query: ListGrantEventsQuery): {
  connectionId: string;
  limit: number;
} {
  if (!isPlainObject(query)) {
    throw new CapabilityGrantsError('invalid_input', 'grant events list query must be an object');
  }
  rejectUnknownKeys(query, LIST_EVENTS_QUERY_KEYS, 'grant events list query');
  return {
    connectionId: requireUuid(query.connectionId, 'connectionId'),
    limit: optionalLimit(query.limit, 'limit'),
  };
}

// ---------------------------------------------------------------------------
// Capability surface helpers (validated against the LIVE inventory surface)
// ---------------------------------------------------------------------------

/**
 * Splits a validated live capability surface into read/write partitions
 * (the establish-time envelope builder).
 */
export function partitionSurface(
  surface: readonly { key: string; mode: CapabilityMode }[],
): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  for (const capability of surface) {
    if (capability.mode === 'read') read.push(capability.key);
    else write.push(capability.key);
  }
  return { read, write };
}

/** Finds one capability on a surface by key (null when absent). */
export function findCapability(
  surface: readonly { key: string }[],
  key: string,
): { key: string } | null {
  return surface.find((capability) => capability.key === key) ?? null;
}

/**
 * Freezes a live surface capability into its persisted descriptor shape
 * (defensive copies — frozen records never alias live inventory data).
 */
export function toDescriptor(capability: {
  key: string;
  label: string;
  dataCategories: string[];
}): CapabilityDescriptor {
  return {
    key: capability.key,
    label: capability.label,
    dataCategories: [...capability.dataCategories],
  };
}
