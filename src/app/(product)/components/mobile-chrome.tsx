'use client';

// Product shell (W057) — the mobile chrome.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Canonical product shell — Mobile":
// "top: company + Aurum identity + presence/status; center: chat or
// selected surface; bottom: Chat / Today / Intelligence / People / More".
// The top bar carries the compact company switcher, the presence pill and
// the global entries (search, notifications); the bottom nav carries the
// five areas with 56px touch targets, an active pill and safe-area
// padding — a first-class mobile experience, not a horizontal-scroll
// adaptation.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { TenantSwitcher } from './tenant-switcher';
import { NotificationEntry } from './notification-entry';
import { useProductShell } from './product-shell-provider';
import { useShellState } from './shell-state-context';
import { ShellGlyph } from './icons';
import { activeAreaId, mobileNavAreas } from '../lib/navigation';

export function MobileTopBar(): ReactNode {
  const { openCommandSearch } = useProductShell();
  const { status } = useShellState();
  const scoped =
    status.phase === 'ready' && status.envelope.view.company.ok
      ? status.envelope.view.company.tenant.name
      : null;

  return (
    <header className="aurum-topbar" aria-label="Primary">
      <TenantSwitcher variant="topbar" />
      <p className="aurum-presence" data-scoped={scoped !== null} style={{ padding: '6px 10px' }}>
        <span className="aurum-presence-dot" aria-hidden="true" />
        <span>
          {scoped === null ? (
            <strong>Aurum</strong>
          ) : (
            <>
              <strong>Aurum</strong> · on duty
            </>
          )}
        </span>
      </p>
      <span className="aurum-topbar-spacer" />
      <button
        type="button"
        className="aurum-icon-btn"
        aria-label="Search (command menu)"
        onClick={openCommandSearch}
      >
        <ShellGlyph name="search" size={20} />
      </button>
      <NotificationEntry variant="icon" />
    </header>
  );
}

export function MobileBottomNav(): ReactNode {
  const pathname = usePathname() ?? '/';
  const active = activeAreaId(pathname);
  return (
    <nav className="aurum-bottomnav" aria-label="Primary navigation">
      <ul>
        {mobileNavAreas().map((area) => (
          <li key={area.id}>
            <Link
              href={area.href}
              aria-current={active === area.id ? 'page' : undefined}
              aria-label={
                area.mode === 'management'
                  ? `${area.label} (management mode)`
                  : area.label
              }
            >
              <ShellGlyph name={area.icon} size={20} />
              <span>{area.shortLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
