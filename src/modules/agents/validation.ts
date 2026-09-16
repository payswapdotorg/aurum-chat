// Pure validation/normalization logic of the agents module (no database).
// Everything a caller may put into an agent definition, an execution
// submission, a cancellation or a query crosses these guards first; the
// SQL CHECK constraints and triggers in migrations/001–003 mirror the
// load-bearing rules as defense in depth (the actions/llm discipline).
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `submittedBy`, `submittedAt`, `policy`,
// `attemptsCount`, `result`, `costMinor` or `completedAt` into a
// submission — an execution's identity, tenancy, lifecycle state, gate
// decision and accounting are minted by the system (the submission is
// history the moment it is recorded; only the live state may move).

import type { TenantContext } from '@/infra/tenant';
import { AgentsError } from './errors';
import {
  AGENT_PERMISSION_SCOPES,
  AGENT_RUNTIME_PROVIDERS,
  AGENT_STATUSES,
  isAgentExecutionStatus,
  isAgentPermissionScope,
  isAgentRuntimeProvider,
  isAgentStatus,
} from './policy';
import type {
  AgentExecutionStatusWord,
  AgentPermissionScopeWord,
  AgentRuntimeProvider,
  AgentStatusWord,
} from './policy';
import type {
  CancelAgentExecutionInput,
  ListAgentsQuery,
  ListAgentExecutionAttemptsQuery,
  ListAgentExecutionsQuery,
  RegisterAgentInput,
  RunAgentExecutionInput,
  SubmitAgentExecutionInput,
  UpdateAgentInput,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (module-owned constants, re-exported through the contract)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_MAX_ATTEMPTS = 5;
/** Task bodies stay modest; large artifacts belong to object storage. */
export const MAX_TASK_BYTES = 1_048_576; // 1 MiB
/** Runtime configuration is configuration, not a payload dump. */
export const MAX_RUNTIME_CONFIG_BYTES = 65_536; // 64 KiB
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_SLUG_LENGTH = 64;
export const MAX_ROLE_CHARS = 128;
export const MAX_DISPLAY_NAME_CHARS = 128;
export const MAX_DESCRIPTION_CHARS = 2_048;
export const MAX_INSTRUCTIONS_CHARS = 32_768;
export const MAX_PERMISSIONS = 6;
export const MAX_CORRELATION_CHARS = 128;
export const MAX_REASON_CHARS = 512;
export const MAX_SUMMARY_CHARS = 512;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
/**
 * §25 correlation/causation identities are opaque strings, but bounded and
 * printable so they stay filterable and log-safe.
 */
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const REGISTER_INPUT_KEYS = [
  'slug',
  'displayName',
  'role',
  'description',
  'provider',
  'instructions',
  'runtimeConfig',
  'permissions',
] as const;
const UPDATE_INPUT_KEYS = [
  'agentId',
  'displayName',
  'role',
  'description',
  'instructions',
  'runtimeConfig',
  'permissions',
  'status',
] as const;
const SUBMIT_INPUT_KEYS = [
  'agentId',
  'task',
  'requestedPermissions',
  'maxAttempts',
  'correlationId',
  'causationId',
  'idempotencyKey',
] as const;
const RUN_INPUT_KEYS = ['executionId'] as const;
const CANCEL_INPUT_KEYS = ['executionId', 'reason'] as const;
const LIST_AGENTS_QUERY_KEYS = ['provider', 'status', 'limit'] as const;
const LIST_EXECUTIONS_QUERY_KEYS = [
  'agentId',
  'provider',
  'status',
  'correlationId',
  'limit',
] as const;
const ATTEMPTS_QUERY_KEYS = ['executionId'] as const;

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAgentsTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new AgentsError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AgentsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AgentsError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new AgentsError('invalid_context', 'TenantContext.authority must be an array of claim strings');
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
      throw new AgentsError(
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

function optionalTrimmed(value: unknown, field: string, maxChars: number): string | null {
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

function requireProvider(value: unknown, field: string): AgentRuntimeProvider {
  if (!isAgentRuntimeProvider(value)) {
    throw inputError(
      `${field} must be one of ${AGENT_RUNTIME_PROVIDERS.join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
}

/**
 * Normalize a permission-scopes list: must be a non-empty array from the
 * closed vocabulary; returned deduplicated and in canonical §20 order,
 * so equal grants always serialize identically (determinism).
 */
function normalizeScopes(
  value: unknown,
  field: string,
  maxEntries: number,
): AgentPermissionScopeWord[] {
  if (value === undefined || value === null) {
    throw inputError(`${field} must be an array of permission scopes`);
  }
  if (!Array.isArray(value)) {
    throw inputError(`${field} must be an array of permission scopes`);
  }
  if (value.length === 0) {
    throw inputError(`${field} must contain at least one permission scope`);
  }
  if (value.length > maxEntries) {
    throw inputError(`${field} must contain at most ${maxEntries} permission scopes`);
  }
  const out: AgentPermissionScopeWord[] = [];
  for (const entry of value) {
    if (!isAgentPermissionScope(entry)) {
      throw inputError(
        `${field} entries must be one of ${AGENT_PERMISSION_SCOPES.join(', ')} (got '${String(entry)}')`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  out.sort((a, b) => AGENT_PERMISSION_SCOPES.indexOf(a) - AGENT_PERMISSION_SCOPES.indexOf(b));
  return out;
}

function optionalIdempotencyKey(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw inputError(
      `${field} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (got ${text.length})`,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw inputError(`${field} must match ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`);
  }
  return text;
}

function optionalIdentity(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > MAX_CORRELATION_CHARS) {
    throw inputError(`${field} must be at most ${MAX_CORRELATION_CHARS} characters`);
  }
  if (!IDENTITY_PATTERN.test(text)) {
    throw inputError(`${field} must match ${IDENTITY_PATTERN.source} (got '${text}')`);
  }
  return text;
}

function requireLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIST_LIMIT : value;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(`query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`);
  }
  return limit;
}

function inputError(message: string): AgentsError {
  return new AgentsError('invalid_agent_input', message);
}

function queryError(message: string): AgentsError {
  return new AgentsError('invalid_query', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite
 * numbers, booleans, null, arrays, plain objects) — the actions module's
 * payload discipline.
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

/** Serialized size guard for JSON values (task bodies, runtime configs). */
function requireBoundedJson(value: unknown, field: string, maxBytes: number): void {
  checkJsonValue(value, field, 0);
  const serializedLength = JSON.stringify(value)?.length ?? 0;
  if (serializedLength > maxBytes) {
    throw inputError(
      `${field} exceeds the maximum of ${maxBytes} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterAgentInput`. */
export interface ValidatedRegisterAgentInput {
  slug: string;
  displayName: string | null;
  role: string;
  description: string | null;
  provider: AgentRuntimeProvider;
  instructions: string;
  runtimeConfig: unknown;
  permissions: AgentPermissionScopeWord[];
}

export function validateRegisterAgentInput(input: RegisterAgentInput): ValidatedRegisterAgentInput {
  if (!isPlainObject(input)) {
    throw inputError('agent input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(REGISTER_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the agent input (allowed: ${REGISTER_INPUT_KEYS.join(', ')})`,
      );
    }
  }

  const slug = requireString(input.slug, 'slug').toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw inputError(
      `slug must match ${SLUG_PATTERN.source} (got '${slug}')`,
    );
  }
  const displayName = optionalTrimmed(input.displayName, 'displayName', MAX_DISPLAY_NAME_CHARS);
  const role = requireString(input.role, 'role');
  if (role.length > MAX_ROLE_CHARS) {
    throw inputError(`role must be at most ${MAX_ROLE_CHARS} characters`);
  }
  const description = optionalTrimmed(input.description, 'description', MAX_DESCRIPTION_CHARS);
  const provider = requireProvider(input.provider, 'provider');
  const instructions = requireString(input.instructions, 'instructions');
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw inputError(`instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters`);
  }
  const runtimeConfig = input.runtimeConfig === undefined ? {} : input.runtimeConfig;
  requireBoundedJson(runtimeConfig, 'runtimeConfig', MAX_RUNTIME_CONFIG_BYTES);
  const permissions = normalizeScopes(input.permissions, 'permissions', MAX_PERMISSIONS);

  return { slug, displayName, role, description, provider, instructions, runtimeConfig, permissions };
}

