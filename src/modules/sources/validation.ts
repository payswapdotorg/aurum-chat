// Pure validation/normalization logic of the sources module (no database,
// no clock, no network). Everything a caller, an adapter or a transport may
// put into the ingestion path crosses these guards first; the SQL CHECK
// constraints in migrations/001 and /002 mirror the load-bearing rules as
// defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `createdAt` or credential VALUES into a source record — the
// connector's identity, tenancy and commit times are minted by the system,
// and secrets never enter domain tables at all (IMPLEMENTATION-STACK §8).

import type { TenantContext } from '@/infra/tenant';
import { SourcesError } from './errors';
import type {
  GetSourceCheckpointQuery,
  ListSourceCheckpointsQuery,
  ListSourcesQuery,
  PollSourceInput,
  ReceiveWebhookInput,
  RegisterSourceInput,
  ReplaySourceInput,
  SetSourceStatusInput,
  SourceAuthKind,
  SourceIngestionMode,
  SourceIngestionVia,
  SourceProvider,
  SourceStatus,
} from './types';

/** Canonical source-provider vocabulary (mirrored by the migration CHECK and the adapter registry). */
export const SOURCE_PROVIDERS = [
  'salesforce',
  'hubspot',
  'zendesk',
  'jira',
  'linear',
  'confluence',
  'notion',
  'github',
  'google-drive',
  'google-calendar',
  'stripe',
  'quickbooks',
  'zapier',
] as const;

