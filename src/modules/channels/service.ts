// Implementation of the channels module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`connection_not_found`), including for identity and
// conversation references.
//
// W030 acceptance — "canonical adapters … preserve provider isolation" —
// is carried by these deliberate properties, all tested:
//   1. provider-native payloads exist ONLY inside `adapters/`: every
//      operation receives canonical inputs and persists canonical outputs;
//      adapter output is re-validated before it reaches the identity /
//      conversations contracts (a buggy adapter cannot smuggle provider
//      shapes past the boundary — lock 16 / ADR-0015);
//   2. inbound turns are registered on sight through the identity contract
//      (W002) and recorded through the conversations contract (W029) —
//      person attribution requires a verified, subject-linked identity
//      (lock 15); unverified senders stay `external`. Recording the
//      OBSERVATION is the cognition path's job (W013), which is NOT a
//      declared dependency of W030 (work-item DAG);
//   3. outbound turns are delivered through the provider-neutral transport
//      port BEFORE the transcript records them — the transcript records
//      what was ACTUALLY sent, never an unsent intent;
//   4. verification codes are credentials: they are embedded in the
//      provider-bound delivery and then never persisted — the transcript
//      turn is a `verification_code` turn whose payload carries only a
//      redaction reason (IMPLEMENTATION-STACK §8);
//   5. thread routing (`channel_threads`) is append-only: the first
//      canonical message observed on a provider thread fixes its
//      conversation; PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE
//      (migration 002 triggers);
//   6. connections are configuration, not evidence: the only mutable field
//      is `status`, and `credential_ref` is an opaque secret-store
//      reference — credential VALUES never reach any domain table.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  completeVerificationChallenge,
  getExternalIdentity,
  IdentityError,
  issueVerificationChallenge,
  registerExternalIdentity,
  type ChannelProvider,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import {
  ConversationsError,
  createConversation,
  getConversation,
  recordMessage,
  type Message,
} from '@/modules/conversations/contract';
import { getChannelAdapter } from './adapters';
import { ChannelsError } from './errors';
import {
  assertChannelsTenantContext,
  isUuid,
  validateCanonicalInboundMessage,
  validateCompleteChallengeInput,
  validateDeliverChallengeInput,
  validateListChannelConnectionsQuery,
  validateReceiveInboundInput,
  validateRegisterChannelConnectionInput,
  validateSendOutboundInput,
  validateSetChannelConnectionStatusInput,
  type ValidatedListConnectionsQuery,
  type ValidatedReceiveInboundInput,
  type ValidatedRegisterConnectionInput,
  type ValidatedSendOutboundInput,
} from './validation';
import type {
  CanonicalContent,
  CanonicalDeliveryRequest,
  CanonicalInboundMessage,
  CanonicalParty,
  CanonicalTranscriptPayload,
  ChannelConnection,
  ChannelConnectionStatus,
  ChannelTransport,
  ChallengeDeliveryResult,
  CompleteChallengeInput,
  DeliverChallengeInput,
  InboundResult,
  ListChannelConnectionsQuery,
  OutboundResult,
  ReceiveInboundInput,
  RegisterChannelConnectionInput,
  RegisterChannelConnectionResult,
  SendOutboundInput,
  SetChannelConnectionStatusInput,
  TransportReceipt,
} from './types';

interface ConnectionRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  display_name: string | null;
  credential_ref: string;
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapConnection(row: ConnectionRow): ChannelConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as ChannelProvider, // CHECK-constrained by migration 001
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    credentialRef: row.credential_ref,
    status: row.status as ChannelConnectionStatus, // CHECK-constrained by migration 001
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral; implementations live inside adapters/)
// ---------------------------------------------------------------------------

let channelTransport: ChannelTransport | null = null;

/**
 * Infrastructure wiring for the delivery port. Real transports (provider
 * SDKs / HTTP) are implemented inside `src/modules/channels/adapters/` and
 * wired once at process start; tests substitute a recording transport.
 * `null` restores the default "no provider available" state.
 */
