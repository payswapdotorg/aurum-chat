'use client';

// Capability, workforce & agent interventions (W063) — the team
// lifecycle form (the gated activation / dissolution).
//
// THE ACCEPTANCE CORE: "proposal → approval → activation" for the team
// dimension, and the retain/modify/terminate vocabulary mirrored for
// teams (a team is activated — recruited as a unit — and dissolved
// terminally). The transition routes through the W009 authority matrix
// (activation: 'agent-recruitment' EXECUTE; dissolution:
// 'agent-termination' EXECUTE), so the requester can never be the
// decider — a DIFFERENT authorized approver decides the pending request
// in Approvals, and re-invoking THIS form applies the decided
// transition (the idempotency key is derived from the team id, so the
// same call requests and applies).
//
// The honest outcomes this form renders: applied (the transition
// landed), or waiting at the gate (the request id, linked to Approvals,
// with the separation-of-duties explanation).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

interface LifecycleBody {
  applied?: boolean;
  gate?: { actionRequestId?: string; status?: string };
  team?: { status?: string };
  error?: string;
  message?: string;
}

export function TeamLifecycleForm({
  teamId,
  status,
}: {
  teamId: string;
  status: 'draft' | 'active' | 'dissolved';
}): ReactNode {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LifecycleBody | null>(null);

  const action: 'activate' | 'dissolve' | null =
    status === 'draft' ? 'activate' : status === 'active' ? 'dissolve' : null;

  async function drive(kind: 'activate' | 'dissolve'): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(
        `/api/product/interventions/teams/${teamId}/lifecycle`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: kind, reason: kind === 'dissolve' ? reason : null }),
        },
      );
      const body = (await response.json().catch(() => null)) as LifecycleBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the transition failed (HTTP ${response.status})`);
      }
      setDone(body);
      setReason('');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the transition failed');
    } finally {
      setPending(false);
    }
  }

  if (action === null) {
    return (
      <p className="aurum-learn-hint" role="note">
        This team is dissolved — dissolution is terminal. A returning need is a NEW team (the
        versioned contract’s own discipline).
      </p>
    );
  }

  return (
    <form
      className="aurum-learn-form"
      onSubmit={(event) => {
        event.preventDefault();
        void drive(action);
      }}
    >
      {action === 'dissolve' ? (
        <label className="aurum-learn-field">
          <span className="aurum-learn-field-label">Why this team is dissolved</span>
          <textarea
            className="aurum-learn-input"
            name="reason"
            required
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="The reason is recorded on the terminal version — dissolutions record their why."
          />
        </label>
      ) : (
        <p className="aurum-learn-hint">
          Activation enforces the roster’s liveness — every member agent must currently be active —
          and routes through the authority gate as a recruitment executed by this team as a unit.
        </p>
      )}
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending}>
          {pending
            ? 'Driving the transition…'
            : action === 'activate'
              ? 'Request activation — or apply the decided one'
              : 'Request dissolution — or apply the decided one'}
        </button>
        <span className="aurum-learn-hint">
          {action === 'activate'
            ? 'The first request waits at the gate; a different authorized approver decides it in Approvals, and this same button then applies it.'
            : 'Dissolution is terminal and gated; the same button requests it and later applies the decided one.'}
        </span>
      </div>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The transition did not land</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            {done.applied === true ? (
              <>
                <strong>The transition applied — the team is {done.team?.status}.</strong> The
                version chain records the gate request that authorized it.
              </>
            ) : (
              <>
                <strong>The transition waits at the authority gate.</strong> Request{' '}
                <Link className="aurum-learn-link" href="/approvals">
                  {(done.gate?.actionRequestId ?? '').slice(0, 8)} in Approvals
                </Link>{' '}
                holds it — a different authorized approver decides it (the requester never decides
                their own request). Once decided, this same button applies it.
              </>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
