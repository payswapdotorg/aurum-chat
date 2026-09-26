// Pure validation/normalization logic of the edge-connector module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, timestamps, nonces, receipts or
// results into records — identity, tenancy and outcome links are minted
// by the system from validated state.

import type { TenantContext } from '@/infra/tenant';
import { EdgeConnectorError } from './errors';
import type {
  EdgeConnectivityKind,
  EdgeEventType,
  EdgeJobKind,
  EdgeJobState,
  EdgeJobEnvelope,
  EdgeRuntimeStatus,
  EdgeReceiptStatus,
  SignedEdgeJobEnvelope,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const EDGE_CONNECTIVITY_KINDS = [
  'private-api',
  'openapi',
  'mcp',
  'database',
  'file-share',
  'browser',
] as const;

export const EDGE_RUNTIME_STATUSES = ['pending', 'connected', 'revoked'] as const;

export const EDGE_JOB_KINDS = ['inspect', 'execute'] as const;

export const EDGE_JOB_STATES = [
  'issued',
  'delivered',
  'succeeded',
  'rejected',
  'failed',
  'expired',
] as const;

export const EDGE_RECEIPT_STATUSES = ['accepted', 'rejected', 'failed'] as const;

export const EDGE_EVENT_TYPES = [
  'registered',
  'allowlist-updated',
  'heartbeat-received',
  'revoked',
  'job-issued',
  'job-delivered',
  'job-succeeded',
  'job-failed',
  'job-rejected',
  'job-expired',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_PULL_LIMIT = 10;
export const MAX_PULL_LIMIT = 50;
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_SIGNING_KEY_ID_LENGTH = 64;
export const MAX_VERSION_LENGTH = 64;
export const MAX_TARGET_LENGTH = 200;
export const MAX_CAPABILITY_KEY_LENGTH = 128;
export const MIN_CAPABILITY_KEY_LENGTH = 3;
export const MAX_SECRET_REF_LENGTH = 200;
export const MAX_SECRET_SCOPES = 16;
export const MAX_SECRET_SCOPE_LENGTH = 64;
export const MAX_ALLOWLIST_ENTRIES = 64;
export const MAX_HEARTBEAT_PENDING_JOBS = 1_000_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 200;
export const MAX_SYSTEM_KEY_LENGTH = 312;
export const MAX_RECEIPT_ID_LENGTH = 200;
export const MAX_RECEIPT_DETAIL_LENGTH = 500;
export const MAX_REQUEST_NONCE_LENGTH = 128;
/** Canonical payload size cap (256 KiB — modest jsonb; the W004 discipline). */
export const MAX_PAYLOAD_BYTES = 262_144;
/** Canonical edge-result size cap (state + receipt together). */
export const MAX_RESULT_STATE_BYTES = 262_144;
export const DEFAULT_STALE_AFTER_SECONDS = 300;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
export const DEFAULT_TTL_SECONDS = 300;
export const MIN_TTL_SECONDS = 10;
export const MAX_TTL_SECONDS = 86_400;
export const MIN_STALE_AFTER_SECONDS = 30;
export const MAX_STALE_AFTER_SECONDS = 86_400;
export const MIN_HEARTBEAT_INTERVAL_SECONDS = 10;
export const MAX_HEARTBEAT_INTERVAL_SECONDS = 86_400;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_PATTERN = /^[^\n\r\t]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;
const REQUEST_NONCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isEdgeConnectivityKind(value: unknown): value is EdgeConnectivityKind {
  return (
    typeof value === 'string' &&
    (EDGE_CONNECTIVITY_KINDS as readonly string[]).includes(value)
  );
}

export function isEdgeRuntimeStatus(value: unknown): value is EdgeRuntimeStatus {
  return (
    typeof value === 'string' && (EDGE_RUNTIME_STATUSES as readonly string[]).includes(value)
  );
}

export function isEdgeJobKind(value: unknown): value is EdgeJobKind {
  return typeof value === 'string' && (EDGE_JOB_KINDS as readonly string[]).includes(value);
}

export function isEdgeJobState(value: unknown): value is EdgeJobState {
  return typeof value === 'string' && (EDGE_JOB_STATES as readonly string[]).includes(value);
}

export function isEdgeReceiptStatus(value: unknown): value is EdgeReceiptStatus {
  return (
    typeof value === 'string' && (EDGE_RECEIPT_STATUSES as readonly string[]).includes(value)
  );
}

export function isEdgeEventType(value: unknown): value is EdgeEventType {
  return typeof value === 'string' && (EDGE_EVENT_TYPES as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertEdgeTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new EdgeConnectorError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new EdgeConnectorError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new EdgeConnectorError(
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
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new EdgeConnectorError('invalid_input', `'${field}' must be a uuid`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must match ${IDEMPOTENCY_KEY_PATTERN.source} (2..${MAX_IDEMPOTENCY_KEY_LENGTH} characters)`,
    );
  }
  return value;
}

function optionalLimit(value: unknown, field: string, max: number): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EdgeConnectorError('invalid_input', `'${field}' must be an integer`);
  }
  if (value < 1 || value > max) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must be between 1 and ${max}`,
    );
  }
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
  minLength = 1,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must be a string of ${minLength}..${maxLength} characters`,
    );
  }
  return value;
}

/** A bounded plain-JSON value: JSON-serializable and within the byte cap. */
function requireBoundedJsonValue(value: unknown, field: string, maxBytes: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must be a JSON-serializable value (no cycles, no provider objects)`,
    );
  }
  if (serialized.length > maxBytes) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' exceeds ${maxBytes} bytes — large artifacts belong in object storage`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Capability keys (the W081 vocabulary: read./write. prefixes)
// ---------------------------------------------------------------------------

/** The write-capability prefix convention of the W081 vocabulary. */
const WRITE_CAPABILITY_PREFIX = 'write.';
/** The read-capability prefix convention of the W081 vocabulary. */
const READ_CAPABILITY_PREFIX = 'read.';

function requireCapabilityKey(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < MIN_CAPABILITY_KEY_LENGTH ||
    value.length > MAX_CAPABILITY_KEY_LENGTH ||
    !CAPABILITY_KEY_PATTERN.test(value)
  ) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must be a plain-language capability key of ${MIN_CAPABILITY_KEY_LENGTH}..${MAX_CAPABILITY_KEY_LENGTH} characters matching ${CAPABILITY_KEY_PATTERN.source} (e.g. 'write.customer-records')`,
    );
  }
  return value;
}

/** The capability mode implied by a W081-style key's prefix. */
export function modeOfCapabilityKey(capabilityKey: string): 'read' | 'write' {
  return capabilityKey.startsWith(READ_CAPABILITY_PREFIX) ? 'read' : 'write';
}

/** The read capability of the same class as a write key ('read.' swap). */
export function readCapabilityKeyOf(capabilityKey: string): string | null {
  if (capabilityKey.startsWith(WRITE_CAPABILITY_PREFIX)) {
    return READ_CAPABILITY_PREFIX + capabilityKey.slice(WRITE_CAPABILITY_PREFIX.length);
  }
  if (capabilityKey.startsWith(READ_CAPABILITY_PREFIX)) return capabilityKey;
  return null;
}

// ---------------------------------------------------------------------------
// Validation exports for tests and edge implementers (the house pattern)
// ---------------------------------------------------------------------------

export {
  requireCapabilityKey as assertCapabilityKey,
  requireUuid as assertUuid,
};

// ---------------------------------------------------------------------------
// Allowlist entries
// ---------------------------------------------------------------------------

export interface ValidatedAllowlistEntry {
  capabilityKey: string;
  mode: 'read' | 'write';
  connectivity: EdgeConnectivityKind;
  secretRef: string;
  secretScopes: string[];
}

function validateAllowlistEntry(value: unknown): ValidatedAllowlistEntry {
  if (!isPlainObject(value)) {
    throw new EdgeConnectorError('invalid_input', 'each allowlist entry must be an object');
  }
  rejectUnknownKeys(value, [
    'capabilityKey',
    'mode',
    'connectivity',
    'secretRef',
    'secretScopes',
  ], 'an allowlist entry');
  const capabilityKey = requireCapabilityKey(value.capabilityKey, 'allowlist.capabilityKey');
  if (value.mode !== 'read' && value.mode !== 'write') {
    throw new EdgeConnectorError(
      'invalid_input',
      "allowlist.mode must be 'read' or 'write'",
    );
  }
  if (modeOfCapabilityKey(capabilityKey) !== value.mode) {
    throw new EdgeConnectorError(
      'invalid_input',
      `allowlist.mode '${value.mode}' does not match the key prefix of '${capabilityKey}'`,
    );
  }
  if (!isEdgeConnectivityKind(value.connectivity)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `allowlist.connectivity must be one of ${EDGE_CONNECTIVITY_KINDS.join(', ')}`,
    );
  }
  const secretRef = optionalText(value.secretRef, 'allowlist.secretRef', MAX_SECRET_REF_LENGTH);
  if (secretRef === null) {
    throw new EdgeConnectorError('invalid_input', 'allowlist.secretRef is required');
  }
  if (!Array.isArray(value.secretScopes)) {
    throw new EdgeConnectorError(
      'invalid_input',
      'allowlist.secretScopes must be an array of scope strings',
    );
  }
  if (value.secretScopes.length > MAX_SECRET_SCOPES) {
    throw new EdgeConnectorError(
      'invalid_input',
      `allowlist.secretScopes must hold at most ${MAX_SECRET_SCOPES} scopes`,
    );
  }
  const secretScopes: string[] = [];
  for (const scope of value.secretScopes) {
    if (
      typeof scope !== 'string' ||
      scope.length < 1 ||
      scope.length > MAX_SECRET_SCOPE_LENGTH
    ) {
      throw new EdgeConnectorError(
        'invalid_input',
        `each secret scope must be a string of 1..${MAX_SECRET_SCOPE_LENGTH} characters`,
      );
    }
    secretScopes.push(scope);
  }
  return { capabilityKey, mode: value.mode, connectivity: value.connectivity, secretRef, secretScopes };
}

function validateAllowlist(value: unknown, field: string): ValidatedAllowlistEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWLIST_ENTRIES) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must be a non-empty array of at most ${MAX_ALLOWLIST_ENTRIES} entries`,
    );
  }
  const entries = value.map(validateAllowlistEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.capabilityKey)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `duplicate allowlist capability key '${entry.capabilityKey}'`,
      );
    }
    seen.add(entry.capabilityKey);
  }
  return entries;
}

