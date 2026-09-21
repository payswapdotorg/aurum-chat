// Aurum chat (W060) — the chat surface's view models and payload guards.
//
// PURE by design: no imports beyond the shell's tone vocabulary, no DB, no
// React — every function here is unit-testable in isolation and shared by
// the server composition (chat-view / answers / workflow) and the client
// renderer (the payload guards make the timeline defensive: a stored
// message payload is arbitrary JSON, and the renderer must degrade a
// foreign/legacy payload to plain text instead of crashing).
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 (employee mode): Aurum behaves like a
// persistent organizational employee — answers are evidence-backed, the
// seven consequential card kinds arrive INSIDE messages, and every card
// deep-links into management mode (the Control Tower). Chat is a channel;
// the answer payloads are derived intelligence, never authoritative state
// (ARCHITECTURE.md §1, lock 10/34).

import type { PillTone } from '../../lib/states';

// ---------------------------------------------------------------------------
// Intents (the canonical discovery starters, plan §3, + the open fallback)
// ---------------------------------------------------------------------------

/** Which company question a turn is asking (the starters, plus open text). */
export type ChatIntent =
  | 'attention'
  | 'changed'
  | 'unknowns'
  | 'goals'
  | 'inefficiency'
  | 'improve'
  | 'why'
  | 'learning'
  | 'open';

export const CHAT_INTENTS: readonly ChatIntent[] = [
  'attention',
  'changed',
  'unknowns',
  'goals',
  'inefficiency',
  'improve',
  'why',
  'learning',
  'open',
];

export function isChatIntent(value: unknown): value is ChatIntent {
  return typeof value === 'string' && (CHAT_INTENTS as readonly string[]).includes(value);
}

/** Human copy for an intent (the composer's suggested-question hint). */
export function chatIntentLabel(intent: ChatIntent): string {
  switch (intent) {
    case 'attention':
      return 'What needs my attention';
    case 'changed':
      return 'What changed';
    case 'unknowns':
      return 'What we don’t know';
    case 'goals':
      return 'Goal progress';
    case 'inefficiency':
      return 'Efficiency';
    case 'improve':
      return 'Recommendations';
    case 'why':
      return 'Evidence and reasoning';
    case 'learning':
      return 'What Aurum is learning';
    case 'open':
      return 'Open question';
  }
}

// ---------------------------------------------------------------------------
// Cards — the seven consequential kinds (W060 acceptance), deep-linked into
// the Control Tower's management surfaces
// ---------------------------------------------------------------------------

export type ChatCardKind =
  | 'goal'
  | 'unknown'
  | 'mission'
  | 'risk'
  | 'opportunity'
  | 'recommendation'
  | 'approval';

export const CHAT_CARD_KINDS: readonly ChatCardKind[] = [
  'goal',
  'unknown',
  'mission',
  'risk',
  'opportunity',
  'recommendation',
  'approval',
];

/** The tower surface each card kind deep-links into (management mode). */
export const CARD_HREFS: Record<ChatCardKind, string> = {
  goal: '/goals',
  unknown: '/unknowns',
  mission: '/missions',
  risk: '/risks',
  opportunity: '/opportunities',
  recommendation: '/recommendations',
  approval: '/approvals',
};

export function isChatCardKind(value: unknown): value is ChatCardKind {
  return (
    typeof value === 'string' && (CHAT_CARD_KINDS as readonly string[]).includes(value)
  );
}

/** Human copy for a card kind (the chip label — never color alone). */
export function chatCardKindLabel(kind: ChatCardKind): string {
  switch (kind) {
    case 'goal':
      return 'Goal';
    case 'unknown':
      return 'Unknown';
    case 'mission':
      return 'Learning mission';
    case 'risk':
      return 'Risk';
    case 'opportunity':
      return 'Opportunity';
    case 'recommendation':
      return 'Recommendation';
    case 'approval':
      return 'Approval';
  }
}

export interface ChatCardLink {
  label: string;
  href: string;
}

/**
 * One context-drawer section a card can open ("why this matters" /
 * evidence / related goal — plan §3's drawer contents). The client hands
 * the card's context to the shell's `openContext` seam (W057).
 */
export interface ChatCardContextSection {
  kind:
    | 'summary'
    | 'evidence'
    | 'why'
    | 'related-goal'
    | 'mission'
    | 'policy'
    | 'approval'
    | 'outcome'
    | 'detail';
  title: string;
  lines: string[];
  links: ChatCardLink[];
}

export interface ChatCardContext {
  subtitle: string | null;
  sections: ChatCardContextSection[];
}

