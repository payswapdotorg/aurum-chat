'use client';

// Auth surfaces (W058) — the invitation accept button (the invite landing
// page for an already-signed-in principal with the matching email).
//
// POST /api/auth/invite/redeem: the membership grant + the company becomes
// the session's active selection → chat.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { dispatchShellRefresh } from '@/app/(product)/lib/shell-events';
import { postAuthJson } from './auth-fetch';

export function AcceptInviteButton({ code }: { code: string }): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAccept = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await postAuthJson('/api/auth/invite/redeem', { code });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string' ? outcome.body['message'] : 'the invitation could not be redeemed';
      setError(message);
      setPending(false);
      return;
    }
    dispatchShellRefresh();
    router.replace('/chat');
  };

  return (
    <div>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}
      <button
        className="aurum-auth-btn"
        type="button"
        onClick={() => {
          void onAccept();
        }}
        disabled={pending}
      >
        {pending ? 'Joining…' : 'Accept invitation'}
      </button>
    </div>
  );
}
