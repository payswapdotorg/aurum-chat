// Provider choice (W091) — "Choose what Aurum optimizes for".
//
// THE WORK ITEM: "Present provider selection as outcomes such as cost,
// privacy, quality, speed or organizational policy. Persist preferences
// and reveal technical details only in advanced settings."
//
// One page, five quiet sections, composed from the provider-preferences
// module's CONTRACT only (the outcome layer over the llm gateway — this
// page is a view, never a second source of truth):
//
//   1. Your choice — the current state (In effect / Saved / Default), the
//      five plain-language options, the mapping guidance notes, and the
//      honest pending-application notice when a member's save awaits an
//      administrator;
//   2. Why this option was used — the plain-language explanation of the
//      latest AI task's FROZEN routing decision (chosen first, one line
//      per other option, honest "we can't explain everything yet" lines);
//   3. Change history — the append-only audit in plain words; technical
//      overrides stay in the advanced view;
//   4. Advanced settings — a disclosure. Members see a plain "ask an
//      administrator" sentence and NO technical data whatsoever;
//      administrators see the accounts table in routing order, the
//      current mapping guidance, the apply button, the technical override
//      forms, and the machine detail of the last AI task.
//
// JARGON RULE (W091 acceptance): sections 1–3 (and the unauthorized
// branch of 4) render NO provider names, model ids, capability codes,
// scope codes or classification enum values — outcomes in plain words
// only. Technical vocabulary appears ONLY inside the authorized advanced
// branch.
//
// Mobile-first, 44px+ targets, real heading hierarchy (the PageHead h1 +
// Panel h2s), the shell's quiet states everywhere, and honest degradation
// notes per read family. Scope comes from the authenticated session
// (W058) — there is no tenant parameter anywhere in this surface.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { allExplanationLines } from '@/modules/provider-preferences/contract';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill, Tag } from '../components/states';
import { buildProviderPreferencesView } from './lib/views';
import {
  PENDING_APPLICATION_NOTE,
  PREFERENCE_OPTIONS_COPY,
  TECHNICAL_CHANGE_PLACEHOLDER,
  accountStatusLabel,
  accountStatusTone,
  ageLabel,
  capabilityLabel,
  classificationLabel,
  formatUsdMinor,
  preferenceLabel,
  preferenceStateLabel,
  preferenceStateTone,
  providerLabel,
  scopeLabel,
} from './lib/labels';
import {
  ApplyPreferenceButton,
  PreferenceChoiceForm,
  TechnicalOverrideForm,
} from './components/controls';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Choose what Aurum optimizes for — Aurum',
  description:
    'Say what matters when Aurum picks AI for you — privacy, cost, speed or reliability — in plain words. Change it any time, and see why each choice was made.',
};

/** The honest lead-in for lines the explanation layer cannot translate. */
const UNEXPLAINED_LEAD = 'We can’t explain everything yet:';

