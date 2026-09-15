// ============================================================================
// channels — the ONLY public surface of the channels module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W030 — Channel Adapters:
// "Implement canonical adapters for WhatsApp, Telegram, Signal, Slack, X,
//  Instagram, Facebook/Messenger, LinkedIn, email, SMS/voice and web as
//  provider availability permits. Preserve provider isolation."
//
//   registerChannelConnection — register (idempotently) one tenant-owned
//      sending endpoint per provider account: a WhatsApp business number,
//      a Telegram bot, a Slack workspace app, an email mailbox…
//      `credentialRef` is an OPAQUE secret-store reference; credential
//      values never reach domain tables.
//   getChannelConnection      — tenant-scoped read (uniform not-found).
//   listChannelConnections    — filtered endpoint list.
//   setChannelConnectionStatus— enable/disable an endpoint (the only
//      mutable field of a connection).
//   receiveInbound            — the canonical inbound path: a provider
//      webhook payload (provider key + raw JSON envelope) is parsed by the
//      provider's PRIVATE adapter into a canonical communication event; the
//      sender identity is registered on sight through the identity contract
//      (W002); the turn is recorded through the conversations contract
//      (W029). Person attribution requires a verified, subject-linked
//      identity (lock 15) — everything else stays `external`. Provider
//      threads map to conversations through an append-only routing table
//      (first mapping wins). The raw provider payload NEVER crosses this
//      module boundary, and no observation is recorded here — that is the
//      cognition path's job (W013), not a declared dependency of W030.
//   sendOutbound              — the canonical outbound path: canonical
//      content is adapter-formatted, delivered through the provider-neutral
//      transport port and only then recorded as an outbound transcript
//      turn (what was ACTUALLY sent). The communication-policy decision
//      (W009 authority matrix) happened before this call; the channels
//      module is the delivery mechanism, never the decision authority.
//   deliverIdentityChallenge  — issue (identity contract, W002) and deliver
//      a single-use verification code over the sender's own channel — the
//      identity module explicitly assigns code delivery to W030. The code
//      is a credential: it exists only inside this module and the delivered
//      message; the transcript records a `verification_code` turn with a
//      redaction marker, never the value (IMPLEMENTATION-STACK §8).
//   completeIdentityChallenge — feed a channel-replied code back to the
//      identity contract's verification workflow.
//   setChannelTransport / getChannelTransport — infrastructure wiring for
//      the provider-neutral delivery port. Transport implementations that
//      touch provider SDKs/HTTP must live inside this module's adapters/
//      folder (IMPLEMENTATION-STACK §6 provider isolation); no transport is
//      wired by default, so deliveries fail explicitly with
//      `provider_unavailable` ("as provider availability permits").
//
// PROVIDER ISOLATION (lock 16 / ADR-0015): everything exported below is
// provider-neutral by construction. Providers appear only as the identity
// module's canonical `ChannelProvider` key; the only provider-minted
// values on this surface are OPAQUE strings (account ids, message ids,
// thread keys, media references). Provider webhook envelopes, SDK objects
// and account semantics are parsed inside `adapters/` and never leave.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's channel
// connections (and to identities/conversations referenced through them) is
// reported as `connection_not_found` / `invalid_provenance` — no existence
// leak.
// ============================================================================

export {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  getChannelConnection,
  getChannelTransport,
  listChannelConnections,
  receiveInbound,
  registerChannelConnection,
  sendOutbound,
  setChannelConnectionStatus,
  setChannelTransport,
} from './service';

export { ChannelsError } from './errors';
export type { ChannelsErrorCode } from './errors';

export {
  ATTACHMENT_KINDS,
  CHANNEL_CONNECTION_STATUSES,
  CHALLENGE_TTL_MAX_SECONDS,
  CHALLENGE_TTL_MIN_SECONDS,
  DEFAULT_LIST_LIMIT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_REFERENCE_LENGTH,
  MAX_CAPTION_LENGTH,
  MAX_CONTENT_BYTES,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MIME_TYPE_LENGTH,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_MESSAGE_ID_LENGTH,
  MAX_PROVIDER_THREAD_KEY_LENGTH,
  MAX_RAW_PAYLOAD_BYTES,
  MAX_SUBJECT_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  isCanonicalAttachmentKind,
  isCanonicalContent,
  isChannelConnectionStatus,
} from './validation';

export type {
  ValidatedCompleteChallengeInput,
  ValidatedDeliverChallengeInput,
  ValidatedListConnectionsQuery,
  ValidatedReceiveInboundInput,
  ValidatedRegisterConnectionInput,
  ValidatedSendOutboundInput,
} from './validation';

export type {
  ChallengeDeliveryResult,
  ChannelConnection,
  ChannelConnectionStatus,
  ChannelTransport,
  CanonicalAttachment,
  CanonicalAttachmentKind,
  CanonicalContent,
  CanonicalDeliveryRequest,
  CanonicalInboundMessage,
  CanonicalParty,
  CanonicalTranscriptPayload,
  CompleteChallengeInput,
  DeliverChallengeInput,
  DeliveryPurpose,
  FormattedMessage,
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

// The canonical channel-provider vocabulary is owned by the identity module
// (W002 — ADR-0015 provider-neutral keys); it is re-exported here so this
// contract is self-contained, exactly like the conversations contract
// (W029) does.
export type { ChannelProvider, ExternalIdentity, Message } from './types';
