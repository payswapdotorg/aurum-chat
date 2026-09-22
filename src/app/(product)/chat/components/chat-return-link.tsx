// Aurum chat (W072 — conversational intelligence continuity) — the
// "back to the conversation" affordance drill-down surfaces render.
//
// THE CONTRACT'S DESTINATION HALF. The chat renderer appends the
// message's stable return link (`/chat?c=<conversation>#m-<message>`)
// to every drill-down href it emits (`withChatReturn`); the surface
// that receives the reader reads the SAME parameter through
// `normalizeChatReturnLink` (chat-types.ts — internal /chat paths
// only) and renders this component as the way home. One component, one
// style, one guard — intelligence and explainability surfaces cannot
// fork the behavior.
//
// Server-component safe (a plain <Link>, no hooks): the product pages
// render it inside their PageHead meta rows; nothing about the reader's
// session is needed — the return link is already addressed to their own
// conversation.
//
// Honest absence: with no (or a refused) `back` parameter the component
// renders nothing — a surface nobody arrived from chat shows no dead
// affordance.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { normalizeChatReturnLink } from '../lib/chat-types';

/** The link's human copy — the reader's word for the place they were. */
export const CHAT_RETURN_LABEL = 'Back to the conversation';

/**
 * Read the return link from a page's search params (the first value of
 * the `back` parameter, guarded by `normalizeChatReturnLink`). Shared
 * by every drill-down page so the read cannot drift.
 */
export function chatReturnFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): string | null {
  const raw = params['back'];
  const value = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  return normalizeChatReturnLink(value);
}

/**
 * The "back to the conversation" affordance (W072 acceptance: "every
 * drill-down can return to the originating conversation"). Null (or a
 * refused/foreign value) renders nothing.
 */
export function ChatReturnLink({ back }: { back: string | null }): ReactNode {
  if (back === null) return null;
  return (
    <Link className="aurum-chat-return" href={back} aria-label={CHAT_RETURN_LABEL}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        role="presentation"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
      {CHAT_RETURN_LABEL}
    </Link>
  );
}
