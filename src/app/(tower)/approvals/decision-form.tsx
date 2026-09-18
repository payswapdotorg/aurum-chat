'use client';

// Management Control Tower (W033) — the approvals decision form.
//
// The tower's one interactive control: a human APPROVE/REJECT decision
// on a pending action request, POSTed to the tower API route which
// delegates to the actions contract (decideApproval — claim-gated,
// separation of duties, first decision wins). On success the router
// refreshes so the server-rendered surfaces reflect the new state.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

export interface DecisionFormProps {
  requestId: string;
  /** Scoping parameters forwarded from the page's query string. */
  tenant: string | null;
  principal: string | null;
  authority: string | null;
  /** True when the current principal cannot decide (self-requested). */
  disabled?: boolean;
  disabledReason?: string | null;
}

export function DecisionForm({
  requestId,
  tenant,
  principal,
  authority,
  disabled = false,
  disabledReason = null,
}: DecisionFormProps): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject'): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (tenant !== null && tenant !== '') query.set('tenant', tenant);
      if (principal !== null && principal !== '') query.set('principal', principal);
      if (authority !== null && authority !== '') query.set('authority', authority);
      const response = await fetch(
        `/api/tower/approvals/${requestId}/decide${query.size === 0 ? '' : `?${query.toString()}`}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, note: 'Decided in the Management Control Tower' }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          message?: string;
        } | null;
        throw new Error(
          body?.message ?? body?.error ?? `decision failed (HTTP ${response.status})`,
        );
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'decision failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="decide">
      <button
        type="button"
        className="decide-approve"
        disabled={pending || disabled}
        onClick={() => void decide('approve')}
      >
        Approve
      </button>
      <button
        type="button"
        className="decide-reject"
        disabled={pending || disabled}
        onClick={() => void decide('reject')}
      >
        Reject
      </button>
      {disabled && disabledReason !== null ? (
        <span className="decide-note">{disabledReason}</span>
      ) : null}
      {error === null ? null : (
        <span className="decide-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