/**
 * Fully validated + normalized form of `UpdateAgentInput` — at least one
 * mutable field must be present (`agentId` alone is not an update).
 */
export interface ValidatedUpdateAgentInput {
  agentId: string;
  displayName: string | null | undefined;
  role: string | undefined;
  description: string | null | undefined;
  instructions: string | undefined;
  runtimeConfig: unknown;
  runtimeConfigSet: boolean;
  permissions: AgentPermissionScopeWord[] | undefined;
  status: AgentStatusWord | undefined;
}

export function validateUpdateAgentInput(input: UpdateAgentInput): ValidatedUpdateAgentInput {
  if (!isPlainObject(input)) {
    throw inputError('agent update must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(UPDATE_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the agent update (allowed: ${UPDATE_INPUT_KEYS.join(', ')})`,
      );
    }
  }
  const agentId = requireUuid(input.agentId, 'agentId');

  let displayName: string | null | undefined;
  if (input.displayName !== undefined) {
    displayName = optionalTrimmed(input.displayName, 'displayName', MAX_DISPLAY_NAME_CHARS);
  }
  let role: string | undefined;
  if (input.role !== undefined) {
    role = requireString(input.role, 'role');
    if (role.length > MAX_ROLE_CHARS) {
      throw inputError(`role must be at most ${MAX_ROLE_CHARS} characters`);
    }
  }
  let description: string | null | undefined;
  if (input.description !== undefined) {
    description = optionalTrimmed(input.description, 'description', MAX_DESCRIPTION_CHARS);
  }
  let instructions: string | undefined;
  if (input.instructions !== undefined) {
    instructions = requireString(input.instructions, 'instructions');
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      throw inputError(`instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters`);
    }
  }
  let runtimeConfig: unknown = undefined;
  let runtimeConfigSet = false;
  if (input.runtimeConfig !== undefined) {
    runtimeConfig = input.runtimeConfig ?? {};
    requireBoundedJson(runtimeConfig, 'runtimeConfig', MAX_RUNTIME_CONFIG_BYTES);
    runtimeConfigSet = true;
  }
  let permissions: AgentPermissionScopeWord[] | undefined;
  if (input.permissions !== undefined) {
    permissions = normalizeScopes(input.permissions, 'permissions', MAX_PERMISSIONS);
  }
  let status: AgentStatusWord | undefined;
  if (input.status !== undefined) {
    if (!isAgentStatus(input.status)) {
      throw inputError(`status must be one of ${AGENT_STATUSES.join(', ')} (got '${String(input.status)}')`);
    }
    status = input.status;
  }

  if (
    displayName === undefined &&
    role === undefined &&
    description === undefined &&
    instructions === undefined &&
    !runtimeConfigSet &&
    permissions === undefined &&
    status === undefined
  ) {
    throw inputError('agent update carries no change (set at least one mutable field)');
  }

  return { agentId, displayName, role, description, instructions, runtimeConfig, runtimeConfigSet, permissions, status };
}