function validateConnectivityList(value: unknown, field: string): EdgeConnectivityKind[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new EdgeConnectorError('invalid_input', `'${field}' must be a non-empty array`);
  }
  if (value.length > EDGE_CONNECTIVITY_KINDS.length) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'${field}' must hold at most ${EDGE_CONNECTIVITY_KINDS.length} kinds`,
    );
  }
  const kinds = value.map((kind) => {
    if (!isEdgeConnectivityKind(kind)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `'${field}' entries must be one of ${EDGE_CONNECTIVITY_KINDS.join(', ')}`,
      );
    }
    return kind;
  });
  if (new Set(kinds).size !== kinds.length) {
    throw new EdgeConnectorError('invalid_input', `'${field}' must not repeat kinds`);
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Registration / lifecycle inputs
// ---------------------------------------------------------------------------

export interface ValidatedRegisterInput {
  name: string;
  description: string | null;
  signingKeyId: string;
  connectivity: EdgeConnectivityKind[];
  allowlist: ValidatedAllowlistEntry[];
  staleAfterSeconds: number;
  heartbeatIntervalSeconds: number;
}

export function validateRegisterEdgeRuntimeInput(input: unknown): ValidatedRegisterInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'registerEdgeRuntime input must be an object');
  }
  rejectUnknownKeys(input, [
    'name',
    'description',
    'signingKeyId',
    'connectivity',
    'allowlist',
    'staleAfterSeconds',
    'heartbeatIntervalSeconds',
  ], 'registerEdgeRuntime input');
  const name = optionalText(input.name, 'name', MAX_NAME_LENGTH);
  if (name === null) {
    throw new EdgeConnectorError('invalid_input', "'name' is required");
  }
  if (!NAME_PATTERN.test(name)) {
    throw new EdgeConnectorError('invalid_input', "'name' must not contain control characters");
  }
  const description = optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  const signingKeyId = optionalText(input.signingKeyId, 'signingKeyId', MAX_SIGNING_KEY_ID_LENGTH);
  if (signingKeyId === null) {
    throw new EdgeConnectorError('invalid_input', "'signingKeyId' is required");
  }
  if (input.connectivity === undefined) {
    throw new EdgeConnectorError('invalid_input', "'connectivity' is required");
  }
  const connectivity = validateConnectivityList(input.connectivity, 'connectivity');
  if (input.allowlist === undefined) {
    throw new EdgeConnectorError('invalid_input', "'allowlist' is required");
  }
  const allowlist = validateAllowlist(input.allowlist, 'allowlist');
  for (const entry of allowlist) {
    if (!connectivity.includes(entry.connectivity)) {
      throw new EdgeConnectorError(
        'invalid_input',
        `allowlist entry '${entry.capabilityKey}' rides connectivity '${entry.connectivity}' which the runtime does not declare`,
      );
    }
  }
  return {
    name,
    description,
    signingKeyId,
    connectivity,
    allowlist,
    staleAfterSeconds: optionalSeconds(
      input.staleAfterSeconds,
      'staleAfterSeconds',
      MIN_STALE_AFTER_SECONDS,
      MAX_STALE_AFTER_SECONDS,
      DEFAULT_STALE_AFTER_SECONDS,
    ),
    heartbeatIntervalSeconds: optionalSeconds(
      input.heartbeatIntervalSeconds,
      'heartbeatIntervalSeconds',
      MIN_HEARTBEAT_INTERVAL_SECONDS,
      MAX_HEARTBEAT_INTERVAL_SECONDS,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    ),
  };
}

function optionalSeconds(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EdgeConnectorError('invalid_input', `'${field}' must be an integer (seconds)`);
  }
  if (value < min || value > max) {
    throw new EdgeConnectorError('invalid_input', `'${field}' must be between ${min} and ${max}`);
  }
  return value;
}

export interface ValidatedRevokeInput {
  edgeId: string;
  reason: string | null;
}

export function validateRevokeEdgeRuntimeInput(input: unknown): ValidatedRevokeInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'revokeEdgeRuntime input must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'reason'], 'revokeEdgeRuntime input');
  const edgeId = requireUuid(input.edgeId, 'edgeId');
  const reason = optionalText(input.reason, 'reason', MAX_DESCRIPTION_LENGTH);
  return { edgeId, reason };
}

export interface ValidatedSetAllowlistInput {
  edgeId: string;
  allowlist: ValidatedAllowlistEntry[];
}

export function validateSetEdgeAllowlistInput(input: unknown): ValidatedSetAllowlistInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'setEdgeAllowlist input must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'allowlist'], 'setEdgeAllowlist input');
  const edgeId = requireUuid(input.edgeId, 'edgeId');
  if (input.allowlist === undefined) {
    throw new EdgeConnectorError('invalid_input', "'allowlist' is required");
  }
  return { edgeId, allowlist: validateAllowlist(input.allowlist, 'allowlist') };
}

export interface ValidatedGetEdgeQuery {
  edgeId: string;
}

export function validateGetEdgeRuntimeQuery(input: unknown): ValidatedGetEdgeQuery {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_query', 'getEdgeRuntime query must be an object');
  }
  rejectUnknownKeys(input, ['edgeId'], 'getEdgeRuntime query');
  return { edgeId: requireUuid(input.edgeId, 'edgeId') };
}

export interface ValidatedListRuntimesQuery {
  health: string | null;
  limit: number;
}

export function validateListEdgeRuntimesQuery(input: unknown): ValidatedListRuntimesQuery {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_query', 'listEdgeRuntimes query must be an object');
  }
  rejectUnknownKeys(input, ['health', 'limit'], 'listEdgeRuntimes query');
  const health =
    input.health === undefined || input.health === null
      ? null
      : typeof input.health === 'string' &&
          ['pending', 'connected', 'stale', 'revoked'].includes(input.health)
        ? input.health
        : null;
  if (input.health !== undefined && input.health !== null && health === null) {
    throw new EdgeConnectorError(
      'invalid_query',
      "'health' must be one of pending, connected, stale, revoked",
    );
  }
  return { health, limit: optionalLimit(input.limit, 'limit', MAX_LIST_LIMIT) };
}

export interface ValidatedEdgeScopedQuery {
  edgeId: string;
  limit: number;
}

export function validateListEdgeHeartbeatsQuery(input: unknown): ValidatedEdgeScopedQuery {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_query', 'listEdgeHeartbeats query must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'limit'], 'listEdgeHeartbeats query');
  return {
    edgeId: requireUuid(input.edgeId, 'edgeId'),
    limit: optionalLimit(input.limit, 'limit', MAX_LIST_LIMIT),
  };
}

export function validateListEdgeEventsQuery(input: unknown): ValidatedEdgeScopedQuery {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_query', 'listEdgeEvents query must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'limit'], 'listEdgeEvents query');
  return {
    edgeId: requireUuid(input.edgeId, 'edgeId'),
    limit: optionalLimit(input.limit, 'limit', MAX_LIST_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Heartbeat report
// ---------------------------------------------------------------------------

export interface ValidatedHeartbeatReport {
  version: string;
  capabilities: EdgeConnectivityKind[] | null;
  pendingJobs: number | null;
}

export function validateEdgeHeartbeatReport(input: unknown): ValidatedHeartbeatReport {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'the heartbeat report must be an object');
  }
  rejectUnknownKeys(input, ['version', 'capabilities', 'pendingJobs'], 'the heartbeat report');
  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'version' must be a semver string (e.g. '1.4.2', at most ${MAX_VERSION_LENGTH} characters)`,
    );
  }
  let capabilities: EdgeConnectivityKind[] | null = null;
  if (input.capabilities !== undefined && input.capabilities !== null) {
    capabilities = validateConnectivityList(input.capabilities, 'capabilities');
  }
  let pendingJobs: number | null = null;
  if (input.pendingJobs !== undefined && input.pendingJobs !== null) {
    if (
      typeof input.pendingJobs !== 'number' ||
      !Number.isInteger(input.pendingJobs) ||
      input.pendingJobs < 0 ||
      input.pendingJobs > MAX_HEARTBEAT_PENDING_JOBS
    ) {
      throw new EdgeConnectorError(
        'invalid_input',
        `'pendingJobs' must be an integer between 0 and ${MAX_HEARTBEAT_PENDING_JOBS}`,
      );
    }
    pendingJobs = input.pendingJobs;
  }
  return { version: input.version, capabilities, pendingJobs };
}

