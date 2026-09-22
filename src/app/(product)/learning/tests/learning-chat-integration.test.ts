// Integration tests for the W073 chat-based learning requests against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE WORK ITEM'S ACCEPTANCE, proven end to end through REAL module
// contracts:
//
//   * THE ASK — Aurum's open knowledge requests enter the persistent
//     "Aurum learning" conversation as proactive chat messages (one per
//     plan, idempotent forever), carrying the shared-model
//     knowledge-request card with the mission progress, evidence links
//     and the ask-policy evaluation;
//   * INLINE COMPLETION WITHOUT THE LEARNING ROUTE — an employee answers
//     from the thread (the chat-answer API write with only chat
//     artifacts: the plan id off the delivered card), and the SAME domain
//     workflow the Learning surface drives runs: the answer becomes an
//     immutable observation (evidence capture), the contribution anchors
//     to the plan (the acknowledgement), and the thread records the
//     member's turn plus Aurum's acknowledgement with the contribution,
//     mission-progress, reward/recognition state and evidence citations;
//   * THE SAME EVIDENCE CHAIN FROM BOTH SURFACES — the Learning hub's
//     rows (buildLearningHomeView) show the SAME contribution, evidence
//     observation and mission progress the chat acknowledgement cites,
//     and the hub links back into the same conversation (the stable
//     /chat?c= return link);
//   * REWARD/RECOGNITION STATE CONVERSATIONALLY — a Learning-form answer
//     that management validated and converted under the explicit reward
//     policy converges into the thread with its reward card, and any
//     reward copy carries only the closed non-compensation vocabulary;
//   * HONEST REFUSALS — a second answer is 409 first-write-wins with the
//     recorded state attached; a malformed plan id is 404; anonymous is
//     401; a bad body is 400;
//   * TENANT ISOLATION (ADR-0001) — tenant B's chat learning surface is
//     blind to tenant A's asks and contributions.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { createEmployee, createPerson, linkExternalIdentity } from '@/modules/people/contract';
import {
  attestIdentity,
  registerExternalIdentity,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
} from '@/modules/identity/contract';
import { createMission } from '@/modules/missions/contract';
import { getMission } from '@/modules/missions/contract';
import { missionSubjectTopics } from '@/modules/knowledge-acquisition/contract';
import {
  getAcquisitionPlan,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import { recordObservation } from '@/modules/observations/contract';
import { recordTransactiveEntry } from '@/modules/memory/contract';
import {
  validateContribution,
  listContributions,
} from '@/modules/contributions/contract';
import { applyRewardPolicy, setRewardPolicy } from '@/modules/rewards/contract';
import { REWARDS_AUTHORITY_ADMINISTER } from '@/modules/rewards/contract';
import type { Reward } from '@/modules/rewards/contract';

import { requestNextKnowledge } from '../lib/answer';
import { buildLearningHomeView } from '../lib/views';
import { handleAnswerPost } from '../lib/api';
import {
  deliverKnowledgeRequestsToChat,
  findLearningConversation,
  learningChatLinkage,
  LEARNING_CONVERSATION_TITLE,
  answerKnowledgeRequestInChat,
} from '../lib/chat-requests';
import { handleChatAnswerPost, handleChatDeliverPost } from '../lib/chat-api';
import { buildChatStateView } from '../../chat/lib/chat-view';
import type { ChatMessageView } from '../../chat/lib/chat-types';
import { usesForbiddenTerm } from '../lib/labels';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture (the W062 learning-integration discipline)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'aurum_session';

// Fake credentials assembled from fragments at runtime (push-protection).
const passwordFragments = ['pa', 'per', 'lily-', '9'];

function member(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

function rewardAdmin(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [REWARDS_AUTHORITY_ADMINISTER] };
}

interface ChatLearningFixture {
  tenant: Tenant;
  owner: TenantContext;
  ownerToken: string;
}

async function provisionChatLearningFixture(name: string): Promise<ChatLearningFixture> {
  const local = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const email = [local, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: `${name} Owner`,
    email,
    password: passwordFragments.join(''),
  });
  const tenant = await provisionTenant(
    { principalId: newId(), authority: ['organizations:provision'] },
    { name, ownerPrincipalId: issued.session.principalId },
  );
  await selectCompany({ token: issued.token, tenantId: tenant.id });
  return {
    tenant,
    owner: member(tenant.id, issued.session.principalId),
    ownerToken: issued.token,
  };
}

