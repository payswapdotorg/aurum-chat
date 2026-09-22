// Intelligence discovery (W061) — the unknown detail page (chain step 3).
//
// One first-class unknown in full: the question Aurum cannot answer, the
// recorded consequence (the "why this matters" of the work item — always
// visible), the missions closing it ("what Aurum needs next" — the
// confidence progress), the goal it serves (the chain upward), the
// bounding evidence/claims/beliefs, and the resolution that closed the
// gap when one exists. Every element drills into the next chain step.
//
// Read-only composition through module contracts; a foreign/missing id
// renders the honest not-found state (uniform unknown_not_found).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { ChatReturnLink, chatReturnFromSearchParams } from '../../../chat/components/chat-return-link';
import { buildUnknownView } from '../../lib/views';
import type { UnknownView } from '../../lib/views';
import {
  BeliefRow,
  ChainEmpty,
  ChainRail,
  EvidenceRow,
  MissionLinkRow,
  WhyNextBlock,
} from '../../components/chain-ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Unknown — Aurum Intelligence',
  description:
    'One consequential unknown: why it matters, the missions closing it, and the evidence beneath.',
};

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function UnknownPage({
  params,
  searchParams,
}: {
  params: Promise<{ unknownId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { unknownId } = await params;
  // W072 — the guarded return link when this step was opened from a
  // chat card or a chain hop (`?back=/chat?c=…`).
  const back = chatReturnFromSearchParams(await searchParams);
  const session = await requireAuthenticatedPage();

  let view: UnknownView;
  try {
    view = await buildUnknownView(session.context, unknownId);
  } catch {
    notFound();
  }

  const unknown = view.unknown;
  const activeMissions = view.missions.filter((mission) => mission.status === 'active');
  const next =
    unknown.status === 'resolved'
      ? 'This gap is closed — the resolution note and the belief it resolved into are below.'
      : activeMissions.length > 0
        ? `${activeMissions.length} active learning mission(s) are closing this gap — their confidence progress is what Aurum needs next.`
        : 'No active mission covers this gap yet — a learning mission is the next step.';

  return (
    <>
      <PageHead
        title={unknown.question}
        description={`A first-class unknown — recorded ${dateLabel(unknown.recordedAt)}${
          unknown.resolvedAt === null ? '' : `, resolved ${dateLabel(unknown.resolvedAt)}`
        }.`}
        meta={
          <>
            <ChatReturnLink back={back} />
            <Link href="/intelligence">← Intelligence</Link>
            {' · '}
            <Link href="/unknowns">Unknowns surface (management mode)</Link>
          </>
        }
      />

      <WhyNextBlock why={unknown.consequence} next={next} />

      <ChainRail activeStep="Unknown" />

      <Panel
        title="The question and its consequence"
        blurb="An unknown is first-class only when not knowing has a recorded cost — that consequence is the why of the whole chain."
        meta={
          <StatusPill tone={unknown.status === 'open' ? 'warning' : 'positive'}>
            {unknown.status === 'open' ? 'Open' : 'Resolved'}
          </StatusPill>
        }
      >
        <div className="aurum-intel-goal">
          <p className="aurum-intel-row-text">
            <strong>Question:</strong> {unknown.question}
          </p>
          <p className="aurum-intel-row-text">
            <strong>Consequence of not knowing:</strong> {unknown.consequence}
          </p>
          {unknown.note === null ? null : (
            <p className="aurum-intel-row-foot">Note: {unknown.note}</p>
          )}
          {unknown.status === 'resolved' ? (
            <p className="aurum-intel-row-text">
              <strong>How it was closed:</strong> {unknown.resolutionNote ?? 'resolution note not recorded'}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="The goal this unknown serves"
        blurb="The chain upward: which declared direction exposed this gap."
      >
        {view.goals.length === 0 ? (
          <EmptyState
            title="Not anchored to a goal"
            hint="This unknown was recorded outside goal-gap discovery — its subject is another record or none."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.goals.map((goal) => (
              <li key={goal.id} className="aurum-intel-row">
                <div className="aurum-intel-row-head">
                  <Link className="aurum-intel-row-title" href={goal.href}>
                    {goal.title}
                  </Link>
                  <StatusPill tone={goal.priority === 'critical' ? 'error' : 'info'}>
                    {goal.priority} priority
                  </StatusPill>
                </div>
                <p className="aurum-intel-row-foot">Open the full chain: goal → gap → this unknown → missions → evidence → belief.</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="The missions closing it"
        blurb="What Aurum is doing about the gap — urgency, information value, confidence progress."
      >
        {view.missions.length === 0 ? (
          <ChainEmpty
            step="mission"
            hint="A mission turns a material unknown into bounded learning work with a target confidence."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.missions.map((mission) => (
              <MissionLinkRow key={mission.id} mission={mission} back={back} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="The bounding evidence"
        blurb="What is already known: the immutable observations that frame the gap."
      >
        {view.evidence.length === 0 ? (
          <ChainEmpty
            step="evidence"
            hint="Related observations appear here as sources observe and the discovery pass links them."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.evidence.map((evidence) => (
              <EvidenceRow key={evidence.id} evidence={evidence} back={back} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="The claims and beliefs around it"
        blurb="Derived propositions and the working understanding — including the belief that resolved this gap, when one did."
      >
        {view.claims.length === 0 && view.beliefs.length === 0 ? (
          <ChainEmpty
            step="belief"
            hint="Claims derive from evidence; beliefs are the versioned understanding that weighs them."
          />
        ) : (
          <>
            {view.claims.length === 0 ? null : (
              <ul className="aurum-intel-list">
                {view.claims.map((claim) => (
                  <li key={claim.id} className="aurum-intel-row">
                    <div className="aurum-intel-row-head">
                      <span className="aurum-intel-row-title">{claim.proposition}</span>
                      <StatusPill tone="info">Claim</StatusPill>
                    </div>
                    <p className="aurum-intel-row-foot">
                      Confidence{' '}
                      {claim.confidence === null ? '—' : `${(Math.round(claim.confidence * 100)).toFixed(0)}%`} ·
                      recorded {dateLabel(claim.recordedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {view.beliefs.length === 0 ? null : (
              <ul className="aurum-intel-list">
                {view.beliefs.map((belief) => (
                  <BeliefRow key={belief.id} belief={belief} />
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/intelligence"
        />
      )}
    </>
  );
}
