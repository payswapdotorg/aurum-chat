// W073 — the chat-based learning requests' DOM suite.
//
// WHAT THIS PROVES AND HOW. The learning lane's chat pieces are a
// STRUCTURE contract inside the messenger: the knowledge-request card
// renders inside the message stream (embedded, never replacing it) with
// the composer's "Answer here" affordance; the contribution and reward
// cards render the acknowledgement with the Learning deep links; and the
// answer-mode banner (the WhatsApp reply pattern) carries the quoted
// question, the honest confidence selector and the cancel affordance.
// Those guarantees live in the RENDERED MARKUP, so this suite
// server-renders the real ChatWorkspace (inside the real
// ProductShellProvider — exactly the provider/page tree /chat hydrates)
// and the real AnswerBanner through React's renderToReadableStream, the
// same technique as the W071 DOM suite, and asserts the HTML.
//
// Pure presentation-fixture inputs: no DB, no API — the data flow is
// covered by the integration suite; this file owns the DOM shape only.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { ProductShellProvider } from '../../components/product-shell-provider';
import { ChatWorkspace } from '../../chat/components/chat-workspace';
import { AnswerBanner } from '../../chat/components/learning/answer-banner';
import { CHAT_STARTERS } from '../../lib/chat-starters';
import type { ChatMessageView, ChatStateView } from '../../chat/lib/chat-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function localIso(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000`
  );
}

const now = new Date();
const at = new Date(now);
at.setHours(now.getHours() - 1);

/** One Aurum turn carrying a learning card, the shared card model. */
function learningTurn(
  id: string,
  cardKind: 'knowledge-request' | 'contribution' | 'reward',
): ChatMessageView {
  return {
    id,
    side: 'aurum',
    speaker: 'Aurum',
    text: 'The learning turn text.',
    sentAt: localIso(at),
    starterId: null,
    answer: {
      intent: 'learning',
      mode: 'deterministic',
      headline: 'The learning headline.',
      bullets: [],
      note: null,
      cards: [
        {
          kind: cardKind,
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Which customs-broker change delays the cold chain?',
          statusLabel: 'Awaiting an answer',
          tone: 'info',
          meta: ['Asked of June Park', 'Confidence 20% of 80% — 25% toward target'],
          href: '/learning',
          linkLabel: 'Open the Learning surface',
          decision: null,
          context: {
            subtitle: 'A targeted knowledge request',
            sections: [
              { kind: 'why', title: 'Why this matters', lines: ['The objective.'], links: [] },
            ],
          },
        },
      ],
      citations: [
        {
          kind: 'mission',
          id: '11111111-1111-4111-8111-111111111111',
          label: 'Learning mission — Courier customs bottleneck',
          detail: null,
          href: '/intelligence/missions/11111111-1111-4111-8111-111111111111',
        },
      ],
      executionId: null,
    },
    pending: false,
  };
}

function chatState(threadMessages: ChatMessageView[]): ChatStateView {
  return {
    generatedAt: localIso(now),
    conversations: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        title: 'Aurum learning — knowledge requests',
        lastMessageAt: localIso(at),
        messageCount: threadMessages.length,
        preview: 'Aurum: A knowledge request for…',
      },
    ],
    thread: {
      id: '99999999-9999-4999-8999-999999999999',
      title: 'Aurum learning — knowledge requests',
      messages: threadMessages,
    },
  };
}

async function renderWorkspace(messages: ChatMessageView[]): Promise<string> {
  const stream = await renderToReadableStream(
    createElement(
      ProductShellProvider,
      null,
      createElement(ChatWorkspace, {
        tenantId: 't-dom',
        principalName: 'Dom Owner',
        starters: CHAT_STARTERS,
        initial: chatState(messages),
        starterQuery: null,
      }),
    ),
  );
  return await new Response(stream).text();
}

async function renderNode(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  return await new Response(stream).text();
}

// ---------------------------------------------------------------------------
// The knowledge-request card inside the timeline
// ---------------------------------------------------------------------------

describe('the knowledge-request card in the chat timeline', () => {
  it('renders embedded in the message stream with the answer affordance', async () => {
    const html = await renderWorkspace([learningTurn('m-1', 'knowledge-request')]);
    // The card is inside the bubble (embedded, not a pane of its own).
    expect(html).toContain('data-kind="knowledge-request"');
    expect(html).toContain('Knowledge request');
    expect(html).toContain('Which customs-broker change delays the cold chain?');
    expect(html).toContain('Asked of June Park');
    // The one learning affordance: Answer here (the composer mode).
    expect(html).toContain('Answer here');
    // The shared affordances ride along: the Learning deep link + Why this?
    expect(html).toContain('Open the Learning surface');
    expect(html).toContain('Why this?');
    // The evidence note under the card.
    expect(html).toContain('Your reply is recorded as evidence');
    // The mission citation renders in the same turn.
    expect(html).toContain('Learning mission — Courier customs bottleneck');
  });

  it('renders the contribution acknowledgement card', async () => {
    const html = await renderWorkspace([learningTurn('m-1', 'contribution')]);
    expect(html).toContain('data-kind="contribution"');
    expect(html).toContain('Contribution');
    expect(html).toContain('Awaiting an answer');
    expect(html).toContain('Open the Learning surface');
    // No answer affordance on the acknowledgement — it is already answered.
    expect(html).not.toContain('Answer here');
  });

  it('renders the reward card with the separation sentence', async () => {
    const html = await renderWorkspace([learningTurn('m-1', 'reward')]);
    expect(html).toContain('data-kind="reward"');
    expect(html).toContain('Reward');
    expect(html).toContain('separate from the company\u2019s people decisions');
    expect(html).not.toContain('Answer here');
  });
});

// ---------------------------------------------------------------------------
// The answer-mode banner (the WhatsApp reply pattern)
// ---------------------------------------------------------------------------

describe('the composer answer-mode banner', () => {
  it('carries the quoted question, the confidence selector and the cancel affordance', async () => {
    const html = await renderNode(
      createElement(AnswerBanner, {
        question: 'Which customs-broker change delays the cold chain, and by how much?',
        confidence: 'medium',
        onConfidenceChange: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain('Answering a knowledge request');
    expect(html).toContain('Which customs-broker change delays the cold chain');
    expect(html).toContain('How certain you are');
    // The honest three strengths (the single client-safe definition).
    expect(html).toContain('Confident — I know this well');
    expect(html).toContain('Cancel the answer and return to normal messages');
    expect(html).toContain('Cancel');
    expect(html).toContain(
      'Your next send is recorded as your answer — evidence for the mission',
    );
  });

  it('keeps 44px+ touch targets on the selector and the cancel button (the class contract)', async () => {
    const html = await renderNode(
      createElement(AnswerBanner, {
        question: 'Q?',
        confidence: 'high',
        onConfidenceChange: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain('aurum-learn-answer-select');
    expect(html).toContain('aurum-learn-answer-cancel');
  });
});
