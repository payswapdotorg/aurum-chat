'use client';

// Auth surfaces (W058) — the invitation acceptance control.
//
// One button, one honest outcome. The acceptance runs with the signed-in
// session; on success the session switches to the joined company and the
// user lands in Aurum chat (the onboarding acceptance).

import { useState } from 'react';
import type { ReactNode } from 'react';
import { navigateTo, postJson } from './auth-fetch';

export function AcceptInviteForm({ token }: { token: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    const outcome = await postJson('/api/auth/invitations/accept', {
      invitationToken: token,
    });
    if (!outcome.ok) {
      setError(outcome.message ?? 'Accepting the invitation failed. Try again.');
      setBusy(false);
      return;
    }
    navigateTo('/chat');
  };

  return (
    <>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      <div className="aurum-auth-actions">
        <button type="button" className="aurum-auth-btn" onClick={() => void accept()} disabled={busy}>
          {busy ? 'Joining…' : 'Accept and open Aurum chat'}
        </button>
      </div>
    </>
  );
}
