// Unit tests for the W073 chat-based learning requests' PURE layer — no
// DB, no DOM: the provider-message idempotency keys, the shared-contract
// learning card kinds (the payload guards accept them — renderer parity),
// the ask/acknowledgement payload composition (cards, citations, text),
// the stable /chat?c= return-link shape, the API body parsing, and the
// COMPENSATION SEPARATION sweep over every string the chat lane can put
// in a thread (the acceptance's middle clause, pinned here end to end).

import { describe, expect, it } from 'vitest';
import type { Mission } from '@/modules/missions/contract';
import type { AcquisitionPlan } from '@/modules/knowledge-acquisition/contract';
import type { Contribution } from '@/modules/contributions/contract';
import {
  acknowledgementAnswer,
  askAnswer,
  askProviderMessageId,
  answerProviderMessageId,
  askedOfLabel,
  acknowledgementProviderMessageId,
  knowledgeRequestCard,
  missionProgressCard,
  missionProgressLine,
  renderAnswerAcknowledgementText,
  renderAnsweredStateText,
  renderAskText,
} from '../lib/chat-requests';
import {
  parseTurnPayload,
  normalizeChatCard,
  chatConversationHref,
  CHAT_CARD_KINDS,
  isLearningCardKind,
  isChatCardKind,
} from '../../chat/lib/chat-types';
import { parseChatAnswerBody, learningChatApiError } from '../lib/chat-api';
import { AnswerInputError, LearningStateError } from '../lib/answer';
import { usesForbiddenTerm } from '../lib/labels';

// ---------------------------------------------------------------------------
// Fixtures (plain domain-shaped objects — the pure builders read only)
// ---------------------------------------------------------------------------

const MISSION: Mission = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 't-1',
  version: 1,
  content: {
    title: 'Courier customs bottleneck',
    knowledgeObjective:
      'Identify why wholesale delivery freshness dropped after September.',
    affectedGoals: [],
    unknownIds: [],
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.2,
    targetConfidence: 0.8,
    investigationBudget: { amount: 500_00, currency: 'USD' },
    rewardBudget: { amount: 200_00, currency: 'USD' },
    rewardTerms: 'A configured reward for a validated root-cause answer.',
    candidateSources: [{ kind: 'person', id: 'p-1', label: 'June Park' }],
    completionCriteria: 'The dip is attributed to a named, evidenced cause.',
    status: 'active',
  },
  completion: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastChange: {
    kind: 'created',
    actor: { kind: 'person', label: 'Ops Lead' },
    changedByPrincipal: 'principal-1',
    rationale: 'fixture',
    recordedAt: '2026-10-01T00:00:00.000Z',
  },
};

const PLAN: AcquisitionPlan = {
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: 't-1',
  missionId: MISSION.id,
  missionVersion: 1,
  decision: 'selected',
  chosen: { kind: 'person', id: 'p-1', label: 'June Park' },
  action: 'ask-person',
  question:
    'For the Courier customs bottleneck mission: which customs-broker change delays the cold chain, and by how much?',
  askPolicy: { outcome: 'allowed', resolvedVia: 'tenant-default' },
  ranked: [],
  budgetRemaining: 500_00,
  budgetCurrency: 'USD',
  estimatedCost: 0,
  actor: { kind: 'system', label: 'aurum-cognition' },
  plannedByPrincipal: 'principal-1',
  rationale: 'the operations lead knows the courier change',
  recordedAt: '2026-10-02T00:00:00.000Z',
  outcome: null,
};

const CONTRIBUTION: Contribution = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: 't-1',
  planId: PLAN.id,
  missionId: MISSION.id,
  evidenceObservationId: '44444444-4444-4444-8444-444444444444',
  contributor: { id: 'p-1', label: 'June Park' },
  question: PLAN.question ?? '',
  budgetCurrency: 'USD',
  summary: 'The courier switched to a cheaper customs broker in September.',
  note: null,
  status: 'pending',
  validation: null,
  validationCount: 0,
  impact: null,
  recordedByPrincipal: 'principal-1',
  recordedAt: '2026-10-03T00:00:00.000Z',
  actor: { kind: 'external', label: 'Northwind Owner' },
};

