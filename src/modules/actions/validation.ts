// Pure validation/normalization logic of the actions module (no database).
// Everything a caller may put into an authority policy, an action request,
// an approval decision or a query crosses these guards first; the SQL
// CHECK constraints and triggers in migrations/001–003 mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `requestedBy`, `requestedAt`, `decidedAt`
// or `evaluation` into `authorizeAction` — a request's identity, tenancy,
// lifecycle state and evaluation are minted by the system (the request is
// history the moment it is recorded; only the decision state may move).

import type { TenantContext } from '@/infra/tenant';
import { ActionsError } from './errors';
import {
  ACTION_REQUEST_STATUSES,
  AUTHORITY_LEVELS,
  isActionRequestStatus,
  isAuthorityLevel,
} from './matrix';
import type {
  AuthorityLevel,
  ActionRequestStatus,
} from './matrix';
import type {
  AuthorizeActionInput,
  DecideApprovalInput,
  EvaluateAuthorityQuery,
  GetActionRequestQuery,
  ListActionRequestsQuery,
  ListApprovalDecisionsQuery,
  ListAuthorityPoliciesQuery,
  PolicySubjectQuery,
  SetAuthorityPolicyInput,
} from './types';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB — jsonb payloads stay modest; large artifacts belong to object storage
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_NOTE_CHARS = 512;
export const MAX_JUSTIFICATION_CHARS = 512;
/** Opaque principal references stay bounded (they are filters, not records). */
export const MAX_PRINCIPAL_CHARS = 128;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

const POLICY_INPUT_KEYS = ['actionKind', 'approvalLevels', 'forbiddenLevels', 'note'] as const;
const AUTHORIZE_INPUT_KEYS = [
  'actionKind',
  'authorityLevel',
  'payload',
  'justification',
  'idempotencyKey',
] as const;
const DECIDE_INPUT_KEYS = ['requestId', 'decision', 'note'] as const;
const POLICY_SUBJECT_QUERY_KEYS = ['actionKind'] as const;
const POLICY_LIST_QUERY_KEYS = ['limit'] as const;
const EVALUATE_QUERY_KEYS = ['actionKind', 'authorityLevel'] as const;
const GET_REQUEST_QUERY_KEYS = ['requestId'] as const;
const LIST_REQUESTS_QUERY_KEYS = [
  'actionKind',
  'authorityLevel',
  'status',
  'requestedBy',
  'limit',
] as const;
const DECISIONS_LIST_QUERY_KEYS = ['requestId'] as const;

/** Uuid shape guard; malformed request ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertActionsTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new ActionsError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ActionsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ActionsError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new ActionsError('invalid_context', 'TenantContext.authority must be an array of claim strings');
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
      throw new ActionsError(
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

function requireActionKind(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!KIND_PATTERN.test(text)) {
    throw inputError(
      `${field} must be a canonical action kind matching ${KIND_PATTERN.source} (got '${text}')`,
    );
  }
  return text;
}

function requireAuthorityLevel(value: unknown, field: string): AuthorityLevel {
  if (!isAuthorityLevel(value)) {
    throw inputError(
      `${field} must be one of ${AUTHORITY_LEVELS.join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
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
    throw inputError(
      `${field} must match ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`,
    );
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

function inputError(message: string): ActionsError {
  return new ActionsError('invalid_action_input', message);
}

function policyError(message: string): ActionsError {
  return new ActionsError('invalid_policy_input', message);
}

function queryError(message: string): ActionsError {
  return new ActionsError('invalid_query', message);
}

function decisionError(message: string): ActionsError {
  return new ActionsError('invalid_decision', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite
 * numbers, booleans, null, arrays, plain objects) — same discipline the
 * observations and freshness modules apply to payloads.
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

/**
 * Normalize a levels list: must be an array of authority levels; returns
 * it deduplicated and in canonical consequentiality order, so equal
 * policies always serialize identically (determinism).
 */
function normalizeLevels(value: unknown, field: string): AuthorityLevel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw policyError(`${field} must be an array of authority levels`);
  }
  const out: AuthorityLevel[] = [];
  for (const entry of value) {
    const level = requireAuthorityLevel(entry, `${field} entry`);
    if (!out.includes(level)) out.push(level);
  }
  out.sort((a, b) => AUTHORITY_LEVELS.indexOf(a) - AUTHORITY_LEVELS.indexOf(b));
  return out;
}

