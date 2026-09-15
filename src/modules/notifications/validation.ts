// Pure validation/normalization logic of the notifications module (no
// database, no clock). Everything a caller may put into a notification,
// a policy, a query or an acknowledgment crosses these guards first; the
// SQL CHECK constraints in migrations/001 and /002 mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `createdAt`, `status` or `createdBy` into a create
// call — the notification's identity, tenancy, lifecycle state and commit
// time are minted by the system.
//
// Escalation coherence is enforced HERE and in the database: a policy of
// class 'escalation' must require acknowledgment and carry both the
// deadline and the fallback recipient; any other class must carry none of
// the escalation configuration.

import type { TenantContext } from '@/infra/tenant';
import {
  CHANNEL_PROVIDERS,
  isChannelProvider,
  type ChannelProvider,
} from '@/modules/identity/contract';
import { NotificationsError } from './errors';
import {
  isNotificationDeliveryClass,
  isNotificationStatus,
  NOTIFICATIONS_AUTHORITY_ADMINISTER,
} from './policy';
import type {
  AcknowledgeNotificationInput,
  CreateNotificationInput,
  EscalateUnacknowledgedQuery,
  EscalationRecipient,
  FlushDigestsQuery,
  GetNotificationAcknowledgmentQuery,
  GetNotificationQuery,
  ListNotificationAttemptsQuery,
  ListNotificationsQuery,
  ListNotificationPoliciesQuery,
  NotificationDeliveryClass,
  NotificationRecipient,
  NotificationStatus,
  PolicySubjectQuery,
  RetryDueQuery,
  SetNotificationPolicyInput,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (mirrored by the SQL CHECK constraints where load-bearing)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const DEFAULT_RETRY_LIMIT = 20;
export const MAX_RETRY_LIMIT = 100;
export const DEFAULT_DIGEST_GROUP_LIMIT = 10;
export const MAX_DIGEST_GROUP_LIMIT = 50;

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 4_096;
export const MAX_DATA_BYTES = 65_536;
export const MAX_DEDUPE_KEY_LENGTH = 200;
export const MAX_CORRELATION_ID_LENGTH = 200;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2_000;

export const MIN_MAX_ATTEMPTS = 1;
export const MAX_MAX_ATTEMPTS = 10;
export const MIN_RETRY_BACKOFF_SECONDS = 1;
export const MAX_RETRY_BACKOFF_SECONDS = 86_400;
export const MIN_DEDUPE_WINDOW_SECONDS = 0;
export const MAX_DEDUPE_WINDOW_SECONDS = 2_592_000;
export const MIN_DIGEST_WINDOW_SECONDS = 1;
export const MAX_DIGEST_WINDOW_SECONDS = 2_592_000;
export const MIN_ESCALATION_AFTER_SECONDS = 1;
export const MAX_ESCALATION_AFTER_SECONDS = 2_592_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Open kind namespace — the actions module's action-kind pattern.
const KIND_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Emitter-supplied keys — the actions module's idempotency-key pattern.
const EMITTER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
// Opaque provider-minted strings — printable, no control characters.
const PRINTABLE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;

const CREATE_KEYS = [
  'kind',
  'recipient',
  'subject',
  'body',
  'data',
  'dedupeKey',
  'correlationId',
  'connectionId',
] as const;
const RECIPIENT_KEYS = ['provider', 'providerAccountId', 'displayName'] as const;
const POLICY_KEYS = [
  'notificationKind',
  'deliveryClass',
  'maxAttempts',
  'retryBackoffSeconds',
  'dedupeWindowSeconds',
  'digestWindowSeconds',
  'requireAcknowledgment',
  'escalationAfterSeconds',
  'escalationRecipient',
  'note',
] as const;
const POLICY_SUBJECT_KEYS = ['notificationKind'] as const;
const POLICY_LIST_KEYS = ['limit'] as const;
const GET_NOTIFICATION_KEYS = ['notificationId'] as const;
const LIST_NOTIFICATIONS_KEYS = [
  'notificationKind',
  'status',
  'deliveryClass',
  'provider',
  'recipientAccountId',
  'dedupeKey',
  'limit',
] as const;
const ATTEMPTS_LIST_KEYS = ['notificationId'] as const;
const ACK_KEYS = ['notificationId', 'note'] as const;
const RETRY_KEYS = ['limit'] as const;
const DIGEST_KEYS = ['limit'] as const;
const ESCALATION_KEYS = ['limit'] as const;

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertNotificationsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new NotificationsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new NotificationsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new NotificationsError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** May these authority claims manage the tenant's notification policies? */
export function canAdministerNotificationPolicies(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(NOTIFICATIONS_AUTHORITY_ADMINISTER);
}

/** Notification-kind slug guard (the actions module's action-kind shape). */
export function isNotificationKindSlug(value: unknown): value is string {
  return typeof value === 'string' && KIND_SLUG_PATTERN.test(value);
}

/** Uuid shape guard. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
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
      throw inputError(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function inputError(message: string): NotificationsError {
  return new NotificationsError('invalid_notification_input', message);
}

function policyInputError(message: string): NotificationsError {
  return new NotificationsError('invalid_policy_input', message);
}

function queryError(message: string): NotificationsError {
  return new NotificationsError('invalid_notification_query', message);
}

function policyQueryError(message: string): NotificationsError {
  return new NotificationsError('invalid_policy_query', message);
}

/** Remaps the error code thrown by `fn` (shared guards throw input-flavored errors). */
function remapError<T>(fn: () => T, code: NotificationsError['code']): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof NotificationsError) {
      throw new NotificationsError(code, error.message);
    }
    throw error;
  }
}

