'use client';

// Auth surfaces (W058) — the sign-in / create-account form.
//
// One card, two tabs (ShareNet's progressive disclosure: the sign-up
// fields appear only in the create tab). Both modes POST to /api/auth/*
// and on success navigate FULLY to `next` so the fresh session cookie
// reaches the destination's server render. Errors are the quiet inline
// state (role=alert), never a toast over a dead form.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { navigateTo, postJson } from './auth-fetch';

type Mode = 'signin' | 'signup';

export function SignInForm({ next }: { next: string }): ReactNode {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (target: Mode) => {
    if (busy) return;
    setMode(target);
    setError(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (mode === 'signup' && displayName.trim() === '') {
      setError('Tell us your name — colleagues will see it in Aurum.');
      return;
    }
    setBusy(true);
    const outcome =
      mode === 'signin'
        ? await postJson('/api/auth/sign-in', { email, password })
        : await postJson('/api/auth/sign-up', { email, password, displayName });
    if (!outcome.ok) {
      setError(outcome.message ?? 'Sign-in failed. Try again.');
      setBusy(false);
      return;
    }
    navigateTo(next);
  };

  return (
    <section className="aurum-auth-card" aria-labelledby="aurum-signin-title">
      <h2 id="aurum-signin-title">
        {mode === 'signin' ? 'Sign in to Aurum' : 'Create your Aurum account'}
      </h2>
      <p className="aurum-auth-sub">
        {mode === 'signin'
          ? 'Your session carries your company scope — no tenant ids, no headers, just your membership.'
          : 'One account, then create or join your company workspace.'}
      </p>

      <div className="aurum-auth-tabs" role="tablist" aria-label="Sign in or create an account">
        <button
          type="button"
          role="tab"
          id="aurum-tab-signin"
          aria-selected={mode === 'signin'}
          aria-controls="aurum-signin-panel"
          className="aurum-auth-tab"
          onClick={() => switchMode('signin')}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          id="aurum-tab-signup"
          aria-selected={mode === 'signup'}
          aria-controls="aurum-signin-panel"
          className="aurum-auth-tab"
          onClick={() => switchMode('signup')}
        >
          Create account
        </button>
      </div>

      <form onSubmit={submit} noValidate>
        <div
          id="aurum-signin-panel"
          role="tabpanel"
          aria-labelledby={mode === 'signin' ? 'aurum-tab-signin' : 'aurum-tab-signup'}
        >
          {error === null ? null : (
            <p className="aurum-auth-error" role="alert">
              {error}
            </p>
          )}

          {mode === 'signup' ? (
            <div className="aurum-auth-field">
              <label htmlFor="aurum-signin-name">Your name</label>
              <input
                id="aurum-signin-name"
                name="displayName"
                type="text"
                autoComplete="name"
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
          ) : null}

          <div className="aurum-auth-field">
            <label htmlFor="aurum-signin-email">Work email</label>
            <input
              id="aurum-signin-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="aurum-auth-field">
            <label htmlFor="aurum-signin-password">
              {mode === 'signin' ? 'Password' : 'Choose a password (8+ characters)'}
            </label>
            <input
              id="aurum-signin-password"
              name="password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={mode === 'signup' ? 8 : undefined}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="aurum-auth-hint">
              {mode === 'signin'
                ? 'Invited by a colleague? Sign in with the invited email, then open the invite link.'
                : 'Passwords are stored as salted scrypt hashes; sessions are HttpOnly cookies.'}
            </p>
          </div>

          <div className="aurum-auth-actions">
            <button type="submit" className="aurum-auth-btn" disabled={busy}>
              {busy
                ? mode === 'signin'
                  ? 'Signing in…'
                  : 'Creating account…'
                : mode === 'signin'
                  ? 'Sign in'
                  : 'Create account'}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
