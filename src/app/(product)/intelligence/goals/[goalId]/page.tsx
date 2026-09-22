// Intelligence discovery (W061) — the goal chain page.
//
// THE NAVIGABLE CHAIN (the acceptance's core): for one goal, the page
// walks goal → gap → unknown → mission → evidence → belief as six linked
// steps, every row drilling into the next step's page (unknowns and
// missions have their own routes; evidence links to the immutable
// evidence surface; beliefs render with their provenance and
// alternatives). "Why this matters" and "what Aurum needs next" are
// always visible — the goal's objective/desired state carries the why,
// the open gaps/missions carry the next.
//
// Read-only composition through module contracts (lock 31/32/34); a
// foreign/missing goal id renders the honest not-found state (the
// contract's uniform goal_not_found — no existence leak).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { ChatReturnLink, chatReturnFromSearchParams } from '../../../chat/components/chat-return-link';
import { buildGoalChainView } from '../../lib/views';
import type { GoalChainView } from '../../lib/views';
import {
  BeliefRow,
  ChainEmpty,
  ChainRail,
  EvidenceRow,
  GapRunBlock,
  MissionLinkRow,
  UnknownLinkRow,
  WhyNextBlock,
} from '../../components/chain-ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Goal chain — Aurum Intelligence',
  description:
    'The navigable chain for one goal: gap → unknown → mission → evidence → belief, with why it matters and what Aurum needs next.',
};

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function GoalChainPage({
  params,
  searchParams,
}: {
  params: Promise<{ goalId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { goalId } = await params;
  // W072 — the guarded return link when this chain was opened from a
  // chat card (`?back=/chat?c=…`): the way home renders in the head, and
  // the chain's own drill-downs carry it forward.
  const back = chatReturnFromSearchParams(await searchParams);
  const session = await requireAuthenticatedPage();

  let view: GoalChainView;
  try {
    view = await buildGoalChainView(session.context, goalId);
  } catch {
    notFound();
  }

  const goal = view.goal;
  const openUnknowns = view.unknowns.filter((unknown) => unknown.status === 'open');
  const activeMissions = view.missions.filter((mission) => mission.status === 'active');
  const promotedGaps = view.gaps.flatMap((run) =>
    run.candidates.filter((candidate) => candidate.disposition === 'promoted'),
  );

  const why = `${goal.objective} The desired state: ${goal.desiredState}`;
  const next =
    activeMissions.length > 0
      ? `${activeMissions.length} learning mission(s) are closing the knowledge gaps this goal exposed — their confidence progress is the next thing Aurum needs.`
      : openUnknowns.length > 0
        ? `${openUnknowns.length} open unknown(s) are not yet covered by a learning mission — that is the next step.`
        : promotedGaps.length > 0
          ? 'The latest discovery pass found no uncovered material gaps — the next discovery sweep re-checks this goal against new evidence.'
          : 'No discovery pass has evaluated this goal yet — the next step is a goal-gap discovery sweep against the evidence.';

  return (
    <>
      <PageHead
        title={goal.title}
        description={`The intelligence chain for this goal — priority ${goal.priority}, horizon ends ${dateLabel(goal.horizonEnd)}, owner ${goal.ownerLabel}.`}
        meta={
          <>
            <ChatReturnLink back={back} />
            <Link href="/intelligence">← Intelligence</Link>
            {' · '}
            <Link href="/goals">Goals surface (management mode)</Link>
            {' · '}
            updated {dateLabel(goal.updatedAt)}
          </>
        }
      />

      <WhyNextBlock why={why} next={next} />

      <ChainRail
        activeStep="Goal"
        counts={{
          Gap: view.gaps.length,
          Unknown: view.unknowns.length,
          Mission: view.missions.length,
          Evidence: view.evidence.length,
          Belief: view.beliefs.length,
        }}
      />

      <Panel
        title="Step 1 — the goal"
        blurb="Management's declared direction: the objective, the desired state, and the metrics that define meeting it."
        meta={<StatusPill tone={goal.priority === 'critical' ? 'error' : goal.priority === 'high' ? 'warning' : 'info'}>{goal.priority} priority</StatusPill>}
      >
        <div className="aurum-intel-goal">
          <p className="aurum-intel-row-text">
            <strong>Objective:</strong> {goal.objective}
          </p>
          <p className="aurum-intel-row-text">
            <strong>Desired state:</strong> {goal.desiredState}
          </p>
          <p className="aurum-intel-row-text">
            <strong>Success criteria:</strong> {goal.successCriteria}
          </p>
          {goal.metricLines.length === 0 ? null : (
            <ul className="aurum-intel-metrics">
              {goal.metricLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="aurum-intel-row-foot">
            Status {goal.status} · horizon ends {dateLabel(goal.horizonEnd)} · owner{' '}
            {goal.ownerLabel}
          </p>
        </div>
      </Panel>

      <Panel
        title="Step 2 — the gaps discovery found"
        blurb="Unprompted goal-gap discovery (ADR-0017): material gaps between this goal and its evidence, decided through the materiality gate."
      >
        {view.gaps.length === 0 ? (
          <ChainEmpty
            step="gap"
            hint="A discovery sweep derives candidates from active goals and metric readings — none has run for this goal yet."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.gaps.map((run) => (
              <GapRunBlock key={run.id} run={run} back={back} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Step 3 — the unknowns"
        blurb="First-class consequential questions: what not knowing costs, and which missions are closing them."
      >
        {view.unknowns.length === 0 ? (
          <ChainEmpty
            step="unknown"
            hint="Unknowns appear when a material goal gap is promoted — each one records the consequence of not knowing."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.unknowns.map((unknown) => (
              <UnknownLinkRow key={unknown.id} unknown={unknown} back={back} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Step 4 — the learning missions"
        blurb="Goal-driven knowledge investments: urgency, information value and the confidence gap each mission is closing."
      >
        {view.missions.length === 0 ? (
          <ChainEmpty
            step="mission"
            hint="Missions launch when a promoted unknown needs learning — goal-driven, budget-bounded."
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
        title="Step 5 — the evidence"
        blurb="The immutable observations beneath the chain — what Aurum's conclusions actually stand on."
      >
        {view.evidence.length === 0 ? (
          <ChainEmpty
            step="evidence"
            hint="Evidence accumulates as sources and channels observe; unknowns and claims link to it."
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
        title="Step 6 — the current beliefs"
        blurb="The versioned working understanding about this goal: confidence, alternatives retained, and what could change the conclusion."
      >
        {view.beliefs.length === 0 ? (
          <ChainEmpty
            step="belief"
            hint="Beliefs form when the loop's model-update stage records a working understanding — every version carries provenance."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.beliefs.map((belief) => (
              <BeliefRow key={belief.id} belief={belief} />
            ))}
          </ul>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some chain steps are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — this chain may be missing steps. Retry in a moment.`}
          retryHref="/intelligence"
        />
      )}
    </>
  );
}