// ---------------------------------------------------------------------------
// The shared-contract extension (learning kinds through the same machinery)
// ---------------------------------------------------------------------------

describe('the W073 learning card kinds ride the shared card model', () => {
  it('extends the shared kind set with exactly the three learning kinds', () => {
    expect(CHAT_CARD_KINDS).toEqual(
      expect.arrayContaining(['knowledge-request', 'contribution', 'reward']),
    );
    expect(isLearningCardKind('knowledge-request')).toBe(true);
    expect(isLearningCardKind('contribution')).toBe(true);
    expect(isLearningCardKind('reward')).toBe(true);
    expect(isLearningCardKind('goal')).toBe(false);
    expect(isLearningCardKind('mission')).toBe(false);
  });

  it('keeps every learning kind a first-class chat card kind (the guards accept it)', () => {
    const card = knowledgeRequestCard(PLAN, MISSION);
    expect(isChatCardKind(card.kind)).toBe(true);
    const normalized = normalizeChatCard(JSON.parse(JSON.stringify(card)));
    expect(normalized).not.toBeNull();
    expect(normalized?.kind).toBe('knowledge-request');
    expect(normalized?.id).toBe(PLAN.id);
  });

  it('round-trips a whole ask payload through the stored-payload guards (renderer parity)', () => {
    const answer = askAnswer(PLAN, MISSION);
    const payload = JSON.parse(
      JSON.stringify({ text: renderAskText(PLAN, MISSION), starterId: null, answer }),
    );
    const parsed = parseTurnPayload(payload);
    expect(parsed.text).toContain('June Park');
    expect(parsed.answer).not.toBeNull();
    expect(parsed.answer?.intent).toBe('learning');
    expect(parsed.answer?.cards.length).toBe(2);
    const kinds = parsed.answer?.cards.map((card) => card.kind);
    expect(kinds).toContain('knowledge-request');
    expect(kinds).toContain('mission');
    // The knowledge-request card survives the defensive read with its
    // context sections (evidence + mission links, the Why-this payload).
    const request = parsed.answer?.cards.find((card) => card.kind === 'knowledge-request');
    expect(request?.context?.sections.map((section) => section.kind)).toEqual(
      expect.arrayContaining(['why', 'mission', 'policy', 'evidence']),
    );
  });

  it('round-trips a whole acknowledgement payload through the stored-payload guards', () => {
    const answer = acknowledgementAnswer({
      mission: MISSION,
      contribution: CONTRIBUTION,
      evidenceObservationId: CONTRIBUTION.evidenceObservationId,
      rewards: [],
      fresh: true,
    });
    const payload = JSON.parse(
      JSON.stringify({
        text: renderAnswerAcknowledgementText(MISSION, CONTRIBUTION),
        starterId: null,
        answer,
      }),
    );
    const parsed = parseTurnPayload(payload);
    expect(parsed.answer?.cards.map((card) => card.kind)).toEqual(
      expect.arrayContaining(['contribution', 'mission']),
    );
    const contribution = parsed.answer?.cards.find((card) => card.kind === 'contribution');
    expect(contribution?.statusLabel).toBe('Recorded — awaiting assessment');
    // The evidence citation carries the immutable observation id.
    expect(
      parsed.answer?.citations.some(
        (citation) =>
          citation.kind === 'observation' && citation.id === CONTRIBUTION.evidenceObservationId,
      ),
    ).toBe(true);
  });

  it('derives the stable /chat?c= return link (the W072 seam)', () => {
    const id = '55555555-5555-4555-8555-555555555555';
    expect(chatConversationHref(id)).toBe(`/chat?c=${id}`);
    const spaced = '5555 5555';
    expect(chatConversationHref(spaced)).toBe(`/chat?c=${encodeURIComponent(spaced)}`);
  });
});

