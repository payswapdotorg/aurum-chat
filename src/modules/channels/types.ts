// Public domain types of the channels module (W030 — Channel Adapters).
//
// Everything in this file is provider-neutral BY CONSTRUCTION (lock 16:
// "channel providers cannot leak provider-specific objects into domain
// contracts"; ADR-0015). Providers appear only as the neutral
// `ChannelProvider` key owned by the identity module; provider-native
// webhook envelopes, message objects and account semantics are parsed
// inside `adapters/` and never leave this module in their raw shape. The
// only provider-minted values that cross the boundary are OPAQUE strings
// (account ids, message ids, thread keys, media handles) — exactly the
// discipline the conversations module applies to `providerMessageId`.
//
// Canonical flow (ARCHITECTURE.md §9):
//   * inbound  — provider webhook payload → adapter → CanonicalInboundMessage
//     → identity registration (W002, on sight) + immutable transcript turn
//     (W029). Incoming messages enter perception; recording the OBSERVATION
//     is the cognition path's job (W013), deliberately not imported here —
//     W030's declared dependency is W029 only, per the work-item DAG.
//   * outbound — canonical content → adapter formatting → provider-neutral
//     transport → immutable transcript turn of what was actually sent. The
//     communication-POLICY decision (W009 authority matrix) happens before
//     this module is called; the channels module is the delivery mechanism,
//     never the decision authority.

import type { ChannelProvider, ExternalIdentity } from '@/modules/identity/contract';
import type { Message } from '@/modules/conversations/contract';

export type { ChannelProvider, ExternalIdentity, Message };

// ---------------------------------------------------------------------------
// Canonical content
// ---------------------------------------------------------------------------

/** Kinds of attachment a provider message may carry (mirrored by validation). */
export type CanonicalAttachmentKind = 'image' | 'audio' | 'video' | 'document' | 'location';

/**
 * One attachment, normalized. `reference` is the provider-neutral handle for
 * the artifact — a URL, an object-storage key or the provider's opaque media
 * id; fetching the bytes is the transport/ingestion path's concern, never
 * the transcript's.
 */
export interface CanonicalAttachment {
  kind: CanonicalAttachmentKind;
  reference: string;
  mimeType: string | null;
  caption: string | null;
  /** Provider- (or later Aurum-)supplied transcript for audio/video. */
  transcript: string | null;
}

/**
 * Provider-neutral message body: a text, at least one attachment, or both.
 * A contentless message is invalid (validation enforces it).
 */
export interface CanonicalContent {
  text: string | null;
  attachments: CanonicalAttachment[];
}

/** A provider party (sender or recipient) in canonical form. */
export interface CanonicalParty {
  /** Canonical, adapter-normalized provider account id (opaque string). */
  providerAccountId: string;
  displayName: string | null;
}

/**
 * The payload shape the channels module records on every transcript turn
 * through the conversations contract — the canonical, provider-neutral
 * record of WHAT was communicated.
 *
 * Verification codes are credentials (they prove account ownership), so
 * their value is never stored in transcripts (IMPLEMENTATION-STACK §8:
 * "secrets/credentials … never in chat transcripts"): a
 * `verification_code` turn records THAT the single-use code was delivered
 * and nothing more.
 */
export type CanonicalTranscriptPayload =
  | {
      kind: 'message';
      /** Outbound only — the canonical recipient (inbound senders are the actor). */
      to?: CanonicalParty;
      /** Subject for store-and-forward providers (email-style); null otherwise. */
      subject?: string | null;
      content: CanonicalContent;
    }
  | {
      kind: 'verification_code';
      to?: CanonicalParty;
      subject?: string | null;
      /** Why the communicated value is withheld from the transcript. */
      redaction: { reason: string };
    };

// ---------------------------------------------------------------------------
// Connections (tenant-owned sending endpoints)
// ---------------------------------------------------------------------------

export type ChannelConnectionStatus = 'active' | 'disabled';

/**
 * A tenant-scoped channel endpoint the tenant sends through: one WhatsApp
 * business number, one Telegram bot, one Slack workspace app, one email
 * mailbox, … (ARCHITECTURE.md §3 — tenants own their channels).
 *
 * `credentialRef` is an OPAQUE reference to the secret store entry holding
 * the provider credentials — the secret value itself never reaches any
 * domain table (IMPLEMENTATION-STACK §8; GOVERNANCE mandatory invariant:
 * channel credentials are tenant-scoped and never stored in semantic
 * memory).
 */
export interface ChannelConnection {
  id: string;
  tenantId: string;
  provider: ChannelProvider;
  /** Canonical, adapter-normalized account id of the tenant's own endpoint. */
  providerAccountId: string;
  displayName: string | null;
  credentialRef: string;
  status: ChannelConnectionStatus;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; changes on status transitions only. */
  updatedAt: string;
}

export interface RegisterChannelConnectionInput {
  provider: ChannelProvider;
  /**
   * Raw provider account id of the endpoint; normalized by the provider's
   * adapter (E.164 for phone carriers, lowercase for email, …).
   */
  providerAccountId: string;
  displayName?: string | null;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
}

export interface RegisterChannelConnectionResult {
  connection: ChannelConnection;
  /** false when a connection for this (provider, account) already existed. */
  created: boolean;
}

