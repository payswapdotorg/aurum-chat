// Auth surfaces (W058) — the layout of the (auth) route group.
//
// Deliberately chrome-free (the ShareNet quiet entry pattern): a centered
// card on the warm canvas, a subtle Aurum brand, the sticky footer. The
// product shell starts INSIDE the authenticated experience — sign-in,
// sign-up, onboarding and the invitation landing live here.

import type { ReactNode } from 'react';
import './auth.css';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="aurum-auth">
      <a className="aurum-auth-skip" href="#auth-main">
        Skip to content
      </a>
      <main id="auth-main" className="aurum-auth-main">
        {children}
      </main>
      <footer className="aurum-auth-footer">
        <span>Aurum — the organizational intelligence employee.</span>
        <span>Sessions are httpOnly · companies re-verify membership on every request</span>
      </footer>
    </div>
  );
}
