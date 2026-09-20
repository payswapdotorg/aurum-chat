// Product shell (W057) — the Chat area.
//
// The conversation-first entry point of the product (plan §3 "Employee
// mode — WhatsApp-like"). The shell's honest scope for W057: the Aurum
// identity header and the EIGHT canonical discovery starters (plan §3
// "Chat discovery starters"), selectable into the URL (`/chat?q=<id>`) so
// the live conversation workflow (W060) inherits a stable input contract.
// No fake composer, no fake replies — quiet, honest states only.

import Link from 'next/link';
import { requirePageScope } from '@/app/lib/page-session';
import { CHAT_STARTERS, findStarter, starterHref } from '../lib/chat-starters';
import { PageHead, StatusPill, WorkingIndicator } from '../components/states';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // W058: authenticated routing — the session carries the company scope
  // (unauthenticated visitors never reach this render; they are redirected
  // to sign-in, and sessions without an active company go to onboarding).
  await requirePageScope('/chat');
  const params = await searchParams;
  const q = Array.isArray(params['q']) ? (params['q'][0] ?? null) : (params['q'] ?? null);
  const selected = findStarter(q);

  return (
    <>
      <PageHead
        title="Chat"
        description="Talk with Aurum like you would a colleague who happens to know the whole company. Answers are evidence-backed, findings arrive as cards, and consequential actions always pass a human approval gate."
        meta={<span>Company scope active — Aurum answers from your tenant-scoped state.</span>}
      />

      <section className="aurum-chat-card" aria-labelledby="aurum-chat-identity-title">
        <div className="aurum-chat-identity">
          <span className="aurum-chat-avatar" aria-hidden="true">
            A
          </span>
          <div>
            <h2 id="aurum-chat-identity-title" className="aurum-chat-name">
              Aurum
            </h2>
            <p className="aurum-chat-role">
              Organizational intelligence employee · on your company&apos;s side
            </p>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <StatusPill tone="positive">on duty</StatusPill>
          </div>
        </div>

        {selected === null ? (
          <>
            <p className="aurum-item-text" style={{ marginBottom: 6 }}>
              Start with a question — Aurum answers with evidence, follows up on
              its own unknowns, and can walk you to any finding:
            </p>
            <div className="aurum-starter-grid">
              {CHAT_STARTERS.map((starter) => (
                <Link
                  key={starter.id}
                  href={starterHref(starter, '')}
                  className="aurum-starter"
                >
                  <span className="aurum-starter-q">{starter.question}</span>
                  <span className="aurum-starter-hint">{starter.hint}</span>
                </Link>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="aurum-pending-question" role="status">
              “{selected.question}”
            </div>
            <p className="aurum-item-text">
              Good question. The live conversation experience picks this
              selection up from here — it reads the same{' '}
              <code className="aurum-mono">?q={selected.id}</code> you see in the
              address bar, so nothing is lost between the shell and the chat.
            </p>
            <p style={{ marginTop: 14 }}>
              <WorkingIndicator label="Aurum will answer here" />
            </p>
            <p style={{ marginTop: 14 }}>
              <Link className="aurum-btn" data-variant="quiet" href="/chat">
                Pick a different question
              </Link>
            </p>
          </>
        )}
      </section>

      <section className="aurum-panel">
        <h2 className="aurum-panel-title">How Aurum answers</h2>
        <p className="aurum-panel-blurb">
          The conversation is a channel; the company intelligence loop is the
          product core. That has three consequences you can feel in chat:
        </p>
        <ul className="aurum-item-list">
          <li>
            <div className="aurum-item-head">
              <span className="aurum-item-title">Evidence first</span>
            </div>
            <p className="aurum-item-text">
              Every consequential answer carries its observations and reasoning —
              “show me why” is always one question away.
            </p>
          </li>
          <li>
            <div className="aurum-item-head">
              <span className="aurum-item-title">Findings as cards</span>
            </div>
            <p className="aurum-item-text">
              Goals, unknowns, missions, risks, opportunities and recommendations
              arrive as actionable cards, deep-linked into management mode.
            </p>
          </li>
          <li>
            <div className="aurum-item-head">
              <span className="aurum-item-title">Humans decide</span>
            </div>
            <p className="aurum-item-text">
              Aurum proposes; the authority gate disposes. Consequential actions
              wait for your approval — always.
            </p>
          </li>
        </ul>
      </section>
    </>
  );
}