export function setChannelTransport(transport: ChannelTransport | null): void {
  channelTransport = transport;
}

/** The currently wired transport (null when none — deliveries then fail `provider_unavailable`). */
export function getChannelTransport(): ChannelTransport | null {
  return channelTransport;
}

async function deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
  const transport = channelTransport;
  if (transport === null) {
    throw new ChannelsError(
      'provider_unavailable',
      `no channel transport is wired for provider '${request.provider}' (as provider availability permits — wire one via setChannelTransport)`,
    );
  }
  return transport.deliver(request);
}

function ensureReceiptShape(receipt: TransportReceipt, provider: string): TransportReceipt {
  const providerMessageId = receipt.providerMessageId;
  if (
    providerMessageId !== null &&
    (typeof providerMessageId !== 'string' ||
      providerMessageId.trim() === '' ||
      providerMessageId.length > 255 ||
      /[\p{Cc}]/u.test(providerMessageId))
  ) {
    throw new Error(
      `channel transport for '${provider}' returned a malformed provider message id (internal invariant violation)`,
    );
  }
  return receipt;
}

function throwForReceipt(receipt: TransportReceipt, provider: string): void {
  if (receipt.status === 'rejected') {
    throw new ChannelsError(
      'delivery_rejected',
      `the ${provider} transport refused the delivery${receipt.detail === null ? '' : `: ${receipt.detail}`}`,
    );
  }
  if (receipt.status === 'failed') {
    throw new ChannelsError(
      'delivery_failed',
      `the ${provider} transport failed to deliver${receipt.detail === null ? '' : `: ${receipt.detail}`} (transient — the caller may retry)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function registerChannelConnection(
  ctx: TenantContext,
  input: RegisterChannelConnectionInput,
): Promise<RegisterChannelConnectionResult> {
  assertChannelsTenantContext(ctx);
  const valid: ValidatedRegisterConnectionInput = validateRegisterChannelConnectionInput(input);
  const adapter = getChannelAdapter(valid.provider);
  const providerAccountId = adapter.normalizeAccountId(valid.providerAccountId);
  const at = now();
  const db = getDb();

  // ON CONFLICT DO NOTHING collapses duplicate registrations (re-registering
  // the same endpoint is idempotent; first registration wins).
  const inserted = await db.query<ConnectionRow>(
    `INSERT INTO channel_connections (
       tenant_id, provider, provider_account_id, display_name, credential_ref,
       created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (tenant_id, provider, provider_account_id) DO NOTHING
     RETURNING *`,
    [
      ctx.tenantId,
      valid.provider,
      providerAccountId,
      valid.displayName,
      valid.credentialRef,
      ctx.principalId,
      at,
    ],
  );
  const row = inserted.rows[0];
  if (row !== undefined) {
    return { connection: mapConnection(row), created: true };
  }
  const existing = await db.query<ConnectionRow>(
    `SELECT * FROM channel_connections
       WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, valid.provider, providerAccountId],
  );
  const winner = existing.rows[0];
  if (winner === undefined) {
    // Unreachable barring a delete path (none exists today); stay loud rather than wrong.
    throw new Error('channel connection disappeared after a duplicate-registration conflict');
  }
  return { connection: mapConnection(winner), created: false };
}

export async function getChannelConnection(
  ctx: TenantContext,
  connectionId: string,
): Promise<ChannelConnection> {
  assertChannelsTenantContext(ctx);
  if (!isUuid(connectionId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new ChannelsError(
      'connection_not_found',
      `channel connection '${connectionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM channel_connections WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, connectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ChannelsError(
      'connection_not_found',
      `channel connection '${connectionId}' does not exist in this tenant`,
    );
  }
  return mapConnection(row);
}

export async function listChannelConnections(
  ctx: TenantContext,
  query: ListChannelConnectionsQuery,
): Promise<ChannelConnection[]> {
  assertChannelsTenantContext(ctx);
  const valid: ValidatedListConnectionsQuery = validateListChannelConnectionsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<ConnectionRow>(
    `SELECT * FROM channel_connections WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapConnection(row));
}

export async function setChannelConnectionStatus(
  ctx: TenantContext,
  input: SetChannelConnectionStatusInput,
): Promise<ChannelConnection> {
  assertChannelsTenantContext(ctx);
  const valid = validateSetChannelConnectionStatusInput(input);
  // The only mutable field of a connection is its status (+ updated_at).
  const result = await getDb().query<ConnectionRow>(
    `UPDATE channel_connections SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.connectionId, valid.status, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant connections are indistinguishable from missing ones.
    throw new ChannelsError(
      'connection_not_found',
      `channel connection '${valid.connectionId}' does not exist in this tenant`,
    );
  }
  return mapConnection(row);
}

// ---------------------------------------------------------------------------
// Inbound — provider payload → canonical event → identity + transcript
// ---------------------------------------------------------------------------

/**
 * Actor attribution for an inbound turn (ADR-0003, lock 15): a `person`
 * attribution requires the carrying identity to be verified AND
 * subject-linked; every other state stays `external` — channel accounts
 * never become disconnected pseudo-employees.
 */
function actorFor(
  identity: ExternalIdentity,
  displayName: string | null,
): { kind: 'person' | 'external'; externalIdentityId: string; label: string } {
  const fallback = `${identity.provider}:${identity.providerAccountId}`.slice(0, 200);
  const identityLabel =
    identity.displayName !== null && identity.displayName.trim() !== ''
      ? identity.displayName.trim().slice(0, 200)
      : null;
  const label = displayName ?? identityLabel ?? fallback;
  if (identity.status === 'verified' && identity.subjectId !== null && identity.subjectKind === 'person') {
    return { kind: 'person', externalIdentityId: identity.id, label };
  }
  return { kind: 'external', externalIdentityId: identity.id, label };
}

/** Provider-neutral transcript payload of an inbound canonical message. */
function inboundTranscriptPayload(content: CanonicalContent): CanonicalTranscriptPayload {
  return { kind: 'message', content };
}

/**
 * Routes a provider thread to its conversation: the first canonical
 * message observed on the thread creates the conversation and the
 * append-only mapping; later messages reuse it (first mapping wins).
 */
async function resolveThread(
  ctx: TenantContext,
  provider: string,
  providerThreadKey: string,
  title: string | null,
): Promise<string> {
  const db = getDb();
  const existing = await db.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM channel_threads
       WHERE tenant_id = $1 AND provider = $2 AND provider_thread_key = $3`,
    [ctx.tenantId, provider, providerThreadKey],
  );
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].conversation_id;
  }

  const conversation = await createConversation(ctx, { title });
  const inserted = await db.query<{ conversation_id: string }>(
    `INSERT INTO channel_threads (
       tenant_id, provider, provider_thread_key, conversation_id, created_by, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, provider, provider_thread_key) DO NOTHING
     RETURNING conversation_id`,
    [ctx.tenantId, provider, providerThreadKey, conversation.id, ctx.principalId, now()],
  );
  if (inserted.rows[0] !== undefined) {
    return inserted.rows[0].conversation_id;
  }
  // A concurrent delivery of the same thread won the race — replay its
  // mapping. (The conversation we just created stays as a harmless empty
  // thread, mirroring the conversations module's own auto-create race.)
  const winner = await db.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM channel_threads
       WHERE tenant_id = $1 AND provider = $2 AND provider_thread_key = $3`,
    [ctx.tenantId, provider, providerThreadKey],
  );
  if (winner.rows[0] === undefined) {
    throw new Error(
      'channel thread mapping disappeared after an insert conflict (internal invariant violation)',
    );
  }
  return winner.rows[0].conversation_id;
}

/**
 * Records a transcript turn through the conversations contract, mapping the
 * module-boundary errors onto channels codes (another module's error class
 * never escapes this contract).
 */
async function recordTranscriptTurn(
  ctx: TenantContext,
  input: Parameters<typeof recordMessage>[1],
): Promise<Message> {
  try {
    return await recordMessage(ctx, input);
  } catch (error) {
    if (error instanceof ConversationsError) {
      if (error.code === 'conversation_not_found' || error.code === 'message_not_found') {
        throw new ChannelsError('conversation_not_found', error.message);
      }
      if (error.code === 'invalid_provenance' || error.code === 'identity_not_resolved') {
        throw new ChannelsError('invalid_provenance', error.message);
      }
      // Every other rejection contradicts a pre-validated canonical turn.
      throw new Error(
        `conversation transcript rejected a canonical channel turn (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function receiveInbound(ctx: TenantContext, input: ReceiveInboundInput): Promise<InboundResult> {
  assertChannelsTenantContext(ctx);
  const valid: ValidatedReceiveInboundInput = validateReceiveInboundInput(input);
  const adapter = getChannelAdapter(valid.provider);

  // Provider-native payload → canonical event (adapter-private; the raw
  // envelope never advances past this line).
  const canonical: CanonicalInboundMessage = adapter.parseInbound(valid.payload);
  // Defense in depth: adapter output is re-validated before anything is
  // persisted or handed to a sibling contract.
  const event = validateCanonicalInboundMessage(canonical);

  // On-sight identity registration (W002): duplicates collapse onto the
  // existing row; the returned state drives actor attribution.
  const { identity, created } = await registerExternalIdentity(ctx, {
    provider: event.provider,
    providerAccountId: event.providerAccountId,
    displayName: event.displayName,
  });

  const conversationId =
    event.providerThreadKey !== null
      ? await resolveThread(ctx, event.provider, event.providerThreadKey, event.threadTitle)
      : null;

  const message = await recordTranscriptTurn(ctx, {
    conversationId,
    direction: 'inbound',
    actor: actorFor(identity, event.displayName),
    channel: event.provider,
    payload: inboundTranscriptPayload(event.content),
    // When the provider event carries no sender clock, the service clock is
    // the honest fallback (SMS, undated bridge events).
    sentAt: event.sentAt ?? now().toISOString(),
    providerMessageId: event.providerMessageId,
  });

  return {
    message,
    identity,
    identityCreated: created,
    threadKey: event.providerThreadKey,
  };
}

// ---------------------------------------------------------------------------
// Outbound — canonical message → adapter formatting → transport → transcript
// ---------------------------------------------------------------------------

function connectionParty(connection: ChannelConnection): CanonicalParty {
  return {
    providerAccountId: connection.providerAccountId,
    displayName: connection.displayName,
  };
}

function connectionLabel(connection: ChannelConnection): string {
  return (
    connection.displayName ??
    `${connection.provider}:${connection.providerAccountId}`.slice(0, 200)
  );
}

/**
 * Resolves the sending endpoint: an explicit connection id (tenant-scoped,
 * provider-matching, active) or the tenant's UNIQUE active connection for
 * the provider.
 */
async function resolveSendingConnection(
  ctx: TenantContext,
  provider: string,
  connectionId: string | null,
): Promise<ChannelConnection> {
  const db: Queryable = getDb();
  if (connectionId !== null) {
    if (!isUuid(connectionId)) {
      // Malformed ids are indistinguishable from missing records (no leak).
      throw new ChannelsError(
        'connection_not_found',
        `channel connection '${connectionId}' does not exist in this tenant`,
      );
    }
    const result = await db.query<ConnectionRow>(
      `SELECT * FROM channel_connections WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, connectionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ChannelsError(
        'connection_not_found',
        `channel connection '${connectionId}' does not exist in this tenant`,
      );
    }
    if (row.provider !== provider) {
      throw new ChannelsError(
        'invalid_channel_input',
        `channel connection '${connectionId}' belongs to provider '${row.provider}', not '${provider}'`,
      );
    }
    const connection = mapConnection(row);
    if (connection.status !== 'active') {
      throw new ChannelsError(
        'connection_disabled',
        `channel connection '${connection.id}' (${connection.provider}) is disabled`,
      );
    }
    return connection;
  }

  const rows = await db.query<ConnectionRow>(
    `SELECT * FROM channel_connections
       WHERE tenant_id = $1 AND provider = $2 AND status = 'active'
       ORDER BY created_at, id`,
    [ctx.tenantId, provider],
  );
  if (rows.rows.length === 0) {
    // Precision over a bare not-found: if the tenant HAS connections for the
    // provider but none is active, say so.
    const any = await db.query<{ status: string }>(
      `SELECT status FROM channel_connections WHERE tenant_id = $1 AND provider = $2 LIMIT 1`,
      [ctx.tenantId, provider],
    );
    if (any.rows[0] !== undefined) {
      throw new ChannelsError(
        'connection_disabled',
        `no active ${provider} connection exists in this tenant (all connections are disabled)`,
      );
    }
    throw new ChannelsError(
      'connection_not_found',
      `no active ${provider} connection exists in this tenant`,
    );
  }
  if (rows.rows.length > 1) {
    throw new ChannelsError(
      'connection_ambiguous',
      `${rows.rows.length} active ${provider} connections exist — pass an explicit connectionId`,
    );
  }
  return mapConnection(rows.rows[0]!);
}

export async function sendOutbound(ctx: TenantContext, input: SendOutboundInput): Promise<OutboundResult> {
  assertChannelsTenantContext(ctx);
  const valid: ValidatedSendOutboundInput = validateSendOutboundInput(input);
  const adapter = getChannelAdapter(valid.provider);
  const to: CanonicalParty = {
    providerAccountId: adapter.normalizeAccountId(valid.to.providerAccountId),
    displayName: valid.to.displayName,
  };
  const connection = await resolveSendingConnection(ctx, valid.provider, valid.connectionId);

  const formatted = adapter.formatOutbound({
    purpose: 'message',
    content: valid.content,
    subject: valid.subject,
    recipientName: to.displayName,
  });

  // Deliver FIRST, record SECOND: the transcript records what was actually
  // sent, never an unsent intent (ARCHITECTURE.md §9 / W029 contract).
  const receipt = ensureReceiptShape(
    await deliver({
      provider: valid.provider,
      tenantId: ctx.tenantId,
      purpose: 'message',
      from: connectionParty(connection),
      to,
      message: formatted,
    }),
    valid.provider,
  );
  throwForReceipt(receipt, valid.provider);

  if (valid.conversationId !== null) {
    // Pre-validate the caller-supplied thread so the uniform not-found code
    // is ours, not the conversations module's.
    try {
      await getConversation(ctx, valid.conversationId);
    } catch (error) {
      if (error instanceof ConversationsError && error.code === 'conversation_not_found') {
        throw new ChannelsError(
          'conversation_not_found',
          `conversation '${valid.conversationId}' does not exist in this tenant`,
        );
      }
      throw error;
    }
  }

  const message = await recordTranscriptTurn(ctx, {
    conversationId: valid.conversationId,
    direction: 'outbound',
    actor: { kind: 'system', label: connectionLabel(connection) },
    channel: valid.provider,
    payload: { kind: 'message', to, subject: formatted.subject, content: valid.content },
    sentAt: now().toISOString(),
    providerMessageId: receipt.providerMessageId,
  });
  return { message, receipt };
}

// ---------------------------------------------------------------------------
// Identity verification challenges (W002 assigns delivery to W030)
// ---------------------------------------------------------------------------

export async function deliverIdentityChallenge(
  ctx: TenantContext,
  input: DeliverChallengeInput,
): Promise<ChallengeDeliveryResult> {
  assertChannelsTenantContext(ctx);
  const valid = validateDeliverChallengeInput(input);

  let identity: ExternalIdentity;
  try {
    identity = await getExternalIdentity(ctx, valid.identityId);
  } catch (error) {
    if (error instanceof IdentityError && error.code === 'identity_not_found') {
      // Cross-tenant/missing identities are uniformly invalid provenance (no leak).
      throw new ChannelsError(
        'invalid_provenance',
        `the referenced channel identity is not available in this tenant (identity '${valid.identityId}')`,
      );
    }
    throw error;
  }

  let challenge: { code: string; expiresAt: string };
  try {
    challenge = await issueVerificationChallenge(ctx, {
      identityId: valid.identityId,
      ttlSeconds: valid.ttlSeconds ?? undefined,
    });
  } catch (error) {
    if (error instanceof IdentityError) {
      if (error.code === 'identity_already_verified' || error.code === 'identity_revoked') {
        throw new ChannelsError('identity_not_eligible', error.message);
      }
      if (error.code === 'invalid_challenge_ttl') {
        throw new ChannelsError('invalid_channel_input', error.message);
      }
      if (error.code === 'identity_not_found') {
        throw new ChannelsError('invalid_provenance', error.message);
      }
    }
    throw error;
  }

  const adapter = getChannelAdapter(identity.provider);
  const connection = await resolveSendingConnection(ctx, identity.provider, valid.connectionId);
  const to: CanonicalParty = {
    providerAccountId: identity.providerAccountId,
    displayName: identity.displayName,
  };

  // The code exists only inside the module boundary from here on: it is
  // formatted onto the provider-bound message, delivered, and never
  // persisted (the transcript turn below carries a redaction marker).
  const formatted = adapter.formatOutbound({
    purpose: 'verification',
    code: challenge.code,
    recipientName: identity.displayName,
  });

  const receipt = ensureReceiptShape(
    await deliver({
      provider: identity.provider,
      tenantId: ctx.tenantId,
      purpose: 'verification',
      from: connectionParty(connection),
      to,
      message: formatted,
    }),
    identity.provider,
  );
  throwForReceipt(receipt, identity.provider);

  const message = await recordTranscriptTurn(ctx, {
    direction: 'outbound',
    actor: { kind: 'system', label: connectionLabel(connection) },
    channel: identity.provider,
    payload: {
      kind: 'verification_code',
      to,
      subject: formatted.subject,
      redaction: {
        reason:
          'single-use verification code delivered over the provider channel; the value is a credential and is never stored in transcripts (IMPLEMENTATION-STACK §8)',
      },
    },
    sentAt: now().toISOString(),
    providerMessageId: receipt.providerMessageId,
  });
  return { identityId: identity.id, expiresAt: challenge.expiresAt, message, receipt };
}

export async function completeIdentityChallenge(
  ctx: TenantContext,
  input: CompleteChallengeInput,
): Promise<ExternalIdentity> {
  assertChannelsTenantContext(ctx);
  const valid = validateCompleteChallengeInput(input);
  try {
    return await completeVerificationChallenge(ctx, {
      identityId: valid.identityId,
      code: valid.code,
    });
  } catch (error) {
    if (error instanceof IdentityError) {
      switch (error.code) {
        case 'identity_not_found':
          throw new ChannelsError('invalid_provenance', error.message);
        case 'identity_already_verified':
        case 'identity_revoked':
          throw new ChannelsError('identity_not_eligible', error.message);
        case 'challenge_not_active':
        case 'challenge_expired':
        case 'challenge_code_mismatch':
        case 'challenge_attempts_exhausted':
          throw new ChannelsError(error.code, error.message);
        case 'invalid_identity_input':
          throw new ChannelsError('invalid_channel_input', error.message);
        default:
          break;
      }
    }
    throw error;
  }
}
