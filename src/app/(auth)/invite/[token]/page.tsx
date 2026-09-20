// Auth surfaces (W058) — the invitation landing page: /invite/<token>.
//
// PUBLIC route (the token itself is the authorization to see the
// invitation — possession doctrine). Unauthenticated holders are sent to
// sign-in with the invite URL preserved as ?next=, so the round trip
// lands right back here, signed in with the invited email.
//
// States rendered honestly: pending (the accept control), accepted,
// withdrawn, expired, unknown — each with guidance, never a dead end.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageScope } from '@/app/lib/page-session';
import { inspectInvitation } from '@/modules/auth/contract';
import { AcceptInviteForm } from '../../components/accept-invite-form';
import { sanitizeNextPath } from '../../lib/next-path';

export const dynamic = 'force-dynamic';

function roleLabel(role: string): string {
  if (role === 'owner') return 'an owner';
  if (role === 'admin') return 'an admin';
  return 'a member';
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const scope = await pageScope();
  if (scope.phase === 'unauthenticated') {
    const next = sanitizeNextPath(`/invite/${token}`);
    redirect(`/signin?next=${encodeURIComponent(next)}`);
  }

  const invitation = await inspectInvitation(token);

  return (
    <>
      <header className="aurum-auth-brand">
        <span className="aurum-auth-mark" aria-hidden="true">
          A
        </span>
        <div>
          <h1>Aurum invitation</h1>
          <p>Signed in as {scope.principal.email}</p>
        </div>
      </header>

      {invitation.status === 'pending' ? (
        <section className="aurum-auth-card" aria-labelledby="aurum-invite-pending-title">
          <h2 id="aurum-invite-pending-title">
            Join {invitation.tenantName} on Aurum
          </h2>
          <p className="aurum-auth-sub">
            You were invited as {roleLabel(invitation.tenantRole)}
            {invitation.workspaceRole === null
              ? ''
              : `, with the ${invitation.workspaceRole} role in a workspace`}{' '}
            — the invitation is addressed to{' '}
            <strong>{invitation.email}</strong>.
          </p>
          {invitation.email === scope.principal.email ? (
            <AcceptInviteForm token={token} />
          ) : (
            <p className="aurum-auth-warn" role="alert">
              This invitation was issued for{' '}
              <strong>{invitation.email}</strong>, but you are signed in as{' '}
              <strong>{scope.principal.email}</strong>. Sign in with the
              invited email to accept it — invite links are personal.
            </p>
          )}
          <p className="aurum-auth-hint" style={{ marginTop: 12 }}>
            Valid until {new Date(invitation.expiresAt).toUTCString()}.
          </p>
        </section>
      ) : invitation.status === 'accepted' ? (
        <section className="aurum-auth-card" aria-labelledby="aurum-invite-done-title">
          <h2 id="aurum-invite-done-title">This invitation was already used</h2>
          <p className="aurum-auth-sub">
            Someone accepted it — if that was you, your company is already
            waiting.
          </p>
          <div className="aurum-auth-actions">
            <Link className="aurum-auth-btn" href="/chat">
              Go to Aurum chat
            </Link>
            <Link className="aurum-auth-btn" data-variant="quiet" href="/onboarding">
              Your companies
            </Link>
          </div>
        </section>
      ) : invitation.status === 'revoked' ? (
        <section className="aurum-auth-card" aria-labelledby="aurum-invite-revoked-title">
          <h2 id="aurum-invite-revoked-title">This invitation was withdrawn</h2>
          <p className="aurum-auth-sub">
            Ask your colleague for a fresh link — withdrawing is how an
            invitation is kept personal.
          </p>
          <div className="aurum-auth-actions">
            <Link className="aurum-auth-btn" data-variant="quiet" href="/onboarding">
              Back to onboarding
            </Link>
          </div>
        </section>
      ) : invitation.status === 'expired' ? (
        <section className="aurum-auth-card" aria-labelledby="aurum-invite-expired-title">
          <h2 id="aurum-invite-expired-title">This invitation has expired</h2>
          <p className="aurum-auth-sub">
            Invitations live for 7 days. Ask your colleague to invite you
            again.
          </p>
          <div className="aurum-auth-actions">
            <Link className="aurum-auth-btn" data-variant="quiet" href="/onboarding">
              Back to onboarding
            </Link>
          </div>
        </section>
      ) : (
        <section className="aurum-auth-card" aria-labelledby="aurum-invite-unknown-title">
          <h2 id="aurum-invite-unknown-title">This invitation link is not valid</h2>
          <p className="aurum-auth-sub">
            It may have been mistyped or replaced by a newer invitation.
            Ask your colleague for the link again.
          </p>
          <div className="aurum-auth-actions">
            <Link className="aurum-auth-btn" data-variant="quiet" href="/onboarding">
              Back to onboarding
            </Link>
          </div>
        </section>
      )}
    </>
  );
}
