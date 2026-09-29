// Platform admin surface (W116) — the (platform) route group's layout.
//
// A deliberate sibling of the (auth) group's quiet card and the tower's
// dark-ink shell: the platform administration area is Chrome-light and
// messenger-toned — the W114 language (thread sand canvas, dark-ink
// header bar, gold accent, hairline dividers) scoped fully under
// `.aurum-platform`. The root layout stays untouched, exactly the
// discipline the tower and the product shell follow.
//
// Gating is NOT done here: each page resolves its own session and
// redirects (the (product) shell's read-only resolve pattern does not
// fit — this group exists ONLY for platform-admin surfaces, so the page
// itself is the gate; anonymous visitors bounce to /signin, everyone
// else to /chat, with no "access denied" page to leak the area).

import type { ReactNode } from 'react';
import './platform.css';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <div className="aurum-platform">
      <a className="aurum-platform-skip" href="#platform-main">
        Skip to content
      </a>
      <header className="aurum-platform-header">
        <div className="aurum-platform-mark" aria-hidden="true">
          A
        </div>
        <div className="aurum-platform-heading">
          <h1 className="aurum-platform-title">Aurum — Platform</h1>
          <p className="aurum-platform-subtitle">The access waitlist · admin review</p>
        </div>
        <nav aria-label="Platform areas">
          <a className="aurum-platform-back" href="/chat">
            Back to Aurum Chat
          </a>
        </nav>
      </header>
      <main id="platform-main" className="aurum-platform-main">
        {children}
      </main>
      <footer className="aurum-platform-footer">
        <span>
          Aurum — the organizational intelligence employee. Platform
          administration, never tenant data.
        </span>
        <span>Decisions are audited · decided by principal id · sessions re-verify on every request</span>
      </footer>
    </div>
  );
}
