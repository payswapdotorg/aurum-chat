// Product shell (W057) — the Marketplace area.
//
// The marketplace hub: an honest structural home for the extension and
// agent-package experiences (browse/install, permission inspection,
// builder flow, governance states — W064's scope). Governance facts that
// are already true architecturally (platform approval is mandatory;
// publication and installation are separate states) are stated plainly —
// they are product semantics, not placeholder content.

import { productContextFromSearchParams } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { PageHead, Panel, ScopeNotice } from '../components/states';
import { ShellGlyph } from '../components/icons';

export const dynamic = 'force-dynamic';

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  const scoped = productContextFromSearchParams(params).ok;

  return (
    <>
      <PageHead
        title="Marketplace"
        description="Extensions and governed agent packages — general software capabilities for your Aurum, not a fixed feature catalog."
        meta={
          scoped ? undefined : (
            <span>Browsing without a company scope — links keep your current scope.</span>
          )
        }
      />
      {!scoped ? <ScopeNotice /> : null}

      <div className="aurum-hub-grid">
        <div className="aurum-hub-card">
          <span className="aurum-hub-label">
            <ShellGlyph name="marketplace" size={16} />
            Browse &amp; install
          </span>
          <span className="aurum-hub-tagline">
            Discover packages, inspect exactly which permissions they request,
            install and activate them for your company.
          </span>
          <span className="aurum-hub-note">coming to this area</span>
        </div>
        <div className="aurum-hub-card">
          <span className="aurum-hub-label">
            <ShellGlyph name="developer" size={16} />
            Build
          </span>
          <span className="aurum-hub-tagline">
            The builder walks a package from design through automated
            verification to submission.
          </span>
          <span className="aurum-hub-note">coming to this area</span>
        </div>
        <div className="aurum-hub-card">
          <span className="aurum-hub-label">
            <ShellGlyph name="tower" size={16} />
            Governance
          </span>
          <span className="aurum-hub-tagline">
            Every submission passes automated verification and platform review —
            publication and installation are separate states.
          </span>
          <span className="aurum-hub-note">always true</span>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel
          title="What is already true"
          blurb="The runtime, builder and marketplace governance exist in the domain; this surface grows around them:"
        >
          <ul className="aurum-item-list">
            <li>
              <p className="aurum-item-text">
                Third-party packages stay <strong>pending until platform
                approval</strong> — no submission can bypass review.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                Install, activate, suspend and rollback are{' '}
                <strong>separate lifecycle states</strong> with full telemetry.
              </p>
            </li>
            <li>
              <p className="aurum-item-text">
                Agent packages ride the <strong>same governance surface</strong>{' '}
                as extensions — permissions, budgets and outcomes included.
              </p>
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
