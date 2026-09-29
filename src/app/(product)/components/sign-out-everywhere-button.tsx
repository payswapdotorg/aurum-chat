'use client';

// Product shell (W116) — the sign-out-everywhere button.
//
// POST /api/auth/sign-out-everywhere: revokes EVERY live session of the
// principal (this browser included), clears the cookie and routes to the
// sign-in page — the "lost device" control next to the password change.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { postAuthJson } from '@/app/(auth)/components/auth-fetch';

export function SignOutEverywhereButton({ label = 'Sign out everywhere' }: { label?: string }): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const onSignOutEverywhere = async () => {
    if (pending) return;
    setPending(true);
    await postAuthJson('/api/auth/sign-out-everywhere', {});
    router.replace('/signin');
    router.refresh();
  };

  return (
    <button
      type="button"
      className="aurum-auth-btn"
      data-variant="quiet"
      onClick={() => {
        void onSignOutEverywhere();
      }}
      disabled={pending}
    >
      {pending ? 'Signing out everywhere…' : label}
    </button>
  );
}
