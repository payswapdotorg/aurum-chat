// Pure validation/normalization logic of the destinations module (no
// database, no clock, no network). Everything a caller, an adapter or a
// transport may put into the outbound path crosses these guards first; the
// SQL CHECK constraints in migrations/001 and /002 mirror the load-bearing
// rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `requestedAt` or credential VALUES into a delivery — the
// delivery's identity, tenancy and commit times are minted by the system,
// and secrets never enter domain tables at all (IMPLEMENTATION-STACK §8).

import type { TenantContext } from '@/infra/tenant';
import { DestinationsError } from './errors';
import type {
  DispatchDeliveryInput,
  FormattedDelivery,
  FormattedDeliveryShape,
  GetDeliveryQuery,
  ListDeliveriesQuery,
  ListDeliveryAttemptsQuery,
  ListDestinationsQuery,
  RegisterDestinationInput,
  ReplayDeliveryInput,
  RetryDeliveryInput,
  SetDestinationStatusInput,
  TransportReceipt,
  CanonicalOutboundRecord,
  DeliveryOutcome,
  DeliveryStatus,
  DestinationAuthKind,
  DestinationCategory,
  DestinationProvider,
  DestinationStatus,
} from './types';

/** Canonical destination-provider vocabulary (mirrored by the migration CHECK and the adapter registry). */
export const DESTINATION_PROVIDERS = [
  'looker',
  'tableau',
  'power-bi',
  'snowflake',
  'bigquery',
  'redshift',
  'salesforce',
  'hubspot',
  'netsuite',
  'google-sheets',
  'airtable',
  'http-api',
  'webhook',
] as const;

