'use client';

// Product shell (W116) — the change-password form of the More area.
//
// POST /api/auth/password: current + new + confirm, client-checked then
// server-enforced (the same 8–200 policy as registration; scrypt
// re-hash). The documented session policy: every OTHER browser's session
// is revoked — this one stays signed in. The confirm field is a plain
// client-side guard; the server never sees it.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { postAuthJson } from '@/app/(auth)/components/auth-fetch';

export function PasswordChangeForm(): ReactNode {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setDone(null);
    if (newPassword !== confirmPassword) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    setPending(true);
    const outcome = await postAuthJson('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    setPending(false);
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string' ? outcome.body['message'] : 'the password could not be changed';
      setError(message);
      return;
    }
    setDone('Password changed. Every other browser has been signed out — this one stays signed in.');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <form className="aurum-auth-form" onSubmit={onSubmit} noValidate>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          className="aurum-auth-input"
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value);
          }}
        />
      </div>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          className="aurum-auth-input"
          type="password"
          name="newPassword"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value);
          }}
        />
        <p className="aurum-auth-hint">At least 8 characters.</p>
      </div>
      <div className="aurum-auth-field">
        <label className="aurum-auth-label" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          className="aurum-auth-input"
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(event) => {
            setConfirmPassword(event.target.value);
          }}
        />
      </div>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      {done === null ? null : (
        <p className="aurum-auth-notice" role="status">
          {done}
        </p>
      )}
      <button className="aurum-auth-btn" type="submit" disabled={pending}>
        {pending ? 'Changing password…' : 'Change password'}
      </button>
    </form>
  );
}
