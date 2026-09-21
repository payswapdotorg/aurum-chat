'use client';

// Intelligence discovery (W061) — the "Deliver to chat" affordance.
//
// THE ACCEPTANCE'S CHAT HALF: "proactive findings enter chat and Today".
// Today shows the briefing on this page; this button is the honest,
// user-invoked delivery of the SAME findings state into the persistent
// "Aurum intelligence" conversation — the API write is idempotent per
// findings digest (lib/briefing-chat.ts), so pressing it twice changes
// nothing, and new findings arrive as exactly one new message.
//
// Real <form> semantics, focus-visible treatment from the shell, pending
// state announced via aria-live, and a 44px+ touch target. On success the
// outcome links straight into the chat thread (?c= deep link).

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';

interface DeliveryBody {
  delivered?: boolean;
  deduped?: boolean;
  conversationId?: string;
  findingCount?: number;
  error?: string;
  message?: string;
}

export function DeliverToChatButton(): ReactNode {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DeliveryBody | null>(null);

  async function deliver(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch('/api/product/intelligence/briefing/deliver', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await response.json().catch(() => null)) as DeliveryBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `delivery failed (HTTP ${response.status})`);
      }
      setDone(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'delivery failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="aurum-intel-deliver">
      <button
        type="button"
        className="aurum-btn"
        onClick={() => void deliver()}
        disabled={pending}
        aria-label="Deliver today's findings into the Aurum chat"
      >
        {pending ? 'Delivering…' : 'Deliver to chat'}
      </button>
      <span className="aurum-intel-deliver-hint">
        Aurum messages you first — the findings land in the “Aurum intelligence”
        conversation, idempotent until the findings change.
      </span>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The delivery was refused</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            {done.deduped === true ? (
              <>This briefing is already in the chat — nothing new was recorded.</>
            ) : (
              <>
                Delivered {done.findingCount ?? 0} proactive finding(s) to the chat.
              </>
            )}{' '}
            {done.conversationId === undefined ? null : (
              <Link className="aurum-intel-inline-link" href={`/chat?c=${done.conversationId}`}>
                Open the conversation
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
