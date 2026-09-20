// Product shell (W057) — the More area.
//
// The everything-else index: the full management-mode surface set (the
// Control Tower), the platform tools (developer console, AI providers —
// their product surfaces arrive with their work items), what Aurum is, and
// the shell's keyboard & accessibility reference. "All major product areas
// discoverable" gets its guarantee here: every destination in one honest
// list, each link scope-preserving.

import Link from 'next/link';
import { requirePageScope } from '@/app/lib/page-session';
import {
  governanceSurfaces,
  overviewSurfaces,
  towerLinksByGroup,
} from '../lib/navigation';
import { PageHead, Panel } from '../components/states';
import { ShellGlyph } from '../components/icons';

export const dynamic = 'force-dynamic';

export default async function MorePage() {
  // W058: authenticated routing — the session carries the company scope.
  await requirePageScope('/more');
  const groups = towerLinksByGroup();

  return (
    <>
      <PageHead
        title="More"
        description="Management mode, platform tools, and the shell itself — everything the product surface exposes, in one place."
      />

      <Panel
        title="Management mode — the Control Tower"
        blurb="The fifteen intelligence and governance surfaces, always available as drill-down destinations. Derived intelligence, never authoritative source state."
      >
        <div className="aurum-hub-grid">
          {groups.flatMap((group) =>
            group.links.map((surface) => (
              <Link
                key={surface.surface}
                href={`${surface.href}`}
                className="aurum-hub-card"
              >
                <span className="aurum-hub-label">
                  <ShellGlyph name="tower" size={16} />
                  {surface.label}
                </span>
                <span className="aurum-hub-tagline">{surface.tagline}</span>
                <span className="aurum-hub-note">{group.heading}</span>
              </Link>
            )),
          )}
        </div>
        <p className="aurum-panel-blurb" style={{ marginTop: 12, marginBottom: 0 }}>
          {overviewSurfaces().length + governanceSurfaces().length} of these
          surfaces also live one click away in Intelligence, People, and the
          command search (⌘K).
        </p>
      </Panel>

      <Panel title="Platform tools" blurb="Developer and AI configuration surfaces:">
        <div className="aurum-hub-grid">
          <div className="aurum-hub-card">
            <span className="aurum-hub-label">
              <ShellGlyph name="developer" size={16} />
              Developer · API · MCP
            </span>
            <span className="aurum-hub-tagline">
              API keys and scopes, webhooks, MCP connection instructions,
              integration activity.
            </span>
            <span className="aurum-hub-note">coming to this area</span>
          </div>
          <div className="aurum-hub-card">
            <span className="aurum-hub-label">
              <ShellGlyph name="spark" size={16} />
              AI providers (BYOA)
            </span>
            <span className="aurum-hub-tagline">
              Your own AI accounts: routing, availability, cost, hot-swap. No
              provider is architecturally privileged.
            </span>
            <span className="aurum-hub-note">coming to this area</span>
          </div>
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
