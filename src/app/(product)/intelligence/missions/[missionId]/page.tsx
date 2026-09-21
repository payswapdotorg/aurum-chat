// Intelligence discovery (W061) — the mission detail page (chain step 4).
//
// One learning mission in full: the knowledge objective and its urgency
// (severity legible), the confidence progress toward target ("what Aurum
// needs next" — always visible), the affected goals and unknowns (the
// chain upward and downward), the acquisitions the loop ran for it
// (from W013 traces), and the beliefs its unknowns resolved into (the
// chain's end). W062 adds the learning half on top of this chain view:
// the ask trigger (the planner's next acquisition), the knowledge
// requests and contributions this mission collected, and its rewards.
//
// Composition through module contracts (the one write is the W062 ask
// trigger — the planner's decision, policy-gated); a foreign/missing id
// renders the honest not-found state (uniform mission_not_found).

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { ErrorState, PageHead, Panel, StatusPill, EmptyState } from '../../../components/states';
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
// W062 — the learning half of this mission: open knowledge requests,
// contributions (acknowledgement + evidence) and rewards. The page's
// own comment reserved this layer for W062; the view logic lives in the
// learning surface's module (its lib, its tests).
import { buildMissionLearningView } from '../../../learning/lib/views';
import type { MissionLearningView } from '../../../learning/lib/views';
import {
  contributionStatusLabel,
  contributionStatusTone,
  contributionStatusExplanation,
  dateLabel as learningDateLabel,
  percentLabel,
  REWARD_SEPARATION_NOTE,
  rewardKindLabel,
  rewardStatusLabel,
  rewardStatusTone,
  settlementDecisionLabel,
  validationOutcomeLabel,
  validationOutcomeTone,
  moneyLabel,
} from '../../../learning/lib/labels';
import { AskNextSourceButton } from '../../../learning/components/ask-button';

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
  let learning: MissionLearningView | null = null;
  try {
    view = await buildMissionView(session.context, missionId);
    learning = await buildMissionLearningView(session.context, missionId);
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
        meta={
          <AskNextSourceButton missionId={mission.id} />
        }
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

      {learning === null ? null : (
        <>
          <Panel
            title="Knowledge requests and contributions"
            blurb="The people this mission asked, what they answered, and how the evidence was assessed — employees are first-class knowledge sources (the learning surface owns the full experience)."
            meta={
              <>
                <Link href="/learning">Open Learning</Link>
                {learning.requests.length === 0 ? null : (
                  <>
                    {' · '}
                    {learning.requests.length} open request(s)
                  </>
                )}
              </>
            }
          >
            {learning.requests.length > 0 ? (
              <ul className="aurum-intel-list aurum-learn-list">
                {learning.requests.map((request) => (
                  <li key={request.planId} className="aurum-intel-row aurum-learn-request">
                    <div className="aurum-intel-row-head">
                      <span className="aurum-learn-question">{request.question}</span>
                      <StatusPill tone={request.askPolicy === 'allowed' ? 'positive' : 'warning'}>
                        {request.askPolicy === null ? 'ask recorded' : request.askPolicy}
                      </StatusPill>
                    </div>
                    <p className="aurum-intel-row-foot">
                      Asked of <strong>{request.askedOf}</strong> · planned{' '}
                      {learningDateLabel(request.plannedAt)} ·{' '}
                      <Link href="/learning">answer it in Learning</Link>
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            {learning.trail.length === 0 ? null : (
              <details className="aurum-learn-disclose" style={{ marginTop: 10 }}>
                <summary>The planner’s acquisition trail</summary>
                <ul className="aurum-intel-list" style={{ marginTop: 10 }}>
                  {learning.trail.map((entry) => (
                    <li key={entry.planId} className="aurum-intel-row">
                      <div className="aurum-intel-row-head">
                        <span className="aurum-intel-row-title">
                          {entry.decision === 'selected'
                            ? `Asked ${entry.chosenLabel ?? 'the selected source'} (${entry.action ?? 'acquisition'})`
                            : 'Found no eligible candidate'}
                        </span>
                        <StatusPill tone={entry.outcome === null ? 'info' : 'neutral'}>
                          {entry.outcome === null ? 'awaiting outcome' : entry.outcome}
                        </StatusPill>
                      </div>
                      <p className="aurum-intel-row-foot">
                        {entry.question === null ? '' : `“${entry.question}” · `}
                        planned {learningDateLabel(entry.plannedAt)}
                        {entry.evidenceObservationId === null ? (
                          ''
                        ) : (
                          <>
                            {' · evidence '}
                            <Link href="/evidence">
                              {entry.evidenceObservationId.slice(0, 8)}
                            </Link>
                          </>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {learning.contributions.length === 0 ? (
              <EmptyState
                title="No contributions recorded for this mission yet"
                hint="When a targeted question is answered, the answer becomes evidence and the contribution records here — acknowledgement, assessment and measured impact."
              />
            ) : (
              <ul className="aurum-intel-list">
                {learning.contributions.map((contribution) => (
                  <li key={contribution.id} className="aurum-intel-row">
                    <div className="aurum-intel-row-head">
                      <span className="aurum-intel-row-title">{contribution.summary}</span>
                      <StatusPill tone={contributionStatusTone(contribution.status)}>
                        {contributionStatusLabel(contribution.status)}
                      </StatusPill>
                    </div>
                    <p className="aurum-intel-row-foot">
                      {contributionStatusExplanation(contribution.status)} · recorded{' '}
                      {learningDateLabel(contribution.recordedAt)} · evidence observation{' '}
                      <Link href="/evidence">{contribution.evidenceObservationId.slice(0, 8)}</Link>
                    </p>
                    {contribution.validation === null ? null : (
                      <p className="aurum-intel-row-foot">
                        <StatusPill tone={validationOutcomeTone(contribution.validation.outcome)}>
                          {validationOutcomeLabel(contribution.validation.outcome)}
                        </StatusPill>{' '}
                        quality {percentLabel(contribution.validation.quality)}
                      </p>
                    )}
                    {contribution.impact === null ? null : (
                      <p className="aurum-intel-row-foot">
                        Measured — knowledge gain{' '}
                        {percentLabel(contribution.impact.knowledgeGain)} · cost avoided{' '}
                        {contribution.impact.avoidedCost}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Rewards under this mission"
            blurb="What the tenant's explicit reward policy configured for this mission's qualifying contributions — proposed rewards wait at the human approval gate."
            meta={
              learning.rewardSummary === null
                ? undefined
                : <>{learning.rewardSummary.totalRewards} total</>
            }
          >
            {learning.rewards.length === 0 ? (
              <EmptyState
                title="No rewards under this mission"
                hint="Rewards exist only under an explicit reward policy — none minted silently, ever."
              />
            ) : (
              <ul className="aurum-intel-list">
                {learning.rewards.map((reward) => (
                  <li key={reward.id} className="aurum-intel-row">
                    <div className="aurum-intel-row-head">
                      <span className="aurum-intel-row-title">
                        {rewardKindLabel(reward.kind)} — {reward.tierName}
                      </span>
                      <StatusPill tone={rewardStatusTone(reward.status)}>
                        {rewardStatusLabel(reward.status)}
                      </StatusPill>
                    </div>
                    <p className="aurum-intel-row-foot">
                      {reward.amount === 0
                        ? 'Recognition — no amount attached'
                        : moneyLabel(reward.amount, reward.currency)}{' '}
                      · value score {percentLabel(reward.valueScore)} · recorded{' '}
                      {learningDateLabel(reward.recordedAt)}
                    </p>
                    {reward.status === 'proposed' ? (
                      <p className="aurum-intel-row-foot">
                        <Link href="/approvals">
                          Decide request {reward.actionRequestId.slice(0, 8)} in Approvals
                        </Link>
                      </p>
                    ) : null}
                    {reward.settlement === null ? null : (
                      <p className="aurum-intel-row-foot">
                        The approval gate {settlementDecisionLabel(reward.settlement.decision)} this
                        reward.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="aurum-learn-separation" role="note">
              {REWARD_SEPARATION_NOTE}
            </p>
          </Panel>
        </>
      )}

      {view.degraded.length === 0 && (learning?.degraded.length ?? 0) === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${[...view.degraded, ...(learning?.degraded ?? [])].join(', ')}) — retry in a moment.`}
          retryHref="/intelligence"
        />
      )}
    </>
  );
}
