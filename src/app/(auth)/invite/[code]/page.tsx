// Auth surfaces (W058) — /invite/<code>, the public invitation landing.
//
// The code itself is the capability (an opaque random token): the page
// shows what the invitation grants — which company, which role, which
// workspace — resolved through the issuer's context. An unusable code
// gets the honest quiet state. A signed-in principal with the matching
// email can accept immediately; everyone else is routed through sign-in
// / sign-up with the code riding along (?invite=<code>).

import Link from 'next/link';
import type { ReactNode } from 'react';
import { getInviteByCode } from '@/modules/auth/contract';
import { resolveSession } from '@/app/lib/session';
import { AuthBrand } from '../../components/brand';
import { AcceptInviteButton } from '../../components/accept-invite-button';

export const dynamic = 'force-dynamic';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<ReactNode> {
  const { code } = await params;
  const session = await resolveSession();

  let preview: Awaited<ReturnType<typeof getInviteByCode>> | null;
  try {
    preview = await getInviteByCode({ code });
  } catch {
    preview = null;
  }

  if (preview === null) {
    return (
      <div className="aurum-auth-card">
        <AuthBrand tag="Invitation" />
        <h1 className="aurum-auth-title">This invitation is no longer usable</h1>
        <p className="aurum-auth-blurb">
          Invitation codes are single-use, expire after seven days, and can
          be revoked by the company that issued them. Ask your company&apos;s
          admin for a fresh link — then sign in with the email it names.
        </p>
        <div className="aurum-auth-alt">
          <span>
            <Link href="/signin">Sign in</Link> ·{' '}
            <Link href="/signup">Create an account</Link>
          </span>
        </div>
      </div>
    );
  }

  const signedInAndMatches =
    session.status !== 'anonymous' && session.principal.email === preview.email;
  const signedInMismatch =
    session.status !== 'anonymous' && session.principal.email !== preview.email;

  return (
    <div className="aurum-auth-card">
      <AuthBrand tag="Invitation" />
      <h1 className="aurum-auth-title">
        {preview.tenantName === null
          ? 'You are invited to join a company on Aurum'
          : `${preview.tenantName} invited you to Aurum`}
      </h1>
      <p className="aurum-auth-blurb">
        This invitation grants the <strong>{preview.role}</strong> role
        {preview.workspaceName === null
          ? ' in the company'
          : ` in the company and the ${preview.workspaceName} workspace`}
        , bound to <strong>{preview.email}</strong>.
        {preview.tenantName === null
          ? ' The company name is not shown because the issuer no longer verifies.'
          : ''}
      </p>

      {signedInAndMatches ? (
        <AcceptInviteButton code={code} />
      ) : signedInMismatch ? (
        <p className="aurum-auth-notice" role="status">
          You are signed in as <strong>{session.principal.email}</strong>, but
          this invitation was issued to{' '}
          <strong>{preview!.email}</strong>. Sign out and use the invited
          address (or ask for a new invitation for your address).
        </p>
      ) : (
        <div className="aurum-auth-alt">
          <span>
            <Link href={`/signin?invite=${encodeURIComponent(code)}`}>
              Sign in to accept
            </Link>
          </span>
          <span>
            New to Aurum?{' '}
            <Link href={`/signup?invite=${encodeURIComponent(code)}`}>
              Create an account with {preview.email}
            </Link>
          </span>
        </div>
      )}
    </div>
  );
}
