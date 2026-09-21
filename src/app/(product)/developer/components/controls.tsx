'use client';

// Developer / API / MCP Console (W067) — the interactive controls.
//
// The surface's client side is deliberately small and quiet (ShareNet
// visual language, WhatsApp-era interaction restraint: compact forms,
// progressive disclosure, honest pending/error/result states). Every
// control POSTs one action to /api/product/developer (a thin adapter →
// the api module's contract only) and refreshes the server-rendered view
// on success; nothing here holds domain state.
//
// CREDENTIAL DISCIPLINE: the raw key value exists ONLY inside this
// component tree's ephemeral client state, in the one-time reveal the
// create/rotate actions return. The server-rendered view can never carry
// it (only sha-256 hashes persist anywhere), and no field here accepts a
// webhook signing-secret VALUE — only an opaque `secretRef`.
//
// Accessibility: real <form> semantics, labeled inputs, focus-visible
// treatment from the shell, pending state announced via aria-live, and
// 44px+ touch targets on every interactive control.

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { DeveloperAction } from '../lib/actions';
import {
  DEV_API_SCOPES,
  DEV_AUTHORITY_CLAIMS,
  EVENT_TYPE_EXAMPLES,
  KEY_SHOWN_ONCE_NOTE,
  authorityClaimExplanation,
  authorityClaimLabel,
  maskKey,
  scopeExplanation,
  scopeLabel,
} from '../lib/labels';

// ---------------------------------------------------------------------------
// The shared action plumbing
// ---------------------------------------------------------------------------

interface ApiEnvelope {
  summary?: string;
  result?: unknown;
  error?: string;
  message?: string;
}

