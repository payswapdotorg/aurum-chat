// Platform surfaces (W116) — the layout of the (platform) route group.
//
// The operator's review desk: a quiet, chrome-light shell in the same
// messenger visual language as the product (W114 DNA — dark-ink top bar,
// warm cream canvas, gold accent), scoped under `.platform` exactly the
// way the tower and the product shell scope theirs. The root layout
// stays untouched. Pages gate themselves through lib/page-context
// (anonymous and non-admin visitors are redirected before any platform
// markup renders).

import type { ReactNode } from 'react';
import './platform.css';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <div className="platform">
      <a className="platform-skip" href="#platform-main">
        Skip to content
      </a>
      <header className="platform-header">
        <div className="platform-mark" aria-hidden="true">
          A
        </div>
        <div>
          <h1 className="platform-title">Aurum — Platform</h1>
          <p className="platform-subtitle">
            The operator&apos;s review desk · access requests
          </p>
        </div>
        <div className="platform-header-meta">
          Platform administration
          <br />
          Decisions are audited — decided by, decided at
        </div>
      </header>
      <main id="platform-main" className="platform-main">
        {children}
      </main>
      <footer className="platform-footer">
        <span>
          Aurum — the organizational intelligence employee. Every account
          begins as a request the platform team reviews.
        </span>
        <span>
          Access requests are platform records · decisions are append-only
          · invitations skip the queue
        </span>
      </footer>
    </div>
  );
}
