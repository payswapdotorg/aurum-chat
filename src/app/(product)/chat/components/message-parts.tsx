'use client';

// Aurum chat (W060 base, W071 fidelity) — the timeline's rendering parts
// (client).
//
// Presentational components only; all logic lives in the pure libs
// (chat-types guards, chat-format — including the W071 bubble-run
// grouping) and the workspace component. The WhatsApp-like density comes
// from the bubble structure — compact timestamp + delivery state inside
// each member bubble, consecutive same-side runs grouped with a tail
// corner on the run's last bubble, day separators between turns — while
// the visual language stays ShareNet-dominant (scoped in chat.css).

import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatusPill } from '../../components/states';
import type {
  ChatAnswer,
  ChatCard,
  ChatMessageView,
} from '../lib/chat-types';
import { chatCardKindLabel } from '../lib/chat-types';
import {
  bubbleTimeLabel,
  dayLabel,
  deliveryStatusLabel,
} from '../lib/chat-format';
import type { BubbleGroup } from '../lib/chat-format';

// ---------------------------------------------------------------------------
// A tiny local glyph set (the shell's icons stay shell-owned)
// ---------------------------------------------------------------------------

function Glyph({
  d,
  size = 16,
  label,
}: {
  d: string;
  size?: number;
  label: string;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <title>{label}</title>
      <path d={d} />
    </svg>
  );
}

export { Glyph };

export const SEND_GLYPH_D = 'M12 19V5M5 12l7-7 7 7';
export const BACK_GLYPH_D = 'm15 18-6-6 6-6';
export const OPEN_GLYPH_D = 'M7 17 17 7M9 7h8v8';
/** The new-message glyph (chat bubble + plus — the new-conversation affordance, W071). */
export const COMPOSE_GLYPH_D =
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z M11.5 7.5v5 M9 10h5';
/** The magnifier (the conversation search affordance, W071). */
export const SEARCH_GLYPH_D = 'M21 21l-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z';
/** The single check (delivery state on the member's own bubbles, W071). */
export const CHECK_GLYPH_D = 'M20 6 9 17l-5-5';

// ---------------------------------------------------------------------------
// Working indicator (the streaming/working state)
// ---------------------------------------------------------------------------

