// Implementation of the conversations module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at`/`created_at` come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`conversation_not_found` /
// `message_not_found`), including for identity references.
//
// W029 acceptance — "persist conversations/messages with actor/source/
// provenance and links to cognitive executions WITHOUT making conversations
// authoritative truth" — is carried by these deliberate properties, all
// tested:
//   1. the contract exposes create/read/list/link operations ONLY: there is
//      no update, no delete, no correction, no promotion operation — and no
//      operation that derives beliefs, goals, knowledge or observations from
//      transcript content. PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE
//      on all three tables (migrations 001/002 triggers), so even a caller
//      bypassing the service cannot rewrite what was said;
//   2. messages carry no confidence or truth metadata: incoming turns
//      become EVIDENCE only through the observations module (W004), which is
//      deliberately NOT imported here (W029's declared dependency is W002
//      only, per the work-item DAG) — recording that evidence is the channel
//      adapter / cognition path's job, never the transcript's;
//   3. execution links are OPAQUE references (execution_id) — this module
//      never reads, writes or validates cognition state (W013), and a link
//      grants no authority: a message does not become true, decided or
//      approved because an execution touched it (lock 10, ADR-0014);
//   4. actor attribution goes through the W002 contracts: a `person`
//      attribution requires either an existing people.persons record or a
//      channel identity that is verified AND subject-linked (ADR-0003,
//      lock 15 — unverified accounts stay `external` and can never become
//      pseudo-employees);
//   5. `recordedAt` is minted by the service clock and caller-supplied
//      `id`/`tenantId`/`recordedAt`/`createdBy` fields are rejected at
//      validation;
//   6. outbound messages are recorded as what was actually sent — the
//      communication-policy decision (W009 authority matrix) happens before
//      this module is called; the transcript is a channel, not a decision
//      authority.
//
// Idempotency: (tenant, channel, providerMessageId) redelivery replays the
// original message (first write wins, like the events module's idempotency
// keys), and execution links are idempotent per (execution, role, target).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  getExternalIdentity,
  IdentityError,
  type ChannelProvider,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import { getPerson, PeopleError } from '@/modules/people/contract';
import { ConversationsError } from './errors';
import {
  assertConversationsTenantContext,
  escapeLikePattern,
  isUuid,
  validateCreateConversationInput,
  validateListConversationsQuery,
  validateListExecutionLinksQuery,
  validateListMessagesQuery,
  validateRecordExecutionLinkInput,
  validateRecordMessageInput,
  type ValidatedActorInput,
  type ValidatedCreateConversationInput,
  type ValidatedListConversationsQuery,
  type ValidatedListExecutionLinksQuery,
  type ValidatedListMessagesQuery,
  type ValidatedRecordExecutionLinkInput,
  type ValidatedRecordMessageInput,
} from './validation';
import type {
  Conversation,
  ConversationActorKind,
  CreateConversationInput,
  ExecutionLink,
  ExecutionLinkRole,
  ListConversationsQuery,
  ListExecutionLinksQuery,
  ListMessagesQuery,
  Message,
  MessageActor,
  MessageDirection,
  RecordExecutionLinkInput,
  RecordMessageInput,
} from './types';

interface ConversationRow extends DbRow {
  id: string;
  tenant_id: string;
  title: string | null;
  created_by: string;
  created_at: Date | string;
  message_count: number | string;
  last_message_at: Date | string | null;
}

interface MessageRow extends DbRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  direction: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  actor_identity_id: string | null;
  channel: string;
  provider_message_id: string | null;
  payload: unknown;
  sent_at: Date | string;
  recorded_at: Date | string;
}

