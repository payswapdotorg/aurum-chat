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
// consequential card kinds arrive INSIDE messages, and every card
// deep-links into management mode (the Control Tower). Chat is a channel;
// the answer payloads are derived intelligence, never authoritative state
// (ARCHITECTURE.md §1, lock 10/34).
//
// W072 — CONVERSATIONAL INTELLIGENCE CONTINUITY: this file is also the
// reusable card/context contract Wave-2 workers build against. The W060
// seven kinds are widened into the unified nine-kind model (capabilities
// and evidence join), every card carries evidence/context (the renderer
// synthesizes the honest fallback when a stored payload lacks one), and
// the return-link grammar (`chatReturnLink` / `withChatReturn` /
// `normalizeChatReturnLink`) keeps drill-downs returnable to the
// originating conversation — `/chat?c=<conversation>` plus the message
// anchor — without ever making the transcript domain truth.

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
// Cards — the unified consequential kinds (W060's seven + W072's
// capability and evidence + W073's learning kinds), deep-linked into
// the Control Tower's management and Learning surfaces. W073 landed
// the learning kinds through the shared contract's extension pattern —
// the same union/array/hrefs/label/guard machinery, no parallel layer.
// ---------------------------------------------------------------------------

export type ChatCardKind =
  | 'goal'
  | 'unknown'
  | 'mission'
  | 'risk'
  | 'opportunity'
  | 'recommendation'
  | 'approval'
  // W072 — the unified conversational-card model widens the W060 seven
  // with the two remaining consequential families of the intelligence
  // workflow: capabilities (W017 supply/demand, gap alternatives) and
  // evidence (the immutable observation records every answer rests on).
  | 'capability'
  | 'evidence'
  // W073 — chat-based learning requests (learning surfaces as cards).
  | 'knowledge-request'
  | 'contribution'
  | 'reward';

export const CHAT_CARD_KINDS: readonly ChatCardKind[] = [
  'goal',
  'unknown',
  'mission',
  'risk',
  'opportunity',
  'recommendation',
  'approval',
  'capability',
  'evidence',
  // W073 — chat-based learning requests.
  'knowledge-request',
  'contribution',
  'reward',
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
  capability: '/capabilities',
  evidence: '/evidence',
  // W073 — the supporting Learning surface owns the learning evidence chain.
  'knowledge-request': '/learning',
  contribution: '/learning',
  reward: '/learning',
};

/**
 * The consequential kinds (W072): every kind in the unified card model is
 * consequential — each one deep-links into a management or intelligence
 * surface and therefore owes the reader evidence/context and a return
 * path into the conversation (frozen plan §5 W072 acceptance).
 */
export const CONSEQUENTIAL_CARD_KINDS: readonly ChatCardKind[] = CHAT_CARD_KINDS;

/** The learning kinds (W073) — cards the chat learning lane renders. */
export const LEARNING_CARD_KINDS: readonly ChatCardKind[] = [
  'knowledge-request',
  'contribution',
  'reward',
];

