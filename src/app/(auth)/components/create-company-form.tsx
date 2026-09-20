'use client';

// Auth surfaces (W058) — the onboarding create-company form (first-manager
// journey step 3). POST /api/auth/onboarding/company: the auth module
// provisions the company + default workspace + owner membership through
// the organizations contract and selects it; onboarding then lands in
// Aurum chat.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { dispatchShellRefresh } from '@/app/(product)/lib/shell-events';
import { postAuthJson } from './auth-fetch';

export function CreateCompanyForm(): ReactNode {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await postAuthJson('/api/auth/onboarding/company', { name });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string' ? outcome.body['message'] : 'the company could not be created';
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
        <label className="aurum-auth-label" htmlFor="company-name">
          Company name
        </label>
        <input
          id="company-name"
          className="aurum-auth-input"
          type="text"
          name="name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <p className="aurum-auth-hint">
          You become the owner; a default workspace is created with it. The
          slug is derived from the name.
        </p>
      </div>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      <button className="aurum-auth-btn" type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create company'}
      </button>
    </form>
  );
}
