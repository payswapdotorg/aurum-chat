'use client';

// Auth surfaces (W058) — the sign-in form.
//
// POST /api/auth/sign-in (email + password; the invite code rides along
// when the entry came from an invitation link). On success the route sets
// the httpOnly session cookie and this form routes: an active company →
// chat; no company yet → onboarding. Failures render the module's own
// honest words — invalid credentials are uniformly worded (no account
// existence leak).

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { afterAuthTarget, postAuthJson } from './auth-fetch';

export interface SignInFormProps {
  inviteCode: string | null;
  inviteCompanyName: string | null;
  next: string | null;
}

export function SignInForm({
  inviteCode,
  inviteCompanyName,
  next,
}: SignInFormProps): ReactNode {
  const router = useRouter();
  const [email, setEmail] = useState('');
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
    const outcome = await postAuthJson('/api/auth/sign-in', {
      email,
      password,
      ...(inviteCode === null ? {} : { inviteCode }),
    });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string'
          ? outcome.body['message']
          : 'sign-in failed';
      setError(message);
      setPending(false);
      return;
    }
    if (typeof outcome.body['notice'] === 'string') {
      // The session is live; the invitation could not be redeemed — the
      // onboarding page shows the honest state.
      setNotice(outcome.body['notice']);
      setPending(false);
      router.replace('/onboarding');
      return;
    }
    router.replace(afterAuthTarget(outcome.body, next));
  };

  return (
    <form className="aurum-auth-form" onSubmit={onSubmit} noValidate>
      {inviteCode !== null ? (
        <p className="aurum-auth-notice" role="status">
          {inviteCompanyName === null
            ? 'You are signing in to accept an invitation.'
            : `${inviteCompanyName} invited you — sign in to accept.`}
        </p>
      ) : null}
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="signin-email">
          Email
        </label>
        <input
          id="signin-email"
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
      </div>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="signin-password">
          Password
        </label>
        <input
          id="signin-password"
          className="aurum-auth-input"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
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
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
