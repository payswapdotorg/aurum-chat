'use client';

// Product shell (W116) — the change-password form of the More area.
//
// POST /api/auth/password/change (the (auth) group's own API): current
// password + new password + confirm. The server re-verifies the current
// password (a wrong one is the uniform invalid_credentials) and re-hashes
// with scrypt; every OTHER session of the principal is revoked — this
// form's session stays signed in (the documented doctrine). On success
// the form settles into a quiet confirmation, messenger tone.

import { useState } from 'react';
import type { ReactNode } from 'react';

export function ChangePasswordForm(): ReactNode {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || done) return;
    if (newPassword !== confirmPassword) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/password/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.error ?? `the change failed (HTTP ${response.status})`);
      }
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the change failed');
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <div className="aurum-mkt-form" role="status">
        <p className="aurum-item-text">
          <strong>Password updated.</strong> Every other session of yours
          has been signed out — this one stays signed in.
        </p>
      </div>
    );
  }

  return (
    <form className="aurum-mkt-form" onSubmit={onSubmit} noValidate>
      <div className="aurum-mkt-field">
        <label className="aurum-mkt-field-label" htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          className="aurum-mkt-input"
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
      <div className="aurum-mkt-field">
        <label className="aurum-mkt-field-label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          className="aurum-mkt-input"
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
        <p className="aurum-mkt-hint">At least 8 characters.</p>
      </div>
      <div className="aurum-mkt-field">
        <label className="aurum-mkt-field-label" htmlFor="confirm-password">
          Confirm the new password
        </label>
        <input
          id="confirm-password"
          className="aurum-mkt-input"
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
        <div className="aurum-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="aurum-mkt-form-actions">
        <button className="aurum-btn" type="submit" disabled={pending}>
          {pending ? 'Updating…' : 'Update password'}
        </button>
      </div>
    </form>
  );
}
