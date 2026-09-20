// Auth surfaces (W058) — /signin.
//
// The product entry: email + password. An ?invite=<code> from an
// invitation link rides along into the form (and is redeemed server-side
// after sign-in). Already-signed-in visitors go straight to their
// company (or onboarding) — sign-in is only for the anonymous.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getInviteByCode } from '@/modules/auth/contract';
import { resolveSession } from '@/app/lib/session';
import { AuthBrand } from '../components/brand';
import { SignInForm } from '../components/signin-form';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  const inviteCode = first(params['invite']);
  const next = first(params['next']);

  const session = await resolveSession();
  if (session.status !== 'anonymous') {
    redirect(session.status === 'authenticated' ? '/chat' : '/onboarding');
  }

  let inviteCompanyName: string | null = null;
  let inviteUsable = true;
  if (inviteCode !== null) {
    try {
      const preview = await getInviteByCode({ code: inviteCode });
      inviteCompanyName = preview.tenantName;
    } catch {
      inviteUsable = false;
      inviteCompanyName = null;
    }
  }

  return (
    <div className="aurum-auth-card">
      <AuthBrand tag="Sign in to your company workspace" />
      <h1 className="aurum-auth-title">Welcome back</h1>
      <p className="aurum-auth-blurb">
        Aurum is your company&apos;s organizational intelligence employee —
        evidence-backed answers, proactive findings, and approval-gated
        actions in one conversation.
      </p>
      {inviteCode !== null && !inviteUsable ? (
        <p className="aurum-auth-error" role="alert" style={{ marginBottom: 13 }}>
          The invitation link is no longer usable — you can still sign in and
          ask your company&apos;s admin for a fresh invitation.
        </p>
      ) : null}
      <SignInForm
        inviteCode={inviteCode}
        inviteCompanyName={inviteUsable ? inviteCompanyName : null}
        next={next}
      />
      <div className="aurum-auth-alt">
        <span>
          New to Aurum?{' '}
          <Link
            href={inviteCode === null ? '/signup' : `/signup?invite=${encodeURIComponent(inviteCode)}`}
          >
            Create an account
          </Link>
        </span>
      </div>
    </div>
  );
}