// ---------------------------------------------------------------------------
// Job issue input
// ---------------------------------------------------------------------------

export interface ValidatedIssueJobInput {
  edgeId: string;
  kind: EdgeJobKind;
  capabilityKey: string;
  target: string;
  payload: Record<string, unknown> | null;
  credentialRef: string | null;
  systemKey: string | null;
  idempotencyKey: string | null;
  ttlSeconds: number;
}

export function validateIssueEdgeJobInput(input: unknown): ValidatedIssueJobInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'issueEdgeJob input must be an object');
  }
  rejectUnknownKeys(
    input,
    [
      'edgeId',
      'kind',
      'capabilityKey',
      'target',
      'payload',
      'credentialRef',
      'systemKey',
      'idempotencyKey',
      'ttlSeconds',
    ],
    'issueEdgeJob input',
  );
  const edgeId = requireUuid(input.edgeId, 'edgeId');
  if (!isEdgeJobKind(input.kind)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'kind' must be one of ${EDGE_JOB_KINDS.join(', ')}`,
    );
  }
  const capabilityKey = requireCapabilityKey(input.capabilityKey, 'capabilityKey');
  const expectedMode = modeOfCapabilityKey(capabilityKey);
  if (input.kind === 'inspect' && expectedMode !== 'read') {
    throw new EdgeConnectorError(
      'invalid_input',
      `an 'inspect' job must exercise a read.* capability (got '${capabilityKey}')`,
    );
  }
  if (input.kind === 'execute' && expectedMode !== 'write') {
    throw new EdgeConnectorError(
      'invalid_input',
      `an 'execute' job must exercise a write.* capability (got '${capabilityKey}')`,
    );
  }
  if (typeof input.target !== 'string' || input.target.length < 1 || input.target.length > MAX_TARGET_LENGTH) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'target' must be an opaque string of 1..${MAX_TARGET_LENGTH} characters`,
    );
  }
  let payload: Record<string, unknown> | null = null;
  if (input.payload !== undefined && input.payload !== null) {
    if (input.kind === 'inspect') {
      throw new EdgeConnectorError(
        'invalid_input',
        "an 'inspect' job carries no payload (it is a canonical state read)",
      );
    }
    if (!isPlainObject(input.payload)) {
      throw new EdgeConnectorError('invalid_input', "'payload' must be a JSON object");
    }
    requireBoundedJsonValue(input.payload, 'payload', MAX_PAYLOAD_BYTES);
    payload = input.payload;
  }
  if (input.kind === 'execute' && payload === null) {
    throw new EdgeConnectorError(
      'invalid_input',
      "an 'execute' job requires a payload object",
    );
  }
  const credentialRef = optionalText(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
  );
  // The advisory system key is the W081 inventory's opaque descriptor
  // (e.g. '<sourceId>:<externalId>') — length-bounded, never interpreted.
  const systemKey = optionalText(input.systemKey, 'systemKey', MAX_SYSTEM_KEY_LENGTH, 3);
  return {
    edgeId,
    kind: input.kind,
    capabilityKey,
    target: input.target,
    payload,
    credentialRef,
    systemKey,
    idempotencyKey: optionalIdempotencyKey(input.idempotencyKey, 'idempotencyKey'),
    ttlSeconds: optionalSeconds(
      input.ttlSeconds,
      'ttlSeconds',
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS,
      DEFAULT_TTL_SECONDS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Job queries
// ---------------------------------------------------------------------------

export interface ValidatedGetJobQuery {
  jobId: string;
}

export function validateGetEdgeJobQuery(input: unknown): ValidatedGetJobQuery {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_query', 'getEdgeJob query must be an object');
  }
  rejectUnknownKeys(input, ['jobId'], 'getEdgeJob query');
  return { jobId: requireUuid(input.jobId, 'jobId') };
}

export interface ValidatedListJobsQuery {
  edgeId: string | null;
  state: EdgeJobState | null;
  limit: number;
}

export function validateListEdgeJobsQuery(input: unknown): ValidatedListJobsQuery {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_query', 'listEdgeJobs query must be an object');
  }
  rejectUnknownKeys(input, ['edgeId', 'state', 'limit'], 'listEdgeJobs query');
  const edgeId =
    input.edgeId === undefined || input.edgeId === null
      ? null
      : requireUuid(input.edgeId, 'edgeId');
  const state =
    input.state === undefined || input.state === null
      ? null
      : isEdgeJobState(input.state)
        ? input.state
        : null;
  if (input.state !== undefined && input.state !== null && state === null) {
    throw new EdgeConnectorError(
      'invalid_query',
      `'state' must be one of ${EDGE_JOB_STATES.join(', ')}`,
    );
  }
  return { edgeId, state, limit: optionalLimit(input.limit, 'limit', MAX_LIST_LIMIT) };
}