export default async function ProviderPreferencesPage(): Promise<ReactNode> {
  const session = await requireAuthenticatedPage();
  const view = await buildProviderPreferencesView(session.context);
  const nowIso = view.generatedAt;

  const explanationFound =
    view.explanation !== null && view.explanation.found ? view.explanation : null;
  const explanationMissing =
    view.explanation !== null && !view.explanation.found ? view.explanation : null;
  const explainedLines =
    explanationFound === null
      ? []
      : allExplanationLines({
          ...explanationFound.explanation,
          unexplained: [],
        });
  const unexplainedLines = explanationFound?.explanation.unexplained ?? [];

  return (
    <>
      <PageHead
        title="Choose what Aurum optimizes for"
        description="One plain-language choice — privacy, cost, speed, reliability, or your organization’s own settings — decides the order Aurum tries your AI options in. Change it at any time; every change is recorded and explained."
        meta={
          <>
            Generated {nowIso} · {view.changeEventCount} change
            {view.changeEventCount === 1 ? '' : 's'} recorded
          </>
        }
      />

      {/* --------------------------- Your choice ---------------------------- */}

      <Panel
        title="Your choice"
        blurb="What Aurum optimizes for when it picks an AI option for you. Any member of your company can save a choice; an administrator applies it to the routing order."
      >
        <div className="aurum-item-head" style={{ marginBottom: 12 }}>
          <StatusPill tone={preferenceStateTone(view)}>
            {preferenceStateLabel(view)}
          </StatusPill>
          <span className="aurum-meta">{preferenceLabel(view.preference)}</span>
          {view.saved && view.updatedAt !== null ? (
            <span className="aurum-meta">saved {ageLabel(view.updatedAt, nowIso)}</span>
          ) : null}
        </div>
        <PreferenceChoiceForm
          options={PREFERENCE_OPTIONS_COPY}
          current={view.preference}
          disabled={false}
        />
        {view.mappingNotes.length === 0 ? null : (
          <ul className="aurum-item-list" style={{ marginTop: 12 }}>
            {view.mappingNotes.map((note, index) => (
              <li key={index} className="aurum-item-text">
                {note}
              </li>
            ))}
          </ul>
        )}
        {view.pendingApplication ? (
          <div className="aurum-notice" role="note" style={{ marginTop: 12 }}>
            {PENDING_APPLICATION_NOTE}
          </div>
        ) : null}
      </Panel>

      {/* ---------------------- Why this option was used --------------------- */}

      <Panel
        title="Why this option was used"
        blurb="The latest AI task, explained in plain words: which option was used, why, and why the others were not. Explanations come from what was actually recorded — never invented."
      >
        {view.explanation === null ? (
          <EmptyState
            title="The explanation is unavailable right now"
            hint="The AI task read failed just now — nothing is hidden, it could not be read. Try again in a moment."
          />
        ) : explanationFound === null ? (
          <EmptyState
            title={
              explanationMissing?.reason === 'no-executions'
                ? 'No AI task has run yet'
                : 'No AI task matches this address'
            }
            hint={explanationMissing?.note ?? undefined}
          />
        ) : (
          <div>
            <p className="aurum-item-text">{explanationFound.preferenceLine}</p>
            <p className="aurum-meta" style={{ margin: '6px 0 10px' }}>
              AI task from {ageLabel(explanationFound.invokedAt, nowIso)} ·{' '}
              {explanationFound.status === 'completed' ? 'completed' : 'did not complete'}
            </p>
            {explainedLines.length === 0 ? null : (
              <ul className="aurum-item-list">
                {explainedLines.map((line, index) =>
                  line.kind === 'chosen' ? (
                    <li key={index}>
                      <span className="aurum-item-title">{line.text}</span>
                    </li>
                  ) : (
                    <li key={index}>
                      <span className="aurum-item-text">{line.text}</span>
                    </li>
                  ),
                )}
              </ul>
            )}
            {unexplainedLines.length === 0 ? null : (
              <div style={{ marginTop: 10 }}>
                <p className="aurum-item-text">{UNEXPLAINED_LEAD}</p>
                <ul className="aurum-item-list">
                  {unexplainedLines.map((line, index) => (
                    <li key={index}>
                      <span className="aurum-item-text">{line.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* --------------------------- Change history -------------------------- */}

      <Panel
        title="Change history"
        blurb="Every saved choice, every application and every technical change, newest first. Preferences can be changed at any time — the audit keeps the whole story."
        meta={
          <>
            {view.history.length} shown · {view.changeEventCount} total
          </>
        }
      >
        {view.history.length === 0 ? (
          <EmptyState
            title="No changes yet"
            hint="Save your first choice above — it appears here with its reason and its effect."
          />
        ) : (
          <ul className="aurum-item-list">
            {view.history.map((row, index) => (
              <li key={index}>
                <div className="aurum-item-head">
                  <span className="aurum-item-title">{row.eventLabel}</span>
                  <span className="aurum-meta">{ageLabel(row.occurredAt, nowIso)}</span>
                </div>
                <p className="aurum-item-text">
                  {row.technical ? TECHNICAL_CHANGE_PLACEHOLDER : row.summary}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* -------------------------- Advanced settings ------------------------ */}

      <Panel
        title="Advanced settings"
        blurb="Technical settings for administrators: the AI options in routing order, the current mapping guidance, and the machine detail behind the last AI task."
      >
        <details className="aurum-learn-disclose">
          <summary>Advanced settings (technical)</summary>
          {view.advanced === null ? (
            <p className="aurum-item-text">
              Technical settings are for administrators — ask an owner or admin of your company.
            </p>
          ) : (
            <div>
              <h3 className="aurum-mkt-subhead">Your AI options (routing order)</h3>
              {view.advanced.accounts.length === 0 ? (
                <EmptyState
                  title="No AI provider accounts yet"
                  hint="Register provider accounts on the AI providers page first — this choice maps onto them."
                />
              ) : (
                <div role="region" aria-label="AI provider accounts in routing order" tabIndex={0}>
                  <table className="aurum-kbd-table">
                    <caption className="aurum-sr-only">
                      AI provider accounts — routing position, provider, label, priority, status,
                      scopes, capabilities, data policy ceiling and budget
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Provider · label</th>
                        <th scope="col">Priority</th>
                        <th scope="col">Status</th>
                        <th scope="col">Scopes</th>
                        <th scope="col">Capabilities</th>
                        <th scope="col">Ceiling</th>
                        <th scope="col">Budget</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.advanced.accounts.map((account) => (
                        <tr key={account.accountId}>
                          <td>{account.routingPosition}</td>
                          <th scope="row">
                            {providerLabel(account.provider)} · {account.label}
                          </th>
                          <td>{account.priority}</td>
                          <td>
                            <StatusPill tone={accountStatusTone(account.status)}>
                              {accountStatusLabel(account.status)}
                            </StatusPill>
                          </td>
                          <td>{account.scopes.map((scope) => scopeLabel(scope)).join(', ')}</td>
                          <td>
                            {account.capabilities
                              .map((capability) => capabilityLabel(capability))
                              .join(', ')}
                          </td>
                          <td>{classificationLabel(account.maxDataClassification)}</td>
                          <td>
                            {account.budgetMinor === null
                              ? 'no budget'
                              : formatUsdMinor(account.budgetMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {view.advanced.mappings.length === 0 ? null : (
                <div>
                  <h3 className="aurum-mkt-subhead">Current mapping guidance</h3>
                  <ul className="aurum-item-list">
                    {view.advanced.mappings.map((mapping) => (
                      <li key={mapping.accountId}>
                        <div className="aurum-item-head">
                          <span className="aurum-item-title">#{mapping.position}</span>
                          <span className="aurum-meta">
                            routing priority {mapping.assignedPriority}
                          </span>
                          {mapping.evidenceAvailable ? null : <Tag>no evidence</Tag>}
                        </div>
                        <p className="aurum-item-text">{mapping.basis}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {view.advanced.mappingNotes.length === 0 ? null : (
                <ul className="aurum-item-list">
                  {view.advanced.mappingNotes.map((note, index) => (
                    <li key={index} className="aurum-item-text">
                      {note}
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="aurum-mkt-subhead">Apply and override</h3>
              <ApplyPreferenceButton visible />
              <TechnicalOverrideForm accounts={view.advanced.accounts} />

              {explanationFound === null ? null : (
                <div>
                  <h3 className="aurum-mkt-subhead">The last AI task, technically</h3>
                  <p className="aurum-item-text">
                    {explanationFound.technical.pinned
                      ? 'A specific option was pinned for this task.'
                      : 'No pin — your routing order decided.'}{' '}
                    Chosen:{' '}
                    {explanationFound.technical.chosen === null
                      ? 'none (every option was rejected)'
                      : `${providerLabel(explanationFound.technical.chosen.provider)} · ${explanationFound.technical.chosen.model}`}
                    .
                  </p>
                  <ul className="aurum-item-list">
                    {explanationFound.technical.candidates.map((candidate, index) => (
                      <li key={index}>
                        <span className="aurum-item-text">
                          {providerLabel(candidate.provider)} · {candidate.model} —{' '}
                          {candidate.eligible
                            ? 'eligible'
                            : `rejected: ${candidate.reason ?? 'no reason recorded'}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </details>
      </Panel>

      {/* ------------------------- Degraded reads ---------------------------- */}

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/provider-preferences"
        />
      )}
    </>
  );
}
