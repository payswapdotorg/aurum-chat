// ============================================================================
// conversations — the ONLY public surface of the conversations module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W029 — Conversation Domain:
// "Persist conversations/messages with actor/source/provenance and links to
//  cognitive executions without making conversations authoritative truth."
//
//   createConversation       — open an (optionally titled) thread explicitly
//      (the web-UI path; channel adapters usually let recordMessage
//      auto-create the thread on the first turn instead).
//   getConversation           — tenant-scoped read with derived message
//      count / last activity.
//   listConversations         — filtered thread list (title text, person
//      participation), most recently active first.
//   recordMessage             — append one immutable transcript turn with
//      actor attribution resolved through the W002 contracts (ADR-0003:
//      person attribution requires a verified, linked channel identity or
//      an existing person record — unverified accounts stay `external`,
//      lock 15), the canonical channel key, the provider's own message id
//      (redelivery dedupe), and the sender's clock vs the service clock.
//      Omitting conversationId auto-creates the thread.
//   getMessage                — tenant-scoped read of one turn.
//   listMessages              — filtered transcript retrieval (conversation,
//      channel, direction, actor kind/id, channel identity, sent window,
//      order, limit).
//   recordExecutionLink       — append an idempotent, append-only link
//      between a conversation (or one message) and a cognitive execution
//      (W013): role `triggered` (what the execution was reacting to) or
//      `produced` (the message the execution emitted). The execution id is
//      an OPAQUE reference — this module never reads or validates cognition
//      state, and a link grants no authority.
//   listExecutionLinks         — link retrieval by conversation, message,
//      execution or role.
//
// There is deliberately NO operation to update, delete, edit, redact,
// correct, close or archive a conversation or message, and NO operation
// that promotes, derives or asserts anything from transcript content — no
// belief, goal, knowledge or observation creation, no confidence or truth
// metadata: chat is a channel, not the product (ARCHITECTURE.md §1,
// ADR-0014; lock 10). Incoming turns become EVIDENCE through the
// observations module (W004) on the channel-adapter/cognition path —
// deliberately outside this module (W029's declared dependency is W002
// only, per the work-item DAG). Outgoing turns are recorded as what was
// actually sent; the communication-policy decision (W009 authority matrix)
// happened before this module was called. The database enforces the same
// discipline with triggers that reject UPDATE/DELETE/TRUNCATE on all three
// tables (migrations 001 and 002).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's
// conversations, messages or links (including identity/person references)
// is reported as `conversation_not_found` / `message_not_found` /
// `invalid_provenance` — no existence leak.
// ============================================================================

export {
  createConversation,
  getConversation,
  getMessage,
  listConversations,
  listExecutionLinks,
  listMessages,
  recordExecutionLink,
  recordMessage,
} from './service';

export { ConversationsError } from './errors';
export type { ConversationsErrorCode } from './errors';

export {
  CONVERSATION_ACTOR_KINDS,
  DEFAULT_LIST_LIMIT,
  EXECUTION_LINK_ROLES,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_PAYLOAD_BYTES,
  MAX_PROVIDER_MESSAGE_ID_LENGTH,
  MAX_TITLE_LENGTH,
  MESSAGE_DIRECTIONS,
  isConversationActorKind,
  isExecutionLinkRole,
  isMessageDirection,
} from './validation';

export type {
  ValidatedActorInput,
  ValidatedCreateConversationInput,
  ValidatedListConversationsQuery,
  ValidatedListExecutionLinksQuery,
  ValidatedListMessagesQuery,
  ValidatedRecordExecutionLinkInput,
  ValidatedRecordMessageInput,
} from './validation';

export type {
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
  RecordMessageActorInput,
  RecordMessageInput,
} from './types';

// The canonical channel-provider vocabulary is owned by the identity module
// (W002 — ADR-0015 provider-neutral keys); it is re-exported here so this
// contract is self-contained for the `channel` field it requires.
export type { ChannelProvider } from '@/modules/identity/contract';

