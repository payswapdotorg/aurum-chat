// AI/BYOA & Provider Routing UX (W066) — the AI-providers surface (/ai).
//
// THE WORK ITEM: "Build AI provider account management and routing
// interface." One management surface composes Journey H end to end from
// the llm module's CONTRACT only (lock 28: AI/LLM providers are accessed
// only through the LLM Gateway; locks 31/32 — this page is a view, never
// a second source of truth):
//
//   * provider ACCOUNTS — add (BYOA registration), verify (a pinned
//     connection test through the canonical gateway path), revoke (disable
//     routing, evidence retained), restore, and the full policy/routing
//     configuration (scopes, capabilities, data-policy ceiling, priority,
//     budget, credential rotation);
//   * MODEL AVAILABILITY — the current per-(account, model) states with
//     manual holds/releases (execution-observed cooldowns arrive as
//     append-only events on their own);
//   * ROUTING — the tenant's own priority order, rendered as the routing
//     order it is, with the no-privileged-provider note (lock 30) said
//     out loud: preference is tenant-owned, registry position never
//     participates;
//   * COST & LATENCY — per (provider, model, capability) usage aggregates,
//     per-account budget posture, and the append-only execution evidence;
//   * HOT-SWAP TEST — the same canonical request through two pinned
//     (provider, model) targets with the deterministic comparison
//     (equivalent / completed-divergent / failed), plus the deep-linkable
//     verification record (?verification=<id>).
//
// Mobile-first, 44px+ targets, real heading hierarchy, the shell's quiet
// states everywhere (EmptyState/ErrorState/StatusPill), progressive
// disclosure for configuration, and honest degradation notes per read
// family. Scope comes from the authenticated session (W058) — there is
// no tenant parameter anywhere in this surface.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { getHotSwapVerification } from '@/modules/llm/contract';
import type { LlmHotSwapVerification } from '@/modules/llm/contract';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../components/states';
import { buildByoaView } from './lib/views';
import type { AccountCard, ByoaView, ExecutionRow } from './lib/views';
import {
  ACCOUNT_TEST_PROMPT,
  CREDENTIAL_NOTE,
  NO_PRIVILEGED_PROVIDER_NOTE,
  REVOKE_NOTE,
  accountStatusLabel,
  accountStatusTone,
  ageLabel,
  availabilityLabel,
  availabilityTone,
  capabilityLabel,
  classificationLabel,
  executionPurposeLabel,
  executionStatusTone,
  formatLatency,
  formatPricePerMillion,
  formatTokens,
  formatUsdMinor,
  hotSwapOutcomeExplanation,
  hotSwapOutcomeLabel,
  hotSwapOutcomeTone,
  providerLabel,
  scopeLabel,
} from './lib/labels';
import {
  AccountControls,
  AddAccountForm,
  AvailabilityControl,
  HotSwapForm,
} from './components/controls';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'AI providers — Aurum',
  description:
    'Bring your own AI accounts: provider accounts, model availability, routing policy, cost and latency, and provider hot-swap verification.',
};

/** First non-empty value of a possibly-array query parameter. */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function BudgetPosture({ account }: { account: AccountCard }): ReactNode {
  if (account.spend === null) {
    return <span>spend this month unknown (read degraded)</span>;
  }
  const spend = formatUsdMinor(account.spend.spendMinor);
  if (account.budgetMinor === null) {
    return (
      <span>
        no budget · {spend} spent this month ({account.spend.executions} completed executions)
      </span>
    );
  }
  const percent =
    account.spend.spendMinor === 0
      ? 0
      : Math.min(100, Math.round((account.spend.spendMinor / account.budgetMinor) * 100));
  return (
    <span>
      budget {formatUsdMinor(account.budgetMinor)} · {spend} spent this month ({percent}%) ·{' '}
      {account.spend.executions} completed executions
      {percent >= 100 ? ' — budget exhausted, routing rejects' : ''}
    </span>
  );
}