// ---------------------------------------------------------------------------
// The idempotency keys (one ask, one answer turn, one ack per plan)
// ---------------------------------------------------------------------------

describe('the per-plan provider message ids', () => {
  it('derives the three stable idempotency keys from the plan id', () => {
    expect(askProviderMessageId(PLAN.id)).toBe(`learning-ask-${PLAN.id}`);
    expect(answerProviderMessageId(PLAN.id)).toBe(`learning-answer-${PLAN.id}`);
    expect(acknowledgementProviderMessageId(PLAN.id)).toBe(`learning-ack-${PLAN.id}`);
  });
});

// ---------------------------------------------------------------------------
// The pure composition (cards, citations, text)
// ---------------------------------------------------------------------------

describe('the ask composition (Aurum speaking first)', () => {
  it('carries the question, the asked-of person and the mission progress', () => {
    const text = renderAskText(PLAN, MISSION);
    expect(text).toContain('Courier customs bottleneck');
    expect(text).toContain('June Park');
    expect(text).toContain('customs-broker change');
    const card = knowledgeRequestCard(PLAN, MISSION);
    expect(card.kind).toBe('knowledge-request');
    expect(card.id).toBe(PLAN.id);
    expect(card.title).toContain('customs-broker change');
    expect(card.meta.join(' ')).toContain('Asked of June Park');
    expect(card.href).toBe('/learning');
    expect(card.linkLabel).toBe('Open the Learning surface');
    expect(card.decision).toBeNull();
  });

  it('carries mission progress on both the request and the mission card', () => {
    const progress = missionProgressLine(MISSION);
    expect(progress).toBe('Confidence 20% of 80% — 25% toward target');
    expect(knowledgeRequestCard(PLAN, MISSION).meta.join(' ')).toContain(progress);
    const mission = missionProgressCard(MISSION);
    expect(mission.kind).toBe('mission');
    expect(mission.meta.join(' ')).toContain(progress);
    expect(mission.href).toBe(`/intelligence/missions/${MISSION.id}`);
  });

  it('answers with the learning intent and honest deterministic mode', () => {
    const answer = askAnswer(PLAN, MISSION);
    expect(answer.intent).toBe('learning');
    expect(answer.mode).toBe('deterministic');
    expect(answer.executionId).toBeNull();
    expect(answer.citations[0]?.kind).toBe('mission');
  });

  it('derives the asked-of label with the views discipline', () => {
    expect(askedOfLabel(PLAN)).toBe('June Park');
    expect(
      askedOfLabel({ ...PLAN, chosen: { kind: 'person', id: 'p-9', label: null } }),
    ).toBe('p-9');
    expect(askedOfLabel({ ...PLAN, chosen: null })).toBe('the selected source');
  });
});

describe('the acknowledgement composition (the same thread)', () => {
  it('thanks the answerer and states the recorded ladder', () => {
    const text = renderAnswerAcknowledgementText(MISSION, CONTRIBUTION);
    expect(text).toContain('Thank you — your answer is recorded');
    expect(text).toContain('Courier customs bottleneck');
    expect(text).toContain('Recorded — awaiting assessment');
  });

  it('states the recorded state for the converged path (never re-asks)', () => {
    const text = renderAnsweredStateText(MISSION, CONTRIBUTION);
    expect(text).toContain('has an answer');
    expect(text).not.toContain('Thank you');
    const without = renderAnsweredStateText(MISSION, null);
    expect(without).toContain('The same chain lives in the Learning surface.');
  });

  it('composes the acknowledgement with contribution + mission cards and evidence citations', () => {
    const answer = acknowledgementAnswer({
      mission: MISSION,
      contribution: CONTRIBUTION,
      evidenceObservationId: CONTRIBUTION.evidenceObservationId,
      rewards: [],
      fresh: true,
    });
    expect(answer.intent).toBe('learning');
    const kinds = answer.cards.map((card) => card.kind);
    expect(kinds).toEqual(['contribution', 'mission']);
    expect(answer.citations.map((citation) => citation.kind)).toEqual(['observation', 'mission']);
    const converged = acknowledgementAnswer({
      mission: MISSION,
      contribution: null,
      evidenceObservationId: null,
      rewards: [],
      fresh: false,
    });
    expect(converged.cards.map((card) => card.kind)).toEqual(['mission']);
    expect(converged.citations.map((citation) => citation.kind)).toEqual(['mission']);
  });
});

