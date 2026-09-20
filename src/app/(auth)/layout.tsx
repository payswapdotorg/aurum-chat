// Auth surfaces (W058) — the layout around sign-in / onboarding /
// invitation pages: brand header, centered column, sticky footer.
//
// These pages render OUTSIDE the product shell (the shell requires an
// authenticated session with an active company); styling is scoped under
// `.aurum-auth` with the same ShareNet-dominant token system.

import type { ReactNode } from 'react';
import './auth.css';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="aurum-auth">
      <a className="aurum-skip" href="#auth-main">
        Skip to content
      </a>
      <main id="auth-main" className="aurum-auth-main">
        <div className="aurum-auth-column">{children}</div>
      </main>
      <footer className="aurum-auth-footer">
        <span>
          Aurum — the organizational intelligence employee. Chat is a
          channel; the company intelligence loop is the product core.
        </span>
        <span>Sessions are membership-verified · PostgreSQL is domain truth</span>
      </footer>
    </div>
  );
}