interface ExecutionLinkRow extends DbRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string | null;
  execution_id: string;
  role: string;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toCount(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    messageCount: toCount(row.message_count),
    lastMessageAt: row.last_message_at === null ? null : toIso(row.last_message_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    direction: row.direction as MessageDirection, // CHECK-constrained by migration 001
    actor: {
      kind: row.actor_kind as ConversationActorKind, // CHECK-constrained by migration 001
      id: row.actor_id,
      label: row.actor_label,
      identityId: row.actor_identity_id,
    },
    channel: row.channel as ChannelProvider, // CHECK-constrained by migration 001
    payload: row.payload,
    sentAt: toIso(row.sent_at),
    recordedAt: toIso(row.recorded_at),
    providerMessageId: row.provider_message_id,
  };
}

function mapExecutionLink(row: ExecutionLinkRow): ExecutionLink {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    executionId: row.execution_id,
    role: row.role as ExecutionLinkRole, // CHECK-constrained by migration 002
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// Actor resolution — W002 through the identity/people contracts only
// (never their tables; ADR-0003, lock 15).
// ---------------------------------------------------------------------------

/** Loads an external identity through the identity contract; missing/foreign → uniform `invalid_provenance`. */
async function loadIdentityRef(
  ctx: TenantContext,
  identityId: string,
): Promise<ExternalIdentity> {
  try {
    return await getExternalIdentity(ctx, identityId);
  } catch (error) {
    if (error instanceof IdentityError && error.code === 'identity_not_found') {
      throw new ConversationsError(
        'invalid_provenance',
        `the referenced channel identity is not available in this tenant (identity '${identityId}')`,
      );
    }
    throw error;
  }
}

/**
 * Resolves a validated actor input into the persisted attribution shape.
 *
 * - `person` + personId      — the person record must exist (people
 *   contract, tenant-scoped; foreign/missing → uniform `invalid_provenance`);
 * - `person` + identityId    — the channel identity must be `verified` AND
 *   linked to a person subject; the subject id becomes the actor id
 *   (ADR-0003; otherwise `identity_not_resolved` — lock 15: no
 *   pseudo-employees);
 * - `agent`                  — opaque id/label (agents module is W021+);
 * - `system`                 — label (already validated as required);
 * - `external`               — an optional raw channel identity (any
 *   verification status — the transcript records the account as external)
 *   and/or a label.
 */
async function resolveActor(ctx: TenantContext, actor: ValidatedActorInput): Promise<MessageActor> {
  switch (actor.kind) {
    case 'person': {
      if (actor.personId !== null) {
        try {
          await getPerson(ctx, actor.personId);
        } catch (error) {
          if (error instanceof PeopleError && error.code === 'person_not_found') {
            throw new ConversationsError(
              'invalid_provenance',
              `the referenced person is not available in this tenant (person '${actor.personId}')`,
            );
          }
          throw error;
        }
        return { kind: 'person', id: actor.personId, label: actor.label, identityId: null };
      }
      const identity = await loadIdentityRef(ctx, actor.externalIdentityId!);
      if (identity.status !== 'verified' || identity.subjectId === null || identity.subjectKind !== 'person') {
        throw new ConversationsError(
          'identity_not_resolved',
          `channel identity '${identity.id}' does not resolve to a verified person subject — ` +
            'attribution to a person requires a verified, linked identity (lock 15: no pseudo-employees)',
        );
      }
      return {
        kind: 'person',
        id: identity.subjectId,
        label: actor.label ?? identity.displayName,
        identityId: identity.id,
      };
    }
    case 'agent': {
      return { kind: 'agent', id: actor.agentId, label: actor.label, identityId: null };
    }
    case 'system': {
      return { kind: 'system', id: null, label: actor.label, identityId: null };
    }
    case 'external': {
      if (actor.externalIdentityId === null) {
        return { kind: 'external', id: null, label: actor.label, identityId: null };
      }
      const identity = await loadIdentityRef(ctx, actor.externalIdentityId);
      return {
        kind: 'external',
        id: null,
        label: actor.label ?? identity.displayName,
        identityId: identity.id,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** INSERT for a new conversation (title, creator, service clock). */
async function insertConversation(
  db: Queryable,
  ctx: TenantContext,
  valid: ValidatedCreateConversationInput,
): Promise<{ id: string; createdAt: Date }> {
  const at = now(); // one clock read: the stored and returned values agree exactly
  const inserted = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO conversations (tenant_id, title, created_by, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [ctx.tenantId, valid.title, ctx.principalId, at],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('conversation insert returned no row (internal invariant violation)');
  }
  return { id: row.id, createdAt: row.created_at };
}

export async function createConversation(
  ctx: TenantContext,
  input: CreateConversationInput,
): Promise<Conversation> {
  assertConversationsTenantContext(ctx);
  const valid: ValidatedCreateConversationInput = validateCreateConversationInput(input);
  const created = await insertConversation(getDb(), ctx, valid);
  return {
    id: created.id,
    tenantId: ctx.tenantId,
    title: valid.title,
    createdBy: ctx.principalId,
    createdAt: toIso(created.createdAt),
    messageCount: 0,
    lastMessageAt: null,
  };
}

export async function getConversation(
  ctx: TenantContext,
  conversationId: string,
): Promise<Conversation> {
  assertConversationsTenantContext(ctx);
  if (!isUuid(conversationId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new ConversationsError(
      'conversation_not_found',
      `conversation '${conversationId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ConversationRow>(
    `SELECT c.id, c.tenant_id, c.title, c.created_by, c.created_at,
       (SELECT count(*) FROM conversation_messages m
          WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id) AS message_count,
       (SELECT max(m.sent_at) FROM conversation_messages m
          WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id) AS last_message_at
     FROM conversations c
     WHERE c.tenant_id = $1 AND c.id = $2`,
    [ctx.tenantId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ConversationsError(
      'conversation_not_found',
      `conversation '${conversationId}' does not exist in this tenant`,
    );
  }
  return mapConversation(row);
}

export async function listConversations(
  ctx: TenantContext,
  query: ListConversationsQuery,
): Promise<Conversation[]> {
  assertConversationsTenantContext(ctx);
  const valid: ValidatedListConversationsQuery = validateListConversationsQuery(query);

  const conditions: string[] = ['c.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.titleContains !== null) {
    add(`c.title ILIKE $# ESCAPE '\\'`, `%${escapeLikePattern(valid.titleContains)}%`);
  }
  if (valid.participantPersonId !== null) {
    // A participant is a person who SENT at least one message in the thread.
    add(
      `EXISTS (
         SELECT 1 FROM conversation_messages p
           WHERE p.tenant_id = c.tenant_id AND p.conversation_id = c.id
             AND p.actor_kind = 'person' AND p.actor_id = $#
       )`,
      valid.participantPersonId,
    );
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ConversationRow>(
    `SELECT c.id, c.tenant_id, c.title, c.created_by, c.created_at,
       count(m.id) AS message_count, max(m.sent_at) AS last_message_at
     FROM conversations c
     LEFT JOIN conversation_messages m
       ON m.tenant_id = c.tenant_id AND m.conversation_id = c.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY c.id, c.tenant_id, c.title, c.created_by, c.created_at
     ORDER BY COALESCE(max(m.sent_at), c.created_at) DESC, c.id DESC
     LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapConversation(row));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Finds a message by its provider dedupe key (tenant + channel + provider id). */
async function findProviderMessage(
  db: Queryable,
  ctx: TenantContext,
  channel: string,
  providerMessageId: string,
): Promise<MessageRow | null> {
  const result = await db.query<MessageRow>(
    `SELECT * FROM conversation_messages
       WHERE tenant_id = $1 AND channel = $2 AND provider_message_id = $3`,
    [ctx.tenantId, channel, providerMessageId],
  );
  return result.rows[0] ?? null;
}

export async function recordMessage(
  ctx: TenantContext,
  input: RecordMessageInput,
): Promise<Message> {
  assertConversationsTenantContext(ctx);
  const valid: ValidatedRecordMessageInput = validateRecordMessageInput(input);
  const actor: MessageActor = await resolveActor(ctx, valid.actor);
  const recordedAt = now();
  const db = getDb();

  // Idempotent fast path: a redelivered provider message replays the
  // originally recorded turn (first write wins) — before any conversation
  // is created.
  if (valid.providerMessageId !== null) {
    const existing = await findProviderMessage(db, ctx, valid.channel, valid.providerMessageId);
    if (existing !== null) return mapMessage(existing);
  }

  return db.transaction(async (tx) => {
    let conversationId: string;
    if (valid.conversationId !== null) {
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.conversationId],
      );
      if (found.rows[0] === undefined) {
        // Cross-tenant conversations are indistinguishable from missing ones.
        throw new ConversationsError(
          'conversation_not_found',
          `conversation '${valid.conversationId}' does not exist in this tenant`,
        );
      }
      conversationId = valid.conversationId;
    } else {
      conversationId = (await insertConversation(tx, ctx, { title: valid.conversationTitle })).id;
    }

    const inserted = await tx.query<MessageRow>(
      `INSERT INTO conversation_messages (
         tenant_id, conversation_id, direction,
         actor_kind, actor_id, actor_label, actor_identity_id,
         channel, provider_message_id, payload, sent_at, recorded_at
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6, $7,
         $8, $9, $10, $11::timestamptz, $12::timestamptz
       )
       ON CONFLICT (tenant_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        conversationId,
        valid.direction,
        actor.kind,
        actor.id,
        actor.label,
        actor.identityId,
        valid.channel,
        valid.providerMessageId,
        JSON.stringify(valid.payload),
        new Date(valid.sentAt),
        recordedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return mapMessage(row);

    // ON CONFLICT swallowed the insert: a redelivery won the race between
    // the fast path and the INSERT — replay its turn. (The auto-created
    // conversation, if any, stays as a harmless empty thread.)
    if (valid.providerMessageId !== null) {
      const winner = await findProviderMessage(tx, ctx, valid.channel, valid.providerMessageId);
      if (winner !== null) return mapMessage(winner);
    }
    throw new Error(
      'message insert returned no row without a provider-message conflict (internal invariant violation)',
    );
  });
}

export async function getMessage(ctx: TenantContext, messageId: string): Promise<Message> {
  assertConversationsTenantContext(ctx);
  if (!isUuid(messageId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new ConversationsError(
      'message_not_found',
      `message '${messageId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<MessageRow>(
    `SELECT * FROM conversation_messages WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, messageId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ConversationsError(
      'message_not_found',
      `message '${messageId}' does not exist in this tenant`,
    );
  }
  return mapMessage(row);
}

export async function listMessages(
  ctx: TenantContext,
  query: ListMessagesQuery,
): Promise<Message[]> {
  assertConversationsTenantContext(ctx);
  const valid: ValidatedListMessagesQuery = validateListMessagesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.conversationId !== null) add('conversation_id = $#', valid.conversationId);
  if (valid.channel !== null) add('channel = $#', valid.channel);
  if (valid.direction !== null) add('direction = $#', valid.direction);
  if (valid.actorKind !== null) {
    add('actor_kind = $#', valid.actorKind);
    if (valid.actorId !== null) add('actor_id = $#', valid.actorId);
  }
  if (valid.actorIdentityId !== null) add('actor_identity_id = $#', valid.actorIdentityId);
  if (valid.sentFrom !== null) add('sent_at >= $#', valid.sentFrom);
  if (valid.sentTo !== null) add('sent_at <= $#', valid.sentTo);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const direction = valid.order === 'desc' ? 'DESC' : 'ASC';
  const rows = await getDb().query<MessageRow>(
    `SELECT * FROM conversation_messages WHERE ${conditions.join(' AND ')}
       ORDER BY sent_at ${direction}, id ${direction} LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapMessage(row));
}

// ---------------------------------------------------------------------------
// Execution links
// ---------------------------------------------------------------------------

/** Finds an existing link by its idempotency key (execution + role + target shape). */
async function findEquivalentLink(
  db: Queryable,
  ctx: TenantContext,
  valid: ValidatedRecordExecutionLinkInput,
): Promise<ExecutionLinkRow | null> {
  const sql =
    valid.messageId !== null
      ? `SELECT * FROM conversation_execution_links
           WHERE tenant_id = $1 AND execution_id = $2 AND role = $3 AND message_id = $4`
      : `SELECT * FROM conversation_execution_links
           WHERE tenant_id = $1 AND execution_id = $2 AND role = $3
             AND conversation_id = $4 AND message_id IS NULL`;
  const target = valid.messageId ?? valid.conversationId;
  const result = await db.query<ExecutionLinkRow>(sql, [
    ctx.tenantId,
    valid.executionId,
    valid.role,
    target,
  ]);
  return result.rows[0] ?? null;
}

export async function recordExecutionLink(
  ctx: TenantContext,
  input: RecordExecutionLinkInput,
): Promise<ExecutionLink> {
  assertConversationsTenantContext(ctx);
  const valid: ValidatedRecordExecutionLinkInput = validateRecordExecutionLinkInput(input);
  const db = getDb();

  // Idempotent fast path: re-recording an identical link replays the
  // original row — adapters and the orchestrator may retry.
  const existing = await findEquivalentLink(db, ctx, valid);
  if (existing !== null) return mapExecutionLink(existing);

  return db.transaction(async (tx) => {
    let conversationId: string;
    if (valid.messageId !== null) {
      const found = await tx.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM conversation_messages WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.messageId],
      );
      const row = found.rows[0];
      if (row === undefined) {
        // Cross-tenant messages are indistinguishable from missing ones.
        throw new ConversationsError(
          'message_not_found',
          `message '${valid.messageId}' does not exist in this tenant`,
        );
      }
      conversationId = row.conversation_id; // the message's own conversation
    } else {
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.conversationId],
      );
      if (found.rows[0] === undefined) {
        throw new ConversationsError(
          'conversation_not_found',
          `conversation '${valid.conversationId}' does not exist in this tenant`,
        );
      }
      conversationId = valid.conversationId!;
    }

    // Conflict target matches the target shape's partial unique index.
    const conflictTarget =
      valid.messageId !== null
        ? `(tenant_id, execution_id, role, message_id) WHERE message_id IS NOT NULL`
        : `(tenant_id, execution_id, role, conversation_id) WHERE message_id IS NULL`;
    const inserted = await tx.query<ExecutionLinkRow>(
      `INSERT INTO conversation_execution_links (
         tenant_id, conversation_id, message_id, execution_id, role, recorded_by, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ${conflictTarget} DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        conversationId,
        valid.messageId,
        valid.executionId,
        valid.role,
        ctx.principalId,
        now(),
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return mapExecutionLink(row);

    // A concurrent identical link won the race — replay it.
    const winner = await findEquivalentLink(tx, ctx, valid);
    if (winner !== null) return mapExecutionLink(winner);
    throw new Error(
      'execution link insert returned no row without an idempotency conflict (internal invariant violation)',
    );
  });
}

export async function listExecutionLinks(
  ctx: TenantContext,
  query: ListExecutionLinksQuery,
): Promise<ExecutionLink[]> {
  assertConversationsTenantContext(ctx);
  const valid: ValidatedListExecutionLinksQuery = validateListExecutionLinksQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.conversationId !== null) add('conversation_id = $#', valid.conversationId);
  if (valid.messageId !== null) add('message_id = $#', valid.messageId);
  if (valid.executionId !== null) add('execution_id = $#', valid.executionId);
  if (valid.role !== null) add('role = $#', valid.role);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ExecutionLinkRow>(
    `SELECT * FROM conversation_execution_links WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at ASC, id ASC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapExecutionLink(row));
}
