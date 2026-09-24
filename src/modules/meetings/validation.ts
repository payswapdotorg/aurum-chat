// Pure validation/normalization logic of the meetings module (no database,
// no clock, no network). Everything a caller, an adapter or a transport may
// put into the capture path crosses these guards first; the SQL CHECK
// constraints in migrations/ mirror the load-bearing rules as defense in
// depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId` or credential VALUES into a capture record — registry identity,
// tenancy and commit times are minted by the system, and secrets never enter
// domain tables at all (IMPLEMENTATION-STACK §8).
//
// Adapter and transport output is re-validated here (defense in depth): the
// provider-native envelope exists only inside `adapters/`, and its
// canonicalized output must still pass the canonical contract before
// anything reaches the registry or the observations contract — a buggy
// adapter cannot smuggle provider shapes past the boundary (lock 16), and
// neither can a misbehaving transport.

import type { TenantContext } from '@/infra/tenant';
import { MeetingsError } from './errors';
import type {
  ListMeetingAccessEventsQuery,
  ListMeetingArtifactsQuery,
  ListMeetingConnectionsQuery,
  ListMeetingParticipantsQuery,
  ListMeetingsQuery,
  ListMeetingSessionsQuery,
  ListMeetingTranscriptsQuery,
  MeetingAccessCode,
  MeetingArtifactKind,
  MeetingAuthKind,
  MeetingConnectionStatus,
  MeetingIngestionMode,
  MeetingIngestionVia,
  MeetingProvider,
  MeetingSessionStatus,
  PollMeetingConnectionInput,
  RegisterMeetingConnectionInput,
  SetMeetingConnectionStatusInput,
} from './types';

/** Canonical meeting-provider vocabulary (mirrored by the migration CHECKs and the adapter registry). */
export const MEETING_PROVIDERS = [
  'zoom',
  'microsoft-teams',
  'google-meet',
  'recall',
] as const;

