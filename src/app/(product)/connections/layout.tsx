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
          Assembled live from your connected systems — always current
        </div>
      </header>
      <main id="conn-main" className="conn-body">
        {children}
      </main>
      <footer className="conn-footer">
        <span>
          Your company's connectors · credentials stay sealed — Aurum never
          displays them · providers stay isolated
        </span>
        <span>
          Connection health is computed from live connector state — your source
          systems remain the record of truth
        </span>
      </footer>
    </div>
  );
}
