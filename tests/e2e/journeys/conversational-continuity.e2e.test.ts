// W072 — the conversational intelligence continuity journey (end to end,
// through the real surfaces the browser receives).
//
// WHAT THIS PROVES (the W072 acceptance, walked as a user would):
//
//   1. THE CONVERSATION IS ANCHORED — a chat turn's reply renders with a
//      stable message anchor (`id="m-<message>"`), so any link that
//      addresses the conversation can land on the exact message.
//   2. EVERY DRILL-DOWN CARRIES THE WAY HOME — the card Open links and
//      the message-level "Why this answer?" link carry the guarded
//      return link (`?back=/chat?c=<conversation>#m-<message>`).
//   3. THE DRILL-DOWN RETURNS — the intelligence workflow pages and the
//      explainability reconstruction render "Back to the conversation"
//      when (and only when) the parameter is a real internal /chat link;
//      a refused value renders no dead affordance.
//   4. THE CHAIN KEEPS THE CONTEXT — walking the intelligence chain
//      (goal → unknown/mission) preserves the conversation return link
//      at every hop.
//   5. PROACTIVE FINDINGS ENTER THE CONVERSATION — the briefing delivery
//      lands in the persistent intelligence thread as cards with
//      evidence/context, and their drill-downs carry the way back.
//
// The deterministic W068 demo world provides the data; the send goes
// through the real chat API handler; the renders go through the real
// page components + layouts (the SSR harness).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorId,
  apiRequest,
  demoWorld,
  renderOk,
  shutdownWorld,
  signInPersona,
  type DemoSeedReport,
  type PersonaSession,
} from './harness';
import { handleChatSendPost } from '../../../src/app/(product)/chat/lib/chat-api';
import { handleBriefingDeliverPost } from '../../../src/app/(product)/intelligence/lib/api';
import type { ChatMessageView } from '../../../src/app/(product)/chat/lib/chat-types';

let report: DemoSeedReport;
let manager: PersonaSession;
let conversationId: string;
let goalId: string;

beforeAll(async () => {
  report = await demoWorld();
  manager = await signInPersona('manager');
  conversationId = anchorId(report, 'employee-chat', 'conversation-freshness');
  goalId = anchorId(report, 'unprompted-discovery', 'goal-freshness');
});

afterAll(async () => {
  await shutdownWorld();
});

// ---------------------------------------------------------------------------
// 1+2 — a live turn: anchors and back-carrying drill-downs
// ---------------------------------------------------------------------------

