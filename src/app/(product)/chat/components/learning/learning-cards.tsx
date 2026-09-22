'use client';

// Chat-based learning requests (W073) — the learning lane's card renderer
// inside the chat timeline (client).
//
// CONSUMPTION OF THE SHARED CONTRACT ONLY: the cards are instances of the
// shared card model (chat-types' W073 learning kinds — knowledge-request,
// contribution, reward), rendered inside the message stream exactly like
// the seven consequential kinds (the same aurum-chat-card structure and
// CSS, embedded in the bubble, never replacing the thread). The one
// learning-specific affordance is the knowledge-request's "Answer here"
// button — it routes the COMPOSER into answer mode (the WhatsApp reply
// pattern: the employee's next send is captured as the answer through
// the same domain workflow the Learning surface drives).
//
// ShareNet visual language throughout (no glassmorphism, no gradient
// chrome, no gold/amber dominance): the cards reuse the existing chat
// card classes; the reward card carries the one separation sentence.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatusPill } from '../../../components/states';
import type { ChatCard } from '../../lib/chat-types';
import { chatCardKindLabel, withChatReturn } from '../../lib/chat-types';
import { Glyph, OPEN_GLYPH_D, ANSWER_GLYPH_D } from '../message-parts';
import type { CardActions } from '../message-parts';

/**
 * One learning card (knowledge-request / contribution / reward) — the
 * shared card body plus the learning affordances.
 */
export function LearningMessageCard({
  card,
  actions,
  returnTo = null,
}: {
  card: ChatCard;
  actions?: CardActions;
  /** The message's stable return link (W072 continuity — station
   *  integration: the learning lane joined the unified contract after
   *  W072 landed, so its drill-down now carries the return link too). */
  returnTo?: string | null;
}): ReactNode {
  const isRequest = card.kind === 'knowledge-request';
  const isReward = card.kind === 'reward';
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
        {isRequest && actions?.onAnswer !== undefined ? (
          <button
            type="button"
            className="aurum-chat-decide"
            data-decision="answer"
            onClick={() => actions.onAnswer?.(card)}
          >
            Answer here
            <Glyph d={ANSWER_GLYPH_D} size={13} label="answer" />
          </button>
        ) : null}
        <Link className="aurum-chat-card-open" href={withChatReturn(card.href, returnTo)}>
          {card.linkLabel === null || card.linkLabel === undefined
            ? 'Open the Learning surface'
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
      </div>
      {isRequest ? (
        <p className="aurum-chat-card-note">
          Your reply is recorded as evidence and acknowledged as a contribution.
        </p>
      ) : null}
      {isReward ? (
        <p className="aurum-chat-card-note aurum-learn-separation" role="note">
          A reward recognizes a knowledge contribution under the company’s explicit
          reward policy — it is separate from the company’s people decisions.
        </p>
      ) : null}
    </article>
  );
}