/** One action card inside a message (deep-linked into management mode). */
export interface ChatCard {
  kind: ChatCardKind;
  /** Domain record id (or trace execution id for loop findings). */
  id: string;
  title: string;
  /** Status chip copy (e.g. 'Active', 'Pending', 'Open'). */
  statusLabel: string;
  tone: PillTone;
  /** Small facts, one per line. */
  meta: string[];
  /** The tower deep link. */
  href: string;
  /**
   * The deep link's affordance label (W061 — proactive briefing cards
   * deep-link into the product intelligence workflow, not management
   * mode). Null/absent renders the canonical 'Open in management mode'.
   */
  linkLabel?: string | null;
  /** The human decision affordance (approval cards only). */
  decision:
    | { requestId: string; status: 'pending' | 'approved' | 'rejected' }
    | null;
  /** Context-drawer payload for the "Why this" affordance. */
  context: ChatCardContext | null;
}

// ---------------------------------------------------------------------------
// Citations — the evidence trail behind an answer
// ---------------------------------------------------------------------------

export type ChatCitationKind =
  | 'observation'
  | 'execution'
  | 'goal'
  | 'unknown'
  | 'mission'
  | 'action-request';

export interface ChatCitation {
  kind: ChatCitationKind;
  id: string;
  label: string;
  detail: string | null;
  href: string;
}

// ---------------------------------------------------------------------------
// The answer payload (outbound turns)
// ---------------------------------------------------------------------------

/** How the reply text was rendered (lock 10 — neither mode is authority). */
export type ChatAnswerMode = 'deterministic' | 'llm';

export interface ChatAnswer {
  intent: ChatIntent;
  mode: ChatAnswerMode;
  headline: string;
  bullets: string[];
  /** Honest degradation note (e.g. deterministic mode, unavailable reads). */
  note: string | null;
  cards: ChatCard[];
  citations: ChatCitation[];
  /** The cognition execution that produced this answer (opaque here). */
  executionId: string | null;
}

// ---------------------------------------------------------------------------
// The first-party web-chat turn payload (stored verbatim in the transcript)
// ---------------------------------------------------------------------------

/** What the web chat stores in a message payload (our own wire format). */
export interface ChatTurnPayload {
  text: string;
  starterId?: string | null;
  answer?: ChatAnswer | null;
}

/** The MAXIMUM chat text accepted from the composer (matches validation). */
export const MAX_CHAT_TEXT_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Timeline / conversation-list views (serialized to the client as props)
// ---------------------------------------------------------------------------

/** Which side of the timeline a bubble renders on (WhatsApp-like). */
export type ChatMessageSide = 'member' | 'aurum';

export interface ChatMessageView {
  id: string;
  side: ChatMessageSide;
  /** Speaker display label ('You', 'Aurum', a person name). */
  speaker: string;
  text: string;
  /** ISO 8601 — the sender's clock (sentAt). */
  sentAt: string;
  starterId: string | null;
  answer: ChatAnswer | null;
  /** True while the optimistic bubble awaits the server's confirmation. */
  pending: boolean;
}

export interface ConversationListItemView {
  id: string;
  title: string;
  lastMessageAt: string | null;
  messageCount: number;
  /** Last-turn preview text ('Aurum: …' / 'You: …'), or null when empty. */
  preview: string | null;
}

export interface ChatThreadView {
  id: string;
  title: string;
  messages: ChatMessageView[];
}

/** The composed chat state the page hydrates from and the client polls. */
export interface ChatStateView {
  generatedAt: string;
  conversations: ConversationListItemView[];
  thread: ChatThreadView | null;
}

// ---------------------------------------------------------------------------
// Payload guards (defensive reads of arbitrary stored JSON)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

const TONES: readonly PillTone[] = ['positive', 'warning', 'error', 'neutral', 'info'];

function pillTone(value: unknown): PillTone {
  return typeof value === 'string' && (TONES as readonly string[]).includes(value)
    ? (value as PillTone)
    : 'neutral';
}

const CONTEXT_SECTION_KINDS: readonly ChatCardContextSection['kind'][] = [
  'summary',
  'evidence',
  'why',
  'related-goal',
  'mission',
  'policy',
  'approval',
  'outcome',
  'detail',
];

function normalizeLinks(value: unknown): ChatCardLink[] {
  if (!Array.isArray(value)) return [];
  const out: ChatCardLink[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const label = boundedText(entry['label'], 120);
    const href = typeof entry['href'] === 'string' ? entry['href'] : '';
    if (label !== null && href.startsWith('/')) out.push({ label, href });
  }
  return out;
}

function normalizeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const line = boundedText(entry, 400);
    if (line !== null) out.push(line);
  }
  return out;
}

