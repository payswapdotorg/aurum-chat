// Aurum chat (W060) — pure presentation formatting for the chat surface.
//
// CLIENT-SAFE: this module is imported by the client component, so it
// imports nothing and touches nothing but its arguments (the navigation.ts
// client-safety discipline). Everything here is a total function over
// strings — unit-tested without a DOM:
//
//   * compact WhatsApp-like timestamps (HH:MM inside bubbles, relative
//     labels in the conversation list, day separators in the timeline);
//   * the last-turn preview derivation ('You: …' / 'Aurum: …');
//   * the client-side unread/new-activity derivation (see seen-state.ts).
//
// Timestamps are computed in the READER's locale/timezone: bubbles carry
// `suppressHydrationWarning` in the renderer because the server's SSR
// labels and the client's hydration labels can legitimately differ.

import type {
  ChatMessageSide,
  ChatMessageView,
  ConversationListItemView,
} from './chat-types';

/** Zero-padded 2-digit number. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Compact bubble timestamp — HH:MM in the reader's timezone. */
export function bubbleTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Day-separator label ('Today', 'Yesterday', or a local date). */
export function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

/** Conversation-list activity label — compact relative time. */
export function relativeActivityLabel(iso: string | null, now: Date): string {
  if (iso === null) return 'no messages yet';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return dayLabel(iso, now);
}

/**
 * The speaker prefix for a conversation-list preview. Direction is
 * tenant-relative (W029): inbound = someone speaking toward the tenant
 * (the signed-in member on the web surface — 'You' when no display label
 * carried), outbound = the tenant side speaking (Aurum).
 */
export function previewSpeaker(
  direction: 'inbound' | 'outbound',
  actorLabel: string | null,
): string {
  if (direction === 'outbound') return actorLabel ?? 'Aurum';
  return actorLabel ?? 'You';
}

/** One-line preview of a stored turn for the conversation list. */
export function previewText(
  direction: 'inbound' | 'outbound',
  actorLabel: string | null,
  text: string,
  max = 80,
): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  const clipped =
    flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
  return `${previewSpeaker(direction, actorLabel)}: ${clipped}`;
}

/** Which side a stored turn renders on (inbound member → right). */
export function sideForDirection(direction: 'inbound' | 'outbound'): ChatMessageSide {
  return direction === 'inbound' ? 'member' : 'aurum';
}

/** The speaker label for a timeline bubble. */
export function speakerLabel(
  direction: 'inbound' | 'outbound',
  actorLabel: string | null,
): string {
  if (direction === 'outbound') return actorLabel ?? 'Aurum';
  return actorLabel ?? 'You';
}

/** Delivery-status copy for the member's own bubbles (compact, honest). */
export function deliveryStatusLabel(message: ChatMessageView): string {
  if (message.pending) return 'sending';
  return 'sent';
}

// ---------------------------------------------------------------------------
// Unread / new activity (client-side last-seen state)
// ---------------------------------------------------------------------------

export type ConversationActivity = 'new' | 'unread' | null;

/**
 * Derive the activity badge for one conversation from the client's
 * last-seen timestamp: 'new' when the thread was never seen, 'unread'
 * when it has activity newer than the last look, null when read.
 *
 * The conversations domain is APPEND-ONLY by design (W029: no update
 * operations, no read-state column) — read state is a VIEWER concern, so
 * it lives in the viewer's browser, never in domain truth.
 */
export function conversationActivity(
  conversation: ConversationListItemView,
  seenAt: string | null,
): ConversationActivity {
  if (conversation.lastMessageAt === null) return null;
  if (seenAt === null) return 'new';
  return conversation.lastMessageAt > seenAt ? 'unread' : null;
}