/** Deep JSON check: only plain JSON values survive (the house pattern). */
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw inputError(`${field} must be a string when present`);
  const text = value.trim();
  return text === '' ? null : text;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function boundedOptionalText(value: unknown, field: string, maxLength: number): string | null {
  const text = optionalTrimmed(value, field);
  if (text !== null && text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requirePrintable(value: unknown, field: string, maxLength: number): string {
  const text = boundedText(value, field, maxLength);
  if (!PRINTABLE_ID_PATTERN.test(text)) {
    throw inputError(
      `${field} must be 1..${maxLength} printable characters without control characters`,
    );
  }
  return text;
}

function optionalPrintable(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return requirePrintable(value, field, maxLength);
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function optionalUuid(value: unknown, field: string): string | null {
  const text = optionalTrimmed(value, field);
  if (text === null) return null;
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid when present (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw inputError(`${field} must be an integer in [${min}, ${max}] (got ${String(value)})`);
  }
  return value;
}

function requireListLimit(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
): number {
  const limit = value === undefined ? fallback : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) {
    throw queryError(`${field} must be an integer in [1, ${max}] (got ${String(limit)})`);
  }
  return limit;
}

// ---------------------------------------------------------------------------
// Recipients (canonical channel parties)
// ---------------------------------------------------------------------------

function validateRecipient(value: unknown, where: string): NotificationRecipient {
  if (!isPlainObject(value)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(value, RECIPIENT_KEYS, where);
  if (!isChannelProvider(value.provider)) {
    throw inputError(
      `${where}.provider must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(value.provider)}')`,
    );
  }
  const providerAccountId = requirePrintable(
    value.providerAccountId,
    `${where}.providerAccountId`,
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  );
  const displayName = boundedOptionalText(
    value.displayName,
    `${where}.displayName`,
    MAX_DISPLAY_NAME_LENGTH,
  );
  return { provider: value.provider, providerAccountId, displayName };
}

// ---------------------------------------------------------------------------
// createNotification
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CreateNotificationInput`. */
export interface ValidatedCreateNotificationInput {
  kind: string;
  recipient: NotificationRecipient;
  subject: string;
  body: string;
  data: unknown;
  dedupeKey: string | null;
  correlationId: string | null;
  connectionId: string | null;
}

export function validateCreateNotificationInput(
  input: CreateNotificationInput,
): ValidatedCreateNotificationInput {
  if (!isPlainObject(input)) {
    throw inputError('notification input must be an object');
  }
  rejectUnknownKeys(input, CREATE_KEYS, 'the notification input');
  if (!isNotificationKindSlug(input.kind)) {
    throw inputError(
      `kind must be a canonical slug matching ${String(KIND_SLUG_PATTERN)} (got '${String(input.kind)}')`,
    );
  }
  const recipient = validateRecipient(input.recipient, 'recipient');
  const subject = boundedText(input.subject, 'subject', MAX_SUBJECT_LENGTH);
  const body = boundedText(input.body, 'body', MAX_BODY_LENGTH);

  let data: unknown = null;
  if (input.data !== undefined && input.data !== null) {
    checkJsonValue(input.data, 'data', 0);
    const serializedLength = JSON.stringify(input.data)?.length ?? 0;
    if (serializedLength > MAX_DATA_BYTES) {
      throw inputError(
        `data exceeds the maximum of ${MAX_DATA_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
      );
    }
    data = input.data;
  }

  let dedupeKey: string | null = null;
  if (input.dedupeKey !== undefined && input.dedupeKey !== null) {
    if (typeof input.dedupeKey !== 'string' || !EMITTER_KEY_PATTERN.test(input.dedupeKey)) {
      throw inputError(
        `dedupeKey must match ${String(EMITTER_KEY_PATTERN)} (got '${String(input.dedupeKey)}')`,
      );
    }
    dedupeKey = input.dedupeKey;
  }

  const correlationId = optionalPrintable(
    input.correlationId,
    'correlationId',
    MAX_CORRELATION_ID_LENGTH,
  );
  const connectionId = optionalUuid(input.connectionId, 'connectionId');
  return { kind: input.kind, recipient, subject, body, data, dedupeKey, correlationId, connectionId };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `SetNotificationPolicyInput`. */
export interface ValidatedPolicyInput {
  notificationKind: string | null;
  deliveryClass: NotificationDeliveryClass;
  maxAttempts: number;
  retryBackoffSeconds: number;
  dedupeWindowSeconds: number;
  digestWindowSeconds: number;
  requireAcknowledgment: boolean;
  escalationAfterSeconds: number | null;
  escalationRecipient: EscalationRecipient | null;
  note: string | null;
}

export function validateSetNotificationPolicyInput(
  input: SetNotificationPolicyInput,
): ValidatedPolicyInput {
  if (!isPlainObject(input)) {
    throw policyInputError('policy input must be an object');
  }
  remapError(() => rejectUnknownKeys(input, POLICY_KEYS, 'the policy input'), 'invalid_policy_input');

  let notificationKind: string | null = null;
  if (input.notificationKind !== undefined && input.notificationKind !== null) {
    if (!isNotificationKindSlug(input.notificationKind)) {
      throw policyInputError(
        `notificationKind must be a canonical slug matching ${String(KIND_SLUG_PATTERN)} or null for the tenant default (got '${String(input.notificationKind)}')`,
      );
    }
    notificationKind = input.notificationKind;
  }

  if (!isNotificationDeliveryClass(input.deliveryClass)) {
    throw policyInputError(
      `deliveryClass must be one of urgent, digest, escalation (got '${String(input.deliveryClass)}')`,
    );
  }
  const deliveryClass: NotificationDeliveryClass = input.deliveryClass;

  // Policy writes are explicit and atomic: every governing field is
  // required, so an upsert can never leave a half-configured row behind.
  if (input.maxAttempts === undefined) {
    throw policyInputError('maxAttempts is required (policy writes are explicit)');
  }
  if (input.retryBackoffSeconds === undefined) {
    throw policyInputError('retryBackoffSeconds is required (policy writes are explicit)');
  }
  if (input.dedupeWindowSeconds === undefined) {
    throw policyInputError('dedupeWindowSeconds is required (policy writes are explicit)');
  }
  if (input.digestWindowSeconds === undefined) {
    throw policyInputError('digestWindowSeconds is required (policy writes are explicit)');
  }
  if (typeof input.requireAcknowledgment !== 'boolean') {
    throw policyInputError('requireAcknowledgment must be a boolean');
  }
  const maxAttempts = remapError(
    () =>
      requireIntInRange(
        input.maxAttempts,
        'maxAttempts',
        MIN_MAX_ATTEMPTS,
        MAX_MAX_ATTEMPTS,
      ),
    'invalid_policy_input',
  );
  const retryBackoffSeconds = remapError(
    () =>
      requireIntInRange(
        input.retryBackoffSeconds,
        'retryBackoffSeconds',
        MIN_RETRY_BACKOFF_SECONDS,
        MAX_RETRY_BACKOFF_SECONDS,
      ),
    'invalid_policy_input',
  );
  const dedupeWindowSeconds = remapError(
    () =>
      requireIntInRange(
        input.dedupeWindowSeconds,
        'dedupeWindowSeconds',
        MIN_DEDUPE_WINDOW_SECONDS,
        MAX_DEDUPE_WINDOW_SECONDS,
      ),
    'invalid_policy_input',
  );
  const digestWindowSeconds = remapError(
    () =>
      requireIntInRange(
        input.digestWindowSeconds,
        'digestWindowSeconds',
        MIN_DIGEST_WINDOW_SECONDS,
        MAX_DIGEST_WINDOW_SECONDS,
      ),
    'invalid_policy_input',
  );

  let escalationAfterSeconds: number | null = null;
  if (input.escalationAfterSeconds !== undefined && input.escalationAfterSeconds !== null) {
    escalationAfterSeconds = remapError(
      () =>
        requireIntInRange(
          input.escalationAfterSeconds,
          'escalationAfterSeconds',
          MIN_ESCALATION_AFTER_SECONDS,
          MAX_ESCALATION_AFTER_SECONDS,
        ),
      'invalid_policy_input',
    );
  }
  let escalationRecipient: EscalationRecipient | null = null;
  if (input.escalationRecipient !== undefined && input.escalationRecipient !== null) {
    escalationRecipient = remapError(
      () => validateRecipient(input.escalationRecipient, 'escalationRecipient'),
      'invalid_policy_input',
    );
  }

  // Escalation coherence (mirrored by the SQL CHECK): the escalation
  // class demands acknowledgment + deadline + fallback recipient; every
  // other class carries none of the escalation configuration.
  if (deliveryClass === 'escalation') {
    if (!input.requireAcknowledgment) {
      throw policyInputError(
        "deliveryClass 'escalation' requires requireAcknowledgment — an escalation without acknowledgment is meaningless",
      );
    }
    if (escalationAfterSeconds === null) {
      throw policyInputError(
        "deliveryClass 'escalation' requires escalationAfterSeconds (the unacknowledged deadline)",
      );
    }
    if (escalationRecipient === null) {
      throw policyInputError(
        "deliveryClass 'escalation' requires escalationRecipient (the fallback party)",
      );
    }
  } else if (escalationAfterSeconds !== null || escalationRecipient !== null) {
    throw policyInputError(
      `escalationAfterSeconds/escalationRecipient are only valid for deliveryClass 'escalation' (got '${deliveryClass}')`,
    );
  }

  const note = remapError(
    () => boundedOptionalText(input.note, 'note', MAX_NOTE_LENGTH),
    'invalid_policy_input',
  );
  return {
    notificationKind,
    deliveryClass,
    maxAttempts,
    retryBackoffSeconds,
    dedupeWindowSeconds,
    digestWindowSeconds,
    requireAcknowledgment: input.requireAcknowledgment,
    escalationAfterSeconds,
    escalationRecipient,
    note,
  };
}

/** Fully validated + normalized form of `PolicySubjectQuery`. */
export interface ValidatedPolicySubjectQuery {
  notificationKind: string | null;
}

export function validatePolicySubjectQuery(query: PolicySubjectQuery): ValidatedPolicySubjectQuery {
  if (!isPlainObject(query)) throw policyQueryError('query must be an object');
  remapError(
    () => rejectUnknownKeys(query, POLICY_SUBJECT_KEYS, 'the query'),
    'invalid_policy_query',
  );
  let notificationKind: string | null = null;
  if (query.notificationKind !== undefined && query.notificationKind !== null) {
    if (!isNotificationKindSlug(query.notificationKind)) {
      throw policyQueryError(
        `query.notificationKind must be a canonical slug or null (got '${String(query.notificationKind)}')`,
      );
    }
    notificationKind = query.notificationKind;
  }
  return { notificationKind };
}

/** Fully validated + normalized form of `ListNotificationPoliciesQuery`. */
export interface ValidatedPolicyListQuery {
  limit: number;
}

export function validateListNotificationPoliciesQuery(
  query: ListNotificationPoliciesQuery,
): ValidatedPolicyListQuery {
  if (!isPlainObject(query)) throw policyQueryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => !(POLICY_LIST_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw policyQueryError(`unknown query field '${unknown[0]}' (allowed: ${POLICY_LIST_KEYS.join(', ')})`);
  }
  return { limit: requireListLimit(query.limit, 'query.limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT) };
}

// ---------------------------------------------------------------------------
// Notification queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `GetNotificationQuery`. */
export interface ValidatedGetNotificationQuery {
  notificationId: string;
}

export function validateGetNotificationQuery(
  query: GetNotificationQuery,
): ValidatedGetNotificationQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return remapError(() => {
    rejectUnknownKeys(query, GET_NOTIFICATION_KEYS, 'the query');
    return { notificationId: requireUuid(query.notificationId, 'query.notificationId') };
  }, 'invalid_notification_query');
}

/** Fully validated + normalized form of `ListNotificationsQuery`. */
export interface ValidatedListNotificationsQuery {
  notificationKind: string | null;
  status: NotificationStatus | null;
  deliveryClass: NotificationDeliveryClass | null;
  provider: ChannelProvider | null;
  recipientAccountId: string | null;
  dedupeKey: string | null;
  limit: number;
}

export function validateListNotificationsQuery(
  query: ListNotificationsQuery,
): ValidatedListNotificationsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return remapError(() => {
    rejectUnknownKeys(query, LIST_NOTIFICATIONS_KEYS, 'the query');
    let notificationKind: string | null = null;
    if (query.notificationKind !== undefined && query.notificationKind !== null) {
      if (!isNotificationKindSlug(query.notificationKind)) {
        throw queryError(
          `query.notificationKind must be a canonical slug (got '${String(query.notificationKind)}')`,
        );
      }
      notificationKind = query.notificationKind;
    }
    const status =
      query.status === undefined || query.status === null
        ? null
        : isNotificationStatus(query.status)
          ? query.status
          : null;
    if (query.status !== undefined && query.status !== null && status === null) {
      throw queryError(`query.status must be a canonical status (got '${String(query.status)}')`);
    }
    const deliveryClass =
      query.deliveryClass === undefined || query.deliveryClass === null
        ? null
        : isNotificationDeliveryClass(query.deliveryClass)
          ? query.deliveryClass
          : null;
    if (query.deliveryClass !== undefined && query.deliveryClass !== null && deliveryClass === null) {
      throw queryError(
        `query.deliveryClass must be one of urgent, digest, escalation (got '${String(query.deliveryClass)}')`,
      );
    }
    const provider =
      query.provider === undefined || query.provider === null
        ? null
        : isChannelProvider(query.provider)
          ? query.provider
          : null;
    if (query.provider !== undefined && query.provider !== null && provider === null) {
      throw queryError(
        `query.provider must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(query.provider)}')`,
      );
    }
    const recipientAccountId = optionalPrintable(
      query.recipientAccountId,
      'query.recipientAccountId',
      MAX_PROVIDER_ACCOUNT_ID_LENGTH,
    );
    let dedupeKey: string | null = null;
    if (query.dedupeKey !== undefined && query.dedupeKey !== null) {
      if (typeof query.dedupeKey !== 'string' || !EMITTER_KEY_PATTERN.test(query.dedupeKey)) {
        throw queryError(
          `query.dedupeKey must match ${String(EMITTER_KEY_PATTERN)} (got '${String(query.dedupeKey)}')`,
        );
      }
      dedupeKey = query.dedupeKey;
    }
    return {
      notificationKind,
      status,
      deliveryClass,
      provider,
      recipientAccountId,
      dedupeKey,
      limit: requireListLimit(query.limit, 'query.limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    };
  }, 'invalid_notification_query');
}

/** Fully validated + normalized form of `ListNotificationAttemptsQuery`. */
export interface ValidatedAttemptsListQuery {
  notificationId: string;
}

export function validateListNotificationAttemptsQuery(
  query: ListNotificationAttemptsQuery,
): ValidatedAttemptsListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return remapError(() => {
    rejectUnknownKeys(query, ATTEMPTS_LIST_KEYS, 'the query');
    return { notificationId: requireUuid(query.notificationId, 'query.notificationId') };
  }, 'invalid_notification_query');
}

// ---------------------------------------------------------------------------
// Acknowledgments
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `AcknowledgeNotificationInput`. */
export interface ValidatedAcknowledgeInput {
  notificationId: string;
  note: string | null;
}

export function validateAcknowledgeNotificationInput(
  input: AcknowledgeNotificationInput,
): ValidatedAcknowledgeInput {
  if (!isPlainObject(input)) throw inputError('acknowledgment input must be an object');
  return remapError(() => {
    rejectUnknownKeys(input, ACK_KEYS, 'the acknowledgment input');
    const notificationId = requireUuid(input.notificationId, 'notificationId');
    const note = boundedOptionalText(input.note, 'note', MAX_NOTE_LENGTH);
    return { notificationId, note };
  }, 'invalid_notification_input');
}

/** Fully validated + normalized form of `GetNotificationAcknowledgmentQuery`. */
export interface ValidatedGetAcknowledgmentQuery {
  notificationId: string;
}

export function validateGetNotificationAcknowledgmentQuery(
  query: GetNotificationAcknowledgmentQuery,
): ValidatedGetAcknowledgmentQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return remapError(() => {
    rejectUnknownKeys(query, GET_NOTIFICATION_KEYS, 'the query');
    return { notificationId: requireUuid(query.notificationId, 'query.notificationId') };
  }, 'invalid_notification_query');
}

// ---------------------------------------------------------------------------
// Due-processing pumps
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RetryDueQuery`. */
export interface ValidatedRetryDueQuery {
  limit: number;
}

export function validateRetryDueQuery(query: RetryDueQuery): ValidatedRetryDueQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => !(RETRY_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: ${RETRY_KEYS.join(', ')})`);
  }
  return { limit: requireListLimit(query.limit, 'query.limit', DEFAULT_RETRY_LIMIT, MAX_RETRY_LIMIT) };
}

/** Fully validated + normalized form of `FlushDigestsQuery`. */
export interface ValidatedFlushDigestsQuery {
  limit: number;
}

export function validateFlushDigestsQuery(query: FlushDigestsQuery): ValidatedFlushDigestsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => !(DIGEST_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: ${DIGEST_KEYS.join(', ')})`);
  }
  return {
    limit: requireListLimit(query.limit, 'query.limit', DEFAULT_DIGEST_GROUP_LIMIT, MAX_DIGEST_GROUP_LIMIT),
  };
}

/** Fully validated + normalized form of `EscalateUnacknowledgedQuery`. */
export interface ValidatedEscalateQuery {
  limit: number;
}

export function validateEscalateUnacknowledgedQuery(
  query: EscalateUnacknowledgedQuery,
): ValidatedEscalateQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => !(ESCALATION_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: ${ESCALATION_KEYS.join(', ')})`);
  }
  return { limit: requireListLimit(query.limit, 'query.limit', DEFAULT_RETRY_LIMIT, MAX_RETRY_LIMIT) };
}