/** Is this card kind one of the W073 learning kinds? */
export function isLearningCardKind(value: unknown): value is ChatCardKind {
  return (
    typeof value === 'string' && (LEARNING_CARD_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The stable conversation return link (the W072 continuity seam — every
 * management/product surface that opens a detail from a conversation links
 * BACK to the same thread with this shape; W073 consumes it and lands the
 * single definition here so the two surfaces cannot drift).
 */
export function chatConversationHref(conversationId: string): string {
  return `/chat?c=${encodeURIComponent(conversationId)}`;
}

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
    case 'capability':
      return 'Capability';
    case 'evidence':
      return 'Evidence';
    // W073 — chat-based learning requests.
    case 'knowledge-request':
      return 'Knowledge request';
    case 'contribution':
      return 'Contribution';
    case 'reward':
      return 'Reward';
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
// Conversational continuity (W072) — the return-link grammar
//
// THE CONTRACT (frozen plan §5 W072): a card may carry the reader away
// from the conversation (into an intelligence workflow page, a tower
// surface, the explainability reconstruction), but the conversation is
// never lost: the drill-down href carries the return link as ONE query
// parameter, and every surface that renders a "back to the conversation"
// affordance reads it through the same guard. Chat stays a CHANNEL —
// the return link is derived from the conversation id, never stored as
// domain truth (ARCHITECTURE-LOCK 35: PostgreSQL is authoritative; the
// transcript's message ids are transcript concerns, not domain state).
// ---------------------------------------------------------------------------

/** The query parameter drill-down hrefs carry the return link under. */
export const CHAT_RETURN_PARAM = 'back';

/** The DOM id prefix of one timeline message (the deep-link anchor). */
export const CHAT_MESSAGE_ANCHOR_PREFIX = 'm-';

/** The anchor id of one message (stable — the message row's DOM id). */
export function chatMessageAnchor(messageId: string): string {
  return `${CHAT_MESSAGE_ANCHOR_PREFIX}${messageId}`;
}

/**
 * The stable return link into the conversation (W072): `/chat?c=<id>`
 * plus, where supported, the exact-message anchor. Pure and
 * deterministic — the same conversation/message always yields the same
 * link, so a drill-down opened from a card can always go home.
 */
export function chatReturnLink(conversationId: string, messageId?: string | null): string {
  const base = `/chat?c=${encodeURIComponent(conversationId)}`;
  if (messageId === undefined || messageId === null || messageId === '') return base;
  return `${base}#${chatMessageAnchor(messageId)}`;
}

/** The maximum accepted length of an encoded return link. */
export const MAX_CHAT_RETURN_LENGTH = 300;

/**
 * Guard a `back` parameter value (raw, undecoded): it must decode to an
 * INTERNAL CHAT path — exactly `/chat` before any query or hash.
 * Anything else (foreign paths, absolute URLs, protocol-relative
 * mischief, look-alike paths such as `/chatty`, oversized junk) is
 * refused (null) and the surface simply renders no return affordance.
 * A return link can only ever send a reader back to a conversation.
 */
export function normalizeChatReturnLink(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length > MAX_CHAT_RETURN_LENGTH) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.includes('://') || decoded.includes('\\')) return null;
  if (decoded.startsWith('//')) return null;
  const path = decoded.split(/[?#]/, 1)[0] ?? '';
  if (path !== '/chat') return null;
  return decoded;
}

/**
 * Append the return link to a drill-down href under `CHAT_RETURN_PARAM`
 * (merging with an existing query when the href carries one). Null
 * return link or a foreign href → the href unchanged. Pure.
 */
export function withChatReturn(href: string, returnLink: string | null): string {
  if (returnLink === null || returnLink === '') return href;
  if (!href.startsWith('/')) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}${CHAT_RETURN_PARAM}=${encodeURIComponent(returnLink)}`;
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

/**
 * The honest fallback context of one consequential card kind (W072
 * acceptance: "every consequential chat card has evidence/context").
 *
 * Builders attach rich, record-specific context; this is the RENDERER'S
 * GUARANTEE for stored payloads whose context is missing, foreign or
 * legacy-shaped — a card without context does not render a dead "Why
 * this?" affordance, it renders the honest default: what the kind IS,
 * where the evidence lives, and how the decision trail is reached. The
 * fallback never invents record specifics — it states the kind's
 * semantics and links the surfaces that own the truth.
 */
export function fallbackCardContext(kind: ChatCardKind): ChatCardContext {
  return {
    subtitle: `${chatCardKindLabel(kind)} — derived intelligence; the owning surface is the source of truth`,
    sections: [
      {
        kind: 'why',
        title: 'Why this matters',
        lines: [
          KIND_WHY_LINES[kind],
          'This card was recorded before its full context was captured — the surfaces below carry the complete record.',
        ],
        links: [],
      },
      {
        kind: 'evidence',
        title: 'Evidence and reasoning',
        lines: [
          'Every consequential card rests on immutable observations and a recorded decision cycle.',
        ],
        links: [
          { label: 'Open the Evidence surface', href: '/evidence' },
          { label: 'Open the reconstruction surface', href: '/explain' },
        ],
      },
    ],
  };
}

/** The kind's one-line semantics (the fallback context's "why" line). */
const KIND_WHY_LINES: Record<ChatCardKind, string> = {
  goal: 'A goal is management\u2019s declared direction — Aurum evaluates progress against it from live evidence.',
  unknown: 'An unknown is a consequential question the company cannot yet answer — closing it is first-class work.',
  mission: 'A learning mission is the goal-driven, budget-bounded effort that closes a knowledge gap.',
  risk: 'A risk is an exposure the analysis stage recorded against affected goals, with its evidence retained.',
  opportunity: 'An opportunity is an evidence-backed chance to advance a goal, with value and confidence estimates.',
  recommendation: 'A recommendation is a consequential action Aurum proposed — it waits at the human authority gate.',
  approval: 'An approval is a human decision explicitly required before anything consequential executes.',
  capability: 'A capability is what the company can do today — supply and demand, with alternatives when short.',
  evidence: 'Evidence is the immutable observation record every answer and decision ultimately rests on.',
};

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
    // W072 acceptance — evidence/context on EVERY consequential card:
    // a stored payload without usable context degrades to the honest
    // fallback, never to a context-less card.
    context: normalizeContext(value['context']) ?? fallbackCardContext(kind),
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
