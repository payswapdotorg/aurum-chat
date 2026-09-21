'use client';

// Aurum chat (W060 base, W071 fidelity) — the conversation workspace (the
// surface's client root).
//
// THE WHATSAPP-LIKE INTERACTION MODEL (frozen plan §2, employee mode):
//   * ONE messenger window: the conversation list pane and the thread pane
//     are internal panes of a single surface (chat.css owns the window);
//   * the list pane carries the Aurum contact identity (avatar/name/
//     presence), the new-conversation compose control and the
//     search/filter affordance, one row per conversation (avatar, title,
//     preview, activity time) with unread/new-activity badges (client-side
//     last-seen state — the conversations domain is append-only by
//     design, so read state is a viewer concern);
//   * a message timeline with compact timestamps, delivery state and day
//     separators; consecutive same-side messages group into runs
//     (bubbleGroup drives spacing + the tail corner);
//   * a compact composer (Enter sends, Shift+Enter newlines, retry-safe
//     sends through a client-minted idempotency id);
//   * streaming/working states — the member's bubble renders
//     optimistically, the working indicator runs while the workflow
//     executes, the thread header's status switches to "working…", and
//     the evidence-backed reply lands as bubbles + cards;
//   * action cards deep-linked into management mode with "Why this?"
//     opening the shell's context drawer, and pending approvals decidable
//     inline (Journey E — without leaving the conversation);
//   * mobile: one pane at a time (conversation-first) with a restrained
//     slide+fade transition and back navigation, 44px+ targets.
//
// All data flows through the /api/product/chat surface (the session is
// the only scope source — W058); the component never touches module
// contracts directly.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useProductShell } from '../../components/product-shell-provider';
import type { ChatStarter } from '../../lib/chat-starters';
import type {
  ChatCard,
  ChatMessageView,
  ChatStateView,
} from '../lib/chat-types';
import {
  conversationActivity,
  bubbleGroup,
  filterConversations,
  relativeActivityLabel,
} from '../lib/chat-format';
import {
  defaultStorage,
  loadSeenMap,
  markSeen,
  seenFor,
  type SeenMap,
} from '../lib/seen-state';
import {
  BACK_GLYPH_D,
  COMPOSE_GLYPH_D,
  DaySeparator,
  Glyph,
  MessageBubble,
  needsDaySeparator,
  SEARCH_GLYPH_D,
  SEND_GLYPH_D,
  WorkingRow,
} from './message-parts';
import type { CardActions } from './message-parts';

/** How often the client polls for new activity (unread/new messages). */
const POLL_MS = 12_000;

export interface ChatWorkspaceProps {
  tenantId: string;
  principalName: string;
  starters: readonly ChatStarter[];
  initial: ChatStateView;
  /** The ?q= starter id (W057's URL contract — prefills the composer). */
  starterQuery: string | null;
}

interface TurnResponse {
  conversationId: string;
  error?: string;
  message?: string;
}

