// Capability, workforce & agent interventions (W063) — the
// Interventions hub.
//
// THE WORK ITEM: "Surface capability-gap alternatives and the full
// agent/workforce lifecycle." One management surface composes plan §2
// Journey I end to end from module contracts only (lock 31/32 — this
// page is a view, never a second source of truth):
//
//   * the seven-word comparison axis — where train / reassign / hire /
//     automate / recruit / install / outsource are currently being
//     compared (proposals, automation candidates, workforce
//     alternatives);
//   * the capability gaps with their available alternatives (the
//     intervention surface's demand side);
//   * the recruitment proposals — the comparison + explicit approval,
//     pending decisions legible (the detail page carries the decision
//     and activation affordances);
//   * the agent teams (topology/budget; the detail page carries the
//     gated lifecycle) and the agent workforce (the detail page carries
//     the measured evaluation + retain/modify/terminate lifecycle);
//   * the workforce assessments — uncertainty, alternative
//     explanations, alternatives and the human decision trail, with the
//     lock-20/21 note always visible;
//   * the automation candidates (the outsource-bearing vocabulary) and
//     the outcome tracking rollup (expected versus realized).
//
// Mobile-first, 44px+ targets, real heading hierarchy, the shell's
// quiet states everywhere (EmptyState/ErrorState/StatusPill), and the
// honest degradation note when a read family failed.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../components/states';
import { buildInterventionsHomeView } from './lib/views';
import type {
  AgentRow,
  AssessmentRow,
  AutomationRow,
  GapRow,
  OutcomeRow,
  ProposalRow,
  TeamRow,
} from './lib/views';
import {
  GATE_NOTE,
  HUMAN_AUTHORIZED_NOTE,
  UNCERTAINTY_NOTE,
  automationStatusLabel,
  automationStatusTone,
  dateLabel,
  gapStatusLabel,
  gapStatusTone,
  moneyLabel,
  outcomeStatusLabel,
  outcomeStatusTone,
  percentLabel,
  proposalStatusLabel,
  proposalStatusTone,
  recommendationLabel,
  recommendationTone,
  solutionTypeLabel,
  teamStatusLabel,
  teamStatusTone,
  workforceAlternativeLabel,
} from './lib/labels';
import { TeamComposeForm } from './components/team-compose-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Interventions — Aurum',
  description:
    'Capability gaps, acquisition alternatives and the full agent/workforce lifecycle — compare, decide, activate and track, with employment decisions staying human-authorized.',
};

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function VocabularyRowView({ entry }: { entry: { word: string; label: string; proposalCount: number; automationCount: number; workforceCount: number; total: number } }) {
  return (
    <li className="aurum-intel-row aurum-int-vocab-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">{entry.label}</span>
        <StatusPill tone={entry.total === 0 ? 'neutral' : 'info'}>
          {entry.total === 0 ? 'not currently compared' : `${entry.total} comparison${entry.total === 1 ? '' : 's'}`}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {entry.proposalCount} recruitment proposal{entry.proposalCount === 1 ? '' : 's'} ·{' '}
        {entry.automationCount} automation candidate{entry.automationCount === 1 ? '' : 's'} ·{' '}
        {entry.workforceCount} workforce alternative{entry.workforceCount === 1 ? '' : 's'}
      </p>
    </li>
  );
}

