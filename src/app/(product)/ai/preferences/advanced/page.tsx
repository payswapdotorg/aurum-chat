// AI preferences (W091) — the ADVANCED settings surface
// (/ai/preferences/advanced).
//
// This is the ONE place technical identity appears in the preferences
// experience: the authorization-gated area for advanced users carrying
// the 'provider-preferences:administer' claim. The page composes the
// provider-preferences module's claim-gated reads (the technical
// override rows, the FULL explanation records via ?explanation=<id>)
// plus the llm module's registry and BYOA account reads (the technical
// provider details) — the same multi-contract composition discipline
// the connections hub follows.
//
//   * TECHNICAL PROVIDER DETAILS — the llm registry's providers and
//     models (count, cheapest list price) and the tenant's BYOA
//     accounts on each;
//   * TECHNICAL OVERRIDES — the pin/clear controls: pin a provider on
//     one AI route with a REQUIRED reason, clear a pin (reversible —
//     setting it again re-activates the route), every change on the
//     append-only audit feed;
//   * SELECTION RECORDS (TECHNICAL) — the deep-linked FULL explanation
//     record: which provider was chosen, on which gateway route, with
//     the same user-language explanation the ordinary surface shows.
//
// A session WITHOUT the claim still renders the page — as an honest
// gate notice (not a redirect, not an error page): the advanced area
// says who can open it and links back to the ordinary surface. The
// e2e journey renders this page as the manager persona (an owner —
// authorized) and the member path is covered by the surface's own
// integration tests.
//
// Scope comes from the authenticated session (W058); the page is a
// server component; the client controls POST to
// /api/product/ai/preferences and refresh this view.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { buildAdvancedView, OVERRIDE_CAPABILITY_OPTIONS } from '../lib/views';
import type { AdvancedView, OverrideRow } from '../lib/views';
import { ageLabel, capabilityLabel, decisionLabel, decisionTone } from '../lib/labels';
import { OverrideClearButton, OverrideForm } from '../components/controls';
import { listLlmProviders } from '@/modules/llm/contract';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Advanced AI settings — Aurum',
  description:
    'Authorized advanced settings: technical provider details, reversible provider pins, and the technical record of every AI choice.',
};