// ---------------------------------------------------------------------------
// Execution submission
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `SubmitAgentExecutionInput`. */
export interface ValidatedSubmitInput {
  agentId: string;
  task: unknown;
  requestedPermissions: AgentPermissionScopeWord[];
  maxAttempts: number;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
}

export function validateSubmitAgentExecutionInput(input: SubmitAgentExecutionInput): ValidatedSubmitInput {
  if (!isPlainObject(input)) {
    throw inputError('execution input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(SUBMIT_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the execution input (allowed: ${SUBMIT_INPUT_KEYS.join(', ')})`,
      );
    }
  }

  const agentId = requireUuid(input.agentId, 'agentId');

  if (input.task === undefined || input.task === null) {
    throw inputError('task must be a non-null JSON value');
  }
  requireBoundedJson(input.task, 'task', MAX_TASK_BYTES);

  const requestedPermissions = normalizeScopes(
    input.requestedPermissions,
    'requestedPermissions',
    MAX_PERMISSIONS,
  );

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
    if (
      typeof input.maxAttempts !== 'number' ||
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > MAX_MAX_ATTEMPTS
    ) {
      throw inputError(
        `maxAttempts must be an integer in [1, ${MAX_MAX_ATTEMPTS}] (got ${String(input.maxAttempts)})`,
      );
    }
    maxAttempts = input.maxAttempts;
  }

  const correlationId = optionalIdentity(input.correlationId, 'correlationId');
  const causationId = optionalIdentity(input.causationId, 'causationId');
  const idempotencyKey = optionalIdempotencyKey(input.idempotencyKey, 'idempotencyKey');

  return {
    agentId,
    task: input.task,
    requestedPermissions,
    maxAttempts,
    correlationId,
    causationId,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// Pump, cancellation, queries
// ---------------------------------------------------------------------------

/** Fully validated form of `RunAgentExecutionInput`. */
export interface ValidatedRunInput {
  executionId: string;
}

export function validateRunAgentExecutionInput(input: RunAgentExecutionInput): ValidatedRunInput {
  if (!isPlainObject(input)) throw queryError('run input must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(input, RUN_INPUT_KEYS, 'the run input');
    return { executionId: requireUuid(input.executionId, 'run input .executionId') };
  });
}

