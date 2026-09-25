// Pure validation/normalization logic of the cellular module (no
// database, no clock). Everything a caller may put into a connection, a
// policy, a reach request, a query or a provider event crosses these
// guards first; the SQL CHECK constraints in migrations 001–005 mirror
// the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `createdAt`, `status` or `createdBy` into a create
// call — the record's identity, tenancy, lifecycle state and commit time
// are minted by the system (the notifications/channels discipline).
//
// Adapter output is re-validated before anything is persisted or handed
// to a sibling contract (defense in depth — a buggy provider adapter
// cannot smuggle provider shapes past the module boundary, lock 16).

import type { TenantContext } from '@/infra/tenant';
import {
  CHANNEL_PROVIDERS,
  isChannelProvider,
  type ChannelProvider,
} from '@/modules/identity/contract';
import { CellularError } from './errors';
import {
  CELLULAR_AUTHORITY_ADMINISTER,
  CELLULAR_REACH_STATUSES,
  isCellularProvider,
  isCellularReachKind,
  isCellularReachStatus,
  isCellularVoiceFallbackMode,
  smsSegmentsOf,
} from './policy';
import type {
  CellularCallStatus,
  CellularConnectionStatus,
  CellularEventKind,
  CellularLeg,
  CellularNotificationTarget,
  CellularProvider,
  CellularReachKind,
  CellularReachStatus,
  CellularSmsReceiptStatus,
  CellularVoiceFallbackMode,
  ListCellularConnectionsQuery,
  ListCellularEventsQuery,
  ListCellularPoliciesQuery,
  ListCellularReachQuery,
  ListCellularRepliesQuery,
  ListCellularAttemptsQuery,
  CanonicalCellularEvent,
  ReachAnyoneInput,
  ReceiveCellularEventInput,
  RegisterCellularConnectionInput,
  RetryCellularReachInput,
  SetCellularConnectionStatusInput,
  SetCellularPolicyInput,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (mirrored by the SQL CHECK constraints where load-bearing)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_PUMP_LIMIT = 20;
export const MAX_PUMP_LIMIT = 100;

export const MAX_TEXT_LENGTH = 640; // 4 SMS segments — the hard floor; the policy may be tighter
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_NOTE_LENGTH = 2_000;
export const MAX_DETAIL_LENGTH = 2_000;
export const MAX_PROVIDER_MESSAGE_ID_LENGTH = 255;
export const MAX_PROVIDER_CALL_ID_LENGTH = 255;
export const MAX_PROVIDER_EVENT_ID_LENGTH = 255;
export const MAX_RECORDING_URL_LENGTH = 2_048;
export const MAX_TEXT_FIELD_LENGTH = 65_536;

export const MIN_SMS_MAX_ATTEMPTS = 1;
export const MAX_SMS_MAX_ATTEMPTS = 10;
export const MIN_RETRY_BACKOFF_SECONDS = 1;
export const MAX_RETRY_BACKOFF_SECONDS = 86_400;
export const MIN_MAX_SMS_SEGMENTS = 1;
export const MAX_MAX_SMS_SEGMENTS = 10;
export const MIN_COST_MINOR = 0;
export const MAX_COST_MINOR = 1_000_000; // per-unit rates stay sane
export const MIN_COST_CAP_MINOR = 0;
export const MAX_COST_CAP_MINOR = 1_000_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Opaque provider-minted strings — printable, no control characters.
const PRINTABLE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;

const REGISTER_KEYS = [
  'provider',
  'providerAccountId',
  'phoneNumber',
  'displayName',
  'credentialRef',
] as const;
const SET_STATUS_KEYS = ['connectionId', 'status'] as const;
const POLICY_KEYS = [
  'reachKind',
  'voiceFallback',
  'smsMaxAttempts',
  'retryBackoffSeconds',
  'maxSmsSegments',
  'smsSegmentCostMinor',
  'voicePerMinuteCostMinor',
  'currency',
  'maxCostPerReachMinor',
  'note',
] as const;
const REACH_KEYS = [
  'personId',
  'phoneNumber',
  'kind',
  'text',
  'connectionId',
  'failureNotification',
] as const;
const NOTIFICATION_TARGET_KEYS = ['provider', 'providerAccountId', 'displayName'] as const;
const EVENT_KEYS = ['provider', 'payload'] as const;

// ---------------------------------------------------------------------------
// Context + authority guards
// ---------------------------------------------------------------------------

export function assertCellularTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new CellularError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new CellularError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new CellularError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** May these authority claims manage the tenant's cellular policies? */
export function canAdministerCellularPolicies(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(CELLULAR_AUTHORITY_ADMINISTER);
}

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_PATTERN.test(value);
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
  errorOf: (message: string) => CellularError = inputError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw errorOf(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function inputError(message: string): CellularError {
  return new CellularError('invalid_cellular_input', message);
}

function queryError(message: string): CellularError {
  return new CellularError('invalid_cellular_query', message);
}

function normalizeText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw inputError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw inputError(`${field} must not be empty or whitespace`);
  }
  if (trimmed.length > max) {
    throw inputError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeText(value, field, max);
}

function requireProvider(value: unknown, field: string): CellularProvider {
  if (!isCellularProvider(value)) {
    throw inputError(`${field} must be one of: twilio, telnyx`);
  }
  return value;
}

function requireE164(value: unknown, field: string): string {
  if (typeof value !== 'string' || !E164_PATTERN.test(value.trim())) {
    throw inputError(`${field} must be an E.164 phone number (+, then 8-15 digits)`);
  }
  return value.trim();
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw inputError(`${field} must be a uuid`);
  }
  return value;
}

