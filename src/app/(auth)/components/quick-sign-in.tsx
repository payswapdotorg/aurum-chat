'use client';

// Auth surfaces (post-W070 UX hardening) — the quick-access panel of the
// sign-in page.
//
// One-tap sign-in as a seeded demo persona (W068 harness). The panel
// receives the persona DIRECTORY from the server (names, titles, role
// labels — never credentials); each action POSTs only the persona id to
// /api/auth/quick-sign-in, where the server resolves the seeded demo
// credentials and drives the real auth contract. Routing afterwards is
// exactly the password form's: an active company → chat, and the `next`
// parameter is honored. The panel renders only when the server judged the
// runtime demo-legal (never in production, never on a production-like
// backend).

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { afterAuthTarget, postAuthJson } from './auth-fetch';

/** One persona row of the quick-access directory (no credentials). */
export interface QuickSignInPersona {
  id: string;
  name: string;
  title: string;
  roleLabel: string;
  email: string;
}

export interface QuickSignInProps {
  personas: readonly QuickSignInPersona[];
  next: string | null;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function QuickSignIn({ personas, next }: QuickSignInProps): ReactNode {
  const router = useRouter();
  const [pendingPersona, setPendingPersona] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onQuickSignIn = async (persona: QuickSignInPersona) => {
    if (pendingPersona !== null) return;
    setPendingPersona(persona.id);
    setError(null);
    const outcome = await postAuthJson('/api/auth/quick-sign-in', {
      persona: persona.id,
    });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string'
          ? outcome.body['message']
          : 'quick sign-in failed';
      setError(message);
      setPendingPersona(null);
      return;
    }
    router.replace(afterAuthTarget(outcome.body, next));
  };

  return (
    <section className="aurum-auth-quick" aria-labelledby="aurum-quick-title">
      <h2 className="aurum-auth-quick-title" id="aurum-quick-title">
        Quick access
      </h2>
      <p className="aurum-auth-quick-blurb">
        One tap signs you in as a seeded demo persona — each enters through
        the real auth flow with the permissions of their role.
      </p>
      <ul className="aurum-auth-quick-list">
        {personas.map((persona) => {
          const pending = pendingPersona !== null;
          const isThis = pendingPersona === persona.id;
          return (
            <li key={persona.id}>
              <button
                type="button"
                className="aurum-auth-quick-persona"
                data-pending={isThis ? 'true' : undefined}
                aria-busy={isThis}
                disabled={pending}
                onClick={() => {
                  void onQuickSignIn(persona);
                }}
              >
                <span className="aurum-auth-quick-avatar" aria-hidden="true">
                  {initialsOf(persona.name)}
                </span>
                <span className="aurum-auth-quick-main">
                  <span className="aurum-auth-quick-name">{persona.name}</span>
                  <span className="aurum-auth-quick-meta">
                    {persona.title} · {persona.email}
                  </span>
                </span>
                <span className="aurum-auth-quick-tag">
                  {isThis ? 'Signing in…' : persona.roleLabel}
                </span>
                <span className="aurum-sr-only">
                  {' '}
                  — continue as {persona.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