function ModelRows({ account, nowIso }: { account: AccountCard; nowIso: string }): ReactNode {
  if (account.models.length === 0) {
    return <p className="aurum-ai-model-none">The registry carries no models for this provider.</p>;
  }
  return (
    <ul className="aurum-ai-models">
      {account.models.map((model) => {
        const state = model.availability?.state ?? 'available';
        const held = state === 'unavailable';
        return (
          <li className="aurum-ai-model" key={model.modelId}>
            <div className="aurum-ai-model-head">
              <code className="aurum-mono">{model.modelId}</code>
              {model.usableCapabilities.length === 0 ? (
                <StatusPill tone="warning">no permitted capability</StatusPill>
              ) : null}
              <StatusPill tone={availabilityTone(state)}>{availabilityLabel(state)}</StatusPill>
            </div>
            <p className="aurum-ai-model-meta">
              {model.capabilities.map((capability) => capabilityLabel(capability)).join(' · ')}
              {model.usableCapabilities.length === 0
                ? ' — the account permits none of them (routing always rejects)'
                : ''}
              {model.availability === null
                ? ''
                : ` · ${model.availability.source} source${
                    model.availability.reason === null ? '' : `: ${model.availability.reason}`
                  }${held && model.availability.expiresAt !== null ? ` · until ${model.availability.expiresAt}` : ''}`}
              {model.availability === null ? '' : ` · observed ${ageLabel(model.availability.observedAt, nowIso)}`}
            </p>
            <AvailabilityControl
              accountId={account.id}
              provider={account.provider}
              model={model.modelId}
              held={held}
            />
          </li>
        );
      })}
    </ul>
  );
}

function AccountCardView({ account, nowIso }: { account: AccountCard; nowIso: string }): ReactNode {
  return (
    <li className="aurum-ai-account">
      <div className="aurum-ai-account-head">
        <span className="aurum-ai-account-title">{account.label}</span>
        <StatusPill tone={accountStatusTone(account.status)}>
          {accountStatusLabel(account.status)}
        </StatusPill>
        <span className="aurum-pill aurum-pill-neutral aurum-ai-provider-tag">
          {providerLabel(account.provider)}
        </span>
        <span className="aurum-ai-routing-position">
          routes #{account.routingPosition} · priority {account.priority}
        </span>
      </div>
      <p className="aurum-ai-account-meta">
        {account.scopes.map((scope) => scopeLabel(scope)).join(' · ')} ·{' '}
        {account.capabilities.map((capability) => capabilityLabel(capability)).join(' · ')} ·
        ceiling {classificationLabel(account.maxDataClassification)} · <BudgetPosture account={account} />
      </p>
      <p className="aurum-ai-account-meta aurum-ai-account-meta-sub">
        credential <code className="aurum-mono">{account.credentialRef}</code> · added{' '}
        {ageLabel(account.createdAt, nowIso)} · configuration updated{' '}
        {ageLabel(account.updatedAt, nowIso)}
        {account.lastExecutionAt === null
          ? ' · no executions yet'
          : ` · last execution ${ageLabel(account.lastExecutionAt, nowIso)}`}
      </p>
      <ModelRows account={account} nowIso={nowIso} />
      <AccountControls account={account} />
    </li>
  );
}

