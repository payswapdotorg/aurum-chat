// Management Control Tower (W033) — the tower shell.
//
// IMPLEMENTATION-STACK §5: "Control Tower (W033): src/app/(tower)/**
// React pages reading only module contracts via route handlers/server
// code." This layout owns the shell (header, navigation, footer); every
// page in the group renders inside it. The root layout (W000) stays
// untouched — the tower's styling is fully scoped under `.tower`.

import type { ReactNode } from 'react';
import Link from 'next/link';
import './tower.css';
import { TowerNav } from './components/nav';

/** The tower's way home (W115): the control's stable accessible name. */
export const TOWER_BACK_LABEL = 'Back to Aurum Chat';

export default function TowerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="tower">
      <a className="tower-skip" href="#tower-main">
        Skip to content
      </a>
      <header className="tower-header">
        <div className="tower-mark" aria-hidden="true">
          A
        </div>
        <div className="tower-heading">
          <h1 className="tower-title">Aurum — Management Control Tower</h1>
          <p className="tower-subtitle">
            Goals · Situation · Unknowns · Missions · Risks · Opportunities ·
            Capabilities · Processes · Workforce · Agents · Automation ·
            Evidence · Recommendations · Approvals
          </p>
        </div>
        <div className="tower-header-meta">
          Summaries of your records — the source systems remain the record of
          truth
          <br />
          Management briefing — assembled live from your company's records
        </div>
        {/* W115 — the way home: the shell owns the chrome, so every one of
            the fifteen surfaces inherits this control. A real link to the
            employee app's /chat (keyboard focusable, named for assistive
            tech, styled as the tower's dark-ink channel bar in tower.css)
            — the journey back never depends on hand-editing the URL. */}
        <Link className="tower-back" href="/chat" aria-label={TOWER_BACK_LABEL}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            role="presentation"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          {TOWER_BACK_LABEL}
        </Link>
      </header>
      <div className="tower-body">
        <TowerNav />
        <main id="tower-main" className="tower-main">
          {children}
        </main>
      </div>
      <footer className="tower-footer">
        <span>
          Aurum — the organizational intelligence employee. Management briefings
          summarize your company's records — the source systems remain the
          record of truth.
        </span>
        <span>
          Every finding cites its evidence · changes are recorded, never
          rewritten
        </span>
      </footer>
    </div>
  );
}
