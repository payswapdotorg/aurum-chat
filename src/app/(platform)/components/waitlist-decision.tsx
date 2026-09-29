'use client';

// Platform admin surface (W116) — the per-row accept/decline actions.
//
// Accept creates the account immediately (compact gold button). Decline
// first opens the optional one-line note disclosure (compact ink button)
// — sending is a second explicit step. Both POST JSON with the session
// cookie (the CSRF-resistant shape every auth write uses — a cross-site
// form cannot post application/json); the page refreshes after every
// mutation so the queue re-renders from server truth.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { postAuthJson } from '@/app/(auth)/components/auth-fetch';

export function WaitlistDecision({ requestId }: { requestId: string }): ReactNode {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<'accept' | 'decline' | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = async (path: string, body: Record<string, unknown>, action: 'accept' | 'decline') => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    setError(null);
    const outcome = await postAuthJson(path, body);
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string'
          ? outcome.body['message']
          : 'the request could not be decided';
      setError(message);
      setPendingAction(null);
      return;
    }
    router.refresh();
  };

  const accept = () => {
    void send('/api/platform/waitlist/accept', { requestId }, 'accept');
  };

  const decline = () => {
    void send('/api/platform/waitlist/decline', { requestId, note: note.trim() === '' ? null : note.trim() }, 'decline');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <div className="aurum-waitlist-actions">
        <button
          className="aurum-waitlist-accept"
          type="button"
          onClick={accept}
          disabled={pendingAction !== null}
        >
          {pendingAction === 'accept' ? 'Accepting…' : 'Accept'}
        </button>
        <button
          className="aurum-waitlist-decline"
          type="button"
          onClick={() => {
            setNoteOpen((open) => !open);
          }}
          disabled={pendingAction !== null}
          aria-expanded={noteOpen}
        >
          Decline
        </button>
        {noteOpen ? (
          <button
            className="aurum-waitlist-decline"
            type="button"
            onClick={decline}
            disabled={pendingAction !== null}
          >
            {pendingAction === 'decline' ? 'Declining…' : 'Send decline'}
          </button>
        ) : null}
      </div>
      {noteOpen ? (
        <label className="aurum-waitlist-note-form">
          <span className="aurum-waitlist-meta" style={{ fontSize: 11.5 }}>
            Optional note — the requester sees it on their next sign-in attempt.
          </span>
          <input
            className="aurum-waitlist-note-input"
            type="text"
            value={note}
            maxLength={280}
            placeholder="One line, 280 characters at most"
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </label>
      ) : null}
      {error === null ? null : (
        <p className="aurum-waitlist-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