// ---------------------------------------------------------------------------
// Dial-home inputs (authentication, pull, submit)
// ---------------------------------------------------------------------------

export interface ValidatedEdgeAuthentication {
  tenantId: string;
  edgeId: string;
  requestNonce: string;
  proof: string;
}

export function validateEdgeAuthentication(
  purpose: 'heartbeat' | 'pull' | 'submit',
  input: unknown,
): ValidatedEdgeAuthentication {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `the ${purpose} authentication must be an object`,
    );
  }
  rejectUnknownKeys(input, ['tenantId', 'edgeId', 'requestNonce', 'proof'], 'edge authentication');
  const tenantId = requireUuid(input.tenantId, 'auth.tenantId');
  const edgeId = requireUuid(input.edgeId, 'auth.edgeId');
  if (
    typeof input.requestNonce !== 'string' ||
    !REQUEST_NONCE_PATTERN.test(input.requestNonce)
  ) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'auth.requestNonce' must match ${REQUEST_NONCE_PATTERN.source}`,
    );
  }
  if (typeof input.proof !== 'string' || !SIGNATURE_HEX_PATTERN.test(input.proof)) {
    throw new EdgeConnectorError(
      'invalid_input',
      "'auth.proof' must be a hex HMAC-SHA256 signature (64 characters)",
    );
  }
  return { tenantId, edgeId, requestNonce: input.requestNonce, proof: input.proof };
}

export interface ValidatedPullInput {
  limit: number;
}

export function validatePullPendingEdgeJobsInput(input: unknown): ValidatedPullInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'pullPendingEdgeJobs input must be an object');
  }
  rejectUnknownKeys(input, ['limit'], 'pullPendingEdgeJobs input');
  if (input.limit === undefined || input.limit === null) return { limit: DEFAULT_PULL_LIMIT };
  if (
    typeof input.limit !== 'number' ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_PULL_LIMIT
  ) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'limit' must be an integer between 1 and ${MAX_PULL_LIMIT}`,
    );
  }
  return { limit: input.limit };
}

