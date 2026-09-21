// Intelligence discovery (W061) — the mission detail page (chain step 4).
//
// One learning mission in full: the knowledge objective and its urgency
// (severity legible), the confidence progress toward target ("what Aurum
// needs next" — always visible), the affected goals and unknowns (the
// chain upward and downward), the acquisitions the loop ran for it
// (from W013 traces), and the beliefs its unknowns resolved into (the
// chain's end). W062 will build the employee-facing contribution and
// reward experience on top of this chain view.
//
// Read-only composition through module contracts; a foreign/missing id
// renders the honest not-found state (uniform mission_not_found).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { buildMissionView } from '../../lib/views';
import type { MissionView } from '../../lib/views';
import {
  AcquisitionRowItem,
  BeliefRow,
  ChainEmpty,
  ChainRail,
  UnknownLinkRow,
  WhyNextBlock,
} from '../../components/chain-ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Learning mission — Aurum Intelligence',
  description:
    'One goal-driven learning mission: what it must learn, its urgency and confidence progress, and the evidence and beliefs it produced.',
};

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function percent(value: number): string {
  return `${(Math.round(value * 100)).toFixed(0)}%`;
}

export default async function MissionPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;
  const session = await requireAuthenticatedPage();

  let view: MissionView;
  try {
    view = await buildMissionView(session.context, missionId);
  } catch {
    notFound();
  }

  const mission = view.mission;
  const why = `${mission.knowledgeObjective} — it matters to ${
    view.goals.length === 0
      ? 'the company\u2019s direction'
      : view.goals.map((goal) => goal.title).join(', ')
  } (information value ${percent(mission.informationValue)}).`;
  const next =
    mission.status === 'completed'
      ? `Completed — achieved confidence ${percent(mission.completion?.achievedConfidence ?? 0)}${
          mission.completion?.outcome === null || mission.completion === null
            ? ''
            : `: ${mission.completion.outcome}`
        }. The beliefs it produced are below.`
      : mission.status === 'abandoned'
        ? 'Abandoned — the recorded reason lives on the mission\u2019s audit trail; a returning need is a new mission.'
        : `Close the confidence gap ${percent(mission.currentConfidence)} → ${percent(
            mission.targetConfidence,
          )} — completion: ${mission.completionCriteria}.`;

  return (
    <>
      <PageHead
        title={mission.title}
        description={`A learning mission — ${mission.urgency} urgency, status ${mission.status}, updated ${dateLabel(mission.updatedAt)}.`}
        meta={
          <>
            <Link href="/intelligence">← Intelligence</Link>
            {' · '}
            <Link href="/missions">Missions surface (management mode)</Link>
          </>
        }
      />

      <WhyNextBlock why={why} next={next} />

      <ChainRail
        activeStep="Mission"
        counts={{
          Unknown: view.unknowns.length,
          Evidence: view.acquisitions.length,
          Belief: view.beliefs.length,
        }}
      />

      <Panel
        title="The knowledge objective"
        blurb="What this mission exists to learn, how urgent it is, and what it may cost — the learning investment Aurum is making."
        meta={
          <StatusPill
            tone={
              mission.urgency === 'critical'
                ? 'error'
                : mission.urgency === 'high'
                  ? 'warning'
                  : 'info'
            }
          >
            {mission.urgency} urgency
          </StatusPill>
        }
      >
        <div className="aurum-intel-goal">
          <p className="aurum-intel-row-text">
            <strong>Objective:</strong> {mission.knowledgeObjective}
          </p>
          <p className="aurum-intel-row-text">
            <strong>Completion criteria:</strong> {mission.completionCriteria}
          </p>
          <div
            className="aurum-intel-progress"
            role="img"
            aria-label={`Confidence ${percent(mission.currentConfidence)} of target ${percent(mission.targetConfidence)}`}
          >
            <span
              className="aurum-intel-progress-fill"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(
                    (mission.currentConfidence / Math.max(mission.targetConfidence, 0.01)) * 100,
                  ),
                )}%`,
              }}
            />
          </div>
          <p className="aurum-intel-row-foot">
            Confidence {percent(mission.currentConfidence)} → target{' '}
            {percent(mission.targetConfidence)} · information value{' '}
            {percent(mission.informationValue)} · investigation budget{' '}
            {mission.investigationBudget} · reward budget {mission.rewardBudget}
          </p>
          {mission.completion === null ? null : (
            <p className="aurum-intel-row-text">
              <strong>Outcome:</strong> achieved {percent(mission.completion.achievedConfidence)}
              {mission.completion.outcome === null ? '' : ` — ${mission.completion.outcome}`}
            </p>
          )}
          {mission.candidateSourceLabels.length === 0 ? null : (
            <p className="aurum-intel-row-foot">
              Candidate sources: {mission.candidateSourceLabels.join(' · ')}
            </p>
          )}
        </div>
      </Panel>

      <Panel
        title="The goals and unknowns it serves"
        blurb="The chain in both directions: the declared direction above, the consequential gaps below."
      >
        {view.goals.length === 0 ? (
          <p className="aurum-intel-row-foot">No affected goals recorded.</p>
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
                <p className="aurum-intel-row-foot">Open the full chain from the goal down.</p>
              </li>
            ))}
          </ul>
        )}
        {view.unknowns.length === 0 ? (
          <p className="aurum-intel-row-foot">Closes no recorded unknown (management-requested investigation).</p>
        ) : (
          <ul className="aurum-intel-list">
            {view.unknowns.map((unknown) => (
              <UnknownLinkRow key={unknown.id} unknown={unknown} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="The acquisitions the loop ran"
        blurb="Knowledge-acquisition steps of the cognitive loop that targeted this mission — who was asked, what came back, what evidence landed."
      >
        {view.acquisitions.length === 0 ? (
          <ChainEmpty
            step="acquisition"
            hint="The loop's planner picks the next best source to ask — its steps record here as they run."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.acquisitions.map((acquisition) => (
              <AcquisitionRowItem
                key={`${acquisition.executionId}-${acquisition.recordedAt}`}
                acquisition={acquisition}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="The resulting beliefs"
        blurb="When this mission's unknowns resolve, the working understanding they resolve into — the chain's end."
      >
        {view.beliefs.length === 0 ? (
          <ChainEmpty
            step="belief"
            hint="Beliefs form as the mission's evidence is weighed — every version carries provenance and alternatives."
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
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/intelligence"
        />
      )}
    </>
  );
}
