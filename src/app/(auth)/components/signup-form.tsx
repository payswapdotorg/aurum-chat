'use client';

// Auth surfaces (W058) — the sign-up (registration) form.
//
// POST /api/auth/sign-up: register + sign in one operation (the password
// is transmitted once). The route sets the httpOnly session cookie; the
// fresh principal has no company yet, so the form routes to onboarding
// (an invitation code, when present, is redeemed server-side first).

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { afterAuthTarget, postAuthJson } from './auth-fetch';

export interface SignUpFormProps {
  inviteCode: string | null;
  inviteCompanyName: string | null;
  inviteEmail: string | null;
}

export function SignUpForm({
  inviteCode,
  inviteCompanyName,
  inviteEmail,
}: SignUpFormProps): ReactNode {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState(inviteEmail ?? '');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    const outcome = await postAuthJson('/api/auth/sign-up', {
      displayName,
      email,
      password,
      ...(inviteCode === null ? {} : { inviteCode }),
    });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string'
          ? outcome.body['message']
          : 'registration failed';
      setError(message);
      setPending(false);
      return;
    }
    if (typeof outcome.body['notice'] === 'string') {
      setNotice(outcome.body['notice']);
      setPending(false);
      router.replace('/onboarding');
      return;
    }
    router.replace(afterAuthTarget(outcome.body, null));
  };

  return (
    <form className="aurum-auth-form" onSubmit={onSubmit} noValidate>
      {inviteCode !== null ? (
        <p className="aurum-auth-notice" role="status">
          {inviteCompanyName === null
            ? 'You are creating an account to accept an invitation.'
            : `${inviteCompanyName} invited you — create your account to accept.`}
        </p>
      ) : null}
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="signup-name">
          Your name
        </label>
        <input
          id="signup-name"
          className="aurum-auth-input"
          type="text"
          name="displayName"
          autoComplete="name"
          required
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />
      </div>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="signup-email">
          Email
        </label>
        <input
          id="signup-email"
          className="aurum-auth-input"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <p className="aurum-auth-hint">
          {inviteEmail === null
            ? 'Work email — invitations and briefings use it.'
            : 'Pre-filled from the invitation (the invite is bound to this address).'}
        </p>
      </div>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="signup-password">
          Password
        </label>
        <input
          id="signup-password"
          className="aurum-auth-input"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <p className="aurum-auth-hint">At least 8 characters.</p>
      </div>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p className="aurum-auth-notice" role="status">
          {notice}
        </p>
      )}
      <button className="aurum-auth-btn" type="submit" disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
