// Pure validation/normalization logic of the edge-connector module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, timestamps, signatures or results
// into records — identity, tenancy and the envelope are minted by the
// system, and the envelope's signature covers every field it carries.
//
// OPEN VOCABULARIES (the W082 broker discipline): `edgeKey`, `systemClass`
// and the machine-readable reason codes are SHAPE-CHECKED ONLY — never
// closed CHECKs. Wiring a new private-system class or a new refusal code
// must require no migration. The first-party vocabularies below are
// documentation and test fixtures, not enforcement.

import type { TenantContext } from '@/infra/tenant';
import { EdgeConnectorError } from './errors';
import type {
  EdgeAllowlistChange,
  EdgeJobEventType,
  EdgeJobKind,
  EdgeJobStatus,
  EdgeRegistrationStatus,
  EdgeStatusEventType,
  EdgeJobRequest,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (the closed ones mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const EDGE_JOB_KINDS = ['inspect', 'execute'] as const;

export const EDGE_JOB_STATUSES = [
  'pending',
  'claimed',
  'succeeded',
  'failed',
  'refused',
] as const;

export const EDGE_JOB_EVENT_TYPES = [
  'created',
  'claimed',
  'reclaimed',
  'succeeded',
  'failed',
  'refused',
  'replayed',
  'redriven',
] as const;

export const EDGE_REGISTRATION_STATUSES = ['active', 'retired'] as const;

export const EDGE_STATUS_EVENT_TYPES = [
  'registered',
  'retired',
  'heartbeat',
  'allowlist-changed',
] as const;

export const EDGE_ALLOWLIST_CHANGES = ['added', 'removed'] as const;

/**
 * First-party machine-readable refusal/failure reason codes (OPEN
 * vocabulary — shape-checked only, so a wired edge may mint its own):
 * the envelope-rejection codes plus the runtime's own verdicts.
 */
export const EDGE_REFUSAL_REASONS = [
  'invalid_envelope',
  'unsupported_version',
  'bad_signature',
  'tenant_mismatch',
  'edge_mismatch',
  'invalid_idempotency_key',
  'capability_not_allowed',
  'no_executor',
  'secret_leak_detected',
  'invalid_result',
  'executor_error',
] as const;

/**
 * The suggested private-system classes of the W088 catalog ("private/
 * on-prem APIs, MCP, OpenAPI, databases, files and approved browser
 * adapters"). OPEN vocabulary — shape-checked only; any shape-valid class
 * registers without a migration.
 */
export const EDGE_SYSTEM_CLASSES = [
  'api',
  'mcp',
  'openapi',
  'database',
  'file-share',
  'browser',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_ALLOWLIST_KEYS = 64;
export const MAX_CAPABILITY_KEY_LENGTH = 128;
export const MIN_CAPABILITY_KEY_LENGTH = 3;
export const MAX_LABEL_LENGTH = 200;
export const MAX_VERSION_LENGTH = 64;
export const MAX_EDGE_KEY_LENGTH = 64;
export const MIN_EDGE_TOKEN_LENGTH = 16;
export const MAX_EDGE_TOKEN_LENGTH = 256;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_REASON_LENGTH = 64;
export const MAX_NOTE_LENGTH = 500;
/** Canonical request/result size cap (256 KiB — modest jsonb). */
export const MAX_VALUE_BYTES = 262_144;
export const DEFAULT_CLAIM_LIMIT = 8;
export const MAX_CLAIM_LIMIT = 64;
export const MIN_LEASE_MS = 1_000;
export const MAX_LEASE_MS = 600_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Open-vocabulary key shape (the broker's discipline: lowercase dot/dash/hyphen). */
const OPEN_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const LABEL_PATTERN = /^.{1,200}$/s;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CAPABILITY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;
/** Machine-readable reason codes: lowercase dot/dash/hyphen, 1..64. */
const REASON_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** Opaque credential reference (never a credential VALUE — a store ref). */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isEdgeJobKind(value: unknown): value is EdgeJobKind {
  return typeof value === 'string' && (EDGE_JOB_KINDS as readonly string[]).includes(value);
}

export function isEdgeJobStatus(value: unknown): value is EdgeJobStatus {
  return typeof value === 'string' && (EDGE_JOB_STATUSES as readonly string[]).includes(value);
}

export function isEdgeJobEventType(value: unknown): value is EdgeJobEventType {
  return (
    typeof value === 'string' && (EDGE_JOB_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isEdgeRegistrationStatus(value: unknown): value is EdgeRegistrationStatus {
  return (
    typeof value === 'string' &&
    (EDGE_REGISTRATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isEdgeStatusEventType(value: unknown): value is EdgeStatusEventType {
  return (
    typeof value === 'string' &&
    (EDGE_STATUS_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isEdgeAllowlistChange(value: unknown): value is EdgeAllowlistChange {
  return (
    typeof value === 'string' &&
    (EDGE_ALLOWLIST_CHANGES as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Open-vocabulary shape check (never a closed CHECK — the W082 discipline). */
export function isEdgeKeyShape(value: unknown): value is string {
  return typeof value === 'string' && OPEN_KEY_PATTERN.test(value);
}

/** Open-vocabulary system class (shape-checked only). */
export function isSystemClassShape(value: unknown): value is string {
  return isEdgeKeyShape(value);
}

export function isMachineReadableReason(value: unknown): value is string {
  return typeof value === 'string' && REASON_PATTERN.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Plain-JSON discipline (provider objects never cross — the W084 guard)
// ---------------------------------------------------------------------------

/** True when `value` is plain JSON (no class instances, symbols, cycles). */
export function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  if (Array.isArray(value)) return value.every((entry) => isPlainJsonValue(entry));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) =>
    isPlainJsonValue(entry),
  );
}

// ---------------------------------------------------------------------------
// Context + input guards
// ---------------------------------------------------------------------------

export function assertEdgeTenantContext(context: unknown): asserts context is TenantContext {
  if (
    typeof context !== 'object' ||
    context === null ||
    !isUuid((context as TenantContext).tenantId) ||
    typeof (context as TenantContext).principalId !== 'string' ||
    (context as TenantContext).principalId.length === 0 ||
    !Array.isArray((context as TenantContext).authority)
  ) {
    throw new EdgeConnectorError(
      'invalid_context',
      'an edge-connector operation requires a TenantContext with tenantId, principalId and authority',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects unknown keys (the house strictness). */
function rejectUnknownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `unknown field '${key}' — allowed fields: ${allowed.join(', ')}`,
      );
    }
  }
}

function requireNonEmptyString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new EdgeConnectorError('invalid_input', `field '${field}' must be a non-empty string`);
  }
  return value;
}

function boundedInt(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new EdgeConnectorError(
      'invalid_input',
      `field '${field}' must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function checkCapabilityKey(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < MIN_CAPABILITY_KEY_LENGTH ||
    value.length > MAX_CAPABILITY_KEY_LENGTH ||
    !CAPABILITY_KEY_PATTERN.test(value)
  ) {
    throw new EdgeConnectorError(
      'invalid_input',
      `field '${field}' must be a plain-language capability key of ${MIN_CAPABILITY_KEY_LENGTH}..${MAX_CAPABILITY_KEY_LENGTH} characters`,
    );
  }
  return value;
}

/** Validates one allowlist: unique, shape-checked capability keys, 0..64. */
export function checkAllowlist(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new EdgeConnectorError('invalid_input', `field '${field}' must be an array of capability keys`);
  }
  if (value.length > MAX_ALLOWLIST_KEYS) {
    throw new EdgeConnectorError(
      'invalid_input',
      `field '${field}' carries more than ${MAX_ALLOWLIST_KEYS} capability keys`,
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    checkCapabilityKey(entry, `${field} entry`);
    if (seen.has(entry as string)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `field '${field}' carries duplicate capability key '${entry as string}'`,
      );
    }
    seen.add(entry as string);
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// The canonical deep-action request shapes (submit-time validation)
// ---------------------------------------------------------------------------

/**
 * Validates one canonical request (the deep-action transport shapes).
 * Strict unknown-key rejection; every value must be plain JSON; the
 * `credentialRef` must be an OPAQUE store reference (a credential VALUE
 * never rides inside a request — the edge resolves refs locally).
 */
export function checkEdgeJobRequest(kind: EdgeJobKind, value: unknown): EdgeJobRequest {
  if (!isRecord(value)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `field 'request' must be an object (the canonical ${kind} request)`,
    );
  }
  const allowed =
    kind === 'inspect'
      ? ['connectionId', 'credentialRef', 'systemKey', 'capabilityKey', 'target', 'idempotencyKey']
      : [
          'connectionId',
          'credentialRef',
          'systemKey',
          'capabilityKey',
          'target',
          'payload',
          'idempotencyKey',
        ];
  rejectUnknownKeys(value, allowed);
  const connectionId = value.connectionId;
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    throw new EdgeConnectorError('invalid_input', "field 'request.connectionId' must be a non-empty string");
  }
  if (!isUuid(connectionId)) {
    throw new EdgeConnectorError('invalid_input', "field 'request.connectionId' must be a uuid");
  }
  const credentialRef = value.credentialRef;
  if (typeof credentialRef !== 'string' || credentialRef.length === 0) {
    throw new EdgeConnectorError('invalid_input', "field 'request.credentialRef' must be a non-empty string");
  }
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'request.credentialRef' must be an opaque credential-store reference (a credential VALUE never rides a request)",
    );
  }
  const systemKey = value.systemKey;
  if (typeof systemKey !== 'string' || systemKey.length === 0) {
    throw new EdgeConnectorError('invalid_input', "field 'request.systemKey' must be a non-empty string");
  }
  if (systemKey.length > 312) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'request.systemKey' must not exceed 312 characters",
    );
  }
  checkCapabilityKey(value.capabilityKey, 'request.capabilityKey');
  const target = value.target;
  if (typeof target !== 'string' || target.length === 0) {
    throw new EdgeConnectorError('invalid_input', "field 'request.target' must be a non-empty string");
  }
  if (target.length > 200) {
    throw new EdgeConnectorError('invalid_input', "field 'request.target' must not exceed 200 characters");
  }
  const idempotencyKey = value.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new EdgeConnectorError('invalid_input', "field 'request.idempotencyKey' must be a non-empty string");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'request.idempotencyKey' must match the canonical idempotency key pattern (2..200 characters)",
    );
  }
  if (kind === 'execute') {
    const payload = value.payload;
    if (!isRecord(payload) || !isPlainJsonValue(payload)) {
      throw new EdgeConnectorError(
        'invalid_input',
        "field 'request.payload' must be a plain JSON object (a provider object never rides a request)",
      );
    }
    const serialized = JSON.stringify(payload) ?? 'null';
    if (serialized.length > MAX_VALUE_BYTES) {
      throw new EdgeConnectorError(
        'invalid_input',
        `field 'request.payload' exceeds ${MAX_VALUE_BYTES} bytes — large artifacts belong in object storage`,
      );
    }
  }
  return value as unknown as EdgeJobRequest;
}

// ---------------------------------------------------------------------------
// Validated operation inputs
// ---------------------------------------------------------------------------

export interface ValidatedRegisterInput {
  edgeKey: string;
  label: string;
  systemClass: string;
  version: string;
  allowlist: string[];
  edgeToken: string;
}

export function validateRegisterEdgeInput(input: unknown): ValidatedRegisterInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'registerEdgeRuntime input must be an object');
  }
  rejectUnknownKeys(input, [
    'edgeKey',
    'label',
    'systemClass',
    'version',
    'allowlist',
    'edgeToken',
  ]);
  const edgeKey = requireNonEmptyString(input, 'edgeKey');
  if (!isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'edgeKey' must match the open key vocabulary shape (lowercase, dot/dash/underscore, ≤ 64 chars)",
    );
  }
  const label = requireNonEmptyString(input, 'label');
  if (!LABEL_PATTERN.test(label)) {
    throw new EdgeConnectorError('invalid_input', "field 'label' must be 1..200 characters");
  }
  const systemClass = requireNonEmptyString(input, 'systemClass');
  if (!isSystemClassShape(systemClass)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'systemClass' must match the open class vocabulary shape (lowercase, dot/dash/underscore, ≤ 64 chars)",
    );
  }
  const version = requireNonEmptyString(input, 'version');
  if (!VERSION_PATTERN.test(version)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'version' must be a version shape (1..64 chars, alphanumeric/dot/dash/plus/underscore)",
    );
  }
  const allowlist = checkAllowlist(input.allowlist ?? [], 'allowlist');
  const edgeToken = requireNonEmptyString(input, 'edgeToken');
  if (edgeToken.length < MIN_EDGE_TOKEN_LENGTH || edgeToken.length > MAX_EDGE_TOKEN_LENGTH) {
    throw new EdgeConnectorError(
      'invalid_input',
      `field 'edgeToken' must be ${MIN_EDGE_TOKEN_LENGTH}..${MAX_EDGE_TOKEN_LENGTH} characters (stored only as its SHA-256 digest)`,
    );
  }
  return { edgeKey, label, systemClass, version, allowlist, edgeToken };
}

export interface ValidatedUpdateAllowlistInput {
  edgeId: string;
  add: string[];
  remove: string[];
  note: string | null;
}

export function validateUpdateAllowlistInput(input: unknown): ValidatedUpdateAllowlistInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'updateEdgeAllowlist input must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'add', 'remove', 'note']);
  const edgeId = requireNonEmptyString(input, 'edgeId');
  if (!isUuid(edgeId)) {
    throw new EdgeConnectorError('invalid_input', "field 'edgeId' must be a uuid");
  }
  const add = checkAllowlist(input.add ?? [], 'add');
  const remove = checkAllowlist(input.remove ?? [], 'remove');
  const overlap = add.filter((key) => remove.includes(key));
  if (overlap.length > 0) {
    throw new EdgeConnectorError(
      'invalid_input',
      `capability keys cannot be both added and removed: ${overlap.join(', ')}`,
    );
  }
  const note = input.note === undefined || input.note === null ? null : String(input.note);
  if (note !== null && (note.length === 0 || note.length > MAX_NOTE_LENGTH)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `field 'note' must be 1..${MAX_NOTE_LENGTH} characters`,
    );
  }
  return { edgeId, add, remove, note };
}

export interface ValidatedSubmitJobInput {
  edgeKey: string;
  kind: EdgeJobKind;
  capabilityKey: string;
  idempotencyKey: string;
  request: EdgeJobRequest;
}

export function validateSubmitEdgeJobInput(input: unknown): ValidatedSubmitJobInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'submitEdgeJob input must be an object');
  }
  rejectUnknownKeys(input, ['edgeKey', 'kind', 'capabilityKey', 'idempotencyKey', 'request']);
  const edgeKey = requireNonEmptyString(input, 'edgeKey');
  if (!isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError('invalid_input', "field 'edgeKey' must match the open key vocabulary shape");
  }
  const kind = input.kind;
  if (!isEdgeJobKind(kind)) {
    throw new EdgeConnectorError('invalid_input', "field 'kind' must be 'inspect' or 'execute'");
  }
  const idempotencyKey = requireNonEmptyString(input, 'idempotencyKey');
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'idempotencyKey' must match the canonical idempotency key pattern (2..200 characters)",
    );
  }
  const request = checkEdgeJobRequest(kind, input.request);
  const capabilityKey = checkCapabilityKey(input.capabilityKey, 'capabilityKey');
  return { edgeKey, kind, capabilityKey, idempotencyKey, request };
}

export interface ValidatedClaimInput {
  edgeKey: string;
  edgeToken: string;
  limit: number;
  leaseMs: number;
}

export function validateClaimEdgeJobsInput(input: unknown): ValidatedClaimInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'claimEdgeJobs input must be an object');
  }
  rejectUnknownKeys(input, ['edgeKey', 'edgeToken', 'limit', 'leaseMs']);
  const edgeKey = requireNonEmptyString(input, 'edgeKey');
  if (!isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError('invalid_input', "field 'edgeKey' must match the open key vocabulary shape");
  }
  const edgeToken = requireNonEmptyString(input, 'edgeToken');
  const limit = boundedInt(input.limit, 'limit', 1, MAX_CLAIM_LIMIT) ?? DEFAULT_CLAIM_LIMIT;
  const leaseMs =
    boundedInt(input.leaseMs, 'leaseMs', MIN_LEASE_MS, MAX_LEASE_MS) ?? undefined;
  return { edgeKey, edgeToken, limit, leaseMs: leaseMs ?? 0 };
}

export interface ValidatedReportInput {
  edgeKey: string;
  edgeToken: string;
  jobId: string;
  executedEnvelopeDigest: string;
  outcome: { kind: 'result'; result: unknown } | { kind: 'failed' | 'refused'; reason: string };
}

export function validateReportEdgeJobInput(input: unknown): ValidatedReportInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'reportEdgeJobResult input must be an object');
  }
  rejectUnknownKeys(input, ['edgeKey', 'edgeToken', 'jobId', 'executedEnvelopeDigest', 'outcome']);
  const edgeKey = requireNonEmptyString(input, 'edgeKey');
  if (!isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError('invalid_input', "field 'edgeKey' must match the open key vocabulary shape");
  }
  requireNonEmptyString(input, 'edgeToken');
  const jobId = requireNonEmptyString(input, 'jobId');
  if (!isUuid(jobId)) {
    throw new EdgeConnectorError('invalid_input', "field 'jobId' must be a uuid");
  }
  const executedEnvelopeDigest = requireNonEmptyString(input, 'executedEnvelopeDigest');
  if (!isHex64(executedEnvelopeDigest)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'executedEnvelopeDigest' must be a SHA-256 hex digest of the executed envelope",
    );
  }
  const outcome = input.outcome;
  if (!isRecord(outcome)) {
    throw new EdgeConnectorError('invalid_input', "field 'outcome' must be an object");
  }
  rejectUnknownKeys(outcome, ['kind', 'result', 'reason']);
  if (outcome.kind === 'result') {
    if (outcome.reason !== undefined) {
      throw new EdgeConnectorError('invalid_input', "a 'result' outcome carries no 'reason'");
    }
    return {
      edgeKey,
      edgeToken: input.edgeToken as string,
      jobId,
      executedEnvelopeDigest,
      outcome: { kind: 'result', result: outcome.result },
    };
  }
  if (outcome.kind === 'failed' || outcome.kind === 'refused') {
    const reason = outcome.reason;
    if (!isMachineReadableReason(reason)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `field 'outcome.reason' must be a machine-readable code (lowercase, dot/dash/underscore, ≤ ${MAX_REASON_LENGTH} chars) — a free-text detail or secret VALUE never crosses the report path`,
      );
    }
    return {
      edgeKey,
      edgeToken: input.edgeToken as string,
      jobId,
      executedEnvelopeDigest,
      outcome: { kind: outcome.kind, reason },
    };
  }
  throw new EdgeConnectorError(
    'invalid_input',
    "field 'outcome.kind' must be 'result', 'failed' or 'refused'",
  );
}

export interface ValidatedHeartbeatInput {
  edgeKey: string;
  edgeToken: string;
  version: string;
  allowlistDigest: string;
  stats: {
    jobsClaimed: number;
    jobsSucceeded: number;
    jobsFailed: number;
    jobsRefused: number;
    lastJobAt: string | null;
  };
}

export function validateHeartbeatInput(input: unknown): ValidatedHeartbeatInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'reportEdgeHeartbeat input must be an object');
  }
  rejectUnknownKeys(input, ['edgeKey', 'edgeToken', 'version', 'allowlistDigest', 'stats']);
  const edgeKey = requireNonEmptyString(input, 'edgeKey');
  if (!isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError('invalid_input', "field 'edgeKey' must match the open key vocabulary shape");
  }
  requireNonEmptyString(input, 'edgeToken');
  const version = requireNonEmptyString(input, 'version');
  if (!VERSION_PATTERN.test(version)) {
    throw new EdgeConnectorError('invalid_input', "field 'version' must be a version shape");
  }
  const allowlistDigest = requireNonEmptyString(input, 'allowlistDigest');
  if (!isHex64(allowlistDigest)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "field 'allowlistDigest' must be a SHA-256 hex digest",
    );
  }
  const stats = input.stats;
  if (!isRecord(stats)) {
    throw new EdgeConnectorError('invalid_input', "field 'stats' must be an object");
  }
  rejectUnknownKeys(stats, [
    'jobsClaimed',
    'jobsSucceeded',
    'jobsFailed',
    'jobsRefused',
    'lastJobAt',
  ]);
  for (const field of ['jobsClaimed', 'jobsSucceeded', 'jobsFailed', 'jobsRefused']) {
    const value = stats[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new EdgeConnectorError(
        'invalid_input',
        `field 'stats.${field}' must be a non-negative integer`,
      );
    }
  }
  const lastJobAt = stats.lastJobAt ?? null;
  if (lastJobAt !== null && (typeof lastJobAt !== 'string' || Number.isNaN(Date.parse(lastJobAt)))) {
    throw new EdgeConnectorError('invalid_input', "field 'stats.lastJobAt' must be an ISO timestamp or null");
  }
  return {
    edgeKey,
    edgeToken: input.edgeToken as string,
    version,
    allowlistDigest,
    stats: {
      jobsClaimed: stats.jobsClaimed as number,
      jobsSucceeded: stats.jobsSucceeded as number,
      jobsFailed: stats.jobsFailed as number,
      jobsRefused: stats.jobsRefused as number,
      lastJobAt: lastJobAt as string | null,
    },
  };
}

export interface ValidatedGetEdgeQuery {
  edgeId: string | null;
  edgeKey: string | null;
}

export function validateGetEdgeQuery(input: unknown): ValidatedGetEdgeQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', 'getEdgeRuntime query must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'edgeKey']);
  const edgeId = input.edgeId === undefined || input.edgeId === null ? null : String(input.edgeId);
  if (edgeId !== null && !isUuid(edgeId)) {
    throw new EdgeConnectorError('invalid_query', "field 'edgeId' must be a uuid");
  }
  const edgeKey =
    input.edgeKey === undefined || input.edgeKey === null ? null : String(input.edgeKey);
  if (edgeKey !== null && !isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError('invalid_query', "field 'edgeKey' must match the open key vocabulary shape");
  }
  if ((edgeId === null) === (edgeKey === null)) {
    throw new EdgeConnectorError(
      'invalid_query',
      'exactly one of edgeId or edgeKey must be provided',
    );
  }
  return { edgeId, edgeKey };
}

export interface ValidatedListEdgesQuery {
  status: EdgeRegistrationStatus | null;
  limit: number;
}

export function validateListEdgesQuery(input: unknown): ValidatedListEdgesQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', 'listEdgeRuntimes query must be an object');
  }
  rejectUnknownKeys(input, ['status', 'limit']);
  const status =
    input.status === undefined || input.status === null ? null : String(input.status);
  if (status !== null && !isEdgeRegistrationStatus(status)) {
    throw new EdgeConnectorError('invalid_query', "field 'status' must be 'active' or 'retired'");
  }
  const limit = boundedInt(input.limit, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  return { status, limit };
}

export interface ValidatedIdQuery {
  id: string;
}

export function validateIdQuery(
  input: unknown,
  field: string,
  operation: string,
): ValidatedIdQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', `${operation} query must be an object`);
  }
  const allowed = [field];
  rejectUnknownKeys(input, allowed);
  const id = requireNonEmptyString(input, field);
  if (!isUuid(id)) {
    throw new EdgeConnectorError('invalid_query', `field '${field}' must be a uuid`);
  }
  return { id };
}

export interface ValidatedListJobsQuery {
  status: EdgeJobStatus | null;
  edgeKey: string | null;
  limit: number;
}

export function validateListEdgeJobsQuery(input: unknown): ValidatedListJobsQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', 'listEdgeJobs query must be an object');
  }
  rejectUnknownKeys(input, ['status', 'edgeKey', 'limit']);
  const status =
    input.status === undefined || input.status === null ? null : String(input.status);
  if (status !== null && !isEdgeJobStatus(status)) {
    throw new EdgeConnectorError(
      'invalid_query',
      "field 'status' must be one of pending, claimed, succeeded, failed, refused",
    );
  }
  const edgeKey =
    input.edgeKey === undefined || input.edgeKey === null ? null : String(input.edgeKey);
  if (edgeKey !== null && !isEdgeKeyShape(edgeKey)) {
    throw new EdgeConnectorError('invalid_query', "field 'edgeKey' must match the open key vocabulary shape");
  }
  const limit = boundedInt(input.limit, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  return { status, edgeKey, limit };
}

export interface ValidatedListFeedQuery {
  limit: number;
}

export function validateListFeedQuery(
  input: unknown,
  operation: string,
): ValidatedListFeedQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', `${operation} query must be an object`);
  }
  rejectUnknownKeys(input, ['limit']);
  const limit = boundedInt(input.limit, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  return { limit };
}

/** One job-scoped feed query: the job's id plus a bounded limit. */
export interface ValidatedJobFeedQuery {
  jobId: string;
  limit: number;
}

export function validateJobFeedQuery(input: unknown): ValidatedJobFeedQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', 'the job feed query must be an object');
  }
  rejectUnknownKeys(input, ['jobId', 'limit']);
  const jobId = requireNonEmptyString(input, 'jobId');
  if (!isUuid(jobId)) {
    throw new EdgeConnectorError('invalid_query', "field 'jobId' must be a uuid");
  }
  const limit = boundedInt(input.limit, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  return { jobId, limit };
}

/** One edge-scoped feed query: the edge's id plus a bounded limit. */
export interface ValidatedEdgeFeedQuery {
  edgeId: string;
  limit: number;
}

export function validateEdgeFeedQuery(input: unknown): ValidatedEdgeFeedQuery {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_query', 'the edge feed query must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'limit']);
  const edgeId = requireNonEmptyString(input, 'edgeId');
  if (!isUuid(edgeId)) {
    throw new EdgeConnectorError('invalid_query', "field 'edgeId' must be a uuid");
  }
  const limit = boundedInt(input.limit, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  return { edgeId, limit };
}

export interface ValidatedRetireInput {
  edgeId: string;
}

export function validateRetireInput(input: unknown): ValidatedRetireInput {
  if (!isRecord(input)) {
    throw new EdgeConnectorError('invalid_input', 'retireEdgeRuntime input must be an object');
  }
  rejectUnknownKeys(input, ['edgeId']);
  const edgeId = requireNonEmptyString(input, 'edgeId');
  if (!isUuid(edgeId)) {
    throw new EdgeConnectorError('invalid_input', "field 'edgeId' must be a uuid");
  }
  return { edgeId };
}