export interface ValidatedSubmitResultInput {
  jobId: string;
  result: ValidatedEdgeResult;
}

export interface ValidatedEdgeResult {
  receipt: { status: EdgeReceiptStatus; receiptId: string | null; detail: string | null };
  state: { found: boolean; state: unknown } | null;
}

/**
 * Validates the SUBMITTED result (a canonical receipt, and for inspect
 * jobs the normalized read state). This is the shape guard; the service
 * additionally canonicalizes for provider objects (plain-JSON proof) —
 * validation here stays pure and structural.
 */
export function validateEdgeJobResult(value: unknown, kind: EdgeJobKind): ValidatedEdgeResult {
  if (!isPlainObject(value)) {
    throw new EdgeConnectorError('invalid_input', 'the submitted result must be an object');
  }
  rejectUnknownKeys(value, ['receipt', 'state'], 'the submitted result');
  if (!isPlainObject(value.receipt)) {
    throw new EdgeConnectorError('invalid_input', "the result's 'receipt' must be an object");
  }
  rejectUnknownKeys(value.receipt, ['status', 'receiptId', 'detail'], 'the result receipt');
  if (!isEdgeReceiptStatus(value.receipt.status)) {
    throw new EdgeConnectorError(
      'invalid_input',
      `'receipt.status' must be one of ${EDGE_RECEIPT_STATUSES.join(', ')} (the W084 taxonomy)`,
    );
  }
  const receiptId = optionalText(
    value.receipt.receiptId,
    'receipt.receiptId',
    MAX_RECEIPT_ID_LENGTH,
  );
  const detail = optionalText(
    value.receipt.detail,
    'receipt.detail',
    MAX_RECEIPT_DETAIL_LENGTH,
  );
  let state: { found: boolean; state: unknown } | null = null;
  if (value.state !== undefined && value.state !== null) {
    if (!isPlainObject(value.state)) {
      throw new EdgeConnectorError('invalid_input', "the result's 'state' must be an object");
    }
    rejectUnknownKeys(value.state, ['found', 'state'], 'the result state');
    if (typeof value.state.found !== 'boolean') {
      throw new EdgeConnectorError(
        'invalid_input',
        "the result state's 'found' must be a boolean",
      );
    }
    requireBoundedJsonValue(value.state.state ?? null, 'state.state', MAX_RESULT_STATE_BYTES);
    state = { found: value.state.found, state: value.state.state ?? null };
  }
  // An ACCEPTED inspect result must carry its normalized read state (the
  // read is the product); a refused/failed inspect result may omit it.
  if (kind === 'inspect' && value.receipt.status === 'accepted' && state === null) {
    throw new EdgeConnectorError(
      'invalid_input',
      "an accepted 'inspect' result must carry its normalized read state",
    );
  }
  return { receipt: { status: value.receipt.status, receiptId, detail }, state };
}

