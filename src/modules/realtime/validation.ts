// Pure validation/normalization logic of the realtime module (no database,
// no clock, no network). Everything a caller, an adapter or a transport may
// put into the realtime path crosses these guards first; the SQL CHECK
// constraints in migrations/ mirror the load-bearing rules as defense in
// depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `status` or credential VALUES into a session/participant/
// event — registry identity, tenancy and commit times are minted by the
// system, and secrets never enter domain tables at all
// (IMPLEMENTATION-STACK §8).
//
// Adapter output is re-validated here (defense in depth): the
// provider-native envelope exists only inside `adapters/`, and its
// canonicalized output must still pass the canonical contract before
// anything reaches the registry — a buggy adapter cannot smuggle provider
// shapes past the boundary (lock 16), and neither can a misbehaving
// transport.

import type { TenantContext } from '@/infra/tenant';
import { RealtimeError } from './errors';
import type {
  CanonicalRealtimeEvent,
  DialRealtimeParticipantInput,
  ListRealtimeArtifactsQuery,
  ListRealtimeConnectionsQuery,
  ListRealtimeEventsQuery,
  ListRealtimeParticipantsQuery,
  ListRealtimeResponsesQuery,
  ListRealtimeSessionsQuery,
  ListRealtimeTurnsQuery,
  RealtimeAuthKind,
  RealtimeConnectionStatus,
  RealtimeConsentState,
  RealtimeEndedReason,
  RealtimeEventKind,
  RealtimeFailureCode,
  RealtimeParticipantRole,
  RealtimeProvider,
  RealtimeRecordingState,
  RealtimeSessionKind,
  RealtimeSessionStatus,
  RecordRealtimeConsentInput,
  RegisterRealtimeConnectionInput,
  ReceiveRealtimeEventInput,
  SpeakRealtimeResponseInput,
  StartRealtimeSessionInput,
  StopRealtimeSessionInput,
} from './types';

/** Canonical realtime-transport vocabulary (mirrored by migration CHECKs and the adapter registry). */
export const REALTIME_PROVIDERS = ['livekit', 'openai-realtime'] as const;

export const REALTIME_SESSION_KINDS = [
  'aurum_voice',
  'meeting_participation',
  'meeting_companion',
  'telephony',
] as const;

