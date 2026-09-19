// Product shell (W057) — the Intelligence area.
//
// The intelligence hub: every intelligence surface of management mode,
// discoverable in one place with plain-language intent (plan §3: the tower
// surfaces "become drill-down destinations rather than the first discovery
// mechanism"). The guided intelligence workflow — the navigable
// goal → gap → unknown → mission → evidence → belief chain — is W061's
// scope; this hub is its shell home.

import Link from 'next/link';
import { productContextFromSearchParams, withProductScope } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { intelligenceSurfaces } from '../lib/navigation';
import { PageHead, Panel, ScopeNotice } from '../components/states';
import { ShellGlyph } from '../components/icons';

export const dynamic = 'force-dynamic';

export default async function IntelligencePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  const scoped = productContextFromSearchParams(params).ok;
  const scopeQuery = withProductScope(params);
  const surfaces = intelligenceSurfaces();

  return (
    <>
      <PageHead
        title="Intelligence"
        description="Everything Aurum understands about where the company is heading and what it has found — direction, risks, opportunities and the mechanics underneath."
        meta={
          scoped ? undefined : (
            <span>Browsing without a company scope — links keep your current scope.</span>
          )
        }
      />
      {!scoped ? <ScopeNotice /> : null}

      <div className="aurum-hub-grid">
        {surfaces.map((surface) => (
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
          title="The intelligence loop, in one paragraph"
          blurb="What these surfaces share — and what the guided workflow will walk through surface by surface:"
        >
          <ul className="aurum-item-list">
            <li>
              <p className="aurum-item-text">
                <strong>Goals</strong> state where the company wants to be;{' '}
                <strong>situation</strong> is where it is.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                The gap between them becomes <strong>unknowns</strong> when not
                knowing is consequential — and <strong>missions</strong> when it
                is worth learning.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                What missions find becomes <strong>evidence</strong>, then{' '}
                <strong>risks</strong>, <strong>opportunities</strong> and{' '}
                <strong>recommendations</strong> — each traceable back to its
                observations.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                <strong>Capabilities</strong>, <strong>processes</strong> and{' '}
                <strong>automation</strong> show whether the company can act on
                what it knows.
              </p>
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
