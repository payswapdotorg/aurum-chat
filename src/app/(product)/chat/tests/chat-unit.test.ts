// Unit tests for the Aurum chat surface (W060) — the pure logic, no DB,
// no DOM (the product-shell testing doctrine): intent classification,
// focus-topic derivation, answer composition from fixture data, the
// deterministic text renderer and LLM prompt, payload guards, formatting,
// the client seen-state store, and the API body parsers.

import { describe, expect, it } from 'vitest';
import type {
  ActionRequest,
} from '@/modules/actions/contract';
import type { Goal } from '@/modules/goals/contract';
import type { Unknown } from '@/modules/epistemics/contract';
import type { Mission } from '@/modules/missions/contract';
import type { Observation } from '@/modules/observations/contract';
import type { CapabilityGap } from '@/modules/capabilities/contract';
import type { KnowledgeEntry } from '@/modules/memory/contract';
import type { Contradiction } from '@/modules/epistemics/contract';
import {
  classifyIntent,
  composeAnswerParts,
  deriveTopics,
  buildLlmUserPrompt,
  renderDeterministicText,
  humanizeActionKind,
} from '../lib/answers';
import type { AnswerData } from '../lib/answers';
import {
  normalizeChatAnswer,
  parseTurnPayload,
  CARD_HREFS,
} from '../lib/chat-types';
import {
  bubbleTimeLabel,
  conversationActivity,
  dayLabel,
  previewText,
  relativeActivityLabel,
  sideForDirection,
  speakerLabel,
} from '../lib/chat-format';
import {
  loadSeenMap,
  markSeen,
  seenFor,
  type SeenStorage,
} from '../lib/seen-state';
import { validateChatText, threadTitleFor } from '../lib/workflow';
import { parseDecideBody, parseSendBody } from '../lib/chat-api';

// ---------------------------------------------------------------------------
// Fixtures (minimal domain shapes — only what the composers read)
// ---------------------------------------------------------------------------

const NOW = '2026-10-12T12:00:00.000Z';

function goalFixture(overrides: Partial<Goal> = {}): Goal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-a',
    version: 1,
    content: {
      title: 'Wholesale freshness',
      objective: 'Keep wholesale freshness above 90',
      desiredState: 'Freshness score at 90+ for every wholesale account',
      metrics: [
        { name: 'freshness-score', unit: 'score', direction: 'at_least', threshold: 90, lowerBound: null, upperBound: null },
      ],
      horizon: { start: null, end: '2026-12-31T00:00:00.000Z' },
      owner: { kind: 'person', id: 'p1', label: 'Ops lead' },
      priority: 'high',
      evidenceSources: [],
      successCriteria: 'All wholesale accounts at 90+ for a full month',
      status: 'active',
    },
    createdAt: NOW,
    updatedAt: NOW,
    lastChange: {
      kind: 'created',
      actor: { kind: 'person', id: 'p1', label: 'Ops lead' },
      changedByPrincipal: 'principal-1',
      rationale: null,
      recordedAt: NOW,
    },
    ...overrides,
  };
}

function unknownFixture(): Unknown {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: 'tenant-a',
    question: 'Why did the customs broker change delay shipments?',
    consequence: 'Without the reason, renegotiation timing is a guess and the freshness goal stays at risk.',
    subject: null,
    status: 'open',
    relatedObservationIds: [],
    relatedClaimIds: [],
    relatedBeliefIds: [],
    note: null,
    recordedAt: NOW,
    resolvedAt: null,
    resolution: null,
    resolutionNote: null,
  };
}