function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ChatWorkspace({
  tenantId,
  principalName,
  starters,
  initial,
  starterQuery,
}: ChatWorkspaceProps): ReactNode {
  const { openContext } = useProductShell();
  const [state, setState] = useState<ChatStateView>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.thread?.id ?? null,
  );
  /** Mobile: whether the thread pane is open (the conversation-first view). */
  const [threadOpen, setThreadOpen] = useState<boolean>(initial.thread !== null);
  /** The starter attached to the NEXT send (?q= prefill — consumed on send). */
  const [pendingStarterId, setPendingStarterId] = useState<string | null>(starterQuery);
  const [seen, setSeen] = useState<SeenMap>({});
  const [draft, setDraft] = useState('');
  /** The conversation-list search/filter query (client-side, W071). */
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<ChatMessageView | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  /** Whether the selected thread's timeline is being fetched right now. */
  const [opening, setOpening] = useState(false);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

  // --- the seen map (client-side unread state) --------------------------
  useEffect(() => {
    setSeen(loadSeenMap());
  }, []);

  const markConversationSeen = useCallback(
    (conversationId: string) => {
      setSeen((current) =>
        markSeen(
          current,
          defaultStorage(),
          tenantId,
          conversationId,
          new Date().toISOString(),
        ),
      );
    },
    [tenantId],
  );

  // Mark the open conversation as seen whenever its timeline refreshes
  // with the window focused (the WhatsApp "read on open" behavior).
  useEffect(() => {
    if (selectedId === null || state.thread === null) return;
    if (state.thread.id !== selectedId) return;
    if (typeof document !== 'undefined' && !document.hasFocus()) return;
    markConversationSeen(selectedId);
  }, [selectedId, state.thread, markConversationSeen]);

  // --- the ?q= starter prefill (W057's URL input contract) --------------
  useEffect(() => {
    if (starterQuery === null) return;
    const starter = starters.find((candidate) => candidate.id === starterQuery);
    if (starter === undefined) return;
    setDraft(starter.question);
    setPendingStarterId(starter.id);
    setThreadOpen(true);
    composerRef.current?.focus();
  }, [starterQuery, starters]);

  // --- polling for unread / new activity ---------------------------------
  const refresh = useCallback(
    async (conversationId: string | null): Promise<void> => {
      const query =
        conversationId === null ? '' : `?conversationId=${encodeURIComponent(conversationId)}`;
      try {
        const response = await fetch(`/api/product/chat/state${query}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { view?: ChatStateView };
        if (body.view === undefined) throw new Error('malformed state');
        setState(body.view);
        setPollFailed(false);
      } catch {
        setPollFailed(true);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh(selectedRef.current);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // --- URL sync (?c= — shareable, no navigation) --------------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (selectedId === null) url.searchParams.delete('c');
    else url.searchParams.set('c', selectedId);
    window.history.replaceState(null, '', url);
  }, [selectedId]);

  // --- timeline autoscroll -------------------------------------------------
  const messages = state.thread?.messages ?? [];
  const renderedCount = messages.length + (pendingMessage === null ? 0 : 1);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = timelineRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [renderedCount, sending]);

  const onTimelineScroll = useCallback(() => {
    const node = timelineRef.current;
    if (node === null) return;
    stickToBottom.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }, []);

  // --- sending --------------------------------------------------------------
  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || sending) return;
    const clientMessageId = newClientId();
    const starterId = pendingStarterId;
    const optimistic: ChatMessageView = {
      id: `pending-${clientMessageId}`,
      side: 'member',
      speaker: 'You',
      text,
      sentAt: new Date().toISOString(),
      starterId,
      answer: null,
      pending: true,
    };
    setPendingMessage(optimistic);
    setDraft('');
    setSendError(null);
    setSending(true);
    stickToBottom.current = true;
    try {
      const response = await fetch('/api/product/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: selectedRef.current,
          text,
          starterId,
          clientMessageId,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(body?.message ?? body?.error ?? `send failed (HTTP ${response.status})`);
      }
      const body = (await response.json()) as TurnResponse;
      const conversationId = body.conversationId;
      setSelectedId(conversationId);
      selectedRef.current = conversationId;
      setPendingStarterId(null);
      setPendingMessage(null);
      await refresh(conversationId);
    } catch (cause) {
      setPendingMessage(null);
      setDraft(text);
      setSendError(cause instanceof Error ? cause.message : 'send failed');
    } finally {
      setSending(false);
    }
  }, [draft, sending, refresh, pendingStarterId]);

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void send();
      }
    },
    [send],
  );

  const autoGrow = useCallback((node: HTMLTextAreaElement): void => {
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 148)}px`;
  }, []);

  // --- approval decisions (Journey E — inline) ------------------------------
  const decide = useCallback(
    async (card: ChatCard, decision: 'approve' | 'reject'): Promise<void> => {
      if (card.decision === null) return;
      const requestId = card.decision.requestId;
      setDeciding(requestId);
      try {
        const response = await fetch(
          `/api/product/chat/approvals/${encodeURIComponent(requestId)}/decide`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision }),
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { message?: string; error?: string }
            | null;
          throw new Error(
            body?.message ?? body?.error ?? `decision failed (HTTP ${response.status})`,
          );
        }
        setDecided((current) => ({
          ...current,
          [requestId]: decision === 'approve' ? 'approved' : 'rejected',
        }));
      } catch (cause) {
        setSendError(cause instanceof Error ? cause.message : 'decision failed');
      } finally {
        setDeciding(null);
      }
    },
    [],
  );

  const cardActions: CardActions = useMemo(
    () => ({
      decided,
      deciding,
      onOpenContext: (card) => {
        if (card.context === null) return;
        openContext({
          title: card.title,
          subtitle: card.context.subtitle,
          tone: card.tone,
          sections: card.context.sections,
          source: `Chat card · ${card.kind}`,
        });
      },
      onDecide: (card, decision) => {
        void decide(card, decision);
      },
    }),
    [openContext, decided, deciding, decide],
  );

  // --- selection -------------------------------------------------------------
  const selectConversation = useCallback(
    (conversationId: string | null): void => {
      setSelectedId(conversationId);
      selectedRef.current = conversationId;
      setThreadOpen(true);
      stickToBottom.current = true;
      setSendError(null);
      // FIDELITY (W071): opening a conversation is immediate — the
      // selected thread's timeline is fetched NOW. The 12s poll remains
      // the background activity stream (unread/new), never the open path.
      setOpening(true);
      void refresh(conversationId).finally(() => {
        if (selectedRef.current === conversationId) setOpening(false);
      });
    },
    [refresh],
  );

  /** Mobile: back to the conversation list (the thread stays selected). */
  const backToList = useCallback((): void => {
    setThreadOpen(false);
  }, []);

  const useStarter = useCallback((question: string): void => {
    setDraft(question);
    setThreadOpen(true);
    composerRef.current?.focus();
  }, []);

  // --- derived ---------------------------------------------------------------
  const now = useMemo(
    () => new Date(),
    [state.generatedAt, pendingMessage, sending],
  );
  const thread = state.thread !== null && state.thread.id === selectedId ? state.thread : null;
  // W071 fix: the mobile view follows the OPEN PANE alone. (Deriving it
  // from `selectedId !== null` made back navigation impossible — once a
  // conversation was selected, the list could never return. The thread
  // stays selected behind the list; desktop shows both panes regardless.)
  const mobileView = threadOpen ? 'thread' : 'list';
  const visibleConversations = useMemo(
    () => filterConversations(state.conversations, search),
    [state.conversations, search],
  );
  /** The timeline's rendered bubbles (stored + the optimistic one, in order). */
  const rendered = useMemo(
    () => (pendingMessage === null ? messages : [...messages, pendingMessage]),
    [messages, pendingMessage],
  );

  return (
    <div className="aurum-chat-app" data-mobile-view={mobileView}>
      {/* The surface's single h1 (a11y: one heading per document — the
          messenger is an app surface, so the heading stays screen-reader
          only while the identity lives in the list/thread headers). */}
      <h1 className="aurum-sr-only">Chat with Aurum</h1>

      {/* ---- the conversation list pane ---- */}
      <nav className="aurum-chat-listpane" aria-label="Conversations">
        <div className="aurum-chat-listhead">
          <span className="aurum-chat-avatar" aria-hidden="true">
            A
          </span>
          <div className="aurum-chat-listhead-id">
            <h2 className="aurum-chat-name">Aurum</h2>
            <p className="aurum-chat-role" data-presence="onduty">
              <span className="aurum-presence-dot" aria-hidden="true" />
              On duty · evidence-backed
            </p>
          </div>
          <button
            type="button"
            className="aurum-chat-newchat"
            onClick={() => selectConversation(null)}
            aria-current={selectedId === null ? 'true' : undefined}
            aria-label="Start a new conversation"
            title="New conversation"
          >
            <Glyph d={COMPOSE_GLYPH_D} label="new conversation" />
          </button>
        </div>

        {/* The search/filter affordance (client-side over the loaded
            list — the WhatsApp search box pattern). */}
        <div className="aurum-chat-search">
          <label className="aurum-sr-only" htmlFor="aurum-chat-search">
            Search conversations
          </label>
          <span className="aurum-chat-search-icon" aria-hidden="true">
            <Glyph d={SEARCH_GLYPH_D} size={15} label="search" />
          </span>
          <input
            id="aurum-chat-search"
            type="search"
            value={search}
            placeholder="Search conversations"
            autoComplete="off"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {/* Compact starters — the first-run discovery surface (mobile's
            list pane only, and only until the first conversation exists). */}
        {state.conversations.length === 0 ? (
          <div className="aurum-chat-pane-starters">
            {starters.slice(0, 4).map((starter) => (
              <button
                key={starter.id}
                type="button"
                className="aurum-chat-pane-starter"
                onClick={() => useStarter(starter.question)}
              >
                {starter.question}
              </button>
            ))}
          </div>
        ) : null}

        <ul className="aurum-chat-list">
          {state.conversations.length === 0 ? (
            <li className="aurum-chat-listempty">
              No conversations yet — ask Aurum anything about the company.
            </li>
          ) : visibleConversations.length === 0 ? (
            <li className="aurum-chat-listempty">
              No conversations match “{search.trim()}”.
            </li>
          ) : (
            visibleConversations.map((conversation) => {
              const activity = conversationActivity(
                conversation,
                seenFor(seen, tenantId, conversation.id),
              );
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className="aurum-chat-convo"
                    aria-current={conversation.id === selectedId ? 'true' : undefined}
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <span className="aurum-chat-convo-avatar" aria-hidden="true">
                      A
                    </span>
                    <span className="aurum-chat-convo-body">
                      <span className="aurum-chat-convo-top">
                        <span className="aurum-chat-convo-title">{conversation.title}</span>
                        <span className="aurum-chat-convo-when" suppressHydrationWarning>
                          {relativeActivityLabel(conversation.lastMessageAt, now)}
                        </span>
                      </span>
                      {conversation.preview === null ? (
                        <span className="aurum-chat-convo-preview aurum-chat-convo-preview-empty">
                          No messages yet
                        </span>
                      ) : (
                        <span className="aurum-chat-convo-preview">{conversation.preview}</span>
                      )}
                    </span>
                    {activity === null ? null : (
                      <span className="aurum-chat-unread" data-activity={activity}>
                        {activity === 'new' ? 'New' : 'Unread'}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </nav>

      {/* ---- the thread pane (timeline + composer) ---- */}
      <section className="aurum-chat-thread" aria-label="Conversation with Aurum">
        <header className="aurum-chat-thread-head">
          <button
            type="button"
            className="aurum-chat-back"
            aria-label="Back to conversations"
            onClick={backToList}
          >
            <Glyph d={BACK_GLYPH_D} label="back" />
          </button>
          <span className="aurum-chat-avatar aurum-chat-avatar-sm" aria-hidden="true">
            A
          </span>
          <div className="aurum-chat-thread-title">
            <strong>{thread === null ? 'Aurum' : thread.title}</strong>
            <span className="aurum-chat-thread-status" data-working={sending}>
              {sending ? 'Aurum is working…' : 'On duty · evidence-backed answers'}
            </span>
          </div>
          <Link className="aurum-chat-thread-link" href="/evidence">
            Evidence
          </Link>
        </header>

        {/* The poll/degradation state — calm, inline, never a modal. */}
        {pollFailed ? (
          <div className="aurum-chat-conn" role="status">
            Reconnecting — showing the last known conversation state…
          </div>
        ) : null}

        <div
          className="aurum-chat-timeline"
          ref={timelineRef}
          onScroll={onTimelineScroll}
          role="log"
          aria-label="Message timeline"
        >
          {thread === null && pendingMessage === null ? (
            selectedId === null ? (
              <div className="aurum-chat-welcome">
                <p className="aurum-chat-welcome-hint">
                  Start with a question — Aurum answers from live company
                  state, cites its evidence, and walks you to any finding:
                </p>
                <div className="aurum-starter-grid">
                  {starters.map((starter) => (
                    <button
                      key={starter.id}
                      type="button"
                      className="aurum-starter"
                      onClick={() => useStarter(starter.question)}
                    >
                      <span className="aurum-starter-q">{starter.question}</span>
                      <span className="aurum-starter-hint">{starter.hint}</span>
                    </button>
                  ))}
                </div>
                <p className="aurum-chat-welcome-signed">
                  Signed in as {principalName} — messages stay scoped to your
                  company.
                </p>
              </div>
            ) : opening ? (
              <div className="aurum-chat-opening" role="status">
                <span className="aurum-working-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                Opening conversation…
              </div>
            ) : (
              <div className="aurum-chat-opening" role="status">
                Couldn’t open this conversation yet — retrying automatically.
              </div>
            )
          ) : (
            <>
              {rendered.map((message, index) => {
                const previous = rendered[index - 1] as ChatMessageView | undefined;
                const next = rendered[index + 1] as ChatMessageView | undefined;
                // Day separators break a run: the message after a
                // separator opens a new one, and the message before it
                // closes its own.
                const separatedBefore = needsDaySeparator(previous, message, now);
                const separatedAfter =
                  next !== undefined && needsDaySeparator(message, next, now);
                return (
                  <div key={message.id}>
                    {separatedBefore ? (
                      <DaySeparator message={message} now={now} />
                    ) : null}
                    <MessageBubble
                      message={message}
                      group={bubbleGroup(
                        separatedBefore ? undefined : previous,
                        message,
                        separatedAfter ? undefined : next,
                      )}
                      actions={cardActions}
                    />
                  </div>
                );
              })}
              {sending ? <WorkingRow /> : null}
              {messages.length === 0 && pendingMessage === null ? (
                <div className="aurum-chat-listempty">
                  This conversation has no messages yet — say hello.
                </div>
              ) : null}
            </>
          )}
        </div>

        <form
          className="aurum-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {sendError === null ? null : (
            <div className="aurum-chat-error" role="alert">
              <span>{sendError}</span>
              <button
                type="submit"
                className="aurum-chat-retry"
                disabled={sending || draft.trim() === ''}
              >
                Retry
              </button>
            </div>
          )}
          <div className="aurum-chat-composer-row">
            <label className="aurum-sr-only" htmlFor="aurum-chat-input">
              Message Aurum
            </label>
            <textarea
              id="aurum-chat-input"
              ref={composerRef}
              className="aurum-chat-input"
              rows={1}
              value={draft}
              placeholder="Ask about goals, unknowns, risks, approvals…"
              disabled={sending}
              onChange={(event) => {
                setDraft(event.target.value);
                autoGrow(event.target);
              }}
              onKeyDown={onComposerKeyDown}
            />
            <button
              type="submit"
              className="aurum-chat-send"
              data-busy={sending}
              disabled={sending || draft.trim() === ''}
              aria-label={sending ? 'Aurum is working' : 'Send message'}
            >
              <span className="aurum-chat-send-icon">
                <Glyph d={SEND_GLYPH_D} label="send" />
              </span>
            </button>
          </div>
          <span className="aurum-chat-hint">
            <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a
            line
          </span>
        </form>
      </section>
    </div>
  );
}
