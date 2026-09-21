'use client';

// Capability, workforce & agent interventions (W063) — the agent
// lifecycle decision form (retain / modify / terminate).
//
// THE ACCEPTANCE CORE: "retain/modify/terminate agent lifecycle". The
// decision always follows from a measured evaluation (the
// agent-evaluation contract enforces the link — no decision without
// evidence) and requires the agents module's 'agents:administer' claim.
// Retain/modify are recorded management evidence (the modify mutation
// itself flows through the agents module's own claim-gated controls);
// TERMINATE routes through the W009 authority matrix — kind
// 'agent-termination' at EXECUTE — so out of the box no agent is
// terminated without an explicit human decision by a DIFFERENT
// authorized approver (lock 23), applied afterwards through the settle
// pump (settle-button.tsx).
//
// The replacement options the evaluation compared (retain/modify/train/
// reassign/hire/automate/recruit/install/eliminate) are selectable on a
// terminate decision — the §13 vocabulary mirrored on the termination
// side.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
// CLIENT-SAFE imports only: lib/form.ts imports NOTHING.
import {
  AGENT_LIFECYCLE_CHANGES,
  MAX_DECISION_RATIONALE_CHARS,
} from '../lib/form';

interface DecisionBody {
  decision?: { id?: string; change?: string; status?: string; appliedAt?: string | null };
  applied?: boolean | null;
  gateRequestId?: string | null;
  error?: string;
  message?: string;
}

const CHANGE_COPY: Record<(typeof AGENT_LIFECYCLE_CHANGES)[number], string> = {
  retain: 'Retain — keep the agent as it is',
  modify: 'Modify — change the agent’s contract',
  terminate: 'Terminate — retire the agent (human-approved)',
};

export function AgentLifecycleForm({
  agentId,
  evaluationId,
  replacementOptions,
}: {
  agentId: string;
  evaluationId: string;
  replacementOptions: readonly { id: string; kind: string; summary: string; recommended: boolean }[];
}): ReactNode {
  const router = useRouter();
  const [change, setChange] = useState<(typeof AGENT_LIFECYCLE_CHANGES)[number]>('retain');
  const [rationale, setRationale] = useState('');
  const [modificationSummary, setModificationSummary] = useState('');
  const [note, setNote] = useState('');
  const [replacementOptionId, setReplacementOptionId] = useState('');
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
        `/api/product/interventions/agents/${agentId}/lifecycle`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            evaluationId,
            change,
            rationale,
            note,
            modificationSummary: change === 'modify' ? modificationSummary : null,
            replacementOptionId:
              change === 'terminate' && replacementOptionId !== '' ? replacementOptionId : null,
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as DecisionBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the decision failed (HTTP ${response.status})`);
      }
      setDone(body);
      setRationale('');
      setModificationSummary('');
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
        <legend className="aurum-learn-field-label">The lifecycle decision</legend>
        {AGENT_LIFECYCLE_CHANGES.map((option) => (
          <label key={option} className="aurum-int-form-choice">
            <input
              type="radio"
              name="change"
              value={option}
              checked={change === option}
              onChange={() => setChange(option)}
            />
            <span>{CHANGE_COPY[option]}</span>
          </label>
        ))}
      </fieldset>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Why</span>
        <textarea
          className="aurum-learn-input"
          name="rationale"
          required
          rows={3}
          maxLength={MAX_DECISION_RATIONALE_CHARS}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="The decision records its why — what in the measured evaluation justifies it."
        />
      </label>
      {change === 'modify' ? (
        <label className="aurum-learn-field">
          <span className="aurum-learn-field-label">What will be changed</span>
          <textarea
            className="aurum-learn-input"
            name="modificationSummary"
            required
            rows={2}
            value={modificationSummary}
            onChange={(event) => setModificationSummary(event.target.value)}
            placeholder="The modification is applied afterwards through the agents module’s own controls."
          />
        </label>
      ) : null}
      {change === 'terminate' && replacementOptions.length > 0 ? (
        <label className="aurum-learn-field">
          <span className="aurum-learn-field-label">Chosen replacement (optional)</span>
          <select
            className="aurum-learn-input"
            name="replacementOptionId"
            value={replacementOptionId}
            onChange={(event) => setReplacementOptionId(event.target.value)}
          >
            <option value="">— none cited —</option>
            {replacementOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.kind}
                {option.recommended ? ' (recommended)' : ''} — {option.summary}
              </option>
            ))}
          </select>
          <span className="aurum-learn-hint">
            A termination may cite exactly one of THIS evaluation’s replacement options — never a
            foreign one.
          </span>
        </label>
      ) : null}
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Note (optional)</span>
        <input
          className="aurum-learn-input"
          name="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending}>
          {pending ? 'Recording the decision…' : 'Record the lifecycle decision'}
        </button>
        <span className="aurum-learn-hint">
          A terminate decision routes through the authority gate — a different authorized approver
          decides it, and the settle step applies it afterwards.
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
            {done.applied === true ? (
              <>
                <strong>The termination was applied.</strong> The agent definition is disabled
                through the agents contract — the decision is terminal evidence.
              </>
            ) : done.applied === false ? (
              <>
                <strong>The termination waits at the authority gate.</strong> Request{' '}
                <Link className="aurum-learn-link" href="/approvals">
                  {(done.gateRequestId ?? '').slice(0, 8)} in Approvals
                </Link>{' '}
                holds it — a different authorized approver decides it. Once approved, the settle
                step below applies it.
              </>
            ) : (
              <>
                <strong>The {done.decision?.change} decision is recorded.</strong> It is management
                evidence linked to the measured evaluation it follows from.
              </>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
