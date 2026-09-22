// W074 — the conversational interventions & approval continuity's DOM
// suite.
//
// WHAT THIS PROVES AND HOW. The intervention lane's chat pieces are a
// STRUCTURE contract inside the messenger: the intervention-proposal card
// renders INSIDE the message stream (embedded, never replacing it) with
// the inline human-decision affordances (Approve / Reject through the
// authority gate), the compared alternatives as scannable meta lines, the
// future grant and the human-employment safeguard note; the approved
// proposal card carries the Activate affordance; the intervention-agent
// card carries the scopes, the provenance and the
// retain/modify/terminate lifecycle context; and every drill-down (the
// proposal, the agent, the explainability reconstruction) carries the
// W072 return link so the reader keeps the way back to the exact message.
// Those guarantees live in the RENDERED MARKUP, so this suite
// server-renders the real ChatWorkspace (inside the real
// ProductShellProvider — exactly the provider/page tree /chat hydrates)
// through React's renderToReadableStream, the same technique as the
// W071/W073 DOM suites, and asserts the HTML.
//
// Pure presentation-fixture inputs: no DB, no API — the data flow is
// covered by the integration suite; this file owns the DOM shape only.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { ProductShellProvider } from '../../components/product-shell-provider';
import { ChatWorkspace } from '../../chat/components/chat-workspace';
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

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '99999999-9999-4999-8999-999999999999';

