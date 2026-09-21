// Auth surfaces (W058 + post-W070 UX hardening) — /signin.
//
// The product entry: email + password. An ?invite=<code> from an
// invitation link rides along into the form (and is redeemed server-side
// after sign-in). Already-signed-in visitors go straight to their
// company (or onboarding) — sign-in is only for the anonymous.
//
// In demo-legal runtimes (never production) the page also offers the
// quick-access panel: one-tap sign-in as a seeded demo persona (the W068
// harness directory — server-side, credentials never reach the client).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getInviteByCode } from '@/modules/auth/contract';
import { DEMO_PERSONAS, demoRole } from '@/modules/demo/contract';
import { resolveSession } from '@/app/lib/session';
import { quickSignInAvailable } from '../lib/api';
import { AuthBrand } from '../components/brand';
import { SignInForm } from '../components/signin-form';
import { QuickSignIn } from '../components/quick-sign-in';
import type { QuickSignInPersona } from '../components/quick-sign-in';

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

  // The quick-access directory: the demo harness's STATIC persona specs
  // (pure constants — names, titles, role labels; the fixed credentials
  // stay server-side and are resolved only inside the quick-sign-in
  // handler). Offered strictly in demo-legal runtimes.
  const quickAvailable = quickSignInAvailable();
  const quickPersonas: readonly QuickSignInPersona[] = quickAvailable
    ? DEMO_PERSONAS.map((spec) => ({
        id: spec.role,
        name: spec.fullName,
        title: spec.title,
        roleLabel: demoRole(spec.role).label,
        email: spec.email,
      }))
    : [];

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
      {quickAvailable ? <QuickSignIn personas={quickPersonas} next={next} /> : null}
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
