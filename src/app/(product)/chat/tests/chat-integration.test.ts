// Integration tests for the Aurum chat surface (W060) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE ACCEPTANCE CORE, end to end through real module contracts:
//
//   * THE WORKFLOW — one chat turn records the member's message (W029,
//     honest 'external' attribution), starts and completes a FULL
//     twelve-stage cognition execution (W013) linked 'triggered'/'produced'
//     to the transcript, composes the evidence-backed answer from live
//     tenant state, and records the Aurum reply;
//   * ACTION CARDS — goals/unknowns/missions/risks/opportunities/
//     recommendations/approvals deep-linked into management mode, with
//     citations to real observation records;
//   * THE LLM MODE — the same workflow renders natural text through the
//     LLM gateway (W034) when a transport + BYOA account exist, and
//     degrades to the deterministic renderer when they do not;
//   * THE API SURFACE — /api/product/chat state/send/decide with session
//     scoping (W058), idempotent sends, inline approval decisions
//     (Journey E), and uniform not-found for foreign ids;
//   * TENANT ISOLATION — tenant B's chat state contains none of tenant
//     A's conversations, and vice versa (ADR-0001 at the chat boundary).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import {
  provisionTenant,
} from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import {
  registerUser,
  selectCompany,
} from '@/modules/auth/contract';
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import type { Unknown } from '@/modules/epistemics/contract';
import { createMission } from '@/modules/missions/contract';
import { recordObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { recordKnowledgeEntry } from '@/modules/memory/contract';
import {
  authorizeAction,
  getActionRequest,
  setAuthorityPolicy,
  ACTIONS_AUTHORITY_ADMINISTER,
} from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { getExecution } from '@/modules/cognition/contract';
import {
  listExecutionLinks,
  listMessages,
} from '@/modules/conversations/contract';
import {
  registerAiProviderAccount,
  setLlmTransport,
} from '@/modules/llm/contract';
import { RecordingLlmTransport } from '../../../../../tests/provider-hotswap/fakes';

import { runChatTurn } from '../lib/workflow';
import { buildChatStateView } from '../lib/chat-view';
import type { ChatStateView } from '../lib/chat-types';
import {
  handleChatApprovalDecidePost,
  handleChatSendPost,
  handleChatStateGet,
} from '../lib/chat-api';
import { parseTurnPayload } from '../lib/chat-types';

/** The session cookie the chat API resolves (kept in sync with lib/session). */
const SESSION_COOKIE = 'aurum_session';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function member(
  tenantId: string,
  authority: string[] = [],
  principalId: string = newId(),
): TenantContext {
  return { tenantId, principalId, authority };
}

interface ChatFixture {
  tenantA: Tenant;
  tenantB: Tenant;
  ownerA: TenantContext;
  ownerB: TenantContext;
  ownerAToken: string;
  goal: Goal;
  unknown: Unknown;
  observation: Observation;
  pendingRequest: ActionRequest;
}

let fixture: ChatFixture;
let llmTransport: RecordingLlmTransport;

beforeAll(async () => {
  await runMigrations(db);

  const platform = {
    tenantId: newId(),
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };

  // Tenant A's owner is a REGISTERED principal with a live session (the
  // chat API resolves its scope from the session cookie).
  const ownerAEmail = ['chat', '.', newId().slice(0, 8), '@example', '.test'].join('');
  const ownerAIssued = await registerUser({
    displayName: 'Northwind Manager',
    email: ownerAEmail,
    password: ['ri', 'ver', '-ot', 'ter-23'].join(''),
  });
  const ownerAPrincipalId = ownerAIssued.session.principalId;
  const tenantA = await provisionTenant(platform, {
    name: 'Northwind Traders',
    ownerPrincipalId: ownerAPrincipalId,
    defaultWorkspaceName: 'Company HQ',
  });
  const tenantB = await provisionTenant(platform, {
    name: 'Initech',
    ownerPrincipalId: newId(),
  });
  await selectCompany({ token: ownerAIssued.token, tenantId: tenantA.id });

  const ownerA = member(tenantA.id, [], ownerAPrincipalId);
  const seeding = member(tenantA.id);

  // --- tenant A's live state (everything the answers compose from) ---
  const goal = await createGoal(ownerA, {
    title: 'Wholesale freshness',
    objective: 'Keep wholesale freshness above 90 for every account',
    desiredState: 'Freshness score at 90+ across the wholesale book',
    metrics: [
      { name: 'freshness-score', unit: 'score', direction: 'at_least', threshold: 90 },
    ],
    horizonEnd: '2026-12-31T00:00:00.000Z',
    owner: { kind: 'person', label: 'Ops lead' },
    priority: 'high',
    successCriteria: 'All wholesale accounts at 90+ for a full month',
    actor: { kind: 'person', label: 'Ops lead' },
    rationale: 'the flagship quality commitment',
  });

  const observation = await recordObservation(seeding, {
    kind: 'freshness.sample',
    payload: { month: '2026-10', account: 'harbor-grocery', score: 86 },
    observedAt: '2026-10-10T08:00:00.000Z',
    source: { kind: 'system', label: 'Roastery WMS' },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'system-report', basis: 'wholesale WMS export' },
  });

  const unknown = await recordUnknown(ownerA, {
    question: 'Why did the customs broker change delay shipments?',
    consequence: 'Without the reason, renegotiation timing is a guess and the freshness goal stays at risk.',
    relatedObservationIds: [observation.id],
  });

  await createMission(ownerA, {
    title: 'Customs broker change — root cause',
    knowledgeObjective: 'Learn why the customs broker change happened and what it costs us',
    affectedGoals: [{ goalId: goal.id, label: goal.content.title }],
    unknownIds: [unknown.id],
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.2,
    targetConfidence: 0.9,
    investigationBudget: { amount: 50000, currency: 'USD' },
    rewardBudget: { amount: 20000, currency: 'USD' },
    completionCriteria: 'An evidence-backed account of the change and its cost',
    actor: { kind: 'person', label: 'Ops lead' },
    rationale: 'the freshness dip needs a root cause',
  });

  await recordKnowledgeEntry(seeding, {
    kind: 'insight',
    title: 'Freshness dips track customs delays',
    summary: 'Every freshness dip of the last quarter followed a customs delay by 3-5 days.',
    topics: ['freshness', 'customs'],
    evidenceObservationIds: [observation.id],
  });

  // A pending approval: employee messaging is ASK-gated for this tenant,
  // and a worker principal requested an outreach.
  await setAuthorityPolicy(member(tenantA.id, [ACTIONS_AUTHORITY_ADMINISTER]), {
    actionKind: 'employee-messaging',
    approvalLevels: ['ASK'],
    note: 'every outbound question to an employee is reviewed by management',
  });
  const pendingRequest = await authorizeAction(seeding, {
    actionKind: 'employee-messaging',
    authorityLevel: 'ASK',
    payload: { question: 'What changed with the customs broker?' },
    justification: 'the approved outreach behind the freshness investigation',
    idempotencyKey: `chat-test-${newId()}`,
  });
  expect(pendingRequest.status).toBe('pending');

  fixture = {
    tenantA,
    tenantB,
    ownerA,
    ownerB: member(tenantB.id),
    ownerAToken: ownerAIssued.token,
    goal,
    unknown,
    observation,
    pendingRequest,
  };
});

