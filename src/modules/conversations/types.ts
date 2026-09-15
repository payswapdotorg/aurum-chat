// Public domain types of the conversations module (W029 — Conversation
// Domain).
//
// A Conversation is a persisted communication THREAD; a Message is one
// immutable turn of that thread with full provenance (actor, channel,
// provider message identity, sender clock vs commit clock). Conversation is
// a CHANNEL, not the product (ARCHITECTURE.md §1, ADR-0014): the transcript
// records what was actually communicated and never becomes authoritative
// truth —
//   * messages carry no confidence or truth metadata (evidence is the
//     observations module's concept, W004; understanding is epistemics,
//     W007 — neither is a dependency of W029, so this module creates
//     neither);
//   * links to cognitive executions are OPAQUE references (the cognition
//     module, W013, owns execution state) and grant no authority;
//   * outgoing messages are recorded as what was sent; the communication
//     POLICY decision (W009 authority matrix) happens before this module is
//     ever called — the transcript is not the decision authority.
//
// Actor attribution follows ADR-0003 (identity resolution): a message is
// attributed to a `person` only through a verified, linked channel identity
// (or a direct directory reference); unverified accounts stay `external`
// and can never become disconnected pseudo-employees (lock 15).

import type { ChannelProvider } from '@/modules/identity/contract';

/** Who can utter a message in a conversation. */
export type ConversationActorKind = 'person' | 'agent' | 'system' | 'external';

/**
 * Direction of a message relative to the tenant (ARCHITECTURE.md §9):
 * `inbound` — sent toward the tenant (enters perception; becomes evidence
 * downstream); `outbound` — emitted by the tenant side (an action that was
 * subject to communication policy before it was sent).
 */
export type MessageDirection = 'inbound' | 'outbound';

/**
 * Role a cognitive execution plays with respect to a conversation or
 * message:
 *   `triggered` — the conversation (as a whole) or a specific message caused
 *                 a cognitive execution to start;
 *   `produced`  — the cognitive execution produced this specific outbound
 *                 message.
 */
export type ExecutionLinkRole = 'triggered' | 'produced';

/** Actor attribution recorded on a persisted message. */
export interface MessageActor {
  kind: ConversationActorKind;
  /**
   * The acting record: people.persons.id for `person` (verified attribution
   * only — see ADR-0003), an opaque agent id for `agent` (agents module
   * W021+ does not exist yet, so the reference is deliberately unverified
   * here, like the observations module's source references). Null for
   * `system` / `external`.
   */
  id: string | null;
  /** Human-readable fallback / display name (required for `system`). */
  label: string | null;
  /**
   * The identity module's ExternalIdentity (ADR-0003) that carried this
   * specific message — the same person may speak through many providers
   * (W045), and the transcript must show which one carried each turn.
   * Null when the actor did not act through a channel identity.
   */
  identityId: string | null;
}

/**
 * Input actor shape of `recordMessage`. Per kind:
 *   `person`  — exactly one of `personId` (directory reference, verified
 *               through the people contract) or `externalIdentityId`
 *               (channel identity, verified AND subject-linked through the
 *               identity contract — ADR-0003/lock 15);
 *   `agent`   — optional opaque `id` + optional `label` (at least one);
 *   `system`  — `label` required (which Aurum subsystem spoke);
 *   `external`— optional `externalIdentityId` (any verification status —
 *               unverified accounts stay external, they never become
 *               pseudo-persons) + optional `label` (at least one).
 */
export interface RecordMessageActorInput {
  kind: ConversationActorKind;
  personId?: string | null;
  externalIdentityId?: string | null;
  /** Opaque agent id (kind `agent` only — the agents module is W021+). */
  id?: string | null;
  label?: string | null;
}

/** Input shape of `createConversation`. */
export interface CreateConversationInput {
  /** Optional display title (1..200 chars after trimming; null = untitled). */
  title?: string | null;
}

/** A conversation thread — groupMessages target and execution-link anchor. */
export interface Conversation {
  id: string;
  tenantId: string;
  title: string | null;
  /** Principal that created the conversation (auto-created ones: the recording principal). */
  createdBy: string;
  /** ISO 8601 — service clock at creation. */
  createdAt: string;
  /** Derived: number of messages in the thread. */
  messageCount: number;
  /** Derived: latest `sentAt` among the thread's messages (null when empty). ISO 8601. */
  lastMessageAt: string | null;
}

