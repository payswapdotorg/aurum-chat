'use client';

// Connection & Integration Hub (W059) — the interactive controls.
//
// The hub's client surface is deliberately small and quiet (ShareNet visual
// language, WhatsApp-era interaction discipline: compact forms, progressive
// disclosure, honest pending/error states). Every control POSTs one action
// to /api/connections (thin adapter → domain contracts only) and refreshes
// the server-rendered view on success; nothing here holds domain state.
//
// CREDENTIAL DISCIPLINE: the connect forms ask for an OPAQUE
// `credentialRef` (secret-store reference) — there is no field anywhere in
// this file that accepts a credential VALUE (acceptance: "tenant-owned
// credential references only").

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { CatalogEntry } from '../lib/catalog';

export interface Scope {
  tenant: string | null;
  principal: string | null;
  authority: string | null;
}

interface ApiSuccess {
  summary?: string;
}

interface ApiFailure {
  error?: string;
  message?: string;
}

/** POST one action body to the hub API. */
async function postAction(scope: Scope, body: Record<string, unknown>): Promise<ApiSuccess> {
  const query = new URLSearchParams();
  if (scope.tenant !== null && scope.tenant !== '') query.set('tenant', scope.tenant);
  if (scope.principal !== null && scope.principal !== '') query.set('principal', scope.principal);
  if (scope.authority !== null && scope.authority !== '') query.set('authority', scope.authority);
  const response = await fetch(
    `/api/connections${query.size === 0 ? '' : `?${query.toString()}`}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const parsed = (await response.json().catch(() => null)) as ApiSuccess | ApiFailure | null;
  if (!response.ok) {
    const failure = parsed as ApiFailure | null;
    throw new Error(
      failure?.message ?? failure?.error ?? `request failed (HTTP ${response.status})`,
    );
  }
  return (parsed ?? {}) as ApiSuccess;
}

/** Shared action state: pending flag, error line, success summary, refresh. */
function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const run = useCallback(
    async (scope: Scope, body: Record<string, unknown>): Promise<boolean> => {
      setPending(true);
      setError(null);
      setSummary(null);
      try {
        const result = await postAction(scope, body);
        setSummary(result.summary ?? 'Done.');
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
  pendingNote = 'Working…',
}: {
  error: string | null;
  summary: string | null;
  pending: boolean;
  pendingNote?: string;
}): ReactNode {
  return (
    <>
      {pending ? <span className="pending-note" aria-live="polite">{pendingNote}</span> : null}
      {error === null ? null : (
        <span className="status-line error" role="alert">
          {error}
        </span>
      )}
      {error === null && summary !== null ? (
        <span className="status-line ok" aria-live="polite">
          {summary}
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// One-click action button (disconnect / reconnect / poll / retry / …)
// ---------------------------------------------------------------------------

export function ActionButton({
  scope,
  action,
  fields,
  label,
  tone = 'quiet',
  confirmText = null,
}: {
  scope: Scope;
  action: string;
  fields: Record<string, string>;
  label: string;
  tone?: 'quiet' | 'primary' | 'danger';
  confirmText?: string | null;
}): ReactNode {
  const { pending, error, summary, run } = useAction();
  const cls = tone === 'primary' ? 'btn' : tone === 'danger' ? 'btn btn-danger' : 'btn btn-quiet';

  async function submit(): Promise<void> {
    if (confirmText !== null && !window.confirm(confirmText)) return;
    await run(scope, { action, ...fields });
  }

  return (
    <span className="action-inline">
      <button type="button" className={cls} disabled={pending} onClick={() => void submit()}>
        {label}
      </button>
      <StatusLine error={error} summary={summary} pending={pending} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small inline form (code completion, attestation, linking, lookup)
// ---------------------------------------------------------------------------

export interface InlineField {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'email';
  required?: boolean;
}

export function ActionForm({
  scope,
  action,
  fixedFields,
  fields,
  submitLabel,
  tone = 'quiet',
}: {
  scope: Scope;
  action: string;
  fixedFields: Record<string, string>;
  fields: InlineField[];
  submitLabel: string;
  tone?: 'quiet' | 'primary' | 'danger';
}): ReactNode {
  const { pending, error, summary, run } = useAction();
  const cls = tone === 'primary' ? 'btn' : tone === 'danger' ? 'btn btn-danger' : 'btn btn-quiet';

  async function submit(formData: FormData): Promise<void> {
    const body: Record<string, unknown> = { action, ...fixedFields };
    for (const field of fields) {
      const value = formData.get(field.name);
      body[field.name] = typeof value === 'string' ? value : '';
    }
    await run(scope, body);
  }

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        void submit(formData);
      }}
    >
      {fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={`${action}-${field.name}-${fixedFields.id ?? fixedFields.identityId ?? ''}`}>
            {field.label}
          </label>
          <input
            id={`${action}-${field.name}-${fixedFields.id ?? fixedFields.identityId ?? ''}`}
            name={field.name}
            type={field.type ?? 'text'}
            placeholder={field.placeholder}
            required={field.required}
            autoComplete="off"
          />
          {field.hint === undefined ? null : <span className="hint">{field.hint}</span>}
        </div>
      ))}
      <div className="action-inline">
        <button type="submit" className={cls} disabled={pending}>
          {submitLabel}
        </button>
        <StatusLine error={error} summary={summary} pending={pending} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Connect form (channel / source / destination registration)
// ---------------------------------------------------------------------------

export interface ConnectFormProps {
  scope: Scope;
  kind: 'channel' | 'source' | 'destination';
  providers: CatalogEntry[];
  title: string;
}

export function ConnectForm({ scope, kind, providers, title }: ConnectFormProps): ReactNode {
  const { pending, error, summary, run } = useAction();
  const [provider, setProvider] = useState(providers[0]?.key ?? '');
  const needsAuth = kind !== 'channel';
  const [authKind, setAuthKind] = useState<'oauth' | 'credentials'>(
    providers[0]?.authKind ?? 'oauth',
  );
  const entry = providers.find((item) => item.key === provider) ?? null;

  async function submit(formData: FormData): Promise<void> {
    const body: Record<string, unknown> = {
      action: `${kind}.register`,
      provider,
      providerAccountId: String(formData.get('providerAccountId') ?? ''),
      credentialRef: String(formData.get('credentialRef') ?? ''),
    };
    const displayName = String(formData.get('displayName') ?? '').trim();
    if (displayName !== '') body['displayName'] = displayName;
    if (needsAuth) {
      body['authKind'] = authKind;
      if (authKind === 'oauth') {
        const scopes = String(formData.get('oauthScopes') ?? '').trim();
        if (scopes !== '') {
          body['oauthScopes'] = scopes.split(/[\s,]+/).filter((scopeText) => scopeText !== '');
        }
        const expires = String(formData.get('oauthExpiresAt') ?? '').trim();
        if (expires !== '') body['oauthExpiresAt'] = new Date(expires).toISOString();
      }
    }
    await run(scope, body);
  }

  return (
    <details className="disclose">
      <summary>{title}</summary>
      <div className="disclose-body">
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            void submit(formData);
          }}
        >
          <div className="field">
            <label htmlFor={`${kind}-connect-provider`}>Provider</label>
            <select
              id={`${kind}-connect-provider`}
              value={provider}
              onChange={(event) => {
                const key = event.currentTarget.value;
                setProvider(key);
                const next = providers.find((item) => item.key === key);
                if (next !== undefined) setAuthKind(next.authKind);
              }}
            >
              {providers.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
            {entry === null ? null : <span className="hint">{entry.description}</span>}
          </div>
          <div className="field">
            <label htmlFor={`${kind}-connect-account`}>
              {entry?.accountIdHint ?? 'provider account id'}
            </label>
            <input
              id={`${kind}-connect-account`}
              name="providerAccountId"
              type="text"
              required
              autoComplete="off"
              placeholder={entry?.accountIdHint ?? 'account id'}
            />
          </div>
          <div className="field">
            <label htmlFor={`${kind}-connect-name`}>Display name (optional)</label>
            <input id={`${kind}-connect-name`} name="displayName" type="text" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor={`${kind}-connect-credential`}>Credential reference</label>
            <input
              id={`${kind}-connect-credential`}
              name="credentialRef"
              type="text"
              required
              autoComplete="off"
              placeholder="secret-store://…"
            />
            <span className="hint">
              Opaque reference to the tenant&apos;s secret-store entry — never a credential value.
              Aurum stores the reference only.
            </span>
          </div>
          {needsAuth ? (
            <>
              <fieldset className="radios">
                <legend>Authorization kind</legend>
                <span className="radio">
                  <input
                    type="radio"
                    id={`${kind}-auth-oauth`}
                    name="authKindChoice"
                    checked={authKind === 'oauth'}
                    onChange={() => setAuthKind('oauth')}
                  />
                  <label htmlFor={`${kind}-auth-oauth`}>OAuth grant</label>
                </span>
                <span className="radio">
                  <input
                    type="radio"
                    id={`${kind}-auth-credentials`}
                    name="authKindChoice"
                    checked={authKind === 'credentials'}
                    onChange={() => setAuthKind('credentials')}
                  />
                  <label htmlFor={`${kind}-auth-credentials`}>Credentials</label>
                </span>
              </fieldset>
              {authKind === 'oauth' ? (
                <>
                  <div className="field">
                    <label htmlFor={`${kind}-connect-scopes`}>Granted scopes (optional, space-separated)</label>
                    <input
                      id={`${kind}-connect-scopes`}
                      name="oauthScopes"
                      type="text"
                      autoComplete="off"
                      placeholder="read:records write:records"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${kind}-connect-expiry`}>Grant expires (optional)</label>
                    <input
                      id={`${kind}-connect-expiry`}
                      name="oauthExpiresAt"
                      type="datetime-local"
                    />
                    <span className="hint">Leave empty for a non-expiring grant.</span>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          <div className="action-inline">
            <button type="submit" className="btn" disabled={pending}>
              Connect {entry?.label ?? kind}
            </button>
            <StatusLine error={error} summary={summary} pending={pending} />
          </div>
        </form>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Person creation (supports the identity linking workflow)
// ---------------------------------------------------------------------------

export function PersonCreateForm({ scope }: { scope: Scope }): ReactNode {
  const { pending, error, summary, run } = useAction();

  async function submit(formData: FormData): Promise<void> {
    const body: Record<string, unknown> = {
      action: 'person.create',
      fullName: String(formData.get('fullName') ?? ''),
    };
    const email = String(formData.get('email') ?? '').trim();
    if (email !== '') body['email'] = email;
    await run(scope, body);
  }

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        void submit(formData);
      }}
    >
      <div className="field">
        <label htmlFor="person-full-name">Person full name</label>
        <input id="person-full-name" name="fullName" type="text" required autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="person-email">Email (optional)</label>
        <input id="person-email" name="email" type="email" autoComplete="off" />
      </div>
      <div className="action-inline">
        <button type="submit" className="btn btn-quiet" disabled={pending}>
          Create person record
        </button>
        <StatusLine error={error} summary={summary} pending={pending} />
      </div>
    </form>
  );
}