export function validateSubmitEdgeJobResultInput(input: unknown): ValidatedSubmitResultInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_input', 'submitEdgeJobResult input must be an object');
  }
  rejectUnknownKeys(input, ['jobId', 'result'], 'submitEdgeJobResult input');
  const jobId = requireUuid(input.jobId, 'jobId');
  // The kind-specific state requirement is re-checked in the service once
  // the job's kind is known; structurally validate with the looser shape.
  const result = validateEdgeJobResult(input.result, 'execute');
  return { jobId, result };
}

// ---------------------------------------------------------------------------
// Envelope verification input
// ---------------------------------------------------------------------------

/**
 * Unknown-key rejection for ENVELOPE validation (the `invalid_envelope`
 * family, so envelope problems are distinguishable from input-shape
 * problems on the verify path).
 */
function rejectUnknownEnvelopeKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new EdgeConnectorError(
        'invalid_envelope',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

export interface ValidatedVerifyEnvelopeInput {
  envelope: SignedEdgeJobEnvelope;
}

/**
 * Validates a presented SIGNED envelope (the direct input of
 * `verifyEdgeJobEnvelope`): the {envelope, signature} shape, the
 * envelope body's frozen fields and their orderings.
 */
export function validateVerifyEdgeJobEnvelopeInput(input: unknown): ValidatedVerifyEnvelopeInput {
  if (!isPlainObject(input)) {
    throw new EdgeConnectorError('invalid_envelope', 'the signed envelope must be an object');
  }
  const signed = input as Record<string, unknown>;
  rejectUnknownEnvelopeKeys(signed, ['envelope', 'signature'], 'the signed envelope');
  if (!isPlainObject(signed.envelope)) {
    throw new EdgeConnectorError('invalid_envelope', 'the envelope body must be an object');
  }
  if (typeof signed.signature !== 'string' || !SIGNATURE_HEX_PATTERN.test(signed.signature)) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      'the envelope signature must be a hex HMAC-SHA256 signature (64 characters)',
    );
  }
  const body = signed.envelope as Record<string, unknown>;
  rejectUnknownEnvelopeKeys(
    body,
    [
      'jobId',
      'keyId',
      'tenantId',
      'edgeId',
      'kind',
      'capabilityKey',
      'target',
      'payload',
      'credentialRef',
      'systemKey',
      'nonce',
      'issuedAt',
      'expiresAt',
    ],
    'the envelope body',
  );
  const envelope: EdgeJobEnvelope = {
    jobId: requireUuid(body.jobId, 'envelope.jobId'),
    keyId: optionalText(body.keyId, 'envelope.keyId', MAX_SIGNING_KEY_ID_LENGTH)!,
    tenantId: requireUuid(body.tenantId, 'envelope.tenantId'),
    edgeId: requireUuid(body.edgeId, 'envelope.edgeId'),
    kind: isEdgeJobKind(body.kind) ? body.kind : invalidKind(),
    capabilityKey: requireCapabilityKey(body.capabilityKey, 'envelope.capabilityKey'),
    target:
      typeof body.target === 'string' && body.target.length >= 1 && body.target.length <= MAX_TARGET_LENGTH
        ? body.target
        : invalidTarget(),
    payload: body.payload === undefined ? null : body.payload,
    credentialRef: optionalText(
      body.credentialRef,
      'envelope.credentialRef',
      MAX_CREDENTIAL_REF_LENGTH,
    ),
    systemKey: optionalText(body.systemKey, 'envelope.systemKey', MAX_SYSTEM_KEY_LENGTH, 3),
    nonce: requireUuid(body.nonce, 'envelope.nonce'),
    issuedAt: requireIsoTimestamp(body.issuedAt, 'envelope.issuedAt'),
    expiresAt: requireIsoTimestamp(body.expiresAt, 'envelope.expiresAt'),
  };
  if (envelope.kind === 'inspect' && envelope.payload !== null) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      "an 'inspect' envelope must carry no payload",
    );
  }
  if (envelope.expiresAt <= envelope.issuedAt) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      'the envelope expiry must be after its issuance',
    );
  }
  return { envelope: { envelope, signature: signed.signature } };
}

function invalidKind(): never {
  throw new EdgeConnectorError(
    'invalid_envelope',
    `'kind' must be one of ${EDGE_JOB_KINDS.join(', ')}`,
  );
}

function invalidTarget(): never {
  throw new EdgeConnectorError(
    'invalid_envelope',
    `'target' must be an opaque string of 1..${MAX_TARGET_LENGTH} characters`,
  );
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new EdgeConnectorError('invalid_envelope', `'${field}' must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new EdgeConnectorError(
      'invalid_envelope',
      `'${field}' must be an ISO timestamp (got '${value}')`,
    );
  }
  return new Date(parsed).toISOString();
}
