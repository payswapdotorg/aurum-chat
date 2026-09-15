// Pure validation/normalization logic of the conversations module (no
// database). Everything a caller may put into a conversation, message or
// execution link crosses these guards first; the SQL CHECK constraints in
// migrations/001-conversations.sql and /002-execution-links.sql mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `recordedAt`, `createdBy` or `messageCount` into a record
// call — the transcript's identity, tenancy and commit time are minted by
// the system (part of the "conversations are not authoritative truth"
// acceptance: nothing outside the append path shapes a stored record).
//
// The channel vocabulary is owned by the identity module (W002, ADR-0015
// provider-neutral keys) and is imported from ITS contract — this module
// does not duplicate it.

import type { TenantContext } from '@/infra/tenant';
import { CHANNEL_PROVIDERS, isChannelProvider } from '@/modules/identity/contract';
import { ConversationsError } from './errors';
import type {
  ConversationActorKind,
  CreateConversationInput,
  ExecutionLinkRole,
  ListConversationsQuery,
  ListExecutionLinksQuery,
  ListMessagesQuery,
  MessageDirection,
  RecordExecutionLinkInput,
  RecordMessageInput,
} from './types';

/** Canonical actor kinds (mirrored by the `actor_kind` CHECK constraint). */
export const CONVERSATION_ACTOR_KINDS = [
  'person',
  'agent',
  'system',
  'external',
] as const;

/** Canonical message directions (mirrored by the `direction` CHECK constraint). */
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;