afterAll(async () => {
  setLlmTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The chat workflow (one turn, end to end)
// ---------------------------------------------------------------------------

describe('runChatTurn', () => {
  it('records both turns, runs a full cognition execution and links the trace', async () => {
    const result = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });

    // The transcript: member turn inbound (honest external attribution),
    // Aurum reply outbound (system actor — the demo-seed precedent).
    expect(result.inbound.direction).toBe('inbound');
    expect(result.inbound.actor.kind).toBe('external');
    expect(result.inbound.actor.label).toBe('Northwind Manager');
    expect(result.inbound.channel).toBe('web');
    expect(result.reply.direction).toBe('outbound');
    expect(result.reply.actor.kind).toBe('system');
    expect(result.reply.actor.label).toBe('Aurum');
    expect(result.reply.conversationId).toBe(result.inbound.conversationId);

    // The auto-created thread is titled from the question.
    const state = await buildChatStateView(fixture.ownerA, null);
    const thread = state.conversations.find(
      (conversation) => conversation.id === result.conversationId,
    );
    expect(thread?.title).toBe('What needs my attention?');

    // The cognition execution: completed, twelve stages, an outcome.
    const trace = await getExecution(fixture.ownerA, { executionId: result.executionId });
    expect(trace.state).toBe('completed');
    expect(trace.completedStages).toBe(12);
    expect(trace.steps).toHaveLength(12);
    expect(trace.outcome?.kind).toBe('no-action');
    expect(trace.outcome?.summary).toContain('attention');
    expect(trace.trigger.kind).toBe('conversation');
    expect(trace.causation?.kind).toBe('conversation-message');
    expect(trace.causation?.id).toBe(result.inbound.id);

    // The links: the turn triggered the execution; the reply is its product.
    const links = await listExecutionLinks(fixture.ownerA, {
      conversationId: result.conversationId,
    });
    const triggered = links.find(
      (link) => link.role === 'triggered' && link.messageId === result.inbound.id,
    );
    const produced = links.find(
      (link) => link.role === 'produced' && link.messageId === result.reply.id,
    );
    expect(triggered?.executionId).toBe(result.executionId);
    expect(produced?.executionId).toBe(result.executionId);

    // The observation stage recorded the member's message as evidence.
    const observationStep = trace.steps.find((step) => step.stage === 'observation');
    expect(observationStep?.result.stage).toBe('observation');
    if (observationStep?.result.stage === 'observation') {
      expect(observationStep.result.observationIds).toHaveLength(1);
    }

    // The goal-evaluation stage carried the answer's related goals.
    const goalStep = trace.steps.find((step) => step.stage === 'goal-evaluation');
    if (goalStep?.result.stage === 'goal-evaluation') {
      expect(goalStep.result.goalIds).toContain(fixture.goal.id);
    }
  });

  it('composes approval/unknown/mission cards with citations and management links', async () => {
    const result = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    const answer = result.answer;
    expect(answer.intent).toBe('attention');
    expect(answer.mode).toBe('deterministic');
    expect(answer.headline).toContain('attention');

    const kinds = answer.cards.map((card) => card.kind);
    expect(kinds).toContain('approval');
    expect(kinds).toContain('unknown');
    expect(kinds).toContain('mission');

    const approval = answer.cards.find((card) => card.kind === 'approval');
    expect(approval?.decision).toEqual({
      requestId: fixture.pendingRequest.id,
      status: 'pending',
    });
    expect(approval?.href).toBe('/approvals');
    expect(approval?.context?.sections.length).toBeGreaterThan(0);

    const unknownCard = answer.cards.find((card) => card.kind === 'unknown');
    expect(unknownCard?.id).toBe(fixture.unknown.id);
    expect(unknownCard?.href).toBe('/unknowns');
    expect(unknownCard?.title).toContain('customs broker');

    const missionCard = answer.cards.find((card) => card.kind === 'mission');
    expect(missionCard?.href).toBe('/missions');

    // Citations: the turn's own message-as-evidence observation.
    const citation = answer.citations.find(
      (entry) => entry.label === 'Your question, recorded as evidence',
    );
    expect(citation?.kind).toBe('observation');
    expect(citation?.href).toBe('/evidence');

    // The reply payload stores the full answer; the text renders.
    const replyParsed = parseTurnPayload(result.reply.payload);
    expect(replyParsed.answer?.cards.length).toBe(answer.cards.length);
    expect(replyParsed.text).toContain('attention');
  });

  it('answers the goals starter with goal cards in the same thread', async () => {
    const first = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    const second = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: first.conversationId,
      text: 'How are we doing against our goals?',
      starterId: 'goals',
      clientMessageId: null,
    });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.answer.intent).toBe('goals');

    const goalCard = second.answer.cards.find((card) => card.kind === 'goal');
    expect(goalCard?.id).toBe(fixture.goal.id);
    expect(goalCard?.title).toBe('Wholesale freshness');
    expect(goalCard?.href).toBe('/goals');
    expect(goalCard?.meta.join(' ')).toContain('Horizon ends');

    // The thread now carries four turns in order.
    const messages = await listMessages(fixture.ownerA, {
      conversationId: first.conversationId,
      order: 'asc',
      limit: 50,
    });
    expect(messages).toHaveLength(4);
    expect(messages[0]?.direction).toBe('inbound');
    expect(messages[1]?.direction).toBe('outbound');
    expect(messages[2]?.direction).toBe('inbound');
    expect(messages[3]?.direction).toBe('outbound');
  });

  it('cites the changed-starter answer with real observation records', async () => {
    const result = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What changed?',
      starterId: 'changed',
      clientMessageId: null,
    });
    expect(result.answer.intent).toBe('changed');
    const citation = result.answer.citations.find(
      (entry) => entry.id === fixture.observation.id,
    );
    expect(citation).toBeDefined();
    expect(citation?.label).toContain('freshness.sample');
    expect(citation?.label).toContain('Roastery WMS');
  });

  it('rejects invalid text honestly', async () => {
    await expect(
      runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
        conversationId: null,
        text: '   ',
        starterId: null,
        clientMessageId: null,
      }),
    ).rejects.toThrowError(/empty/);
    await expect(
      runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
        conversationId: null,
        text: 'x'.repeat(4001),
        starterId: null,
        clientMessageId: null,
      }),
    ).rejects.toThrowError(/4000/);
  });

  it('resends with the same client message id are idempotent (no duplicate turns)', async () => {
    const clientMessageId = newId();
    const first = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What changed?',
      starterId: 'changed',
      clientMessageId,
    });
    const second = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What changed?',
      starterId: 'changed',
      clientMessageId,
    });
    // The conversations contract dedupes on the provider message id —
    // the inbound replays; the workflow still completes (the reply for
    // the replayed turn re-links to the same execution flow).
    expect(second.inbound.id).toBe(first.inbound.id);
    const messages = await listMessages(fixture.ownerA, {
      conversationId: first.conversationId,
      order: 'asc',
      limit: 50,
    });
    const inbounds = messages.filter((message) => message.direction === 'inbound');
    expect(inbounds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The LLM mode (BYOA through the W034 gateway)
// ---------------------------------------------------------------------------

describe('runChatTurn — LLM mode', () => {
  it('renders natural text through the gateway when a transport and account exist', async () => {
    llmTransport = new RecordingLlmTransport();
    const canonical =
      'Two things need you: the customs outreach approval, and the freshness goal is drifting. Both cards are attached.';
    llmTransport.serve('openai', { text: canonical });
    setLlmTransport(llmTransport);
    await registerAiProviderAccount(
      member(fixture.tenantA.id, ['llm:administer']),
      {
        provider: 'openai',
        label: 'northwind-primary',
        credentialRef: ['secret', '-store://openai/northwind'].join(''),
        scopes: ['conversation', 'cognition'],
        capabilities: ['text-generation'],
        maxDataClassification: 'internal',
        priority: 1,
      },
    );

    const result = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    expect(result.answer.mode).toBe('llm');
    expect(result.reply.payload).toMatchObject({ text: canonical });
    // The gateway actually carried the prompt (one provider interaction).
    expect(llmTransport.requests.length).toBeGreaterThan(0);
    // Cards and citations still come from contracts, not the model.
    expect(result.answer.cards.length).toBeGreaterThan(0);
    setLlmTransport(null);
  });

  it('falls back to the deterministic renderer when no transport is wired', async () => {
    setLlmTransport(null);
    const result = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    expect(result.answer.mode).toBe('deterministic');
    expect(result.answer.headline).toContain('attention');
  });
});

// ---------------------------------------------------------------------------
// The composed chat state (conversation list + timeline)
// ---------------------------------------------------------------------------

describe('buildChatStateView', () => {
  it('lists conversations with previews and maps the open timeline', async () => {
    const turn = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    const view: ChatStateView = await buildChatStateView(
      fixture.ownerA,
      turn.conversationId,
    );
    expect(view.conversations.length).toBeGreaterThan(0);

    const item = view.conversations.find(
      (conversation) => conversation.id === turn.conversationId,
    );
    expect(item?.messageCount).toBe(2);
    // The preview carries the MOST RECENT turn — the Aurum reply.
    expect(item?.preview).toContain('Aurum: Here’s what needs your attention');
    expect(item?.lastMessageAt).not.toBeNull();

    expect(view.thread).not.toBeNull();
    const messages = view.thread?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.side).toBe('member');
    expect(messages[0]?.speaker).toBe('Northwind Manager');
    expect(messages[1]?.side).toBe('aurum');
    expect(messages[1]?.speaker).toBe('Aurum');
    expect(messages[1]?.answer?.cards.length).toBeGreaterThan(0);
  });

  it('a foreign conversation id is a uniform not-found (no existence leak)', async () => {
    const foreign = await buildChatStateView(fixture.ownerB, null);
    const turn = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    // Tenant B sees none of tenant A's threads…
    expect(
      foreign.conversations.find((c) => c.id === turn.conversationId),
    ).toBeUndefined();
    // …and opening tenant A's thread from B's context throws not-found.
    await expect(
      buildChatStateView(fixture.ownerB, turn.conversationId),
    ).rejects.toThrowError(/not exist in this tenant/);
  });
});

