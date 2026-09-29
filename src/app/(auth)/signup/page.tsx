// Auth surfaces (W058/W116) — /signup.
//
// The waitlist-gated entry (W116): a request without a usable invitation
// joins the access waitlist — the Aurum team accepts accounts before they
// exist. ?invite=<code> from an invitation link pre-fills the bound email
// and keeps today's immediate-access path (an invitation is already
// admin-granted trust, redeemed server-side after registration).
// Already-signed-in visitors are routed onward.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getInviteByCode } from '@/modules/auth/contract';
import { resolveSession } from '@/app/lib/session';
import { AuthBrand } from '../components/brand';
import { SignUpForm } from '../components/signup-form';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  const inviteCode = first(params['invite']);

  const session = await resolveSession();
  if (session.status !== 'anonymous') {
    redirect(session.status === 'authenticated' ? '/chat' : '/onboarding');
  }

  let inviteCompanyName: string | null = null;
  let inviteEmail: string | null = null;
  let inviteUsable = true;
  if (inviteCode !== null) {
    try {
      const preview = await getInviteByCode({ code: inviteCode });
      inviteCompanyName = preview.tenantName;
      inviteEmail = preview.email;
    } catch {
      inviteUsable = false;
    }
  }

  return (
    <div className="aurum-auth-card">
      <AuthBrand tag={inviteCode === null ? 'Request an account' : 'Create your account'} />
      <h1 className="aurum-auth-title">Get started with Aurum</h1>
      <p className="aurum-auth-blurb">
        {inviteCode !== null && inviteUsable
          ? "One account, your company's workspace. You are creating it now to accept your invitation — then Aurum starts work as your organizational intelligence employee."
          : 'Sign-up puts your request on a short waitlist — the Aurum team reviews every account before it is created. Once accepted, you sign in and create or join your company.'}
      </p>
      {inviteCode !== null && !inviteUsable ? (
        <p className="aurum-auth-error" role="alert" style={{ marginBottom: 13 }}>
          The invitation link is no longer usable — you can still request an
          account; ask your company&apos;s admin for a fresh invitation.
        </p>
      ) : null}
      <SignUpForm
        inviteCode={inviteCode}
        inviteCompanyName={inviteUsable ? inviteCompanyName : null}
        inviteEmail={inviteUsable ? inviteEmail : null}
      />
      <div className="aurum-auth-alt">
        <span>
          Already have an account?{' '}
          <Link
            href={inviteCode === null ? '/signin' : `/signin?invite=${encodeURIComponent(inviteCode)}`}
          >
            Sign in
          </Link>
        </span>
      </div>
    </div>
  );
}
