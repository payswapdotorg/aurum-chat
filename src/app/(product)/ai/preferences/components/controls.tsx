'use client';

// AI preferences (W091) — the interactive controls.
//
// The surface's client side is deliberately small and quiet (the
// ShareNet visual language the /ai surface follows: compact forms,
// honest pending/error/result states). Every control POSTs one action
// to /api/product/ai/preferences (a thin adapter → the
// provider-preferences module's contract only) and refreshes the
// server-rendered view on success; nothing here holds domain state.
//
// The ORDINARY controls (the priority form, the company form) speak
// outcomes ONLY — no provider names, no technical terms (the
// acceptance's first clause; the unit tests lock the vocabulary). The
// ADVANCED controls (the override form) live in this file too but are
// rendered ONLY by the advanced page, and say so.
//
// Accessibility: real <form> semantics, labeled inputs, focus-visible
// treatment from the shell, pending state announced via aria-live, and
// 44px+ touch targets on every interactive control.

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProviderPreferenceOutcome } from '@/modules/provider-preferences/contract';
import {
  OUTCOME_EXPLANATIONS,
  PREFERENCE_OUTCOMES,
  outcomeLabel,
  priorityPositionLabel,
} from '../lib/labels';

// ---------------------------------------------------------------------------
// The shared action plumbing
// ---------------------------------------------------------------------------

interface ApiEnvelope {
  summary?: string;
  error?: string;
  message?: string;
}

/** POST one action body to the preferences API. */
async function postPreferencesAction(body: Record<string, unknown>): Promise<ApiEnvelope> {
  const response = await fetch('/api/product/ai/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as ApiEnvelope | null;
  if (!response.ok) {
    const failure = parsed as ApiEnvelope | null;
    throw new Error(
      failure?.message ?? failure?.error ?? `request failed (HTTP ${response.status})`,
    );
  }
  return parsed ?? {};
}

/** Shared action state: pending flag, error line, success summary, refresh. */
function usePreferencesAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setPending(true);
      setError(null);
      setSummary(null);
      try {
        const envelope = await postPreferencesAction(body);
        setSummary(envelope.summary ?? 'Saved.');
        router.refresh();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'request failed');
        return false;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { pending, error, summary, run };
}

function StatusLine({
  error,
  summary,
  pending,
}: {
  error: string | null;
  summary: string | null;
  pending: boolean;
}): ReactNode {
  return (
    <p className="aurum-pref-status" aria-live="polite">
      {pending ? <span className="aurum-pref-pending">Saving…</span> : null}
      {error === null ? null : <span className="aurum-pref-error">{error}</span>}
      {summary === null ? null : <span className="aurum-pref-ok">{summary}</span>}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The priority selector (shared by the personal and company forms)
// ---------------------------------------------------------------------------

/**
 * An ordered-outcome picker: one select per position. Deterministic
 * and dependency-free — selecting an outcome that is already placed
 * swaps the two positions (the list stays a strict ordering, so the
 * submitted body is always a valid priority).
 */
function PriorityPicker({
  value,
  onChange,
  disabled,
}: {
  value: ProviderPreferenceOutcome[];
  onChange: (next: ProviderPreferenceOutcome[]) => void;
  disabled: boolean;
}): ReactNode {
  const positions = Array.from(
    { length: PREFERENCE_OUTCOMES.length },
    (_, index) => value[index] ?? null,
  );
  const select = (position: number, outcome: ProviderPreferenceOutcome): void => {
    const next = [...value];
    const existing = next.indexOf(outcome);
    if (existing >= 0) {
      const swap = next[position] ?? null;
      next[existing] = swap === null ? outcome : swap;
    }
    next[position] = outcome;
    onChange(next.filter((entry): entry is ProviderPreferenceOutcome => entry !== null));
  };
  return (
    <div className="aurum-pref-picker">
      {positions.map((outcome, position) => (
        <label key={position} className="aurum-pref-picker-row">
          <span className="aurum-pref-picker-label">{priorityPositionLabel(position + 1)}</span>
          <select
            className="aurum-mkt-input"
            value={outcome ?? ''}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              if (isOutcome(next)) select(position, next);
            }}
          >
            {outcome === null ? <option value="">Not set</option> : null}
            {PREFERENCE_OUTCOMES.map((option) => (
              <option key={option} value={option}>
                {outcomeLabel(option)}
              </option>
            ))}
          </select>
          {position === 0 && outcome !== null ? (
            <span className="aurum-pref-picker-hint">{OUTCOME_EXPLANATIONS[outcome]}</span>
          ) : null}
        </label>
      ))}
    </div>
  );
}