export function WorkingRow(): ReactNode {
  return (
    <div className="aurum-chat-working-row">
      <span
        className="aurum-working aurum-chat-working-note"
        role="status"
        aria-live="polite"
      >
        <span className="aurum-working-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        Aurum is working — reading company state, checking evidence
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One message (bubble + answer extras)
// ---------------------------------------------------------------------------

export function MessageBubble({
  message,
  group,
  actions,
}: {
  message: ChatMessageView;
  /** Run-position flags (W071 rhythm — spacing + the tail corner). */
  group?: BubbleGroup;
  actions?: CardActions;
}): ReactNode {
  const time = bubbleTimeLabel(message.sentAt);
  const run = group ?? { first: true, last: true };
  return (
    <div
      className="aurum-chat-msg"
      data-side={message.side}
      data-pending={message.pending}
      data-group-first={run.first ? 'true' : undefined}
      data-group-last={run.last ? 'true' : undefined}
    >
      <div className="aurum-chat-bubble">
        {message.text === '' ? null : (
          <p className="aurum-chat-bubble-text">
            {/* The timeline is a live log — announce the speaker per turn. */}
            <span className="aurum-sr-only">{message.speaker}: </span>
            {message.text}
          </p>
        )}
        {message.answer === null ? null : (
          <AnswerExtras answer={message.answer} actions={actions} />
        )}
        <span className="aurum-chat-bubble-meta">
          {message.side === 'member' ? (
            <span
              className="aurum-chat-status"
              data-delivery={message.pending ? 'sending' : 'sent'}
            >
              {message.pending ? null : (
                <Glyph d={CHECK_GLYPH_D} size={12} label="delivered" />
              )}
              {deliveryStatusLabel(message)}
            </span>
          ) : null}
          <span suppressHydrationWarning>{time}</span>
        </span>
      </div>
    </div>
  );
}

function AnswerExtras({
  answer,
  actions,
}: {
  answer: ChatAnswer;
  actions?: CardActions;
}): ReactNode {
  return (
    <>
      {answer.cards.length === 0 ? null : (
        <div className="aurum-chat-cards">
          {answer.cards.map((card) => (
            <MessageCard key={`${card.kind}-${card.id}`} card={card} actions={actions} />
          ))}
        </div>
      )}
      {answer.citations.length === 0 ? null : (
        <div className="aurum-chat-citations">
          <span className="aurum-chat-citations-label">Evidence</span>
          <div className="aurum-chat-citation-list">
            {answer.citations.map((citation) => (
              <Link
                key={`${citation.kind}-${citation.id}`}
                className="aurum-chat-citation"
                href={citation.href}
                title={citation.detail ?? undefined}
              >
                <span className="aurum-chat-citation-dot" aria-hidden="true" />
                {citation.label}
              </Link>
            ))}
          </div>
        </div>
      )}
      <span className="aurum-chat-mode">
        {answer.mode === 'llm'
          ? 'Answer composed with your connected AI provider · grounded in the cited records'
          : 'Answer composed from live company records'}
        {answer.executionId === null ? '' : ' · full reasoning on the cognition trace'}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// One action card (the seven consequential kinds, W060 acceptance)
// ---------------------------------------------------------------------------

export interface CardActions {
  /** Decisions already made this session (request id → outcome). */
  decided: Record<string, 'approved' | 'rejected'>;
  /** The request currently being decided (spinner state). */
  deciding: string | null;
  /** Open the shell context drawer with the card's why/evidence. */
  onOpenContext: (card: ChatCard) => void;
  /** Decide a pending approval (approve/reject through the actions contract). */
  onDecide: (card: ChatCard, decision: 'approve' | 'reject') => void;
}

export function MessageCard({ card, actions }: { card: ChatCard; actions?: CardActions }): ReactNode {
  const decided = actions === undefined ? undefined : actions.decided[card.decision?.requestId ?? ''];
  const isPending = card.decision?.status === 'pending' && decided === undefined;
  const decisionNote =
    decided === undefined
      ? card.decision?.status === 'approved'
        ? 'Approved — the decision trail is in Approvals.'
        : card.decision?.status === 'rejected'
          ? 'Rejected — the decision trail is in Approvals.'
          : null
      : decided === 'approved'
        ? 'You approved this — recorded on the approval trail.'
        : 'You rejected this — recorded on the approval trail.';
  return (
    <article className="aurum-chat-card" data-kind={card.kind}>
      <div className="aurum-chat-card-head">
        <span className="aurum-chat-card-kind">{chatCardKindLabel(card.kind)}</span>
        <span className="aurum-chat-card-title">{card.title}</span>
        {card.statusLabel === '' ? null : (
          <StatusPill tone={card.tone}>{card.statusLabel}</StatusPill>
        )}
      </div>
      {card.meta.length === 0 ? null : (
        <ul className="aurum-chat-card-meta">
          {card.meta.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      <div className="aurum-chat-card-actions">
        <Link className="aurum-chat-card-open" href={card.href}>
          {card.linkLabel === null || card.linkLabel === undefined
            ? 'Open in management mode'
            : card.linkLabel}
          <Glyph d={OPEN_GLYPH_D} size={13} label="open" />
        </Link>
        {card.context === null ? null : (
          <button
            type="button"
            className="aurum-chat-card-why"
            onClick={() => actions?.onOpenContext(card)}
          >
            Why this?
          </button>
        )}
        {isPending ? (
          <>
            <button
              type="button"
              className="aurum-chat-decide"
              data-decision="approve"
              disabled={actions?.deciding === card.decision?.requestId}
              onClick={() => actions?.onDecide(card, 'approve')}
            >
              Approve
            </button>
            <button
              type="button"
              className="aurum-chat-decide"
              data-decision="reject"
              disabled={actions?.deciding === card.decision?.requestId}
              onClick={() => actions?.onDecide(card, 'reject')}
            >
              Reject
            </button>
          </>
        ) : null}
      </div>
      {decisionNote === null ? null : (
        <p className="aurum-chat-card-note">{decisionNote}</p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Day separators
// ---------------------------------------------------------------------------

/** Should a day separator render before this message? */
export function needsDaySeparator(
  previous: ChatMessageView | undefined,
  message: ChatMessageView,
  now: Date,
): boolean {
  if (previous === undefined) return true;
  return dayLabel(previous.sentAt, now) !== dayLabel(message.sentAt, now);
}

export function DaySeparator({ message, now }: { message: ChatMessageView; now: Date }): ReactNode {
  return (
    <div className="aurum-chat-day">
      <span suppressHydrationWarning>{dayLabel(message.sentAt, now)}</span>
    </div>
  );
}
