'use client';

// Auth surfaces (W058) — the onboarding join-by-invitation form (the
// invited-employee entry). POST /api/auth/invite/redeem: membership grant
// through the organizations contract, then the company becomes the active
// selection and onboarding lands in Aurum chat.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { dispatchShellRefresh } from '@/app/(product)/lib/shell-events';
import { postAuthJson } from './auth-fetch';

export function RedeemInviteForm(): ReactNode {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await postAuthJson('/api/auth/invite/redeem', { code: code.trim() });
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
    <form className="aurum-auth-form" onSubmit={onSubmit} noValidate>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="invite-code">
          Invitation code
        </label>
        <input
          id="invite-code"
          className="aurum-auth-input"
          type="text"
          name="code"
          required
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
        <p className="aurum-auth-hint">
          The code from your invitation link — it is bound to your account&apos;s
          email address.
        </p>
      </div>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      <button className="aurum-auth-btn" type="submit" disabled={pending}>
        {pending ? 'Joining…' : 'Join company'}
      </button>
    </form>
  );
}