/** Input shape of `recordMessage`. */
export interface RecordMessageInput {
  /**
   * Existing conversation to append to. Omit to auto-create a new
   * conversation (the recording principal becomes its creator) — the
   * ergonomic path for channel adapters handling the first inbound turn.
   */
  conversationId?: string | null;
  /**
   * Title for the auto-created conversation; rejected when
   * `conversationId` is supplied (retitling is not a message concern).
   */
  conversationTitle?: string | null;
  direction: MessageDirection;
  actor: RecordMessageActorInput;
  /** Neutral channel key (the identity module's canonical provider list). */
  channel: ChannelProvider;
  /**
   * Provider-neutral normalized content — any plain JSON value (≤ 1 MiB;
   * large artifacts belong in object storage, adapters keep a reference).
   * Never a provider SDK object (lock 16).
   */
  payload: unknown;
  /** When the message was sent, per the sender's/channel's clock — strict ISO 8601. */
  sentAt: string;
  /**
   * The provider's own message identifier, when the channel supplies one.
   * Doubles as the redelivery dedupe key per (tenant, channel): re-recording
   * the same provider message replays the original row.
   */
  providerMessageId?: string | null;
}

/** One persisted message — the immutable transcript turn. */
export interface Message {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: MessageDirection;
  actor: MessageActor;
  channel: ChannelProvider;
  payload: unknown;
  /** ISO 8601 — the sender's/channel's clock. */
  sentAt: string;
  /** ISO 8601 — when Aurum committed the message (service-controlled). */
  recordedAt: string;
  providerMessageId: string | null;
}

/** Query shape of `listMessages`. */
export interface ListMessagesQuery {
  /** Limit to one thread's transcript. */
  conversationId?: string;
  channel?: ChannelProvider;
  direction?: MessageDirection;
  actorKind?: ConversationActorKind;
  /** Requires `actorKind` (an id is meaningless without its kind). */
  actorId?: string;
  /** Messages carried by this external identity, across channels (W045). */
  actorIdentityId?: string;
  /** Inclusive lower bound on `sentAt` — strict ISO 8601. */
  sentFrom?: string;
  /** Inclusive upper bound on `sentAt` — strict ISO 8601. */
  sentTo?: string;
  /** `asc` (default, chronological) or `desc`. */
  order?: 'asc' | 'desc';
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listConversations`. */
export interface ListConversationsQuery {
  /** Case-insensitive substring over titles (LIKE metacharacters literal). */
  titleContains?: string;
  /** Threads in which this person (people.persons.id) sent at least one message. */
  participantPersonId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input shape of `recordExecutionLink`. */
export interface RecordExecutionLinkInput {
  /**
   * Link target: the conversation as a whole (`conversationId`), or one
   * specific message (`messageId` — its conversation is derived). Exactly
   * one of the two.
   */
  conversationId?: string | null;
  messageId?: string | null;
  /**
   * Opaque uuid of the cognitive execution (cognition module W013 — not a
   * dependency of W029, so the reference is deliberately unverified here;
   * the cognition module remains the sole authority over execution state).
   */
  executionId: string;
  role: ExecutionLinkRole;
}

/** A persisted link between a conversation/message and a cognitive execution. */
export interface ExecutionLink {
  id: string;
  tenantId: string;
  conversationId: string;
  /** Null for conversation-level links. */
  messageId: string | null;
  /** Opaque — owned by the cognition module (W013). */
  executionId: string;
  role: ExecutionLinkRole;
  /** Principal that recorded the link. */
  recordedBy: string;
  /** ISO 8601 — service clock at record time. */
  recordedAt: string;
}

/** Query shape of `listExecutionLinks`. */
export interface ListExecutionLinksQuery {
  /** Links anchored on this conversation (includes its message-level links). */
  conversationId?: string;
  messageId?: string;
  executionId?: string;
  role?: ExecutionLinkRole;
  /** 1..500, default 50. */
  limit?: number;
}
