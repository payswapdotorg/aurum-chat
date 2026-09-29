'use client';

// Auth surfaces (W058/W116) — the sign-up form.
//
// W116 — the waitlist-gated entry: without a usable invitation code the
// POST /api/auth/sign-up records a WAITLIST REQUEST and issues no
// session cookie; the form renders the signed-out confirmation panel
// ("You're on the waitlist — the Aurum team will review your request").
// A valid invitation code keeps today's immediate-access path: the
// route sets the httpOnly session cookie and the form routes to
// onboarding (the invite is redeemed server-side first).

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { afterAuthTarget, postAuthJson } from './auth-fetch';
import { signUpOutcome } from '../lib/signup-outcome';
import { WAITLIST_CONFIRMATION_COPY } from '../lib/signup-outcome';

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
  const [waitlisted, setWaitlisted] = useState<string | null>(null);

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
    const decision = signUpOutcome(outcome.body);
    if (decision.kind === 'waitlisted') {
      // The signed-out confirmation state: no session cookie was issued,
      // so the form stays on the page and shows the panel.
      setWaitlisted(decision.message);
      setNotice(decision.notice);
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

  if (waitlisted !== null) {
    return (
      <div className="aurum-auth-form" role="status">
        <h2 className="aurum-auth-title" style={{ marginBottom: 6 }}>
          {WAITLIST_CONFIRMATION_COPY.heading}
        </h2>
        <p className="aurum-auth-notice">{waitlisted}</p>
        {notice === null ? null : (
          <p className="aurum-auth-hint" style={{ margin: 0 }}>
            {notice}
          </p>
        )}
        <p className="aurum-auth-blurb" style={{ marginBottom: 0 }}>
          {WAITLIST_CONFIRMATION_COPY.blurb}
        </p>
        <Link
          className="aurum-auth-btn"
          data-variant="quiet"
          href={inviteCode === null ? '/signin' : `/signin?invite=${encodeURIComponent(inviteCode)}`}
        >
          {WAITLIST_CONFIRMATION_COPY.signInLabel}
        </Link>
      </div>
    );
  }

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
            ? 'Work email — the Aurum team reviews requests against it.'
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
        <p className="aurum-auth-hint">
          At least 8 characters. You will sign in with it once your request is accepted.
        </p>
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
        {inviteCode === null
          ? pending
            ? 'Sending request…'
            : 'Join the waitlist'
          : pending
            ? 'Creating account…'
            : 'Create account'}
      </button>
    </form>
  );
}