describe('W072 — a live chat turn and its drill-downs', () => {
  let reply: ChatMessageView | null = null;
  let executionId: string | null = null;

  it('answers through the real workflow (cards, execution, citations)', async () => {
    const result = await handleChatSendPost(
      apiRequest('/api/product/chat/messages', manager, {
        body: {
          conversationId,
          text: 'What needs my attention?',
          starterId: 'attention',
        },
      }),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body['chat']).toBe('turn');
    executionId = (result.body['executionId'] as string | undefined) ?? null;
    expect(executionId).not.toBeNull();
    reply = result.body['reply'] as ChatMessageView;
    expect(reply).not.toBeNull();
    expect(reply!.answer?.cards.length ?? 0).toBeGreaterThan(0);
    // The composition-level guarantee: EVERY card carries evidence/context.
    for (const card of reply!.answer?.cards ?? []) {
      expect(card.context).not.toBeNull();
      expect(card.context?.sections.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('renders the reply with its stable message anchor and back-carrying drill-downs', async () => {
    const { html } = await renderOk(`/chat?c=${conversationId}`, manager);
    expect(reply).not.toBeNull();
    // 1 — the anchor of the exact reply message.
    expect(html).toContain(`id="m-${reply!.id}"`);
    // 2 — every card's Open link carries the way home.
    const back = encodeURIComponent(`/chat?c=${conversationId}#m-${reply!.id}`);
    for (const card of reply!.answer?.cards ?? []) {
      expect(html).toContain(`href="${card.href}?back=${back}"`);
    }
    // The message-level explainability affordance.
    expect(html).toContain('Why this answer?');
    expect(html).toContain(`href="/explain/execution/${executionId}?back=${back}"`);
  });

  it('the explainability reconstruction returns to the exact message', async () => {
    const back = encodeURIComponent(`/chat?c=${conversationId}#m-${reply!.id}`);
    const { html } = await renderOk(
      `/explain/execution/${executionId}?back=${back}`,
      manager,
    );
    expect(html).toContain('Back to the conversation');
    // The rendered href is the decoded internal link (an <Link href>).
    expect(html).toContain(`href="/chat?c=${conversationId}#m-${reply!.id}"`);
  });

  it('a refused back parameter renders NO return affordance (no dead links, no smuggling)', async () => {
    const foreign = encodeURIComponent('/goals'); // not a /chat path
    const { html } = await renderOk(
      `/explain/execution/${executionId}?back=${foreign}`,
      manager,
    );
    expect(html).not.toContain('Back to the conversation');
    expect(html).not.toContain('aurum-chat-return');
  });
});

// ---------------------------------------------------------------------------
// 4 — the intelligence chain keeps the conversation context
// ---------------------------------------------------------------------------

describe('W072 — the intelligence chain keeps the context', () => {
  /** The guarded return link — computed per test (after beforeAll seeded). */
  const back = (): string => encodeURIComponent(`/chat?c=${conversationId}`);

  it('the goal chain page renders the way home when opened from chat', async () => {
    const { html } = await renderOk(`/intelligence/goals/${goalId}?back=${back()}`, manager);
    expect(html).toContain('Back to the conversation');
    expect(html).toContain(`href="/chat?c=${conversationId}"`);
  });

  it('the chain’s own drill-down links carry the return link forward', async () => {
    const { html } = await renderOk(`/intelligence/goals/${goalId}?back=${back()}`, manager);
    // Unknown/mission step links into the chain keep the context…
    expect(html).toMatch(/href="\/intelligence\/(unknowns|missions)\/[^"?]+\?back=/);
    // …and so do the evidence links.
    expect(html).toContain(`href="/evidence?back=${back()}"`);
  });

  it('a cold visit (no back) renders the chain without the return links', async () => {
    const { html } = await renderOk(`/intelligence/goals/${goalId}`, manager);
    expect(html).not.toContain('Back to the conversation');
    expect(html).not.toContain('?back=');
  });
});

// ---------------------------------------------------------------------------
// 5 — proactive findings enter the conversation (with the way back)
// ---------------------------------------------------------------------------

describe('W072 — proactive findings enter the conversation', () => {
  it('delivers the briefing into the persistent intelligence thread', async () => {
    const result = await handleBriefingDeliverPost(
      apiRequest('/api/product/intelligence/briefing/deliver', manager, { body: {} }),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body['delivered']).toBe(true);
    expect(typeof result.body['conversationId']).toBe('string');
    expect((result.body['findingCount'] as number) ?? 0).toBeGreaterThan(0);
  });

  it('the briefing renders as cards whose drill-downs carry the way home', async () => {
    // The delivery result's conversation id (re-deliver to read it — the
    // second call is the digest no-op, and still returns the thread).
    const result = await handleBriefingDeliverPost(
      apiRequest('/api/product/intelligence/briefing/deliver', manager, { body: {} }),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const conversationId = result.body['conversationId'] as string;

    const { html } = await renderOk(`/chat?c=${conversationId}`, manager);
    // The briefing turn renders with its message anchor…
    expect(html).toMatch(/id="m-[0-9a-f-]{36}"/);
    // …as W060-era cards (workflow links, why-this affordances)…
    expect(html).toContain('Open the intelligence workflow');
    expect(html.match(/class="aurum-chat-card-why"/g)?.length ?? 0).toBeGreaterThan(0);
    // …and every workflow drill-down carries the way home.
    expect(html).toMatch(/href="\/intelligence\/[^"?]+\?back=/);
  });
});
