'use client';

// AI/BYOA & Provider Routing UX (W066) — the interactive controls.
//
// The surface's client side is deliberately small and quiet (ShareNet
// visual language, WhatsApp-era interaction restraint: compact forms,
// progressive disclosure, honest pending/error/result states). Every
// control POSTs one action to /api/product/ai (a thin adapter → the llm
// module's contract only) and refreshes the server-rendered view on
// success; nothing here holds domain state.
//
// CREDENTIAL DISCIPLINE: every credential field accepts an OPAQUE
// `credentialRef` (secret-store reference) — there is no field anywhere
// in this file that accepts a credential VALUE.
//
// Accessibility: real <form> semantics, labeled inputs, focus-visible
// treatment from the shell, pending state announced via aria-live, and
// 44px+ touch targets on every interactive control.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AccountCard,
  CatalogProviderRow,
  ExecutionRow,
} from '../lib/views';
import type { HotSwapActionResult, TestConnectionResult } from '../lib/actions';
import type { DataClassification, LlmScope } from '@/modules/llm/contract';
import {
  AI_SCOPES,
  capabilityExplanation,
  capabilityLabel,
  classificationExplanation,
  classificationLabel,
  classificationOptions,
  hotSwapOutcomeExplanation,
  hotSwapOutcomeLabel,
  providerLabel,
  providerOptions,
  scopeExplanation,
  scopeLabel,
  scopeOptions,
  suggestedHotSwapParameters,
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

/** POST one action body to the AI-providers API. */
async function postAiAction(body: Record<string, unknown>): Promise<ApiEnvelope> {
  const response = await fetch('/api/product/ai', {
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
function useAiAction() {
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
        const envelope = await postAiAction(body);
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
// One-click action button (revoke / restore / test / hold / release)
// ---------------------------------------------------------------------------

export function AiActionButton({
  action,
  fields,
  label,
  variant = 'quiet',
  confirmText = null,
  pendingNote = 'Working…',
  onResult,
}: {
  action: string;
  fields: Record<string, unknown>;
  label: string;
  variant?: 'quiet' | 'primary' | 'danger';
  confirmText?: string | null;
  pendingNote?: string;
  onResult?: (result: unknown) => void;
}): ReactNode {
  const { pending, error, summary, run } = useAiAction();
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
// The connection-test outcome (the honest verified/failed/gated states)
// ---------------------------------------------------------------------------

function TestOutcomeNote({ result }: { result: unknown }): ReactNode {
  if (!isTestResult(result)) return null;
  if (result.outcome === 'awaiting-approval') {
    return (
      <div className="aurum-notice" role="status">
        <strong>Waiting for the human approval gate.</strong> The tenant policy holds llm
        invocations until an authorized principal decides.
        {result.actionRequestId === null ? null : (
          <span style={{ display: 'block', marginTop: 6 }}>
            <Link className="aurum-mkt-link" href="/approvals">
              Decide request {result.actionRequestId.slice(0, 8)} in Approvals (management mode)
            </Link>
          </span>
        )}
        <span style={{ display: 'block', marginTop: 6 }}>{result.note}</span>
      </div>
    );
  }
  const verified = result.outcome === 'verified';
  return (
    <div className={verified ? 'aurum-ai-result aurum-ai-result-ok' : 'aurum-ai-result aurum-ai-result-fail'}>
      <strong>
        {verified
          ? `Verified through ${result.model ?? 'the routed model'}`
          : 'The test did not complete'}
      </strong>
      <span>
        {verified
          ? `${result.provider} · ${result.capability} · scope ${result.scope} · ${result.latencyMs ?? '—'} ms`
          : `${result.errorCode ?? 'unknown'}: ${result.errorDetail ?? 'no detail'}`}
      </span>
      {verified ? (
        <span className="aurum-ai-result-meta">
          execution <code className="aurum-mono">{result.executionId?.slice(0, 8) ?? '—'}</code> ·
          deterministic cost {result.costMinor ?? 0} minor units · {result.note}
        </span>
      ) : (
        <span className="aurum-ai-result-meta">{result.note}</span>
      )}
    </div>
  );
}

function isTestResult(value: unknown): value is TestConnectionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'outcome' in value &&
    typeof (value as { outcome: unknown }).outcome === 'string'
  );
}

// ---------------------------------------------------------------------------
// Checkbox vocabulary group (scopes / capabilities)
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
// Add-account form (BYOA registration)
// ---------------------------------------------------------------------------

export function AddAccountForm({
  catalog,
}: {
  catalog: CatalogProviderRow[];
}): ReactNode {
  const { pending, error, summary, run } = useAiAction();
  const providers = useMemo(() => providerOptions(catalog.map((entry) => entry.provider)), [catalog]);
  const [provider, setProvider] = useState(providers[0]?.value ?? '');
  const [scopes, setScopes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(AI_SCOPES.map((scope) => [scope, true])),
  );
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({
    'text-generation': true,
    embedding: true,
  });
  const catalogEntry = catalog.find((entry) => entry.provider === provider);

  const capabilityOptions = [
    {
      value: 'text-generation',
      label: capabilityLabel('text-generation'),
      description: capabilityExplanation('text-generation'),
    },
    {
      value: 'embedding',
      label: capabilityLabel('embedding'),
      description: capabilityExplanation('embedding'),
    },
  ];
  const scopeCheckboxOptions = AI_SCOPES.map((scope) => ({
    value: scope,
    label: scopeLabel(scope),
    description: scopeExplanation(scope),
  }));

  async function submit(formData: FormData): Promise<void> {
    const selectedScopes = AI_SCOPES.filter((scope) => scopes[scope]);
    const selectedCapabilities = ['text-generation', 'embedding'].filter(
      (capability) => capabilities[capability],
    );
    const budgetDollars = String(formData.get('budgetDollars') ?? '').trim();
    const body: Record<string, unknown> = {
      action: 'account.register',
      provider,
      label: String(formData.get('label') ?? ''),
      credentialRef: String(formData.get('credentialRef') ?? ''),
      scopes: selectedScopes,
      capabilities: selectedCapabilities,
      maxDataClassification: String(formData.get('maxDataClassification') ?? 'internal'),
      priority: Number(formData.get('priority') ?? 100),
      ...(budgetDollars === '' ? {} : { budgetMinor: Math.round(Number(budgetDollars) * 100) }),
    };
    await run(body);
  }

  return (
    <details className="aurum-learn-disclose aurum-ai-disclose">
      <summary>Add an AI provider account (BYOA)</summary>
      <form
        className="aurum-mkt-form"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          void submit(formData);
        }}
      >
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Provider</span>
          <select
            className="aurum-mkt-input"
            name="provider"
            value={provider}
            onChange={(event) => setProvider(event.currentTarget.value)}
          >
            {providers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="aurum-mkt-hint">
            {catalogEntry === undefined
              ? 'Listed alphabetically — no provider is preferred.'
              : `${catalogEntry.models.length} registry model(s) · listed alphabetically — no provider is preferred.`}
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Account label</span>
          <input
            className="aurum-mkt-input"
            name="label"
            type="text"
            required
            maxLength={100}
            placeholder="Primary workspace key"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            Your own name for this account — unique per (provider, label).
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Credential reference</span>
          <input
            className="aurum-mkt-input"
            name="credentialRef"
            type="text"
            required
            maxLength={255}
            placeholder="secret-store://…"
            autoComplete="off"
          />
          <span className="aurum-mkt-hint">
            Opaque reference to your secret-store entry — never the credential value. Aurum stores
            the reference only.
          </span>
        </label>
        <VocabularyGroup
          legend="Permitted scopes"
          hint="Which Aurum surfaces may route to this account."
          options={scopeCheckboxOptions}
          checked={scopes}
          onToggle={(value) => setScopes((previous) => ({ ...previous, [value]: !previous[value] }))}
        />
        <VocabularyGroup
          legend="Permitted capabilities"
          hint="What the account may be asked to do (must match a model capability to route)."
          options={capabilityOptions}
          checked={capabilities}
          onToggle={(value) =>
            setCapabilities((previous) => ({ ...previous, [value]: !previous[value] }))
          }
        />
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Data-policy ceiling</span>
          <select className="aurum-mkt-input" name="maxDataClassification" defaultValue="internal">
            {classificationOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="aurum-mkt-hint">{classificationExplanation('internal')}</span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Routing priority</span>
          <input
            className="aurum-mkt-input"
            name="priority"
            type="number"
            min={0}
            max={1000}
            defaultValue={100}
            required
          />
          <span className="aurum-mkt-hint">
            Lower is preferred. Ties break by account age, then id — never by provider.
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Monthly budget (USD, optional)</span>
          <input
            className="aurum-mkt-input"
            name="budgetDollars"
            type="number"
            min={0.01}
            step="0.01"
            placeholder="50"
          />
          <span className="aurum-mkt-hint">
            Spend cap on completed executions per UTC month, metered from recorded evidence. Leave
            empty for no budget.
          </span>
        </label>
        <div className="aurum-mkt-form-actions">
          <button type="submit" className="aurum-btn" disabled={pending}>
            {pending ? 'Working…' : 'Add account'}
          </button>
          <StatusLine error={error} summary={summary} pending={pending} />
        </div>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Per-account controls: test / revoke / restore / configure / availability
// ---------------------------------------------------------------------------

export function AccountControls({ account }: { account: AccountCard }): ReactNode {
  const test = useAiAction();
  const [testModel, setTestModel] = useState('');
  const active = account.status === 'active';
  const modelOptions = ['', ...account.models.map((model) => model.modelId)];

  async function runTest(): Promise<void> {
    await test.run({
      action: 'account.test',
      accountId: account.id,
      ...(testModel === '' ? {} : { model: testModel }),
    });
  }

  return (
    <div className="aurum-ai-account-controls">
      <div className="aurum-ai-action-inline">
        <label className="aurum-ai-test-target">
          <span className="aurum-sr-only">Test through a specific model</span>
          <select
            className="aurum-mkt-input"
            value={testModel}
            onChange={(event) => setTestModel(event.currentTarget.value)}
            aria-label={`Model to test for ${account.label}`}
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model === '' ? 'Automatic model choice' : model}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="aurum-btn aurum-btn-quiet"
          disabled={test.pending}
          onClick={() => void runTest()}
        >
          {test.pending ? 'Testing…' : 'Test connection'}
        </button>
        {active ? (
          <AiActionButton
            action="account.setStatus"
            fields={{ accountId: account.id, status: 'disabled' }}
            label="Revoke"
            variant="danger"
            confirmText={`Revoke the ${providerLabel(account.provider)} account “${account.label}”? Routing stops immediately; the record, evidence and spend history are retained.`}
          />
        ) : (
          <AiActionButton
            action="account.setStatus"
            fields={{ accountId: account.id, status: 'active' }}
            label="Restore"
          />
        )}
      </div>
      <StatusLine error={test.error} summary={test.summary} pending={test.pending} />
      <TestOutcomeNote result={test.result} />
      <details className="aurum-learn-disclose">
        <summary>Policy, routing &amp; budget</summary>
        <ConfigureAccountForm account={account} />
      </details>
    </div>
  );
}

function ConfigureAccountForm({ account }: { account: AccountCard }): ReactNode {
  const { pending, error, summary, run } = useAiAction();
  const [scopes, setScopes] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      AI_SCOPES.map((scope) => [scope, (account.scopes as readonly string[]).includes(scope)]),
    ),
  );
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({
    'text-generation': (account.capabilities as readonly string[]).includes('text-generation'),
    embedding: (account.capabilities as readonly string[]).includes('embedding'),
  });
  const [clearBudget, setClearBudget] = useState(false);

  async function submit(formData: FormData): Promise<void> {
    const selectedScopes = AI_SCOPES.filter((scope) => scopes[scope]);
    const selectedCapabilities = ['text-generation', 'embedding'].filter(
      (capability) => capabilities[capability],
    );
    const credentialRef = String(formData.get('credentialRef') ?? '').trim();
    const budgetDollars = String(formData.get('budgetDollars') ?? '').trim();
    const body: Record<string, unknown> = {
      action: 'account.update',
      accountId: account.id,
      scopes: selectedScopes,
      capabilities: selectedCapabilities,
      maxDataClassification: String(formData.get('maxDataClassification') ?? 'internal'),
      priority: Number(formData.get('priority') ?? account.priority),
      ...(credentialRef === '' ? {} : { credentialRef }),
      ...(clearBudget ? { budgetMinor: null } : budgetDollars === '' ? {} : { budgetMinor: Math.round(Number(budgetDollars) * 100) }),
    };
    await run(body);
  }

  return (
    <form
      className="aurum-mkt-form"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        void submit(formData);
      }}
    >
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Rotate credential reference (optional)</span>
        <input
          className="aurum-mkt-input"
          name="credentialRef"
          type="text"
          maxLength={255}
          placeholder={account.credentialRef}
          autoComplete="off"
        />
        <span className="aurum-mkt-hint">
          Leave empty to keep <code className="aurum-mono">{account.credentialRef}</code>.
        </span>
      </label>
      <VocabularyGroup
        legend="Permitted scopes"
        options={AI_SCOPES.map((scope) => ({
          value: scope,
          label: scopeLabel(scope),
          description: scopeExplanation(scope),
        }))}
        checked={scopes}
        onToggle={(value) => setScopes((previous) => ({ ...previous, [value]: !previous[value] }))}
      />
      <VocabularyGroup
        legend="Permitted capabilities"
        options={[
          {
            value: 'text-generation',
            label: capabilityLabel('text-generation'),
            description: capabilityExplanation('text-generation'),
          },
          {
            value: 'embedding',
            label: capabilityLabel('embedding'),
            description: capabilityExplanation('embedding'),
          },
        ]}
        checked={capabilities}
        onToggle={(value) =>
          setCapabilities((previous) => ({ ...previous, [value]: !previous[value] }))
        }
      />
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Data-policy ceiling</span>
        <select
          className="aurum-mkt-input"
          name="maxDataClassification"
          defaultValue={account.maxDataClassification}
        >
          {classificationOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="aurum-mkt-hint">
          {classificationExplanation(account.maxDataClassification)}
        </span>
      </label>
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Routing priority</span>
        <input
          className="aurum-mkt-input"
          name="priority"
          type="number"
          min={0}
          max={1000}
          defaultValue={account.priority}
          required
        />
        <span className="aurum-mkt-hint">Lower is preferred among eligible accounts.</span>
      </label>
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Monthly budget (USD)</span>
        <input
          className="aurum-mkt-input"
          name="budgetDollars"
          type="number"
          min={0.01}
          step="0.01"
          placeholder={
            account.budgetMinor === null ? 'no budget' : (account.budgetMinor / 100).toFixed(2)
          }
          disabled={clearBudget}
        />
        <label className="aurum-mkt-confirm" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={clearBudget}
            onChange={() => setClearBudget((previous) => !previous)}
          />
          <span>Clear the budget (no monthly cap)</span>
        </label>
      </label>
      <div className="aurum-mkt-form-actions">
        <button type="submit" className="aurum-btn aurum-btn-quiet" disabled={pending}>
          {pending ? 'Working…' : 'Save configuration'}
        </button>
        <StatusLine error={error} summary={summary} pending={pending} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-model availability control (manual hold / release)
// ---------------------------------------------------------------------------

export function AvailabilityControl({
  accountId,
  provider,
  model,
  held,
}: {
  accountId: string;
  provider: string;
  model: string;
  held: boolean;
}): ReactNode {
  const { pending, error, summary, run } = useAiAction();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');

  async function hold(): Promise<void> {
    const trimmedReason = reason.trim();
    const trimmedMinutes = minutes.trim();
    const expiresAt =
      trimmedMinutes === '' ? null : new Date(Date.now() + Number(trimmedMinutes) * 60_000).toISOString();
    await run({
      action: 'availability.set',
      accountId,
      model,
      state: 'unavailable',
      ...(trimmedReason === '' ? {} : { reason: trimmedReason }),
      ...(expiresAt === null ? {} : { expiresAt }),
    });
  }

  return (
    <div className="aurum-ai-availability">
      {held ? (
        <AiActionButton
          action="availability.set"
          fields={{ accountId, model, state: 'available' }}
          label="Release hold"
          variant="primary"
        />
      ) : (
        <details className="aurum-learn-disclose aurum-ai-hold-form">
          <summary>Hold</summary>
          <form
            className="aurum-mkt-form"
            onSubmit={(event) => {
              event.preventDefault();
              void hold();
            }}
          >
            <label className="aurum-mkt-field">
              <span className="aurum-mkt-field-label">Reason (optional)</span>
              <input
                className="aurum-mkt-input"
                type="text"
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value)}
                placeholder="incident, rotation, quota…"
              />
            </label>
            <label className="aurum-mkt-field">
              <span className="aurum-mkt-field-label">Hold for minutes (optional)</span>
              <input
                className="aurum-mkt-input"
                type="number"
                min={1}
                value={minutes}
                onChange={(event) => setMinutes(event.currentTarget.value)}
                placeholder="indefinite"
              />
              <span className="aurum-mkt-hint">
                Empty = an indefinite hold you release manually. Execution-observed failures apply
                their own cooldown automatically.
              </span>
            </label>
            <div className="aurum-mkt-form-actions">
              <button type="submit" className="aurum-btn aurum-btn-danger" disabled={pending}>
                {pending ? 'Working…' : `Hold ${provider} ${model}`}
              </button>
              <StatusLine error={error} summary={summary} pending={pending} />
            </div>
          </form>
        </details>
      )}
      {held ? (
        <span className="aurum-mkt-hint">
          Automatic routing avoids this model until the hold lapses or you release it. A pinned
          request (explicit operator instruction) still overrides the hold.
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hot-swap verification form + result
// ---------------------------------------------------------------------------

interface HotSwapTargetOption {
  value: string;
  label: string;
  accountId: string;
  model: string;
  provider: string;
  scopes: string[];
  classification: string;
}

function hotSwapTargetOptions(accounts: AccountCard[]): HotSwapTargetOption[] {
  const options: HotSwapTargetOption[] = [];
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    for (const model of account.models) {
      if (model.usableCapabilities.length === 0) continue;
      options.push({
        value: `${account.id}|${model.modelId}`,
        label: `${providerLabel(account.provider)} · ${account.label} · ${model.modelId}`,
        accountId: account.id,
        model: model.modelId,
        provider: account.provider,
        scopes: [...account.scopes],
        classification: account.maxDataClassification,
      });
    }
  }
  return options;
}

export function HotSwapForm({ accounts }: { accounts: AccountCard[] }): ReactNode {
  const { pending, error, summary, result, run } = useAiAction();
  const options = useMemo(() => hotSwapTargetOptions(accounts), [accounts]);
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);

  // The target selections are CONTROLLED and self-correcting: the form can
  // mount before any account exists (options empty), so a stale selection
  // falls back to the honest defaults (first target, then the first
  // DIFFERENT one) instead of silently desyncing from the rendered select.
  const targetA =
    selectedA !== null && options.some((option) => option.value === selectedA)
      ? selectedA
      : (options[0]?.value ?? '');
  const targetB =
    selectedB !== null && options.some((option) => option.value === selectedB)
      ? selectedB
      : (options.find((option) => option.value !== targetA)?.value ?? '');

  const accountA = options.find((option) => option.value === targetA) ?? null;
  const accountB = options.find((option) => option.value === targetB) ?? null;
  const suggested = useMemo(
    () =>
      accountA !== null && accountB !== null
        ? suggestedHotSwapParameters(
            {
              scopes: accountA.scopes as LlmScope[],
              maxDataClassification: accountA.classification as DataClassification,
            },
            {
              scopes: accountB.scopes as LlmScope[],
              maxDataClassification: accountB.classification as DataClassification,
            },
          )
        : null,
    [accountA, accountB],
  );

  const sameTarget = targetA !== '' && targetA === targetB;

  async function submit(formData: FormData): Promise<void> {
    if (accountA === null || accountB === null || sameTarget) return;
    const prompt = String(formData.get('prompt') ?? '').trim();
    await run({
      action: 'hotswap.verify',
      targetA: { accountId: accountA.accountId, model: accountA.model },
      targetB: { accountId: accountB.accountId, model: accountB.model },
      capability: String(formData.get('capability') ?? 'text-generation'),
      scope: String(formData.get('scope') ?? suggested?.scope ?? 'analysis'),
      dataClassification: String(
        formData.get('dataClassification') ?? suggested?.dataClassification ?? 'public',
      ),
      ...(prompt === '' ? {} : { prompt }),
    });
  }

  if (options.length < 2) {
    return (
      <div className="aurum-empty">
        <strong>Hot-swap needs two active targets</strong>
        <span className="aurum-empty-hint">
          Add at least two provider accounts (or two models across your active accounts) — the
          same canonical request then runs through both, pinned, without any business-code change.
        </span>
      </div>
    );
  }

  return (
    <form
      className="aurum-mkt-form"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        void submit(formData);
      }}
    >
      <div className="aurum-ai-targets">
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Target A</span>
          <select
            className="aurum-mkt-input"
            name="targetASelect"
            value={targetA}
            onChange={(event) => setSelectedA(event.currentTarget.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Target B</span>
          <select
            className="aurum-mkt-input"
            name="targetBSelect"
            value={targetB}
            onChange={(event) => setSelectedB(event.currentTarget.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sameTarget ? (
        <span className="aurum-mkt-hint" role="alert">
          Pick two DIFFERENT (provider, model) targets — a hot-swap proves the swap by contrast.
        </span>
      ) : null}
      <div className="aurum-ai-targets">
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Capability</span>
          <select className="aurum-mkt-input" name="capability" defaultValue="text-generation">
            <option value="text-generation">{capabilityLabel('text-generation')}</option>
            <option value="embedding">{capabilityLabel('embedding')}</option>
          </select>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Scope</span>
          <select
            className="aurum-mkt-input"
            name="scope"
            key={`scope-${suggested?.scope ?? 'none'}`}
            defaultValue={suggested?.scope ?? 'analysis'}
          >
            {scopeOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="aurum-mkt-hint">
            {suggested === null
              ? 'No scope is permitted by both targets yet.'
              : `Suggested: the first scope both accounts permit (${scopeLabel(suggested.scope)}).`}
          </span>
        </label>
        <label className="aurum-mkt-field">
          <span className="aurum-mkt-field-label">Data classification</span>
          <select
            className="aurum-mkt-input"
            name="dataClassification"
            key={`class-${suggested?.dataClassification ?? 'none'}`}
            defaultValue={suggested?.dataClassification ?? 'public'}
          >
            {classificationOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="aurum-mkt-hint">
            {suggested === null
              ? ''
              : `Suggested: the stricter of the two accounts’ ceilings (${classificationLabel(suggested.dataClassification)}).`}
          </span>
        </label>
      </div>
      <label className="aurum-mkt-field">
        <span className="aurum-mkt-field-label">Prompt (optional)</span>
        <input
          className="aurum-mkt-input"
          name="prompt"
          type="text"
          maxLength={500}
          placeholder="Provider swap verification. Reply with exactly: provider swap verified."
          autoComplete="off"
        />
        <span className="aurum-mkt-hint">
          Both targets execute the SAME canonical request (SHA-256 digest recorded).
        </span>
      </label>
      <div className="aurum-mkt-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending || sameTarget}>
          {pending ? 'Running both targets…' : 'Run hot-swap verification'}
        </button>
        <StatusLine error={error} summary={summary} pending={pending} pendingNote="Running both targets…" />
      </div>
      <HotSwapOutcomeNote result={result} />
    </form>
  );
}

function HotSwapOutcomeNote({ result }: { result: unknown }): ReactNode {
  if (!isHotSwapResult(result)) return null;
  if (result.status === 'awaiting-approval') {
    return (
      <div className="aurum-notice" role="status">
        <strong>Waiting for the human approval gate.</strong> The tenant policy holds llm
        invocations until an authorized principal decides.
        {result.actionRequestId === null ? null : (
          <span style={{ display: 'block', marginTop: 6 }}>
            <Link className="aurum-mkt-link" href="/approvals">
              Decide request {result.actionRequestId.slice(0, 8)} in Approvals (management mode)
            </Link>
          </span>
        )}
      </div>
    );
  }
  const verification = result.verification;
  if (verification === null) return null;
  return (
    <div className="aurum-ai-result aurum-ai-result-ok">
      <strong>{hotSwapOutcomeLabel(verification.outcome)}</strong>
      <span>
        {verification.targetA.provider}/{verification.targetA.model} ↔{' '}
        {verification.targetB.provider}/{verification.targetB.model} · capability{' '}
        {verification.capability} · request digest{' '}
        <code className="aurum-mono">{verification.requestDigest.slice(0, 12)}</code>
      </span>
      <span className="aurum-ai-result-meta">{hotSwapOutcomeExplanation(verification.outcome)}</span>
      <span className="aurum-ai-result-meta">
        Execution A <code className="aurum-mono">{verification.executionAId.slice(0, 8)}</code> ·
        execution B <code className="aurum-mono">{verification.executionBId.slice(0, 8)}</code> ·
        verified {verification.verifiedAt}
      </span>
      <span className="aurum-ai-result-meta">{verification.note}</span>
    </div>
  );
}

function isHotSwapResult(value: unknown): value is HotSwapActionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof (value as { status: unknown }).status === 'string'
  );
}

// ---------------------------------------------------------------------------
// Shared execution-evidence row (the append-only feed)
// ---------------------------------------------------------------------------

export function ExecutionEvidenceLink({
  execution,
}: {
  execution: ExecutionRow;
}): ReactNode {
  return (
    <Link className="aurum-mkt-link" href="/evidence">
      {execution.id.slice(0, 8)}
    </Link>
  );
}