export interface ListChannelConnectionsQuery {
  provider?: ChannelProvider;
  status?: ChannelConnectionStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetChannelConnectionStatusInput {
  connectionId: string;
  status: ChannelConnectionStatus;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * Input of `receiveInbound` — the provider webhook edge. `payload` is the
 * raw provider-native JSON envelope as it arrived; it is parsed by the
 * provider's adapter INSIDE this module and never crosses back out.
 */
export interface ReceiveInboundInput {
  provider: ChannelProvider;
  payload: unknown;
}

/**
 * The canonical inbound communication event an adapter produces from a
 * provider webhook payload (module-internal shape; `receiveInbound` returns
 * the persisted result, not this).
 */
export interface CanonicalInboundMessage {
  provider: ChannelProvider;
  /** Canonical, adapter-normalized sender account id. */
  providerAccountId: string;
  /** Sender display name from the payload, when the provider supplies one. */
  displayName: string | null;
  /** The provider's own message id (redelivery dedupe key); null when absent. */
  providerMessageId: string | null;
  /** Sender/ channel clock — strict ISO 8601; null when the event carries none. */
  sentAt: string | null;
  /**
   * The provider's native conversation anchor (chat id, channel id, session
   * id, subject-normalized email thread, …) — an OPAQUE string keyed to one
   * tenant conversation by `channel_threads`. Null when the provider has no
   * thread concept exposed in the payload.
   */
  providerThreadKey: string | null;
  /** Suggested title for the auto-created conversation (e.g. email subject). */
  threadTitle: string | null;
  content: CanonicalContent;
}

/** Result of `receiveInbound`. */
export interface InboundResult {
  /** The immutable transcript turn as persisted through the conversations contract. */
  message: Message;
  /** The (registered-on-sight) external identity that carried the message. */
  identity: ExternalIdentity;
  /** false when the identity already existed for this (provider, account). */
  identityCreated: boolean;
  /** The provider thread key this turn was routed through, when any. */
  threadKey: string | null;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export interface SendOutboundInput {
  provider: ChannelProvider;
  /**
   * Explicit sending connection; when omitted, the tenant's UNIQUE active
   * connection for the provider is auto-selected (`connection_ambiguous` if
   * several are active, `connection_not_found` if none).
   */
  connectionId?: string | null;
  to: CanonicalParty;
  content: CanonicalContent;
  /** Subject for store-and-forward providers (email); adapters may default it. */
  subject?: string | null;
  /**
   * Existing conversation to append the turn to; omit to let the transcript
   * auto-create a thread.
   */
  conversationId?: string | null;
}

export interface OutboundResult {
  /** The immutable transcript turn of what was actually sent. */
  message: Message;
  /** The transport's provider-neutral receipt. */
  receipt: TransportReceipt;
}

// ---------------------------------------------------------------------------
// Identity verification challenges (delivery is assigned to W030 by the
// identity module's contract: "code delivery happens in the channels
// module, W030")
// ---------------------------------------------------------------------------

export interface DeliverChallengeInput {
  identityId: string;
  /** Optional explicit sending connection (same auto-selection rules as sendOutbound). */
  connectionId?: string | null;
  /** Seconds until the challenge expires (identity module bounds: 30..86400). */
  ttlSeconds?: number | null;
}

/** Result of `deliverIdentityChallenge` — the CODE is deliberately absent: it went out over the channel. */
export interface ChallengeDeliveryResult {
  identityId: string;
  /** ISO 8601. */
  expiresAt: string;
  /** The redacted transcript turn proving the delivery. */
  message: Message;
  receipt: TransportReceipt;
}

export interface CompleteChallengeInput {
  identityId: string;
  /** The code as replied by the account holder over the channel. */
  code: string;
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral delivery; implementations are
// module-internal — provider SDKs may only live inside src/modules/channels/)
// ---------------------------------------------------------------------------

/** Why an outbound message is being delivered. */
export type DeliveryPurpose = 'message' | 'verification';

/** Adapter-formatted message body — provider-neutral, ready for the wire. */
export interface FormattedMessage {
  text: string;
  /** Subject for store-and-forward providers; null otherwise. */
  subject: string | null;
  attachments: CanonicalAttachment[];
}

/** The provider-neutral request handed to the transport. */
export interface CanonicalDeliveryRequest {
  provider: ChannelProvider;
  tenantId: string;
  purpose: DeliveryPurpose;
  from: CanonicalParty;
  to: CanonicalParty;
  message: FormattedMessage;
}

/**
 * Provider-neutral outcome of one delivery attempt:
 * `delivered` — the provider ACCEPTED the message (not "recipient read");
 * `rejected`  — the provider refused it (permanent: bad recipient, policy, …);
 * `failed`    — transport error (transient; the caller may retry).
 */
export interface TransportReceipt {
  status: 'delivered' | 'rejected' | 'failed';
  /** The provider's own message id for the accepted send, when it returns one. */
  providerMessageId: string | null;
  detail: string | null;
}

/**
 * The delivery port real transports implement. Transports that touch
 * provider SDKs/HTTP must live inside `src/modules/channels/adapters/`
 * (IMPLEMENTATION-STACK §6 provider isolation); they are wired at process
 * start via `setChannelTransport`. No transport is wired by default —
 * deliveries then fail explicitly with `provider_unavailable` ("as provider
 * availability permits").
 */
export interface ChannelTransport {
  deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt>;
}