export const REALTIME_SESSION_STATUSES = ['requested', 'live', 'ended', 'failed'] as const;
export const REALTIME_ENDED_REASONS = [
  'caller_stopped',
  'provider_ended',
  'last_participant_left',
] as const;
export const REALTIME_RECORDING_STATES = ['off', 'recording', 'recorded'] as const;
export const REALTIME_FAILURE_CODES = [
  'provider_unavailable',
  'transport_failed',
  'dial_failed',
  'room_unavailable',
  'agent_disconnected',
  'provider_error',
] as const;
export const REALTIME_PARTICIPANT_ROLES = ['human', 'aurum', 'phone'] as const;
export const REALTIME_CONSENT_STATES = ['pending', 'granted', 'revoked'] as const;
export const REALTIME_CONNECTION_STATUSES = ['active', 'disabled'] as const;
export const REALTIME_AUTH_KINDS = ['api_key', 'oauth'] as const;
export const REALTIME_EVENT_KINDS = [
  'session.started',
  'session.ended',
  'session.failed',
  'participant.joined',
  'participant.left',
  'consent.granted',
  'consent.revoked',
  'transcript.final',
  'response.completed',
  'response.interrupted',
  'recording.started',
  'recording.stopped',
  'recording.blocked',
] as const;
export const REALTIME_RESPONSE_STATUSES = [
  'speaking',
  'completed',
  'interrupted',
  'failed',
] as const;
export const REALTIME_TURN_KINDS = ['human_speech', 'aurum_response'] as const;
export const REALTIME_ARTIFACT_KINDS = ['transcript', 'recording'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DETAIL_LENGTH = 2000;
export const MAX_TEXT_LENGTH = 8000;
export const MAX_PROVIDER_ID_LENGTH = 255;
export const MAX_PROVIDER_EVENT_ID_LENGTH = 255;
export const MAX_OAUTH_SCOPES = 32;
export const MAX_SCOPE_LENGTH = 255;
export const MAX_STORAGE_REF_LENGTH = 1024;
export const MAX_CHECKSUM_LENGTH = 255;
export const MAX_MEDIA_TYPE_LENGTH = 127;
export const MAX_BYTE_SIZE = 2_147_483_647; // signed 32-bit — matches the bigint CHECK in migrations/
export const MAX_EVENTS_PER_ENVELOPE = 200;
export const MAX_PAYLOAD_BYTES = 1_048_576; // mirrors the observations module's cap

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset — provider event times are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_ID_PATTERN = /^[\P{C}\s]+$/u;
const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isRealtimeProvider(value: unknown): value is RealtimeProvider {
  return (
    typeof value === 'string' && (REALTIME_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isRealtimeSessionKind(value: unknown): value is RealtimeSessionKind {
  return (
    typeof value === 'string' && (REALTIME_SESSION_KINDS as readonly string[]).includes(value)
  );
}

export function isRealtimeSessionStatus(value: unknown): value is RealtimeSessionStatus {
  return (
    typeof value === 'string' && (REALTIME_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isRealtimeEndedReason(value: unknown): value is RealtimeEndedReason {
  return (
    typeof value === 'string' && (REALTIME_ENDED_REASONS as readonly string[]).includes(value)
  );
}

export function isRealtimeRecordingState(value: unknown): value is RealtimeRecordingState {
  return (
    typeof value === 'string' &&
    (REALTIME_RECORDING_STATES as readonly string[]).includes(value)
  );
}

export function isRealtimeFailureCode(value: unknown): value is RealtimeFailureCode {
  return (
    typeof value === 'string' && (REALTIME_FAILURE_CODES as readonly string[]).includes(value)
  );
}

export function isRealtimeParticipantRole(value: unknown): value is RealtimeParticipantRole {
  return (
    typeof value === 'string' &&
    (REALTIME_PARTICIPANT_ROLES as readonly string[]).includes(value)
  );
}

export function isRealtimeConsentState(value: unknown): value is RealtimeConsentState {
  return (
    typeof value === 'string' &&
    (REALTIME_CONSENT_STATES as readonly string[]).includes(value)
  );
}

export function isRealtimeEventKind(value: unknown): value is RealtimeEventKind {
  return (
    typeof value === 'string' && (REALTIME_EVENT_KINDS as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_PATTERN.test(value);
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
  fail: (message: string) => RealtimeError,
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
  fail: (message: string) => RealtimeError,
): string {
  if (typeof value !== 'string') throw fail(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw fail(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(
  value: unknown,
  field: string,
  fail: (message: string) => RealtimeError,
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
  fail: (message: string) => RealtimeError,
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
  fail: (message: string) => RealtimeError,
): string {
  const text = requireString(value, field, fail);
  if (!UUID_PATTERN.test(text)) {
    throw fail(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function optionalUuid(
  value: unknown,
  field: string,
  fail: (message: string) => RealtimeError,
): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, field, fail);
}

function requireIsoInstant(
  value: unknown,
  field: string,
  fail: (message: string) => RealtimeError,
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
  fail: (message: string) => RealtimeError,
): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field, fail);
}

function requireLimit(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
  fail: (message: string) => RealtimeError,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw fail(`${field} must be an integer between 1 and ${max} (got ${String(value)})`);
  }
  return value;
}

function requireConfidence(
  value: unknown,
  field: string,
  fail: (message: string) => RealtimeError,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw fail(`${field} must be a number in [0, 1] (got ${String(value)})`);
  }
  return value;
}

function requireByteSize(
  value: unknown,
  field: string,
  fail: (message: string) => RealtimeError,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BYTE_SIZE) {
    throw fail(`${field} must be a non-negative integer ≤ ${MAX_BYTE_SIZE} (got ${String(value)})`);
  }
  return value;
}

function inputError(message: string): RealtimeError {
  return new RealtimeError('invalid_realtime_input', message);
}

function queryError(message: string): RealtimeError {
  return new RealtimeError('invalid_realtime_query', message);
}

function eventError(message: string): RealtimeError {
  return new RealtimeError('invalid_provider_payload', message);
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

export function assertRealtimeTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new RealtimeError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new RealtimeError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
}

// ---------------------------------------------------------------------------
// Connection registration / queries
// ---------------------------------------------------------------------------

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

export interface ValidatedRegisterConnectionInput {
  provider: RealtimeProvider;
  providerAccountId: string;
  displayName: string | null;
  authKind: RealtimeAuthKind;
  credentialRef: string;
  oauthScopes: string[];
  oauthExpiresAt: string | null;
}

export function validateRegisterConnectionInput(
  input: RegisterRealtimeConnectionInput,
): ValidatedRegisterConnectionInput {
  if (!isPlainObject(input)) throw inputError('connection input must be an object');
  rejectUnknownKeys(input, REGISTER_INPUT_KEYS, 'connection input', inputError);
  if (!isRealtimeProvider(input.provider)) {
    throw inputError(
      `provider must be one of ${REALTIME_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
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
  if (input.authKind !== 'api_key' && input.authKind !== 'oauth') {
    throw inputError(`authKind must be 'api_key' or 'oauth' (got '${String(input.authKind)}')`);
  }
  const credentialRef = requirePrintable(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
    inputError,
  );
  let oauthScopes: string[] = [];
  if (input.oauthScopes !== undefined && input.oauthScopes !== null) {
    if (!Array.isArray(input.oauthScopes)) {
      throw inputError('oauthScopes must be an array of strings when present');
    }
    if (input.oauthScopes.length > MAX_OAUTH_SCOPES) {
      throw inputError(`oauthScopes supports at most ${MAX_OAUTH_SCOPES} entries`);
    }
    oauthScopes = input.oauthScopes.map((scope, index) =>
      requirePrintable(
        scope,
        `oauthScopes[${index}]`,
        MAX_SCOPE_LENGTH,
        inputError,
      ),
    );
  }
  const oauthExpiresAt = optionalIsoInstant(input.oauthExpiresAt, 'oauthExpiresAt', inputError);
  if (input.authKind === 'api_key' && (oauthScopes.length > 0 || oauthExpiresAt !== null)) {
    throw inputError(
      'an api_key connection carries no OAuth state — oauthScopes and oauthExpiresAt must be empty',
    );
  }
  if (input.authKind === 'oauth' && oauthScopes.length === 0) {
    throw inputError('an oauth connection must declare at least one granted scope');
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

export interface ValidatedListConnectionsQuery {
  provider: RealtimeProvider | null;
  status: RealtimeConnectionStatus | null;
  limit: number;
}

export function validateListConnectionsQuery(
  query: ListRealtimeConnectionsQuery,
): ValidatedListConnectionsQuery {
  if (!isPlainObject(query)) throw queryError('connections query must be an object');
  rejectUnknownKeys(query, LIST_CONNECTIONS_QUERY_KEYS, 'connections query', queryError);
  let provider: RealtimeProvider | null = null;
  if (query.provider !== undefined && query.provider !== null) {
    if (!isRealtimeProvider(query.provider)) {
      throw queryError(
        `provider must be one of ${REALTIME_PROVIDERS.join(', ')} (got '${String(query.provider)}')`,
      );
    }
    provider = query.provider;
  }
  let status: RealtimeConnectionStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (query.status !== 'active' && query.status !== 'disabled') {
      throw queryError(`status must be 'active' or 'disabled' (got '${String(query.status)}')`);
    }
    status = query.status;
  }
  return {
    provider,
    status,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export interface ValidatedSetConnectionStatusInput {
  connectionId: string;
  status: RealtimeConnectionStatus;
}

export function validateSetConnectionStatusInput(
  input: { connectionId: string; status: RealtimeConnectionStatus },
): ValidatedSetConnectionStatusInput {
  if (!isPlainObject(input)) throw inputError('status input must be an object');
  rejectUnknownKeys(input, SET_STATUS_INPUT_KEYS, 'status input', inputError);
  return {
    connectionId: requireUuid(input.connectionId, 'connectionId', inputError),
    status: requireString(input.status, 'status', inputError) as RealtimeConnectionStatus,
  };
}

// ---------------------------------------------------------------------------
// Session start / stop / queries
// ---------------------------------------------------------------------------

const START_SESSION_KEYS = ['connectionId', 'kind', 'title', 'meetingSessionId', 'dial'] as const;
const DIAL_TARGET_KEYS = ['phoneNumber', 'displayName'] as const;
const STOP_SESSION_KEYS = ['sessionId'] as const;
const LIST_SESSIONS_KEYS = ['connectionId', 'kind', 'status', 'limit'] as const;

export interface ValidatedStartSessionInput {
  connectionId: string;
  kind: RealtimeSessionKind;
  title: string | null;
  meetingSessionId: string | null;
  dial: { phoneNumber: string; displayName: string | null } | null;
}

export function validateStartSessionInput(
  input: StartRealtimeSessionInput,
): ValidatedStartSessionInput {
  if (!isPlainObject(input)) throw inputError('session start input must be an object');
  rejectUnknownKeys(input, START_SESSION_KEYS, 'session start input', inputError);
  const connectionId = requireUuid(input.connectionId, 'connectionId', inputError);
  if (!isRealtimeSessionKind(input.kind)) {
    throw inputError(
      `kind must be one of ${REALTIME_SESSION_KINDS.join(', ')} (got '${String(input.kind)}')`,
    );
  }
  const title = optionalTrimmed(input.title, 'title', inputError);
  if (title !== null && title.length > MAX_TITLE_LENGTH) {
    throw inputError(`title must be at most ${MAX_TITLE_LENGTH} characters (got ${title.length})`);
  }
  const meetingSessionId = optionalUuid(input.meetingSessionId, 'meetingSessionId', inputError);
  if (
    (input.kind === 'aurum_voice' || input.kind === 'telephony') &&
    meetingSessionId !== null
  ) {
    throw inputError(
      `meetingSessionId is only meaningful for meeting_participation/meeting_companion sessions (kind '${input.kind}' carries none)`,
    );
  }
  let dial: { phoneNumber: string; displayName: string | null } | null = null;
  if (input.dial !== undefined && input.dial !== null) {
    if (!isPlainObject(input.dial)) throw inputError('dial must be an object when present');
    rejectUnknownKeys(input.dial, DIAL_TARGET_KEYS, 'dial', inputError);
    const phoneNumber = requireString(input.dial.phoneNumber, 'dial.phoneNumber', inputError);
    if (!E164_PATTERN.test(phoneNumber)) {
      throw inputError(
        `dial.phoneNumber must be an E.164 number like +15551234567 (got '${phoneNumber}')`,
      );
    }
    const displayName = optionalTrimmed(input.dial.displayName, 'dial.displayName', inputError);
    if (displayName !== null && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw inputError(
        `dial.displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${displayName.length})`,
      );
    }
    dial = { phoneNumber, displayName };
  }
  if (input.kind === 'telephony' && dial === null) {
    throw inputError('a telephony session requires a dial target (phoneNumber)');
  }
  if (input.kind !== 'telephony' && dial !== null) {
    throw inputError(
      `a dial target is only allowed for telephony sessions (kind '${input.kind}') — use dialRealtimeParticipant on a live session instead`,
    );
  }
  return { connectionId, kind: input.kind, title, meetingSessionId, dial };
}

export interface ValidatedStopSessionInput {
  sessionId: string;
}

export function validateStopSessionInput(
  input: StopRealtimeSessionInput,
): ValidatedStopSessionInput {
  if (!isPlainObject(input)) throw inputError('session stop input must be an object');
  rejectUnknownKeys(input, STOP_SESSION_KEYS, 'session stop input', inputError);
  return { sessionId: requireUuid(input.sessionId, 'sessionId', inputError) };
}

export interface ValidatedListSessionsQuery {
  connectionId: string | null;
  kind: RealtimeSessionKind | null;
  status: RealtimeSessionStatus | null;
  limit: number;
}

export function validateListSessionsQuery(
  query: ListRealtimeSessionsQuery,
): ValidatedListSessionsQuery {
  if (!isPlainObject(query)) throw queryError('sessions query must be an object');
  rejectUnknownKeys(query, LIST_SESSIONS_KEYS, 'sessions query', queryError);
  const connectionId = optionalUuid(query.connectionId, 'connectionId', queryError);
  let kind: RealtimeSessionKind | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isRealtimeSessionKind(query.kind)) {
      throw queryError(
        `kind must be one of ${REALTIME_SESSION_KINDS.join(', ')} (got '${String(query.kind)}')`,
      );
    }
    kind = query.kind;
  }
  let status: RealtimeSessionStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isRealtimeSessionStatus(query.status)) {
      throw queryError(
        `status must be one of ${REALTIME_SESSION_STATUSES.join(', ')} (got '${String(query.status)}')`,
      );
    }
    status = query.status;
  }
  return {
    connectionId,
    kind,
    status,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

// ---------------------------------------------------------------------------
// Participants / consent
// ---------------------------------------------------------------------------

const LIST_PARTICIPANTS_KEYS = ['sessionId', 'role', 'limit'] as const;
const RECORD_CONSENT_KEYS = ['sessionId', 'participantId', 'consent'] as const;

export interface ValidatedListParticipantsQuery {
  sessionId: string | null;
  role: RealtimeParticipantRole | null;
  limit: number;
}

export function validateListParticipantsQuery(
  query: ListRealtimeParticipantsQuery,
): ValidatedListParticipantsQuery {
  if (!isPlainObject(query)) throw queryError('participants query must be an object');
  rejectUnknownKeys(query, LIST_PARTICIPANTS_KEYS, 'participants query', queryError);
  const sessionId = optionalUuid(query.sessionId, 'sessionId', queryError);
  let role: RealtimeParticipantRole | null = null;
  if (query.role !== undefined && query.role !== null) {
    if (!isRealtimeParticipantRole(query.role)) {
      throw queryError(
        `role must be one of ${REALTIME_PARTICIPANT_ROLES.join(', ')} (got '${String(query.role)}')`,
      );
    }
    role = query.role;
  }
  return {
    sessionId,
    role,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export interface ValidatedRecordConsentInput {
  sessionId: string;
  participantId: string;
  consent: 'granted' | 'revoked';
}

export function validateRecordConsentInput(
  input: RecordRealtimeConsentInput,
): ValidatedRecordConsentInput {
  if (!isPlainObject(input)) throw inputError('consent input must be an object');
  rejectUnknownKeys(input, RECORD_CONSENT_KEYS, 'consent input', inputError);
  const sessionId = requireUuid(input.sessionId, 'sessionId', inputError);
  const participantId = requireUuid(input.participantId, 'participantId', inputError);
  if (input.consent !== 'granted' && input.consent !== 'revoked') {
    throw inputError(`consent must be 'granted' or 'revoked' (got '${String(input.consent)}')`);
  }
  return { sessionId, participantId, consent: input.consent };
}

// ---------------------------------------------------------------------------
// Recording / dial / speak
// ---------------------------------------------------------------------------

const SESSION_ONLY_KEYS = ['sessionId'] as const;

export interface ValidatedSessionRefInput {
  sessionId: string;
}

export function validateSessionRefInput(
  input: { sessionId: string },
  where: string,
): ValidatedSessionRefInput {
  if (!isPlainObject(input)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(input, SESSION_ONLY_KEYS, where, inputError);
  return { sessionId: requireUuid(input.sessionId, 'sessionId', inputError) };
}

const DIAL_INPUT_KEYS = ['sessionId', 'phoneNumber', 'displayName'] as const;

export interface ValidatedDialInput {
  sessionId: string;
  phoneNumber: string;
  displayName: string | null;
}

export function validateDialInput(input: DialRealtimeParticipantInput): ValidatedDialInput {
  if (!isPlainObject(input)) throw inputError('dial input must be an object');
  rejectUnknownKeys(input, DIAL_INPUT_KEYS, 'dial input', inputError);
  const sessionId = requireUuid(input.sessionId, 'sessionId', inputError);
  const phoneNumber = requireString(input.phoneNumber, 'phoneNumber', inputError);
  if (!E164_PATTERN.test(phoneNumber)) {
    throw inputError(
      `phoneNumber must be an E.164 number like +15551234567 (got '${phoneNumber}')`,
    );
  }
  const displayName = optionalTrimmed(input.displayName, 'displayName', inputError);
  if (displayName !== null && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw inputError(
      `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters (got ${displayName.length})`,
    );
  }
  return { sessionId, phoneNumber, displayName };
}

const SPEAK_INPUT_KEYS = ['sessionId', 'text', 'inReplyToTurnId'] as const;

export interface ValidatedSpeakInput {
  sessionId: string;
  text: string;
  inReplyToTurnId: string | null;
}

export function validateSpeakInput(input: SpeakRealtimeResponseInput): ValidatedSpeakInput {
  if (!isPlainObject(input)) throw inputError('speak input must be an object');
  rejectUnknownKeys(input, SPEAK_INPUT_KEYS, 'speak input', inputError);
  const sessionId = requireUuid(input.sessionId, 'sessionId', inputError);
  const text = requireString(input.text, 'text', inputError);
  if (text.length > MAX_TEXT_LENGTH) {
    throw inputError(`text must be at most ${MAX_TEXT_LENGTH} characters (got ${text.length})`);
  }
  const inReplyToTurnId = optionalUuid(input.inReplyToTurnId, 'inReplyToTurnId', inputError);
  return { sessionId, text, inReplyToTurnId };
}

// ---------------------------------------------------------------------------
// Turn / response / artifact / event queries
// ---------------------------------------------------------------------------

const LIST_TURNS_KEYS = ['sessionId', 'kind', 'limit'] as const;
const LIST_RESPONSES_KEYS = ['sessionId', 'status', 'limit'] as const;
const LIST_ARTIFACTS_KEYS = ['sessionId', 'kind', 'limit'] as const;
const LIST_EVENTS_KEYS = ['sessionId', 'kind', 'limit'] as const;

export interface ValidatedListTurnsQuery {
  sessionId: string;
  kind: 'human_speech' | 'aurum_response' | null;
  limit: number;
}

export function validateListTurnsQuery(query: ListRealtimeTurnsQuery): ValidatedListTurnsQuery {
  if (!isPlainObject(query)) throw queryError('turns query must be an object');
  rejectUnknownKeys(query, LIST_TURNS_KEYS, 'turns query', queryError);
  const sessionId = requireUuid(query.sessionId, 'sessionId', queryError);
  let kind: 'human_speech' | 'aurum_response' | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (query.kind !== 'human_speech' && query.kind !== 'aurum_response') {
      throw queryError(
        `kind must be 'human_speech' or 'aurum_response' (got '${String(query.kind)}')`,
      );
    }
    kind = query.kind;
  }
  return {
    sessionId,
    kind,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export interface ValidatedListResponsesQuery {
  sessionId: string;
  status: 'speaking' | 'completed' | 'interrupted' | 'failed' | null;
  limit: number;
}

export function validateListResponsesQuery(
  query: ListRealtimeResponsesQuery,
): ValidatedListResponsesQuery {
  if (!isPlainObject(query)) throw queryError('responses query must be an object');
  rejectUnknownKeys(query, LIST_RESPONSES_KEYS, 'responses query', queryError);
  const sessionId = requireUuid(query.sessionId, 'sessionId', queryError);
  let status: 'speaking' | 'completed' | 'interrupted' | 'failed' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!(REALTIME_RESPONSE_STATUSES as readonly string[]).includes(query.status)) {
      throw queryError(
        `status must be one of ${REALTIME_RESPONSE_STATUSES.join(', ')} (got '${String(query.status)}')`,
      );
    }
    status = query.status;
  }
  return {
    sessionId,
    status,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export interface ValidatedListArtifactsQuery {
  sessionId: string;
  kind: 'transcript' | 'recording' | null;
  limit: number;
}

export function validateListArtifactsQuery(
  query: ListRealtimeArtifactsQuery,
): ValidatedListArtifactsQuery {
  if (!isPlainObject(query)) throw queryError('artifacts query must be an object');
  rejectUnknownKeys(query, LIST_ARTIFACTS_KEYS, 'artifacts query', queryError);
  const sessionId = requireUuid(query.sessionId, 'sessionId', queryError);
  let kind: 'transcript' | 'recording' | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (query.kind !== 'transcript' && query.kind !== 'recording') {
      throw queryError(`kind must be 'transcript' or 'recording' (got '${String(query.kind)}')`);
    }
    kind = query.kind;
  }
  return {
    sessionId,
    kind,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

export interface ValidatedListEventsQuery {
  sessionId: string;
  kind: RealtimeEventKind | null;
  limit: number;
}

export function validateListEventsQuery(
  query: ListRealtimeEventsQuery,
): ValidatedListEventsQuery {
  if (!isPlainObject(query)) throw queryError('events query must be an object');
  rejectUnknownKeys(query, LIST_EVENTS_KEYS, 'events query', queryError);
  const sessionId = requireUuid(query.sessionId, 'sessionId', queryError);
  let kind: RealtimeEventKind | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isRealtimeEventKind(query.kind)) {
      throw queryError(
        `kind must be one of ${REALTIME_EVENT_KINDS.join(', ')} (got '${String(query.kind)}')`,
      );
    }
    kind = query.kind;
  }
  return {
    sessionId,
    kind,
    limit: requireLimit(query.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, queryError),
  };
}

// ---------------------------------------------------------------------------
// Provider event edge (receiveRealtimeEvent)
// ---------------------------------------------------------------------------

const RECEIVE_EVENT_KEYS = ['provider', 'payload'] as const;

export interface ValidatedReceiveEventInput {
  provider: RealtimeProvider;
  payload: unknown;
}

export function validateReceiveEventInput(
  input: ReceiveRealtimeEventInput,
): ValidatedReceiveEventInput {
  if (!isPlainObject(input)) throw inputError('event input must be an object');
  rejectUnknownKeys(input, RECEIVE_EVENT_KEYS, 'event input', inputError);
  if (!isRealtimeProvider(input.provider)) {
    throw inputError(
      `provider must be one of ${REALTIME_PROVIDERS.join(', ')} (got '${String(input.provider)}')`,
    );
  }
  if (input.payload === undefined || input.payload === null) {
    throw inputError('payload must carry the provider envelope');
  }
  return { provider: input.provider, payload: input.payload };
}

// ---------------------------------------------------------------------------
// Adapter output re-validation (defense in depth — the canonical events an
// adapter produced must pass the canonical contract before anything is
// applied; a buggy adapter cannot smuggle provider shapes past the seam)
// ---------------------------------------------------------------------------

const EVENT_KEYS_BY_KIND: Record<Exclude<RealtimeEventKind, 'recording.blocked'>, readonly string[]> = {
  'session.started': ['kind', 'providerEventId', 'occurredAt', 'providerRoomId'],
  'session.ended': ['kind', 'providerEventId', 'occurredAt', 'providerRoomId', 'reason', 'endedAt'],
  'session.failed': ['kind', 'providerEventId', 'occurredAt', 'providerRoomId', 'code', 'detail'],
  'participant.joined': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'providerParticipantId',
    'displayName',
    'email',
    'phone',
    'joinedAt',
  ],
  'participant.left': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'providerParticipantId',
    'leftAt',
  ],
  'consent.granted': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'providerParticipantId',
  ],
  'consent.revoked': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'providerParticipantId',
  ],
  'transcript.final': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'providerParticipantId',
    'speakerName',
    'startedAt',
    'endedAt',
    'text',
    'confidence',
  ],
  'response.completed': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'responseId',
    'completedAt',
  ],
  'response.interrupted': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'responseId',
    'interruptingProviderParticipantId',
    'interruptedAt',
  ],
  'recording.started': ['kind', 'providerEventId', 'occurredAt', 'providerRoomId'],
  'recording.stopped': [
    'kind',
    'providerEventId',
    'occurredAt',
    'providerRoomId',
    'artifact',
  ],
};

const RECORDING_ARTIFACT_KEYS = [
  'providerArtifactId',
  'storageRef',
  'mediaType',
  'byteSize',
  'checksum',
] as const;

/**
 * Fully validated + normalized form of `CanonicalRealtimeEvent` — the
 * discriminated union stays intact; each variant keeps its own shape
 * (the meetings module's ValidatedMeetingRecord discipline).
 */
export type ValidatedRealtimeEvent =
  | { kind: 'session.started'; providerEventId: string; occurredAt: string; providerRoomId: string }
  | {
      kind: 'session.ended';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      reason: 'provider_ended';
      endedAt: string;
    }
  | {
      kind: 'session.failed';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      code: RealtimeFailureCode;
      detail: string | null;
    }
  | {
      kind: 'participant.joined';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      providerParticipantId: string;
      displayName: string | null;
      email: string | null;
      phone: string | null;
      joinedAt: string;
    }
  | {
      kind: 'participant.left';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      providerParticipantId: string;
      leftAt: string;
    }
  | {
      kind: 'consent.granted';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      providerParticipantId: string;
    }
  | {
      kind: 'consent.revoked';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      providerParticipantId: string;
    }
  | {
      kind: 'transcript.final';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      providerParticipantId: string | null;
      speakerName: string | null;
      startedAt: string;
      endedAt: string | null;
      text: string;
      confidence: number | null;
    }
  | {
      kind: 'response.completed';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      responseId: string;
      completedAt: string;
    }
  | {
      kind: 'response.interrupted';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      responseId: string;
      interruptingProviderParticipantId: string | null;
      interruptedAt: string;
    }
  | {
      kind: 'recording.started';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
    }
  | {
      kind: 'recording.stopped';
      providerEventId: string;
      occurredAt: string;
      providerRoomId: string;
      artifact: {
        providerArtifactId: string;
        storageRef: string | null;
        mediaType: string | null;
        byteSize: number | null;
        checksum: string | null;
      } | null;
    };

/** Re-validates one canonical event an adapter produced (defense in depth). */
export function validateCanonicalEvent(input: unknown): ValidatedRealtimeEvent {
  if (!isPlainObject(input)) throw eventError('a canonical event must be an object');
  const event = input as Record<string, unknown>;
  const kind = event.kind;
  if (!isRealtimeEventKind(kind)) {
    throw eventError(`unknown canonical event kind '${String(kind)}'`);
  }
  // 'recording.blocked' is DOMAIN-ONLY (the consent gate mints it); an
  // adapter can never deliver it.
  if (kind === 'recording.blocked') {
    throw eventError(
      "'recording.blocked' is a domain-only ledger event — providers cannot deliver it",
    );
  }
  rejectUnknownKeys(event, EVENT_KEYS_BY_KIND[kind], `event '${kind}'`, eventError);
  const providerEventId = requirePrintable(
    event.providerEventId,
    `event '${kind}'.providerEventId`,
    MAX_PROVIDER_EVENT_ID_LENGTH,
    eventError,
  );
  const occurredAt = requireIsoInstant(event.occurredAt, `event '${kind}'.occurredAt`, eventError);
  const providerRoomId = requirePrintable(
    event.providerRoomId,
    `event '${kind}'.providerRoomId`,
    MAX_PROVIDER_ID_LENGTH,
    eventError,
  );
  const base = { providerEventId, occurredAt, providerRoomId };

  const requireEventPrintable = (field: string, max: number): string =>
    requirePrintable(event[field], `event '${kind}'.${field}`, max, eventError);
  const optionalEventPrintable = (field: string, max: number): string | null =>
    event[field] === undefined || event[field] === null
      ? null
      : requirePrintable(event[field], `event '${kind}'.${field}`, max, eventError);
  const optionalEventInstant = (field: string): string | null =>
    optionalIsoInstant(event[field], `event '${kind}'.${field}`, eventError);

  switch (kind) {
    case 'session.started':
      return { kind, ...base };
    case 'session.ended':
      if (event.reason !== 'provider_ended') {
        throw eventError(
          `event 'session.ended'.reason must be 'provider_ended' (got '${String(event.reason)}')`,
        );
      }
      return {
        kind,
        ...base,
        reason: 'provider_ended',
        endedAt: requireIsoInstant(event.endedAt, `event '${kind}'.endedAt`, eventError),
      };
    case 'session.failed':
      if (!isRealtimeFailureCode(event.code)) {
        throw eventError(
          `event 'session.failed'.code must be one of ${REALTIME_FAILURE_CODES.join(', ')} (got '${String(event.code)}')`,
        );
      }
      return { kind, ...base, code: event.code, detail: optionalEventPrintable('detail', MAX_DETAIL_LENGTH) };
    case 'participant.joined': {
      const email = optionalEventPrintable('email', 320);
      if (email !== null && !EMAIL_PATTERN.test(email)) {
        throw eventError(`event '${kind}'.email must be a valid address (got '${email}')`);
      }
      const phone = optionalEventPrintable('phone', 16);
      if (phone !== null && !E164_PATTERN.test(phone)) {
        throw eventError(
          `event '${kind}'.phone must be an E.164 number like +15551234567 (got '${phone}')`,
        );
      }
      return {
        kind,
        ...base,
        providerParticipantId: requireEventPrintable('providerParticipantId', MAX_PROVIDER_ID_LENGTH),
        displayName: optionalEventPrintable('displayName', MAX_DISPLAY_NAME_LENGTH),
        email,
        phone,
        joinedAt: requireIsoInstant(event.joinedAt, `event '${kind}'.joinedAt`, eventError),
      };
    }
    case 'participant.left':
      return {
        kind,
        ...base,
        providerParticipantId: requireEventPrintable('providerParticipantId', MAX_PROVIDER_ID_LENGTH),
        leftAt: requireIsoInstant(event.leftAt, `event '${kind}'.leftAt`, eventError),
      };
    case 'consent.granted':
    case 'consent.revoked':
      return {
        kind,
        ...base,
        providerParticipantId: requireEventPrintable('providerParticipantId', MAX_PROVIDER_ID_LENGTH),
      };
    case 'transcript.final': {
      const text = requireString(event.text, `event '${kind}'.text`, eventError);
      if (text.length > MAX_TEXT_LENGTH) {
        throw eventError(
          `event '${kind}'.text must be at most ${MAX_TEXT_LENGTH} characters (got ${text.length})`,
        );
      }
      return {
        kind,
        ...base,
        providerParticipantId:
          event.providerParticipantId === undefined || event.providerParticipantId === null
            ? null
            : requireEventPrintable('providerParticipantId', MAX_PROVIDER_ID_LENGTH),
        speakerName: optionalEventPrintable('speakerName', MAX_DISPLAY_NAME_LENGTH),
        startedAt: requireIsoInstant(event.startedAt, `event '${kind}'.startedAt`, eventError),
        endedAt: optionalEventInstant('endedAt'),
        text,
        confidence: requireConfidence(event.confidence, `event '${kind}'.confidence`, eventError),
      };
    }
    case 'response.completed':
      return {
        kind,
        ...base,
        responseId: requireUuid(event.responseId, `event '${kind}'.responseId`, eventError),
        completedAt: requireIsoInstant(event.completedAt, `event '${kind}'.completedAt`, eventError),
      };
    case 'response.interrupted':
      return {
        kind,
        ...base,
        responseId: requireUuid(event.responseId, `event '${kind}'.responseId`, eventError),
        interruptingProviderParticipantId:
          event.interruptingProviderParticipantId === undefined ||
          event.interruptingProviderParticipantId === null
            ? null
            : requireEventPrintable('interruptingProviderParticipantId', MAX_PROVIDER_ID_LENGTH),
        interruptedAt: requireIsoInstant(
          event.interruptedAt,
          `event '${kind}'.interruptedAt`,
          eventError,
        ),
      };
    case 'recording.started':
      return { kind, ...base };
    case 'recording.stopped': {
      const artifact = event.artifact;
      if (artifact === undefined || artifact === null) {
        return { kind, ...base, artifact: null };
      }
      if (!isPlainObject(artifact)) {
        throw eventError(`event '${kind}'.artifact must be an object when present`);
      }
      rejectUnknownKeys(artifact, RECORDING_ARTIFACT_KEYS, `event '${kind}'.artifact`, eventError);
      return {
        kind,
        ...base,
        artifact: {
          providerArtifactId: requirePrintable(
            artifact.providerArtifactId,
            `event '${kind}'.artifact.providerArtifactId`,
            MAX_PROVIDER_ID_LENGTH,
            eventError,
          ),
          storageRef:
            artifact.storageRef === undefined || artifact.storageRef === null
              ? null
              : requirePrintable(
                  artifact.storageRef,
                  `event '${kind}'.artifact.storageRef`,
                  MAX_STORAGE_REF_LENGTH,
                  eventError,
                ),
          mediaType:
            artifact.mediaType === undefined || artifact.mediaType === null
              ? null
              : requirePrintable(
                  artifact.mediaType,
                  `event '${kind}'.artifact.mediaType`,
                  MAX_MEDIA_TYPE_LENGTH,
                  eventError,
                ),
          byteSize: requireByteSize(
            artifact.byteSize,
            `event '${kind}'.artifact.byteSize`,
            eventError,
          ),
          checksum:
            artifact.checksum === undefined || artifact.checksum === null
              ? null
              : requirePrintable(
                  artifact.checksum,
                  `event '${kind}'.artifact.checksum`,
                  MAX_CHECKSUM_LENGTH,
                  eventError,
                ),
        },
      };
    }
  }
}

export interface ValidatedEventParseResult {
  providerAccountId: string;
  events: ValidatedRealtimeEvent[];
}

/** Re-validates an adapter's whole parse result (account + events). */
export function validateEventParseResult(result: {
  providerAccountId: string;
  events: CanonicalRealtimeEvent[];
}): ValidatedEventParseResult {
  if (!isPlainObject(result)) throw eventError('adapter parse result must be an object');
  if (!Array.isArray(result.events)) {
    throw eventError('adapter parse result.events must be an array');
  }
  if (result.events.length > MAX_EVENTS_PER_ENVELOPE) {
    throw eventError(
      `one envelope carries at most ${MAX_EVENTS_PER_ENVELOPE} events (got ${result.events.length})`,
    );
  }
  const providerAccountId = requirePrintable(
    result.providerAccountId,
    'parse result.providerAccountId',
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
    eventError,
  );
  const serialized = JSON.stringify(result.events);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    throw eventError(
      `events exceed the maximum event payload of ${MAX_PAYLOAD_BYTES} bytes (${serialized.length}) — large content belongs in object storage, referenced by id`,
    );
  }
  return { providerAccountId, events: result.events.map(validateCanonicalEvent) };
}