export const DESTINATION_STATUSES = ['active', 'disabled'] as const;
export const DESTINATION_AUTH_KINDS = ['oauth', 'credentials'] as const;
export const DESTINATION_CATEGORIES = [
  'bi',
  'warehouse',
  'crm-erp',
  'spreadsheet',
  'api',
  'webhook',
] as const;
export const DELIVERY_STATUSES = ['pending', 'delivered', 'rejected', 'failed'] as const;
export const DELIVERY_OUTCOMES = ['delivered', 'rejected', 'failed'] as const;
export const FORMATTED_DELIVERY_SHAPES = ['event', 'records', 'rows'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_RECORDS_PER_DELIVERY = 200;
export const MAX_PROVENANCE_OBSERVATIONS = 32;
/** Same cap the observations/actions modules enforce on jsonb payloads. */
export const MAX_PAYLOAD_BYTES = 1_048_576;
/** Adapter envelopes wrap (never expand) the canonical payload; audited copies may breathe. */
export const MAX_ENVELOPE_BYTES = 2_097_152;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_OAUTH_SCOPES = 32;
export const MAX_SCOPE_LENGTH = 255;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_RECORD_ID_LENGTH = 255;
export const MAX_KIND_LENGTH = 128;
export const MAX_PROVIDER_DELIVERY_ID_LENGTH = 255;
export const MAX_DETAIL_LENGTH = 2000;

/**
 * The W004 usage-constraint tag that forbids export through this module
 * (observations record it; destinations — one of the modules the actions
 * contract anticipated would consume evidence-level permissions — enforce
 * it on every delivery that references the observation as provenance).
 */
export const EXPORT_FORBIDDING_USAGE_TAG = 'no-export';

/**
 * The canonical §20 action kind every outbound delivery is authorized
 * under (W009's open kind namespace — W037 registers its kind by using it;
 * 'data-export' is one of CANONICAL_ACTION_KINDS).
 */
export const DELIVERY_ACTION_KIND = 'data-export';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Canonical classification — the SAME pattern the observations/actions
// modules enforce on kinds, so a validated delivery kind is always a
// legal action-gate payload component.
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Strict ISO 8601 with an explicit offset — grant expiries and transport
// refreshes are unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// The same dedupe-key discipline the actions module enforces (mirrored by
// the idempotency_key CHECK in migrations/002).
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
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
const LIST_DESTINATIONS_QUERY_KEYS = ['provider', 'category', 'status', 'limit'] as const;
const SET_STATUS_INPUT_KEYS = ['destinationId', 'status'] as const;
const DISPATCH_INPUT_KEYS = [
  'destinationId',
  'kind',
  'records',
  'provenanceObservationIds',
  'idempotencyKey',
] as const;
const RETRY_INPUT_KEYS = ['deliveryId'] as const;
const GET_DELIVERY_QUERY_KEYS = ['deliveryId'] as const;
const LIST_DELIVERIES_QUERY_KEYS = ['destinationId', 'provider', 'kind', 'status', 'limit'] as const;
const LIST_ATTEMPTS_QUERY_KEYS = ['deliveryId', 'limit'] as const;
const RECORD_KEYS = ['recordId', 'data'] as const;
const FORMATTED_DELIVERY_KEYS = ['shape', 'body'] as const;
const TRANSPORT_RECEIPT_KEYS = ['status', 'providerDeliveryId', 'detail', 'authorizationExpiresAt'] as const;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isDestinationProvider(value: unknown): value is DestinationProvider {
  return (
    typeof value === 'string' &&
    (DESTINATION_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isDestinationStatus(value: unknown): value is DestinationStatus {
  return (
    typeof value === 'string' &&
    (DESTINATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isDestinationAuthKind(value: unknown): value is DestinationAuthKind {
  return (
    typeof value === 'string' &&
    (DESTINATION_AUTH_KINDS as readonly string[]).includes(value)
  );
}

export function isDestinationCategory(value: unknown): value is DestinationCategory {
  return (
    typeof value === 'string' &&
    (DESTINATION_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return (
    typeof value === 'string' &&
    (DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeliveryOutcome(value: unknown): value is DeliveryOutcome {
  return (
    typeof value === 'string' &&
    (DELIVERY_OUTCOMES as readonly string[]).includes(value)
  );
}

export function isFormattedDeliveryShape(value: unknown): value is FormattedDeliveryShape {
  return (
    typeof value === 'string' &&
    (FORMATTED_DELIVERY_SHAPES as readonly string[]).includes(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertDestinationsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new DestinationsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new DestinationsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new DestinationsError(
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
  fail: (message: string) => DestinationsError,
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
  fail: (message: string) => DestinationsError,
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
  fail: (message: string) => DestinationsError,
): string {
  if (typeof value !== 'string') throw fail(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw fail(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  fail: (message: string) => DestinationsError,
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
  fail: (message: string) => DestinationsError,
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
  fail: (message: string) => DestinationsError,
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
  fail: (message: string) => DestinationsError,
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
  fail: (message: string) => DestinationsError,
): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field, fail);
}

function requireLimit(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
  fail: (message: string) => DestinationsError,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw fail(`${field} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}

function inputError(message: string): DestinationsError {
  return new DestinationsError('invalid_destination_input', message);
}

function queryError(message: string): DestinationsError {
  return new DestinationsError('invalid_destination_query', message);
}

function deliveryInputError(message: string): DestinationsError {
  return new DestinationsError('invalid_delivery_input', message);
}

function deliveryQueryError(message: string): DestinationsError {
  return new DestinationsError('invalid_delivery_query', message);
}

function envelopeError(message: string): DestinationsError {
  return new DestinationsError('invalid_envelope', message);
}

function receiptError(message: string): DestinationsError {
  return new DestinationsError('invalid_transport_receipt', message);
}

// ---------------------------------------------------------------------------
// Destination registration / queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterDestinationInput`. */
export interface ValidatedRegisterDestinationInput {
  provider: DestinationProvider;
  providerAccountId: string;
  displayName: string | null;
  authKind: DestinationAuthKind;
  credentialRef: string;
  oauthScopes: string[];
  oauthExpiresAt: string | null;
}

export function validateRegisterDestinationInput(
  input: RegisterDestinationInput,
): ValidatedRegisterDestinationInput {
  if (!isPlainObject(input)) {
    throw inputError('registerDestination input must be an object');
  }
  rejectUnknownKeys(input, REGISTER_INPUT_KEYS, 'the registerDestination input', inputError);

  if (!isDestinationProvider(input.provider)) {
    throw inputError(
      `provider must be one of: ${DESTINATION_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
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
  if (!isDestinationAuthKind(input.authKind)) {
    throw inputError(
      `authKind must be one of: ${DESTINATION_AUTH_KINDS.join(', ')} (got '${String(input.authKind)}')`,
    );
  }
  const credentialRef = requirePrintable(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
    inputError,
  );

  const scopesRaw = input.oauthScopes ?? [];
  if (!Array.isArray(scopesRaw)) {
    throw inputError('oauthScopes must be an array of scope strings');
  }
  if (scopesRaw.length > MAX_OAUTH_SCOPES) {
    throw inputError(`oauthScopes supports at most ${MAX_OAUTH_SCOPES} entries (got ${scopesRaw.length})`);
  }
  const oauthScopes = scopesRaw.map((scope, index) =>
    requirePrintable(scope, `oauthScopes[${index}]`, MAX_SCOPE_LENGTH, inputError),
  );
  const oauthExpiresAt = optionalIsoInstant(input.oauthExpiresAt, 'oauthExpiresAt', inputError);

  // Credentials destinations carry NO OAuth state (mirrors the sources
  // module's isolation CHECK).
  if (input.authKind === 'credentials' && (oauthScopes.length > 0 || oauthExpiresAt !== null)) {
    throw inputError(
      'credentials-authorized destinations carry no OAuth state (oauthScopes and oauthExpiresAt must be empty)',
    );
  }

  return {
    provider: input.provider,
    providerAccountId,
    displayName,
    authKind: input.authKind,
    credentialRef,
    oauthScopes,
    oauthExpiresAt,
  };
}

/** Fully validated + normalized form of `ListDestinationsQuery`. */
export interface ValidatedListDestinationsQuery {
  provider: DestinationProvider | null;
  category: DestinationCategory | null;
  status: DestinationStatus | null;
  limit: number;
}

export function validateListDestinationsQuery(
  query: ListDestinationsQuery,
): ValidatedListDestinationsQuery {
  if (!isPlainObject(query)) {
    throw queryError('listDestinations query must be an object');
  }
  rejectUnknownKeys(query, LIST_DESTINATIONS_QUERY_KEYS, 'the listDestinations query', queryError);
  if (query.provider !== undefined && !isDestinationProvider(query.provider)) {
    throw queryError(`provider must be one of: ${DESTINATION_PROVIDERS.join(', ')}`);
  }
  if (query.category !== undefined && !isDestinationCategory(query.category)) {
    throw queryError(`category must be one of: ${DESTINATION_CATEGORIES.join(', ')}`);
  }
  if (query.status !== undefined && !isDestinationStatus(query.status)) {
    throw queryError(`status must be one of: ${DESTINATION_STATUSES.join(', ')}`);
  }
  return {
    provider: query.provider ?? null,
    category: query.category ?? null,
    status: query.status ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export interface ValidatedSetStatusInput {
  destinationId: string;
  status: DestinationStatus;
}

export function validateSetDestinationStatusInput(
  input: SetDestinationStatusInput,
): ValidatedSetStatusInput {
  if (!isPlainObject(input)) {
    throw inputError('setDestinationStatus input must be an object');
  }
  rejectUnknownKeys(input, SET_STATUS_INPUT_KEYS, 'the setDestinationStatus input', inputError);
  const destinationId = requireUuid(input.destinationId, 'destinationId', inputError);
  if (!isDestinationStatus(input.status)) {
    throw inputError(`status must be one of: ${DESTINATION_STATUSES.join(', ')}`);
  }
  return { destinationId, status: input.status };
}

// ---------------------------------------------------------------------------
// Delivery dispatch / retry / replay / queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `DispatchDeliveryInput`. */
export interface ValidatedDispatchDeliveryInput {
  destinationId: string;
  kind: string;
  records: CanonicalOutboundRecord[];
  provenanceObservationIds: string[];
  idempotencyKey: string | null;
}

export function validateDispatchDeliveryInput(
  input: DispatchDeliveryInput,
): ValidatedDispatchDeliveryInput {
  if (!isPlainObject(input)) {
    throw deliveryInputError('dispatchDelivery input must be an object');
  }
  rejectUnknownKeys(input, DISPATCH_INPUT_KEYS, 'the dispatchDelivery input', deliveryInputError);

  const destinationId = requireUuid(input.destinationId, 'destinationId', deliveryInputError);

  const kind = requireString(input.kind, 'kind', deliveryInputError);
  if (kind.length > MAX_KIND_LENGTH || !KIND_PATTERN.test(kind)) {
    throw deliveryInputError(
      `kind must be 1..${MAX_KIND_LENGTH} characters matching ${KIND_PATTERN.source} (got '${kind}')`,
    );
  }

  if (!Array.isArray(input.records) || input.records.length === 0) {
    throw deliveryInputError('records must be a non-empty array of outbound records');
  }
  if (input.records.length > MAX_RECORDS_PER_DELIVERY) {
    throw deliveryInputError(
      `records supports at most ${MAX_RECORDS_PER_DELIVERY} entries per delivery (got ${input.records.length})`,
    );
  }
  const records: CanonicalOutboundRecord[] = [];
  const seenRecordIds = new Set<string>();
  let serializedBytes = 0;
  for (const [index, entry] of input.records.entries()) {
    if (!isPlainObject(entry)) {
      throw deliveryInputError(`records[${index}] must be an object`);
    }
    rejectUnknownKeys(entry, RECORD_KEYS, `records[${index}]`, deliveryInputError);
    const recordId = requirePrintable(
      entry.recordId,
      `records[${index}].recordId`,
      MAX_RECORD_ID_LENGTH,
      deliveryInputError,
    );
    if (seenRecordIds.has(recordId)) {
      throw deliveryInputError(`recordId '${recordId}' appears more than once in records`);
    }
    seenRecordIds.add(recordId);
    if (entry.data === undefined) {
      throw deliveryInputError(`records[${index}].data must be present (null is a legal value)`);
    }
    checkJsonValue(entry.data, `records[${index}].data`, 0, deliveryInputError);
    serializedBytes += Buffer.byteLength(JSON.stringify({ recordId, data: entry.data }), 'utf8');
    records.push({ recordId, data: entry.data });
  }
  if (serializedBytes > MAX_PAYLOAD_BYTES) {
    throw deliveryInputError(
      `records exceed the maximum of ${MAX_PAYLOAD_BYTES} bytes (${serializedBytes}); large artifacts belong in object storage`,
    );
  }

  const provenanceRaw = input.provenanceObservationIds ?? [];
  if (!Array.isArray(provenanceRaw)) {
    throw deliveryInputError('provenanceObservationIds must be an array of observation uuids');
  }
  if (provenanceRaw.length > MAX_PROVENANCE_OBSERVATIONS) {
    throw deliveryInputError(
      `provenanceObservationIds supports at most ${MAX_PROVENANCE_OBSERVATIONS} entries (got ${provenanceRaw.length})`,
    );
  }
  const provenanceObservationIds = provenanceRaw.map((id, index) =>
    requireUuid(id, `provenanceObservationIds[${index}]`, deliveryInputError),
  );
  const seenObservationIds = new Set<string>();
  for (const id of provenanceObservationIds) {
    if (seenObservationIds.has(id)) {
      throw deliveryInputError(`provenance observation '${id}' appears more than once`);
    }
    seenObservationIds.add(id);
  }

  let idempotencyKey: string | null = null;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    const text = requireString(input.idempotencyKey, 'idempotencyKey', deliveryInputError);
    if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(text)) {
      throw deliveryInputError(
        `idempotencyKey must be 1..${MAX_IDEMPOTENCY_KEY_LENGTH} characters matching ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`,
      );
    }
    idempotencyKey = text;
  }

  return { destinationId, kind, records, provenanceObservationIds, idempotencyKey };
}

export interface ValidatedDeliveryTargetInput {
  deliveryId: string;
}

export function validateRetryDeliveryInput(input: RetryDeliveryInput): ValidatedDeliveryTargetInput {
  if (!isPlainObject(input)) {
    throw deliveryInputError('retryDelivery input must be an object');
  }
  rejectUnknownKeys(input, RETRY_INPUT_KEYS, 'the retryDelivery input', deliveryInputError);
  return { deliveryId: requireUuid(input.deliveryId, 'deliveryId', deliveryInputError) };
}

export function validateReplayDeliveryInput(
  input: ReplayDeliveryInput,
): ValidatedDeliveryTargetInput {
  if (!isPlainObject(input)) {
    throw deliveryInputError('replayDelivery input must be an object');
  }
  rejectUnknownKeys(input, RETRY_INPUT_KEYS, 'the replayDelivery input', deliveryInputError);
  return { deliveryId: requireUuid(input.deliveryId, 'deliveryId', deliveryInputError) };
}

export function validateGetDeliveryQuery(query: GetDeliveryQuery): ValidatedDeliveryTargetInput {
  if (!isPlainObject(query)) {
    throw deliveryQueryError('getDelivery query must be an object');
  }
  rejectUnknownKeys(query, GET_DELIVERY_QUERY_KEYS, 'the getDelivery query', deliveryQueryError);
  return { deliveryId: requireUuid(query.deliveryId, 'deliveryId', deliveryQueryError) };
}

/** Fully validated + normalized form of `ListDeliveriesQuery`. */
export interface ValidatedListDeliveriesQuery {
  destinationId: string | null;
  provider: DestinationProvider | null;
  kind: string | null;
  status: DeliveryStatus | null;
  limit: number;
}

export function validateListDeliveriesQuery(
  query: ListDeliveriesQuery,
): ValidatedListDeliveriesQuery {
  if (!isPlainObject(query)) {
    throw deliveryQueryError('listDeliveries query must be an object');
  }
  rejectUnknownKeys(query, LIST_DELIVERIES_QUERY_KEYS, 'the listDeliveries query', deliveryQueryError);
  if (query.provider !== undefined && !isDestinationProvider(query.provider)) {
    throw deliveryQueryError(`provider must be one of: ${DESTINATION_PROVIDERS.join(', ')}`);
  }
  if (query.status !== undefined && !isDeliveryStatus(query.status)) {
    throw deliveryQueryError(`status must be one of: ${DELIVERY_STATUSES.join(', ')}`);
  }
  let kind: string | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    kind = requireString(query.kind, 'kind', deliveryQueryError);
    if (kind.length > MAX_KIND_LENGTH || !KIND_PATTERN.test(kind)) {
      throw deliveryQueryError(
        `kind must be 1..${MAX_KIND_LENGTH} characters matching ${KIND_PATTERN.source} (got '${kind}')`,
      );
    }
  }
  return {
    destinationId:
      query.destinationId === undefined || query.destinationId === null
        ? null
        : requireUuid(query.destinationId, 'destinationId', deliveryQueryError),
    provider: query.provider ?? null,
    kind,
    status: query.status ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, deliveryQueryError),
  };
}

export interface ValidatedListAttemptsQuery {
  deliveryId: string;
  limit: number;
}

export function validateListDeliveryAttemptsQuery(
  query: ListDeliveryAttemptsQuery,
): ValidatedListAttemptsQuery {
  if (!isPlainObject(query)) {
    throw deliveryQueryError('listDeliveryAttempts query must be an object');
  }
  rejectUnknownKeys(query, LIST_ATTEMPTS_QUERY_KEYS, 'the listDeliveryAttempts query', deliveryQueryError);
  return {
    deliveryId: requireUuid(query.deliveryId, 'deliveryId', deliveryQueryError),
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, deliveryQueryError),
  };
}

// ---------------------------------------------------------------------------
// Provider-bound content constraint
// ---------------------------------------------------------------------------

/**
 * Enforces the provider adapter's record-shape constraint at dispatch
 * time, BEFORE any gate request or transport call: providers that require
 * object-shaped records (warehouses, BI, spreadsheets, CRM/ERP) cannot
 * receive free-form JSON rows; envelope-style providers (webhook,
 * http-api) accept any JSON.
 */
export function assertRecordsDeliverable(
  requiresObjectRecords: boolean,
  records: readonly CanonicalOutboundRecord[],
): void {
  if (!requiresObjectRecords) return;
  for (const [index, record] of records.entries()) {
    if (!isPlainObject(record.data)) {
      throw new DestinationsError(
        'invalid_delivery_records',
        `records[${index}].data must be a plain JSON object for this provider (structured stores require field-shaped rows; got ${Array.isArray(record.data) ? 'an array' : typeof record.data})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter/transport output guards (defense in depth)
// ---------------------------------------------------------------------------

/**
 * Re-validates a provider adapter's formatted envelope before anything is
 * handed to the transport or persisted as attempt audit — a buggy adapter
 * cannot smuggle provider shapes or oversize bodies past the boundary.
 */
export function validateFormattedDelivery(envelope: unknown): FormattedDelivery {
  if (!isPlainObject(envelope)) {
    throw envelopeError('the formatted delivery envelope must be an object');
  }
  rejectUnknownKeys(envelope, FORMATTED_DELIVERY_KEYS, 'the formatted delivery envelope', envelopeError);
  if (!isFormattedDeliveryShape(envelope.shape)) {
    throw envelopeError(
      `envelope.shape must be one of: ${FORMATTED_DELIVERY_SHAPES.join(', ')} (got '${String(envelope.shape)}')`,
    );
  }
  if (envelope.body === undefined || envelope.body === null) {
    throw envelopeError('envelope.body must be a non-null plain JSON value');
  }
  checkJsonValue(envelope.body, 'envelope.body', 0, envelopeError);
  const bytes = Buffer.byteLength(JSON.stringify(envelope.body), 'utf8');
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw envelopeError(
      `envelope.body exceeds the maximum of ${MAX_ENVELOPE_BYTES} bytes (${bytes})`,
    );
  }
  return { shape: envelope.shape, body: envelope.body };
}

/**
 * Re-validates a transport receipt before it is persisted as attempt
 * audit — a buggy transport cannot invent outcomes, oversize
 * acknowledgments or bogus authorization expiries.
 */
export function validateTransportReceipt(receipt: unknown): TransportReceipt {
  if (!isPlainObject(receipt)) {
    throw receiptError('the transport receipt must be an object');
  }
  rejectUnknownKeys(receipt, TRANSPORT_RECEIPT_KEYS, 'the transport receipt', receiptError);
  if (!isDeliveryOutcome(receipt.status)) {
    throw receiptError(
      `receipt.status must be one of: ${DELIVERY_OUTCOMES.join(', ')} (got '${String(receipt.status)}')`,
    );
  }
  const providerDeliveryId =
    receipt.providerDeliveryId === undefined || receipt.providerDeliveryId === null
      ? null
      : requirePrintable(
          receipt.providerDeliveryId,
          'receipt.providerDeliveryId',
          MAX_PROVIDER_DELIVERY_ID_LENGTH,
          receiptError,
        );
  let detail: string | null = null;
  if (receipt.detail !== undefined && receipt.detail !== null) {
    if (typeof receipt.detail !== 'string') {
      throw receiptError('receipt.detail must be a string when present');
    }
    detail = receipt.detail.length > MAX_DETAIL_LENGTH ? receipt.detail.slice(0, MAX_DETAIL_LENGTH) : receipt.detail;
  }
  const authorizationExpiresAt = optionalIsoInstant(
    receipt.authorizationExpiresAt,
    'receipt.authorizationExpiresAt',
    receiptError,
  );
  return { status: receipt.status, providerDeliveryId, detail, authorizationExpiresAt };
}