export const SOURCE_STATUSES = ['active', 'disabled'] as const;
export const SOURCE_AUTH_KINDS = ['oauth', 'credentials'] as const;
export const SOURCE_INGESTION_MODES = ['polling', 'webhook'] as const;
export const SOURCE_INGESTION_VIAS = ['polling', 'webhook'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MAX_RECORDS = 50;
export const MAX_MAX_RECORDS = 200;
/** Hard cap on one ingestion batch, whatever the caller asked for. */
export const MAX_BATCH_RECORDS = 200;
export const MAX_PAYLOAD_BYTES = 1_048_576; // mirrors the observations module's cap
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_OAUTH_SCOPES = 32;
export const MAX_SCOPE_LENGTH = 255;
export const MAX_CURSOR_LENGTH = 1024;
export const MAX_PROVIDER_RECORD_ID_LENGTH = 255;
export const MAX_KIND_LENGTH = 128;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Canonical classification — the SAME pattern the observations module
// enforces on observation kinds, so a validated record can never be
// rejected downstream.
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Strict ISO 8601 with an explicit offset — provider event times are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_ID_PATTERN = /^[\P{C}\s]+$/u;

const REGISTER_INPUT_KEYS = [
  'provider',
  'providerAccountId',
  'displayName',
  'authKind',
  'credentialRef',
  'oauthScopes',
  'oauthExpiresAt',
] as const;
const LIST_SOURCES_QUERY_KEYS = ['provider', 'status', 'limit'] as const;
const SET_STATUS_INPUT_KEYS = ['sourceId', 'status'] as const;
const POLL_INPUT_KEYS = ['sourceId', 'maxRecords'] as const;
const RECEIVE_WEBHOOK_INPUT_KEYS = ['provider', 'payload'] as const;
const GET_CHECKPOINT_QUERY_KEYS = ['sourceId'] as const;
const LIST_CHECKPOINTS_QUERY_KEYS = ['sourceId', 'limit'] as const;
const REPLAY_INPUT_KEYS = ['sourceId', 'checkpointId', 'fromStart'] as const;
const RECORD_KEYS = ['providerRecordId', 'kind', 'payload', 'occurredAt'] as const;
const FETCH_RESULT_KEYS = [
  'records',
  'nextCursor',
  'hasMore',
  'authorizationExpiresAt',
] as const;
const WEBHOOK_PARSE_KEYS = ['providerAccountId', 'records'] as const;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isSourceProvider(value: unknown): value is SourceProvider {
  return (
    typeof value === 'string' &&
    (SOURCE_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isSourceStatus(value: unknown): value is SourceStatus {
  return (
    typeof value === 'string' &&
    (SOURCE_STATUSES as readonly string[]).includes(value)
  );
}

export function isSourceAuthKind(value: unknown): value is SourceAuthKind {
  return (
    typeof value === 'string' &&
    (SOURCE_AUTH_KINDS as readonly string[]).includes(value)
  );
}

export function isSourceIngestionMode(value: unknown): value is SourceIngestionMode {
  return (
    typeof value === 'string' &&
    (SOURCE_INGESTION_MODES as readonly string[]).includes(value)
  );
}

export function isSourceIngestionVia(value: unknown): value is SourceIngestionVia {
  return (
    typeof value === 'string' &&
    (SOURCE_INGESTION_VIAS as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertSourcesTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new SourcesError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new SourcesError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new SourcesError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared primitive helpers
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
  fail: (message: string) => SourcesError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw fail(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** Deep JSON check: only plain JSON values survive (house pattern). */
function checkJsonValue(
  value: unknown,
  where: string,
  depth: number,
  fail: (message: string) => SourcesError,
): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw fail(`${where} must be finite (got ${String(value)})`);
    return;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    throw fail(`${where} contains a non-JSON value of type ${type}`);
  }
  if (depth > 64) {
    throw fail(`${where} exceeds the maximum nesting depth of 64`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkJsonValue(entry, `${where}[${index}]`, depth + 1, fail);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw fail(`${where} must be a plain JSON value (no class instances)`);
  }
  for (const key of Object.keys(value)) {
    checkJsonValue(value[key], `${where}.${key}`, depth + 1, fail);
  }
}

function requireString(
  value: unknown,
  field: string,
  fail: (message: string) => SourcesError,
): string {
  if (typeof value !== 'string') throw fail(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw fail(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  fail: (message: string) => SourcesError,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fail(`${field} must be a string when present`);
  const text = value.trim();
  return text === '' ? null : text;
}

function requirePrintable(
  value: unknown,
  field: string,
  maxLength: number,
  fail: (message: string) => SourcesError,
): string {
  const text = requireString(value, field, fail);
  if (text.length > maxLength) {
    throw fail(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  if (!PRINTABLE_ID_PATTERN.test(text)) {
    throw fail(
      `${field} must be 1..${maxLength} printable characters without control characters`,
    );
  }
  return text;
}

function requireUuid(
  value: unknown,
  field: string,
  fail: (message: string) => SourcesError,
): string {
  const text = requireString(value, field, fail);
  if (!UUID_PATTERN.test(text)) {
    throw fail(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIsoInstant(
  value: unknown,
  field: string,
  fail: (message: string) => SourcesError,
): string {
  const text = requireString(value, field, fail);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw fail(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

function optionalIsoInstant(
  value: unknown,
  field: string,
  fail: (message: string) => SourcesError,
): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field, fail);
}

function requireLimit(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
  fail: (message: string) => SourcesError,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw fail(`${field} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}

function inputError(message: string): SourcesError {
  return new SourcesError('invalid_source_input', message);
}

function queryError(message: string): SourcesError {
  return new SourcesError('invalid_source_query', message);
}

function payloadError(message: string): SourcesError {
  return new SourcesError('invalid_provider_payload', message);
}

function fetchResultError(message: string): SourcesError {
  return new SourcesError('invalid_fetch_result', message);
}

// ---------------------------------------------------------------------------
// Source registration / queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterSourceInput`. */
export interface ValidatedRegisterSourceInput {
  provider: SourceProvider;
  providerAccountId: string;
  displayName: string | null;
  authKind: SourceAuthKind;
  credentialRef: string;
  oauthScopes: string[];
  oauthExpiresAt: string | null;
}

export function validateRegisterSourceInput(input: RegisterSourceInput): ValidatedRegisterSourceInput {
  if (!isPlainObject(input)) throw inputError('source input must be an object');
  rejectUnknownKeys(input, REGISTER_INPUT_KEYS, 'the source input', inputError);

  if (!isSourceProvider(input.provider)) {
    throw inputError(
      `provider must be one of ${SOURCE_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
    );
  }
  const providerAccountId = requirePrintable(
    input.providerAccountId,
    'providerAccountId',
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
    inputError,
  );
  const displayName = optionalTrimmed(input.displayName, 'displayName', inputError);
  if (displayName !== null && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw inputError(
      `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${displayName.length})`,
    );
  }
  if (!isSourceAuthKind(input.authKind)) {
    throw inputError(
      `authKind must be one of ${SOURCE_AUTH_KINDS.join(', ')} (got '${String(input.authKind)}')`,
    );
  }
  const credentialRef = requirePrintable(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
    inputError,
  );

  // OAuth state coherence: scopes/expiry are OAuth concepts only.
  const scopes: string[] = [];
  if (input.oauthScopes !== undefined && input.oauthScopes !== null) {
    if (!Array.isArray(input.oauthScopes)) {
      throw inputError('oauthScopes must be an array of scope strings when present');
    }
    if (input.oauthScopes.length > MAX_OAUTH_SCOPES) {
      throw inputError(
        `oauthScopes supports at most ${MAX_OAUTH_SCOPES} entries (got ${input.oauthScopes.length})`,
      );
    }
    for (const [index, scope] of input.oauthScopes.entries()) {
      const normalized = requirePrintable(
        scope,
        `oauthScopes[${index}]`,
        MAX_SCOPE_LENGTH,
        inputError,
      );
      if (scopes.includes(normalized)) {
        throw inputError(`oauthScopes contains a duplicate scope '${normalized}'`);
      }
      scopes.push(normalized);
    }
  }
  const oauthExpiresAt = optionalIsoInstant(input.oauthExpiresAt, 'oauthExpiresAt', inputError);
  if (input.authKind === 'credentials' && (scopes.length > 0 || oauthExpiresAt !== null)) {
    throw inputError(
      'credentials-authorized sources carry no OAuth state — omit oauthScopes and oauthExpiresAt',
    );
  }
  if (input.authKind === 'oauth' && scopes.length === 0) {
    throw inputError('oauth-authorized sources must declare at least one granted scope');
  }

  return {
    provider: input.provider,
    providerAccountId,
    displayName,
    authKind: input.authKind,
    credentialRef,
    oauthScopes: scopes,
    oauthExpiresAt,
  };
}

/** Fully validated + normalized form of `ListSourcesQuery`. */
export interface ValidatedListSourcesQuery {
  provider: SourceProvider | null;
  status: SourceStatus | null;
  limit: number;
}

export function validateListSourcesQuery(query: ListSourcesQuery): ValidatedListSourcesQuery {
  if (!isPlainObject(query)) throw queryError('sources query must be an object');
  rejectUnknownKeys(query, LIST_SOURCES_QUERY_KEYS, 'the sources query', queryError);
  if (query.provider !== undefined && query.provider !== null && !isSourceProvider(query.provider)) {
    throw queryError(
      `provider must be one of ${SOURCE_PROVIDERS.join(', ')} (got '${String(query.provider)}')`,
    );
  }
  if (query.status !== undefined && query.status !== null && !isSourceStatus(query.status)) {
    throw queryError(`status must be one of ${SOURCE_STATUSES.join(', ')} (got '${String(query.status)}')`);
  }
  return {
    provider: query.provider ?? null,
    status: query.status ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export function validateSetSourceStatusInput(input: SetSourceStatusInput): {
  sourceId: string;
  status: SourceStatus;
} {
  if (!isPlainObject(input)) throw inputError('status input must be an object');
  rejectUnknownKeys(input, SET_STATUS_INPUT_KEYS, 'the status input', inputError);
  const sourceId = requireUuid(input.sourceId, 'sourceId', inputError);
  if (!isSourceStatus(input.status)) {
    throw inputError(`status must be one of ${SOURCE_STATUSES.join(', ')} (got '${String(input.status)}')`);
  }
  return { sourceId, status: input.status };
}

// ---------------------------------------------------------------------------
// Polling / webhook inputs
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `PollSourceInput`. */
export interface ValidatedPollInput {
  sourceId: string;
  maxRecords: number;
}

export function validatePollSourceInput(input: PollSourceInput): ValidatedPollInput {
  if (!isPlainObject(input)) throw inputError('poll input must be an object');
  rejectUnknownKeys(input, POLL_INPUT_KEYS, 'the poll input', inputError);
  const sourceId = requireUuid(input.sourceId, 'sourceId', inputError);
  return {
    sourceId,
    maxRecords: requireLimit(
      input.maxRecords,
      'maxRecords',
      DEFAULT_MAX_RECORDS,
      MAX_MAX_RECORDS,
      inputError,
    ),
  };
}

/** Fully validated + normalized form of `ReceiveWebhookInput` (payload stays raw for the adapter). */
export interface ValidatedReceiveWebhookInput {
  provider: SourceProvider;
}

export function validateReceiveWebhookInput(input: ReceiveWebhookInput): ValidatedReceiveWebhookInput {
  if (!isPlainObject(input)) throw inputError('webhook input must be an object');
  rejectUnknownKeys(input, RECEIVE_WEBHOOK_INPUT_KEYS, 'the webhook input', inputError);
  if (!isSourceProvider(input.provider)) {
    throw inputError(
      `provider must be one of ${SOURCE_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
    );
  }
  // Provider envelopes are JSON objects; arrays/scalars are malformed before
  // any adapter inspects them.
  if (!isPlainObject(input.payload)) {
    throw payloadError('webhook payload must be a JSON object');
  }
  return { provider: input.provider };
}

// ---------------------------------------------------------------------------
// Checkpoint queries / replay
// ---------------------------------------------------------------------------

export function validateGetSourceCheckpointQuery(query: GetSourceCheckpointQuery): {
  sourceId: string;
} {
  if (!isPlainObject(query)) throw queryError('checkpoint query must be an object');
  rejectUnknownKeys(query, GET_CHECKPOINT_QUERY_KEYS, 'the checkpoint query', queryError);
  return { sourceId: requireUuid(query.sourceId, 'sourceId', queryError) };
}

/** Fully validated + normalized form of `ListSourceCheckpointsQuery`. */
export interface ValidatedListCheckpointsQuery {
  sourceId: string;
  limit: number;
}

export function validateListSourceCheckpointsQuery(
  query: ListSourceCheckpointsQuery,
): ValidatedListCheckpointsQuery {
  if (!isPlainObject(query)) throw queryError('checkpoints query must be an object');
  rejectUnknownKeys(query, LIST_CHECKPOINTS_QUERY_KEYS, 'the checkpoints query', queryError);
  return {
    sourceId: requireUuid(query.sourceId, 'sourceId', queryError),
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export function validateReplaySourceInput(input: ReplaySourceInput): {
  sourceId: string;
  checkpointId: string | null;
  fromStart: boolean;
} {
  if (!isPlainObject(input)) throw inputError('replay input must be an object');
  rejectUnknownKeys(input, REPLAY_INPUT_KEYS, 'the replay input', inputError);
  const sourceId = requireUuid(input.sourceId, 'sourceId', inputError);
  if (input.fromStart !== undefined && typeof input.fromStart !== 'boolean') {
    throw inputError('fromStart must be a boolean when present');
  }
  const hasCheckpoint = input.checkpointId !== undefined && input.checkpointId !== null;
  const fromStart = input.fromStart === true;
  if (hasCheckpoint === fromStart) {
    throw inputError(
      'replay requires exactly one target: a checkpointId or fromStart=true',
    );
  }
  const checkpointId = hasCheckpoint
    ? requireUuid(input.checkpointId, 'checkpointId', inputError)
    : null;
  return { sourceId, checkpointId, fromStart };
}

// ---------------------------------------------------------------------------
// Canonical records (adapter/transport output — defense in depth)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CanonicalSourceRecord`. */
export interface ValidatedRecord {
  providerRecordId: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
}

/**
 * Validates one canonical source record. `fail` builds the context's error
 * (webhook-adapter output fails `invalid_provider_payload`; transport
 * output fails `invalid_fetch_result`) — the record shape itself is one
 * contract, so a buggy adapter cannot smuggle a malformed record past the
 * boundary and neither can a misbehaving transport.
 */
export function validateCanonicalSourceRecord(
  value: unknown,
  fail: (message: string) => SourcesError,
): ValidatedRecord {
  if (!isPlainObject(value)) throw fail('record must be an object');
  rejectUnknownKeys(value, RECORD_KEYS, 'record', fail);
  const providerRecordId = requirePrintable(
    value.providerRecordId,
    'record.providerRecordId',
    MAX_PROVIDER_RECORD_ID_LENGTH,
    fail,
  );
  const kind = requireString(value.kind, 'record.kind', fail);
  if (kind.length > MAX_KIND_LENGTH || !KIND_PATTERN.test(kind)) {
    throw fail(
      `record.kind must be a canonical classification matching ${KIND_PATTERN.source} (got '${kind}')`,
    );
  }
  if (value.payload === undefined || value.payload === null) {
    throw fail('record.payload must be a non-null JSON value');
  }
  checkJsonValue(value.payload, 'record.payload', 0, fail);
  const serializedLength = JSON.stringify(value.payload)?.length ?? 0;
  if (serializedLength > MAX_PAYLOAD_BYTES) {
    throw fail(
      `record.payload exceeds the maximum of ${MAX_PAYLOAD_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }
  const occurredAt = requireIsoInstant(value.occurredAt, 'record.occurredAt', fail);
  return { providerRecordId, kind, payload: value.payload, occurredAt };
}

/**
 * Validates a whole ingestion batch: bounded size, every record valid, and
 * NO duplicate provider record ids inside one batch (an ambiguous batch is
 * rejected outright rather than silently collapsed).
 */
export function validateRecordBatch(
  records: unknown,
  fail: (message: string) => SourcesError,
): ValidatedRecord[] {
  if (!Array.isArray(records)) throw fail('records must be an array');
  if (records.length > MAX_BATCH_RECORDS) {
    throw fail(
      `records supports at most ${MAX_BATCH_RECORDS} entries per batch (got ${records.length})`,
    );
  }
  const validated: ValidatedRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of records.entries()) {
    const record = validateCanonicalSourceRecord(entry, fail);
    if (seen.has(record.providerRecordId)) {
      throw fail(
        `records[${index}] duplicates provider record id '${record.providerRecordId}' within one batch`,
      );
    }
    seen.add(record.providerRecordId);
    validated.push(record);
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Fetch results / webhook parse results
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `SourceFetchResult`. */
export interface ValidatedFetchResult {
  records: ValidatedRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  authorizationExpiresAt: string | null;
}

export function validateFetchResult(value: unknown): ValidatedFetchResult {
  if (!isPlainObject(value)) {
    throw fetchResultError('fetch result must be an object');
  }
  rejectUnknownKeys(value, FETCH_RESULT_KEYS, 'the fetch result', fetchResultError);
  const records = validateRecordBatch(value.records, fetchResultError);
  const nextCursor =
    value.nextCursor === undefined || value.nextCursor === null
      ? null
      : requirePrintable(value.nextCursor, 'nextCursor', MAX_CURSOR_LENGTH, fetchResultError);
  if (typeof value.hasMore !== 'boolean') {
    throw fetchResultError('hasMore must be a boolean');
  }
  const authorizationExpiresAt = optionalIsoInstant(
    value.authorizationExpiresAt,
    'authorizationExpiresAt',
    fetchResultError,
  );
  return { records, nextCursor, hasMore: value.hasMore, authorizationExpiresAt };
}

/** Fully validated + normalized webhook-adapter output. */
export interface ValidatedWebhookParseResult {
  providerAccountId: string;
  records: ValidatedRecord[];
}

export function validateWebhookParseResult(value: unknown): ValidatedWebhookParseResult {
  if (!isPlainObject(value)) {
    throw payloadError('webhook parse result must be an object');
  }
  rejectUnknownKeys(value, WEBHOOK_PARSE_KEYS, 'the webhook parse result', payloadError);
  const providerAccountId = requirePrintable(
    value.providerAccountId,
    'providerAccountId',
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
    payloadError,
  );
  const records = validateRecordBatch(value.records, payloadError);
  return { providerAccountId, records };
}

// ---------------------------------------------------------------------------
// Pure checkpoint logic
// ---------------------------------------------------------------------------

/**
 * Whether a completed poll should advance the checkpoint: only when the
 * provider produced a NEW cursor (a null next cursor means "nothing past
 * this window"; an unchanged cursor means "already current").
 */
export function cursorAdvance(current: string | null, next: string | null): boolean {
  return next !== null && next !== current;
}
