// Auth surfaces (W116) — the waitlist confirmation state of the signup.
//
// Pure presentational component (no hooks, no client-only APIs) so the
// DOM suite can server-render it exactly as the browser receives it. This
// is the signed-out state a person lands in after requesting access: no
// session exists, no cookie was issued, and the copy never reveals
// whether the email was already queued (the idempotent re-request is
// indistinguishable from the first one).

import type { ReactNode } from 'react';
import Link from 'next/link';

export function WaitlistConfirmation(): ReactNode {
  return (
    <div className="aurum-auth-waitlist" role="status">
      <div className="aurum-auth-waitlist-tile" aria-hidden="true">
        A
      </div>
      <h2 className="aurum-auth-waitlist-title">You&apos;re on the waitlist</h2>
      <p className="aurum-auth-waitlist-text">
        The Aurum team will review your request. When your account is
        approved, sign in with the email and password you provided — your
        request is kept, you don&apos;t need to sign up again.
      </p>
      <p className="aurum-auth-waitlist-hint">
        Come back to the sign-in page to check the status of your request.
      </p>
      <Link className="aurum-auth-btn" data-variant="quiet" href="/signin">
        Back to sign in
      </Link>
    </div>
  );
}
