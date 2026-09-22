// W072 — conversational intelligence continuity: the contract suite.
//
// WHAT THIS PROVES. The reusable card/context contract Wave-2 workers
// build against (Workers B/C consume it and must not fork it) carries
// four hard guarantees, all pure and all tested here:
//
//   1. THE UNIFIED CARD MODEL — the nine consequential kinds (W060's
//      seven + W072's capability and evidence) all normalize, label and
//      deep-link; no kind renders without a destination.
//   2. THE RETURN-LINK GRAMMAR — `chatReturnLink` is stable and
//      deterministic (`/chat?c=<id>` + the message anchor),
//      `withChatReturn` appends it to any internal href under one
//      canonical parameter, and `normalizeChatReturnLink` accepts ONLY
//      internal /chat paths (a return link can never smuggle a reader
//      somewhere else).
//   3. EVIDENCE/CONTEXT ON EVERY CONSEQUENTIAL CARD — builders attach
//      rich context; a stored payload whose context is missing, foreign
//      or legacy degrades to the honest fallback (never a context-less
//      "Why this?" dead affordance).
//   4. THE EXPLAINABILITY LOOP — answers with an execution and
//      approval/recommendation cards expose reconstructable-decision
//      links, and the context drawer's links inherit the return context.
//
// Pure unit seams only (no DB, no API): the composition-level and DOM
// halves of the guarantees live in the integration/DOM suites.

import { describe, expect, it } from 'vitest';
import type {
  ChatAnswer,
  ChatCard,
  ChatCardContext,
} from '../lib/chat-types';
import {
  CARD_HREFS,
  CHAT_CARD_KINDS,
  CHAT_MESSAGE_ANCHOR_PREFIX,
  CHAT_RETURN_PARAM,
  CONSEQUENTIAL_CARD_KINDS,
  fallbackCardContext,
  isChatCardKind,
  chatCardKindLabel,
  chatMessageAnchor,
  chatReturnLink,
  normalizeChatCard,
  normalizeChatReturnLink,
  withChatReturn,
} from '../lib/chat-types';
import {
  answerExplainHref,
  cardDrillHref,
  cardExplainHref,
  enrichCardContextLinks,
  isPendingDecisionCard,
} from '../lib/cards';

// ---------------------------------------------------------------------------
// 1 — the unified card model
// ---------------------------------------------------------------------------

