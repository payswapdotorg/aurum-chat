// Pure validation/normalization logic of the channels module (no database,
// no adapters). Everything a caller may put into a channel connection,
// inbound envelope, outbound message or challenge request crosses these
// guards first; the SQL CHECK constraints in migrations/001 and /002 mirror
// the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `createdAt`, `updatedAt` or `createdBy` into a record call —
// the connection's identity, tenancy and commit time are minted by the
// system.
//
// Provider-specific normalization (E.164 phones, lowercase emails, provider
// webhook parsing) lives in `adapters/`, NOT here: validation is
// provider-neutral by construction, and adapter output is re-validated by
// `validateCanonicalInboundMessage` before anything is persisted (defense
// in depth — a buggy adapter cannot smuggle a malformed canonical event
// into the transcript).

import type { TenantContext } from '@/infra/tenant';
import { CHANNEL_PROVIDERS, isChannelProvider, type ChannelProvider } from '@/modules/identity/contract';
import { ChannelsError } from './errors';
import type {
  CanonicalAttachment,
  CanonicalAttachmentKind,
  CanonicalContent,
  CanonicalInboundMessage,
  CanonicalParty,
  ChannelConnectionStatus,
  CompleteChallengeInput,
  DeliverChallengeInput,
  ListChannelConnectionsQuery,
  ReceiveInboundInput,
  RegisterChannelConnectionInput,
  SendOutboundInput,
  SetChannelConnectionStatusInput,
} from './types';

/** Canonical connection statuses (mirrored by the `status` CHECK constraint). */
export const CHANNEL_CONNECTION_STATUSES = ['active', 'disabled'] as const;

