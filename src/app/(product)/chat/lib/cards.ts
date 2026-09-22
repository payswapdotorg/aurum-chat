// Aurum chat (W072 — conversational intelligence continuity) — the
// render-side card helpers.
//
// THE SHARED CONTRACT'S RENDER HALF. `chat-types.ts` owns the wire model
// (kinds, payload guards, the return-link grammar); this module owns the
// pure functions the renderer and the drill-down surfaces call so the
// continuity rules can never drift between them:
//
//   * `cardDrillHref` — a card's Open link, carrying the conversation
//     return link (`?back=`) so the destination can offer the way home;
//   * `answerExplainHref` / `cardExplainHref` — the explainability loop:
//     the message's cognition execution and the approval/recommendation
//     cards' action requests are BOTH reconstructable decisions (W065),
//     so "Why this?" can open the full causal chain from the message;
//   * `enrichCardContextLinks` — when a card's context drawer opens, its
//     section links inherit the same return context (the drawer is part
//     of the conversation, and anything it links out to must be
//     returnable too).
//
// Everything here is PURE (no React, no DB, no server imports) so the
// unit suite covers the guarantees directly, and Workers B (W073) and C
// (W074) consume exactly these helpers instead of forking the behavior.

import type { ChatCard, ChatCardContext, ChatAnswer } from './chat-types';
import { withChatReturn } from './chat-types';

/**
 * The drill-down href of a card (its Open affordance): the card's own
 * href plus the conversation return link, so every surface the card
 * leads to can offer the way back to THIS conversation (W072
 * acceptance: "every drill-down can return to the originating
 * conversation"). A null return link (no open conversation) or a
 * foreign href degrades to the plain href.
 */
export function cardDrillHref(card: ChatCard, returnLink: string | null): string {
  return withChatReturn(card.href, returnLink);
}

/**
 * The explainability href of a whole answer (W072: "explainability
 * context opens from the message/card"): the cognition execution that
 * produced it is a reconstructable decision (W065's execution anchor).
 * Null when the answer carries no execution id.
 */
export function answerExplainHref(answer: ChatAnswer): string | null {
  if (answer.executionId === null || answer.executionId === '') return null;
  return `/explain/execution/${answer.executionId}`;
}

/**
 * The explainability href of one card: approval and recommendation
 * cards ARE action requests, and action requests are reconstructable
 * decisions (W065's action anchor) — the full "why this was proposed,
 * what policy did, who decided" chain. Null for kinds that are not
 * action-request-anchored (their explainability rides the answer's
 * execution link instead).
 */
export function cardExplainHref(card: ChatCard): string | null {
  if (card.kind !== 'approval' && card.kind !== 'recommendation') return null;
  const requestId =
    card.kind === 'approval' ? (card.decision?.requestId ?? null) : card.id;
  if (requestId === null || requestId === '') return null;
  return `/explain/action/${requestId}`;
}

/**
 * Enrich a card-context drawer payload with the conversation return
 * link: every section link that points inside the app carries `?back=`,
 * so a reader who follows the drawer into a surface keeps the way home
 * (the drawer is part of the conversation — its links are drill-downs
 * like any other). Links with foreign hrefs pass through unchanged.
 */
export function enrichCardContextLinks(
  context: ChatCardContext,
  returnLink: string | null,
): ChatCardContext {
  if (returnLink === null || returnLink === '') return context;
  return {
    subtitle: context.subtitle,
    sections: context.sections.map((section) => ({
      ...section,
      links: section.links.map((link) => ({
        ...link,
        href: withChatReturn(link.href, returnLink),
      })),
    })),
  };
}

/**
 * Does this card currently offer the inline human decision affordance?
 * (Any card carrying a still-pending action request — the Journey E
 * pattern; W074 builds the full intervention lifecycle on this seam.)
 */
export function isPendingDecisionCard(card: ChatCard): boolean {
  return card.decision?.status === 'pending';
}