function GapRowView({ gap }: { gap: GapRow }) {
  const channels = Object.entries(gap.activeByKind).filter(([, count]) => count > 0);
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link className="aurum-intel-row-title" href="/capabilities">
          {gap.name}
        </Link>
        <StatusPill tone={gapStatusTone(gap.status)}>
          {gapStatusLabel(gap.status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {gap.unmetCount} unmet requirement{gap.unmetCount === 1 ? '' : 's'} of{' '}
        {gap.activeRequirementCount} · best level{' '}
        {gap.bestActiveLevel === null ? 'none' : percentLabel(gap.bestActiveLevel)} · capacity{' '}
        {gap.totalActiveCapacity}
      </p>
      <p className="aurum-intel-row-foot">
        {channels.length === 0
          ? 'No active supply — nothing currently provides this capability.'
          : `Available alternatives: ${channels.map(([kind, count]) => `${count} ${kind}`).join(' · ')}`}
      </p>
    </li>
  );
}

function ProposalRowView({ proposal }: { proposal: ProposalRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link
          className="aurum-intel-row-title"
          href={`/interventions/proposals/${proposal.id}`}
        >
          {proposal.title}
        </Link>
        <StatusPill tone={proposalStatusTone(proposal.status)}>
          {proposalStatusLabel(proposal.status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        For <strong>{proposal.capabilityName}</strong> · comparing{' '}
        {proposal.alternativeKinds.join(' / ')}
        {proposal.recommendedKind === null ? '' : ` · recommends ${proposal.recommendedKind}`} ·
        updated {dateLabel(proposal.updatedAt)}
      </p>
      {proposal.awaitingDecision ? (
        <p className="aurum-intel-row-foot">
          <Link className="aurum-learn-link" href={`/interventions/proposals/${proposal.id}`}>
            Decide this proposal
          </Link>{' '}
          — a human decision is holding it.
        </p>
      ) : null}
    </li>
  );
}

function TeamRowView({ team }: { team: TeamRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link className="aurum-intel-row-title" href={`/interventions/teams/${team.id}`}>
          {team.displayName ?? team.slug}
        </Link>
        <StatusPill tone={teamStatusTone(team.status)}>
          {teamStatusLabel(team.status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {team.memberCount} member{team.memberCount === 1 ? '' : 's'} · {team.topology} ·{' '}
        {team.objectiveCount} shared objective{team.objectiveCount === 1 ? '' : 's'} · budget{' '}
        {moneyLabel(team.budget.amountMinor, team.budget.currency)} · version {team.version}
      </p>
    </li>
  );
}

function AgentRowView({ agent }: { agent: AgentRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link className="aurum-intel-row-title" href={`/interventions/agents/${agent.id}`}>
          {agent.displayName ?? agent.slug}
        </Link>
        <StatusPill tone={agent.status === 'active' ? 'positive' : 'neutral'}>
          {agent.status}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {agent.role} · {agent.provider} · scopes {agent.permissions.join(' / ')}
      </p>
    </li>
  );
}

function AssessmentRowView({ assessment }: { assessment: AssessmentRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">
          {assessment.employeeLabel ?? 'An employee'} — assessment v{assessment.version}
        </span>
        <StatusPill tone={recommendationTone(assessment.recommendationKind)}>
          {recommendationLabel(assessment.recommendationKind)}
          {assessment.employmentImpacting ? ' · employment-impacting' : ''}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-text">{assessment.recommendationText}</p>
      <p className="aurum-intel-row-foot">
        Confidence {percentLabel(assessment.confidence)} ·{' '}
        {assessment.alternativeExplanations.length} alternative explanation
        {assessment.alternativeExplanations.length === 1 ? '' : 's'} remain open ·{' '}
        {assessment.evidenceObservationIds.length} evidence citation
        {assessment.evidenceObservationIds.length === 1 ? '' : 's'}
      </p>
      <p className="aurum-intel-row-foot">
        Alternatives:{' '}
        {assessment.alternatives
          .map((alternative) => workforceAlternativeLabel(alternative.kind))
          .join(' · ') || 'none recorded'}
      </p>
      {assessment.decision === null ? (
        <p className="aurum-intel-row-foot">
          No human decision recorded yet — the authorized decision belongs to a human, never Aurum.
        </p>
      ) : (
        <p className="aurum-intel-row-foot">
          Human decision: {assessment.decision.kind} · decided {dateLabel(assessment.decision.decidedAt)}
        </p>
      )}
    </li>
  );
}

function AutomationRowView({ opportunity }: { opportunity: AutomationRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <Link className="aurum-intel-row-title" href="/automation">
          {opportunity.name}
        </Link>
        <StatusPill tone={automationStatusTone(opportunity.status)}>
          {automationStatusLabel(opportunity.status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        In {opportunity.processName} · solution types{' '}
        {opportunity.solutionTypes.map((kind) => solutionTypeLabel(kind)).join(' · ')}
      </p>
      <p className="aurum-intel-row-foot">
        Expected net benefit {moneyLabel(opportunity.expectedNetBenefitMinor, opportunity.currency)} ·{' '}
        {opportunity.measurementCount} outcome measurement{opportunity.measurementCount === 1 ? '' : 's'}
        {opportunity.targetMet === null
          ? ' · no target verdict yet'
          : opportunity.targetMet
            ? ' · target met'
            : ' · target not met yet'}
      </p>
    </li>
  );
}

function OutcomeRowView({ outcome }: { outcome: OutcomeRow }) {
  return (
    <li className="aurum-intel-row">
      <div className="aurum-intel-row-head">
        <span className="aurum-intel-row-title">
          {outcome.metricName} ({outcome.metricUnit})
        </span>
        <StatusPill tone={outcomeStatusTone(outcome.status)}>
          {outcomeStatusLabel(outcome.status)}
        </StatusPill>
      </div>
      <p className="aurum-intel-row-foot">
        {outcome.subjectLabel === null ? 'Agent subject' : `Agent ${outcome.subjectLabel}`} ·
        expected {outcome.expected} ·{' '}
        {outcome.realized === null
          ? 'not yet realized'
          : `realized ${outcome.realized}${outcome.assessment === null ? '' : ` — ${outcome.assessment}`}`}
        {' · recorded '}
        {dateLabel(outcome.createdAt)}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function InterventionsPage() {
  const session = await requireAuthenticatedPage();
  const view = await buildInterventionsHomeView(session.context);
  const summary = view.outcomeSummary;

  return (
    <>
      <PageHead
        title="Interventions"
        description="Where the company is short, what could close the gap, and the full lifecycle of the agents and teams that do the work — compared with evidence and uncertainty, decided by humans."
        meta={<>Generated {dateLabel(view.generatedAt)}</>}
      />

      {/* The seven-word comparison axis. */}
      <Panel
        title="Compared alternatives"
        blurb="The acquisition vocabulary the architecture froze — where each alternative is currently being compared: recruitment proposals, automation candidates and workforce alternatives."
        meta={<>{view.vocabulary.filter((entry) => entry.total > 0).length} of 7 in active comparison</>}
      >
        <ul className="aurum-intel-list aurum-int-vocab">
          {view.vocabulary.map((entry) => (
            <VocabularyRowView key={entry.word} entry={entry} />
          ))}
        </ul>
      </Panel>

      {/* Capability gaps — the demand side. */}
      <Panel
        title="Capability gaps"
        blurb="What the company is short of right now — the unmet demand, the best active supply, and the available alternatives per supply channel."
        meta={<>{view.gaps.length} gap{view.gaps.length === 1 ? '' : 's'}</>}
      >
        {view.gaps.length === 0 ? (
          <EmptyState
            title="No gaps in scope"
            hint="A gap appears when an active capability carries active demand — requirements the supply does not meet."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.gaps.map((gap) => (
              <GapRowView key={gap.capabilityId} gap={gap} />
            ))}
          </ul>
        )}
      </Panel>

      {/* Recruitment proposals — comparison + explicit approval. */}
      <Panel
        title="Recruitment proposals"
        blurb="The compared ways to close a gap — cost, timeline and expected capability per alternative, with the recommended one marked and the approval gate explicit."
        meta={
          <>
            {view.proposals.length} proposal{view.proposals.length === 1 ? '' : 's'} ·{' '}
            {view.proposals.filter((proposal) => proposal.awaitingDecision).length} awaiting a
            decision
          </>
        }
      >
        {view.proposals.length === 0 ? (
          <EmptyState
            title="No recruitment proposals"
            hint="A proposal records the comparison before any acquisition is requested — the capability-gap chain creates them."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.proposals.map((proposal) => (
              <ProposalRowView key={proposal.id} proposal={proposal} />
            ))}
          </ul>
        )}
        <p className="aurum-learn-separation" role="note">
          {GATE_NOTE}
        </p>
      </Panel>

      {/* Agent teams + the agent workforce. */}
      <Panel
        title="Agent teams"
        blurb="Teams of agents as organizational actors — roster topology, shared objectives, budget envelopes and escalation rules."
        meta={<>{view.teams.length} team{view.teams.length === 1 ? '' : 's'}</>}
      >
        {view.teams.length === 0 ? (
          <EmptyState
            title="No agent teams"
            hint="A team is recruited as a unit — compose a draft below, then request its activation (a gated, human-approved transition)."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.teams.map((team) => (
              <TeamRowView key={team.id} team={team} />
            ))}
          </ul>
        )}
        <details className="aurum-learn-disclose" style={{ marginTop: 12 }}>
          <summary>Compose a new draft team</summary>
          <TeamComposeForm
            agents={view.agents
              .filter((agent) => agent.status === 'active')
              .map((agent) => ({ id: agent.id, slug: agent.slug, role: agent.role }))}
          />
        </details>
      </Panel>

      <Panel
        title="Agent workforce"
        blurb="Every agent under contract — its role, runtime provider and permission scopes. Each opens its full lifecycle: measured evaluation, tied outcomes, retain/modify/terminate."
        meta={<>{view.agents.length} agent{view.agents.length === 1 ? '' : 's'}</>}
      >
        {view.agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            hint="Agents are recruited through approved proposals — activate one from an approved recruit alternative, or register one through the management surface."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.agents.map((agent) => (
              <AgentRowView key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
      </Panel>

      {/* Workforce intelligence — uncertainty + human decisions. */}
      <Panel
        title="Workforce intelligence"
        blurb="Aurum’s assessments of the human workforce — each carries its confidence, the alternative explanations that remain open, the alternatives compared, and the human decision that owns it."
        meta={<>{view.assessments.length} assessment{view.assessments.length === 1 ? '' : 's'}</>}
      >
        {view.assessments.length === 0 ? (
          <EmptyState
            title="No workforce assessments"
            hint="An assessment is the §14 chain — evidence → interpretation → alternatives → recommendation → the authorized human decision."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.assessments.map((assessment) => (
              <AssessmentRowView key={assessment.id} assessment={assessment} />
            ))}
          </ul>
        )}
        <p className="aurum-learn-separation" role="note">
          {HUMAN_AUTHORIZED_NOTE}
        </p>
        <p className="aurum-learn-separation" role="note" style={{ marginTop: 8 }}>
          {UNCERTAINTY_NOTE}
        </p>
      </Panel>

      {/* Automation candidates — the outsource-bearing vocabulary. */}
      <Panel
        title="Automation candidates"
        blurb="Process inefficiency connected to solution options — including the recruit/install/outsource alternatives — with committed ROI expectations and outcome measurement."
        meta={<>{view.opportunities.length} candidate{view.opportunities.length === 1 ? '' : 's'}</>}
      >
        {view.opportunities.length === 0 ? (
          <EmptyState
            title="No automation candidates"
            hint="Process intelligence connects observed inefficiency to solution options — candidates appear here once registered."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.opportunities.map((opportunity) => (
              <AutomationRowView key={opportunity.id} opportunity={opportunity} />
            ))}
          </ul>
        )}
      </Panel>

      {/* Outcome tracking. */}
      <Panel
        title="Outcome tracking"
        blurb="What the agent workforce was expected to move, and what it actually moved — expected versus realized, per agent-subject outcome."
        meta={
          summary === null ? undefined : (
            <>
              {summary.settled} settled · {summary.open} open · {summary.abandoned} abandoned
            </>
          )
        }
      >
        {view.outcomes.length === 0 ? (
          <EmptyState
            title="No tracked outcomes"
            hint="Outcome measurement ties agents, teams and recommendations to measurable metrics — the expected value is frozen before realization."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.outcomes.map((outcome) => (
              <OutcomeRowView key={outcome.id} outcome={outcome} />
            ))}
          </ul>
        )}
        {summary === null ? null : (
          <p className="aurum-intel-row-foot" style={{ marginTop: 10 }}>
            Over settled agent outcomes: expected {summary.settledExpected} · realized{' '}
            {summary.settledRealized} (sums over metric values — comparing across metrics is the
            reader’s interpretation).
          </p>
        )}
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref="/interventions"
        />
      )}
    </>
  );
}