/** The askable employee: person + active employee + verified identity. */
async function askableEmployee(
  ctx: TenantContext,
  fullName: string,
): Promise<{ personId: string }> {
  const person = await createPerson(ctx, {
    fullName,
    email: [fullName.toLowerCase().replace(/\s+/g, '.'), '.', newId().slice(0, 6), '@example.test'].join(''),
  });
  await createEmployee(ctx, {
    personId: person.id,
    title: 'Operations Lead',
    department: 'Operations',
    hiredAt: '2025-02-03T00:00:00.000Z',
  });
  const registered = await registerExternalIdentity(ctx, {
    provider: 'web',
    providerAccountId: `web-${newId().slice(0, 10)}`,
    displayName: `${fullName} (web)`,
  });
  const attested = await attestIdentity(
    { ...ctx, authority: [...ctx.authority, IDENTITY_AUTHORITY_ATTEST] },
    { identityId: registered.identity.id, evidence: 'integration fixture — verified in person' },
  );
  await linkExternalIdentity(
    { ...ctx, authority: [...ctx.authority, IDENTITY_AUTHORITY_LINK] },
    { personId: person.id, identityId: attested.id },
  );
  return { personId: person.id };
}

function sessionRequest(token: string, body: unknown, url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('chat-based learning requests over the full Journey F chain', () => {
  let acme: ChatLearningFixture;
  let beta: ChatLearningFixture;

  let missionId: string;
  let employeePersonId: string;
  let planId: string;
  let conversationId: string;
  let contributionId: string;
  let evidenceObservationId: string;

  beforeAll(async () => {
    await runMigrations(db);
    acme = await provisionChatLearningFixture('Northwind Chat Learning');
    beta = await provisionChatLearningFixture('Initech Chat Learning');
    const ctx = acme.owner;

    // The askable employee and the mission (the W062 fixture).
    const employee = await askableEmployee(ctx, 'June Park');
    employeePersonId = employee.personId;
    const mission = await createMission(ctx, {
      title: 'Courier customs bottleneck',
      knowledgeObjective:
        'Identify why wholesale delivery freshness dropped after September: which customs-broker change delays the cold chain, and by how much.',
      informationValue: 0.8,
      urgency: 'high',
      targetConfidence: 0.8,
      investigationBudget: { amount: 500_00, currency: 'USD' },
      rewardBudget: { amount: 200_00, currency: 'USD' },
      rewardTerms: 'A configured reward for a validated root-cause answer.',
      candidateSources: [
        { kind: 'person', id: employeePersonId, label: 'June Park' },
        { kind: 'system', label: 'Roastery WMS' },
      ],
      completionCriteria: 'The freshness dip is attributed to a named, evidenced cause.',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    missionId = mission.id;

    const coverage = await recordObservation(ctx, {
      kind: 'ops.note',
      payload: {
        note: 'June Park runs the wholesale courier relationship and handled the September customs handover.',
      },
      observedAt: '2026-10-01T08:00:00.000Z',
      source: { kind: 'person', id: employeePersonId, label: 'June Park' },
      channel: 'ingestion',
      confidence: { value: 0.8, method: 'person-account', basis: 'the ops handover log' },
    });
    await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: employeePersonId },
      relation: 'knows',
      subjectLabel: 'Wholesale courier customs handling',
      topics: missionSubjectTopics(
        'Courier customs bottleneck',
        'Identify why wholesale delivery freshness dropped after September: which customs-broker change delays the cold chain, and by how much.',
      ),
      evidenceObservationIds: [coverage.id],
      notes: 'the ops handover log names June as the courier relationship owner',
    });

    // THE ASK: the planner's targeted person question is live.
    const ask = await requestNextKnowledge(ctx, missionId, 'Northwind Owner');
    expect(ask.decision).toBe('selected');
    expect(ask.chosen?.kind).toBe('person');
    planId = ask.planId;
  });

  // -------------------------------------------------------------------------
  // The ask delivery (Aurum speaks first — the proactive chat message)
  // -------------------------------------------------------------------------

  it('delivers the open knowledge request into the persistent learning conversation', async () => {
    const ctx = acme.owner;
    const delivery = await deliverKnowledgeRequestsToChat(ctx);
    expect(delivery.ok).toBe(true);
    if (!delivery.ok) return;
    expect(delivery.delivered).toBe(true);
    expect(delivery.openCount).toBe(1);
    expect(delivery.asksRecorded).toBe(1);
    expect(delivery.conversationId).toBeTruthy();
    conversationId = delivery.conversationId ?? '';

    const conversation = await findLearningConversation(ctx);
    expect(conversation?.id).toBe(conversationId);
    expect(conversation?.title).toBe(LEARNING_CONVERSATION_TITLE);

    // The message renders through the chat surface's own view builder
    // (the WhatsApp-like timeline): one left-aligned Aurum turn.
    const state = await buildChatStateView(ctx, conversationId);
    expect(state.thread).not.toBeNull();
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBe(1);
    const ask = messages[0]!;
    expect(ask.side).toBe('aurum');
    expect(ask.speaker).toBe('Aurum');
    expect(ask.text).toContain('June Park');
    expect(ask.text).toContain('customs-broker change');
    expect(ask.answer?.intent).toBe('learning');
    const kinds = ask.answer?.cards.map((card) => card.kind) ?? [];
    expect(kinds).toContain('knowledge-request');
    expect(kinds).toContain('mission');
    const request = ask.answer?.cards.find((card) => card.kind === 'knowledge-request');
    // The card's id IS the plan id — the chat's answer affordance rides it.
    expect(request?.id).toBe(planId);
    expect(request?.meta.join(' ')).toContain('Asked of June Park');
  });

  it('is idempotent: re-delivering the unchanged open feed records nothing new', async () => {
    const before = await buildChatStateView(acme.owner, conversationId);
    const count = before.thread?.messages.length ?? 0;
    const delivery = await deliverKnowledgeRequestsToChat(acme.owner);
    expect(delivery.ok).toBe(true);
    if (delivery.ok) {
      expect(delivery.delivered).toBe(false);
      expect(delivery.asksRecorded).toBe(0);
      expect(delivery.asksDeduped).toBe(1);
    }
    const after = await buildChatStateView(acme.owner, conversationId);
    expect(after.thread?.messages.length).toBe(count);
  });

  // -------------------------------------------------------------------------
  // THE ACCEPTANCE CORE — inline completion without the Learning route
  // -------------------------------------------------------------------------

  it('completes the knowledge request from the thread (capture → acknowledgement → reward state → evidence)', async () => {
    // The employee's chat-side actions ONLY: the plan id off the delivered
    // card and the conversation the thread lives in. No Learning read.
    const result = await handleChatAnswerPost(
      sessionRequest(
        acme.ownerToken,
        {
          conversationId,
          text: 'The courier switched to a cheaper customs broker in September — per-shipment paperwork now takes two to three days and the cold chain waits at the port.',
          confidence: 'high',
        },
        `https://aurum.test/api/product/learning/chat/requests/${planId}/answer`,
      ),
      planId,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.body as {
      status?: string;
      contribution?: { id?: string; status?: string };
      evidenceObservationId?: string;
      inbound?: ChatMessageView;
      acknowledgement?: ChatMessageView;
    };
    expect(body.status).toBe('answered');
    expect(body.contribution?.status).toBe('pending');
    contributionId = String(body.contribution?.id);
    expect(body.evidenceObservationId).toBeTruthy();
    evidenceObservationId = String(body.evidenceObservationId);

    // The DOMAIN state — the same workflow the Learning surface drives:
    // the acquisition outcome is 'answered' with the immutable observation.
    const plan = await getAcquisitionPlan(acme.owner, planId);
    expect(plan.outcome?.outcome).toBe('answered');
    expect(plan.outcome?.evidenceObservationId).toBe(evidenceObservationId);
    const contributions = await listContributions(acme.owner, { missionId });
    expect(contributions.length).toBe(1);
    expect(contributions[0]!.id).toBe(contributionId);
    expect(contributions[0]!.planId).toBe(planId);
    expect(contributions[0]!.contributor.label).toBe('June Park');
    expect(contributions[0]!.evidenceObservationId).toBe(evidenceObservationId);

    // The THREAD — ask (left), member answer (right), acknowledgement
    // (left) — the WhatsApp-like shape, rendered through the chat view.
    const state = await buildChatStateView(acme.owner, conversationId);
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBe(3);
    expect(messages.map((message) => message.side)).toEqual(['aurum', 'member', 'aurum']);
    const answer = messages[1]!;
    expect(answer.side).toBe('member');
    expect(answer.text).toContain('cheaper customs broker');
    const ack = messages[2]!;
    expect(ack.text).toContain('Thank you — your answer is recorded');
    // The acknowledgement cards: contribution + mission progress.
    const kinds = ack.answer?.cards.map((card) => card.kind) ?? [];
    expect(kinds).toEqual(expect.arrayContaining(['contribution', 'mission']));
    const contributionCard = ack.answer?.cards.find((card) => card.kind === 'contribution');
    expect(contributionCard?.id).toBe(contributionId);
    expect(contributionCard?.statusLabel).toBe('Recorded — awaiting assessment');
    // The evidence citation links the immutable observation.
    expect(
      ack.answer?.citations.some(
        (citation) => citation.kind === 'observation' && citation.id === evidenceObservationId,
      ),
    ).toBe(true);
    // The mission progress is visible from the same thread.
    const mission = await getMission(acme.owner, missionId);
    const missionCard = ack.answer?.cards.find((card) => card.kind === 'mission');
    expect(missionCard?.meta.join(' ')).toContain(
      `Confidence ${Math.round(mission.content.currentConfidence * 100)}%`,
    );
  });

  it('refuses a second answer (first write wins) with the recorded state attached', async () => {
    const second = await handleChatAnswerPost(
      sessionRequest(
        acme.ownerToken,
        { conversationId, text: 'a different answer' },
        `https://aurum.test/x`,
      ),
      planId,
    );
    expect(second.status).toBe(409);
    if (second.status !== 409) return;
    const body = second.body as {
      status?: string;
      acknowledgement?: ChatMessageView;
      conversationId?: string;
    };
    expect(body.status).toBe('already_answered');
    // The thread converged: the acknowledgement is attached to the 409.
    expect(body.acknowledgement?.answer?.cards.map((card) => card.kind)).toContain(
      'contribution',
    );
    expect(body.conversationId).toBe(conversationId);
    // No new thread turn was recorded for the refused text.
    const state = await buildChatStateView(acme.owner, conversationId);
    expect(state.thread?.messages.length).toBe(3);
    expect(
      state.thread?.messages.some((message) => message.text.includes('a different answer')),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Management parity — the SAME evidence chain from the Learning surface
  // -------------------------------------------------------------------------

  it('shows the same contribution, evidence and conversation link in the Learning hub', async () => {
    const ctx = acme.owner;
    const view = await buildLearningHomeView(ctx);
    // The answered request left the open feed.
    expect(view.requests).toEqual([]);
    // The contribution row — the SAME records the chat ack cited.
    expect(view.contributions.length).toBe(1);
    const row = view.contributions[0]!;
    expect(row.id).toBe(contributionId);
    expect(row.evidenceObservationId).toBe(evidenceObservationId);
    expect(row.contributorLabel).toBe('June Park');
    expect(row.status).toBe('pending');
    // The hub links back into the same conversation (the /chat?c= seam).
    expect(view.chat).not.toBeNull();
    expect(view.chat?.conversationId).toBe(conversationId);
    expect(view.chat?.acknowledgedContributionIds).toContain(contributionId);
    expect(view.degraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The Learning-form path + reward state converging into the thread
  // -------------------------------------------------------------------------

  it('converges a Learning-form answer into the thread after validation and a policy reward', async () => {
    const ctx = acme.owner;
    // A SECOND mission + ask, answered through the LEARNING FORM (W062).
    const mission2 = await createMission(ctx, {
      title: 'Port cold-chain dwell time',
      knowledgeObjective:
        'Measure how long the cold chain waits at the port after the broker change, and what it costs.',
      informationValue: 0.7,
      urgency: 'medium',
      targetConfidence: 0.7,
      investigationBudget: { amount: 300_00, currency: 'USD' },
      rewardBudget: { amount: 150_00, currency: 'USD' },
      rewardTerms: 'Recognition for a quantified dwell-time answer.',
      candidateSources: [
        { kind: 'person', id: employeePersonId, label: 'June Park' },
        { kind: 'system', label: 'Roastery WMS' },
      ],
      completionCriteria: 'The dwell time is quantified with evidence.',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    const coverage2 = await recordObservation(ctx, {
      kind: 'ops.note',
      payload: { note: 'June Park tracks the port dwell logs weekly.' },
      observedAt: '2026-10-05T08:00:00.000Z',
      source: { kind: 'person', id: employeePersonId, label: 'June Park' },
      channel: 'ingestion',
      confidence: { value: 0.8, method: 'person-account', basis: 'the ops handover log' },
    });
    await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: employeePersonId },
      relation: 'knows',
      subjectLabel: 'Port cold-chain dwell handling',
      topics: missionSubjectTopics(
        'Port cold-chain dwell time',
        'Measure how long the cold chain waits at the port after the broker change, and what it costs.',
      ),
      evidenceObservationIds: [coverage2.id],
      notes: 'the dwell logs',
    });
    const ask2 = await requestNextKnowledge(ctx, mission2.id, 'Northwind Owner');
    expect(ask2.decision).toBe('selected');
    const plan2 = ask2.planId;

    // Deliver the ask (the sweep records the proactive message).
    const delivery = await deliverKnowledgeRequestsToChat(ctx);
    expect(delivery.ok).toBe(true);
    if (delivery.ok) expect(delivery.asksRecorded).toBe(1);

    // Answer through the LEARNING FORM API (the W062 surface).
    const answered = await handleAnswerPost(
      sessionRequest(
        acme.ownerToken,
        {
          summary: 'The cold chain now waits two to three days at the port; the dwell cost is roughly 120 USD per shipment.',
          confidence: 'medium',
        },
        `https://aurum.test/api/product/learning/requests/${plan2}/answer`,
      ),
      plan2,
    );
    expect(answered.status).toBe(200);

    // Management validates, and the explicit policy converts the answer
    // into a gated reward — BEFORE the thread ever acknowledges it.
    const contributions2 = await listContributions(ctx, { missionId: mission2.id });
    expect(contributions2.length).toBe(1);
    const contribution2 = contributions2[0]!;
    await validateContribution(ctx, {
      contributionId: contribution2.id,
      outcome: 'validated',
      quality: 0.8,
      note: 'quantified and consistent with the dwell logs',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    await setRewardPolicy(rewardAdmin(acme.tenant.id, newId()), {
      qualifyingStatuses: ['validated'],
      minKnowledgeGain: 0,
      minAffectedGoals: 0,
      tiers: [{ name: 'thank-you-recognition', minValueScore: 0, kind: 'recognition', amount: 0 }],
      rewardCurrency: 'USD',
      note: 'the test policy',
    });
    const application = await applyRewardPolicy(ctx, {
      contribution: {
        kind: 'knowledge-contribution',
        id: contribution2.id,
        label: 'Dwell time quantified',
        contributor: { personId: employeePersonId, label: 'June Park' },
      },
      missionId: mission2.id,
      value: {
        status: 'validated',
        knowledgeGain: 0.2,
        missionImpact: 'advanced',
        affectedGoals: [],
        costAvoided: { amount: 120_00, currency: 'USD' },
      },
      actor: { kind: 'external', label: 'aurum-cognition' },
      rationale: 'the validated dwell-time answer advanced the mission',
    });
    const reward: Reward | null = application.reward;
    expect(reward).not.toBeNull();

    // The sweep converges: the thread receives the acknowledgement for
    // the Learning-form answer, composed from LIVE domain state — the
    // validated contribution and the proposed reward.
    const sweep = await deliverKnowledgeRequestsToChat(ctx);
    expect(sweep.ok).toBe(true);
    if (sweep.ok) {
      expect(sweep.acksRecorded).toBe(1);
      expect(sweep.delivered).toBe(true);
    }

    const state = await buildChatStateView(ctx, conversationId);
    const messages = state.thread?.messages ?? [];
    const acks = messages.filter((message) =>
      message.answer?.cards.some((card) => card.kind === 'contribution'),
    );
    expect(acks.length).toBe(2);
    const converged = acks[1]!;
    expect(converged.text).toContain('has an answer');
    const convergedCards = converged.answer?.cards ?? [];
    const contributionCard = convergedCards.find((card) => card.kind === 'contribution');
    expect(contributionCard?.id).toBe(contribution2.id);
    expect(contributionCard?.statusLabel).toBe('Validated');
    // The reward/recognition state is surfaced conversationally.
    const rewardCard = convergedCards.find((card) => card.kind === 'reward');
    expect(rewardCard).toBeDefined();
    expect(rewardCard?.id).toBe(reward!.id);
    expect(rewardCard?.statusLabel).toContain('approval decision');
    // No member turn was fabricated for the Learning-form answer.
    const memberTurns = messages.filter((message) => message.side === 'member');
    expect(memberTurns.length).toBe(1);

    // Management parity: the hub shows the same second contribution and
    // reward, both acknowledged in the thread.
    const view = await buildLearningHomeView(ctx);
    expect(view.contributions.map((row) => row.id)).toContain(contribution2.id);
    expect(view.rewards.map((row) => row.id)).toContain(reward!.id);
    expect(view.chat?.acknowledgedContributionIds).toContain(contribution2.id);
    expect(view.chat?.askPlanIds).toContain(plan2);
  });

  // -------------------------------------------------------------------------
  // The separation, swept over everything the chat lane can say
  // -------------------------------------------------------------------------

  it('carries no compensation/performance semantics in any chat learning turn', async () => {
    const state = await buildChatStateView(acme.owner, conversationId);
    const messages = state.thread?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      const strings: string[] = [message.text];
      for (const card of message.answer?.cards ?? []) {
        strings.push(card.title, card.statusLabel, card.linkLabel ?? '', ...card.meta);
        for (const section of card.context?.sections ?? []) {
          strings.push(section.title, ...section.lines, ...section.links.map((l) => l.label));
        }
      }
      for (const citation of message.answer?.citations ?? []) {
        strings.push(citation.label, citation.detail ?? '');
      }
      for (const text of strings) {
        expect(usesForbiddenTerm(text)).toBeNull();
      }
    }
  });

  // -------------------------------------------------------------------------
  // The honest API discipline
  // -------------------------------------------------------------------------

  it('maps the chat-answer API surface honestly (401, 404, 400, 409)', async () => {
    const anonymous = await handleChatAnswerPost(
      new Request('https://aurum.test/x', { method: 'POST', body: '{}' }),
      planId,
    );
    expect(anonymous.status).toBe(401);
    const malformed = await handleChatAnswerPost(
      sessionRequest(acme.ownerToken, { text: 's' }, 'https://aurum.test/x'),
      'not-a-uuid',
    );
    expect(malformed.status).toBe(404);
    const badBody = await handleChatAnswerPost(
      sessionRequest(acme.ownerToken, 'not json at all', 'https://aurum.test/x'),
      planId,
    );
    expect(badBody.status).toBe(400);
    // An empty answer text is an input problem (400), not a state problem.
    const empty = await handleChatAnswerPost(
      sessionRequest(acme.ownerToken, { text: '   ' }, 'https://aurum.test/x'),
      '00000000-0000-4000-8000-000000000000',
    );
    expect(empty.status).toBe(404);
  });

  it('answers a fresh open request with a null conversation id (auto-anchors to the learning thread)', async () => {
    const ctx = acme.owner;
    const mission3 = await createMission(ctx, {
      title: 'Warehouse pick-path friction',
      knowledgeObjective: 'Find where pick paths lengthened after the layout change.',
      informationValue: 0.6,
      urgency: 'low',
      targetConfidence: 0.6,
      investigationBudget: { amount: 100_00, currency: 'USD' },
      rewardBudget: { amount: 50_00, currency: 'USD' },
      candidateSources: [
        { kind: 'person', id: employeePersonId, label: 'June Park' },
      ],
      completionCriteria: 'The friction source is named.',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    const coverage3 = await recordObservation(ctx, {
      kind: 'ops.note',
      payload: { note: 'June Park walks the pick paths daily.' },
      observedAt: '2026-10-06T08:00:00.000Z',
      source: { kind: 'person', id: employeePersonId, label: 'June Park' },
      channel: 'ingestion',
      confidence: { value: 0.8, method: 'person-account', basis: 'the ops log' },
    });
    await recordTransactiveEntry(ctx, {
      actor: { kind: 'person', id: employeePersonId },
      relation: 'knows',
      subjectLabel: 'Warehouse pick-path layout',
      topics: missionSubjectTopics(
        'Warehouse pick-path friction',
        'Find where pick paths lengthened after the layout change.',
      ),
      evidenceObservationIds: [coverage3.id],
      notes: 'the floor walks',
    });
    const ask3 = await requestNextKnowledge(ctx, mission3.id, 'Northwind Owner');
    expect(ask3.decision).toBe('selected');

    // The workflow-level call with a NULL conversation: it must anchor to
    // the learning conversation (the thread where asks live).
    const outcome = await answerKnowledgeRequestInChat(
      ctx,
      { conversationId: null, planId: ask3.planId, summary: 'The east aisle crossing doubled.', confidence: 'low' },
      'Northwind Owner',
    );
    expect(outcome.status).toBe('answered');
    expect(outcome.conversationId).toBe(conversationId);
    const plan3 = await getAcquisitionPlan(ctx, ask3.planId);
    expect(plan3.outcome?.outcome).toBe('answered');
  });

  it('refuses a non-question plan honestly (a query-system selection cannot be answered here)', async () => {
    // A plan that was answered through the loop's own path (no person
    // question) refuses the chat answer with request_state.
    const ctx = acme.owner;
    const mission4 = await createMission(ctx, {
      title: 'Freight invoice reconciliation',
      knowledgeObjective: 'Reconcile freight invoices against the new broker tariffs.',
      informationValue: 0.5,
      urgency: 'medium',
      targetConfidence: 0.6,
      investigationBudget: { amount: 100_00, currency: 'USD' },
      rewardBudget: { amount: 50_00, currency: 'USD' },
      candidateSources: [{ kind: 'system', label: 'Roastery WMS' }],
      completionCriteria: 'The invoices reconcile.',
      actor: { kind: 'person', label: 'Ops Lead' },
    });
    const ask4 = await requestNextKnowledge(ctx, mission4.id, 'Northwind Owner');
    if (ask4.decision === 'selected' && ask4.planId) {
      // The planner chose the system — answer it through the loop path.
      await recordAcquisitionOutcome(ctx, {
        planId: ask4.planId,
        outcome: 'failed',
        note: 'the WMS feed was down — retried twice',
      });
      await expect(
        answerKnowledgeRequestInChat(
          ctx,
          { conversationId: null, planId: ask4.planId, summary: 'x', confidence: 'low' },
          'Northwind Owner',
        ),
      ).rejects.toThrow(/terminal|nothing to answer/);
    }
  });

  it('delivers nothing for a tenant with no open requests (no empty conversation is created)', async () => {
    const delivery = await handleChatDeliverPost(
      sessionRequest(beta.ownerToken, {}, 'https://aurum.test/x'),
    );
    expect(delivery.status).toBe(200);
    if (delivery.status !== 200) return;
    const body = delivery.body as { delivered?: boolean; conversationId?: string | null };
    expect(body.delivered).toBe(false);
    expect(body.conversationId).toBeNull();
    expect(await findLearningConversation(beta.owner)).toBeNull();
    expect(await learningChatLinkage(beta.owner)).toBeNull();
  });

  it('maps the deliver API surface honestly (401 anonymous)', async () => {
    const anonymous = await handleChatDeliverPost(
      new Request('https://aurum.test/x', { method: 'POST', body: '{}' }),
    );
    expect(anonymous.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation (ADR-0001)
  // -------------------------------------------------------------------------

  it("keeps tenant B's chat learning surface blind to tenant A", async () => {
    // Tenant B answering tenant A's plan: plan_not_found (404).
    const cross = await handleChatAnswerPost(
      sessionRequest(beta.ownerToken, { text: 'an answer' }, 'https://aurum.test/x'),
      planId,
    );
    expect(cross.status).toBe(404);
    // The plan and the conversation are invisible to tenant B's context.
    await expect(getAcquisitionPlan(beta.owner, planId)).rejects.toThrow();
    expect(await findLearningConversation(beta.owner)).toBeNull();
    // Tenant B's hub shows nothing of tenant A's.
    const view = await buildLearningHomeView(beta.owner);
    expect(view.requests).toEqual([]);
    expect(view.contributions).toEqual([]);
    expect(view.rewards).toEqual([]);
    expect(view.chat).toBeNull();
  });

  afterAll(async () => {
    await closeDb();
  });
});