// ---------------------------------------------------------------------------
// Authority policies
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `SetAuthorityPolicyInput`. */
export interface ValidatedPolicyInput {
  actionKind: string | null;
  approvalLevels: AuthorityLevel[];
  forbiddenLevels: AuthorityLevel[];
  note: string | null;
}

export function validateSetAuthorityPolicyInput(input: SetAuthorityPolicyInput): ValidatedPolicyInput {
  if (!isPlainObject(input)) {
    throw policyError('policy input must be an object');
  }
  return wrapPolicyError(() => validateSetAuthorityPolicyInputInner(input));
}

function validateSetAuthorityPolicyInputInner(input: Record<string, unknown>): ValidatedPolicyInput {
  for (const key of Object.keys(input)) {
    if (!(POLICY_INPUT_KEYS as readonly string[]).includes(key)) {
      throw policyError(
        `unknown field '${key}' on the policy input (allowed: ${POLICY_INPUT_KEYS.join(', ')})`,
      );
    }
  }

  const actionKind =
    input.actionKind === undefined || input.actionKind === null
      ? null
      : requireActionKind(input.actionKind, 'actionKind');

  const approvalLevels = normalizeLevels(input.approvalLevels, 'approvalLevels');
  const forbiddenLevels = normalizeLevels(input.forbiddenLevels, 'forbiddenLevels');
  for (const level of approvalLevels) {
    if (forbiddenLevels.includes(level)) {
      throw policyError(
        `authority level '${level}' cannot be both approval-gated and forbidden — the matrix must be unambiguous`,
      );
    }
  }

  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_CHARS);

  return { actionKind, approvalLevels, forbiddenLevels, note };
}

// ---------------------------------------------------------------------------
// Action requests (the gate)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `AuthorizeActionInput`. */
export interface ValidatedAuthorizeInput {
  actionKind: string;
  authorityLevel: AuthorityLevel;
  payload: unknown;
  justification: string | null;
  idempotencyKey: string | null;
}

export function validateAuthorizeActionInput(input: AuthorizeActionInput): ValidatedAuthorizeInput {
  if (!isPlainObject(input)) {
    throw inputError('action input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!(AUTHORIZE_INPUT_KEYS as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on the action input (allowed: ${AUTHORIZE_INPUT_KEYS.join(', ')})`,
      );
    }
  }

  const actionKind = requireActionKind(input.actionKind, 'actionKind');
  const authorityLevel = requireAuthorityLevel(input.authorityLevel, 'authorityLevel');

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

  const justification = optionalTrimmed(input.justification, 'justification', MAX_JUSTIFICATION_CHARS);
  const idempotencyKey = optionalIdempotencyKey(input.idempotencyKey, 'idempotencyKey');

  return { actionKind, authorityLevel, payload: input.payload, justification, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Approval decisions
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `DecideApprovalInput`. */
export interface ValidatedDecideInput {
  requestId: string;
  decision: 'approve' | 'reject';
  note: string | null;
}

export function validateDecideApprovalInput(input: DecideApprovalInput): ValidatedDecideInput {
  if (!isPlainObject(input)) {
    throw decisionError('decision input must be an object');
  }
  return wrapDecisionError(() => validateDecideApprovalInputInner(input));
}

function validateDecideApprovalInputInner(input: Record<string, unknown>): ValidatedDecideInput {
  for (const key of Object.keys(input)) {
    if (!(DECIDE_INPUT_KEYS as readonly string[]).includes(key)) {
      throw decisionError(
        `unknown field '${key}' on the decision input (allowed: ${DECIDE_INPUT_KEYS.join(', ')})`,
      );
    }
  }
  const requestId = requireUuid(input.requestId, 'requestId');
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    throw decisionError(
      `decision must be 'approve' or 'reject' (got '${String(input.decision)}')`,
    );
  }
  const note = optionalTrimmed(input.note, 'note', MAX_NOTE_CHARS);
  return { requestId, decision: input.decision, note };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated form of `PolicySubjectQuery` (actionKind nullable). */
export interface ValidatedPolicySubjectQuery {
  actionKind: string | null;
}

export function validatePolicySubjectQuery(query: PolicySubjectQuery): ValidatedPolicySubjectQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, POLICY_SUBJECT_QUERY_KEYS, 'the query');
  return wrapQueryError(() => ({
    actionKind:
      query.actionKind === undefined || query.actionKind === null
        ? null
        : requireActionKind(query.actionKind, 'query.actionKind'),
  }));
}

