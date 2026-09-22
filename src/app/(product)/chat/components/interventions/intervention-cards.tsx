'use client';

// Conversational interventions & approval continuity (W074) — the
// intervention lane's card renderer inside the chat timeline (client).
//
// CONSUMPTION OF THE SHARED CONTRACT ONLY: the cards are instances of
// the shared card model (chat-types' W074 station kinds —
// intervention-proposal and intervention-agent, plus the shared
// capability kind the recommendation's gap card rides), rendered inside
// the message stream exactly like every other consequential kind (the
// same aurum-chat-card structure and CSS, embedded in the bubble, never
// replacing the thread). The intervention-specific affordances:
//
//   * the INLINE HUMAN DECISION (Approve / Reject) on a proposal card
//     whose decision payload is still pending — it drives the SAME
//     authority gate the Interventions surface drives (decideApproval +
//     settle through /api/product/interventions/chat), so the thread and
//     the detail surface stay ONE governance truth. This is the W060
//     consequential-approval affordance pattern applied to the proposal
//     lifecycle;
//   * the ACTIVATION (Activate recruit) on an approved proposal card —
//     registering the agent with exactly the scopes the approved
//     comparison proposed;
//   * the human-employment SAFEGUARD note at every consequential step
//     (the gate, the activation, the agent lifecycle) — lock 20/21 in
//     conversational copy.
//
// ShareNet visual language throughout (no glassmorphism, no gradient
// chrome, no gold/amber dominance): the cards reuse the existing chat
// card classes; the W074-marked additions in product.css stay within
// the surface's restrained vocabulary.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatusPill } from '../../../components/states';
import type { ChatCard } from '../../lib/chat-types';
import { chatCardKindLabel } from '../../lib/chat-types';
import { cardDrillHref, cardExplainHref, isPendingDecisionCard } from '../../lib/cards';
import { Glyph, OPEN_GLYPH_D, WHY_GLYPH_D } from '../message-parts';
import type { CardActions } from '../message-parts';

/** The activate affordance's glyph (a bolt — the capability going live). */
export const ACTIVATE_GLYPH_D = 'M13 2 3 14h7l-1 8 10-12h-7l1-8Z';

/** The authority-gate safeguard (lock 20/21 — the human decision note). */
export const INTERVENTION_GATE_NOTE =
  'The human authority gate: your Approve or Reject is recorded as YOUR explicit decision on the approval trail. Aurum proposes the comparison — employment decisions stay human-authorized.';

/** The activation safeguard (the future grant, restated at activation time). */
export const INTERVENTION_ACTIVATION_NOTE =
  'Activation registers the agent with exactly the scopes the approved comparison proposed — its lifecycle (retain / modify / terminate) stays in human hands.';

/** The agent-lifecycle safeguard (retain/modify/terminate context). */
export const INTERVENTION_LIFECYCLE_NOTE =
  'A recruited agent is an organizational actor, not a person. Lifecycle decisions — retain, modify, terminate — follow measured evaluations and an explicit human decision at the gate; Aurum never autonomously terminates a human employee.';

/**
 * One intervention card (intervention-proposal / intervention-agent) —
 * the shared card body plus the intervention affordances: the inline
 * human decision while the gate holds the proposal, the activation once
 * approved, and the safeguard note at every consequential step.
 */
export function InterventionMessageCard({
  card,
  actions,
  returnTo = null,
}: {
  card: ChatCard;
  actions?: CardActions;
  /**
   * The message's stable return link (W072 continuity — every
   * drill-down this card offers carries it, so the reader can always
   * come back to this exact spot).
   */
  returnTo?: string | null;
}): ReactNode {
  const isProposal = card.kind === 'intervention-proposal';
  const isAgent = card.kind === 'intervention-agent';
  const decided =
    actions === undefined ? undefined : actions.decided[card.decision?.requestId ?? ''];
  const isPending = isProposal && isPendingDecisionCard(card) && decided === undefined;
  const isApproved =
    isProposal &&
    (decided === 'approved' ||
      (decided === undefined && card.decision?.status === 'approved'));
  const explainHref = cardExplainHref(card);
  const decisionNote =
    decided === undefined
      ? card.decision?.status === 'approved'
        ? 'Approved — the decision trail is in Approvals; activation is available here.'
        : card.decision?.status === 'rejected'
          ? 'Rejected — the decision trail is in Approvals; a changed comparison is a new proposal.'
          : null
      : decided === 'approved'
        ? 'You approved this — the outcome message follows in this thread.'
        : 'You rejected this — the outcome message follows in this thread.';
  const safeguard = isPending
    ? INTERVENTION_GATE_NOTE
    : isApproved
      ? INTERVENTION_ACTIVATION_NOTE
      : isAgent
        ? INTERVENTION_LIFECYCLE_NOTE
        : null;
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
        <ul
          className={
            isProposal ? 'aurum-chat-card-meta aurum-intv-comparison' : 'aurum-chat-card-meta'
          }
        >
          {card.meta.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      <div className="aurum-chat-card-actions">
        {isPending ? (
          <>
            <button
              type="button"
              className="aurum-chat-decide"
              data-decision="approve"
              disabled={actions?.deciding === card.decision?.requestId}
              onClick={() => actions?.onDecideIntervention?.(card, 'approve')}
            >
              Approve
            </button>
            <button
              type="button"
              className="aurum-chat-decide"
              data-decision="reject"
              disabled={actions?.deciding === card.decision?.requestId}
              onClick={() => actions?.onDecideIntervention?.(card, 'reject')}
            >
              Reject
            </button>
          </>
        ) : null}
        {isApproved ? (
          <button
            type="button"
            className="aurum-chat-decide aurum-intv-activate"
            data-decision="activate"
            disabled={actions?.intervening === card.id}
            onClick={() => actions?.onActivateIntervention?.(card)}
          >
            {actions?.intervening === card.id ? 'Activating…' : 'Activate recruit'}
            <Glyph d={ACTIVATE_GLYPH_D} size={13} label="activate the approved recruit" />
          </button>
        ) : null}
        {/* W072 — the drill-down carries the way back: the Open link
            appends ?back=/chat?c=<conversation>#m-<message> so the
            Interventions surface can offer the return affordance. */}
        <Link className="aurum-chat-card-open" href={cardDrillHref(card, returnTo)}>
          {card.linkLabel === null || card.linkLabel === undefined
            ? 'Open in management mode'
            : card.linkLabel}
          <Glyph d={OPEN_GLYPH_D} size={13} label="open" />
        </Link>
        {explainHref === null ? null : (
          <Link
            className="aurum-chat-card-explain"
            href={cardDrillHref({ ...card, href: explainHref }, returnTo)}
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
      </div>
      {decisionNote === null ? null : (
        <p className="aurum-chat-card-note">{decisionNote}</p>
      )}
      {safeguard === null ? null : (
        <p className="aurum-chat-card-note aurum-intv-safeguard" role="note">
          {safeguard}
        </p>
      )}
    </article>
  );
}
