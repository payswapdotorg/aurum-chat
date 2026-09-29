'use client';

// Product shell (W116) — the sign-out-everywhere button of the More area.
//
// POST /api/auth/sign-out-everywhere (revokes EVERY session of the
// principal, including this one; the route clears the httpOnly cookie),
// then routes to the sign-in page and refreshes so no authenticated
// chrome survives — the same discipline the shared SignOutButton follows.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export function SignOutEverywhereButton({
  label = 'Sign out everywhere',
}: {
  label?: string;
}): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const onSignOutEverywhere = async () => {
    if (pending) return;
    setPending(true);
    try {
      await fetch('/api/auth/sign-out-everywhere', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
    } catch {
      // Uniformly quiet — the cookie is cleared client-side regardless.
    }
    router.replace('/signin');
    router.refresh();
  };

  return (
    <button
      type="button"
      className="aurum-btn"
      data-variant="quiet"
      onClick={() => {
        void onSignOutEverywhere();
      }}
      disabled={pending}
    >
      {pending ? 'Signing out…' : label}
    </button>
  );
}
