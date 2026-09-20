'use client';

// Auth surfaces (W058) — the shared sign-out button.
//
// POST /api/auth/sign-out (revokes the session server-side; the route
// clears the httpOnly cookie), then routes to the sign-in page and
// refreshes so no authenticated chrome survives the sign-out.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { postAuthJson } from './auth-fetch';

export function SignOutButton({ label = 'Sign out' }: { label?: string }): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const onSignOut = async () => {
    if (pending) return;
    setPending(true);
    await postAuthJson('/api/auth/sign-out', {});
    router.replace('/signin');
    router.refresh();
  };

  return (
    <button
      type="button"
      className="aurum-auth-btn"
      data-variant="quiet"
      onClick={() => {
        void onSignOut();
      }}
      disabled={pending}
    >
      {pending ? 'Signing out…' : label}
    </button>
  );
}
