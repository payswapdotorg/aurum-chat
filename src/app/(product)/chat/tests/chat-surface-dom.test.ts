// W071 — the conversation-fidelity DOM suite.
//
// WHAT THIS PROVES AND HOW. The WhatsApp-like interaction model (frozen
// plan §2) is a STRUCTURE contract: which panes exist, how the messenger
// hierarchy nests, which side each bubble renders on, when day separators
// appear, how runs of consecutive messages group, what the list/search/
// new-chat/composer affordances are, and what the mobile list↔thread
// attribute state is. Those guarantees live in the RENDERED MARKUP the
// browser receives, so this suite server-renders the real ChatWorkspace
// (inside the real ProductShellProvider — exactly the provider/page tree
// /chat hydrates) through React's renderToReadableStream, the same
// technique as the W070 journey harness, and asserts the exact HTML.
//
// Pure presentation-fixture inputs: no DB, no API — the workspace's data
// flow is covered by the integration suite; this file owns the DOM shape
// only. Timestamps are LOCAL-day ISO strings so day separators are
// deterministic at any test clock/timezone.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { ProductShellProvider } from '../../components/product-shell-provider';
import { ChatWorkspace } from '../components/chat-workspace';
import { CHAT_STARTERS } from '../../lib/chat-starters';
import type {
  ChatMessageView,
  ChatStateView,
} from '../lib/chat-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Local-components ISO (no Z) — same local day when re-parsed. */
function localIso(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000`
  );
}

function message(
  id: string,
  side: 'member' | 'aurum',
  at: Date,
  text: string,
): ChatMessageView {
  return {
    id,
    side,
    speaker: side === 'member' ? 'You' : 'Aurum',
    text,
    sentAt: localIso(at),
    starterId: null,
    answer: null,
    pending: false,
  };
}

/** A local Date N days back at a fixed hour. */
function daysAgoAt(days: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date;
}

const now = new Date();

const TIMELINE: ChatMessageView[] = [
  message('m1', 'member', daysAgoAt(1, 10, 0), 'what needs my attention?'),
  message('m2', 'member', daysAgoAt(1, 10, 2), 'especially wholesale'),
  message('m3', 'aurum', daysAgoAt(1, 10, 5), 'Two items: the freshness goal and a pending approval.'),
  message('m4', 'member', daysAgoAt(0, 9, 0), 'show me the goal first'),
  message('m5', 'member', daysAgoAt(0, 9, 1), 'then the approval'),
  message('m6', 'aurum', daysAgoAt(0, 9, 3), 'Here is the freshness goal drift.'),
];

const OPEN_THREAD_STATE: ChatStateView = {
  generatedAt: localIso(now),
  conversations: [
    {
      id: 'conv-a',
      title: 'Freshness goal drift',
      lastMessageAt: localIso(daysAgoAt(0, 9, 3)),
      messageCount: 6,
      preview: 'Aurum: Here is the freshness goal drift.',
    },
    {
      id: 'conv-b',
      title: 'Customs broker question',
      lastMessageAt: null,
      messageCount: 0,
      preview: null,
    },
  ],
  thread: {
    id: 'conv-a',
    title: 'Freshness goal drift',
    messages: TIMELINE,
  },
};

const LIST_ONLY_STATE: ChatStateView = {
  generatedAt: localIso(now),
  conversations: OPEN_THREAD_STATE.conversations,
  thread: null,
};

const EMPTY_STATE: ChatStateView = {
  generatedAt: localIso(now),
  conversations: [],
  thread: null,
};

const EMPTY_THREAD_STATE: ChatStateView = {
  generatedAt: localIso(now),
  conversations: OPEN_THREAD_STATE.conversations,
  thread: { id: 'conv-b', title: 'Customs broker question', messages: [] },
};

/** Render the workspace exactly as /chat does (provider + workspace). */
async function renderWorkspace(initial: ChatStateView): Promise<string> {
  const element: ReactNode = createElement(
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

function count(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

/** React's SSR entity escaping (the starters' apostrophes etc.). */
function reactEscaped(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ---------------------------------------------------------------------------
// The document structure (the "first 5 seconds" guarantees)
// ---------------------------------------------------------------------------

describe('the chat document structure', () => {
  it('renders exactly one h1 — the screen-reader-only surface heading', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*aurum-sr-only[^>]*>\s*Chat with Aurum\s*<\/h1>/);
  });

  it('renders the two-pane messenger window (list + thread)', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(html).toContain('class="aurum-chat-app"');
    expect(html).toContain('aurum-chat-listpane');
    expect(html).toContain('aurum-chat-thread');
    expect(html).toContain('aria-label="Conversations"');
    expect(html).toContain('aria-label="Conversation with Aurum"');
  });

  it('a deep-linked thread renders the thread mobile view; a cold open renders the list view', async () => {
    const threadOpen = await renderWorkspace(OPEN_THREAD_STATE);
    expect(threadOpen).toContain('data-mobile-view="thread"');
    const coldOpen = await renderWorkspace(LIST_ONLY_STATE);
    expect(coldOpen).toContain('data-mobile-view="list"');
  });

  it('carries the Aurum contact identity: avatar, name, status, and the thread header block', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    // the list head's identity
    expect(html).toMatch(/<h2[^>]*aurum-chat-name[^>]*>\s*Aurum\s*<\/h2>/);
    expect(html).toContain('On duty · evidence-backed');
    // the thread header's contact block (avatar + title + status)
    expect(html).toContain('aurum-chat-avatar-sm');
    expect(html).toContain('aurum-chat-thread-status');
    expect(html).toContain('On duty · evidence-backed answers');
    expect(html).toMatch(/<strong[^>]*>\s*Freshness goal drift\s*<\/strong>/);
    // management chrome stays available but secondary (the quiet Evidence link)
    expect(html).toContain('href="/evidence"');
  });
});

// ---------------------------------------------------------------------------
// The conversation list pane
// ---------------------------------------------------------------------------

describe('the conversation list pane', () => {
  it('renders one row per conversation with avatar, title, preview and activity time', async () => {
    const html = await renderWorkspace(LIST_ONLY_STATE);
    expect(count(html, /class="aurum-chat-convo"/g)).toBe(2);
    expect(count(html, /aurum-chat-convo-avatar/g)).toBe(2);
    expect(html).toContain('Freshness goal drift');
    expect(html).toContain('Aurum: Here is the freshness goal drift.');
    // an empty conversation gets an honest preview line, not a blank row
    expect(html).toContain('No messages yet');
  });

  it('marks unread/new activity on the rows (the SSR first-paint state)', async () => {
    const html = await renderWorkspace(LIST_ONLY_STATE);
    // SSR renders with an empty seen map: the conversation with activity
    // is 'new'; the conversation without messages carries no badge.
    expect(count(html, /class="aurum-chat-unread"/g)).toBe(1);
    expect(html).toContain('data-activity="new"');
    expect(html).toContain('>New</span>');
  });

  it('carries the new-conversation affordance (44px compose control in the header)', async () => {
    const html = await renderWorkspace(LIST_ONLY_STATE);
    expect(html).toContain('class="aurum-chat-newchat"');
    expect(html).toContain('aria-label="Start a new conversation"');
    // the banner-style affordance is gone — one affordance, in the header
    expect(html).not.toContain('aurum-chat-newconv');
  });

  it('carries the search/filter affordance with a real label', async () => {
    const html = await renderWorkspace(LIST_ONLY_STATE);
    expect(html).toContain('id="aurum-chat-search"');
    expect(html).toContain('for="aurum-chat-search"');
    expect(html).toContain('type="search"');
    expect(html).toContain('Search conversations');
  });

  it('the first-run starters live in the list pane only until the first conversation exists', async () => {
    const empty = await renderWorkspace(EMPTY_STATE);
    expect(count(empty, /class="aurum-chat-pane-starter"/g)).toBe(4);
    expect(empty).toContain('No conversations yet');
    const populated = await renderWorkspace(LIST_ONLY_STATE);
    expect(populated).not.toContain('aurum-chat-pane-starter');
  });
});

// ---------------------------------------------------------------------------
// The timeline (bubbles, sides, runs, separators, metadata)
// ---------------------------------------------------------------------------

describe('the message timeline', () => {
  it('aligns member messages right and Aurum messages left (side attributes)', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(count(html, /data-side="member"/g)).toBe(4);
    expect(count(html, /data-side="aurum"/g)).toBe(2);
  });

  it('renders a day separator at the timeline start and at each day change', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    // m1 opens the timeline (separator), m4 crosses to today (separator)
    expect(count(html, /class="aurum-chat-day"/g)).toBe(2);
  });

  it('groups consecutive same-side messages into runs (first/last flags)', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    // runs: m1-m2 (member), m3 (aurum), m4-m5 (member), m6 (aurum)
    expect(count(html, /data-group-first="true"/g)).toBe(4);
    expect(count(html, /data-group-last="true"/g)).toBe(4);
  });

  it('member bubbles carry delivery state; Aurum bubbles do not', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(count(html, /data-delivery="sent"/g)).toBe(4);
    expect(html).not.toContain('data-delivery="sending"');
    // the delivery row includes the check glyph and the compact label
    expect(html).toContain('>sent</span>');
  });

  it('announces the speaker per turn (the log reads naturally)', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(count(html, /class="aurum-sr-only">You(?:<!-- -->)?: </g)).toBe(4);
    expect(count(html, /class="aurum-sr-only">Aurum(?:<!-- -->)?: </g)).toBe(2);
  });

  it('an open conversation with no messages shows the calm empty state', async () => {
    const html = await renderWorkspace(EMPTY_THREAD_STATE);
    expect(html).toContain('This conversation has no messages yet');
  });

  it('the welcome state (no conversation open) carries the full starter grid', async () => {
    const html = await renderWorkspace(LIST_ONLY_STATE);
    for (const starter of CHAT_STARTERS) {
      expect(html).toContain(reactEscaped(starter.question));
    }
    expect(html).toContain('aurum-starter-grid');
  });
});

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

describe('the composer', () => {
  it('renders the labeled multiline composer and the send affordance', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(html).toContain('id="aurum-chat-input"');
    expect(html).toContain('for="aurum-chat-input"');
    expect(html).toContain('aria-label="Send message"');
    expect(html).toMatch(/<textarea[^>]*rows="1"/);
  });

  it('keeps the keyboard contract visible (Enter sends, Shift+Enter adds a line)', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(html).toContain('Enter</kbd> sends');
  });

  it('mobile back navigation stays available from the thread header', async () => {
    const html = await renderWorkspace(OPEN_THREAD_STATE);
    expect(html).toContain('aria-label="Back to conversations"');
    expect(html).toContain('class="aurum-chat-back"');
  });
});