/** First non-empty value of a possibly-array query parameter. */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function ProviderRow({
  provider,
  models,
  minPrice,
  accounts,
}: {
  provider: string;
  models: number;
  minPrice: number | null;
  accounts: { id: string; label: string; status: string; priority: number }[];
}): ReactNode {
  return (
    <li className="aurum-pref-provider">
      <div className="aurum-pref-provider-head">
        <code className="aurum-mono">{provider}</code>
        <StatusPill tone={accounts.some((account) => account.status === 'active') ? 'positive' : 'info'}>
          {accounts.length === 0
            ? 'no account connected'
            : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
        </StatusPill>
      </div>
      <p className="aurum-pref-provider-meta">
        {models} model{models === 1 ? '' : 's'} in the registry
        {minPrice === null ? '' : ` · from ${(minPrice / 100).toFixed(2)} USD per million input tokens`}
      </p>
      {accounts.length === 0 ? null : (
        <ul className="aurum-pref-accounts">
          {accounts.map((account) => (
            <li key={account.id}>
              <code className="aurum-mono">{account.id.slice(0, 8)}</code> {account.label} ·{' '}
              {account.status} · routing priority {account.priority}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function OverrideRowView({ override }: { override: OverrideRow }): ReactNode {
  return (
    <li className="aurum-pref-override">
      <div className="aurum-pref-override-head">
        <code className="aurum-mono">{override.provider}</code>
        <span className="aurum-pref-override-scope">
          {override.gateway}
          {override.capability === null ? ' · all AI work' : ` · ${override.capability}`}
        </span>
        <StatusPill tone={override.status === 'active' ? 'info' : 'positive'}>
          {override.status === 'active' ? 'pinned' : 'cleared (reversible)'}
        </StatusPill>
        {override.status === 'active' ? (
          <OverrideClearButton capability={override.capability} />
        ) : null}
      </div>
      <p className="aurum-pref-override-reason">{override.reason}</p>
      <p className="aurum-pref-override-meta">
        set by <code className="aurum-mono">{override.setBy.slice(0, 8)}</code> ·{' '}
        {override.retiredAt === null
          ? 'currently in force'
          : 'no longer in force — the preference policy chooses'}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function AiPreferencesAdvancedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const session = await requireAuthenticatedPage();
  const explanationId = firstValue(params.explanation);
  const view: AdvancedView = await buildAdvancedView(session.context, explanationId);
  const providers = view.authorized ? await listLlmProviders() : [];

  return (
    <>
      <PageHead
        title="Advanced AI settings"
        description="The technical layer behind AI preferences: provider details, reversible pins, and the full record of every choice."
        meta={
          <span>
            <Link className="aurum-quiet-link" href="/ai/preferences">
              Back to AI preferences
            </Link>
            {' · '}
            <Link className="aurum-quiet-link" href="/ai">
              Manage AI accounts
            </Link>
          </span>
        }
      />

      {view.authorized ? (
        <>
          <Panel
            title="Technical provider details"
            blurb="The gateway's provider catalog and your company's connected accounts. This is the only preferences surface that names providers — that is what advanced means here."
          >
            <ul className="aurum-pref-providers">
              {view.providers.map((row) => (
                <ProviderRow
                  key={row.provider}
                  provider={row.provider}
                  models={row.models}
                  minPrice={row.minInputPriceMinorPerMillion}
                  accounts={row.accounts}
                />
              ))}
            </ul>
          </Panel>

          <Panel
            title="Technical overrides (pins)"
            blurb="Pin one provider on one AI route when there is a concrete technical reason. Every pin requires its reason, lands on the audit feed, and stays reversible — clearing it returns the route to the preference policy."
          >
            <OverrideForm providers={providers} capabilities={OVERRIDE_CAPABILITY_OPTIONS} />
            {view.overrides.length === 0 ? (
              <EmptyState
                title="No pins are set"
                hint="Routing follows the outcome preferences. A pin overrides them for one route only, and only until it is cleared."
              />
            ) : (
              <ul className="aurum-pref-overrides">
                {view.overrides.map((override) => (
                  <OverrideRowView key={override.id} override={override} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Selection records (technical)"
            blurb="The full record of the choices Aurum made — the provider identity behind each, on which gateway route, with the same plain-language explanation everyone sees."
          >
            {view.explanationMissing ? (
              <ErrorState
                title="No such record"
                detail="That record id does not resolve in your company. It may never have existed, or it belongs to another company — the answer is the same on purpose."
                retryHref="/ai/preferences"
                retryLabel="Back to AI preferences"
              />
            ) : view.explanationDetail === null ? (
              <EmptyState
                title="Open a record from the preferences page"
                hint="Every entry in the “Why this option?” feed links here with its technical detail: the chosen provider, the route, and the decision trail."
              />
            ) : (
              <div className="aurum-pref-record">
                <div className="aurum-pref-record-head">
                  <StatusPill tone={decisionTone(view.explanationDetail.decision)}>
                    {decisionLabel(view.explanationDetail.decision)}
                  </StatusPill>
                  <code className="aurum-mono">{view.explanationDetail.id.slice(0, 8)}</code>
                </div>
                <dl className="aurum-pref-record-facts">
                  <div>
                    <dt>Gateway route</dt>
                    <dd>
                      <code className="aurum-mono">
                        {view.explanationDetail.gateway} · {view.explanationDetail.capability}
                      </code>{' '}
                      ({capabilityLabel(view.explanationDetail.capability)})
                    </dd>
                  </div>
                  <div>
                    <dt>Chosen provider</dt>
                    <dd>
                      {view.explanationDetail.chosenProvider === null ? (
                        '— nothing was available —'
                      ) : (
                        <code className="aurum-mono">{view.explanationDetail.chosenProvider}</code>
                      )}
                      {view.explanationDetail.chosenAccountRef === null ? null : (
                        <>
                          {' '}
                          via <code className="aurum-mono">{view.explanationDetail.chosenAccountRef}</code>
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Candidates considered</dt>
                    <dd>
                      {view.explanationDetail.candidatesConsidered}
                      {view.explanationDetail.budgetExcludedCount > 0
                        ? ` (a spending limit excluded ${view.explanationDetail.budgetExcludedCount})`
                        : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Recorded</dt>
                    <dd>
                      {ageLabel(view.explanationDetail.occurredAt, view.generatedAt)} by{' '}
                      <code className="aurum-mono">
                        {view.explanationDetail.recordedBy.slice(0, 8)}
                      </code>
                    </dd>
                  </div>
                </dl>
                <p className="aurum-pref-why-text">{view.explanationDetail.explanation}</p>
              </div>
            )}
          </Panel>
        </>
      ) : (
        <Panel
          title="Authorized area"
          blurb="Advanced AI settings show technical detail — which specific AI option is used, and the pins that can override the preference policy. That detail is restricted to administrators of your company."
        >
          <EmptyState
            title="You are not authorized to open the advanced settings"
            hint="Your company's administrators carry the provider-preferences permission. Everything you need as a member is on the AI preferences page — outcomes, your priority, and every “why this option?” record."
          />
          <div className="aurum-mkt-form-actions">
            <Link className="aurum-btn" data-variant="quiet" href="/ai/preferences">
              Back to AI preferences
            </Link>
          </div>
        </Panel>
      )}
    </>
  );
}