function UsageTable({ view }: { view: ByoaView }): ReactNode {
  if (view.usage.length === 0) {
    return (
      <EmptyState
        title="No usage recorded yet"
        hint="Every gateway execution — completed or failed — lands here as evidence with its deterministic cost and measured latency."
      />
    );
  }
  return (
    <div className="aurum-ai-table-wrap" role="region" aria-label="Usage by provider, model and capability" tabIndex={0}>
      <table className="aurum-ai-table">
        <caption className="aurum-sr-only">
          Usage aggregates per provider, model and capability — executions, tokens, cost, latency
        </caption>
        <thead>
          <tr>
            <th scope="col">Provider · model</th>
            <th scope="col">Capability</th>
            <th scope="col">Executions</th>
            <th scope="col">Tokens (in / out)</th>
            <th scope="col">Cost</th>
            <th scope="col">Latency (avg / max)</th>
          </tr>
        </thead>
        <tbody>
          {view.usage.map((row) => (
            <tr key={`${row.provider}-${row.model}-${row.capability}`}>
              <th scope="row">
                {providerLabel(row.provider)} · <code className="aurum-mono">{row.model}</code>
              </th>
              <td>{capabilityLabel(row.capability)}</td>
              <td>
                {row.executions} ({row.completed} ok / {row.failed} failed)
              </td>
              <td>
                {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
              </td>
              <td>{formatUsdMinor(row.costMinor)}</td>
              <td>
                {formatLatency(row.avgLatencyMs)} / {formatLatency(row.maxLatencyMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExecutionRowView({ execution, nowIso }: { execution: ExecutionRow; nowIso: string }): ReactNode {
  return (
    <li className="aurum-ai-execution">
      <div className="aurum-ai-execution-head">
        <StatusPill tone={executionStatusTone(execution.status)}>{execution.status}</StatusPill>
        <span className="aurum-ai-execution-title">
          {providerLabel(execution.provider)} · <code className="aurum-mono">{execution.model}</code>
        </span>
        <span className="aurum-ai-execution-kind">
          {executionPurposeLabel(execution.purpose)} · {capabilityLabel(execution.capability)}
        </span>
      </div>
      <p className="aurum-ai-execution-meta">
        {formatLatency(execution.latencyMs)} · {formatUsdMinor(execution.costMinor)} ·{' '}
        {ageLabel(execution.invokedAt, nowIso)} · execution{' '}
        <code className="aurum-mono">{execution.id.slice(0, 8)}</code>
        {execution.errorCode === null
          ? ''
          : ` · failed with ${execution.errorCode}`}
      </p>
    </li>
  );
}

function CatalogSection({ view }: { view: ByoaView }): ReactNode {
  return (
    <div className="aurum-ai-catalog">
      {view.catalog.map((entry) => (
        <div className="aurum-ai-catalog-provider" key={entry.provider}>
          <h3 className="aurum-ai-catalog-name">{providerLabel(entry.provider)}</h3>
          <ul className="aurum-ai-catalog-models">
            {entry.models.map((model) => (
              <li key={model.modelId}>
                <span className="aurum-ai-catalog-model-head">
                  <code className="aurum-mono">{model.modelId}</code>
                  {model.capabilities.map((capability) => (
                    <StatusPill key={capability} tone="info">
                      {capabilityLabel(capability)}
                    </StatusPill>
                  ))}
                </span>
                <span className="aurum-ai-catalog-model-meta">
                  context {formatTokens(model.contextWindowTokens)} · output cap{' '}
                  {formatTokens(model.maxOutputTokens)} · in{' '}
                  {formatPricePerMillion(model.priceInputMinorPerMillion)} · out{' '}
                  {formatPricePerMillion(model.priceOutputMinorPerMillion)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function VerificationDetail({ verification }: { verification: LlmHotSwapVerification }): ReactNode {
  return (
    <div className="aurum-ai-result aurum-ai-result-ok aurum-ai-verification-detail">
      <div className="aurum-ai-account-head">
        <StatusPill tone={hotSwapOutcomeTone(verification.outcome)}>
          {hotSwapOutcomeLabel(verification.outcome)}
        </StatusPill>
        <span className="aurum-ai-execution-title">
          {providerLabel(verification.targetA.provider)}/{verification.targetA.model} ↔{' '}
          {providerLabel(verification.targetB.provider)}/{verification.targetB.model}
        </span>
      </div>
      <span>
        capability {capabilityLabel(verification.capability)} · requested by{' '}
        <code className="aurum-mono">{verification.requestedBy.slice(0, 8)}</code> · verified{' '}
        {verification.verifiedAt}
      </span>
      <span className="aurum-ai-result-meta">
        Same canonical request on both targets — SHA-256 digest{' '}
        <code className="aurum-mono">{verification.requestDigest.slice(0, 16)}</code>
      </span>
      <span className="aurum-ai-result-meta">
        Execution A <code className="aurum-mono">{verification.executionAId.slice(0, 8)}</code> ·
        execution B <code className="aurum-mono">{verification.executionBId.slice(0, 8)}</code>
      </span>
      <span className="aurum-ai-result-meta">{verification.note}</span>
      <span className="aurum-ai-result-meta">{hotSwapOutcomeExplanation(verification.outcome)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function AiProvidersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireAuthenticatedPage();
  const view = await buildByoaView(session.context);
  const nowIso = view.generatedAt;

  // The optional deep link to one hot-swap verification record (?verification=).
  const verificationId = firstValue(params['verification']);
  let verification: LlmHotSwapVerification | null = null;
  let verificationError: string | null = null;
  if (verificationId !== null) {
    try {
      verification = await getHotSwapVerification(session.context, {
        verificationId,
      });
    } catch {
      // Uniform not-found: a missing OR foreign-tenant id is the same state.
      verificationError = verificationId;
    }
  }

  const activeAccounts = view.accounts.filter((account) => account.status === 'active');

  return (
    <>
      <PageHead
        title="AI providers"
        description="Your own AI accounts — bring the keys, keep the control. Aurum routes to them through one provider-neutral gateway: no provider is privileged, every execution is evidence, and a hot-swap is provable."
        meta={<>Generated {nowIso} · {activeAccounts.length} active account{activeAccounts.length === 1 ? '' : 's'} in routing order</>}
      />

      {view.canAdminister ? null : (
        <div className="aurum-notice" role="note">
          <strong>View-only.</strong> Managing AI provider accounts (adding, configuring, revoking,
          availability holds, hot-swap runs) requires the <code className="aurum-mono">llm:administer</code>{' '}
          authority — your role in this company carries reads only. Ask an owner or admin.
        </div>
      )}

      {view.transportWired ? null : (
        <div className="aurum-notice" role="note">
          <strong>No provider transport is wired in this environment.</strong> Connection tests and
          hot-swap runs will fail honestly with <code className="aurum-mono">provider_unavailable</code> —
          accounts, routing, policy and recorded evidence remain fully manageable. The transport is
          infrastructure wiring (setLlmTransport at process start), never domain state.
        </div>
      )}

      {/* ------------------------------ Accounts ----------------------------- */}

      <Panel
        title="Provider accounts"
        blurb="Tenant-owned AI accounts. Adding one registers an opaque credential reference and the routing constraints you choose; revoking stops routing while the record, evidence and spend history stay intact."
        meta={<>{view.accounts.length} account{view.accounts.length === 1 ? '' : 's'}</>}
      >
        {view.accounts.length === 0 ? (
          <EmptyState
            title="No AI provider accounts yet"
            hint="Add your first account below — an opaque secret-store reference, the scopes and capabilities you permit, a data-policy ceiling, a routing priority and an optional monthly budget."
          />
        ) : (
          <ul className="aurum-ai-accounts">
            {view.accounts.map((account) => (
              <AccountCardView key={account.id} account={account} nowIso={nowIso} />
            ))}
          </ul>
        )}
        <AddAccountForm catalog={view.catalog} />
      </Panel>

      {/* --------------------------- Routing & policy ------------------------ */}

      <Panel
        title="Routing & policy"
        blurb="What the gateway considers, in order, for every request — and the order your accounts are tried in. Preference lives here, in your priority numbers, nowhere else."
      >
        {view.accounts.length === 0 ? (
          <EmptyState
            title="No routing yet"
            hint="Routing needs at least one active account. Among eligible (account, model) pairs, lower priority is preferred; ties break by account age, then id."
          />
        ) : (
          <ol className="aurum-ai-routing-order">
            {view.accounts.map((account) => (
              <li key={account.id} data-active={account.status === 'active'}>
                <span className="aurum-ai-routing-position">#{account.routingPosition}</span>
                <span className="aurum-ai-routing-label">
                  {providerLabel(account.provider)} · {account.label}
                </span>
                <StatusPill tone={accountStatusTone(account.status)}>
                  {accountStatusLabel(account.status)}
                </StatusPill>
                <span className="aurum-ai-routing-meta">
                  priority {account.priority} · {account.scopes.map((scope) => scopeLabel(scope)).join('/')} ·{' '}
                  {account.capabilities.map((capability) => capabilityLabel(capability)).join('/')} ·
                  ceiling {classificationLabel(account.maxDataClassification)}
                </span>
              </li>
            ))}
          </ol>
        )}
        <ul className="aurum-ai-notes">
          <li>{NO_PRIVILEGED_PROVIDER_NOTE}</li>
          <li>
            Eligibility, in check order: account status → scope → capability permission → data-policy
            ceiling → budget → model capability support → output cap → availability. Every candidate
            and its machine-readable verdict is frozen onto each execution as evidence.
          </li>
          <li>{CREDENTIAL_NOTE}</li>
          <li>{REVOKE_NOTE}</li>
        </ul>
      </Panel>

      {/* ----------------------------- Model catalog ------------------------- */}

      <Panel
        title="Model catalog (the registry)"
        blurb="The platform's canonical provider/model reference data — capabilities, windows, output caps and list prices that feed deterministic cost accounting. It versions with the adapter set; tenants never mutate it, and it confers no routing privilege. Listed alphabetically."
      >
        <CatalogSection view={view} />
      </Panel>

      {/* ----------------------------- Cost & latency ------------------------ */}

      <Panel
        title="Cost & latency"
        blurb="Deterministic cost in integer minor units from recorded evidence, and measured latency — per provider, model and capability; plus the append-only execution feed behind them."
      >
        <UsageTable view={view} />
        {view.executions.length === 0 ? null : (
          <details className="aurum-learn-disclose" style={{ marginTop: 12 }}>
            <summary>Recent execution evidence ({view.executions.length})</summary>
            <ul className="aurum-ai-executions">
              {view.executions.map((execution) => (
                <ExecutionRowView key={execution.id} execution={execution} nowIso={nowIso} />
              ))}
            </ul>
          </details>
        )}
      </Panel>

      {/* ------------------------------ Hot-swap ----------------------------- */}

      <Panel
        title="Hot-swap verification"
        blurb="Prove a provider swap without touching business semantics: the SAME canonical request runs through two pinned (provider, model) targets, and the deterministic comparison is recorded — equivalent, completed-divergent, or failed. Divergent output still proves the swap (same contract, same request); semantic judgment stays with you."
      >
        <p className="aurum-ai-test-note">
          Connection tests send a fixed public prompt (“{ACCOUNT_TEST_PROMPT}”); hot-swap runs use
          the canonical prompt unless you write your own.
        </p>
        <HotSwapForm accounts={view.accounts} />
        {verificationError === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 12 }}>
            <strong>No verification at this address</strong>
            <span>
              The id <code className="aurum-mono">{verificationError.slice(0, 8)}</code> matches no
              hot-swap verification in this company — missing and foreign ids are indistinguishable
              by design.
            </span>
          </div>
        )}
        {verification === null ? null : (
          <div style={{ marginTop: 12 }}>
            <h3 className="aurum-ai-subhead">Verification record</h3>
            <VerificationDetail verification={verification} />
          </div>
        )}
        {view.hotSwapExecutions.length === 0 ? (
          <EmptyState
            title="No hot-swap runs recorded yet"
            hint="Each run records two pinned executions (plus the comparison record) as append-only evidence — they appear here."
          />
        ) : (
          <details className="aurum-learn-disclose" style={{ marginTop: 12 }} open>
            <summary>Hot-swap evidence ({view.hotSwapExecutions.length} executions)</summary>
            <ul className="aurum-ai-executions">
              {view.hotSwapExecutions.map((execution) => (
                <ExecutionRowView key={execution.id} execution={execution} nowIso={nowIso} />
              ))}
            </ul>
          </details>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/ai"
        />
      )}
    </>
  );
}
