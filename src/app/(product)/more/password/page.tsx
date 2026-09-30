// Product shell (W116) — the password settings page of the More area.
//
// Reached from /more (the settings list): change password + sign out
// everywhere, the two account-security entries the authentication
// completion adds. Follows the More page's own patterns — PageHead with
// the settings tone, quiet panels, the marketplace form classes — and
// restructures nothing.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { PageHead, Panel } from '../../components/states';
import { ChangePasswordForm } from '../components/change-password-form';
import { SignOutEverywhereButton } from '../components/sign-out-everywhere-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "Change your password — Aurum",
  description: "Change the password you sign in with.",
};

export default async function PasswordSettingsPage() {
  const session = await requireAuthenticatedPage();

  return (
    <>
      <PageHead
        title="Password & sessions"
        description="Your account's credentials and the sessions holding it open — change the password, or close every session at once."
        tone="settings"
      />

      <Panel
        title="Change password"
        blurb="The current password is re-verified; the new one is stored as a scrypt verifier, never in plain text."
      >
        <ChangePasswordForm />
        <p className="aurum-item-text" style={{ marginTop: 12, marginBottom: 0 }}>
          Changing the password signs out every other session of yours —
          this one stays signed in. Signed in somewhere you don&apos;t
          recognize? Change the password, or close everything below.
        </p>
      </Panel>

      <Panel
        title="Sign out everywhere"
        blurb={`Revoke every session of ${session.principal.email} — every browser, including this one.`}
      >
        <div className="aurum-mkt-form-actions">
          <SignOutEverywhereButton />
          <Link className="aurum-btn" data-variant="quiet" href="/more">
            Back to More
          </Link>
        </div>
      </Panel>
    </>
  );
}
