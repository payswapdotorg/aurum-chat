'use client';

// Product surface (W064) — the marketplace area's write forms.
//
// One generic, quiet client form drives every governance write of the
// area (submit/verify/review/publish/make-installable, deploy/rollback/
// activate/suspend/resume/deprecate, create packages, request/advance/
// cancel builds). It POSTs JSON to the thin API adapter with the scope
// parameters preserved, then renders the HONEST outcome:
//   * an error (what the domain refused, in its own words);
//   * a pending human-approval gate (with the deep link to decide it —
//     management mode's Approvals surface);
//   * success (then a router refresh so the server-rendered state
//     catches up — the server page stays the source of truth).
//
// Accessibility: real <form> semantics, labeled inputs, focus-visible
// treatment from the shell, pending state announced via aria-live, and
// 44px+ touch targets on every interactive control.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

export type ActionField =
  | {
      kind: 'text';
      name: string;
      label: string;
      placeholder?: string;
      required?: boolean;
      defaultValue?: string;
      textarea?: boolean;
      hint?: string;
    }
  | {
      kind: 'select';
      name: string;
      label: string;
      options: { value: string; label: string }[];
      defaultValue?: string;
      required?: boolean;
      hint?: string;
    }
  | {
      kind: 'permission-select';
      name: string;
      label: string;
      hint?: string;
      options: { value: string; label: string; description: string }[];
    };

export interface ActionFormProps {
  /** The API path (relative), e.g. /api/product/marketplace/package/<id>/submit */
  action: string;
  /** Preserved scope query ('' or '?tenant=…&principal=…'). */
  scopeQuery: string;
  fields: ActionField[];
  submitLabel: string;
  /** Renders a quiet variant of the submit control. */
  variant?: 'primary' | 'quiet' | 'danger';
  /** A confirmation the user must see before the button unlocks (consequential actions). */
  confirmPrompt?: string;
  note?: string;
  /** Hidden values merged into the POST body. */
  hidden?: Record<string, string>;
}

interface GateInfo {
  actionRequestId?: string;
  status?: string;
}

interface InstallReportBody {
  outcome: string;
  steps: {
    step: string;
    label: string;
    status: string;
    detail: string;
    actionRequestId?: string;
  }[];
}

interface OutcomeBody {
  ok?: boolean;
  applied?: boolean;
  outcome?: string;
  gate?: GateInfo;
  error?: string;
  message?: string;
  report?: InstallReportBody;
}