/** POST one action body to the developer API. */
async function postDeveloperAction(body: Record<string, unknown>): Promise<ApiEnvelope> {
  const response = await fetch('/api/product/developer', {
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
function useDeveloperAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<unknown> => {
      setPending(true);
      setError(null);
      setSummary(null);
      setResult(null);
      try {
        const envelope = await postDeveloperAction(body);
        setSummary(envelope.summary ?? 'Done.');
        setResult(envelope.result ?? null);
        router.refresh();
        return envelope.result ?? null;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'request failed');
        return null;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { pending, error, summary, result, run };
}

function StatusLine({
  error,
  summary,
  pending,
  pendingNote = 'Working…',
}: {
  error: string | null;
  summary: string | null;
  pending: boolean;
  pendingNote?: string;
}): ReactNode {
  return (
    <>
      {pending ? (
        <span className="aurum-mkt-hint" aria-live="polite">
          {pendingNote}
        </span>
      ) : null}
      {error === null ? null : (
        <span className="aurum-ai-status aurum-ai-status-error" role="alert">
          {error}
        </span>
      )}
      {error === null && summary !== null ? (
        <span className="aurum-ai-status aurum-ai-status-ok" aria-live="polite">
          {summary}
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The one-time raw-key reveal
// ---------------------------------------------------------------------------

/** A key-issuing action result, narrowed for the reveal. */
function isIssuedKeyResult(value: unknown): value is { apiKey: { label: string }; key: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof (value as { key: unknown }).key === 'string' &&
    'apiKey' in value
  );
}

/**
 * The one-time reveal: the raw key in a copyable code block with the
 * shown-once warning. Exists only as client state — a refresh (or any
 * navigation) drops it, because the server view can never carry it.
 */
export function KeyReveal({ value }: { value: { apiKey: { label: string }; key: string } }): ReactNode {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="aurum-dev-reveal" role="status" aria-live="polite">
      <strong>{value.apiKey.label} — raw key</strong>
      <code className="aurum-mono aurum-dev-reveal-key">{value.key}</code>
      <span className="aurum-dev-reveal-note">{KEY_SHOWN_ONCE_NOTE}</span>
      <span className="aurum-dev-reveal-note aurum-dev-reveal-mask">
        For logs and dashboards, call it <code className="aurum-mono">{maskKey(value.key)}</code>.
      </span>
      <button type="button" className="aurum-btn aurum-btn-quiet" onClick={() => void copy()}>
        {copied ? 'Copied ✓' : 'Copy key'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One-click action button (revoke / rotate / deactivate / test / redeliver)
// ---------------------------------------------------------------------------

export function DevActionButton({
  action,
  fields,
  label,
  variant = 'quiet',
  confirmText = null,
  pendingNote = 'Working…',
  onResult,
}: {
  action: DeveloperAction;
  fields: Record<string, unknown>;
  label: string;
  variant?: 'quiet' | 'primary' | 'danger';
  confirmText?: string | null;
  pendingNote?: string;
  onResult?: (result: unknown) => void;
}): ReactNode {
  const { pending, error, summary, run } = useDeveloperAction();
  const cls =
    variant === 'primary'
      ? 'aurum-btn'
      : variant === 'danger'
        ? 'aurum-btn aurum-btn-danger'
        : 'aurum-btn aurum-btn-quiet';

  async function submit(): Promise<void> {
    if (confirmText !== null && !window.confirm(confirmText)) return;
    const outcome = await run({ action, ...fields });
    onResult?.(outcome);
  }

  return (
    <span className="aurum-ai-action-inline">
      <button type="button" className={cls} disabled={pending} onClick={() => void submit()}>
        {label}
      </button>
      <StatusLine error={error} summary={summary} pending={pending} pendingNote={pendingNote} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Checkbox vocabulary group (scopes / authority claims)
// ---------------------------------------------------------------------------

function VocabularyGroup({
  legend,
  hint,
  options,
  checked,
  onToggle,
}: {
  legend: string;
  hint?: string;
  options: { value: string; label: string; description: string }[];
  checked: Record<string, boolean>;
  onToggle: (value: string) => void;
}): ReactNode {
  return (
    <fieldset className="aurum-mkt-perms">
      <legend className="aurum-mkt-field-label">{legend}</legend>
      {hint === undefined ? null : <span className="aurum-mkt-hint">{hint}</span>}
      <div className="aurum-mkt-perm-list">
        {options.map((option) => (
          <label key={option.value} className="aurum-mkt-perm">
            <input
              type="checkbox"
              checked={checked[option.value] ?? false}
              onChange={() => onToggle(option.value)}
            />
            <span className="aurum-mkt-perm-body">
              <span className="aurum-mkt-perm-label">{option.label}</span>
              <span className="aurum-mkt-perm-desc">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Create-key form
// ---------------------------------------------------------------------------

export function CreateKeyForm(): ReactNode {
  const { pending, error, summary, run } = useDeveloperAction();
  const [reveal, setReveal] = useState<{ apiKey: { label: string }; key: string } | null>(null);
  const [scopes, setScopes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DEV_API_SCOPES.map((scope) => [scope, scope === 'goals:read'])),
  );
  const [authority, setAuthority] = useState<Record<string, boolean>>({});

  async function submit(formData: FormData): Promise<void> {
    const result = await run({
      action: 'key.create',
      label: String(formData.get('label') ?? ''),
      principalId: String(formData.get('principalId') ?? '').trim(),
      scopes: DEV_API_SCOPES.filter((scope) => scopes[scope]),
      authority: DEV_AUTHORITY_CLAIMS.filter((claim) => authority[claim]),
    });
    if (isIssuedKeyResult(result)) setReveal(result);
  }

  return (
    <details className="aurum-learn-disclose aurum-dev-disclose">
      <summary>Create an API key</summary>
      <form
        className="aurum-mkt-form"
        onSubmit={(event) => {
          event.preventDefault();
          setReveal(null);
          const formData = new FormData(event.currentTarget);
          void submit(formData);
        }}
      >
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Key label</span>
          <input
            className="aurum-mkt-input"
            name="label"
            type="text"
            required
            maxLength={120}
            placeholder="CI pipeline"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            Your own name for the credential — what you will recognize in the key list.
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Grantee principal (optional)</span>
          <input
            className="aurum-mkt-input"
            name="principalId"
            type="text"
            placeholder="(defaults to you)"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            A uuid of a company member the key acts as. Leave empty to issue it as yourself.
          </span>
        </label>
        <VocabularyGroup
          legend="Capability scopes"
          hint="Exactly what this key may call on the public API — nothing more."
          options={DEV_API_SCOPES.map((scope) => ({
            value: scope,
            label: scopeLabel(scope),
            description: scopeExplanation(scope),
          }))}
          checked={scopes}
          onToggle={(value) => setScopes((previous) => ({ ...previous, [value]: !previous[value] }))}
        />
        <VocabularyGroup
          legend="Authority claims (optional)"
          hint="Claims the key carries DOWNSTREAM, so domain modules' own gates apply unchanged. Platform claims are never grantable to a key."
          options={DEV_AUTHORITY_CLAIMS.map((claim) => ({
            value: claim,
            label: authorityClaimLabel(claim),
            description: authorityClaimExplanation(claim),
          }))}
          checked={authority}
          onToggle={(value) =>
            setAuthority((previous) => ({ ...previous, [value]: !previous[value] }))
          }
        />
        <div className="aurum-mkt-form-actions">
          <button type="submit" className="aurum-btn" disabled={pending}>
            {pending ? 'Working…' : 'Create key'}
          </button>
          <StatusLine error={error} summary={summary} pending={pending} />
        </div>
        {reveal === null ? null : <KeyReveal value={reveal} />}
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Per-key controls: rotate (with reveal) / revoke
// ---------------------------------------------------------------------------

export function KeyControls({
  keyId,
  label,
  active,
}: {
  keyId: string;
  label: string;
  active: boolean;
}): ReactNode {
  const rotate = useDeveloperAction();
  const [reveal, setReveal] = useState<{ apiKey: { label: string }; key: string } | null>(null);

  async function runRotate(): Promise<void> {
    if (
      !window.confirm(
        `Rotate the key “${label}”? A fresh key with the same grant is issued and this one is revoked immediately.`,
      )
    ) {
      return;
    }
    const result = await rotate.run({ action: 'key.rotate', keyId });
    if (isIssuedKeyResult(result)) setReveal(result);
  }

  if (!active) {
    return (
      <span className="aurum-ai-action-inline">
        <span className="aurum-mkt-hint">Revoked — retained as evidence.</span>
      </span>
    );
  }

  return (
    <div className="aurum-dev-key-controls">
      <div className="aurum-ai-action-inline">
        <button
          type="button"
          className="aurum-btn aurum-btn-quiet"
          disabled={rotate.pending}
          onClick={() => void runRotate()}
        >
          {rotate.pending ? 'Rotating…' : 'Rotate'}
        </button>
        <DevActionButton
          action="key.revoke"
          fields={{ keyId }}
          label="Revoke"
          variant="danger"
          confirmText={`Revoke the key “${label}”? It stops authenticating immediately; the record and its audit history stay.`}
        />
        <StatusLine
          error={rotate.error}
          summary={rotate.summary}
          pending={rotate.pending}
          pendingNote="Rotating…"
        />
      </div>
      {reveal === null ? null : <KeyReveal value={reveal} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-webhook form
// ---------------------------------------------------------------------------

export function CreateWebhookForm(): ReactNode {
  const { pending, error, summary, run } = useDeveloperAction();

  async function submit(formData: FormData): Promise<void> {
    await run({
      action: 'webhook.create',
      label: String(formData.get('label') ?? ''),
      url: String(formData.get('url') ?? ''),
      eventTypes: String(formData.get('eventTypes') ?? ''),
      secretRef: String(formData.get('secretRef') ?? '').trim(),
      maxAttempts: String(formData.get('maxAttempts') ?? '').trim(),
    });
  }

  return (
    <details className="aurum-learn-disclose aurum-dev-disclose">
      <summary>Add a webhook endpoint</summary>
      <form
        className="aurum-mkt-form"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          void submit(formData);
        }}
      >
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Endpoint label</span>
          <input
            className="aurum-mkt-input"
            name="label"
            type="text"
            required
            maxLength={120}
            placeholder="Order pipeline"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">Your own name for the subscription.</span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">HTTPS endpoint</span>
          <input
            className="aurum-mkt-input"
            name="url"
            type="url"
            required
            maxLength={2000}
            placeholder="https://example.test/hooks/aurum"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            https is required (plain http only for loopback hosts). Aurum POSTs the signed envelope
            here for every matching event.
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Event types</span>
          <input
            className="aurum-mkt-input"
            name="eventTypes"
            type="text"
            required
            placeholder={EVENT_TYPE_EXAMPLES.join(', ')}
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            Comma- or newline-separated patterns — a canonical event-type id, a dotted prefix
            wildcard (goal.*), or *.
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Signing-secret reference (optional)</span>
          <input
            className="aurum-mkt-input"
            name="secretRef"
            type="text"
            maxLength={255}
            placeholder="secret-store://…"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            Opaque secret-store reference — never the secret value. When set, deliveries are
            HMAC-SHA256 signed.
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Max delivery attempts</span>
          <input
            className="aurum-mkt-input"
            name="maxAttempts"
            type="number"
            min={1}
            max={10}
            defaultValue={5}
          />
          <span className="aurum-mkt-hint">
            1..10 attempts; transient failures retry with exponential backoff, subscriber
            rejections fail terminally.
          </span>
        </label>
        <div className="aurum-mkt-form-actions">
          <button type="submit" className="aurum-btn" disabled={pending}>
            {pending ? 'Working…' : 'Subscribe endpoint'}
          </button>
          <StatusLine error={error} summary={summary} pending={pending} />
        </div>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Per-subscription controls: test ping / deactivate
// ---------------------------------------------------------------------------

export function WebhookControls({
  subscriptionId,
  label,
  active,
}: {
  subscriptionId: string;
  label: string;
  active: boolean;
}): ReactNode {
  if (!active) {
    return (
      <span className="aurum-ai-action-inline">
        <span className="aurum-mkt-hint">Deactivated — delivery history stays as evidence.</span>
      </span>
    );
  }
  return (
    <span className="aurum-ai-action-inline">
      <DevActionButton
        action="webhook.test"
        fields={{ subscriptionId }}
        label="Send test ping"
        pendingNote="Enqueuing test…"
      />
      <DevActionButton
        action="webhook.deactivate"
        fields={{ subscriptionId }}
        label="Deactivate"
        variant="danger"
        confirmText={`Deactivate the webhook “${label}”? No further events fan out to it; the delivery history stays.`}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-delivery controls: redeliver
// ---------------------------------------------------------------------------

export function RedeliverButton({ deliveryId }: { deliveryId: string }): ReactNode {
  return (
    <DevActionButton
      action="webhook.redeliver"
      fields={{ deliveryId }}
      label="Redeliver"
      pendingNote="Cloning delivery…"
    />
  );
}

// ---------------------------------------------------------------------------
// The dispatch pump control
// ---------------------------------------------------------------------------

export function DispatchPumpControl(): ReactNode {
  const { pending, error, summary, result, run } = useDeveloperAction();

  async function runPump(): Promise<void> {
    await run({ action: 'webhook.dispatch' });
  }

  return (
    <div className="aurum-dev-key-controls">
      <div className="aurum-ai-action-inline">
        <button
          type="button"
          className="aurum-btn aurum-btn-quiet"
          disabled={pending}
          onClick={() => void runPump()}
        >
          {pending ? 'Running…' : 'Run delivery pump'}
        </button>
        <StatusLine
          error={error}
          summary={summary}
          pending={pending}
          pendingNote="Delivering due webhooks…"
        />
      </div>
      {result !== null && typeof result === 'object' && 'transportWired' in result && result['transportWired'] === false ? (
        <div className="aurum-notice" role="status">
          <strong>No webhook transport is wired in this process.</strong> Test pings and deliveries
          queue as pending and dispatch honestly refuses to fake success — wire a transport
          (setApiWebhookTransport at process start) to send them. Subscriptions, evidence and
          redelivery remain fully manageable.
        </div>
      ) : null}
    </div>
  );
}