export const MEETING_CONNECTION_STATUSES = ['active', 'disabled'] as const;
export const MEETING_AUTH_KINDS = ['oauth', 'credentials'] as const;
export const MEETING_INGESTION_MODES = ['polling', 'webhook'] as const;
export const MEETING_INGESTION_VIAS = ['polling', 'webhook'] as const;
export const MEETING_SESSION_STATUSES = ['scheduled', 'started', 'ended'] as const;
export const MEETING_ARTIFACT_KINDS = [
  'recording',
  'chat',
  'summary',
  'document',
  'attachment',
  'other',
] as const;
export const MEETING_ACCESS_CODES = [
  'authorization_expired',
  'access_denied',
  'not_found',
  'recording_unavailable',
  'transcript_unavailable',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MAX_RECORDS = 50;
export const MAX_MAX_RECORDS = 200;
/** Hard cap on one capture batch, whatever the caller asked for. */
export const MAX_BATCH_RECORDS = 200;
export const MAX_PAYLOAD_BYTES = 1_048_576; // mirrors the observations module's cap
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_OAUTH_SCOPES = 32;
export const MAX_SCOPE_LENGTH = 255;
export const MAX_CURSOR_LENGTH = 1024;
export const MAX_PROVIDER_RECORD_ID_LENGTH = 255;
export const MAX_PROVIDER_MEETING_ID_LENGTH = 255;
export const MAX_PROVIDER_SESSION_ID_LENGTH = 255;
export const MAX_PROVIDER_TRANSCRIPT_ID_LENGTH = 255;
export const MAX_PROVIDER_ARTIFACT_ID_LENGTH = 255;
export const MAX_PROVIDER_PARTICIPANT_ID_LENGTH = 255;
export const MAX_TITLE_LENGTH = 300;
export const MAX_AGENDA_LENGTH = 4000;
export const MAX_EMAIL_LENGTH = 320;
export const MAX_LANGUAGE_LENGTH = 35;
export const MAX_MEDIA_TYPE_LENGTH = 255;
export const MAX_STORAGE_REF_LENGTH = 1024;
export const MAX_CHECKSUM_LENGTH = 255;
export const MAX_DETAIL_LENGTH = 2000;
export const MAX_SEGMENT_TEXT_LENGTH = 20_000;
export const MAX_PARTICIPANTS_PER_SESSION = 500;
export const MAX_SEGMENTS_PER_TRANSCRIPT = 5000;
export const MAX_BYTE_SIZE = 2_147_483_647; // signed 32-bit — the bigint CHECK in migrations/
export const MAX_UNDERLYING_PLATFORM_LENGTH = 64;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset — provider event times are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_ID_PATTERN = /^[\P{C}\s]+$/u;
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const UNDERLYING_PLATFORM_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const REGISTER_INPUT_KEYS = [
  'provider',
  'providerAccountId',
  'displayName',
  'authKind',
  'credentialRef',
  'oauthScopes',
  'oauthExpiresAt',
] as const;
const LIST_CONNECTIONS_QUERY_KEYS = ['provider', 'status', 'limit'] as const;
const SET_STATUS_INPUT_KEYS = ['connectionId', 'status'] as const;
const POLL_INPUT_KEYS = ['connectionId', 'maxRecords'] as const;
const RECEIVE_WEBHOOK_INPUT_KEYS = ['provider', 'payload'] as const;
const LIST_MEETINGS_QUERY_KEYS = [
  'provider',
  'connectionId',
  'scheduledFrom',
  'scheduledTo',
  'limit',
] as const;
const LIST_SESSIONS_QUERY_KEYS = [
  'meetingId',
  'status',
  'startedFrom',
  'startedTo',
  'limit',
] as const;
const LIST_TRANSCRIPTS_QUERY_KEYS = ['sessionId', 'limit'] as const;
const LIST_ARTIFACTS_QUERY_KEYS = ['sessionId', 'kind', 'limit'] as const;
const LIST_ACCESS_EVENTS_QUERY_KEYS = ['connectionId', 'code', 'limit'] as const;
const LIST_PARTICIPANTS_QUERY_KEYS = ['provider', 'limit'] as const;

const PARTICIPANT_KEYS = ['providerParticipantId', 'displayName', 'email'] as const;
const ATTENDANCE_KEYS = ['participant', 'joinedAt', 'leftAt'] as const;
const SEGMENT_KEYS = [
  'providerParticipantId',
  'speakerName',
  'startedAt',
  'endedAt',
  'text',
  'confidence',
] as const;
const MEETING_UPDATED_KEYS = [
  'kind',
  'providerRecordId',
  'occurredAt',
  'providerMeetingId',
  'title',
  'agenda',
  'scheduledStartAt',
  'scheduledEndAt',
  'underlyingPlatform',
  'host',
] as const;
const SESSION_UPDATED_KEYS = [
  'kind',
  'providerRecordId',
  'occurredAt',
  'providerMeetingId',
  'providerSessionId',
  'status',
  'title',
  'startedAt',
  'endedAt',
  'participants',
] as const;
const TRANSCRIPT_AVAILABLE_KEYS = [
  'kind',
  'providerRecordId',
  'occurredAt',
  'providerMeetingId',
  'providerSessionId',
  'providerTranscriptId',
  'language',
  'segments',
] as const;
const ARTIFACT_AVAILABLE_KEYS = [
  'kind',
  'providerRecordId',
  'occurredAt',
  'providerMeetingId',
  'providerSessionId',
  'providerArtifactId',
  'artifactKind',
  'displayName',
  'mediaType',
  'byteSize',
  'storageRef',
  'checksum',
] as const;
const ACCESS_FAILED_KEYS = [
  'kind',
  'providerRecordId',
  'occurredAt',
  'providerMeetingId',
  'accessCode',
  'detail',
] as const;
const WEBHOOK_PARSE_KEYS = ['providerAccountId', 'records'] as const;
const FETCH_RESULT_KEYS = ['records', 'nextCursor', 'hasMore', 'authorizationExpiresAt'] as const;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isMeetingProvider(value: unknown): value is MeetingProvider {
  return typeof value === 'string' && (MEETING_PROVIDERS as readonly string[]).includes(value);
}

export function isMeetingConnectionStatus(value: unknown): value is MeetingConnectionStatus {
  return (
    typeof value === 'string' &&
    (MEETING_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isMeetingAuthKind(value: unknown): value is MeetingAuthKind {
  return typeof value === 'string' && (MEETING_AUTH_KINDS as readonly string[]).includes(value);
}

export function isMeetingIngestionMode(value: unknown): value is MeetingIngestionMode {
  return (
    typeof value === 'string' && (MEETING_INGESTION_MODES as readonly string[]).includes(value)
  );
}

export function isMeetingIngestionVia(value: unknown): value is MeetingIngestionVia {
  return (
    typeof value === 'string' && (MEETING_INGESTION_VIAS as readonly string[]).includes(value)
  );
}

export function isMeetingSessionStatus(value: unknown): value is MeetingSessionStatus {
  return (
    typeof value === 'string' && (MEETING_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isMeetingArtifactKind(value: unknown): value is MeetingArtifactKind {
  return (
    typeof value === 'string' && (MEETING_ARTIFACT_KINDS as readonly string[]).includes(value)
  );
}

export function isMeetingAccessCode(value: unknown): value is MeetingAccessCode {
  return typeof value === 'string' && (MEETING_ACCESS_CODES as readonly string[]).includes(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertMeetingsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new MeetingsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new MeetingsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new MeetingsError(
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
  fail: (message: string) => MeetingsError,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw fail(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  fail: (message: string) => MeetingsError,
): string {
  if (typeof value !== 'string') throw fail(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw fail(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  fail: (message: string) => MeetingsError,
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
  fail: (message: string) => MeetingsError,
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
  fail: (message: string) => MeetingsError,
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
  fail: (message: string) => MeetingsError,
): string {
  const text = requireString(value, field, fail);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw fail(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-24T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

function optionalIsoInstant(
  value: unknown,
  field: string,
  fail: (message: string) => MeetingsError,
): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field, fail);
}

function requireLimit(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
  fail: (message: string) => MeetingsError,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw fail(`${field} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}

function inputError(message: string): MeetingsError {
  return new MeetingsError('invalid_meeting_input', message);
}

function queryError(message: string): MeetingsError {
  return new MeetingsError('invalid_meeting_query', message);
}

function payloadError(message: string): MeetingsError {
  return new MeetingsError('invalid_provider_payload', message);
}

function fetchResultError(message: string): MeetingsError {
  return new MeetingsError('invalid_fetch_result', message);
}

// ---------------------------------------------------------------------------
// Connection registration / queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterMeetingConnectionInput`. */
export interface ValidatedRegisterConnectionInput {
  provider: MeetingProvider;
  providerAccountId: string;
  displayName: string | null;
  authKind: MeetingAuthKind;
  credentialRef: string;
  oauthScopes: string[];
  oauthExpiresAt: string | null;
}

export function validateRegisterConnectionInput(
  input: RegisterMeetingConnectionInput,
): ValidatedRegisterConnectionInput {
  if (!isPlainObject(input)) throw inputError('connection input must be an object');
  rejectUnknownKeys(input, REGISTER_INPUT_KEYS, 'the connection input', inputError);

  if (!isMeetingProvider(input.provider)) {
    throw inputError(
      `provider must be one of ${MEETING_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
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
  if (!isMeetingAuthKind(input.authKind)) {
    throw inputError(
      `authKind must be one of ${MEETING_AUTH_KINDS.join(', ')} (got '${String(input.authKind)}')`,
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
      'credentials-authorized connections carry no OAuth state — omit oauthScopes and oauthExpiresAt',
    );
  }
  if (input.authKind === 'oauth' && scopes.length === 0) {
    throw inputError('oauth-authorized connections must declare at least one granted scope');
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

/** Fully validated + normalized form of `ListMeetingConnectionsQuery`. */
export interface ValidatedListConnectionsQuery {
  provider: MeetingProvider | null;
  status: MeetingConnectionStatus | null;
  limit: number;
}

export function validateListConnectionsQuery(
  query: ListMeetingConnectionsQuery,
): ValidatedListConnectionsQuery {
  if (!isPlainObject(query)) throw queryError('connections query must be an object');
  rejectUnknownKeys(query, LIST_CONNECTIONS_QUERY_KEYS, 'the connections query', queryError);
  if (query.provider !== undefined && query.provider !== null && !isMeetingProvider(query.provider)) {
    throw queryError(
      `provider must be one of ${MEETING_PROVIDERS.join(', ')} (got '${String(query.provider)}')`,
    );
  }
  if (
    query.status !== undefined &&
    query.status !== null &&
    !isMeetingConnectionStatus(query.status)
  ) {
    throw queryError(
      `status must be one of ${MEETING_CONNECTION_STATUSES.join(', ')} (got '${String(query.status)}')`,
    );
  }
  return {
    provider: query.provider ?? null,
    status: query.status ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export function validateSetConnectionStatusInput(input: SetMeetingConnectionStatusInput): {
  connectionId: string;
  status: MeetingConnectionStatus;
} {
  if (!isPlainObject(input)) throw inputError('status input must be an object');
  rejectUnknownKeys(input, SET_STATUS_INPUT_KEYS, 'the status input', inputError);
  const connectionId = requireUuid(input.connectionId, 'connectionId', inputError);
  if (!isMeetingConnectionStatus(input.status)) {
    throw inputError(
      `status must be one of ${MEETING_CONNECTION_STATUSES.join(', ')} (got '${String(input.status)}')`,
    );
  }
  return { connectionId, status: input.status };
}

// ---------------------------------------------------------------------------
// Polling / webhook inputs
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `PollMeetingConnectionInput`. */
export interface ValidatedPollInput {
  connectionId: string;
  maxRecords: number;
}

export function validatePollInput(input: PollMeetingConnectionInput): ValidatedPollInput {
  if (!isPlainObject(input)) throw inputError('poll input must be an object');
  rejectUnknownKeys(input, POLL_INPUT_KEYS, 'the poll input', inputError);
  const connectionId = requireUuid(input.connectionId, 'connectionId', inputError);
  return {
    connectionId,
    maxRecords: requireLimit(
      input.maxRecords,
      'maxRecords',
      DEFAULT_MAX_RECORDS,
      MAX_MAX_RECORDS,
      inputError,
    ),
  };
}

/** Fully validated + normalized webhook input (the payload stays raw for the adapter). */
export interface ValidatedReceiveWebhookInput {
  provider: MeetingProvider;
}

export function validateReceiveWebhookInput(
  input: { provider: unknown; payload: unknown },
): ValidatedReceiveWebhookInput {
  if (!isPlainObject(input)) throw inputError('webhook input must be an object');
  rejectUnknownKeys(input, RECEIVE_WEBHOOK_INPUT_KEYS, 'the webhook input', inputError);
  if (!isMeetingProvider(input.provider)) {
    throw inputError(
      `provider must be one of ${MEETING_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
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
// Registry queries
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ListMeetingsQuery`. */
export interface ValidatedListMeetingsQuery {
  provider: MeetingProvider | null;
  connectionId: string | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  limit: number;
}

export function validateListMeetingsQuery(query: ListMeetingsQuery): ValidatedListMeetingsQuery {
  if (!isPlainObject(query)) throw queryError('meetings query must be an object');
  rejectUnknownKeys(query, LIST_MEETINGS_QUERY_KEYS, 'the meetings query', queryError);
  if (query.provider !== undefined && query.provider !== null && !isMeetingProvider(query.provider)) {
    throw queryError(
      `provider must be one of ${MEETING_PROVIDERS.join(', ')} (got '${String(query.provider)}')`,
    );
  }
  const connectionId =
    query.connectionId === undefined || query.connectionId === null
      ? null
      : requireUuid(query.connectionId, 'connectionId', queryError);
  const scheduledFrom = optionalIsoInstant(query.scheduledFrom, 'scheduledFrom', queryError);
  const scheduledTo = optionalIsoInstant(query.scheduledTo, 'scheduledTo', queryError);
  if (scheduledFrom !== null && scheduledTo !== null && scheduledFrom > scheduledTo) {
    throw queryError('scheduledFrom must not be after scheduledTo');
  }
  return {
    provider: query.provider ?? null,
    connectionId,
    scheduledFrom,
    scheduledTo,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

/** Fully validated + normalized form of `ListMeetingSessionsQuery`. */
export interface ValidatedListSessionsQuery {
  meetingId: string | null;
  status: MeetingSessionStatus | null;
  startedFrom: string | null;
  startedTo: string | null;
  limit: number;
}

export function validateListSessionsQuery(
  query: ListMeetingSessionsQuery,
): ValidatedListSessionsQuery {
  if (!isPlainObject(query)) throw queryError('sessions query must be an object');
  rejectUnknownKeys(query, LIST_SESSIONS_QUERY_KEYS, 'the sessions query', queryError);
  const meetingId =
    query.meetingId === undefined || query.meetingId === null
      ? null
      : requireUuid(query.meetingId, 'meetingId', queryError);
  if (query.status !== undefined && query.status !== null && !isMeetingSessionStatus(query.status)) {
    throw queryError(
      `status must be one of ${MEETING_SESSION_STATUSES.join(', ')} (got '${String(query.status)}')`,
    );
  }
  const startedFrom = optionalIsoInstant(query.startedFrom, 'startedFrom', queryError);
  const startedTo = optionalIsoInstant(query.startedTo, 'startedTo', queryError);
  if (startedFrom !== null && startedTo !== null && startedFrom > startedTo) {
    throw queryError('startedFrom must not be after startedTo');
  }
  return {
    meetingId,
    status: query.status ?? null,
    startedFrom,
    startedTo,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

/** Fully validated + normalized form of `ListMeetingTranscriptsQuery`. */
export interface ValidatedListTranscriptsQuery {
  sessionId: string;
  limit: number;
}

export function validateListTranscriptsQuery(
  query: ListMeetingTranscriptsQuery,
): ValidatedListTranscriptsQuery {
  if (!isPlainObject(query)) throw queryError('transcripts query must be an object');
  rejectUnknownKeys(query, LIST_TRANSCRIPTS_QUERY_KEYS, 'the transcripts query', queryError);
  return {
    sessionId: requireUuid(query.sessionId, 'sessionId', queryError),
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

/** Fully validated + normalized form of `ListMeetingArtifactsQuery`. */
export interface ValidatedListArtifactsQuery {
  sessionId: string;
  kind: MeetingArtifactKind | null;
  limit: number;
}

export function validateListArtifactsQuery(
  query: ListMeetingArtifactsQuery,
): ValidatedListArtifactsQuery {
  if (!isPlainObject(query)) throw queryError('artifacts query must be an object');
  rejectUnknownKeys(query, LIST_ARTIFACTS_QUERY_KEYS, 'the artifacts query', queryError);
  if (query.kind !== undefined && query.kind !== null && !isMeetingArtifactKind(query.kind)) {
    throw queryError(
      `kind must be one of ${MEETING_ARTIFACT_KINDS.join(', ')} (got '${String(query.kind)}')`,
    );
  }
  return {
    sessionId: requireUuid(query.sessionId, 'sessionId', queryError),
    kind: query.kind ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

/** Fully validated + normalized form of `ListMeetingAccessEventsQuery`. */
export interface ValidatedListAccessEventsQuery {
  connectionId: string | null;
  code: MeetingAccessCode | null;
  limit: number;
}

export function validateListAccessEventsQuery(
  query: ListMeetingAccessEventsQuery,
): ValidatedListAccessEventsQuery {
  if (!isPlainObject(query)) throw queryError('access events query must be an object');
  rejectUnknownKeys(query, LIST_ACCESS_EVENTS_QUERY_KEYS, 'the access events query', queryError);
  const connectionId =
    query.connectionId === undefined || query.connectionId === null
      ? null
      : requireUuid(query.connectionId, 'connectionId', queryError);
  if (query.code !== undefined && query.code !== null && !isMeetingAccessCode(query.code)) {
    throw queryError(
      `code must be one of ${MEETING_ACCESS_CODES.join(', ')} (got '${String(query.code)}')`,
    );
  }
  return {
    connectionId,
    code: query.code ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

/** Fully validated + normalized form of `ListMeetingParticipantsQuery`. */
export interface ValidatedListParticipantsQuery {
  provider: MeetingProvider | null;
  limit: number;
}

export function validateListParticipantsQuery(
  query: ListMeetingParticipantsQuery,
): ValidatedListParticipantsQuery {
  if (!isPlainObject(query)) throw queryError('participants query must be an object');
  rejectUnknownKeys(query, LIST_PARTICIPANTS_QUERY_KEYS, 'the participants query', queryError);
  if (query.provider !== undefined && query.provider !== null && !isMeetingProvider(query.provider)) {
    throw queryError(
      `provider must be one of ${MEETING_PROVIDERS.join(', ')} (got '${String(query.provider)}')`,
    );
  }
  return {
    provider: query.provider ?? null,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

// ---------------------------------------------------------------------------
// Canonical participants / segments (shared by the record validators)
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CanonicalParticipant`. */
export interface ValidatedParticipant {
  providerParticipantId: string;
  displayName: string | null;
  email: string | null;
}

export function validateCanonicalParticipant(
  value: unknown,
  fail: (message: string) => MeetingsError,
): ValidatedParticipant {
  if (!isPlainObject(value)) throw fail('participant must be an object');
  rejectUnknownKeys(value, PARTICIPANT_KEYS, 'participant', fail);
  const providerParticipantId = requirePrintable(
    value.providerParticipantId,
    'participant.providerParticipantId',
    MAX_PROVIDER_PARTICIPANT_ID_LENGTH,
    fail,
  );
  const displayName = optionalTrimmed(value.displayName, 'participant.displayName', fail);
  if (displayName !== null && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw fail(
      `participant.displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${displayName.length})`,
    );
  }
  const email = optionalTrimmed(value.email, 'participant.email', fail);
  if (email !== null && email.length > MAX_EMAIL_LENGTH) {
    throw fail(
      `participant.email must be at most ${MAX_EMAIL_LENGTH} characters (got ${email.length})`,
    );
  }
  return { providerParticipantId, displayName, email };
}

/** Fully validated + normalized form of `CanonicalParticipantAttendance`. */
export interface ValidatedAttendance {
  participant: ValidatedParticipant;
  joinedAt: string | null;
  leftAt: string | null;
}

export function validateAttendance(
  value: unknown,
  fail: (message: string) => MeetingsError,
): ValidatedAttendance {
  if (!isPlainObject(value)) throw fail('attendance must be an object');
  rejectUnknownKeys(value, ATTENDANCE_KEYS, 'attendance', fail);
  const participant = validateCanonicalParticipant(value.participant, fail);
  const joinedAt = optionalIsoInstant(value.joinedAt, 'attendance.joinedAt', fail);
  const leftAt = optionalIsoInstant(value.leftAt, 'attendance.leftAt', fail);
  if (joinedAt !== null && leftAt !== null && leftAt < joinedAt) {
    throw fail('attendance.leftAt must not be before attendance.joinedAt');
  }
  return { participant, joinedAt, leftAt };
}

/** Fully validated + normalized form of `CanonicalTranscriptSegment`. */
export interface ValidatedSegment {
  providerParticipantId: string | null;
  speakerName: string | null;
  startedAt: string;
  endedAt: string | null;
  text: string;
  confidence: number | null;
}

export function validateSegment(
  value: unknown,
  fail: (message: string) => MeetingsError,
): ValidatedSegment {
  if (!isPlainObject(value)) throw fail('segment must be an object');
  rejectUnknownKeys(value, SEGMENT_KEYS, 'segment', fail);
  const providerParticipantId =
    value.providerParticipantId === undefined || value.providerParticipantId === null
      ? null
      : requirePrintable(
          value.providerParticipantId,
          'segment.providerParticipantId',
          MAX_PROVIDER_PARTICIPANT_ID_LENGTH,
          fail,
        );
  const speakerName = optionalTrimmed(value.speakerName, 'segment.speakerName', fail);
  if (speakerName !== null && speakerName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw fail(
      `segment.speakerName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${speakerName.length})`,
    );
  }
  const startedAt = requireIsoInstant(value.startedAt, 'segment.startedAt', fail);
  const endedAt = optionalIsoInstant(value.endedAt, 'segment.endedAt', fail);
  if (endedAt !== null && endedAt < startedAt) {
    throw fail('segment.endedAt must not be before segment.startedAt');
  }
  const text = requireString(value.text, 'segment.text', fail);
  if (text.length > MAX_SEGMENT_TEXT_LENGTH) {
    throw fail(
      `segment.text must be at most ${MAX_SEGMENT_TEXT_LENGTH} characters (got ${text.length})`,
    );
  }
  let confidence: number | null = null;
  if (value.confidence !== undefined && value.confidence !== null) {
    if (
      typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1
    ) {
      throw fail('segment.confidence must be a number in [0, 1] when present');
    }
    confidence = value.confidence;
  }
  return { providerParticipantId, speakerName, startedAt, endedAt, text, confidence };
}

// ---------------------------------------------------------------------------
// Canonical records (adapter/transport output — defense in depth)
// ---------------------------------------------------------------------------

/**
 * Fully validated + normalized form of `CanonicalMeetingRecord` — the
 * discriminated union stays intact; each variant keeps its own shape.
 */
export type ValidatedMeetingRecord =
  | {
      kind: 'meeting.updated';
      providerRecordId: string;
      occurredAt: string;
      providerMeetingId: string;
      title: string | null;
      agenda: string | null;
      scheduledStartAt: string | null;
      scheduledEndAt: string | null;
      underlyingPlatform: string | null;
      host: ValidatedParticipant | null;
    }
  | {
      kind: 'session.updated';
      providerRecordId: string;
      occurredAt: string;
      providerMeetingId: string;
      providerSessionId: string;
      status: MeetingSessionStatus;
      title: string | null;
      startedAt: string | null;
      endedAt: string | null;
      participants: ValidatedAttendance[];
    }
  | {
      kind: 'transcript.available';
      providerRecordId: string;
      occurredAt: string;
      providerMeetingId: string;
      providerSessionId: string;
      providerTranscriptId: string;
      language: string | null;
      segments: ValidatedSegment[];
    }
  | {
      kind: 'artifact.available';
      providerRecordId: string;
      occurredAt: string;
      providerMeetingId: string;
      providerSessionId: string;
      providerArtifactId: string;
      artifactKind: MeetingArtifactKind;
      displayName: string | null;
      mediaType: string | null;
      byteSize: number | null;
      storageRef: string | null;
      checksum: string | null;
    }
  | {
      kind: 'access.failed';
      providerRecordId: string;
      occurredAt: string;
      providerMeetingId: string | null;
      accessCode: MeetingAccessCode;
      detail: string | null;
    };

/**
 * Validates one canonical meeting record. `fail` builds the context's error
 * (webhook-adapter output fails `invalid_provider_payload`; transport
 * output fails `invalid_fetch_result`) — the record shape itself is one
 * contract, so a buggy adapter cannot smuggle a malformed record past the
 * boundary and neither can a misbehaving transport.
 */
export function validateCanonicalMeetingRecord(
  value: unknown,
  fail: (message: string) => MeetingsError,
): ValidatedMeetingRecord {
  if (!isPlainObject(value)) throw fail('record must be an object');
  if (value.kind === undefined) throw fail('record.kind must be present');

  const providerRecordId = (): string =>
    requirePrintable(
      (value as Record<string, unknown>).providerRecordId,
      'record.providerRecordId',
      MAX_PROVIDER_RECORD_ID_LENGTH,
      fail,
    );
  const occurredAt = (): string =>
    requireIsoInstant((value as Record<string, unknown>).occurredAt, 'record.occurredAt', fail);

  switch (value.kind) {
    case 'meeting.updated': {
      rejectUnknownKeys(value, MEETING_UPDATED_KEYS, 'record', fail);
      const providerMeetingId = requirePrintable(
        value.providerMeetingId,
        'record.providerMeetingId',
        MAX_PROVIDER_MEETING_ID_LENGTH,
        fail,
      );
      const title = optionalTrimmed(value.title, 'record.title', fail);
      if (title !== null && title.length > MAX_TITLE_LENGTH) {
        throw fail(`record.title must be at most ${MAX_TITLE_LENGTH} characters`);
      }
      const agenda = optionalTrimmed(value.agenda, 'record.agenda', fail);
      if (agenda !== null && agenda.length > MAX_AGENDA_LENGTH) {
        throw fail(`record.agenda must be at most ${MAX_AGENDA_LENGTH} characters`);
      }
      const scheduledStartAt = optionalIsoInstant(
        value.scheduledStartAt,
        'record.scheduledStartAt',
        fail,
      );
      const scheduledEndAt = optionalIsoInstant(
        value.scheduledEndAt,
        'record.scheduledEndAt',
        fail,
      );
      if (
        scheduledStartAt !== null &&
        scheduledEndAt !== null &&
        scheduledEndAt < scheduledStartAt
      ) {
        throw fail('record.scheduledEndAt must not be before record.scheduledStartAt');
      }
      const underlyingPlatform = optionalTrimmed(
        value.underlyingPlatform,
        'record.underlyingPlatform',
        fail,
      );
      if (
        underlyingPlatform !== null &&
        !UNDERLYING_PLATFORM_PATTERN.test(underlyingPlatform)
      ) {
        throw fail(
          `record.underlyingPlatform must be a lowercase neutral platform key like 'zoom' (got '${underlyingPlatform}')`,
        );
      }
      const host =
        value.host === undefined || value.host === null
          ? null
          : validateCanonicalParticipant(value.host, fail);
      return {
        kind: 'meeting.updated',
        providerRecordId: providerRecordId(),
        occurredAt: occurredAt(),
        providerMeetingId,
        title,
        agenda,
        scheduledStartAt,
        scheduledEndAt,
        underlyingPlatform,
        host,
      };
    }

    case 'session.updated': {
      rejectUnknownKeys(value, SESSION_UPDATED_KEYS, 'record', fail);
      const providerMeetingId = requirePrintable(
        value.providerMeetingId,
        'record.providerMeetingId',
        MAX_PROVIDER_MEETING_ID_LENGTH,
        fail,
      );
      const providerSessionId = requirePrintable(
        value.providerSessionId,
        'record.providerSessionId',
        MAX_PROVIDER_SESSION_ID_LENGTH,
        fail,
      );
      if (!isMeetingSessionStatus(value.status)) {
        throw fail(
          `record.status must be one of ${MEETING_SESSION_STATUSES.join(', ')} (got '${String(value.status)}')`,
        );
      }
      const title = optionalTrimmed(value.title, 'record.title', fail);
      if (title !== null && title.length > MAX_TITLE_LENGTH) {
        throw fail(`record.title must be at most ${MAX_TITLE_LENGTH} characters`);
      }
      const startedAt = optionalIsoInstant(value.startedAt, 'record.startedAt', fail);
      const endedAt = optionalIsoInstant(value.endedAt, 'record.endedAt', fail);
      // Actual-time coherence: a started session must carry its actual
      // start; an ended session must carry its actual end.
      if (value.status === 'started' && startedAt === null) {
        throw fail("record.startedAt is required when status is 'started'");
      }
      if (value.status === 'ended' && endedAt === null) {
        throw fail("record.endedAt is required when status is 'ended'");
      }
      if (startedAt !== null && endedAt !== null && endedAt < startedAt) {
        throw fail('record.endedAt must not be before record.startedAt');
      }
      if (!Array.isArray(value.participants)) {
        throw fail('record.participants must be an array');
      }
      if (value.participants.length > MAX_PARTICIPANTS_PER_SESSION) {
        throw fail(
          `record.participants supports at most ${MAX_PARTICIPANTS_PER_SESSION} entries (got ${value.participants.length})`,
        );
      }
      const validatedParticipants: ValidatedAttendance[] = [];
      const seenParticipantIds = new Set<string>();
      for (const [index, entry] of (value.participants as unknown[]).entries()) {
        const attendance = validateAttendance(entry, (message) =>
          fail(`record.participants[${index}]: ${message}`),
        );
        if (seenParticipantIds.has(attendance.participant.providerParticipantId)) {
          throw fail(
            `record.participants[${index}] duplicates participant '${attendance.participant.providerParticipantId}' within one record`,
          );
        }
        seenParticipantIds.add(attendance.participant.providerParticipantId);
        validatedParticipants.push(attendance);
      }
      return {
        kind: 'session.updated',
        providerRecordId: providerRecordId(),
        occurredAt: occurredAt(),
        providerMeetingId,
        providerSessionId,
        status: value.status,
        title,
        startedAt,
        endedAt,
        participants: validatedParticipants,
      };
    }

    case 'transcript.available': {
      rejectUnknownKeys(value, TRANSCRIPT_AVAILABLE_KEYS, 'record', fail);
      const providerMeetingId = requirePrintable(
        value.providerMeetingId,
        'record.providerMeetingId',
        MAX_PROVIDER_MEETING_ID_LENGTH,
        fail,
      );
      const providerSessionId = requirePrintable(
        value.providerSessionId,
        'record.providerSessionId',
        MAX_PROVIDER_SESSION_ID_LENGTH,
        fail,
      );
      const providerTranscriptId = requirePrintable(
        value.providerTranscriptId,
        'record.providerTranscriptId',
        MAX_PROVIDER_TRANSCRIPT_ID_LENGTH,
        fail,
      );
      const language = optionalTrimmed(value.language, 'record.language', fail);
      if (language !== null && !LANGUAGE_TAG_PATTERN.test(language)) {
        throw fail(
          `record.language must be a BCP-47-style tag like 'en-US' (got '${language}')`,
        );
      }
      if (!Array.isArray(value.segments)) {
        throw fail('record.segments must be an array');
      }
      if (value.segments.length === 0) {
        throw fail('record.segments must carry at least one segment');
      }
      if (value.segments.length > MAX_SEGMENTS_PER_TRANSCRIPT) {
        throw fail(
          `record.segments supports at most ${MAX_SEGMENTS_PER_TRANSCRIPT} entries (got ${value.segments.length})`,
        );
      }
      const segments: ValidatedSegment[] = [];
      let previousStarted: string | null = null;
      for (const [index, entry] of (value.segments as unknown[]).entries()) {
        const segment = validateSegment(entry, (message) =>
          fail(`record.segments[${index}]: ${message}`),
        );
        // Transcripts are ordered: a segment may not start before its
        // predecessor (provider ASR timelines are monotonic).
        if (previousStarted !== null && segment.startedAt < previousStarted) {
          throw fail(
            `record.segments[${index}].startedAt must not precede the previous segment (transcripts are ordered)`,
          );
        }
        previousStarted = segment.startedAt;
        segments.push(segment);
      }
      return {
        kind: 'transcript.available',
        providerRecordId: providerRecordId(),
        occurredAt: occurredAt(),
        providerMeetingId,
        providerSessionId,
        providerTranscriptId,
        language,
        segments,
      };
    }

    case 'artifact.available': {
      rejectUnknownKeys(value, ARTIFACT_AVAILABLE_KEYS, 'record', fail);
      const providerMeetingId = requirePrintable(
        value.providerMeetingId,
        'record.providerMeetingId',
        MAX_PROVIDER_MEETING_ID_LENGTH,
        fail,
      );
      const providerSessionId = requirePrintable(
        value.providerSessionId,
        'record.providerSessionId',
        MAX_PROVIDER_SESSION_ID_LENGTH,
        fail,
      );
      const providerArtifactId = requirePrintable(
        value.providerArtifactId,
        'record.providerArtifactId',
        MAX_PROVIDER_ARTIFACT_ID_LENGTH,
        fail,
      );
      if (!isMeetingArtifactKind(value.artifactKind)) {
        throw fail(
          `record.artifactKind must be one of ${MEETING_ARTIFACT_KINDS.join(', ')} (got '${String(value.artifactKind)}')`,
        );
      }
      const displayName = optionalTrimmed(value.displayName, 'record.displayName', fail);
      if (displayName !== null && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
        throw fail(
          `record.displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${displayName.length})`,
        );
      }
      const mediaType = optionalTrimmed(value.mediaType, 'record.mediaType', fail);
      if (mediaType !== null && !MEDIA_TYPE_PATTERN.test(mediaType)) {
        throw fail(`record.mediaType must be a MIME type like 'video/mp4' (got '${mediaType}')`);
      }
      let byteSize: number | null = null;
      if (value.byteSize !== undefined && value.byteSize !== null) {
        if (
          typeof value.byteSize !== 'number' ||
          !Number.isInteger(value.byteSize) ||
          value.byteSize < 0 ||
          value.byteSize > MAX_BYTE_SIZE
        ) {
          throw fail('record.byteSize must be a non-negative integer when present');
        }
        byteSize = value.byteSize;
      }
      const storageRef = optionalTrimmed(value.storageRef, 'record.storageRef', fail);
      if (storageRef !== null && storageRef.length > MAX_STORAGE_REF_LENGTH) {
        throw fail(
          `record.storageRef must be at most ${MAX_STORAGE_REF_LENGTH} characters (got ${storageRef.length})`,
        );
      }
      const checksum = optionalTrimmed(value.checksum, 'record.checksum', fail);
      if (checksum !== null && checksum.length > MAX_CHECKSUM_LENGTH) {
        throw fail(
          `record.checksum must be at most ${MAX_CHECKSUM_LENGTH} characters (got ${checksum.length})`,
        );
      }
      return {
        kind: 'artifact.available',
        providerRecordId: providerRecordId(),
        occurredAt: occurredAt(),
        providerMeetingId,
        providerSessionId,
        providerArtifactId,
        artifactKind: value.artifactKind,
        displayName,
        mediaType,
        byteSize,
        storageRef,
        checksum,
      };
    }

    case 'access.failed': {
      rejectUnknownKeys(value, ACCESS_FAILED_KEYS, 'record', fail);
      const providerMeetingId =
        value.providerMeetingId === undefined || value.providerMeetingId === null
          ? null
          : requirePrintable(
              value.providerMeetingId,
              'record.providerMeetingId',
              MAX_PROVIDER_MEETING_ID_LENGTH,
              fail,
            );
      if (!isMeetingAccessCode(value.accessCode)) {
        throw fail(
          `record.accessCode must be one of ${MEETING_ACCESS_CODES.join(', ')} (got '${String(value.accessCode)}')`,
        );
      }
      const detail = optionalTrimmed(value.detail, 'record.detail', fail);
      if (detail !== null && detail.length > MAX_DETAIL_LENGTH) {
        throw fail(
          `record.detail must be at most ${MAX_DETAIL_LENGTH} characters (got ${detail.length})`,
        );
      }
      return {
        kind: 'access.failed',
        providerRecordId: providerRecordId(),
        occurredAt: occurredAt(),
        providerMeetingId,
        accessCode: value.accessCode,
        detail,
      };
    }

    default:
      throw fail(
        `record.kind must be one of meeting.updated, session.updated, transcript.available, artifact.available, access.failed (got '${String(value.kind)}')`,
      );
  }
}

/**
 * Validates a whole capture batch: bounded size, every record valid, and NO
 * duplicate provider record ids inside one batch (an ambiguous batch is
 * rejected outright rather than silently collapsed).
 */
export function validateRecordBatch(
  records: unknown,
  fail: (message: string) => MeetingsError,
): ValidatedMeetingRecord[] {
  if (!Array.isArray(records)) throw fail('records must be an array');
  if (records.length > MAX_BATCH_RECORDS) {
    throw fail(
      `records supports at most ${MAX_BATCH_RECORDS} entries per batch (got ${records.length})`,
    );
  }
  const validated: ValidatedMeetingRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of records.entries()) {
    const record = validateCanonicalMeetingRecord(entry, (message) =>
      fail(`records[${index}]: ${message}`),
    );
    if (seen.has(record.providerRecordId)) {
      throw fail(
        `records[${index}] duplicates provider record id '${record.providerRecordId}' within one batch`,
      );
    }
    seen.add(record.providerRecordId);
    // The observations contract caps evidence payloads (1 MiB); a canonical
    // record larger than that budget can never become evidence, so it is
    // rejected at the boundary with the canonical code instead of failing
    // mid-ingest. Large media belongs in object storage (W086 owns durable
    // artifact content) — referenced, never embedded.
    const serialized = JSON.stringify(record) ?? '';
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      throw fail(
        `records[${index}] exceeds the maximum capture payload of ${MAX_PAYLOAD_BYTES} bytes (${serialized.length}) — large content belongs in object storage, referenced by id`,
      );
    }
    validated.push(record);
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Fetch results / webhook parse results
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `MeetingFetchResult`. */
export interface ValidatedFetchResult {
  records: ValidatedMeetingRecord[];
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
  records: ValidatedMeetingRecord[];
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
// Pure capture logic
// ---------------------------------------------------------------------------

/**
 * Whether a completed poll should advance the connection's cursor: only
 * when the provider produced a NEW cursor (a null next cursor means
 * "nothing past this window"; an unchanged cursor means "already current").
 */
export function cursorAdvance(current: string | null, next: string | null): boolean {
  return next !== null && next !== current;
}