export function ActionForm({
  action,
  scopeQuery,
  fields,
  submitLabel,
  variant = 'primary',
  confirmPrompt,
  note,
  hidden = {},
}: ActionFormProps): ReactNode {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of fields) {
      if (field.kind === 'permission-select') continue;
      if (field.defaultValue !== undefined) initial[field.name] = field.defaultValue;
      else if (field.kind === 'select' && field.options[0] !== undefined) {
        initial[field.name] = field.options[0].value;
      } else {
        initial[field.name] = '';
      }
    }
    return initial;
  });
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const field of fields) {
      if (field.kind !== 'permission-select') continue;
      for (const option of field.options) initial[option.value] = true;
    }
    return initial;
  });
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<GateInfo | null>(null);
  const [installReport, setInstallReport] = useState<InstallReportBody | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null);

  const needsConfirm = confirmPrompt !== undefined;
  const confirmSatisfied = !needsConfirm || confirmed;

  function set(name: string, value: string): void {
    setValues((previous) => ({ ...previous, [name]: value }));
  }

  function toggle(permission: string): void {
    setChecked((previous) => ({ ...previous, [permission]: !previous[permission] }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!confirmSatisfied) return;
    setPending(true);
    setError(null);
    setGate(null);
    setInstallReport(null);
    setDoneNote(null);
    try {
      const body: Record<string, unknown> = { ...hidden, ...values };
      for (const field of fields) {
        if (field.kind === 'permission-select') {
          body[field.name] = field.options
            .filter((option) => checked[option.value])
            .map((option) => option.value);
        }
      }
      const url =
        scopeQuery === '' ? action : `${action}${scopeQuery}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const body_ = (await response.json().catch(() => null)) as OutcomeBody | null;
      if (!response.ok || body_ === null) {
        throw new Error(
          body_?.message ?? body_?.error ?? `the operation failed (HTTP ${response.status})`,
        );
      }
      // The honest outcome rendering (see the component doc).
      if (body_.report !== undefined) {
        setInstallReport(body_.report);
        router.refresh();
        return;
      }
      if (body_.gate !== undefined && body_.gate.status === 'pending') {
        setGate(body_.gate);
        router.refresh();
        return;
      }
      if (body_.gate !== undefined && body_.gate.status === 'rejected') {
        setError('the tenant authority policy refused this operation — see Approvals for the recorded decision');
        return;
      }
      setDoneNote('Done — the state below is live.');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the operation failed');
    } finally {
      setPending(false);
    }
  }

  const approvalsHref = `/approvals${scopeQuery === '' ? '' : scopeQuery}`;

  return (
    <form className="aurum-mkt-form" onSubmit={(event) => void submit(event)}>
      {fields.map((field) => {
        if (field.kind === 'text') {
          return (
            <label key={field.name} className="aurum-mkt-field">
              <span className="aurum-mkt-field-label">{field.label}</span>
              {field.textarea === true ? (
                <textarea
                  className="aurum-mkt-input"
                  name={field.name}
                  placeholder={field.placeholder}
                  required={field.required}
                  value={values[field.name] ?? ''}
                  onChange={(event) => set(field.name, event.target.value)}
                  rows={3}
                />
              ) : (
                <input
                  className="aurum-mkt-input"
                  type="text"
                  name={field.name}
                  placeholder={field.placeholder}
                  required={field.required}
                  value={values[field.name] ?? ''}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              )}
              {field.hint === undefined ? null : (
                <span className="aurum-mkt-hint">{field.hint}</span>
              )}
            </label>
          );
        }
        if (field.kind === 'select') {
          return (
            <label key={field.name} className="aurum-mkt-field">
              <span className="aurum-mkt-field-label">{field.label}</span>
              <select
                className="aurum-mkt-input"
                name={field.name}
                required={field.required}
                value={values[field.name] ?? ''}
                onChange={(event) => set(field.name, event.target.value)}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {field.hint === undefined ? null : (
                <span className="aurum-mkt-hint">{field.hint}</span>
              )}
            </label>
          );
        }
        // permission-select: the grant narrowing control.
        const anyChecked = field.options.some((option) => checked[option.value]);
        return (
          <fieldset key={field.name} className="aurum-mkt-perms">
            <legend className="aurum-mkt-field-label">{field.label}</legend>
            {field.hint === undefined ? null : (
              <span className="aurum-mkt-hint">{field.hint}</span>
            )}
            <div className="aurum-mkt-perm-list">
              {field.options.map((option) => (
                <label key={option.value} className="aurum-mkt-perm">
                  <input
                    type="checkbox"
                    checked={checked[option.value] ?? false}
                    onChange={() => toggle(option.value)}
                  />
                  <span className="aurum-mkt-perm-body">
                    <span className="aurum-mkt-perm-label">{option.label}</span>
                    <span className="aurum-mkt-perm-desc">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {anyChecked ? null : (
              <span className="aurum-mkt-hint" role="alert">
                grant at least one permission, or accept the full set.
              </span>
            )}
          </fieldset>
        );
      })}

      {needsConfirm ? (
        <label className="aurum-mkt-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={() => setConfirmed((previous) => !previous)}
          />
          <span>{confirmPrompt}</span>
        </label>
      ) : null}

      <div className="aurum-mkt-form-actions">
        <button
          type="submit"
          className="aurum-btn"
          data-variant={variant === 'primary' ? undefined : variant}
          disabled={pending || !confirmSatisfied}
        >
          {pending ? 'Working…' : submitLabel}
        </button>
        {note === undefined ? null : <span className="aurum-mkt-hint">{note}</span>}
      </div>

      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The operation was refused</strong>
            <span>{error}</span>
          </div>
        )}
        {gate === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }}>
            <strong>Waiting for the human approval gate.</strong> Nothing was applied — the
            authority matrix holds this operation until an authorized principal decides it.
            <span style={{ display: 'block', marginTop: 6 }}>
              <Link className="aurum-mkt-link" href={approvalsHref}>
                Decide it in Approvals (management mode)
              </Link>
            </span>
          </div>
        )}
        {installReport == null ? null : (
          <div className="aurum-mkt-report" style={{ marginTop: 10 }}>
            <strong>
              {installReport.outcome === 'installed'
                ? 'Installed.'
                : installReport.outcome === 'awaiting_approval'
                  ? 'Partly installed — a step is waiting for approval.'
                  : 'The install stopped.'}
            </strong>
            <ol className="aurum-mkt-report-steps">
              {installReport.steps.map((step) => (
                <li key={step.step} data-status={step.status}>
                  <span className="aurum-mkt-report-step-label">{step.label}</span>
                  <span className="aurum-mkt-report-step-detail">{step.detail}</span>
                  {step.actionRequestId === undefined ? null : (
                    <span className="aurum-mkt-report-step-detail">
                      <Link className="aurum-mkt-link" href={approvalsHref}>
                        decide request {step.actionRequestId.slice(0, 8)}
                      </Link>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        {doneNote === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            {doneNote}
          </div>
        )}
      </div>
    </form>
  );
}
