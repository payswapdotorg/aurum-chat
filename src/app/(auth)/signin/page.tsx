// Auth surfaces (W058) — the sign-in page (public).
//
// The product's front door: an unauthenticated visitor lands here (the
// middleware redirects protected routes here with ?next= preserved). A
// visitor who already carries a live session goes straight to their
// destination — sign-in is never a detour.

import { redirect } from 'next/navigation';
import { pageScope } from '@/app/lib/page-session';
import { SignInForm } from '../components/signin-form';
import { sanitizeNextPath } from '../lib/next-path';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params['next']) ? params['next'][0] : params['next'];
  const next = sanitizeNextPath(rawNext);

  const scope = await pageScope();
  if (scope.phase !== 'unauthenticated') {
    // Already signed in (and scoped, or heading through onboarding).
    redirect(scope.phase === 'ready' ? next : '/onboarding');
  }

  return (
    <>
      <header className="aurum-auth-brand">
        <span className="aurum-auth-mark" aria-hidden="true">
          A
        </span>
        <div>
          <h1>Aurum</h1>
          <p>The organizational intelligence employee for your company</p>
        </div>
      </header>
      <SignInForm next={next} />
      <p className="aurum-auth-note">
        Aurum answers with evidence, follows up on its own unknowns, and
        brings consequential actions to a human approval gate. Your company
        scope follows your membership — never a URL parameter.
      </p>
    </>
  );
}