/** Fully validated form of `ListAuthorityPoliciesQuery`. */
export interface ValidatedPolicyListQuery {
  limit: number;
}

export function validateListPoliciesQuery(query: ListAuthorityPoliciesQuery): ValidatedPolicyListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, POLICY_LIST_QUERY_KEYS, 'the query');
  return { limit: requireLimit(query.limit) };
}

/** Fully validated form of `EvaluateAuthorityQuery`. */
export interface ValidatedEvaluateQuery {
  actionKind: string;
  authorityLevel: AuthorityLevel;
}

export function validateEvaluateAuthorityQuery(query: EvaluateAuthorityQuery): ValidatedEvaluateQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, EVALUATE_QUERY_KEYS, 'the query');
    return {
      actionKind: requireActionKind(query.actionKind, 'query.actionKind'),
      authorityLevel: requireAuthorityLevel(query.authorityLevel, 'query.authorityLevel'),
    };
  });
}

/** Fully validated form of `GetActionRequestQuery`. */
export interface ValidatedGetRequestQuery {
  requestId: string;
}

export function validateGetActionRequestQuery(query: GetActionRequestQuery): ValidatedGetRequestQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_REQUEST_QUERY_KEYS, 'the query');
    return { requestId: requireUuid(query.requestId, 'query.requestId') };
  });
}

/** Fully validated form of `ListActionRequestsQuery`. */
export interface ValidatedListRequestsQuery {
  actionKind: string | null;
  authorityLevel: AuthorityLevel | null;
  status: ActionRequestStatus | null;
  requestedBy: string | null;
  limit: number;
}

export function validateListActionRequestsQuery(
  query: ListActionRequestsQuery,
): ValidatedListRequestsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_REQUESTS_QUERY_KEYS, 'the query');

    const actionKind =
      query.actionKind === undefined || query.actionKind === null
        ? null
        : requireActionKind(query.actionKind, 'query.actionKind');
    const authorityLevel =
      query.authorityLevel === undefined || query.authorityLevel === null
        ? null
        : requireAuthorityLevel(query.authorityLevel, 'query.authorityLevel');
    const status =
      query.status === undefined || query.status === null
        ? null
        : requireRequestStatus(query.status);
    let requestedBy: string | null = null;
    if (query.requestedBy !== undefined && query.requestedBy !== null) {
      requestedBy = requireString(query.requestedBy, 'query.requestedBy');
      if (requestedBy.length > MAX_PRINCIPAL_CHARS) {
        throw queryError(
          `query.requestedBy must be at most ${MAX_PRINCIPAL_CHARS} characters`,
        );
      }
    }
    return { actionKind, authorityLevel, status, requestedBy, limit: requireLimit(query.limit) };
  });
}

function requireRequestStatus(value: unknown): ActionRequestStatus {
  if (!isActionRequestStatus(value)) {
    throw queryError(
      `query.status must be one of ${ACTION_REQUEST_STATUSES.join(', ')} (got '${String(value)}')`,
    );
  }
  return value;
}

/** Fully validated form of `ListApprovalDecisionsQuery`. */
export interface ValidatedDecisionsListQuery {
  requestId: string;
}

export function validateListApprovalDecisionsQuery(
  query: ListApprovalDecisionsQuery,
): ValidatedDecisionsListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, DECISIONS_LIST_QUERY_KEYS, 'the query');
    return { requestId: requireUuid(query.requestId, 'query.requestId') };
  });
}

/** The shared string guards throw input-flavored errors; a query deserves `invalid_query`. */
function wrapQueryError<T>(fn: () => T): T {
  return remapError(fn, 'invalid_query');
}

/** ... a policy input deserves `invalid_policy_input`. */
function wrapPolicyError<T>(fn: () => T): T {
  return remapError(fn, 'invalid_policy_input');
}

/** ... an approval decision input deserves `invalid_decision`. */
function wrapDecisionError<T>(fn: () => T): T {
  return remapError(fn, 'invalid_decision');
}

function remapError<T>(fn: () => T, code: 'invalid_query' | 'invalid_policy_input' | 'invalid_decision'): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'invalid_action_input') {
      throw new ActionsError(code, error.message);
    }
    throw error;
  }
}