/** Fully validated form of `CancelAgentExecutionInput`. */
export interface ValidatedCancelInput {
  executionId: string;
  reason: string;
}

export function validateCancelAgentExecutionInput(input: CancelAgentExecutionInput): ValidatedCancelInput {
  if (!isPlainObject(input)) throw inputError('cancel input must be an object');
  for (const key of Object.keys(input)) {
    if (!(CANCEL_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the cancel input (allowed: ${CANCEL_INPUT_KEYS.join(', ')})`,
      );
    }
  }
  const executionId = requireUuid(input.executionId, 'executionId');
  const reason = requireString(input.reason, 'reason');
  if (reason.length > MAX_REASON_CHARS) {
    throw inputError(`reason must be at most ${MAX_REASON_CHARS} characters`);
  }
  return { executionId, reason };
}

/** Fully validated form of `ListAgentsQuery`. */
export interface ValidatedListAgentsQuery {
  provider: AgentRuntimeProvider | null;
  status: AgentStatusWord | null;
  limit: number;
}

export function validateListAgentsQuery(query: ListAgentsQuery): ValidatedListAgentsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_AGENTS_QUERY_KEYS, 'the query');
    return {
      provider:
        query.provider === undefined || query.provider === null
          ? null
          : requireProvider(query.provider, 'query.provider'),
      status:
        query.status === undefined || query.status === null
          ? null
          : requireAgentStatus(query.status),
      limit: requireLimit(query.limit),
    };
  });
}

function requireAgentStatus(value: unknown): AgentStatusWord {
  if (!isAgentStatus(value)) {
    throw queryError(`query.status must be one of ${AGENT_STATUSES.join(', ')} (got '${String(value)}')`);
  }
  return value;
}

/** Fully validated form of `ListAgentExecutionsQuery`. */
export interface ValidatedListExecutionsQuery {
  agentId: string | null;
  provider: AgentRuntimeProvider | null;
  status: AgentExecutionStatusWord | null;
  correlationId: string | null;
  limit: number;
}

export function validateListAgentExecutionsQuery(
  query: ListAgentExecutionsQuery,
): ValidatedListExecutionsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_EXECUTIONS_QUERY_KEYS, 'the query');
    let agentId: string | null = null;
    if (query.agentId !== undefined && query.agentId !== null) {
      agentId = requireUuid(query.agentId, 'query.agentId');
    }
    let correlationId: string | null = null;
    if (query.correlationId !== undefined && query.correlationId !== null) {
      correlationId = optionalIdentity(query.correlationId, 'query.correlationId');
    }
    return {
      agentId,
      provider:
        query.provider === undefined || query.provider === null
          ? null
          : requireProvider(query.provider, 'query.provider'),
      status:
        query.status === undefined || query.status === null
          ? null
          : requireExecutionStatus(query.status),
      correlationId,
      limit: requireLimit(query.limit),
    };
  });
}

function requireExecutionStatus(value: unknown): AgentExecutionStatusWord {
  if (!isAgentExecutionStatus(value)) {
    throw queryError(
      `query.status must be one of ${['awaiting_approval', 'queued', 'succeeded', 'failed', 'refused', 'cancelled'].join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
}

/** Fully validated form of `ListAgentExecutionAttemptsQuery`. */
export interface ValidatedAttemptsQuery {
  executionId: string;
}

export function validateListAgentExecutionAttemptsQuery(
  query: ListAgentExecutionAttemptsQuery,
): ValidatedAttemptsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, ATTEMPTS_QUERY_KEYS, 'the query');
    return { executionId: requireUuid(query.executionId, 'query.executionId') };
  });
}

/** The shared string guards throw input-flavored errors; a query deserves `invalid_query`. */
function wrapQueryError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'invalid_agent_input') {
      throw new AgentsError('invalid_query', error.message);
    }
    throw error;
  }
}
