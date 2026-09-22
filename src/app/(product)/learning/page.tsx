// Learning missions, contributions & rewards (W062) — the Learning hub.
//
// THE WORK ITEM: "Surface learning missions to management and employees."
// One employee-facing surface composes Journey F end to end from module
// contracts only (lock 31/32 — this page is a view, never a second
// source of truth):
//
//   * the OPEN knowledge requests — the asks Aurum's planner decided on
//     (who, the composed question, the ask-policy evaluation), each with
//     the ANSWER form (progressive disclosure — ShareNet's quiet detail
//     pattern): the answer becomes immutable evidence and the recorded
//     contribution acknowledges itself;
//   * the learning missions with their confidence progress (management
//     and employees see the same legible state — detail lives one link
//     away on the intelligence chain, where W061 built it and W062 adds
//     the contribution/reward panels);
//   * the contribution acknowledgement ladder — what was recorded, how
//     the evidence was assessed, what the answer moved (knowledge gain,
//     mission impact, investigation cost avoided);
//   * the reward status and history — the closed non-compensation
//     vocabulary, the approval gate that holds proposed rewards, the
//     settlement that ended them, and the one honest sentence that keeps
//     rewards separate from people decisions (labels.ts, tested).
//
// Mobile-first, 44px+ targets, real heading hierarchy, the shell's
// quiet states everywhere (EmptyState/ErrorState/StatusPill), and the
// honest degradation note when a read family failed.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../components/states';
import { buildLearningHomeView } from './lib/views';
import type {
  ContributionRow,
  KnowledgeRequestRow,
  LearningMissionRow,
  RewardRow,
} from './lib/views';
import {
  contributionStatusExplanation,
  contributionStatusLabel,
  contributionStatusTone,
  dateLabel,
  missionUrgencyTone,
  missionImpactLabel,
  moneyLabel,
  missionProgressPercent,
  percentLabel,
  askPolicyNote,
  REWARD_SEPARATION_NOTE,
  rewardKindLabel,
  rewardStatusLabel,
  rewardStatusTone,
  settlementDecisionLabel,
  validationOutcomeLabel,
  validationOutcomeTone,
} from './lib/labels';
import type { ContributionStatus } from '@/modules/contributions/contract';
import { AnswerForm } from './components/answer-form';
import type { RewardKind, RewardStatus } from '@/modules/rewards/contract';
import { learningChatHref } from './lib/chat-requests';
import type { LearningChatLinkage } from './lib/chat-requests';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Learning — Aurum',
  description:
    'Learning missions, knowledge requests, contributions and rewards — what Aurum is learning about the company, and how employees help it learn.',
};

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function MissionProgress({ mission }: { mission: LearningMissionRow }) {
  const percent = missionProgressPercent(mission.currentConfidence, mission.targetConfidence);
  return (
    <div
      className="aurum-intel-progress"
      role="img"
      aria-label={`Confidence ${percentLabel(mission.currentConfidence)} of target ${percentLabel(
        mission.targetConfidence,
      )} — ${percent}% toward target`}
    >
      <span className="aurum-intel-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

function MissionRowView({ mission }: { mission: LearningMissionRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link
          className="aurum-intel-row-title"
          href={`/intelligence/missions/${mission.id}`}
        >
          {mission.title}
        </Link>
        <StatusPill tone={missionUrgencyTone(mission.urgency)}>{mission.urgency} urgency</StatusPill>
      </div>
      <p className="aurum-intel-row-text">{mission.knowledgeObjective}</p>
      <MissionProgress mission={mission} />
      <p className="aurum-intel-row-foot">
        Confidence {percentLabel(mission.currentConfidence)} → target{' '}
        {percentLabel(mission.targetConfidence)} · investigation budget{' '}
        {mission.investigationBudget} · reward budget {mission.rewardBudget}
        {mission.rewardTerms === null ? '' : ` · promised: ${mission.rewardTerms}`} · updated{' '}
        {dateLabel(mission.updatedAt)}
      </p>
    </li>
  );
}

function RequestRow({
  request,
  chat,
}: {
  request: KnowledgeRequestRow;
  /** W073 — the learning conversation's linkage, when it exists. */
  chat: LearningChatLinkage | null;
}) {
  const inChat = chat !== null && chat.askPlanIds.includes(request.planId);
  return (
    <li className="aurum-intel-row aurum-learn-request">
      <div className="aurum-intel-row-head">
        <span className="aurum-learn-question">{request.question}</span>
        <StatusPill tone={request.askPolicy === 'allowed' ? 'positive' : 'warning'}>
          {request.askPolicy === null ? 'ask recorded' : request.askPolicy}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        Asked of <strong>{request.askedOf}</strong>
        {request.missionTitle === null ? '' : ' for '}
        {request.missionTitle === null ? (
          'the mission'
        ) : (
          <Link className="aurum-learn-link" href={`/intelligence/missions/${request.missionId}`}>
            {request.missionTitle}
          </Link>
        )}{' '}
        · planned {dateLabel(request.plannedAt)}
      </p>
      <p className="aurum-intel-row-foot">
        {request.askPolicy === null ? '' : askPolicyNote(request.askPolicy)}
      </p>
      {chat === null ? null : (
        <p className="aurum-intel-row-foot aurum-learn-chatlink">
          {inChat ? (
            <>
              Aurum also asked this in the conversation —{' '}
              <Link className="aurum-learn-link" href={learningChatHref(chat)}>
                answer it in the chat
              </Link>
              .
            </>
          ) : (
            <>
              <Link className="aurum-learn-link" href={learningChatHref(chat)}>
                Answer in the chat instead
              </Link>{' '}
              — it lands in the same conversation, with the same acknowledgement.
            </>
          )}
        </p>
      )}
      <details className="aurum-learn-disclose">
        <summary>Answer this question</summary>
        <AnswerForm planId={request.planId} />
      </details>
    </li>
  );
}

function ContributionRowView({ contribution }: { contribution: ContributionRow }) {
  const status: ContributionStatus = contribution.status;
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">
          {contribution.missionTitle === null
            ? 'A contribution'
            : `Contributed to ${contribution.missionTitle}`}
        </span>
        <StatusPill tone={contributionStatusTone(status)}>
          {contributionStatusLabel(status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-text">{contribution.summary}</p>
      <p className="aurum-intel-row-foot">
        Answered “{contribution.question}” · contributed by{' '}
        {contribution.contributorLabel ?? 'an employee'} · recorded{' '}
        {dateLabel(contribution.recordedAt)} · evidence observation{' '}
        <Link className="aurum-learn-link" href="/evidence">
          {contribution.evidenceObservationId.slice(0, 8)}
        </Link>
      </p>
      {contribution.validation === null ? (
        <p className="aurum-intel-row-foot">{contributionStatusExplanation(status)}</p>
      ) : (
        <p className="aurum-intel-row-foot">
          <StatusPill tone={validationOutcomeTone(contribution.validation.outcome)}>
            {validationOutcomeLabel(contribution.validation.outcome)}
          </StatusPill>{' '}
          quality {percentLabel(contribution.validation.quality)}
          {contribution.validation.seriesCount > 1
            ? ` · ${contribution.validation.seriesCount} assessments retained`
            : ''}
          {contribution.validation.note === null ? '' : ` · “${contribution.validation.note}”`}
        </p>
      )}
      {contribution.impact === null ? null : (
        <p className="aurum-intel-row-foot">
          Measured: {missionImpactLabel(contribution.impact.missionImpact)} · knowledge gain{' '}
          {percentLabel(contribution.impact.knowledgeGain)} (confidence{' '}
          {percentLabel(contribution.impact.confidenceBefore)} →{' '}
          {percentLabel(contribution.impact.confidenceAfter)}) · investigation cost avoided{' '}
          {contribution.impact.avoidedCost}
        </p>
      )}
    </li>
  );
}

function RewardRowView({ reward }: { reward: RewardRow }) {
  const status: RewardStatus = reward.status;
  const kind: RewardKind = reward.kind;
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">
          {rewardKindLabel(kind)} — {reward.tierName}
        </span>
        <StatusPill tone={rewardStatusTone(status)}>{rewardStatusLabel(status)}</StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {reward.amount === 0
          ? 'Recognition — no amount attached'
          : moneyLabel(reward.amount, reward.currency)}
        {reward.contributorLabel === null ? '' : ` · for ${reward.contributorLabel}`} · value score{' '}
        {percentLabel(reward.valueScore)}
        {reward.missionTitle === null ? '' : ' · '}
        {reward.missionTitle === null ? (
          ''
        ) : (
          <Link className="aurum-learn-link" href={`/intelligence/missions/${reward.missionId}`}>
            {reward.missionTitle}
          </Link>
        )}{' '}
        · recorded {dateLabel(reward.recordedAt)}
      </p>
      {status === 'proposed' ? (
        <p className="aurum-intel-row-foot">
          The human approval gate holds this reward —{' '}
          <Link className="aurum-learn-link" href="/approvals">
            decide request {reward.actionRequestId.slice(0, 8)} in Approvals
          </Link>
          .
        </p>
      ) : null}
      {reward.settlement === null ? null : (
        <p className="aurum-intel-row-foot">
          The approval gate {settlementDecisionLabel(reward.settlement.decision)} this
          reward{reward.settlement.decidedAt === null
            ? ''
            : ` on ${dateLabel(reward.settlement.decidedAt)}`}
          .
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function LearningPage() {
  const session = await requireAuthenticatedPage();
  const view = await buildLearningHomeView(session.context);
  const summary = view.contributionSummary;
  const rewardSummary = view.rewardSummary;

  return (
    <>
      <PageHead
        title="Learning"
        description="What Aurum is learning about the company — the questions it is asking, the missions it is running, the knowledge employees contribute, and the rewards that acknowledge it."
        meta={<>Generated {dateLabel(view.generatedAt)}</>}
      />

      {/* The ask/answer loop: open knowledge requests. */}
      <Panel
        title="Knowledge requests awaiting an answer"
        blurb="Aurum’s planner chose who to ask and composed the question; policy permitted the ask. Answer in your own words — the answer is recorded as evidence, and the contribution acknowledges itself."
        meta={<>{view.requests.length} open</>}
      >
        {view.requests.length === 0 ? (
          <EmptyState
            title="No open knowledge requests"
            hint="When a learning mission needs knowledge a person holds, Aurum’s planner asks that person a targeted question — it lands here, policy-permitting."
          />
        ) : (
          <ul className="aurum-intel-list aurum-learn-list">
            {view.requests.map((request) => (
              <RequestRow key={request.planId} request={request} chat={view.chat} />
            ))}
          </ul>
        )}
        {view.chat === null ? null : (
          <p className="aurum-intel-row-foot aurum-learn-chatlink" style={{ marginTop: 10 }}>
            Aurum asks these questions in the conversation too —{' '}
            <Link className="aurum-learn-link" href={learningChatHref(view.chat)}>
              open the “Aurum learning” thread
            </Link>
            . Employees can complete them right there, without this page.
          </p>
        )}
      </Panel>

      {/* The missions with their progress (management + employees). */}
      <Panel
        title="Learning missions"
        blurb="What the company is investing to know — each mission’s urgency, its confidence progress toward target, and what it may spend and reward."
        meta={<>{view.missions.length} active</>}
      >
        {view.missions.length === 0 ? (
          <EmptyState
            title="No active learning missions"
            hint="Missions are the company’s declared knowledge investments — the intelligence chain (goal → gap → unknown → mission) creates them."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.missions.map((mission) => (
              <MissionRowView key={mission.id} mission={mission} />
            ))}
          </ul>
        )}
        {view.settledMissions.length === 0 ? null : (
          <details className="aurum-learn-disclose" style={{ marginTop: 12 }}>
            <summary>Recently settled missions</summary>
            <ul className="aurum-intel-list" style={{ marginTop: 10 }}>
              {view.settledMissions.map((mission) => (
                <MissionRowView key={mission.id} mission={mission} />
              ))}
            </ul>
          </details>
        )}
      </Panel>

      {/* Contribution acknowledgement. */}
      <Panel
        title="Contributions"
        blurb="What employees supplied, how the evidence was assessed, and what it moved — the acknowledgement ladder from recorded to measured."
        meta={
          summary === null ? undefined : (
            <>
              {summary.total} total · {summary.validated} validated · {summary.measured} measured
            </>
          )
        }
      >
        {view.contributions.length === 0 ? (
          <EmptyState
            title="No contributions yet"
            hint="The first answered knowledge request records the first contribution — employees are first-class knowledge sources."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.contributions.map((contribution) => (
              <ContributionRowView key={contribution.id} contribution={contribution} />
            ))}
          </ul>
        )}
        {summary === null ? null : (
          <p className="aurum-intel-row-foot" style={{ marginTop: 10 }}>
            Total knowledge gain {percentLabel(summary.totalKnowledgeGain)} across{' '}
            {summary.measured} measured contribution(s) · investigation cost avoided{' '}
            {summary.costAvoidedByCurrency
              .map((bucket) => moneyLabel(bucket.avoidedCost, bucket.currency))
              .join(' · ') || 'nothing recorded'}
          </p>
        )}
      </Panel>

      {/* Reward status/history + the separation note. */}
      <Panel
        title="Rewards"
        blurb="Status and history of the rewards the tenant’s explicit policy configured for valuable contributions — proposed rewards wait at the human approval gate."
        meta={
          rewardSummary === null ? undefined : (
            <>
              {rewardSummary.totalRewards} total · {rewardSummary.byStatus.granted} granted ·{' '}
              {rewardSummary.byStatus.proposed} proposed
            </>
          )
        }
      >
        {view.rewards.length === 0 ? (
          <EmptyState
            title="No rewards recorded"
            hint="Rewards exist only under the tenant’s explicit reward policy — no policy, no rewards (they are never minted silently)."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.rewards.map((reward) => (
              <RewardRowView key={reward.id} reward={reward} />
            ))}
          </ul>
        )}
        {rewardSummary === null ? null : (
          <p className="aurum-intel-row-foot" style={{ marginTop: 10 }}>
            {rewardSummary.byKind
              .map((row) => `${rewardKindLabel(row.kind)} ×${row.count}`)
              .join(' · ') || 'no kinds recorded'}{' '}
            · committed{' '}
            {rewardSummary.committedByCurrency
              .map((row) => moneyLabel(row.amount, row.currency))
              .join(' · ') || 'nothing'}
          </p>
        )}
        {view.chat === null ? null : (
          <p className="aurum-intel-row-foot aurum-learn-chatlink" style={{ marginTop: 8 }}>
            The same acknowledgements and reward state are visible in the Aurum
            conversation —{' '}
            <Link className="aurum-learn-link" href={learningChatHref(view.chat)}>
              open the thread
            </Link>
            .
          </p>
        )}
        <p className="aurum-learn-separation" role="note">
          {REWARD_SEPARATION_NOTE}
        </p>
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/learning"
        />
      )}
    </>
  );
}