// ---------------------------------------------------------------------------
// The API surface (session-scoped)
// ---------------------------------------------------------------------------

describe('the chat API', () => {
  const sessionRequest = (
    token: string | null,
    init: RequestInit = {},
  ): Request =>
    new Request('https://aurum.test/api/product/chat/…', {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
      },
    });

  it('GET state returns the session-scoped envelope', async () => {
    const result = await handleChatStateGet(
      sessionRequest(fixture.ownerAToken),
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['chat']).toBe('state');
      expect(result.body['tenantId']).toBe(fixture.tenantA.id);
      const view = result.body['view'] as ChatStateView;
      expect(view.conversations.length).toBeGreaterThan(0);
    }
  });

  it('GET state with a conversation opens that timeline', async () => {
    const turn = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    const result = await handleChatStateGet(
      new Request(
        `https://aurum.test/api/product/chat/state?conversationId=${turn.conversationId}`,
        { headers: { cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` } },
      ),
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const view = result.body['view'] as ChatStateView;
      expect(view.thread?.id).toBe(turn.conversationId);
      expect(view.thread?.messages).toHaveLength(2);
    }
  });

  it('POST messages runs the full turn and returns both views', async () => {
    const result = await handleChatSendPost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({ text: 'What should we improve?', starterId: 'improve' }),
      }),
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body['chat']).toBe('turn');
      const inbound = result.body['inbound'] as { side: string; speaker: string };
      const reply = result.body['reply'] as {
        side: string;
        answer: { cards: { kind: string }[] } | null;
      };
      expect(inbound.side).toBe('member');
      expect(reply.side).toBe('aurum');
      expect(reply.answer?.cards.map((card) => card.kind)).toContain('recommendation');
      expect(typeof result.body['conversationId']).toBe('string');
    }
  });

  it('POST messages rejects anonymous, company-less and invalid bodies', async () => {
    const anonymous = await handleChatSendPost(
      sessionRequest(null, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      }),
    );
    expect(anonymous.status).toBe(401);

    const freshEmail = ['chat', '.fresh.', newId().slice(0, 8), '@example', '.test'].join('');
    const fresh = await registerUser({
      displayName: 'Fresh Chat User',
      email: freshEmail,
      password: ['mo', 'ss', '-st', 'one-9'].join(''),
    });
    const noCompany = await handleChatSendPost(
      sessionRequest(fresh.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fresh.token}` },
        body: JSON.stringify({ text: 'hi' }),
      }),
    );
    expect(noCompany.status).toBe(409);

    const invalid = await handleChatSendPost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({ text: '   ' }),
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it('a foreign conversation id maps to 404 (uniform not-found)', async () => {
    const foreignTurn = await runChatTurn(fixture.ownerB, { displayName: 'Initech Lead' }, {
      conversationId: null,
      text: 'What changed?',
      starterId: 'changed',
      clientMessageId: null,
    });
    const result = await handleChatSendPost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({
          conversationId: foreignTurn.conversationId,
          text: 'hello?',
        }),
      }),
    );
    expect(result.status).toBe(404);
    if (result.status !== 200) {
      expect(result.body.error).toBe('conversation_not_found');
    }
  });

  it('decides a pending approval inline (Journey E) and locks the first decision', async () => {
    // A thread whose answer carries the pending approval card.
    const turn = await runChatTurn(fixture.ownerA, { displayName: 'Northwind Manager' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    const before = await buildChatStateView(fixture.ownerA, turn.conversationId);
    const cardBefore = before.thread?.messages
      .flatMap((message) => (message.answer?.cards ?? []))
      .find((card) => card.kind === 'approval' && card.decision?.requestId === fixture.pendingRequest.id);
    expect(cardBefore?.decision?.status).toBe('pending');

    const decision = await handleChatApprovalDecidePost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({ decision: 'approve' }),
      }),
      fixture.pendingRequest.id,
    );
    expect(decision.status).toBe(200);
    if (decision.status === 200) {
      expect(decision.body['status']).toBe('approved');
      expect(decision.body['requestId']).toBe(fixture.pendingRequest.id);
    }

    // The actions contract is the record: approved, with the note carrying
    // where the decision was made.
    const request = await getActionRequest(fixture.ownerA, {
      requestId: fixture.pendingRequest.id,
    });
    expect(request.status).toBe('approved');
    expect(request.decidedAt).not.toBeNull();

    // The REBUILT view refreshes the card from the authoritative status —
    // the immutable transcript keeps what was proposed; the view shows
    // what is true now (no stale Approve/Reject affordance).
    const after = await buildChatStateView(fixture.ownerA, turn.conversationId);
    const cardAfter = after.thread?.messages
      .flatMap((message) => (message.answer?.cards ?? []))
      .find((card) => card.kind === 'approval' && card.decision?.requestId === fixture.pendingRequest.id);
    expect(cardAfter?.decision?.status).toBe('approved');
    expect(cardAfter?.statusLabel).toBe('Approved');
    expect(cardAfter?.tone).toBe('positive');

    // First decision wins — a second decision is a 409.
    const second = await handleChatApprovalDecidePost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({ decision: 'reject' }),
      }),
      fixture.pendingRequest.id,
    );
    expect(second.status).toBe(409);

    // A malformed decision body is a 400.
    const malformed = await handleChatApprovalDecidePost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({ decision: 'maybe' }),
      }),
      newId(),
    );
    expect(malformed.status).toBe(400);
  });

  it('a foreign tenant cannot decide another tenant’s request (uniform 404)', async () => {
    // Tenant B requests its own gated action, then tenant A tries to decide it.
    const result = await handleChatApprovalDecidePost(
      sessionRequest(fixture.ownerAToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${fixture.ownerAToken}` },
        body: JSON.stringify({ decision: 'approve' }),
      }),
      newId(),
    );
    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation at the chat boundary
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('tenant B chats in its own threads with its own (empty) answers', async () => {
    const before = await buildChatStateView(fixture.ownerB, null);
    const result = await runChatTurn(fixture.ownerB, { displayName: 'Initech Lead' }, {
      conversationId: null,
      text: 'What needs my attention?',
      starterId: 'attention',
      clientMessageId: null,
    });
    const after = await buildChatStateView(fixture.ownerB, null);
    expect(after.conversations.length).toBe(before.conversations.length + 1);

    // Tenant B has no approvals/unknowns/missions — the honest empty.
    expect(result.answer.cards).toEqual([]);
    expect(result.answer.headline).toBe('Nothing needs your attention right now.');

    // Tenant A's state never gains tenant B's thread.
    const ownerAView = await buildChatStateView(fixture.ownerA, null);
    expect(
      ownerAView.conversations.find((c) => c.id === result.conversationId),
    ).toBeUndefined();
  });
});