/** One Aurum turn carrying an intervention card, the shared card model. */
function interventionTurn(
  id: string,
  cardKind: 'intervention-proposal' | 'intervention-agent',
  decision: { requestId: string; status: 'pending' | 'approved' | 'rejected' } | null,
  extraMeta: string[] = [],
): ChatMessageView {
  const isProposal = cardKind === 'intervention-proposal';
  return {
    id,
    side: 'aurum',
    speaker: 'Aurum',
    text: isProposal
      ? 'A capability-gap recommendation needs your decision: "Cold-chain coverage for the Q4 peak".'
      : 'Activated — "Recruit a cold-chain monitoring agent" is registered as an organizational actor.',
    sentAt: localIso(at),
    starterId: null,
    answer: {
      intent: 'improve',
      mode: 'deterministic',
      headline: isProposal
        ? 'A capability-gap recommendation awaits a human decision'
        : 'Activation complete — the agent is an organizational actor',
      bullets: [],
      note: null,
      cards: [
        {
          kind: cardKind,
          id: isProposal ? PROPOSAL_ID : AGENT_ID,
          title: isProposal
            ? 'Cold-chain coverage for the Q4 peak'
            : 'Recruit a cold-chain monitoring agent',
          statusLabel: isProposal
            ? decision?.status === 'approved'
              ? 'Approved — activation available'
              : 'Needs your decision'
            : 'active',
          tone: isProposal ? 'warning' : 'positive',
          meta: isProposal
            ? [
                'Recommended: Recruit an agent — the fastest cover at the lowest cost',
                'Train an employee — Coach June on customs paperwork (400.00 USD · 4 weeks · +15% level)',
                'Recruit an agent — a governed marketplace agent (900.00 USD · 1 week · +30% level) · recommended',
                'Hire human capability — a seasonal coordinator (2,500.00 USD · 6 weeks · +25% level)',
                ...extraMeta,
              ]
            : [
                'Role: watch wholesale cold-chain freshness signals',
                'Scopes: observe / analyze',
                'From the approved proposal: Cold-chain coverage for the Q4 peak',
                'Lifecycle: retain / modify / terminate — decided by humans after measured evaluations',
              ],
          href: isProposal ? `/interventions/proposals/${PROPOSAL_ID}` : `/interventions/agents/${AGENT_ID}`,
          linkLabel: isProposal ? 'Open the proposal' : 'Open the agent detail',
          decision,
          context: {
            subtitle: isProposal
              ? 'A capability-gap acquisition comparison — decided by a human'
              : 'A recruited agent — an organizational actor with explicit scopes',
            sections: [
              {
                kind: 'policy',
                title: isProposal ? 'The human authority gate' : 'The lifecycle — retain, modify, terminate',
                lines: isProposal
                  ? [
                      'Aurum proposes the comparison; an authorized human decides the acquisition.',
                      'Separation of duties holds: whoever submitted the proposal can never decide it.',
                    ]
                  : [
                      'Every lifecycle decision follows a measured evaluation — no decision without evidence.',
                      'Employment decisions stay human-authorized — this agent is a capability, not a person.',
                    ],
                links: [],
              },
            ],
          },
        },
      ],
      citations: [
        {
          kind: 'action-request',
          id: REQUEST_ID,
          label: 'Authority-gate request — the human decision',
          detail: null,
          href: '/approvals',
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
        id: CONVERSATION_ID,
        title: 'Aurum interventions — recommendations & approvals',
        lastMessageAt: localIso(at),
        messageCount: threadMessages.length,
        preview: 'Aurum: A capability-gap recommendation needs your decision…',
      },
    ],
    thread: {
      id: CONVERSATION_ID,
      title: 'Aurum interventions — recommendations & approvals',
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

// ---------------------------------------------------------------------------
// The pending proposal card inside the timeline (the decision-time shape)
// ---------------------------------------------------------------------------

describe('the pending intervention-proposal card in the chat timeline', () => {
  it('renders embedded in the message stream with the inline human decision', async () => {
    const html = await renderWorkspace([
      interventionTurn('m-1', 'intervention-proposal', { requestId: REQUEST_ID, status: 'pending' }),
    ]);
    // The card is inside the bubble (embedded, not a pane of its own):
    // the shared aurum-chat-card structure, keyed by the W074 kind.
    expect(html).toContain('data-kind="intervention-proposal"');
    expect(html).toContain('Intervention proposal');
    expect(html).toContain('Cold-chain coverage for the Q4 peak');
    expect(html).toContain('Needs your decision');
    // THE INLINE HUMAN DECISION: Approve / Reject, the same 44px+ decide
    // button body the approval card uses.
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="reject"');
    expect(html).toContain('aurum-chat-decide');
    // The comparison, scannable: one meta line per compared alternative.
    expect(html).toContain('Train an employee — ');
    expect(html).toContain('Recruit an agent — ');
    expect(html).toContain('Hire human capability — ');
    expect(html).toContain('recommended');
    // The safeguard note (lock 20/21 — the human authority gate).
    expect(html).toContain('The human authority gate');
    expect(html).toContain('employment decisions stay human-authorized');
    // The shared affordances ride along.
    expect(html).toContain('Open the proposal');
    expect(html).toContain('Why this?');
    // The authority-gate citation renders in the same turn.
    expect(html).toContain('Authority-gate request');
  });

  it('carries the drill-down return link (the W072 continuity seam)', async () => {
    const html = await renderWorkspace([
      interventionTurn('m-1', 'intervention-proposal', { requestId: REQUEST_ID, status: 'pending' }),
    ]);
    // Every drill-down the card offers carries ?back=/chat?c=…#m-… so the
    // Interventions surface can offer the return affordance.
    expect(html).toContain(
      `back=${encodeURIComponent(`/chat?c=${CONVERSATION_ID}#m-m-1`)}`,
    );
    // The proposal deep link itself.
    expect(html).toContain(`/interventions/proposals/${PROPOSAL_ID}`);
    // The action-anchored explainability affordance (one governance truth).
    expect(html).toContain(`/explain/action/${REQUEST_ID}`);
  });

  it('renders the future grant line when the comparison carries a recruit', async () => {
    const html = await renderWorkspace([
      interventionTurn('m-1', 'intervention-proposal', { requestId: REQUEST_ID, status: 'pending' }, [
        'Proposed agent scopes: observe / analyze — implies propose authority (the gate reviews every execution)',
      ]),
    ]);
    expect(html).toContain('Proposed agent scopes: observe / analyze');
  });
});

// ---------------------------------------------------------------------------
// The approved proposal card (the activation-time shape)
// ---------------------------------------------------------------------------

describe('the approved intervention-proposal card in the chat timeline', () => {
  it('replaces the decision with the activation affordance', async () => {
    const html = await renderWorkspace([
      interventionTurn('m-1', 'intervention-proposal', { requestId: REQUEST_ID, status: 'approved' }),
    ]);
    expect(html).toContain('Approved — activation available');
    // No decision buttons anymore — the gate is settled.
    expect(html).not.toContain('data-decision="approve"');
    expect(html).not.toContain('data-decision="reject"');
    // THE ACTIVATION: the affordance that registers the agent.
    expect(html).toContain('data-decision="activate"');
    expect(html).toContain('Activate recruit');
    expect(html).toContain('aurum-intv-activate');
    // The activation safeguard (the future grant restated).
    expect(html).toContain('exactly the scopes the approved comparison proposed');
    expect(html).toContain('lifecycle (retain / modify / terminate) stays in human hands');
  });

  it('renders the rejected state without any consequential affordance', async () => {
    const html = await renderWorkspace([
      interventionTurn('m-1', 'intervention-proposal', { requestId: REQUEST_ID, status: 'rejected' }),
    ]);
    expect(html).toContain('Rejected');
    expect(html).not.toContain('data-decision="approve"');
    expect(html).not.toContain('data-decision="reject"');
    expect(html).not.toContain('data-decision="activate"');
    expect(html).not.toContain('Activate recruit');
  });
});

// ---------------------------------------------------------------------------
// The agent card (the activation outcome's lifecycle shape)
// ---------------------------------------------------------------------------

describe('the intervention-agent card in the chat timeline', () => {
  it('renders the scopes, the provenance and the lifecycle context', async () => {
    const html = await renderWorkspace([interventionTurn('m-1', 'intervention-agent', null)]);
    expect(html).toContain('data-kind="intervention-agent"');
    expect(html).toContain('Recruit a cold-chain monitoring agent');
    expect(html).toContain('Scopes: observe / analyze');
    expect(html).toContain('From the approved proposal: Cold-chain coverage for the Q4 peak');
    // The retain/modify/terminate lifecycle context, conversationally.
    expect(html).toContain('retain / modify / terminate');
    // The lifecycle safeguard (lock 21 — Aurum never autonomously
    // terminates a human employee).
    expect(html).toContain('never autonomously terminates a human employee');
    // The agent detail deep link + the shared affordances.
    expect(html).toContain(`/interventions/agents/${AGENT_ID}`);
    expect(html).toContain('Open the agent detail');
    expect(html).toContain('Why this?');
    // No decision or activation affordance on the agent card.
    expect(html).not.toContain('data-decision="approve"');
    expect(html).not.toContain('data-decision="activate"');
  });
});

// ---------------------------------------------------------------------------
// The messenger shape the lane rides (WhatsApp-like, left-aligned Aurum)
// ---------------------------------------------------------------------------

describe('the intervention lane rides the WhatsApp-like messenger shape', () => {
  it('the turns are left-aligned Aurum bubbles in the timeline with the persistent thread title', async () => {
    const html = await renderWorkspace([
      interventionTurn('m-1', 'intervention-proposal', { requestId: REQUEST_ID, status: 'pending' }),
      interventionTurn('m-2', 'intervention-agent', null),
    ]);
    expect(html).toContain('Aurum interventions — recommendations &amp; approvals');
    expect(html).toContain('data-side="aurum"');
    // The messages carry their anchors (the return link's #m-<id> target).
    expect(html).toContain('id="m-m-1"');
    expect(html).toContain('id="m-m-2"');
    // Two intervention cards, embedded in the stream (never replacing it).
    expect(html.match(/data-kind="intervention-proposal"/g)?.length).toBe(1);
    expect(html.match(/data-kind="intervention-agent"/g)?.length).toBe(1);
    // The comparison list keeps its hairline rhythm class.
    expect(html).toContain('aurum-intv-comparison');
  });
});
