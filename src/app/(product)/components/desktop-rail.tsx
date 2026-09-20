'use client';

// Product shell (W057) — the desktop rail.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Canonical product shell — Desktop":
// left rail with the product areas, plus the shell's global cluster
// (command search, notification entry) and the honest presence block at the
// bottom — the ShareNet reference's slim persistent sidebar pattern: warm
// sidebar tone, hairline right border, soft-green active pill, generous
// spacing, no dashboard density. The rail is a client component only
// because active-state needs the pathname.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { TenantSwitcher } from './tenant-switcher';
import { NotificationEntry } from './notification-entry';
import { useProductShell } from './product-shell-provider';
import { useShellState } from './shell-state-context';
import { ShellGlyph } from './icons';
import { activeAreaId, productArea, railNavAreas } from '../lib/navigation';

export function DesktopRail(): ReactNode {
  const pathname = usePathname() ?? '/';
  const { openCommandSearch } = useProductShell();
  const { status } = useShellState();
  const active = activeAreaId(pathname);
  const scoped =
    status.phase === 'ready' && status.envelope.view.company.ok
      ? status.envelope.view.company.tenant.name
      : null;

  return (
    <aside className="aurum-rail" aria-label="Product navigation">
      <div className="aurum-rail-head">
        <a className="aurum-brand" href="/chat" aria-label="Aurum home">
          <span className="aurum-brand-tile" aria-hidden="true">
            A
          </span>
          <span>
            <span className="aurum-brand-name">Aurum</span>
            <span className="aurum-brand-sub">intelligence employee</span>
          </span>
        </a>
      </div>

      <div style={{ padding: '0 12px 4px' }}>
        <TenantSwitcher variant="rail" />
      </div>

      <nav className="aurum-rail-nav" aria-label="Primary">
        <p className="aurum-rail-heading">Product</p>
        {railNavAreas()
          .filter((area) => area.mode === 'product')
          .map((area) => (
            <Link
              key={area.id}
              href={area.href}
              className="aurum-rail-link"
              aria-current={active === area.id ? 'page' : undefined}
            >
              <ShellGlyph name={area.icon} />
              <span>{area.label}</span>
            </Link>
          ))}

        <p className="aurum-rail-heading">Management mode</p>
        <Link
          href="/today"
          className="aurum-rail-link"
          aria-current={undefined}
        >
          <ShellGlyph name={productArea('today').icon} />
          <span>{productArea('today').label}</span>
          <span className="aurum-nav-note">tower</span>
        </Link>
        <Link href="/more" className="aurum-rail-link" aria-current={active === 'more' ? 'page' : undefined}>
          <ShellGlyph name={productArea('more').icon} />
          <span>{productArea('more').label}</span>
        </Link>
      </nav>

      <div className="aurum-rail-foot">
        <div className="aurum-rail-cluster">
          <button
            type="button"
            className="aurum-cluster-btn"
            onClick={openCommandSearch}
          >
            <ShellGlyph name="search" size={15} />
            <span>Search</span>
            <span className="aurum-kbd" style={{ marginLeft: 'auto' }}>
              ⌘K
            </span>
          </button>
        </div>
        <div className="aurum-rail-cluster">
          <NotificationEntry variant="button" />
        </div>
        <p className="aurum-presence" data-scoped={scoped !== null}>
          <span className="aurum-presence-dot" aria-hidden="true" />
          <span>
            {scoped === null ? (
              <>
                <strong>Aurum</strong> — no company selected
              </>
            ) : (
              <>
                <strong>Aurum</strong> — on duty at {scoped}
              </>
            )}
          </span>
        </p>
      </div>
    </aside>
  );
}