function isOutcome(value: string): value is ProviderPreferenceOutcome {
  return (PREFERENCE_OUTCOMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The personal preference form (any member — the ordinary surface)
// ---------------------------------------------------------------------------

/** The member's own priority: set, change any time, or clear. */
export function PersonalPreferenceForm({
  current,
}: {
  current: ProviderPreferenceOutcome[] | null;
}): ReactNode {
  const { pending, error, summary, run } = usePreferencesAction();
  const [priority, setPriority] = useState<ProviderPreferenceOutcome[]>(
    current ?? ['quality', 'speed', 'cost', 'privacy'],
  );
  return (
    <form
      className="aurum-mkt-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({ action: 'preference.setPersonal', outcomePriority: priority });
      }}
    >
      <PriorityPicker value={priority} onChange={setPriority} disabled={pending} />
      <div className="aurum-mkt-form-actions">
        <button className="aurum-btn" type="submit" disabled={pending}>
          Save my priority
        </button>
        {current === null ? null : (
          <button
            className="aurum-btn"
            type="button"
            data-variant="quiet"
            disabled={pending}
            onClick={() => {
              void run({ action: 'preference.clearPersonal' });
            }}
          >
            Clear my priority
          </button>
        )}
      </div>
      <StatusLine error={error} summary={summary} pending={pending} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// The company preference form (authorized users — the ordinary surface)
// ---------------------------------------------------------------------------

/** The company-wide priority + the policy-first posture (administer claim holders). */
export function TenantPreferenceForm({
  current,
  policyFirst,
}: {
  current: ProviderPreferenceOutcome[];
  policyFirst: boolean;
}): ReactNode {
  const { pending, error, summary, run } = usePreferencesAction();
  const [priority, setPriority] = useState<ProviderPreferenceOutcome[]>(current);
  const [first, setFirst] = useState(policyFirst);
  return (
    <form
      className="aurum-mkt-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({
          action: 'preference.setTenant',
          outcomePriority: priority,
          policyFirst: first,
        });
      }}
    >
      <PriorityPicker value={priority} onChange={setPriority} disabled={pending} />
      <label className="aurum-pref-policy-toggle">
        <input
          type="checkbox"
          checked={first}
          disabled={pending}
          onChange={(event) => {
            setFirst(event.target.checked);
          }}
        />
        <span>
          Let company policy decide how AI options are chosen (everyone’s recorded priorities
          wait until this is turned off)
        </span>
      </label>
      <div className="aurum-mkt-form-actions">
        <button className="aurum-btn" type="submit" disabled={pending}>
          Save the company priority
        </button>
      </div>
      <StatusLine error={error} summary={summary} pending={pending} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// The technical override controls (ADVANCED surface only)
// ---------------------------------------------------------------------------

/** Set a technical override: pin a provider on one AI route, with a reason. */
export function OverrideForm({
  providers,
  capabilities,
}: {
  providers: string[];
  capabilities: readonly { value: string; label: string }[];
}): ReactNode {
  const { pending, error, summary, run } = usePreferencesAction();
  const [capability, setCapability] = useState('');
  const [provider, setProvider] = useState(providers[0] ?? '');
  const [reason, setReason] = useState('');
  return (
    <form
      className="aurum-mkt-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run({
          action: 'override.set',
          capability,
          provider,
          reason,
        });
      }}
    >
      <label className="aurum-pref-picker-row">
        <span className="aurum-pref-picker-label">AI route to pin</span>
        <select
          className="aurum-mkt-input"
          value={capability}
          disabled={pending}
          onChange={(event) => {
            setCapability(event.target.value);
          }}
        >
          {capabilities.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="aurum-pref-picker-row">
        <span className="aurum-pref-picker-label">Provider to pin (technical choice)</span>
        <select
          className="aurum-mkt-input"
          value={provider}
          disabled={pending}
          onChange={(event) => {
            setProvider(event.target.value);
          }}
        >
          {providers.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="aurum-pref-picker-row">
        <span className="aurum-pref-picker-label">Why this pin exists (required, kept in the audit feed)</span>
        <textarea
          className="aurum-mkt-input"
          rows={3}
          value={reason}
          disabled={pending}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
      <div className="aurum-mkt-form-actions">
        <button className="aurum-btn" type="submit" disabled={pending || reason.trim() === ''}>
          Pin this provider
        </button>
      </div>
      <StatusLine error={error} summary={summary} pending={pending} />
    </form>
  );
}

/** Clear one technical override (reversible — set it again any time). */
export function OverrideClearButton({
  capability,
}: {
  capability: string | null;
}): ReactNode {
  const { pending, error, summary, run } = usePreferencesAction();
  return (
    <span className="aurum-pref-inline-action">
      <button
        className="aurum-btn"
        type="button"
        data-variant="quiet"
        disabled={pending}
        onClick={() => {
          void run({ action: 'override.clear', capability });
        }}
      >
        Clear pin
      </button>
      <StatusLine error={error} summary={summary} pending={pending} />
    </span>
  );
}
