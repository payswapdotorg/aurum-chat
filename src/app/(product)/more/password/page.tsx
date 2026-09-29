// Product shell (W116) — /more/password: the change-password surface.
//
// The settings entry the More area links to (messenger style): current
// password + new password + confirm, scrypt re-hash server-side. The
// documented session policy rides the form: every OTHER browser's
// session is revoked, this one stays signed in. The lost-device control
// (sign out everywhere) sits right beside it.
//
// Scope comes from the authenticated session (W058) — there is no tenant
// parameter anywhere in this surface. The page is a server component;
// the interactive controls (client components) POST to /api/auth/password
// and /api/auth/sign-out-everywhere.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { PageHead, Panel } from '../../components/states';
import { PasswordChangeForm } from '../../components/password-change-form';
import { SignOutEverywhereButton } from '../../components/sign-out-everywhere-button';
import { SignOutButton } from '@/app/(auth)/components/sign-out-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Change password — Aurum',
  description: 'Change your Aurum account password and sign out every other browser.',
};

export default async function PasswordPage(): Promise<ReactNode> {
  const session = await requireAuthenticatedPage();

  return (
    <>
      <PageHead
        title="Change password"
        description={`Your account, ${session.principal.displayName} — the password that signs you in.`}
        tone="settings"
      />

      <Panel
        title="Set a new password"
        blurb="The current password confirms it is you. Changing it signs out every other browser — this one stays signed in."
      >
        <PasswordChangeForm />
      </Panel>

      <Panel
        title="Signed-in devices"
        blurb="Lost a device, or lent a browser you should not have? One control ends every session at once."
      >
        <div className="aurum-mkt-form-actions" style={{ marginTop: 12 }}>
          <SignOutEverywhereButton />
          <SignOutButton label="Sign out this browser" />
        </div>
      </Panel>

      <Panel title="Back" blurb="Return to the More area.">
        <div className="aurum-mkt-form-actions" style={{ marginTop: 12 }}>
          <Link className="aurum-btn" data-variant="quiet" href="/more">
            Back to More
          </Link>
        </div>
      </Panel>
    </>
  );
}