function missionFixture(): Mission {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant-a',
    version: 1,
    content: {
      title: 'Customs broker change — root cause',
      knowledgeObjective: 'Learn why the customs broker change happened and what it costs us',
      affectedGoals: [{ goalId: '11111111-1111-4111-8111-111111111111', label: 'Wholesale freshness' }],
      unknownIds: ['22222222-2222-4222-8222-222222222222'],
      informationValue: 0.8,
      urgency: 'high',
      currentConfidence: 0.2,
      targetConfidence: 0.9,
      investigationBudget: { amount: 50000, currency: 'USD' },
      rewardBudget: { amount: 20000, currency: 'USD' },
      rewardTerms: null,
      candidateSources: [],
      completionCriteria: 'A evidence-backed account of the change and its cost',
      status: 'active',
    },
    completion: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastChange: {
      kind: 'created',
      actor: { kind: 'person', id: 'p1', label: 'Ops lead' },
      changedByPrincipal: 'principal-1',
      rationale: null,
      recordedAt: NOW,
    },
  };
}

function actionRequestFixture(
  id: string,
  status: ActionRequest['status'] = 'pending',
): ActionRequest {
  return {
    id,
    tenantId: 'tenant-a',
    actionKind: 'employee-messaging',
    authorityLevel: 'ASK',
    payload: { question: 'What changed with the customs broker?' },
    justification: 'the approved outreach behind the freshness investigation',
    requestedBy: 'principal-1',
    requestedAt: NOW,
    idempotencyKey: `key-${id}`,
    status,
    decidedAt: null,
    evaluation: { outcome: 'approval_required', resolvedVia: 'kind', policy: null },
  };
}

function gapFixture(): CapabilityGap {
  return {
    capability: { id: '44444444-4444-4444-8444-444444444444', tenantId: 'tenant-a', name: 'Customs brokerage', status: 'active' },
    status: 'uncovered',
    activeRequirementCount: 2,
    activeSupplyCount: 0,
    bestActiveLevel: null,
    totalActiveCapacity: 0,
    activeSuppliesWithKnownCapacity: 0,
    unmet: [],
    alternatives: {
      activeByKind: { employee: 0, team: 0, agent: 0, software: 0, supplier: 0, partner: 0 },
      activeSupplies: [],
      retiredSupplies: [],
    },
  };
}

function observationFixture(): Observation {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenantId: 'tenant-a',
    kind: 'freshness.sample',
    payload: { month: '2026-10', score: 86 },
    observedAt: NOW,
    recordedAt: NOW,
    source: { kind: 'system', id: null, label: 'Roastery WMS' },
    channel: 'ingestion',
    lineage: { method: 'direct', parents: [], extractor: null },
    permissions: { visibility: 'tenant', workspaceId: null, principalId: null, usage: [] },
    confidence: { value: 0.9, method: 'system-report', basis: 'WMS export' },
  };
}

function knowledgeFixture(): KnowledgeEntry {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    tenantId: 'tenant-a',
    kind: 'insight',
    title: 'Freshness dips track customs delays',
    summary: 'Every freshness dip of the last quarter followed a customs delay by 3-5 days.',
    topics: ['freshness', 'customs'],
    entities: [],
    evidenceObservationIds: ['55555555-5555-4555-8555-555555555555'],
    notes: null,
    recordedAt: NOW,
  };
}

