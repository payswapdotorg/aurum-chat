// Evidence, audit & explainability (W065) — the surface home: the
// reconstructable-decision index.
//
// Journey K's entry problem: "any consequential answer or decision" must
// be reconstructable — but a user cannot be expected to know a uuid. The
// index therefore lists every recent reconstructable decision (decision
// cycles AND action requests, merged newest-first, human-titled by what
// started them) plus the append-only audit trail, each row deep-linking
// into the causal view. Plan §8 gate 10: "Evidence/audit is understandable
// without reading database identifiers."
//
// Read-only composition through module contracts (lock 31/32/34); the
// honest empty state covers a company with no decisions yet; degraded
// reads are noted, never faked.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, PageHead, Panel, StatusPill } from '../components/states';
import { buildEvidenceIndexView } from './lib/views';
import { dateTimeLabel } from './lib/labels';
import { AuditRow } from './components/chain-steps';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Evidence & audit — Aurum',
  description:
    'Explain any consequential answer or decision: the full causal chain from input through evidence, belief, policy, approval, execution and outcome to learning.',
};

export default async function ExplainHomePage() {
  const session = await requireAuthenticatedPage();
  const view = await buildEvidenceIndexView(session.context);

  return (
    <>
      <PageHead
        title="Evidence & audit"
        description="Every consequential answer or decision is reconstructable end to end — input, evidence, beliefs, missions, policy, approval, execution, outcome and learning. Open a decision to walk its causal chain."
        meta={<>Generated {dateTimeLabel(view.generatedAt)}</>}
      />

      <Panel
        title="Reconstructable decisions"
        blurb="The latest decision cycles and action requests, newest first — each one opens its full causal chain: what started it, the evidence it rested on, how the sources scored, what conflicted, which rules applied, who decided, what ran, what came of it, and what was learned."
      >
        {view.decisions.length === 0 ? (
          <EmptyState
            title="No decisions to explain yet"
            hint="When Aurum runs a decision cycle or routes a consequential action through the authority gate, it becomes reconstructable here — nothing is ever summarized away."
          />
        ) : (
          <ul className="aurum-explain-list">
            {view.decisions.map((entry) => (
              <li key={entry.key} className="aurum-explain-row">
                <div className="aurum-explain-row-head">
                  <Link className="aurum-explain-row-title" href={entry.href}>
                    {entry.title}
                  </Link>
                  <StatusPill tone={entry.tone}>{entry.statusLabel}</StatusPill>
                  <span className="aurum-explain-row-meta">{entry.kindLabel}</span>
                </div>
                <p className="aurum-explain-row-text">{entry.subtitle}</p>
                <p className="aurum-explain-row-foot">
                  <Link href={entry.href}>Open the causal chain</Link> · began{' '}
                  {dateTimeLabel(entry.when)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {view.degraded.length === 0 ? null : (
          <p className="aurum-explain-degraded" role="note">
            Some reads were unavailable just now ({view.degraded.join(', ')}) — this index
            may be incomplete.
          </p>
        )}
      </Panel>

      <Panel
        title="The audit trail"
        blurb="The append-only record of consequential events — each entry states where it sits on the causal chain. Audit records are never rewritten; corrections are new records."
      >
        {view.auditEvents.length === 0 ? (
          <EmptyState
            title="No audit events recorded yet"
            hint="Consequential events — policy changes, approvals, executions — are appended here as they happen."
          />
        ) : (
          <ul className="aurum-explain-list">
            {view.auditEvents.map((event) => (
              <AuditRow
                key={event.id}
                event={event.event}
                stageLabel={event.stageLabel}
                summary={event.summary}
                recordedAt={event.recordedAt}
                href={event.href}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="What this view is"
        blurb="The explainability promise the architecture freezes (§24):"
      >
        <ul className="aurum-item-list">
          <li>
            <p className="aurum-item-text">
              <strong>Reconstructable, not summarized</strong> — the chain is assembled
              from the real records of the owning modules, never re-authored.
            </p>
          </li>
          <li>
            <p className="aurum-item-text">
              <strong>Conflicting evidence is retained</strong> — contradictions appear
              with both sides and, once weighed, their resolution.
            </p>
          </li>
          <li>
            <p className="aurum-item-text">
              <strong>Absent links are stated</strong> — a decision still in flight
              reconstructs honestly: its later links show as not-on-this-chain yet.
            </p>
          </li>
          <li>
            <p className="aurum-item-text">
              <strong>AI output is evidence, not authority</strong> — the models and
              providers behind each extraction are part of the chain.
            </p>
          </li>
        </ul>
      </Panel>
    </>
  );
}
