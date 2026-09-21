'use client';

// Capability, workforce & agent interventions (W063) — the proposal
// decision form (the human authority gate).
//
// THE ACCEPTANCE CORE: "proposal → approval → activation" — this form
// IS the approval step. An awaiting recruitment proposal renders it;
// the authorized human approves or rejects the linked action request
// (the actions module enforces the approve claim and the separation of
// duties — the requester can never decide their own proposal), and the
// settle lands the decision on the proposal. A re-click after another
// approver decided is not an error (first-write-wins).
//
// Real <form> semantics, labeled inputs, focus-visible treatment from
// the shell, pending state announced via aria-live, 44px+ touch
// targets. On success the honest outcome: what was decided, by whom,
// and what may follow (activation).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
// CLIENT-SAFE imports only (the shell's rule): the form constants and
// validation live in lib/form.ts, which imports NOTHING.
import { PROPOSAL_DECISIONS } from '../lib/form';

interface DecisionBody {
  status?: string;
  decidedHere?: boolean;
  decidedBy?: string | null;
  decidedAt?: string | null;
  error?: string;
  message?: string;
}

export function ProposalDecisionForm({
  proposalId,
  requestId,
}: {
  proposalId: string;
  requestId: string;
}): ReactNode {
  const router = useRouter();
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DecisionBody | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(
        `/api/product/interventions/proposals/${proposalId}/decide`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, note }),
        },
      );
      const body = (await response.json().catch(() => null)) as DecisionBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the decision failed (HTTP ${response.status})`);
      }
      setDone(body);
      setNote('');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the decision failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="aurum-learn-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="aurum-int-form-choices">
        <legend className="aurum-learn-field-label">The human decision</legend>
        {PROPOSAL_DECISIONS.map((option) => (
          <label key={option} className="aurum-int-form-choice">
            <input
              type="radio"
              name="decision"
              value={option}
              checked={decision === option}
              onChange={() => setDecision(option)}
            />
            <span>{option === 'approve' ? 'Approve the acquisition' : 'Reject the acquisition'}</span>
          </label>
        ))}
      </fieldset>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Note (optional)</span>
        <textarea
          className="aurum-learn-input"
          name="note"
          rows={2}
          placeholder="Why you decided this — recorded with the decision trail."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <span className="aurum-learn-hint">
          The note travels with the approval record. The authority gate separates duties —
          whoever requested this proposal cannot decide it.
        </span>
      </label>
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending}>
          {pending ? 'Recording the decision…' : 'Decide the proposal'}
        </button>
        <span className="aurum-learn-hint">
          Approving authorizes the acquisition — the recruit alternative can then be activated.
          Rejecting retains the comparison as evidence.
        </span>
      </div>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The decision was not recorded</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            <strong>Decision recorded — the proposal is now {done.status}.</strong>{' '}
            {done.decidedHere === false
              ? 'Another authorized approver had already decided this request; your view now shows their recorded decision. '
              : ''}
            The gate request{' '}
            <Link className="aurum-learn-link" href="/approvals">
              {requestId.slice(0, 8)} in Approvals
            </Link>{' '}
            carries the full decision trail.
            {done.status === 'approved' ? ' Activation may follow below.' : ''}
          </div>
        )}
      </div>
    </form>
  );
}
