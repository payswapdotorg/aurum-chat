'use client';

// Learning missions, contributions & rewards (W062) — the answer form.
//
// THE ACCEPTANCE CORE: "ask/answer knowledge requests" + "evidence
// capture" + "contribution acknowledgement". One open knowledge request
// (an ask-person acquisition plan the planner recorded and policy
// permitted) renders this form: the employee writes what they know,
// states their own certainty honestly, and the submit drives the
// surface's API write — the answer becomes acquisition evidence (an
// immutable observation) and the contribution is recorded with status
// 'pending' (the acknowledgement the form renders on success).
//
// Real <form> semantics, labeled inputs, focus-visible treatment from
// the shell, pending state announced via aria-live, and a 44px+ touch
// target (the marketplace action-form discipline). On success the
// outcome is the HONEST acknowledgement — what was recorded, where the
// evidence lives, and what happens next (assessment, then possible
// reward under the tenant's explicit policy). A 409 renders the
// first-write-wins truth: the request was already answered.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
// CLIENT-SAFE imports only (the shell's rule — navigation.ts): the form
// constants and validation live in lib/form.ts, which imports NOTHING
// (the server workflow module pulls the db layer — never into the
// browser bundle).
import {
  ANSWER_CONFIDENCE_OPTIONS,
  MAX_ANSWER_NOTE_LENGTH,
  MAX_ANSWER_SUMMARY_LENGTH,
} from '../lib/form';

interface AcknowledgementBody {
  missionId?: string;
  missionTitle?: string;
  evidenceObservationId?: string;
  contribution?: { id?: string; status?: string };
  error?: string;
  message?: string;
}

export function AnswerForm({ planId }: { planId: string }): ReactNode {
  const router = useRouter();
  const [summary, setSummary] = useState('');
  const [confidence, setConfidence] = useState('medium');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AcknowledgementBody | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(
        `/api/product/learning/requests/${planId}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summary, confidence, note }),
        },
      );
      const body = (await response.json().catch(() => null)) as AcknowledgementBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the answer failed (HTTP ${response.status})`);
      }
      setDone(body);
      setSummary('');
      setNote('');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the answer failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="aurum-learn-form" onSubmit={(event) => void submit(event)}>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">What you know</span>
        <textarea
          className="aurum-learn-input"
          name="summary"
          required
          maxLength={MAX_ANSWER_SUMMARY_LENGTH}
          rows={4}
          placeholder="Answer in your own words — specifics help Aurum weigh the evidence."
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
        <span className="aurum-learn-hint">
          Recorded as evidence exactly as you state it. At most{' '}
          {MAX_ANSWER_SUMMARY_LENGTH} characters.
        </span>
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">How certain you are</span>
        <select
          className="aurum-learn-input"
          name="confidence"
          value={confidence}
          onChange={(event) => setConfidence(event.target.value)}
        >
          {ANSWER_CONFIDENCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="aurum-learn-hint">
          Your stated certainty is recorded with the evidence — an honest
          partial answer is more useful than a confident guess.
        </span>
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Context (optional)</span>
        <textarea
          className="aurum-learn-input"
          name="note"
          maxLength={MAX_ANSWER_NOTE_LENGTH}
          rows={2}
          placeholder="Where the knowledge comes from — a document, a conversation, direct experience."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending}>
          {pending ? 'Recording…' : 'Submit the answer'}
        </button>
        <span className="aurum-learn-hint">
          The answer is recorded as evidence; Aurum assesses its quality against
          the mission’s other sources before any reward.
        </span>
      </div>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The answer was not recorded</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            <strong>Thank you — your contribution is recorded.</strong> Aurum
            anchored it to the mission{' '}
            {done.missionTitle === undefined ? '' : (
              <>
                “{done.missionTitle}” (
                <Link
                  className="aurum-learn-link"
                  href={`/intelligence/missions/${done.missionId ?? ''}`}
                >
                  open it
                </Link>
                )
              </>
            )}{' '}
            and stored the answer as immutable evidence
            {done.evidenceObservationId === undefined ? '' : ' in the Evidence surface'}.
            It now awaits Aurum’s evidence-quality assessment — any reward
            follows the company’s explicit reward policy, never this form.
          </div>
        )}
      </div>
    </form>
  );
}