describe('the unified consequential card model (W072)', () => {
  it('covers the W060 seven plus capability and evidence', () => {
    expect([...CHAT_CARD_KINDS]).toEqual([
      'goal',
      'unknown',
      'mission',
      'risk',
      'opportunity',
      'recommendation',
      'approval',
      'capability',
      'evidence',
    ]);
    // Every kind in the unified model is consequential (W072 acceptance).
    expect([...CONSEQUENTIAL_CARD_KINDS]).toEqual([...CHAT_CARD_KINDS]);
  });

  it('every kind has a deep-link destination, a label and a guard', () => {
    for (const kind of CHAT_CARD_KINDS) {
      expect(CARD_HREFS[kind]).toMatch(/^\//);
      expect(chatCardKindLabel(kind)).not.toBe('');
      expect(isChatCardKind(kind)).toBe(true);
    }
    expect(isChatCardKind('nonsense')).toBe(false);
    expect(isChatCardKind(42)).toBe(false);
  });

  it('normalizes capability and evidence cards like the W060 kinds', () => {
    const capability = normalizeChatCard({
      kind: 'capability',
      id: 'cap-1',
      title: 'Customs brokerage',
      statusLabel: 'No active supply',
      tone: 'warning',
      meta: ['2 unmet requirements'],
      href: '/capabilities',
    });
    expect(capability?.kind).toBe('capability');
    expect(capability?.href).toBe('/capabilities');
    expect(capability?.context).not.toBeNull();

    const evidence = normalizeChatCard({
      kind: 'evidence',
      id: 'obs-1',
      title: 'freshness.sample · ACME feed',
    });
    // A missing href degrades to the kind's canonical destination.
    expect(evidence?.href).toBe('/evidence');
    expect(evidence?.context).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 — the return-link grammar
// ---------------------------------------------------------------------------

describe('chatReturnLink (the stable return link)', () => {
  const conversation = '11111111-1111-4111-8111-111111111111';
  const message = '22222222-2222-4222-8222-222222222222';

  it('is /chat?c=<id> plus the message anchor where supported', () => {
    expect(chatReturnLink(conversation)).toBe(`/chat?c=${conversation}`);
    expect(chatReturnLink(conversation, message)).toBe(
      `/chat?c=${conversation}#${CHAT_MESSAGE_ANCHOR_PREFIX}${message}`,
    );
    expect(chatReturnLink(conversation, null)).toBe(`/chat?c=${conversation}`);
  });

  it('is deterministic — the same conversation always yields the same link', () => {
    expect(chatReturnLink(conversation, message)).toBe(
      chatReturnLink(conversation, message),
    );
    expect(chatMessageAnchor(message)).toBe(`m-${message}`);
  });
});

describe('withChatReturn (drill-down href enrichment)', () => {
  const back = chatReturnLink('c-1', 'm-1');

  it('appends the canonical parameter, merging with existing queries', () => {
    expect(withChatReturn('/intelligence', back)).toBe(
      `/intelligence?${CHAT_RETURN_PARAM}=${encodeURIComponent(back)}`,
    );
    expect(withChatReturn('/goals?tab=active', back)).toBe(
      `/goals?tab=active&${CHAT_RETURN_PARAM}=${encodeURIComponent(back)}`,
    );
  });

  it('leaves the href alone without a return link or with foreign hrefs', () => {
    expect(withChatReturn('/intelligence', null)).toBe('/intelligence');
    expect(withChatReturn('/intelligence', '')).toBe('/intelligence');
    expect(withChatReturn('https://evil.example/x', back)).toBe(
      'https://evil.example/x',
    );
  });
});

describe('normalizeChatReturnLink (the destination-side guard)', () => {
  const back = chatReturnLink('c-1', 'm-1');

  it('accepts the encoded return link round-trip', () => {
    expect(normalizeChatReturnLink(encodeURIComponent(back))).toBe(back);
    // A raw (unencoded) value is accepted too — the param may arrive
    // pre-decoded depending on the link source.
    expect(normalizeChatReturnLink(back)).toBe(back);
  });

  it('refuses everything that is not an internal /chat path', () => {
    expect(normalizeChatReturnLink(encodeURIComponent('/goals'))).toBeNull();
    expect(normalizeChatReturnLink(encodeURIComponent('/chatty'))).toBeNull();
    expect(normalizeChatReturnLink(encodeURIComponent('//evil.example'))).toBeNull();
    expect(
      normalizeChatReturnLink(encodeURIComponent('https://evil.example/chat')),
    ).toBeNull();
    expect(normalizeChatReturnLink(encodeURIComponent('/\\evil'))).toBeNull();
    expect(normalizeChatReturnLink('')).toBeNull();
    expect(normalizeChatReturnLink(null)).toBeNull();
    expect(normalizeChatReturnLink(42)).toBeNull();
    expect(normalizeChatReturnLink('%')).toBeNull(); // broken encoding
    expect(normalizeChatReturnLink('x'.repeat(301))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3 — evidence/context on every consequential card
// ---------------------------------------------------------------------------

describe('the evidence/context guarantee', () => {
  it('the fallback context is honest — kind semantics, evidence links, no invented records', () => {
    for (const kind of CHAT_CARD_KINDS) {
      const context = fallbackCardContext(kind);
      expect(context.subtitle).toContain(chatCardKindLabel(kind));
      const kinds = context.sections.map((section) => section.kind);
      expect(kinds).toContain('why');
      expect(kinds).toContain('evidence');
      const links = context.sections.flatMap((section) => section.links);
      expect(links.some((link) => link.href === '/evidence')).toBe(true);
      expect(links.some((link) => link.href === '/explain')).toBe(true);
    }
  });

  it('a stored card without context degrades to the fallback, never to null', () => {
    // The W060-era shape: no context field at all.
    const legacy = normalizeChatCard({
      kind: 'risk',
      id: 'r-1',
      title: 'Conflicting broker statements',
      statusLabel: 'Conflicting evidence',
      meta: [],
      href: '/risks',
      decision: null,
    });
    expect(legacy?.context).not.toBeNull();
    expect(legacy?.context?.sections.length).toBeGreaterThan(0);

    // A foreign/garbage context shape also degrades to the fallback.
    const foreign = normalizeChatCard({
      kind: 'approval',
      id: 'a-1',
      title: 'Employee messaging',
      context: { sections: 'not-an-array' },
    });
    expect(foreign?.context).not.toBeNull();
    expect(foreign?.context?.sections.some((s) => s.kind === 'evidence')).toBe(
      true,
    );
  });

  it('a stored card WITH context keeps its own richer context', () => {
    const context: ChatCardContext = {
      subtitle: 'rich',
      sections: [
        {
          kind: 'evidence',
          title: 'Evidence',
          lines: ['3 observations'],
          links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
        },
      ],
    };
    const card = normalizeChatCard({
      kind: 'unknown',
      id: 'u-1',
      title: 'Renegotiation timing',
      context,
    });
    expect(card?.context?.subtitle).toBe('rich');
  });
});

// ---------------------------------------------------------------------------
// 4 — the explainability loop and the drawer enrichment
// ---------------------------------------------------------------------------

function answerFixture(executionId: string | null): ChatAnswer {
  return {
    intent: 'attention',
    mode: 'deterministic',
    headline: 'H',
    bullets: [],
    note: null,
    cards: [],
    citations: [],
    executionId,
  };
}

describe('the explainability hrefs', () => {
  it('answers with an execution link to the reconstruction', () => {
    const executionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(answerExplainHref(answerFixture(executionId))).toBe(
      `/explain/execution/${executionId}`,
    );
    expect(answerExplainHref(answerFixture(null))).toBeNull();
  });

  it('approval and recommendation cards link to the action-request reconstruction', () => {
    const approval: ChatCard = {
      kind: 'approval',
      id: 'req-1',
      title: 'Employee messaging',
      statusLabel: 'Needs your decision',
      tone: 'warning',
      meta: [],
      href: '/approvals',
      linkLabel: null,
      decision: { requestId: 'req-1', status: 'pending' },
      context: null,
    };
    const recommendation: ChatCard = {
      kind: 'recommendation',
      id: 'req-2',
      title: 'Supplier change',
      statusLabel: 'Awaiting decision',
      tone: 'info',
      meta: [],
      href: '/recommendations',
      linkLabel: null,
      decision: null,
      context: null,
    };
    const goal: ChatCard = {
      kind: 'goal',
      id: 'g-1',
      title: 'Freshness',
      statusLabel: 'Active',
      tone: 'positive',
      meta: [],
      href: '/goals',
      linkLabel: null,
      decision: null,
      context: null,
    };
    expect(cardExplainHref(approval)).toBe('/explain/action/req-1');
    expect(cardExplainHref(recommendation)).toBe('/explain/action/req-2');
    // Non-action cards ride the answer's execution link instead.
    expect(cardExplainHref(goal)).toBeNull();
    // A decided approval keeps its reconstruction (the decision trail).
    const decided: ChatCard = {
      ...approval,
      decision: { requestId: 'req-1', status: 'approved' },
    };
    expect(cardExplainHref(decided)).toBe('/explain/action/req-1');
  });
});

describe('the drill href and the pending-decision predicate', () => {
  const card: ChatCard = {
    kind: 'unknown',
    id: 'u-1',
    title: 'Renegotiation timing',
    statusLabel: 'Open',
    tone: 'warning',
    meta: [],
    href: '/intelligence/unknowns/u-1',
    linkLabel: null,
    decision: null,
    context: null,
  };

  it('the drill href carries the return link', () => {
    const back = chatReturnLink('c-1', 'm-1');
    expect(cardDrillHref(card, back)).toBe(
      `/intelligence/unknowns/u-1?${CHAT_RETURN_PARAM}=${encodeURIComponent(back)}`,
    );
    expect(cardDrillHref(card, null)).toBe('/intelligence/unknowns/u-1');
  });

  it('any card with a still-pending request offers the inline decision affordance', () => {
    expect(isPendingDecisionCard(card)).toBe(false);
    const pending: ChatCard = {
      ...card,
      kind: 'approval',
      decision: { requestId: 'r', status: 'pending' },
    };
    const approved: ChatCard = {
      ...card,
      kind: 'approval',
      decision: { requestId: 'r', status: 'approved' },
    };
    expect(isPendingDecisionCard(pending)).toBe(true);
    expect(isPendingDecisionCard(approved)).toBe(false);
  });
});

describe('enrichCardContextLinks (the drawer inherits the return context)', () => {
  it('every internal section link carries the return link; foreign hrefs pass through', () => {
    const back = chatReturnLink('c-1', 'm-1');
    const context: ChatCardContext = {
      subtitle: 'sub',
      sections: [
        {
          kind: 'evidence',
          title: 'Evidence',
          lines: [],
          links: [
            { label: 'Open the Evidence surface', href: '/evidence' },
            { label: 'Foreign', href: 'https://elsewhere.example/x' },
          ],
        },
      ],
    };
    const enriched = enrichCardContextLinks(context, back);
    expect(enriched.sections[0]?.links[0]?.href).toBe(
      `/evidence?${CHAT_RETURN_PARAM}=${encodeURIComponent(back)}`,
    );
    expect(enriched.sections[0]?.links[1]?.href).toBe(
      'https://elsewhere.example/x',
    );
    // The original context is not mutated (the drawer payload is derived).
    expect(context.sections[0]?.links[0]?.href).toBe('/evidence');
  });

  it('without a return link the context is returned as-is', () => {
    const context: ChatCardContext = {
      subtitle: null,
      sections: [
        { kind: 'why', title: 'Why', lines: ['x'], links: [] },
      ],
    };
    expect(enrichCardContextLinks(context, null)).toEqual(context);
  });
});

// ---------------------------------------------------------------------------
// 5 — the rendered timeline (the continuity guarantees in the DOM)
// ---------------------------------------------------------------------------

import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { ProductShellProvider } from '../../components/product-shell-provider';
import { ChatWorkspace } from '../components/chat-workspace';
import { CHAT_STARTERS } from '../../lib/chat-starters';
import type { ChatMessageView, ChatStateView } from '../lib/chat-types';

const CONVERSATION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const MEMBER_MESSAGE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const AURUM_MESSAGE_ID = 'cccccccc-3333-4333-8333-333333333333';
const EXECUTION_ID = 'eeeeeeee-4444-4444-8444-444444444444';

/** A thread whose Aurum reply carries cards, a citation and an execution. */
function continuityThreadState(): ChatStateView {
  const reply: ChatMessageView = {
    id: AURUM_MESSAGE_ID,
    side: 'aurum',
    speaker: 'Aurum',
    text: 'Two items need you.',
    sentAt: '2026-10-14T09:05:00.000',
    starterId: null,
    answer: {
      intent: 'attention',
      mode: 'deterministic',
      headline: 'Here’s what needs your attention right now.',
      bullets: [],
      note: null,
      cards: [
        {
          kind: 'approval',
          id: 'req-approve-1',
          title: 'Employee messaging',
          statusLabel: 'Needs your decision',
          tone: 'warning',
          meta: ['Authority: ASK'],
          href: '/approvals',
          linkLabel: null,
          decision: { requestId: 'req-approve-1', status: 'pending' },
          context: {
            subtitle: 'Pending action request (W009)',
            sections: [
              {
                kind: 'approval',
                title: 'What is being asked',
                lines: ['Ask June about the customs broker change.'],
                links: [
                  { label: 'Open Approvals (management mode)', href: '/approvals' },
                ],
              },
            ],
          },
        },
        {
          kind: 'unknown',
          id: 'u-1',
          title: 'Renegotiation timing',
          statusLabel: 'Open',
          tone: 'warning',
          meta: [],
          href: '/intelligence/unknowns/u-1',
          linkLabel: 'Open the intelligence workflow',
          decision: null,
          context: {
            subtitle: null,
            sections: [
              {
                kind: 'why',
                title: 'Why this matters',
                lines: ['Without the reason, renegotiation timing is a guess.'],
                links: [],
              },
            ],
          },
        },
      ],
      citations: [
        {
          kind: 'observation',
          id: 'obs-1',
          label: 'freshness.sample · Roastery WMS',
          detail: 'Observed October 12',
          href: '/evidence',
        },
      ],
      executionId: EXECUTION_ID,
    },
    pending: false,
  };
  const member: ChatMessageView = {
    id: MEMBER_MESSAGE_ID,
    side: 'member',
    speaker: 'You',
    text: 'What needs my attention?',
    sentAt: '2026-10-14T09:00:00.000',
    starterId: 'attention',
    answer: null,
    pending: false,
  };
  return {
    generatedAt: '2026-10-14T09:06:00.000',
    conversations: [
      {
        id: CONVERSATION_ID,
        title: 'Freshness goal drift',
        lastMessageAt: '2026-10-14T09:05:00.000',
        messageCount: 2,
        preview: 'Aurum: Two items need you.',
      },
    ],
    thread: { id: CONVERSATION_ID, title: 'Freshness goal drift', messages: [member, reply] },
  };
}

async function renderWorkspace(initial: ChatStateView): Promise<string> {
  const element = createElement(
    ProductShellProvider,
    null,
    createElement(ChatWorkspace, {
      tenantId: 'tenant-a',
      principalName: 'Ops Lead',
      starters: CHAT_STARTERS,
      initial,
      starterQuery: null,
    }),
  );
  const stream = await renderToReadableStream(element);
  return await new Response(stream).text();
}

describe('the rendered timeline carries the continuity contract', () => {
  it('every message renders its stable anchor id (return links land on the exact message)', async () => {
    const html = await renderWorkspace(continuityThreadState());
    expect(html).toContain(`id="m-${MEMBER_MESSAGE_ID}"`);
    expect(html).toContain(`id="m-${AURUM_MESSAGE_ID}"`);
  });

  it('card Open links carry the conversation return link (?back=)', async () => {
    const html = await renderWorkspace(continuityThreadState());
    const back = encodeURIComponent(
      `/chat?c=${CONVERSATION_ID}#m-${AURUM_MESSAGE_ID}`,
    );
    // The approval card drills into management mode with the way home.
    expect(html).toContain(`href="/approvals?back=${back}"`);
    // The workflow card drills into the intelligence surface with it too.
    expect(html).toContain(`href="/intelligence/unknowns/u-1?back=${back}"`);
    // The label override still renders (W061's product-mode links).
    expect(html).toContain('Open the intelligence workflow');
  });

  it('the message-level explainability link opens the reconstruction and returns', async () => {
    const html = await renderWorkspace(continuityThreadState());
    const back = encodeURIComponent(
      `/chat?c=${CONVERSATION_ID}#m-${AURUM_MESSAGE_ID}`,
    );
    expect(html).toContain('Why this answer?');
    expect(html).toContain(`href="/explain/execution/${EXECUTION_ID}?back=${back}"`);
  });

  it('approval cards offer the decision reconstruction (Explain decision)', async () => {
    const html = await renderWorkspace(continuityThreadState());
    const back = encodeURIComponent(
      `/chat?c=${CONVERSATION_ID}#m-${AURUM_MESSAGE_ID}`,
    );
    expect(html).toContain('Explain decision');
    expect(html).toContain(`href="/explain/action/req-approve-1?back=${back}"`);
    // Non-action cards do not render the action-request reconstruction.
    expect(html).not.toContain('href="/explain/action/u-1');
  });

  it('citations carry the return link; the Why-this affordance stays present', async () => {
    const html = await renderWorkspace(continuityThreadState());
    const back = encodeURIComponent(
      `/chat?c=${CONVERSATION_ID}#m-${AURUM_MESSAGE_ID}`,
    );
    expect(html).toContain(`href="/evidence?back=${back}"`);
    expect(html.match(/class="aurum-chat-card-why"/g)?.length).toBe(2);
    // The inline decision affordance renders on the pending approval.
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="reject"');
  });
});
