'use client';

// Provider choice (W091) — the interactive controls.
//
// The surface's client side is deliberately small and quiet (the ai/
// controls.tsx discipline): real <form> semantics, labeled inputs, a
// 44px+ radio group, progressive disclosure for the technical override,
// and honest pending/error/summary states. Every control calls ONE server
// action and refreshes the server-rendered view on success; nothing here
// holds domain state.
//
// Accessibility: fieldset/legend for the radio group, labels on every
// input, pending state announced via aria-live, errors via role="alert",
// and 44px+ touch targets on every interactive control.

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { TechnicalAccountRow } from '../lib/views';
import {
  applyPreferenceAction,
  savePreferenceAction,
  technicalOverrideAction,
} from '../lib/server-actions';
import {
  MAX_NOTE_LENGTH_COPY,
  accountStatusLabel,
  providerLabel,
} from '../lib/labels';

/** What every server action answers (structural — the wire shape). */
type ActionResult = { ok: true; summary: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// The shared action plumbing
// ---------------------------------------------------------------------------

/** Shared action state: pending flag, error line, success summary, refresh. */
function usePreferenceAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const run = useCallback(
    async (invoke: () => Promise<ActionResult>): Promise<boolean> => {
      setPending(true);
      setError(null);
      setSummary(null);
      try {
        const outcome = await invoke();
        if (outcome.ok) {
          setSummary(outcome.summary);
          router.refresh();
          return true;
        }
        setError(outcome.error);
        return false;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'the request failed — try again');
        return false;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { pending, error, summary, run };
}

/** The honest pending/error/summary line (aria-live pending, alert errors). */
export function StatusLine({
  pending,
  error,
  summary,
  pendingNote = 'Working…',
  errorTitle = 'That did not work',
}: {
  pending: boolean;
  error: string | null;
  summary: string | null;
  pendingNote?: string;
  errorTitle?: string;
}): ReactNode {
  return (
    <div style={{ marginTop: 10 }}>
      {pending ? (
        <span className="aurum-learn-hint" aria-live="polite" role="status">
          {pendingNote}
        </span>
      ) : null}
      {error === null ? null : (
        <div className="aurum-error" role="alert">
          <strong>{errorTitle}</strong>
          <span>{error}</span>
        </div>
      )}
      {!pending && error === null && summary !== null ? (
        <div className="aurum-notice" role="status">
          {summary}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. The choice form (any member — the outcome preference)
// ---------------------------------------------------------------------------

/**
 * The outcome-choice form: one radio group over the five plain-language
 * options (44px+ targets, the current choice checked), an optional reason,
 * and the save button. Members and administrators both save here; whether
 * the choice applies immediately is the module's call (the summary says).
 */
export function PreferenceChoiceForm({
  options,
  current,
  disabled,
}: {
  options: readonly {
    kind: string;
    label: string;
    description: string;
  }[];
  current: string;
  disabled: boolean;
}): ReactNode {
  const [choice, setChoice] = useState(current);
  const [note, setNote] = useState('');
  const { pending, error, summary, run } = usePreferenceAction();

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || disabled) return;
    await run(() =>
      savePreferenceAction({
        preference: choice,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    );
  }

  return (
    <form
      className="aurum-learn-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <fieldset className="aurum-int-form-choices" disabled={disabled || pending}>
        <legend className="aurum-learn-field-label">What should Aurum optimize for?</legend>
        {options.map((option) => (
          <label key={option.kind} className="aurum-int-form-choice">
            <input
              type="radio"
              name="preference"
              value={option.kind}
              checked={choice === option.kind}
              onChange={() => setChoice(option.kind)}
            />
            <span className="aurum-mkt-perm-body">
              <span className="aurum-mkt-perm-label">{option.label}</span>
              <span className="aurum-mkt-perm-desc">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Why (optional)</span>
        <input
          className="aurum-learn-input"
          name="note"
          type="text"
          maxLength={MAX_NOTE_LENGTH_COPY}
          placeholder="Say why in your own words — kept with the change history."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <span className="aurum-learn-hint">
          Your reason is recorded with the change, exactly as you write it.
        </span>
      </label>
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending || disabled}>
          {pending ? 'Saving…' : 'Save your choice'}
        </button>
        <span className="aurum-learn-hint">
          You can change this at any time — every change lands in the history below.
        </span>
      </div>
      <StatusLine
        pending={pending}
        error={error}
        summary={summary}
        pendingNote="Saving your choice…"
        errorTitle="Your choice was not saved"
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// 2. The apply button (administrators — the saved choice, applied now)
// ---------------------------------------------------------------------------

/** Renders nothing unless visible; else the apply-now button + status line. */
export function ApplyPreferenceButton({ visible }: { visible: boolean }): ReactNode {
  const { pending, error, summary, run } = usePreferenceAction();
  if (!visible) return null;
  return (
    <div>
      <button
        type="button"
        className="aurum-btn"
        disabled={pending}
        onClick={() => void run(() => applyPreferenceAction())}
      >
        {pending ? 'Applying…' : 'Apply the saved choice now'}
      </button>
      <span className="aurum-learn-hint" style={{ marginLeft: 10 }}>
        Writes the saved choice into the routing order — it takes effect for the next task.
      </span>
      <StatusLine
        pending={pending}
        error={error}
        summary={summary}
        pendingNote="Applying the saved choice…"
        errorTitle="The choice was not applied"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. The technical override (administrators — per-option disclosure)
// ---------------------------------------------------------------------------

/**
 * Per-option disclosures with a small override form: the routing priority
 * (whole number, lower is tried first) and the status (active / switched
 * off). Reversible at any time — call again with new values.
 */
export function TechnicalOverrideForm({
  accounts,
}: {
  accounts: readonly TechnicalAccountRow[];
}): ReactNode {
  if (accounts.length === 0) return null;
  return (
    <div>
      {accounts.map((account) => (
        <details key={account.accountId} className="aurum-learn-disclose" style={{ marginTop: 8 }}>
          <summary>
            {providerLabel(account.provider)} · {account.label} — adjust
          </summary>
          <TechnicalOverrideRow account={account} />
        </details>
      ))}
    </div>
  );
}

function TechnicalOverrideRow({ account }: { account: TechnicalAccountRow }): ReactNode {
  const [priority, setPriority] = useState(String(account.priority));
  const [status, setStatus] = useState<'active' | 'disabled'>(account.status);
  const { pending, error, summary, run } = usePreferenceAction();

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const trimmed = priority.trim();
    const asNumber = Number(trimmed);
    await run(() =>
      // A non-numeric field goes to the parser raw — it answers with the
      // readable message instead of the client guessing.
      technicalOverrideAction({
        accountId: account.accountId,
        priority: trimmed !== '' && Number.isInteger(asNumber) ? asNumber : trimmed,
        status,
      }),
    );
  }

  return (
    <form
      className="aurum-mkt-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Priority (0–1000, lower is tried first)</span>
        <input
          className="aurum-mkt-input"
          name="priority"
          type="number"
          min={0}
          max={1000}
          step={1}
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        />
      </label>
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Status</span>
        <select
          className="aurum-mkt-input"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value === 'disabled' ? 'disabled' : 'active')}
        >
          <option value="active">{accountStatusLabel('active')}</option>
          <option value="disabled">{accountStatusLabel('disabled')}</option>
        </select>
      </label>
      <div className="aurum-mkt-form-actions">
        <button type="submit" className="aurum-btn" data-variant="quiet" disabled={pending}>
          {pending ? 'Saving…' : `Save the change for “${account.label}”`}
        </button>
      </div>
      <StatusLine
        pending={pending}
        error={error}
        summary={summary}
        pendingNote="Saving the technical change…"
        errorTitle="The technical change was not saved"
      />
    </form>
  );
}