function contradictionFixture(): Contradiction {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    tenantId: 'tenant-a',
    evidenceA: { kind: 'claim', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    evidenceB: { kind: 'claim', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    note: 'The broker says delays are weather-driven; the carrier data says otherwise.',
    status: 'open',
    detectedAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };
}

function answerDataFixture(overrides: Partial<AnswerData> = {}): AnswerData {
  return {
    goals: [goalFixture()],
    unknowns: [unknownFixture()],
    missions: [missionFixture()],
    pendingRequests: [actionRequestFixture('cccccccc-cccc-4ccc-8ccc-cccccccccccc')],
    contradictions: [contradictionFixture()],
    gaps: [gapFixture()],
    traceFindings: [],
    observations: [observationFixture()],
    knowledge: [knowledgeFixture()],
    degraded: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

describe('classifyIntent', () => {
  it('maps every canonical starter id to its intent', () => {
    expect(classifyIntent('anything', 'attention')).toBe('attention');
    expect(classifyIntent('anything', 'changed')).toBe('changed');
    expect(classifyIntent('anything', 'unknowns')).toBe('unknowns');
    expect(classifyIntent('anything', 'goals')).toBe('goals');
    expect(classifyIntent('anything', 'inefficiency')).toBe('inefficiency');
    expect(classifyIntent('anything', 'improve')).toBe('improve');
    expect(classifyIntent('anything', 'why')).toBe('why');
    expect(classifyIntent('anything', 'learning')).toBe('learning');
  });

  it('classifies free text through the keyword rules', () => {
    expect(classifyIntent('why did freshness drop?', null)).toBe('why');
    expect(classifyIntent("what don't we know about churn?", null)).toBe('unknowns');
    expect(classifyIntent('where are we inefficient today?', null)).toBe('inefficiency');
    expect(classifyIntent('how are we doing against our goals?', null)).toBe('goals');
    expect(classifyIntent('what should we improve next?', null)).toBe('improve');
    expect(classifyIntent('what is Aurum learning about us?', null)).toBe('learning');
    expect(classifyIntent('what needs my attention?', null)).toBe('attention');
    expect(classifyIntent('what changed since yesterday?', null)).toBe('changed');
  });

  it('falls back to the open intent', () => {
    expect(classifyIntent('hello there good friend', null)).toBe('open');
    expect(classifyIntent('', null)).toBe('open');
  });

  it('starter ids win over free-text keywords', () => {
    expect(classifyIntent('why why why', 'goals')).toBe('goals');
  });

  it('an unknown starter id falls through to keywords', () => {
    expect(classifyIntent('what changed?', 'not-a-starter')).toBe('changed');
  });
});

// ---------------------------------------------------------------------------
// Focus topics (the W013 startExecution contract)
// ---------------------------------------------------------------------------

describe('deriveTopics', () => {
  it('always yields at least one lowercase slug', () => {
    expect(deriveTopics('', null)).toEqual(['chat']);
    expect(deriveTopics('???', null)).toEqual(['chat']);
  });

  it('includes the starter id and distinctive words, capped at five', () => {
    const topics = deriveTopics(
      'Why did wholesale freshness drop after the customs broker change?',
      'why',
    );
    expect(topics).toContain('why');
    expect(topics).toContain('wholesale');
    expect(topics).toContain('freshness');
    expect(topics.length).toBeLessThanOrEqual(5);
    for (const topic of topics) {
      expect(topic).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    }
  });

  it('drops stopwords and dedupes', () => {
    const topics = deriveTopics('the goal about the goal', null);
    expect(topics).toEqual(['goal']);
  });
});

// ---------------------------------------------------------------------------
// Answer composition (the pure seam)
// ---------------------------------------------------------------------------

describe('composeAnswerParts', () => {
  it('attention composes approvals, unknowns and missions with deep links', () => {
    const parts = composeAnswerParts('attention', answerDataFixture());
    expect(parts.headline).toContain('attention');
    expect(parts.bullets.length).toBeGreaterThan(0);
    const kinds = parts.cards.map((card) => card.kind);
    expect(kinds).toContain('approval');
    expect(kinds).toContain('unknown');
    expect(kinds).toContain('mission');
    for (const card of parts.cards) {
      expect(card.href).toBe(CARD_HREFS[card.kind]);
      expect(card.title).not.toBe('');
    }
    const approval = parts.cards.find((card) => card.kind === 'approval');
    expect(approval?.decision?.status).toBe('pending');
    expect(approval?.context?.sections.length).toBeGreaterThan(0);
    expect(parts.relatedGoalIds).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('attention is honest when nothing needs attention', () => {
    const parts = composeAnswerParts('attention', answerDataFixture({
      pendingRequests: [],
      unknowns: [],
      missions: [],
      traceFindings: [],
    }));
    expect(parts.headline).toBe('Nothing needs your attention right now.');
    expect(parts.cards).toEqual([]);
  });

  it('goals produces goal cards with horizon metadata', () => {
    const parts = composeAnswerParts('goals', answerDataFixture());
    expect(parts.cards).toHaveLength(1);
    expect(parts.cards[0]?.kind).toBe('goal');
    expect(parts.cards[0]?.meta.join(' ')).toContain('Horizon ends');
    expect(parts.cards[0]?.statusLabel).toBe('Active');
  });

  it('unknowns surfaces the consequence as the why', () => {
    const parts = composeAnswerParts('unknowns', answerDataFixture());
    expect(parts.cards[0]?.kind).toBe('unknown');
    expect(parts.cards[0]?.meta[0]).toContain('Why it matters');
    const why = parts.cards[0]?.context?.sections.find((s) => s.kind === 'why');
    expect(why?.lines[0]).toContain('renegotiation timing');
  });

  it('inefficiency composes capability gaps as risk cards', () => {
    const parts = composeAnswerParts('inefficiency', answerDataFixture());
    const risk = parts.cards.find((card) => card.kind === 'risk');
    expect(risk?.title).toContain('Customs brokerage');
    expect(risk?.statusLabel).toBe('No active supply');
  });

  it('improve composes recommendations from pending action requests', () => {
    const parts = composeAnswerParts('improve', answerDataFixture());
    expect(parts.cards[0]?.kind).toBe('recommendation');
    expect(parts.cards[0]?.title).toBe('Employee messaging');
    expect(parts.cards[0]?.href).toBe('/recommendations');
  });

  it('why cites observations and surfaces retained contradictions', () => {
    const parts = composeAnswerParts('why', answerDataFixture());
    expect(parts.citations[0]?.kind).toBe('observation');
    expect(parts.citations[0]?.href).toBe('/evidence');
    expect(parts.cards[0]?.kind).toBe('risk');
    expect(parts.cards[0]?.title).toContain('broker says');
  });

  it('changed lists observations newest first with citations', () => {
    const parts = composeAnswerParts('changed', answerDataFixture());
    expect(parts.headline).toContain('most recent observation');
    expect(parts.citations).toHaveLength(1);
    expect(parts.citations[0]?.label).toContain('freshness.sample');
  });

  it('learning composes knowledge bullets and mission cards', () => {
    const parts = composeAnswerParts('learning', answerDataFixture());
    expect(parts.bullets[0]).toContain('Freshness dips track customs delays');
    expect(parts.cards.some((card) => card.kind === 'mission')).toBe(true);
  });

  it('open composes a state summary with the honest deterministic note', () => {
    const parts = composeAnswerParts('open', answerDataFixture());
    expect(parts.headline).toContain('company stands');
    expect(parts.note).toContain('connect an AI provider');
    expect(parts.note).toContain('evidence-backed');
  });

  it('degraded families become an explicit note, never silent empties', () => {
    const parts = composeAnswerParts('attention', answerDataFixture({ degraded: ['goals', 'missions'] }));
    expect(parts.note).toContain('unavailable');
    expect(parts.note).toContain('goals');
    expect(parts.note).toContain('missions');
  });
});

// ---------------------------------------------------------------------------
// Text rendering + the LLM prompt
// ---------------------------------------------------------------------------

describe('renderDeterministicText + buildLlmUserPrompt', () => {
  it('renders headline, bullets and note as the chat text', () => {
    const parts = composeAnswerParts('goals', answerDataFixture());
    const text = renderDeterministicText(parts);
    expect(text.split('\n')[0]).toBe(parts.headline);
    expect(text).toContain('• ');
  });

  it('builds a grounded user prompt with cards and citations', () => {
    const parts = composeAnswerParts('attention', answerDataFixture());
    const prompt = buildLlmUserPrompt('What needs my attention?', parts);
    expect(prompt).toContain('Question: What needs my attention?');
    expect(prompt).toContain('[approval] Employee messaging');
    expect(prompt).toContain('[mission] Customs broker change');
  });
});

describe('humanizeActionKind', () => {
  it('humanizes canonical slugs', () => {
    expect(humanizeActionKind('employee-messaging')).toBe('Employee messaging');
    expect(humanizeActionKind('extension-deployment')).toBe('Extension deployment');
  });
});

// ---------------------------------------------------------------------------
// Payload guards (defensive reads of arbitrary stored JSON)
// ---------------------------------------------------------------------------

describe('parseTurnPayload', () => {
  it('parses a first-party web-chat payload', () => {
    const parsed = parseTurnPayload({
      text: 'hello',
      starterId: 'attention',
      answer: {
        intent: 'attention',
        mode: 'deterministic',
        headline: 'H',
        bullets: ['b'],
        note: null,
        cards: [
          {
            kind: 'goal',
            id: '11111111-1111-4111-8111-111111111111',
            title: 'Wholesale freshness',
            statusLabel: 'Active',
            tone: 'positive',
            meta: [],
            href: '/goals',
            decision: null,
            context: null,
          },
        ],
        citations: [],
        executionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
    });
    expect(parsed.text).toBe('hello');
    expect(parsed.starterId).toBe('attention');
    expect(parsed.answer?.cards[0]?.kind).toBe('goal');
    expect(parsed.answer?.executionId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  });

  it('degrades foreign channel payloads to a plain turn', () => {
    const parsed = parseTurnPayload({ text: 'hi from whatsapp', attachments: [] });
    expect(parsed.text).toBe('hi from whatsapp');
    expect(parsed.answer).toBeNull();
  });

  it('never crashes on non-object payloads', () => {
    expect(parseTurnPayload('plain string').text).toBe('plain string');
    expect(parseTurnPayload(null).text).toBe('');
    expect(parseTurnPayload(42).text).toBe('42');
  });

  it('drops malformed cards and citations instead of failing the answer', () => {
    const answer = normalizeChatAnswer({
      intent: 'attention',
      headline: 'H',
      cards: [{ kind: 'nonsense' }, { kind: 'goal', id: 'x', title: 'T', meta: [], href: '/goals' }],
      citations: [{ kind: 'observation', id: 'y', label: 'L', href: '/evidence' }],
    });
    expect(answer?.cards).toHaveLength(1);
    expect(answer?.citations).toHaveLength(1);
  });

  it('rejects non-answers', () => {
    expect(normalizeChatAnswer({ headline: 'no intent' })).toBeNull();
    expect(normalizeChatAnswer(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Formatting (client-safe pure)
// ---------------------------------------------------------------------------

describe('chat-format', () => {
  it('renders compact bubble timestamps', () => {
    expect(bubbleTimeLabel('2026-10-12T09:05:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(bubbleTimeLabel('not a date')).toBe('');
  });

  it('labels today, yesterday and older days', () => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    expect(dayLabel('2026-10-12T08:00:00.000Z', now)).toBe('Today');
    expect(dayLabel('2026-10-11T23:00:00.000Z', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-30T10:00:00.000Z', now)).not.toBe('Today');
  });

  it('renders compact relative activity labels', () => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    expect(relativeActivityLabel(null, now)).toBe('no messages yet');
    expect(relativeActivityLabel('2026-10-12T11:59:40.000Z', now)).toBe('just now');
    expect(relativeActivityLabel('2026-10-12T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeActivityLabel('2026-10-12T08:00:00.000Z', now)).toBe('4h ago');
    expect(relativeActivityLabel('2026-10-10T08:00:00.000Z', now)).toBe('2d ago');
  });

  it('derives preview speakers by direction (tenant-relative)', () => {
    expect(previewText('outbound', 'Aurum', 'here you go')).toBe('Aurum: here you go');
    expect(previewText('inbound', 'June Park', 'hello')).toBe('June Park: hello');
    expect(previewText('inbound', null, 'hello')).toBe('You: hello');
    expect(previewText('inbound', null, '   ')).toBeNull();
    expect(sideForDirection('inbound')).toBe('member');
    expect(sideForDirection('outbound')).toBe('aurum');
    expect(speakerLabel('outbound', null)).toBe('Aurum');
  });

  it('derives unread/new activity from the last-seen state', () => {
    const conversation = {
      id: 'c1',
      title: 'T',
      lastMessageAt: '2026-10-12T12:00:00.000Z',
      messageCount: 2,
      preview: null,
    };
    expect(conversationActivity(conversation, null)).toBe('new');
    expect(conversationActivity(conversation, '2026-10-12T11:00:00.000Z')).toBe('unread');
    expect(conversationActivity(conversation, '2026-10-12T12:30:00.000Z')).toBeNull();
    expect(conversationActivity({ ...conversation, lastMessageAt: null }, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The client seen-state store
// ---------------------------------------------------------------------------

describe('seen-state', () => {
  function memoryStorage(): SeenStorage & { dump(): Map<string, string> } {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      dump: () => memory,
    };
  }

  it('round-trips through storage and drops malformed entries', () => {
    const storage = memoryStorage();
    storage.setItem('aurum.chat.seen.v1', 'not json');
    expect(loadSeenMap(storage)).toEqual({});
    storage.setItem('aurum.chat.seen.v1', JSON.stringify({ 't/c1': '2026-10-12T10:00:00.000Z', bad: 7 }));
    const map = loadSeenMap(storage);
    expect(seenFor(map, 't', 'c1')).toBe('2026-10-12T10:00:00.000Z');
    expect(seenFor(map, 't', 'other')).toBeNull();
  });

  it('markSeen is monotonic and persists', () => {
    const storage = memoryStorage();
    let map = markSeen({}, storage, 't', 'c1', '2026-10-12T10:00:00.000Z');
    map = markSeen(map, storage, 't', 'c1', '2026-10-12T09:00:00.000Z');
    expect(seenFor(map, 't', 'c1')).toBe('2026-10-12T10:00:00.000Z');
    const reloaded = loadSeenMap(storage);
    expect(seenFor(reloaded, 't', 'c1')).toBe('2026-10-12T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Workflow validation + API body parsers
// ---------------------------------------------------------------------------

describe('validateChatText / threadTitleFor', () => {
  it('accepts trimmed non-empty text and rejects the rest', () => {
    expect(validateChatText('  hello  ')).toBe('hello');
    expect(() => validateChatText('   ')).toThrowError(/empty/);
    expect(() => validateChatText('x'.repeat(4001))).toThrowError(/4000/);
    expect(() => validateChatText(42)).toThrowError(/string/);
  });

  it('clips auto-created thread titles to 60 characters', () => {
    expect(threadTitleFor('short question')).toBe('short question');
    const long = threadTitleFor('w'.repeat(100));
    expect(long.length).toBe(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('parseSendBody / parseDecideBody', () => {
  it('parses a send body and normalizes optional fields', () => {
    const parsed = parseSendBody({ text: ' hello ', starterId: 'goals', clientMessageId: 'abc' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.conversationId).toBeNull();
      expect(parsed.value.starterId).toBe('goals');
      expect(parsed.value.clientMessageId).toBe('abc');
    }
  });

  it('rejects sends without text', () => {
    expect(parseSendBody({}).ok).toBe(false);
    expect(parseSendBody({ text: '   ' }).ok).toBe(false);
    expect(parseSendBody(null).ok).toBe(false);
  });

  it('parses decisions and rejects anything else', () => {
    const ok = parseDecideBody({ decision: 'approve', note: '  looks good ' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.decision).toBe('approve');
    expect(parseDecideBody({ decision: 'maybe' }).ok).toBe(false);
    expect(parseDecideBody('nope').ok).toBe(false);
  });
});
