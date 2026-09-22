// Aurum chat (W060) — the chat-state view builder (server composition).
//
// Reads ONLY module contracts (lock 31/32): the conversations contract is
// the transcript surface (W029). Two reads compose the WhatsApp-like
// state the client hydrates from and polls:
//
//   * the CONVERSATION LIST — threads most-recently-active first, each
//     with a last-turn preview (one bounded desc read per thread — the
//     tower's per-item trail discipline; capped at CHAT_LIST_LIMIT);
//   * the open THREAD TIMELINE — the transcript ascending, capped, with
//     payloads defensively parsed into renderer views (chat-types guards).
//
// Every read degrades to the caller's error mapping (a foreign
// conversation id must surface as not-found, not as a silent empty —
// ADR-0001's no-existence-leak discipline belongs to the API layer).

import type { TenantContext } from '@/infra/tenant';
import { now } from '@/infra/clock';
import {
  getConversation,
  listConversations,
  listMessages,
} from '@/modules/conversations/contract';
import type { Conversation, Message } from '@/modules/conversations/contract';
import { getActionRequest } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import type {
  ChatMessageView,
  ChatStateView,
  ChatThreadView,
  ConversationListItemView,
} from './chat-types';
import { parseTurnPayload } from './chat-types';
import { previewText, sideForDirection, speakerLabel } from './chat-format';

/** How many threads the conversation list carries. */
export const CHAT_LIST_LIMIT = 30;

/** How many turns the open timeline carries (ascending, most recent last). */
export const CHAT_TIMELINE_LIMIT = 200;

/** Map one stored message to the renderer's view. */
export function toMessageView(message: Message): ChatMessageView {
  const parsed = parseTurnPayload(message.payload);
  return {
    id: message.id,
    side: sideForDirection(message.direction),
    speaker: speakerLabel(message.direction, message.actor.label),
    text: parsed.text,
    sentAt: message.sentAt,
    starterId: parsed.starterId,
    answer: parsed.answer,
    pending: false,
  };
}

/** Map one conversation (+ its last turn) to the list's view. */
export function toConversationItem(
  conversation: Conversation,
  lastMessage: Message | null,
): ConversationListItemView {
  const preview =
    lastMessage === null
      ? null
      : previewText(
          lastMessage.direction,
          lastMessage.actor.label,
          parseTurnPayload(lastMessage.payload).text,
        );
  return {
    id: conversation.id,
    title: conversation.title ?? 'Untitled conversation',
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    preview,
  };
}

/**
 * Refresh the CURRENT status of the thread's pending approval cards.
 *
 * The transcript is immutable (W029): an approval card stores what was
 * PROPOSED at send time, and a human decision happens later through the
 * actions module. The VIEW therefore re-reads the authoritative status
 * for every still-pending approval card so the timeline never offers an
 * Approve/Reject affordance that was already decided. Bounded and
 * quiet: an unreadable request leaves the card exactly as recorded.
 *
 * W074 — the intervention-proposal cards join the same refresh: a
 * proposal decided on the Interventions surface (or through the generic
 * chat approval card) updates its card here from the SAME authoritative
 * action request — the thread and the detail surface show one
 * governance truth.
 */
async function refreshApprovalCards(
  ctx: TenantContext,
  messages: ChatMessageView[],
): Promise<void> {
  const pendingIds = new Set<string>();
  for (const message of messages) {
    if (message.answer === null) continue;
    for (const card of message.answer.cards) {
      if (
        (card.kind === 'approval' || card.kind === 'intervention-proposal') &&
        card.decision?.status === 'pending'
      ) {
        pendingIds.add(card.decision.requestId);
      }
    }
  }
  if (pendingIds.size === 0) return;
  const requests = new Map<string, ActionRequest>();
  await Promise.all(
    [...pendingIds].map(async (requestId) => {
      try {
        const request = await getActionRequest(ctx, { requestId });
        requests.set(requestId, request);
      } catch {
        // Uniform not-found / degraded read: keep the recorded state.
      }
    }),
  );
  for (const message of messages) {
    if (message.answer === null) continue;
    for (const card of message.answer.cards) {
      if (
        (card.kind === 'approval' || card.kind === 'intervention-proposal') &&
        card.decision !== null
      ) {
        const request = requests.get(card.decision.requestId);
        if (request === undefined || request.status === 'pending') continue;
        card.decision = {
          requestId: request.id,
          status: request.status === 'approved' ? 'approved' : 'rejected',
        };
        card.statusLabel =
          request.status === 'approved' ? 'Approved' : 'Rejected';
        card.tone = request.status === 'approved' ? 'positive' : 'neutral';
      }
    }
  }
}

/**
 * Build the composed chat state: the conversation list plus (when a
 * conversation is open) its timeline. A missing/foreign conversation id
 * throws the contract's `conversation_not_found` for the API layer to
 * map — the view never fakes an empty thread.
 */
export async function buildChatStateView(
  ctx: TenantContext,
  conversationId: string | null,
): Promise<ChatStateView> {
  const conversations = await listConversations(ctx, { limit: CHAT_LIST_LIMIT });

  // One bounded preview read per thread (newest first — the contract's
  // order). Threads are few; the tower reads per-item trails the same way.
  const previews = await Promise.all(
    conversations.map((conversation) =>
      conversation.lastMessageAt === null
        ? Promise.resolve(null)
        : listMessages(ctx, {
            conversationId: conversation.id,
            order: 'desc',
            limit: 1,
          }).then((messages) => messages[0] ?? null),
    ),
  );

  const items = conversations.map((conversation, index) =>
    toConversationItem(conversation, previews[index] ?? null),
  );

  let thread: ChatThreadView | null = null;
  if (conversationId !== null) {
    // getConversation is the existence check: foreign/missing ids throw
    // the contract's conversation_not_found (uniform — no existence leak).
    const meta = await getConversation(ctx, conversationId);
    const messages = await listMessages(ctx, {
      conversationId,
      order: 'asc',
      limit: CHAT_TIMELINE_LIMIT,
    });
    const views = messages.map(toMessageView);
    await refreshApprovalCards(ctx, views);
    thread = {
      id: conversationId,
      title: meta.title ?? 'Conversation',
      messages: views,
    };
  }

  return {
    generatedAt: now().toISOString(),
    conversations: items,
    thread,
  };
}
