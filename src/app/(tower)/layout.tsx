// Management Control Tower (W033) — the tower shell.
//
// IMPLEMENTATION-STACK §5: "Control Tower (W033): src/app/(tower)/**
// React pages reading only module contracts via route handlers/server
// code." This layout owns the shell (header, navigation, footer); every
// page in the group renders inside it. The root layout (W000) stays
// untouched — the tower's styling is fully scoped under `.tower`.

import type { ReactNode } from 'react';
import './tower.css';
import { TowerNav } from './components/nav';

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
        <div>
          <h1 className="tower-title">Aurum — Management Control Tower</h1>
          <p className="tower-subtitle">
            Goals · Situation · Unknowns · Missions · Risks · Opportunities ·
            Capabilities · Processes · Workforce · Agents · Automation ·
            Evidence · Recommendations · Approvals
          </p>
        </div>
        <div className="tower-header-meta">
          Derived intelligence — never authoritative source state
          <br />
          Management surface W033 (lock 33/34)
        </div>
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
          are derived intelligence, not authoritative source state.
        </span>
        <span>
          PostgreSQL is domain truth · tenant-scoped reads · policy-gated
          actions · append-only evidence
        </span>
      </footer>
    </div>
  );
}
