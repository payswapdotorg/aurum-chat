// Aurum chat (W060) — the conversation-first entry point of the product.
//
// THE EMPLOYEE MODE (plan §3): WhatsApp-like conversation list + message
// timeline + composer; Aurum answers with evidence and action cards
// deep-linked into management mode; pending approvals are decidable
// inline; mobile is a first-class full-screen conversation experience.
//
// The page is the server half of the workspace: it gates the session
// (W058 — anonymous → /signin, company-less → /onboarding), builds the
// initial chat state through the conversations contract (W029), and
// hands it to the client workspace. Every later read/write flows through
// /api/product/chat (the session is the only scope source).
//
// W057's URL input contract survives: `/chat?q=<starter id>` still
// selects the starter — now by PREFILLING the composer with the starter
// question (the live workflow consumes it from there). `/chat?c=<id>`
// opens a conversation directly (shareable deep links).

import type { Metadata } from 'next';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { CHAT_STARTERS, findStarter } from '../lib/chat-starters';
import { buildChatStateView } from './lib/chat-view';
import type { ChatStateView } from './lib/chat-types';
import { ChatWorkspace } from './components/chat-workspace';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chat — Aurum',
  description:
    'Talk with Aurum, your organizational intelligence employee. Evidence-backed answers, action cards, and approvals — in one conversation.',
};

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireAuthenticatedPage();

  const first = (key: string): string | null => {
    const value = params[key];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
  const conversationParam = first('c');
  const starter = findStarter(first('q'));

  // A stale/foreign ?c= degrades to no selection — never a crash, never
  // an existence leak (the contract's not-found is indistinguishable).
  let initial: ChatStateView;
  if (conversationParam !== null && conversationParam !== '') {
    try {
      initial = await buildChatStateView(session.context, conversationParam);
    } catch {
      initial = await buildChatStateView(session.context, null);
    }
  } else {
    initial = await buildChatStateView(session.context, null);
  }

  return (
    <ChatWorkspace
      tenantId={session.context.tenantId}
      principalName={session.principal.displayName}
      starters={CHAT_STARTERS}
      initial={initial}
      starterQuery={starter === null ? null : starter.id}
    />
  );
}
