'use client';

// Capability, workforce & agent interventions (W063) — the termination
// settle button (the idempotent pump).
//
// A terminate decision that sits at the authority gate becomes
// applicable once a human decides its request: this button drives the
// settle workflow, which reads the linked action request, applies an
// approved termination through the agents contract (the definition is
// disabled) and moves the decision to its terminal 'applied' state.
// Settling a still-pending or already-terminal decision is a read — the
// pump is idempotent and retryable (lock 36), and the honest notice
// says which state the decision is in now.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

interface SettleBody {
  decision?: { status?: string; appliedAt?: string | null };
  error?: string;
  message?: string;
}

export function SettleButton({ decisionId }: { decisionId: string }): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SettleBody | null>(null);

  async function settle(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(
        `/api/product/interventions/decisions/${decisionId}/settle`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const body = (await response.json().catch(() => null)) as SettleBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the settle failed (HTTP ${response.status})`);
      }
      setDone(body);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the settle failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="aurum-int-settle">
      <button
        type="button"
        className="aurum-btn"
        data-variant="quiet"
        disabled={pending}
        onClick={() => void settle()}
      >
        {pending ? 'Settling…' : 'Apply the decided termination'}
      </button>
      <span className="aurum-learn-hint">
        Reads the gate request and applies an approved termination; a still-pending request stays
        waiting (decide it in Approvals first).
      </span>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 8 }}>
            <strong>The settle did not land</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 8 }} role="status">
            {done.decision?.status === 'applied' ? (
              <strong>The termination is applied — the agent is disabled.</strong>
            ) : done.decision?.status === 'awaiting_approval' ? (
              <strong>The request is still waiting for its human decision.</strong>
            ) : (
              <strong>The decision is {done.decision?.status} — nothing to apply.</strong>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
