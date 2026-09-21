// Product shell (W057) — the People area.
//
// The people hub: workforce and agents (management mode) plus the
// employee-facing learning/contribution experience (W062 — the Learning
// surface) and the capability/agent interventions surface (W063).
// Honest structural hub — no invented data.

import Link from 'next/link';
import { withProductScope } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { peopleSurfaces } from '../lib/navigation';
import { PageHead, Panel } from '../components/states';
import { ShellGlyph } from '../components/icons';

export const dynamic = 'force-dynamic';

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  await requireAuthenticatedPage();
  const scopeQuery = withProductScope(params);

  return (
    <>
      <PageHead
        title="People"
        description="The humans and the agents doing the work — who they are, what they know, and how Aurum helps without ever making employment decisions on its own."
      />

      <div className="aurum-hub-grid">
        {peopleSurfaces().map((surface) => (
          <Link
            key={surface.surface}
            href={`${surface.href}${scopeQuery}`}
            className="aurum-hub-card"
          >
            <span className="aurum-hub-label">
              <ShellGlyph name="tower" size={16} />
              {surface.label}
            </span>
            <span className="aurum-hub-tagline">{surface.tagline}</span>
            <span className="aurum-hub-note">management mode</span>
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel
          title="Learning and contributions"
          blurb="Aurum asks employees targeted questions; answers become evidence, acknowledgements and rewards under the company’s explicit policy."
        >
          <div className="aurum-hub-grid">
            <Link className="aurum-hub-card" href="/learning">
              <span className="aurum-hub-label">
                <ShellGlyph name="people" size={16} />
                Learning
              </span>
              <span className="aurum-hub-tagline">
                Open knowledge requests, learning missions with progress, contribution
                acknowledgement and reward status.
              </span>
              <span className="aurum-hub-note">employee experience</span>
            </Link>
          </div>
        </Panel>
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel
          title="Capability and agent interventions"
          blurb="Where the company is short, the compared ways to close the gap, and the full agent/workforce lifecycle — decided by humans, tracked to outcomes."
        >
          <div className="aurum-hub-grid">
            <Link className="aurum-hub-card" href="/interventions">
              <span className="aurum-hub-label">
                <ShellGlyph name="people" size={16} />
                Interventions
              </span>
              <span className="aurum-hub-tagline">
                Compare train, reassignment, hiring, automation, agent recruitment, installs and
                outsourcing against a measured gap; decide proposals, activate agents and teams,
                and track what the interventions moved.
              </span>
              <span className="aurum-hub-note">management experience</span>
            </Link>
          </div>
          <p className="aurum-learn-separation" role="note" style={{ marginTop: 14 }}>
            Employment decisions stay human-authorized — Aurum surfaces alternatives, uncertainty
            and evidence; it never autonomously terminates or disciplines a human employee.
          </p>
        </Panel>
      </div>
    </>
  );
}