/** Canonical attachment kinds (mirrored by adapter output validation). */
export const ATTACHMENT_KINDS = [
  'image',
  'audio',
  'video',
  'document',
  'location',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_TEXT_LENGTH = 16_384;
export const MAX_TRANSCRIPT_LENGTH = 16_384;
export const MAX_ATTACHMENT_REFERENCE_LENGTH = 2_048;
export const MAX_MIME_TYPE_LENGTH = 255;
export const MAX_CAPTION_LENGTH = 1_024;
export const MAX_ATTACHMENTS = 20;
export const MAX_PROVIDER_MESSAGE_ID_LENGTH = 255;
export const MAX_PROVIDER_THREAD_KEY_LENGTH = 512;
/** Canonical content must stay well under the conversations module's 1 MiB payload cap. */
export const MAX_CONTENT_BYTES = 262_144;
/** Raw provider webhook payloads are JSON, modest in size; big artifacts are referenced, not inlined. */
export const MAX_RAW_PAYLOAD_BYTES = 1_048_576;
/** Challenge ttl bounds mirror the identity module's (challenge.ts, W002). */
export const CHALLENGE_TTL_MIN_SECONDS = 30;
export const CHALLENGE_TTL_MAX_SECONDS = 86_400;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset — channel timestamps are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Opaque provider-minted strings — printable (no control characters, DEL
// included). Expressed with a Unicode property escape so no literal control
// character appears in the pattern source.
const PRINTABLE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const REGISTER_CONNECTION_KEYS = ['provider', 'providerAccountId', 'displayName', 'credentialRef'] as const;
const LIST_CONNECTIONS_KEYS = ['provider', 'status', 'limit'] as const;
const SET_STATUS_KEYS = ['connectionId', 'status'] as const;
const RECEIVE_INBOUND_KEYS = ['provider', 'payload'] as const;
const PARTY_KEYS = ['providerAccountId', 'displayName'] as const;
const SEND_OUTBOUND_KEYS = ['provider', 'connectionId', 'to', 'content', 'subject', 'conversationId'] as const;
const DELIVER_CHALLENGE_KEYS = ['identityId', 'connectionId', 'ttlSeconds'] as const;
const COMPLETE_CHALLENGE_KEYS = ['identityId', 'code'] as const;
const CANONICAL_INBOUND_KEYS = [
  'provider',
  'providerAccountId',
  'displayName',
  'providerMessageId',
  'sentAt',
  'providerThreadKey',
  'threadTitle',
  'content',
] as const;

export function isChannelConnectionStatus(value: unknown): value is ChannelConnectionStatus {
  return (
    typeof value === 'string' &&
    (CHANNEL_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isCanonicalAttachmentKind(value: unknown): value is CanonicalAttachmentKind {
  return typeof value === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/** Structural check for CanonicalContent (shape + limits; used by callers and tests). */
export function isCanonicalContent(value: unknown): value is CanonicalContent {
  try {
    validateCanonicalContent(value);
    return true;
  } catch {
    return false;
  }
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertChannelsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ChannelsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ChannelsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ChannelsError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** Connection-id shape guard (uuid); malformed ids are simply "not found". */
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

function inputError(message: string): ChannelsError {
  return new ChannelsError('invalid_channel_input', message);
}

function queryError(message: string): ChannelsError {
  return new ChannelsError('invalid_channel_query', message);
}

/** Deep JSON check: only plain JSON values survive (see conversations/validation.ts). */
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

function requirePrintable(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
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

function optionalUuid(value: unknown, field: string): string | null {
  const text = optionalTrimmed(value, field);
  if (text === null) return null;
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid when present (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireIsoInstant(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw inputError(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${text}')`,
    );
  }
  return text;
}

function optionalIsoInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, field);
}

// ---------------------------------------------------------------------------
// Canonical content
// ---------------------------------------------------------------------------

function boundedOptionalText(value: unknown, field: string, maxLength: number): string | null {
  const text = optionalTrimmed(value, field);
  if (text !== null && text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

/**
 * Validates + normalizes CanonicalContent (trusted shape for everything that
 * reaches the transcript). Text and attachments are mutually optional but
 * not jointly: a contentless message is invalid.
 */
export function validateCanonicalContent(value: unknown): CanonicalContent {
  if (!isPlainObject(value)) {
    throw inputError('content must be an object');
  }
  rejectUnknownKeys(value, ['text', 'attachments'], 'content');

  const text = boundedOptionalText(value.text, 'content.text', MAX_TEXT_LENGTH);
  if (text === null && (value.attachments === undefined || value.attachments === null)) {
    throw inputError(
      'content requires a text or at least one attachment — a contentless message is invalid',
    );
  }

  let attachments: CanonicalAttachment[] = [];
  if (value.attachments !== undefined && value.attachments !== null) {
    if (!Array.isArray(value.attachments)) {
      throw inputError('content.attachments must be an array when present');
    }
    if (value.attachments.length > MAX_ATTACHMENTS) {
      throw inputError(
        `content.attachments must hold at most ${MAX_ATTACHMENTS} entries (got ${value.attachments.length})`,
      );
    }
    attachments = value.attachments.map((entry, index) =>
      validateCanonicalAttachment(entry, `content.attachments[${index}]`),
    );
  }

  if (text === null && attachments.length === 0) {
    throw inputError(
      'content requires a text or at least one attachment — a contentless message is invalid',
    );
  }

  const content: CanonicalContent = { text, attachments };
  const serializedLength = JSON.stringify(content)?.length ?? 0;
  if (serializedLength > MAX_CONTENT_BYTES) {
    throw inputError(
      `content exceeds the maximum of ${MAX_CONTENT_BYTES} bytes (${serializedLength}); large artifacts belong in object storage`,
    );
  }
  return content;
}

function validateCanonicalAttachment(value: unknown, where: string): CanonicalAttachment {
  if (!isPlainObject(value)) {
    throw inputError(`${where} must be an object`);
  }
  rejectUnknownKeys(value, ['kind', 'reference', 'mimeType', 'caption', 'transcript'], where);
  if (!isCanonicalAttachmentKind(value.kind)) {
    throw inputError(
      `${where}.kind must be one of ${ATTACHMENT_KINDS.join(', ')} (got '${String(value.kind)}')`,
    );
  }
  const reference = requirePrintable(value.reference, `${where}.reference`, MAX_ATTACHMENT_REFERENCE_LENGTH);
  const mimeType = boundedOptionalText(value.mimeType, `${where}.mimeType`, MAX_MIME_TYPE_LENGTH);
  const caption = boundedOptionalText(value.caption, `${where}.caption`, MAX_CAPTION_LENGTH);
  const transcript = boundedOptionalText(value.transcript, `${where}.transcript`, MAX_TRANSCRIPT_LENGTH);
  return { kind: value.kind, reference, mimeType, caption, transcript };
}

/** Validates + normalizes a canonical party (sender/recipient reference). */
export function validateCanonicalParty(value: unknown, where: string): CanonicalParty {
  if (!isPlainObject(value)) {
    throw inputError(`${where} must be an object`);
  }
  rejectUnknownKeys(value, PARTY_KEYS, where);
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
  return { providerAccountId, displayName };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RegisterChannelConnectionInput` (provider account id still raw — adapters normalize it). */
export interface ValidatedRegisterConnectionInput {
  provider: ChannelProvider;
  providerAccountId: string;
  displayName: string | null;
  credentialRef: string;
}

export function validateRegisterChannelConnectionInput(
  input: RegisterChannelConnectionInput,
): ValidatedRegisterConnectionInput {
  if (!isPlainObject(input)) {
    throw inputError('connection input must be an object');
  }
  rejectUnknownKeys(input, REGISTER_CONNECTION_KEYS, 'the connection input');
  if (!isChannelProvider(input.provider)) {
    throw inputError(
      `provider must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(input.provider)}')`,
    );
  }
  const providerAccountId = requirePrintable(
    input.providerAccountId,
    'providerAccountId',
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  );
  const displayName = boundedOptionalText(
    input.displayName,
    'displayName',
    MAX_DISPLAY_NAME_LENGTH,
  );
  const credentialRef = requirePrintable(
    input.credentialRef,
    'credentialRef',
    MAX_CREDENTIAL_REF_LENGTH,
  );
  return { provider: input.provider, providerAccountId, displayName, credentialRef };
}

/** Fully validated + normalized form of `ListChannelConnectionsQuery`. */
export interface ValidatedListConnectionsQuery {
  provider: ChannelProvider | null;
  status: ChannelConnectionStatus | null;
  limit: number;
}

export function validateListChannelConnectionsQuery(
  query: ListChannelConnectionsQuery,
): ValidatedListConnectionsQuery {
  if (!isPlainObject(query)) {
    throw queryError('query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_CONNECTIONS_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_CONNECTIONS_KEYS.join(', ')})`,
    );
  }
  const provider = query.provider === undefined ? null : query.provider;
  if (provider !== null && !isChannelProvider(provider)) {
    throw queryError(
      `query.provider must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(provider)}')`,
    );
  }
  const status = query.status === undefined ? null : query.status;
  if (status !== null && !isChannelConnectionStatus(status)) {
    throw queryError(
      `query.status must be one of ${CHANNEL_CONNECTION_STATUSES.join(', ')} (got '${String(status)}')`,
    );
  }
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(
      `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`,
    );
  }
  return { provider, status, limit };
}

/** Fully validated + normalized form of `SetChannelConnectionStatusInput`. */
export interface ValidatedSetStatusInput {
  connectionId: string;
  status: ChannelConnectionStatus;
}

export function validateSetChannelConnectionStatusInput(
  input: SetChannelConnectionStatusInput,
): ValidatedSetStatusInput {
  if (!isPlainObject(input)) {
    throw inputError('status input must be an object');
  }
  rejectUnknownKeys(input, SET_STATUS_KEYS, 'the status input');
  const connectionId = requireUuid(input.connectionId, 'connectionId');
  if (!isChannelConnectionStatus(input.status)) {
    throw inputError(
      `status must be one of ${CHANNEL_CONNECTION_STATUSES.join(', ')} (got '${String(input.status)}')`,
    );
  }
  return { connectionId, status: input.status };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `ReceiveInboundInput`. */
export interface ValidatedReceiveInboundInput {
  provider: ChannelProvider;
  payload: unknown;
}

export function validateReceiveInboundInput(
  input: ReceiveInboundInput,
): ValidatedReceiveInboundInput {
  if (!isPlainObject(input)) {
    throw inputError('inbound input must be an object');
  }
  rejectUnknownKeys(input, RECEIVE_INBOUND_KEYS, 'the inbound input');
  if (!isChannelProvider(input.provider)) {
    throw inputError(
      `provider must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(input.provider)}')`,
    );
  }
  if (!isPlainObject(input.payload)) {
    throw inputError(
      'payload must be a plain JSON object (the provider webhook envelope)',
    );
  }
  checkJsonValue(input.payload, 'payload', 0);
  const serializedLength = JSON.stringify(input.payload)?.length ?? 0;
  if (serializedLength > MAX_RAW_PAYLOAD_BYTES) {
    throw inputError(
      `payload exceeds the maximum of ${MAX_RAW_PAYLOAD_BYTES} bytes (${serializedLength}); large artifacts must be referenced, not inlined`,
    );
  }
  return { provider: input.provider, payload: input.payload };
}

/**
 * Validates + normalizes an adapter's canonical inbound output BEFORE
 * anything is persisted — a buggy adapter cannot smuggle a malformed
 * canonical event into the identity/conversations contracts (defense in
 * depth).
 */
export function validateCanonicalInboundMessage(value: unknown): CanonicalInboundMessage {
  if (!isPlainObject(value)) {
    throw new ChannelsError(
      'invalid_provider_payload',
      'adapter produced a non-object canonical message (internal invariant violation)',
    );
  }
  try {
    return validateCanonicalInboundMessageInner(value);
  } catch (error) {
    // The adapter-output path reports shape problems as provider-payload
    // problems (one uniform code), like the conversations module does for
    // actor inputs.
    if (error instanceof ChannelsError && error.code === 'invalid_channel_input') {
      throw new ChannelsError('invalid_provider_payload', error.message);
    }
    throw error;
  }
}

function validateCanonicalInboundMessageInner(
  value: Record<string, unknown>,
): CanonicalInboundMessage {
  rejectUnknownKeys(value, CANONICAL_INBOUND_KEYS, 'the canonical inbound message');
  if (!isChannelProvider(value.provider)) {
    throw new ChannelsError(
      'invalid_provider_payload',
      `adapter produced an unknown provider '${String(value.provider)}'`,
    );
  }
  const providerAccountId = requirePrintable(
    value.providerAccountId,
    'providerAccountId',
    MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  );
  const displayName = boundedOptionalText(
    value.displayName,
    'displayName',
    MAX_DISPLAY_NAME_LENGTH,
  );
  const providerMessageId = optionalPrintable(
    value.providerMessageId,
    'providerMessageId',
    MAX_PROVIDER_MESSAGE_ID_LENGTH,
  );
  const sentAt = optionalIsoInstant(value.sentAt, 'sentAt');
  const providerThreadKey = optionalPrintable(
    value.providerThreadKey,
    'providerThreadKey',
    MAX_PROVIDER_THREAD_KEY_LENGTH,
  );
  const threadTitle = boundedOptionalText(value.threadTitle, 'threadTitle', MAX_DISPLAY_NAME_LENGTH);
  const content = validateCanonicalContent(value.content);
  return {
    provider: value.provider,
    providerAccountId,
    displayName,
    providerMessageId,
    sentAt,
    providerThreadKey,
    threadTitle,
    content,
  };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `SendOutboundInput`. */
export interface ValidatedSendOutboundInput {
  provider: ChannelProvider;
  connectionId: string | null;
  to: CanonicalParty;
  content: CanonicalContent;
  subject: string | null;
  conversationId: string | null;
}

export function validateSendOutboundInput(input: SendOutboundInput): ValidatedSendOutboundInput {
  if (!isPlainObject(input)) {
    throw inputError('outbound input must be an object');
  }
  rejectUnknownKeys(input, SEND_OUTBOUND_KEYS, 'the outbound input');
  if (!isChannelProvider(input.provider)) {
    throw inputError(
      `provider must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(input.provider)}')`,
    );
  }
  const connectionId = optionalUuid(input.connectionId, 'connectionId');
  const to = validateCanonicalParty(input.to, 'to');
  const content = validateCanonicalContent(input.content);
  const subject = boundedOptionalText(input.subject, 'subject', MAX_SUBJECT_LENGTH);
  const conversationId = optionalUuid(input.conversationId, 'conversationId');
  return { provider: input.provider, connectionId, to, content, subject, conversationId };
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `DeliverChallengeInput`. */
export interface ValidatedDeliverChallengeInput {
  identityId: string;
  connectionId: string | null;
  ttlSeconds: number | null;
}

export function validateDeliverChallengeInput(
  input: DeliverChallengeInput,
): ValidatedDeliverChallengeInput {
  if (!isPlainObject(input)) {
    throw inputError('challenge delivery input must be an object');
  }
  rejectUnknownKeys(input, DELIVER_CHALLENGE_KEYS, 'the challenge delivery input');
  const identityId = requireUuid(input.identityId, 'identityId');
  const connectionId = optionalUuid(input.connectionId, 'connectionId');
  let ttlSeconds: number | null = null;
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null) {
    if (
      typeof input.ttlSeconds !== 'number' ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < CHALLENGE_TTL_MIN_SECONDS ||
      input.ttlSeconds > CHALLENGE_TTL_MAX_SECONDS
    ) {
      throw inputError(
        `ttlSeconds must be an integer in [${CHALLENGE_TTL_MIN_SECONDS}, ${CHALLENGE_TTL_MAX_SECONDS}] (got ${String(input.ttlSeconds)})`,
      );
    }
    ttlSeconds = input.ttlSeconds;
  }
  return { identityId, connectionId, ttlSeconds };
}

/** Fully validated + normalized form of `CompleteChallengeInput`. */
export interface ValidatedCompleteChallengeInput {
  identityId: string;
  code: string;
}

export function validateCompleteChallengeInput(
  input: CompleteChallengeInput,
): ValidatedCompleteChallengeInput {
  if (!isPlainObject(input)) {
    throw inputError('challenge completion input must be an object');
  }
  rejectUnknownKeys(input, COMPLETE_CHALLENGE_KEYS, 'the challenge completion input');
  const identityId = requireUuid(input.identityId, 'identityId');
  const code = requireString(input.code, 'code');
  return { identityId, code };
}

/** E.164 shape guard used by the phone-carrier adapters (shared rule). */
export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}
