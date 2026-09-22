// Product shell (W057) — the product-surface layout.
//
// The ShareNet-dominant shell (PRODUCT-SURFACE-DEPLOYMENT-PLAN §3):
// desktop rail + main workflow + overlay system (command search, context
// drawer, notification sheet), or mobile top bar + main + bottom nav.
// The tower (W033) keeps its own (tower) layout and routes — management
// mode stays a drill-down destination, never the first discovery
// mechanism. Styling is fully scoped under `.aurum-shell`; the root layout
// stays untouched, exactly the discipline the tower follows.

import type { ReactNode } from 'react';
import './product.css';
import { resolveSession } from '@/app/lib/session';
import { ProductShellProvider } from './components/product-shell-provider';
import { ShellStateProvider } from './components/shell-state-context';
import { DesktopRail } from './components/desktop-rail';
import { MobileTopBar, MobileBottomNav } from './components/mobile-chrome';
import { CommandSearch } from './components/command-search';
import { ContextDrawer } from './components/context-drawer';

export default async function ProductLayout({ children }: { children: ReactNode }) {
  // Read-only session resolve (no gating): PUBLIC product pages (the
  // marketplace catalog) legitimately render for anonymous visitors, and
  // the chrome must know whether session-scoped state exists at all
  // (W076 — the anonymous public page must not fetch it and 401).
  const session = await resolveSession();
  return (
    <div className="aurum-shell">
      <a className="aurum-skip" href="#product-main">
        Skip to content
      </a>
      <ProductShellProvider>
        <ShellStateProvider authenticated={session.status === 'authenticated'}>
          {/* The mobile top bar is a COLUMN child of the shell (not of the
              body row) so it never stretches to the page content height;
              the body row holds rail + main only. */}
          <MobileTopBar />
          <div className="aurum-body">
            <DesktopRail />
            <main id="product-main" className="aurum-main">
              <div className="aurum-main-inner">{children}</div>
            </main>
          </div>
          <MobileBottomNav />
          <CommandSearch />
          <ContextDrawer />
        </ShellStateProvider>
      </ProductShellProvider>
      <footer className="aurum-footer">
        <span>
          Aurum — the organizational intelligence employee. Chat is a channel;
          the company intelligence loop is the product core.
        </span>
        <span>
          Tenant-scoped reads · evidence-backed findings · approval-gated
          actions · PostgreSQL is domain truth
        </span>
      </footer>
    </div>
  );
}