function requireConnectionStatus(value: unknown, field: string): CellularConnectionStatus {
  if (value !== 'active' && value !== 'disabled') {
    throw inputError(`${field} must be 'active' or 'disabled'`);
  }
  return value;
}

function optionalConnectionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, 'connectionId');
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw inputError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw queryError(`limit must be an integer between 1 and ${max}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ValidatedRegisterConnectionInput {
  provider: CellularProvider;
  providerAccountId: string;
  phoneNumber: string;
  displayName: string | null;
  credentialRef: string;
}

export function validateRegisterCellularConnectionInput(
  input: RegisterCellularConnectionInput,
): ValidatedRegisterConnectionInput {
  if (!isPlainObject(input)) {
    throw inputError('connection registration must be an object');
  }
  rejectUnknownKeys(input, REGISTER_KEYS, 'connection registration');
  const provider = requireProvider(input.provider, 'provider');
  const providerAccountId = normalizeText(
    input.providerAccountId,
    'providerAccountId',
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  );
  const phoneNumber = requireE164(input.phoneNumber, 'phoneNumber');
  const displayName = optionalText(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH);
  const credentialRef = normalizeText(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
  );
  return { provider, providerAccountId, phoneNumber, displayName, credentialRef };
}

export interface ValidatedListConnectionsQuery {
  provider: CellularProvider | null;
  status: CellularConnectionStatus | null;
  limit: number;
}

export function validateListCellularConnectionsQuery(
  query: ListCellularConnectionsQuery,
): ValidatedListConnectionsQuery {
  if (!isPlainObject(query)) {
    throw queryError('connection list query must be an object');
  }
  rejectUnknownKeys(query, ['provider', 'status', 'limit'], 'connection list query', queryError);
  let provider: CellularProvider | null = null;
  if (query.provider !== undefined && query.provider !== null) {
    provider = requireProvider(query.provider, 'provider');
  }
  let status: CellularConnectionStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    status = requireConnectionStatus(query.status, 'status');
  }
  return { provider, status, limit: requireLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) };
}

export interface ValidatedSetConnectionStatusInput {
  connectionId: string;
  status: CellularConnectionStatus;
}

export function validateSetCellularConnectionStatusInput(
  input: SetCellularConnectionStatusInput,
): ValidatedSetConnectionStatusInput {
  if (!isPlainObject(input)) {
    throw inputError('connection status update must be an object');
  }
  rejectUnknownKeys(input, SET_STATUS_KEYS, 'connection status update');
  return {
    connectionId: requireUuid(input.connectionId, 'connectionId'),
    status: requireConnectionStatus(input.status, 'status'),
  };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface ValidatedSetPolicyInput {
  reachKind: CellularReachKind | null;
  voiceFallback: CellularVoiceFallbackMode | null;
  smsMaxAttempts: number | null;
  retryBackoffSeconds: number | null;
  maxSmsSegments: number | null;
  smsSegmentCostMinor: number | null;
  voicePerMinuteCostMinor: number | null;
  currency: string | null;
  maxCostPerReachMinor: number | null;
  note: string | null;
}

export function validateSetCellularPolicyInput(input: SetCellularPolicyInput): ValidatedSetPolicyInput {
  if (!isPlainObject(input)) {
    throw inputError('policy update must be an object');
  }
  rejectUnknownKeys(input, POLICY_KEYS, 'policy update');
  let reachKind: CellularReachKind | null = null;
  if (input.reachKind !== undefined && input.reachKind !== null) {
    if (!isCellularReachKind(input.reachKind)) {
      throw inputError("reachKind must be 'tell' or 'ask'");
    }
    reachKind = input.reachKind;
  }
  let voiceFallback: CellularVoiceFallbackMode | null = null;
  if (input.voiceFallback !== undefined && input.voiceFallback !== null) {
    if (!isCellularVoiceFallbackMode(input.voiceFallback)) {
      throw inputError("voiceFallback must be 'forbidden' or 'on_sms_failure'");
    }
    voiceFallback = input.voiceFallback;
  }
  const optionalBounded = (
    value: unknown,
    field: string,
    min: number,
    max: number,
  ): number | null => {
    if (value === undefined || value === null) return null;
    return boundedInteger(value, field, min, max);
  };
  let currency: string | null = null;
  if (input.currency !== undefined && input.currency !== null) {
    if (typeof input.currency !== 'string' || !CURRENCY_PATTERN.test(input.currency)) {
      throw inputError('currency must be an ISO 4217 code (three uppercase letters)');
    }
    currency = input.currency;
  }
  return {
    reachKind,
    voiceFallback,
    smsMaxAttempts: optionalBounded(input.smsMaxAttempts, 'smsMaxAttempts', MIN_SMS_MAX_ATTEMPTS, MAX_SMS_MAX_ATTEMPTS),
    retryBackoffSeconds: optionalBounded(input.retryBackoffSeconds, 'retryBackoffSeconds', MIN_RETRY_BACKOFF_SECONDS, MAX_RETRY_BACKOFF_SECONDS),
    maxSmsSegments: optionalBounded(input.maxSmsSegments, 'maxSmsSegments', MIN_MAX_SMS_SEGMENTS, MAX_MAX_SMS_SEGMENTS),
    smsSegmentCostMinor: optionalBounded(input.smsSegmentCostMinor, 'smsSegmentCostMinor', MIN_COST_MINOR, MAX_COST_MINOR),
    voicePerMinuteCostMinor: optionalBounded(input.voicePerMinuteCostMinor, 'voicePerMinuteCostMinor', MIN_COST_MINOR, MAX_COST_MINOR),
    currency,
    maxCostPerReachMinor: optionalBounded(input.maxCostPerReachMinor, 'maxCostPerReachMinor', MIN_COST_CAP_MINOR, MAX_COST_CAP_MINOR),
    note: optionalText(input.note, 'note', MAX_NOTE_LENGTH),
  };
}

export interface ValidatedPolicySubjectQuery {
  reachKind: CellularReachKind | null;
}

export function validateCellularPolicySubjectQuery(
  query: { reachKind?: CellularReachKind | null },
): ValidatedPolicySubjectQuery {
  if (!isPlainObject(query)) {
    throw queryError('policy subject query must be an object');
  }
  rejectUnknownKeys(query, ['reachKind'], 'policy subject query', queryError);
  if (query.reachKind === undefined || query.reachKind === null) return { reachKind: null };
  if (!isCellularReachKind(query.reachKind)) {
    throw queryError("reachKind must be 'tell' or 'ask'");
  }
  return { reachKind: query.reachKind };
}

export function validateListCellularPoliciesQuery(query: ListCellularPoliciesQuery): { limit: number } {
  if (!isPlainObject(query)) {
    throw queryError('policy list query must be an object');
  }
  rejectUnknownKeys(query, ['limit'], 'policy list query', queryError);
  return { limit: requireLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) };
}

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

function validateNotificationTarget(
  value: unknown,
): CellularNotificationTarget {
  if (!isPlainObject(value)) {
    throw inputError('failureNotification must be an object');
  }
  rejectUnknownKeys(value, NOTIFICATION_TARGET_KEYS, 'failureNotification');
  if (!isChannelProvider(value.provider)) {
    throw inputError(
      `failureNotification.provider must be one of: ${CHANNEL_PROVIDERS.join(', ')}`,
    );
  }
  return {
    provider: value.provider as ChannelProvider,
    providerAccountId: normalizeText(
      value.providerAccountId,
      'failureNotification.providerAccountId',
      MAX_PROVIDER_ACCOUNT_ID_LENGTH,
    ),
    displayName: optionalText(
      value.displayName,
      'failureNotification.displayName',
      MAX_DISPLAY_NAME_LENGTH,
    ),
  };
}

export interface ValidatedReachInput {
  personId: string | null;
  phoneNumber: string | null;
  kind: CellularReachKind;
  text: string;
  connectionId: string | null;
  failureNotification: CellularNotificationTarget | null;
}

export function validateReachAnyoneInput(input: ReachAnyoneInput): ValidatedReachInput {
  if (!isPlainObject(input)) {
    throw inputError('reach request must be an object');
  }
  rejectUnknownKeys(input, REACH_KEYS, 'reach request');
  const personId =
    input.personId === undefined || input.personId === null
      ? null
      : requireUuid(input.personId, 'personId');
  const phoneNumber =
    input.phoneNumber === undefined || input.phoneNumber === null
      ? null
      : requireE164(input.phoneNumber, 'phoneNumber');
  if (personId === null && phoneNumber === null) {
    throw inputError('exactly one of personId or phoneNumber must be given');
  }
  if (personId !== null && phoneNumber !== null) {
    throw inputError('personId and phoneNumber are mutually exclusive');
  }
  if (!isCellularReachKind(input.kind)) {
    throw inputError("kind must be 'tell' or 'ask'");
  }
  const text = normalizeText(input.text, 'text', MAX_TEXT_LENGTH);
  let failureNotification: CellularNotificationTarget | null = null;
  if (input.failureNotification !== undefined && input.failureNotification !== null) {
    failureNotification = validateNotificationTarget(input.failureNotification);
  }
  return {
    personId,
    phoneNumber,
    kind: input.kind,
    text,
    connectionId: optionalConnectionId(input.connectionId),
    failureNotification,
  };
}

export function validateRetryCellularReachInput(
  input: RetryCellularReachInput,
): { reachRequestId: string } {
  if (!isPlainObject(input)) {
    throw inputError('retry request must be an object');
  }
  rejectUnknownKeys(input, ['reachRequestId'], 'retry request');
  return { reachRequestId: requireUuid(input.reachRequestId, 'reachRequestId') };
}

export function validatePumpQuery(query: { limit?: number }): { limit: number } {
  if (!isPlainObject(query)) {
    throw queryError('pump query must be an object');
  }
  rejectUnknownKeys(query, ['limit'], 'pump query', queryError);
  return { limit: requireLimit(query.limit, DEFAULT_PUMP_LIMIT, MAX_PUMP_LIMIT) };
}

export function validateGetCellularReachQuery(query: { reachRequestId: string }): {
  reachRequestId: string;
} {
  if (!isPlainObject(query)) {
    throw queryError('reach get query must be an object');
  }
  rejectUnknownKeys(query, ['reachRequestId'], 'reach get query', queryError);
  return { reachRequestId: requireUuid(query.reachRequestId, 'reachRequestId') };
}

export interface ValidatedListReachQuery {
  status: CellularReachStatus | null;
  personId: string | null;
  phoneNumber: string | null;
  limit: number;
}

export function validateListCellularReachQuery(query: ListCellularReachQuery): ValidatedListReachQuery {
  if (!isPlainObject(query)) {
    throw queryError('reach list query must be an object');
  }
  rejectUnknownKeys(query, ['status', 'personId', 'phoneNumber', 'limit'], 'reach list query', queryError);
  let status: CellularReachStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isCellularReachStatus(query.status)) {
      throw queryError(
        `status must be one of: ${CELLULAR_REACH_STATUSES.join(', ')}`,
      );
    }
    status = query.status;
  }
  const personId =
    query.personId === undefined || query.personId === null
      ? null
      : requireUuid(query.personId, 'personId');
  const phoneNumber =
    query.phoneNumber === undefined || query.phoneNumber === null
      ? null
      : requireE164(query.phoneNumber, 'phoneNumber');
  return { status, personId, phoneNumber, limit: requireLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) };
}

export function validateListCellularAttemptsQuery(
  query: ListCellularAttemptsQuery,
): { reachRequestId: string } {
  if (!isPlainObject(query)) {
    throw queryError('attempt list query must be an object');
  }
  rejectUnknownKeys(query, ['reachRequestId'], 'attempt list query', queryError);
  return { reachRequestId: requireUuid(query.reachRequestId, 'reachRequestId') };
}

export function validateListCellularRepliesQuery(
  query: ListCellularRepliesQuery,
): { reachRequestId: string | null; limit: number } {
  if (!isPlainObject(query)) {
    throw queryError('reply list query must be an object');
  }
  rejectUnknownKeys(query, ['reachRequestId', 'limit'], 'reply list query', queryError);
  const reachRequestId =
    query.reachRequestId === undefined || query.reachRequestId === null
      ? null
      : requireUuid(query.reachRequestId, 'reachRequestId');
  return {
    reachRequestId,
    limit: requireLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
  };
}

export function validateListCellularEventsQuery(
  query: ListCellularEventsQuery,
): { provider: CellularProvider | null; limit: number } {
  if (!isPlainObject(query)) {
    throw queryError('event list query must be an object');
  }
  rejectUnknownKeys(query, ['provider', 'limit'], 'event list query', queryError);
  let provider: CellularProvider | null = null;
  if (query.provider !== undefined && query.provider !== null) {
    provider = requireProvider(query.provider, 'provider');
  }
  return { provider, limit: requireLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) };
}

// ---------------------------------------------------------------------------
// The provider event edge
// ---------------------------------------------------------------------------

export function validateReceiveCellularEventInput(
  input: ReceiveCellularEventInput,
): { provider: CellularProvider; payload: unknown } {
  if (!isPlainObject(input)) {
    throw inputError('provider event must be an object');
  }
  rejectUnknownKeys(input, EVENT_KEYS, 'provider event');
  return { provider: requireProvider(input.provider, 'provider'), payload: input.payload };
}

const EVENT_KINDS: readonly CellularEventKind[] = [
  'sms_reply',
  'voice_reply',
  'sms_receipt',
  'call_status',
];
const SMS_RECEIPT_STATUSES: readonly CellularSmsReceiptStatus[] = [
  'delivered',
  'undelivered',
  'failed',
];
const CALL_STATUSES: readonly CellularCallStatus[] = [
  'initiated',
  'ringing',
  'answered',
  'completed',
  'no_answer',
  'failed',
];

function requireEventProvider(value: unknown, field: string): CellularProvider {
  if (!isCellularProvider(value)) {
    throw new CellularError(
      'invalid_provider_payload',
      `${field} must be one of: twilio, telnyx (internal invariant violation)`,
    );
  }
  return value;
}

function requireEventId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PROVIDER_EVENT_ID_LENGTH) {
    throw new CellularError(
      'invalid_provider_payload',
      `${field} must be a non-empty string of at most ${MAX_PROVIDER_EVENT_ID_LENGTH} characters`,
    );
  }
  return value.trim();
}

function requireEventE164(value: unknown, field: string): string {
  if (typeof value !== 'string' || !E164_PATTERN.test(value)) {
    throw new CellularError(
      'invalid_provider_payload',
      `${field} must be an E.164 phone number`,
    );
  }
  return value;
}

function optionalEventText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT_FIELD_LENGTH) {
    throw new CellularError(
      'invalid_provider_payload',
      `${field} must be a string of at most ${MAX_TEXT_FIELD_LENGTH} characters`,
    );
  }
  return value;
}

function optionalEventIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new CellularError('invalid_provider_payload', `${field} must be an ISO 8601 timestamp`);
  }
  return value;
}

function optionalEventPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 86_400) {
    throw new CellularError('invalid_provider_payload', `${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Defense in depth: re-validate a provider adapter's canonical output
 * before anything is persisted or handed to a sibling contract (the
 * channels module's discipline — a buggy adapter cannot smuggle provider
 * shapes past the boundary, lock 16).
 */
export function validateCanonicalCellularEvent(event: CanonicalCellularEvent): CanonicalCellularEvent {
  if (!isPlainObject(event)) {
    throw new CellularError('invalid_provider_payload', 'canonical event must be an object');
  }
  const kind = (event as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !EVENT_KINDS.includes(kind as CellularEventKind)) {
    throw new CellularError(
      'invalid_provider_payload',
      `canonical event kind '${String(kind)}' is unknown (allowed: ${EVENT_KINDS.join(', ')})`,
    );
  }
  const provider = requireEventProvider((event as { provider?: unknown }).provider, 'event.provider');
  const providerAccountId = requireEventId(
    (event as { providerAccountId?: unknown }).providerAccountId,
    'event.providerAccountId',
  );
  const providerEventId = requireEventId(
    (event as { providerEventId?: unknown }).providerEventId,
    'event.providerEventId',
  );
  if (event.kind === 'sms_reply') {
    return {
      kind: 'sms_reply',
      provider,
      providerAccountId,
      providerEventId,
      fromNumber: requireEventE164(event.fromNumber, 'event.fromNumber'),
      toNumber: requireEventE164(event.toNumber, 'event.toNumber'),
      text: optionalEventText(event.text, 'event.text') ?? '',
      providerMessageId: requireEventId(event.providerMessageId, 'event.providerMessageId'),
      sentAt: optionalEventIso(event.sentAt, 'event.sentAt'),
    };
  }
  if (event.kind === 'voice_reply') {
    const speech = optionalEventText(event.speech, 'event.speech') ?? '';
    if (speech.trim() === '') {
      throw new CellularError('invalid_provider_payload', 'event.speech must be non-empty');
    }
    return {
      kind: 'voice_reply',
      provider,
      providerAccountId,
      providerEventId,
      providerCallId: requireEventId(event.providerCallId, 'event.providerCallId'),
      fromNumber: requireEventE164(event.fromNumber, 'event.fromNumber'),
      toNumber: requireEventE164(event.toNumber, 'event.toNumber'),
      speech,
      recordingUrl: optionalEventText(event.recordingUrl, 'event.recordingUrl'),
      occurredAt: optionalEventIso(event.occurredAt, 'event.occurredAt'),
    };
  }
  if (event.kind === 'sms_receipt') {
    if (!SMS_RECEIPT_STATUSES.includes(event.status)) {
      throw new CellularError(
        'invalid_provider_payload',
        `event.status must be one of: ${SMS_RECEIPT_STATUSES.join(', ')}`,
      );
    }
    return {
      kind: 'sms_receipt',
      provider,
      providerAccountId,
      providerEventId,
      providerMessageId: requireEventId(event.providerMessageId, 'event.providerMessageId'),
      status: event.status,
      detail: optionalEventText(event.detail, 'event.detail'),
      occurredAt: optionalEventIso(event.occurredAt, 'event.occurredAt'),
    };
  }
  if (!CALL_STATUSES.includes(event.callStatus)) {
    throw new CellularError(
      'invalid_provider_payload',
      `event.callStatus must be one of: ${CALL_STATUSES.join(', ')}`,
    );
  }
  return {
    kind: 'call_status',
    provider,
    providerAccountId,
    providerEventId,
    providerCallId: requireEventId(event.providerCallId, 'event.providerCallId'),
    callStatus: event.callStatus,
    durationSeconds: optionalEventPositiveInteger(event.durationSeconds, 'event.durationSeconds'),
    recordingUrl: optionalEventText(event.recordingUrl, 'event.recordingUrl'),
    occurredAt: optionalEventIso(event.occurredAt, 'event.occurredAt'),
  };
}

// ---------------------------------------------------------------------------
// Transport receipt re-validation (defense in depth)
// ---------------------------------------------------------------------------

/** Re-validate a transport's SMS receipt before it reaches the domain. */
export function validateTransportSmsReceipt(receipt: {
  status: string;
  providerMessageId: string | null;
  detail: string | null;
}): { status: 'accepted' | 'rejected' | 'failed'; providerMessageId: string | null; detail: string | null } {
  if (receipt.status !== 'accepted' && receipt.status !== 'rejected' && receipt.status !== 'failed') {
    throw new Error(
      `cellular transport returned a malformed SMS receipt status '${String(receipt.status)}' (internal invariant violation)`,
    );
  }
  if (
    receipt.providerMessageId !== null &&
    (typeof receipt.providerMessageId !== 'string' ||
      receipt.providerMessageId.trim() === '' ||
      !PRINTABLE_ID_PATTERN.test(receipt.providerMessageId))
  ) {
    throw new Error(
      'cellular transport returned a malformed provider message id (internal invariant violation)',
    );
  }
  if (receipt.detail !== null && typeof receipt.detail !== 'string') {
    throw new Error(
      'cellular transport returned a malformed receipt detail (internal invariant violation)',
    );
  }
  return {
    status: receipt.status,
    providerMessageId: receipt.providerMessageId,
    detail: receipt.detail,
  };
}

/** Re-validate a transport's voice receipt before it reaches the domain. */
export function validateTransportVoiceReceipt(receipt: {
  status: string;
  providerCallId: string | null;
  detail: string | null;
}): { status: 'answered' | 'no_answer' | 'failed'; providerCallId: string | null; detail: string | null } {
  if (
    receipt.status !== 'answered' &&
    receipt.status !== 'no_answer' &&
    receipt.status !== 'failed'
  ) {
    throw new Error(
      `cellular transport returned a malformed voice receipt status '${String(receipt.status)}' (internal invariant violation)`,
    );
  }
  if (
    receipt.providerCallId !== null &&
    (typeof receipt.providerCallId !== 'string' ||
      receipt.providerCallId.trim() === '' ||
      !PRINTABLE_ID_PATTERN.test(receipt.providerCallId))
  ) {
    throw new Error(
      'cellular transport returned a malformed provider call id (internal invariant violation)',
    );
  }
  if (receipt.detail !== null && typeof receipt.detail !== 'string') {
    throw new Error(
      'cellular transport returned a malformed receipt detail (internal invariant violation)',
    );
  }
  return {
    status: receipt.status,
    providerCallId: receipt.providerCallId,
    detail: receipt.detail,
  };
}

// ---------------------------------------------------------------------------
// Misc pure helpers used by the service
// ---------------------------------------------------------------------------

/** SMS segments of a reach text under the resolved policy's segment cap. */
export function segmentsUnderPolicy(
  text: string,
  maxSmsSegments: number,
): { segments: number; ok: boolean } {
  const segments = smsSegmentsOf(text);
  return { segments, ok: segments <= maxSmsSegments };
}

/** Leg of a canonical event (replies carry theirs; receipts are SMS). */
export function legOfEvent(event: CanonicalCellularEvent): CellularLeg {
  return event.kind === 'sms_reply' || event.kind === 'sms_receipt' ? 'sms' : 'voice';
}
