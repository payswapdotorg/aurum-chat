// AI preferences (W091) — the outcome-oriented preferences surface
// (/ai/preferences).
//
// THE WORK ITEM: "Present provider selection as outcomes such as cost,
// privacy, quality, speed or organizational policy. Persist
// preferences and reveal technical details only in advanced settings."
//
// This is the ORDINARY surface — reachable by every signed-in member,
// speaking outcomes only:
//
//   * WHAT MATTERS — the member's effective priority with its honest
//     attribution (you / your company / company policy / the balanced
//     default);
//   * YOUR CHOICE — the member's own outcome priority (set, change any
//     time, or clear — no jargon, no gate);
//   * YOUR COMPANY'S CHOICE — the company-wide priority and the
//     policy-first posture (editable only by authorized administrators;
//     everyone sees the current state);
//   * WHY THIS OPTION — the recent selection explanations, straight
//     from the module's ORDINARY projection (jargon-free by
//     construction — provider identity never crosses), including the
//     honest "only one option", "nothing was available" and "a spending
//     limit excluded others" cases;
//   * the honest pointer to the ADVANCED settings (technical detail
//     lives there, authorization-gated).
//
// Scope comes from the authenticated session (W058) — there is no
// tenant parameter anywhere in this surface. The page is a server
// component; the interactive controls (client components in
// components/controls.tsx) POST to /api/product/ai/preferences and
// refresh this view.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ProviderPreferenceOutcome } from '@/modules/provider-preferences/contract';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, PageHead, Panel, StatusPill } from '../../components/states';
import { buildPreferencesView } from './lib/views';
import type { ExplanationRow, PreferencesView } from './lib/views';
import {
  ADVANCED_GATE_NOTE,
  ORDINARY_NOTE,
  decisionLabel,
  decisionTone,
  outcomeLabel,
  policyFirstNote,
  preferenceSourceLabel,
} from './lib/labels';
import {
  PersonalPreferenceForm,
  TenantPreferenceForm,
} from './components/controls';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'AI preferences — Aurum',
  description:
    'Choose what matters when Aurum uses AI — cost, data protection, quality or speed — and see why each option was chosen, in plain words.',
};

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function PriorityList({ priority }: { priority: readonly ProviderPreferenceOutcome[] }): ReactNode {
  return (
    <ol className="aurum-pref-order" aria-label="Outcome priority">
      {priority.map((outcome, index) => (
        <li key={outcome}>
          <span className="aurum-pref-rank">{index + 1}</span>
          <span className="aurum-pref-outcome">{outcomeLabel(outcome)}</span>
          {index === 0 ? <span className="aurum-pref-first-tag">what matters most</span> : null}
        </li>
      ))}
    </ol>
  );
}

function WhyRow({ entry }: { entry: ExplanationRow }): ReactNode {
  return (
    <li className="aurum-pref-why">
      <div className="aurum-pref-why-head">
        <StatusPill tone={decisionTone(entry.decision)}>{decisionLabel(entry.decision)}</StatusPill>
        <span className="aurum-pref-why-capability">{entry.capabilityLabel}</span>
        <span className="aurum-pref-why-age">{entry.ageLabel}</span>
      </div>
      <p className="aurum-pref-why-text">{entry.explanation}</p>
      <p className="aurum-pref-why-meta">
        {entry.decidingOutcomeLabel === null
          ? `${entry.candidatesConsidered} option${
              entry.candidatesConsidered === 1 ? '' : 's'
            } considered`
          : `won on ${entry.decidingOutcomeLabel.toLowerCase()} · ${entry.candidatesConsidered} option${
              entry.candidatesConsidered === 1 ? '' : 's'
            } considered`}
        {entry.budgetExcludedCount > 0
          ? ` · a spending limit excluded ${entry.budgetExcludedCount} other${
              entry.budgetExcludedCount === 1 ? '' : 's'
            }`
          : ''}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function AiPreferencesPage(): Promise<ReactNode> {
  const session = await requireAuthenticatedPage();
  const view: PreferencesView = await buildPreferencesView(session.context);

  return (
    <>
      <PageHead
        title="AI preferences"
        description="Choose what matters when Aurum uses AI — cost, data protection, quality or speed. Change your mind any time."
        meta={
          <span>
            <Link className="aurum-quiet-link" href="/ai">
              Manage AI accounts
            </Link>
            {' · '}
            <Link className="aurum-quiet-link" href="/ai/preferences/advanced">
              Advanced settings
            </Link>
          </span>
        }
      />

      <Panel title="What matters when Aurum uses AI" blurb={ORDINARY_NOTE}>
        <div className="aurum-pref-resolved">
          <StatusPill tone={view.resolved.source === 'default' ? 'info' : 'positive'}>
            {preferenceSourceLabel(view.resolved.source)}
          </StatusPill>
          <PriorityList priority={view.resolved.outcomePriority} />
          <p className="aurum-pref-note">{policyFirstNote(view.resolved.policyFirst)}</p>
        </div>
      </Panel>

      <Panel
        title="Your choice"
        blurb="Your own priority applies to your interactions whenever company policy lets it. You can change it or clear it at any time — nothing here needs technical words."
      >
        <PersonalPreferenceForm
          current={view.personal === null ? null : view.personal.outcomePriority}
        />
      </Panel>

      <Panel
        title="Your company's choice"
        blurb={
          view.tenant === null
            ? 'No company-wide priority is set yet — members’ own choices (or the balanced default) apply.'
            : 'The company-wide priority everyone without their own choice uses.'
        }
      >
        {view.tenant === null ? (
          <EmptyState
            title="Nothing is set company-wide"
            hint={
              view.canAdminister
                ? 'Set the company priority below — it becomes what anyone without their own choice uses.'
                : 'An administrator of your company can set this.'
            }
          />
        ) : (
          <div className="aurum-pref-tenant">
            <PriorityList priority={view.tenant.outcomePriority} />
            <p className="aurum-pref-note">
              {view.tenant.policyFirst
                ? 'Company policy decides how AI options are chosen.'
                : 'Members’ own priorities lead where they have one; this is the fallback.'}
            </p>
          </div>
        )}
        {view.canAdminister ? (
          <TenantPreferenceForm
            current={view.tenant?.outcomePriority ?? view.resolved.outcomePriority}
            policyFirst={view.tenant?.policyFirst ?? false}
          />
        ) : (
          <p className="aurum-pref-note">Only administrators of your company can change this.</p>
        )}
      </Panel>

      <Panel
        title="Why this option?"
        blurb="Every time Aurum picks among AI options, it records why — in your words, not technical ones. This is that record."
      >
        {view.recentExplanations.length === 0 ? (
          <EmptyState
            title="No choices recorded yet"
            hint="When Aurum next picks among AI options for you, the reason appears here — which priority drove it, or the honest note that only one option existed."
          />
        ) : (
          <ul className="aurum-pref-why-list">
            {view.recentExplanations.map((entry) => (
              <WhyRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Technical detail" blurb={ADVANCED_GATE_NOTE}>
        <p className="aurum-pref-note">
          Authorized administrators can{' '}
          <Link className="aurum-quiet-link" href="/ai/preferences/advanced">
            open the advanced settings
          </Link>{' '}
          to see which specific AI option was used, pin a route to a chosen provider, and review
          every recorded choice with its technical detail. Everything there is reversible and
          audited.
        </p>
      </Panel>
    </>
  );
}
