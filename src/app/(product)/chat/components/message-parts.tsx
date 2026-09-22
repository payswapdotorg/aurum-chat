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
import {
  chatCardKindLabel,
  chatMessageAnchor,
  isLearningCardKind,
  withChatReturn,
} from '../lib/chat-types';
import {
  answerExplainHref,
  cardDrillHref,
  cardExplainHref,
  isPendingDecisionCard,
} from '../lib/cards';
import { LearningMessageCard } from './learning/learning-cards';
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
/** The question-in-circle glyph (the explainability affordance, W072). */
export const WHY_GLYPH_D =
  'M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.1 9a3 3 0 1 1 4.6 2.5c-.8.5-1.7 1-1.7 2.2';
/** The new-message glyph (chat bubble + plus — the new-conversation affordance, W071). */
export const COMPOSE_GLYPH_D =
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z M11.5 7.5v5 M9 10h5';
/** The magnifier (the conversation search affordance, W071). */
export const SEARCH_GLYPH_D = 'M21 21l-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z';
/** The single check (delivery state on the member's own bubbles, W071). */
export const CHECK_GLYPH_D = 'M20 6 9 17l-5-5';
/** The answer affordance (chat bubble + pencil — W073 learning lane). */
export const ANSWER_GLYPH_D =
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z M12 7h-3v3h3v3h2v-3h3V9h-3V6h-2v1Z';
/** The cancel affordance (the answer-mode banner, W073 learning lane). */
export const CANCEL_GLYPH_D = 'M18 6 6 18M6 6l12 12';

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
  returnTo,
}: {
  message: ChatMessageView;
  /** Run-position flags (W071 rhythm — spacing + the tail corner). */
  group?: BubbleGroup;
  actions?: CardActions;
  /**
   * The stable return link of THIS message (W072 continuity —
   * `/chat?c=<conversation>#m-<message>`): every drill-down the message
   * offers (cards, citations, explainability) carries it so the reader
   * can always come back to this exact spot. Null when no conversation
   * is open (the optimistic pending bubble).
   */
  returnTo?: string | null;
}): ReactNode {
  const time = bubbleTimeLabel(message.sentAt);
  const run = group ?? { first: true, last: true };
  return (
    <div
      className="aurum-chat-msg"
      // W072 — the message anchor: deep links (drill-down return links,
      // shared conversation links) land on the exact message.
      id={chatMessageAnchor(message.id)}
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
          <AnswerExtras answer={message.answer} actions={actions} returnTo={returnTo ?? null} />
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
  returnTo,
}: {
  answer: ChatAnswer;
  actions?: CardActions;
  returnTo: string | null;
}): ReactNode {
  // W072 — the message-level explainability loop: the cognition
  // execution that produced this answer is a reconstructable decision,
  // so "Why this answer?" opens the full causal chain and carries the
  // way back to this exact message.
  const explainHref = answerExplainHref(answer);
  return (
    <>
      {answer.cards.length === 0 ? null : (
        <div className="aurum-chat-cards">
          {answer.cards.map((card) => (
            <MessageCard
              key={`${card.kind}-${card.id}`}
              card={card}
              actions={actions}
              returnTo={returnTo}
            />
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
                href={withChatReturn(citation.href, returnTo)}
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
      {explainHref === null ? null : (
        <Link
          className="aurum-chat-explain"
          href={withChatReturn(explainHref, returnTo)}
        >
          <Glyph d={WHY_GLYPH_D} size={13} label="why this answer" />
          Why this answer?
        </Link>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// One action card (the unified consequential kinds, W060 + W072)
// ---------------------------------------------------------------------------

export interface CardActions {
  /** Decisions already made this session (request id → outcome). */
  decided: Record<string, 'approved' | 'rejected'>;
  /** The request currently being decided (spinner state). */
  deciding: string | null;
  /**
   * Open the shell context drawer with the card's why/evidence. The
   * message's return link (W072) rides along so the drawer's links
   * inherit the conversation context.
   */
  onOpenContext: (card: ChatCard, returnTo: string | null) => void;
  /** Decide a pending approval (approve/reject through the actions contract). */
  onDecide: (card: ChatCard, decision: 'approve' | 'reject') => void;
  /**
   * Enter composer answer mode for a knowledge request (W073 learning
   * lane — the card's plan id rides the shared card model's `id`).
   */
  onAnswer?: (card: ChatCard) => void;
}

export function MessageCard({
  card,
  actions,
  returnTo = null,
}: {
  card: ChatCard;
  actions?: CardActions;
  /** The message's stable return link (W072 continuity). */
  returnTo?: string | null;
}): ReactNode {
  // W073 — the learning kinds render through the learning lane's own
  // component (consumption of the shared card model; the one learning
  // affordance is the knowledge-request's composer answer mode).
  if (isLearningCardKind(card.kind)) {
    return <LearningMessageCard card={card} actions={actions} returnTo={returnTo} />;
  }
  const decided = actions === undefined ? undefined : actions.decided[card.decision?.requestId ?? ''];
  const isPending = isPendingDecisionCard(card) && decided === undefined;
  const explainHref = cardExplainHref(card);
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
        {/* W072 — the drill-down carries the way back: the Open link
            appends ?back=/chat?c=<conversation>#m-<message> so the
            destination surface can offer the return affordance. */}
        <Link className="aurum-chat-card-open" href={cardDrillHref(card, returnTo)}>
          {card.linkLabel === null || card.linkLabel === undefined
            ? 'Open in management mode'
            : card.linkLabel}
          <Glyph d={OPEN_GLYPH_D} size={13} label="open" />
        </Link>
        {explainHref === null ? null : (
          <Link
            className="aurum-chat-card-explain"
            href={withChatReturn(explainHref, returnTo)}
          >
            <Glyph d={WHY_GLYPH_D} size={13} label="explain this decision" />
            Explain decision
          </Link>
        )}
        {card.context === null ? null : (
          <button
            type="button"
            className="aurum-chat-card-why"
            onClick={() => actions?.onOpenContext(card, returnTo)}
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