/** Canonical execution-link roles (mirrored by the `role` CHECK constraint). */
export const EXECUTION_LINK_ROLES = ['triggered', 'produced'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_TITLE_LENGTH = 200;
export const MAX_LABEL_LENGTH = 200;
export const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB — transcripts stay modest; large artifacts belong to object storage
export const MAX_PROVIDER_MESSAGE_ID_LENGTH = 255;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with an explicit offset — message timestamps are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Provider message ids are opaque provider-minted strings — printable (no
// control characters, DEL included), at most 255 characters. Expressed with
// a Unicode property escape so no literal control character appears in the
// pattern source.
const PROVIDER_MESSAGE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;

const CREATE_CONVERSATION_KEYS = ['title'] as const;
const RECORD_MESSAGE_KEYS = [
  'conversationId',
  'conversationTitle',
  'direction',
  'actor',
  'channel',
  'payload',
  'sentAt',
  'providerMessageId',
] as const;
const ACTOR_KEYS = ['kind', 'personId', 'externalIdentityId', 'id', 'label'] as const;
const LIST_MESSAGES_KEYS = [
  'conversationId',
  'channel',
  'direction',
  'actorKind',
  'actorId',
  'actorIdentityId',
  'sentFrom',
  'sentTo',
  'order',
  'limit',
] as const;
const LIST_CONVERSATIONS_KEYS = ['titleContains', 'participantPersonId', 'limit'] as const;
const RECORD_EXECUTION_LINK_KEYS = ['conversationId', 'messageId', 'executionId', 'role'] as const;
const LIST_EXECUTION_LINKS_KEYS = [
  'conversationId',
  'messageId',
  'executionId',
  'role',
  'limit',
] as const;

export function isConversationActorKind(value: unknown): value is ConversationActorKind {
  return (
    typeof value === 'string' &&
    (CONVERSATION_ACTOR_KINDS as readonly string[]).includes(value)
  );
}

export function isMessageDirection(value: unknown): value is MessageDirection {
  return typeof value === 'string' && (MESSAGE_DIRECTIONS as readonly string[]).includes(value);
}

export function isExecutionLinkRole(value: unknown): value is ExecutionLinkRole {
  return typeof value === 'string' && (EXECUTION_LINK_ROLES as readonly string[]).includes(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertConversationsTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ConversationsError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ConversationsError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ConversationsError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** Message/conversation-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Escapes ILIKE pattern metacharacters (`\`, `%`, `_`) so user text is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

function inputError(message: string): ConversationsError {
  return new ConversationsError('invalid_conversation_input', message);
}

function actorError(message: string): ConversationsError {
  return new ConversationsError('invalid_actor', message);
}

/**
 * Deep JSON check: only plain JSON values survive (strings, finite numbers,
 * booleans, null, arrays, plain objects). Functions, symbols, bigints,
 * undefined, class instances (Date, Map, …) and over-deep structures are
 * rejected, as is anything whose serialized form exceeds MAX_PAYLOAD_BYTES.
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

/** Fully validated + normalized form of `CreateConversationInput`. */
export interface ValidatedCreateConversationInput {
  title: string | null;
}

export function validateCreateConversationInput(
  input: CreateConversationInput,
): ValidatedCreateConversationInput {
  if (!isPlainObject(input)) {
    throw inputError('conversation input must be an object');
  }
  rejectUnknownKeys(input, CREATE_CONVERSATION_KEYS, 'the conversation input');
  const title = optionalTrimmed(input.title, 'title');
  if (title !== null && title.length > MAX_TITLE_LENGTH) {
    throw inputError(`title must be at most ${MAX_TITLE_LENGTH} characters (got ${title.length})`);
  }
  return { title };
}

/** Fully validated + normalized actor of `recordMessage`. */
export interface ValidatedActorInput {
  kind: ConversationActorKind;
  personId: string | null;
  externalIdentityId: string | null;
  agentId: string | null;
  label: string | null;
}

function validateLabel(value: unknown): string | null {
  const label = optionalTrimmed(value, 'actor.label');
  if (label !== null && label.length > MAX_LABEL_LENGTH) {
    throw inputError(`actor.label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return label;
}

function validateActor(value: unknown): ValidatedActorInput {
  if (!isPlainObject(value)) {
    throw actorError('actor must be an object');
  }
  rejectUnknownKeys(value, ACTOR_KEYS, 'actor');
  if (!isConversationActorKind(value.kind)) {
    throw actorError(
      `actor.kind must be one of ${CONVERSATION_ACTOR_KINDS.join(', ')} (got '${String(value.kind)}')`,
    );
  }
  const kind: ConversationActorKind = value.kind;

  // Fields of the OTHER kinds must never ride along.
  const personId = optionalUuid(value.personId, 'actor.personId');
  const externalIdentityId = optionalUuid(value.externalIdentityId, 'actor.externalIdentityId');
  const agentId = optionalUuid(value.id, 'actor.id');
  const label = validateLabel(value.label);

  switch (kind) {
    case 'person': {
      // Exactly one attribution path: a directory person, or a channel
      // identity the service resolves to its verified subject (ADR-0003).
      if (agentId !== null) {
        throw actorError("actor.id is reserved for kind 'agent'");
      }
      if (personId !== null && externalIdentityId !== null) {
        throw actorError(
          "actor kind 'person' accepts either personId or externalIdentityId, not both",
        );
      }
      if (personId === null && externalIdentityId === null) {
        throw actorError(
          "actor kind 'person' requires personId or externalIdentityId — attribution must be traceable",
        );
      }
      return { kind, personId, externalIdentityId, agentId: null, label };
    }
    case 'agent': {
      if (personId !== null || externalIdentityId !== null) {
        throw actorError(
          "actor kind 'agent' does not accept personId or externalIdentityId (agents act as themselves)",
        );
      }
      if (agentId === null && label === null) {
        throw actorError("actor kind 'agent' requires an id or a label — provenance must be traceable");
      }
      return { kind, personId: null, externalIdentityId: null, agentId, label };
    }
    case 'system': {
      if (personId !== null || externalIdentityId !== null || agentId !== null) {
        throw actorError(
          "actor kind 'system' is identified by its label alone (no person, identity or agent references)",
        );
      }
      if (label === null) {
        throw actorError("actor kind 'system' requires a label naming the subsystem");
      }
      return { kind, personId: null, externalIdentityId: null, agentId: null, label };
    }
    case 'external': {
      if (personId !== null || agentId !== null) {
        throw actorError(
          "actor kind 'external' does not accept personId or agent id — unverified accounts never become persons (lock 15)",
        );
      }
      if (externalIdentityId === null && label === null) {
        throw actorError(
          "actor kind 'external' requires an externalIdentityId or a label — provenance must be traceable",
        );
      }
      return { kind, personId: null, externalIdentityId, agentId: null, label };
    }
  }
}

/** Fully validated + normalized form of `RecordMessageInput`. */
export interface ValidatedRecordMessageInput {
  conversationId: string | null;
  conversationTitle: string | null;
  direction: MessageDirection;
  actor: ValidatedActorInput;
  channel: string;
  payload: unknown;
  sentAt: string;
  providerMessageId: string | null;
}

export function validateRecordMessageInput(
  input: RecordMessageInput,
): ValidatedRecordMessageInput {
  if (!isPlainObject(input)) {
    throw inputError('message input must be an object');
  }
  rejectUnknownKeys(input, RECORD_MESSAGE_KEYS, 'the message input');

  const conversationId = optionalUuid(input.conversationId, 'conversationId');
  const conversationTitle = optionalTrimmed(input.conversationTitle, 'conversationTitle');
  if (conversationTitle !== null && conversationTitle.length > MAX_TITLE_LENGTH) {
    throw inputError(
      `conversationTitle must be at most ${MAX_TITLE_LENGTH} characters (got ${conversationTitle.length})`,
    );
  }
  if (conversationId !== null && conversationTitle !== null) {
    throw inputError(
      'conversationTitle may only be set when recordMessage creates a new conversation (retitling is not a message concern)',
    );
  }

  if (!isMessageDirection(input.direction)) {
    throw inputError(
      `direction must be one of ${MESSAGE_DIRECTIONS.join(', ')} (got '${String(input.direction)}')`,
    );
  }
  const direction: MessageDirection = input.direction;

  // Actor-shape problems are `invalid_actor` uniformly (uuid/id/label
  // failures inside validateActor surface as invalid_conversation_input and
  // are remapped here — every actor-path error carries one code).
  let actor: ValidatedActorInput;
  try {
    actor = validateActor(input.actor);
  } catch (error) {
    if (error instanceof ConversationsError && error.code === 'invalid_conversation_input') {
      throw actorError(error.message);
    }
    throw error;
  }

  if (!isChannelProvider(input.channel)) {
    throw inputError(
      `channel must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(input.channel)}')`,
    );
  }

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

  const sentAt = requireIsoInstant(input.sentAt, 'sentAt');

  // The provider's own message id: when the caller supplies one, it must be
  // a non-empty printable string (a whitespace-only "id" is a caller bug,
  // not an absent id).
  let providerMessageId: string | null = null;
  if (input.providerMessageId !== undefined && input.providerMessageId !== null) {
    if (typeof input.providerMessageId !== 'string') {
      throw inputError('providerMessageId must be a string when present');
    }
    const trimmedProviderMessageId = input.providerMessageId.trim();
    if (trimmedProviderMessageId === '') {
      throw inputError('providerMessageId must be a non-empty string when present');
    }
    if (!PROVIDER_MESSAGE_ID_PATTERN.test(trimmedProviderMessageId)) {
      throw inputError(
        `providerMessageId must be 1..${MAX_PROVIDER_MESSAGE_ID_LENGTH} printable characters without ASCII control characters (got '${trimmedProviderMessageId}')`,
      );
    }
    providerMessageId = trimmedProviderMessageId;
  }

  // Direction/actor coherence (mirrored by the direction_actor_coherent
  // CHECK constraint): an external party never sends on the tenant's
  // outbound side; Aurum's own subsystems are never inbound senders.
  if (direction === 'outbound' && actor.kind === 'external') {
    throw actorError(
      "an 'external' actor cannot send on the outbound side of the tenant (ARCHITECTURE.md §9)",
    );
  }
  if (direction === 'inbound' && actor.kind === 'system') {
    throw actorError(
      "a 'system' actor is never an inbound sender — inbound turns come from outside the tenant's subsystems",
    );
  }

  return {
    conversationId,
    conversationTitle,
    direction,
    actor,
    channel: input.channel,
    payload: input.payload,
    sentAt,
    providerMessageId,
  };
}

/** Fully validated + normalized form of `ListMessagesQuery`. */
export interface ValidatedListMessagesQuery {
  conversationId: string | null;
  channel: string | null;
  direction: MessageDirection | null;
  actorKind: ConversationActorKind | null;
  actorId: string | null;
  actorIdentityId: string | null;
  sentFrom: Date | null;
  sentTo: Date | null;
  order: 'asc' | 'desc';
  limit: number;
}

function queryError(message: string): ConversationsError {
  return new ConversationsError('invalid_conversation_query', message);
}

export function validateListMessagesQuery(
  query: ListMessagesQuery,
): ValidatedListMessagesQuery {
  if (!isPlainObject(query)) {
    throw queryError('query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_MESSAGES_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_MESSAGES_KEYS.join(', ')})`,
    );
  }

  const conversationId =
    query.conversationId === undefined ? null : requireUuidQuery(query.conversationId, 'query.conversationId');

  const channel = query.channel === undefined ? null : query.channel;
  if (channel !== null && !isChannelProvider(channel)) {
    throw queryError(
      `query.channel must be one of the canonical providers (${CHANNEL_PROVIDERS.join(', ')}) (got '${String(channel)}')`,
    );
  }

  const direction = query.direction === undefined ? null : query.direction;
  if (direction !== null && !isMessageDirection(direction)) {
    throw queryError(
      `query.direction must be one of ${MESSAGE_DIRECTIONS.join(', ')} (got '${String(direction)}')`,
    );
  }

  const actorKind = query.actorKind === undefined ? null : query.actorKind;
  if (actorKind !== null && !isConversationActorKind(actorKind)) {
    throw queryError(
      `query.actorKind must be one of ${CONVERSATION_ACTOR_KINDS.join(', ')} (got '${String(actorKind)}')`,
    );
  }
  const actorId =
    query.actorId === undefined ? null : requireUuidQuery(query.actorId, 'query.actorId');
  if (actorId !== null && actorKind === null) {
    throw queryError(
      'query.actorId requires query.actorKind (an id is meaningless without its kind)',
    );
  }
  const actorIdentityId =
    query.actorIdentityId === undefined
      ? null
      : requireUuidQuery(query.actorIdentityId, 'query.actorIdentityId');

  const sentFrom =
    query.sentFrom === undefined
      ? null
      : requireIsoInstantQuery(query.sentFrom, 'query.sentFrom');
  const sentTo = query.sentTo === undefined ? null : requireIsoInstantQuery(query.sentTo, 'query.sentTo');
  if (sentFrom !== null && sentTo !== null && sentFrom > sentTo) {
    throw queryError('query.sentFrom must not be after query.sentTo');
  }

  const order = query.order === undefined ? 'asc' : query.order;
  if (order !== 'asc' && order !== 'desc') {
    throw queryError(`query.order must be 'asc' or 'desc' (got '${String(order)}')`);
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

  return {
    conversationId,
    channel,
    direction,
    actorKind,
    actorId,
    actorIdentityId,
    sentFrom: sentFrom === null ? null : new Date(sentFrom),
    sentTo: sentTo === null ? null : new Date(sentTo),
    order,
    limit,
  };
}

function requireUuidQuery(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw queryError(`${field} must be a uuid (got '${String(value)}')`);
  }
  return value.toLowerCase();
}

function requireIsoInstantQuery(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value : '';
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw queryError(
      `${field} must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z (got '${String(value)}')`,
    );
  }
  return text;
}

/** Fully validated + normalized form of `ListConversationsQuery`. */
export interface ValidatedListConversationsQuery {
  titleContains: string | null;
  participantPersonId: string | null;
  limit: number;
}

export function validateListConversationsQuery(
  query: ListConversationsQuery,
): ValidatedListConversationsQuery {
  if (!isPlainObject(query)) {
    throw queryError('query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_CONVERSATIONS_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_CONVERSATIONS_KEYS.join(', ')})`,
    );
  }
  const titleContainsRaw = query.titleContains;
  let titleContains: string | null = null;
  if (titleContainsRaw !== undefined && titleContainsRaw !== null) {
    if (typeof titleContainsRaw !== 'string') {
      throw queryError('query.titleContains must be a string when present');
    }
    const trimmed = titleContainsRaw.trim();
    if (trimmed === '') {
      throw queryError('query.titleContains must be a non-empty string when present');
    }
    titleContains = trimmed;
  }
  if (titleContains !== null && titleContains.length > MAX_TITLE_LENGTH) {
    throw queryError(
      `query.titleContains must be at most ${MAX_TITLE_LENGTH} characters (got ${titleContains.length})`,
    );
  }
  const participantPersonId =
    query.participantPersonId === undefined
      ? null
      : requireUuidQuery(query.participantPersonId, 'query.participantPersonId');
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
  return { titleContains, participantPersonId, limit };
}

/** Fully validated + normalized form of `RecordExecutionLinkInput`. */
export interface ValidatedRecordExecutionLinkInput {
  conversationId: string | null;
  messageId: string | null;
  executionId: string;
  role: ExecutionLinkRole;
}

export function validateRecordExecutionLinkInput(
  input: RecordExecutionLinkInput,
): ValidatedRecordExecutionLinkInput {
  try {
    return validateRecordExecutionLinkInputInner(input);
  } catch (error) {
    // uuid/id failures surface as invalid_conversation_input inside; for an
    // execution link the uniform code is invalid_execution_link.
    if (error instanceof ConversationsError && error.code === 'invalid_conversation_input') {
      throw new ConversationsError('invalid_execution_link', error.message);
    }
    throw error;
  }
}

function validateRecordExecutionLinkInputInner(
  input: RecordExecutionLinkInput,
): ValidatedRecordExecutionLinkInput {
  if (!isPlainObject(input)) {
    throw new ConversationsError('invalid_execution_link', 'execution link input must be an object');
  }
  rejectUnknownKeys(
    input,
    RECORD_EXECUTION_LINK_KEYS,
    'the execution link input',
  );
  const conversationId = optionalUuid(input.conversationId, 'conversationId');
  const messageId = optionalUuid(input.messageId, 'messageId');
  if (conversationId !== null && messageId !== null) {
    throw new ConversationsError(
      'invalid_execution_link',
      'an execution link targets either a conversation or a message, not both (a message implies its conversation)',
    );
  }
  if (conversationId === null && messageId === null) {
    throw new ConversationsError(
      'invalid_execution_link',
      'an execution link requires a conversationId or a messageId target',
    );
  }
  const executionId = requireUuid(input.executionId, 'executionId');
  if (!isExecutionLinkRole(input.role)) {
    throw new ConversationsError(
      'invalid_execution_link',
      `role must be one of ${EXECUTION_LINK_ROLES.join(', ')} (got '${String(input.role)}')`,
    );
  }
  const role: ExecutionLinkRole = input.role;
  if (role === 'produced' && messageId === null) {
    throw new ConversationsError(
      'invalid_execution_link',
      "role 'produced' requires a message target — an execution produces messages, not conversations",
    );
  }
  return { conversationId, messageId, executionId, role };
}

/** Fully validated + normalized form of `ListExecutionLinksQuery`. */
export interface ValidatedListExecutionLinksQuery {
  conversationId: string | null;
  messageId: string | null;
  executionId: string | null;
  role: ExecutionLinkRole | null;
  limit: number;
}

export function validateListExecutionLinksQuery(
  query: ListExecutionLinksQuery,
): ValidatedListExecutionLinksQuery {
  if (!isPlainObject(query)) {
    throw queryError('query must be an object');
  }
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_EXECUTION_LINKS_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_EXECUTION_LINKS_KEYS.join(', ')})`,
    );
  }
  const conversationId =
    query.conversationId === undefined ? null : requireUuidQuery(query.conversationId, 'query.conversationId');
  const messageId =
    query.messageId === undefined ? null : requireUuidQuery(query.messageId, 'query.messageId');
  const executionId =
    query.executionId === undefined ? null : requireUuidQuery(query.executionId, 'query.executionId');
  const role = query.role === undefined ? null : query.role;
  if (role !== null && !isExecutionLinkRole(role)) {
    throw queryError(
      `query.role must be one of ${EXECUTION_LINK_ROLES.join(', ')} (got '${String(role)}')`,
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
  return { conversationId, messageId, executionId, role, limit };
}
