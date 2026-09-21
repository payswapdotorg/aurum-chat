// Product shell (W057 → W075) — the More area.
//
// W075 — NATURAL CAPABILITY DISCOVERY: the More page is the capability
// hub of the measurement frame `Chat → Search/More → capability hub`
// (plan §4). It is now grouped by USER INTENT — capability families
// ("Connect your systems", "Choose the AI Aurum uses", "Extend Aurum's
// capabilities"…), never by Aurum's internal module taxonomy — and every
// entry is rendered from the single intent registry
// (`../lib/capability-hub`), the same source the command search and the
// contextual prompts derive from. "All major product areas
// discoverable" gets its guarantee here: the COMPLETE index, each link
// scope-preserving — the chat conversation, the working surfaces, the
// platform tools, the fifteen management-mode surfaces of the Control
// Tower, and the honest "when Aurum needs something you haven't set up"
// prompts.
//
// W058: the account section — who is signed in, the company switch
// entry, invitations, and sign-out.

import Link from 'next/link';
import { withProductScope } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import {
  CAPABILITY_FAMILIES,
  CAPABILITY_PROMPTS,
} from '../lib/capability-hub';
import { PageHead, Panel } from '../components/states';
import { ShellGlyph } from '../components/icons';
import { CapabilityPromptList } from '../components/capability-prompts';
import { SignOutButton } from '@/app/(auth)/components/sign-out-button';

export const dynamic = 'force-dynamic';

export default async function MorePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  const session = await requireAuthenticatedPage();
  const scopeQuery = withProductScope(params);

  return (
    <>
      <PageHead
        title="More"
        description="Everything Aurum does, grouped by what you came here to do — and the paths that unblock it when something is missing."
      />

      {/* The intent families: the capability hub. One registry
          (capability-hub) renders every family; the management-mode
          family (the Control Tower bridge) is derived from the same
          navigation registry the rail uses, so nothing can drift. */}
      {CAPABILITY_FAMILIES.map((family) => (
        <Panel key={family.id} title={family.heading} blurb={family.blurb}>
          <div className="aurum-hub-grid">
            {family.entries.map((entry) => (
              <Link
                key={entry.id}
                href={`${entry.href}${scopeQuery}`}
                className="aurum-hub-card"
              >
                <span className="aurum-hub-label">
                  <ShellGlyph name={entry.icon} size={16} />
                  {entry.label}
                </span>
                <span className="aurum-hub-tagline">{entry.summary}</span>
                {entry.note === null ? null : (
                  <span className="aurum-hub-note">{entry.note}</span>
                )}
              </Link>
            ))}
          </div>
        </Panel>
      ))}

      {/* W075 — the contextual prompts: when a capability is missing and
          blocks the conversation, the unblocking path is listed here —
          the same prompts the chat experience's context drawer and the
          command search suggestions carry. No dead ends: a blocked
          moment has an entry point. */}
      <Panel
        title="When Aurum can’t do something yet"
        blurb="The blocked moments, and the path that fixes each one:"
      >
        <CapabilityPromptList prompts={CAPABILITY_PROMPTS} />
      </Panel>

      <Panel
        title="Account"
        blurb="Your session, your companies, and the membership flows."
      >
        <ul className="aurum-item-list">
          <li>
            <div className="aurum-item-head">
              <span className="aurum-item-title">{session.principal.displayName}</span>
            </div>
            <p className="aurum-item-text">
              Signed in as <code className="aurum-mono">{session.principal.email}</code>
              · verified company role: <strong>{session.role}</strong> · scope
              re-verified from the session on every request.
            </p>
          </li>
        </ul>
        <div className="aurum-mkt-form-actions" style={{ marginTop: 12 }}>
          <Link className="aurum-btn" data-variant="quiet" href="/onboarding">
            Company &amp; invitations
          </Link>
          <SignOutButton label="Sign out" />
        </div>
      </Panel>

      <Panel
        title="What Aurum is"
        blurb="An organizational intelligence employee — not a chatbot product:"
      >
        <ul className="aurum-item-list">
          <li>
            <p className="aurum-item-text">
              The <strong>company intelligence loop</strong> is the product
              core; chat is a channel.
            </p>
          </li>
          <li>
            <p className="aurum-item-text">
              <strong>Unknown is first-class</strong> — a question plus the
              consequence of not knowing it.
            </p>
          </li>
          <li>
            <p className="aurum-item-text">
              <strong>Learning never overrides policy</strong>, evidence stays
              immutable, and contradictory findings are retained.
            </p>
          </li>
          <li>
            <p className="aurum-item-text">
              <strong>Consequential actions are approval-gated</strong> —
              Aurum proposes, humans dispose.
            </p>
          </li>
        </ul>
      </Panel>

      <section id="keyboard" aria-labelledby="keyboard-title">
        <Panel
          title="Keyboard & accessibility"
          blurb="This shell is fully traversable by keyboard:"
        >
          <table className="aurum-kbd-table">
            <caption className="aurum-sr-only">
              Keyboard shortcuts of the product shell
            </caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="aurum-kbd">⌘</span> /{' '}
                  <span className="aurum-kbd">ctrl</span> +{' '}
                  <span className="aurum-kbd">K</span>
                </td>
                <td>Open the command search</td>
              </tr>
              <tr>
                <td>
                  <span className="aurum-kbd">↑</span>{' '}
                  <span className="aurum-kbd">↓</span>
                </td>
                <td>Move through commands, menu items and results</td>
              </tr>
              <tr>
                <td>
                  <span className="aurum-kbd">↵</span>
                </td>
                <td>Open the selected command</td>
              </tr>
              <tr>
                <td>
                  <span className="aurum-kbd">esc</span>
                </td>
                <td>Close any sheet, drawer or dialog</td>
              </tr>
              <tr>
                <td>
                  <span className="aurum-kbd">tab</span> /{' '}
                  <span className="aurum-kbd">⇧ + tab</span>
                </td>
                <td>
                  Move through the shell; focus is trapped inside open dialogs
                  and returns to the opener on close
                </td>
              </tr>
              <tr>
                <td>skip link</td>
                <td>
                  The first focusable element on every page jumps straight to
                  content
                </td>
              </tr>
            </tbody>
          </table>
          <p className="aurum-panel-blurb" style={{ marginTop: 12, marginBottom: 0 }}>
            Focus is always visible (a calm green ring), color never carries
            meaning alone (every status pill pairs its dot with a label), and
            motion stays restrained — it switches off entirely when your system
            asks for reduced motion.
          </p>
        </Panel>
      </section>
    </>
  );
}