// ---------------------------------------------------------------------------
// The compensation/performance separation, pinned over the chat lane
// ---------------------------------------------------------------------------

describe('the chat lane carries no compensation/performance semantics', () => {
  it('keeps every string the ask and acknowledgement can put in a thread clean', () => {
    const ask = askAnswer(PLAN, MISSION);
    const ack = acknowledgementAnswer({
      mission: MISSION,
      contribution: CONTRIBUTION,
      evidenceObservationId: CONTRIBUTION.evidenceObservationId,
      rewards: [],
      fresh: true,
    });
    const converged = acknowledgementAnswer({
      mission: MISSION,
      contribution: { ...CONTRIBUTION, status: 'validated' },
      evidenceObservationId: CONTRIBUTION.evidenceObservationId,
      rewards: [],
      fresh: false,
    });
    for (const answer of [ask, ack, converged]) {
      for (const card of answer.cards) {
        const strings = [
          card.title,
          card.statusLabel,
          card.linkLabel ?? '',
          ...card.meta,
          ...(card.context?.sections.flatMap((section) => [section.title, ...section.lines]) ??
            []),
          ...(card.context?.sections.flatMap((section) => section.links.map((l) => l.label)) ?? []),
        ];
        for (const text of strings) {
          expect(usesForbiddenTerm(text)).toBeNull();
        }
      }
      for (const citation of answer.citations) {
        expect(usesForbiddenTerm(`${citation.label} ${citation.detail ?? ''}`)).toBeNull();
      }
    }
    expect(usesForbiddenTerm(renderAskText(PLAN, MISSION))).toBeNull();
    expect(usesForbiddenTerm(renderAnswerAcknowledgementText(MISSION, CONTRIBUTION))).toBeNull();
    expect(usesForbiddenTerm(renderAnsweredStateText(MISSION, CONTRIBUTION))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The chat-answer API body parsing + error mapping
// ---------------------------------------------------------------------------

describe('the chat-answer API surface (pure halves)', () => {
  it('parses the body loosely (text or summary, optional conversation, default confidence)', () => {
    const parsed = parseChatAnswerBody({
      conversationId: '  ',
      text: 'the courier changed brokers',
      confidence: 'high',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.conversationId).toBeNull();
      expect(parsed.text).toBe('the courier changed brokers');
      expect(parsed.confidence).toBe('high');
    }
    const viaSummary = parseChatAnswerBody({ summary: 's' });
    expect(viaSummary.ok).toBe(true);
    if (viaSummary.ok) expect(viaSummary.text).toBe('s');
    const defaults = parseChatAnswerBody({ text: 's' });
    expect(defaults.ok).toBe(true);
    if (defaults.ok) expect(defaults.confidence).toBe('medium');
  });

  it('refuses non-object bodies', () => {
    for (const bad of [null, 'text', 42, [1], undefined]) {
      expect(parseChatAnswerBody(bad).ok).toBe(false);
    }
  });

  it('maps the code-carrying errors to HTTP-ish outcomes', () => {
    expect(learningChatApiError(new AnswerInputError('bad summary')).status).toBe(400);
    expect(learningChatApiError(new LearningStateError('terminal')).status).toBe(409);
    const notFound = Object.assign(new Error('gone'), { code: 'plan_not_found' });
    expect(learningChatApiError(notFound).status).toBe(404);
    const conflict = Object.assign(new Error('conflict'), { code: 'outcome_conflict' });
    expect(learningChatApiError(conflict).status).toBe(409);
    expect(learningChatApiError(new Error('boom')).status).toBe(500);
  });
});