function normalizeContext(value: unknown): ChatCardContext | null {
  if (!isRecord(value)) return null;
  const rawSections = value['sections'];
  if (!Array.isArray(rawSections)) return null;
  const sections: ChatCardContextSection[] = [];
  for (const entry of rawSections) {
    if (!isRecord(entry)) continue;
    const kind = entry['kind'];
    if (
      typeof kind !== 'string' ||
      !(CONTEXT_SECTION_KINDS as readonly string[]).includes(kind)
    ) {
      continue;
    }
    const lines = normalizeLines(entry['lines']);
    const links = normalizeLinks(entry['links']);
    if (lines.length === 0 && links.length === 0) continue;
    const title = boundedText(entry['title'], 120) ?? '';
    sections.push({
      kind: kind as ChatCardContextSection['kind'],
      title,
      lines,
      links,
    });
  }
  if (sections.length === 0) return null;
  return {
    subtitle: boundedText(value['subtitle'], 200),
    sections,
  };
}

/** Defensive read of a stored card; null when the shape is not a card. */
export function normalizeChatCard(value: unknown): ChatCard | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (!isChatCardKind(kind)) return null;
  const id = typeof value['id'] === 'string' ? value['id'] : '';
  const title = boundedText(value['title'], 300);
  if (id === '' || title === null) return null;
  const href = typeof value['href'] === 'string' && value['href'].startsWith('/')
    ? value['href']
    : CARD_HREFS[kind];
  const decisionRaw = value['decision'];
  const decision =
    isRecord(decisionRaw) &&
    typeof decisionRaw['requestId'] === 'string' &&
    (decisionRaw['status'] === 'pending' ||
      decisionRaw['status'] === 'approved' ||
      decisionRaw['status'] === 'rejected')
      ? {
          requestId: decisionRaw['requestId'],
          status: decisionRaw['status'] as 'pending' | 'approved' | 'rejected',
        }
      : null;
  return {
    kind,
    id,
    title,
    statusLabel: boundedText(value['statusLabel'], 60) ?? '',
    tone: pillTone(value['tone']),
    meta: normalizeLines(value['meta']),
    href,
    linkLabel: boundedText(value['linkLabel'], 80),
    decision,
    context: normalizeContext(value['context']),
  };
}

/** Defensive read of a stored citation; null when the shape is not one. */
export function normalizeChatCitation(value: unknown): ChatCitation | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  const kinds: readonly string[] = [
    'observation',
    'execution',
    'goal',
    'unknown',
    'mission',
    'action-request',
  ];
  if (typeof kind !== 'string' || !kinds.includes(kind)) return null;
  const id = typeof value['id'] === 'string' ? value['id'] : '';
  const label = boundedText(value['label'], 200);
  if (id === '' || label === null) return null;
  const href =
    typeof value['href'] === 'string' && value['href'].startsWith('/')
      ? value['href']
      : '/evidence';
  return {
    kind: kind as ChatCitationKind,
    id,
    label,
    detail: boundedText(value['detail'], 300),
    href,
  };
}

/** Defensive read of a stored answer; null when the shape is not an answer. */
export function normalizeChatAnswer(value: unknown): ChatAnswer | null {
  if (!isRecord(value)) return null;
  const intent = value['intent'];
  if (!isChatIntent(intent)) return null;
  const headline = boundedText(value['headline'], 500);
  if (headline === null) return null;
  const mode = value['mode'] === 'llm' ? 'llm' : 'deterministic';
  const cards: ChatCard[] = [];
  if (Array.isArray(value['cards'])) {
    for (const entry of value['cards']) {
      const card = normalizeChatCard(entry);
      if (card !== null) cards.push(card);
    }
  }
  const citations: ChatCitation[] = [];
  if (Array.isArray(value['citations'])) {
    for (const entry of value['citations']) {
      const citation = normalizeChatCitation(entry);
      if (citation !== null) citations.push(citation);
    }
  }
  return {
    intent,
    mode,
    headline,
    bullets: normalizeLines(value['bullets']),
    note: boundedText(value['note'], 400),
    cards,
    citations,
    executionId:
      typeof value['executionId'] === 'string' && value['executionId'] !== ''
        ? value['executionId']
        : null,
  };
}

/** The defensively parsed view of one stored message payload. */
export interface ParsedTurnPayload {
  text: string;
  starterId: string | null;
  answer: ChatAnswer | null;
}

/**
 * Parse a stored message payload into the renderer's view. Unknown or
 * foreign payloads degrade to a plain-text turn (never a crash): the
 * transcript may carry turns from other channels (WhatsApp, Slack, …)
 * whose payloads this surface does not own.
 */
export function parseTurnPayload(payload: unknown): ParsedTurnPayload {
  if (!isRecord(payload)) {
    const asText = boundedText(payload, MAX_CHAT_TEXT_LENGTH) ?? '';
    return { text: asText, starterId: null, answer: null };
  }
  const text = boundedText(payload['text'], MAX_CHAT_TEXT_LENGTH) ?? '';
  const starterRaw = payload['starterId'];
  const starterId =
    typeof starterRaw === 'string' && starterRaw.trim() !== '' ? starterRaw : null;
  return {
    text,
    starterId,
    answer: normalizeChatAnswer(payload['answer']),
  };
}
