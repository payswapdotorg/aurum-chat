// Connection & Integration Hub (W059) — the product-surface shell for the
// connections center.
//
// This layout owns ONLY this surface's chrome (skip link, header, sticky
// footer); the unified product shell (left rail / mobile bottom nav,
// command search, tenant switcher) is W057's scope and will absorb this
// surface. Styling is fully scoped under `.conn` (ShareNet-dominant visual
// system: warm off-white canvas, soft graphite, hairlines, status pills);
// the root layout (W000) stays untouched.

import type { ReactNode } from 'react';
import './connections.css';

export default function ConnectionsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="conn">
      <a className="conn-skip" href="#conn-main">
        Skip to content
      </a>
      <header className="conn-header">
        <div className="conn-mark" aria-hidden="true">
          A
        </div>
        <div>
          <h1 className="conn-title">Connections</h1>
          <p className="conn-sub">
            Channels · Source systems · Destinations · Identity verification
          </p>
        </div>
        <div className="conn-header-meta">
          Aurum — the organizational intelligence employee
          <br />
          Composed from domain contracts — never a second source of truth
        </div>
      </header>
      <main id="conn-main" className="conn-body">
        {children}
      </main>
      <footer className="conn-footer">
        <span>
          Tenant-owned connectors · opaque credential references only ·
          provider isolation enforced
        </span>
        <span>
          Connection health is derived from contract state — PostgreSQL is
          domain truth
        </span>
      </footer>
    </div>
  );
}
