// Capability, workforce & agent interventions (W063) — one agent team's
// detail page (the topology, the budget, the gated lifecycle, the
// outcome timeline).
//
// THE WORK ITEM'S "team topology/budget" clause, in one navigable page:
//   * the roster (which agent fills which team role, and the reporting
//     lines a hierarchical topology carries) — the topology;
//   * the shared objectives (keyed — team outcomes measure against
//     them), the budget envelope (integer minor units + ISO currency),
//     the escalation rules and the accountable owner;
//   * the gated lifecycle — activation (draft → active, an
//     'agent-recruitment' EXECUTE: a team is recruited as a unit) and
//     dissolution (agent-termination EXECUTE, terminal, with its
//     recorded why). The requester never decides their own request; the
//     same affordance requests and later applies the decided
//     transition;
//   * OUTCOME TRACKING — the team's append-only outcome timeline
//     (headline, assessment against an objective, evidence references);
//   * the version audit chain — every composition change is an
//     append-only version, gate-request links included.
//
// The page is a read of the agent-teams contract plus this surface's
// write affordance (lib/workflow.ts) — no second source of truth. A
// missing/foreign team renders the honest not-found state.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { EmptyState, ErrorState, PageHead, Panel, StatusPill } from '../../../components/states';
import { ChatReturnLink, chatReturnFromSearchParams } from '../../../chat/components/chat-return-link';
import { withChatReturn } from '../../../chat/lib/chat-types';
import type { PageSearchParams } from '../../../lib/context';
import { buildTeamView } from '../../lib/views';
import type { TeamView } from '../../lib/views';
import {
  GATE_NOTE,
  dateLabel,
  moneyLabel,
  outcomeAssessmentLabel,
  outcomeAssessmentTone,
  teamStatusLabel,
  teamStatusTone,
  topologyLabel,
} from '../../lib/labels';
import { TeamLifecycleForm } from '../../components/team-lifecycle-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agent team — Interventions — Aurum',
  description:
    'One agent team’s topology, budget, gated lifecycle and outcome timeline.',
};

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { teamId } = await params;
  // W072/W074 — the guarded return link when the team was opened from a
  // chat card drill-down (`?back=/chat?c=…`): the conversation is never
  // lost when the deeper management work begins.
  const search = await searchParams;
  const back = chatReturnFromSearchParams(search);
  const session = await requireAuthenticatedPage();

  let view: TeamView;
  try {
    view = await buildTeamView(session.context, teamId);
  } catch {
    notFound();
  }

  const team = view.team;
  const membersById = new Map(view.members.map((member) => [member.agentId, member]));

  return (
    <>
      <PageHead
        title={team.displayName ?? team.slug}
        description="A team of agents as one organizational actor — its roster topology, shared objectives, budget envelope and escalation rules, with a gated lifecycle and an outcome timeline."
        meta={
          <>
            <ChatReturnLink back={back} />{' '}
            <StatusPill tone={teamStatusTone(team.status)}>{teamStatusLabel(team.status)}</StatusPill>{' '}
            · version {team.version} · composed {dateLabel(team.createdAt)} · updated{' '}
            {dateLabel(team.updatedAt)}
          </>
        }
      />

      {team.description === null ? null : (
        <p className="aurum-intel-row-text" style={{ marginBottom: 12 }}>
          {team.description}
        </p>
      )}
      <p className="aurum-intel-row-foot" style={{ marginBottom: 18 }}>
        <Link className="aurum-learn-link" href={withChatReturn('/interventions', back)}>
          ← All interventions
        </Link>
      </p>

      {/* The topology (the roster). */}
      <Panel
        title="Topology — the roster"
        blurb="Which agent fills which team role, and — for a hierarchical topology — who reports to whom. Every member is validated readable through the agents contract, and activation enforces the roster’s liveness."
        meta={
          <>
            {topologyLabel(team.topology)} · {view.members.length} member
            {view.members.length === 1 ? '' : 's'}
          </>
        }
      >
        {view.members.length === 0 ? (
          <EmptyState title="No members" hint="A team carries at least one member by contract." />
        ) : (
          <ul className="aurum-intel-list">
            {view.members.map((member) => (
              <li className="aurum-intel-row" key={member.agentId}>
                <div className="aurum-intel-row-head">
                  {member.agentSlug === null ? (
                    <span className="aurum-intel-row-title">Agent {member.agentId.slice(0, 8)}</span>
                  ) : (
                    <Link
                      className="aurum-intel-row-title"
                      href={`/interventions/agents/${member.agentId}`}
                    >
                      {member.agentSlug}
                    </Link>
                  )}
                  {member.agentStatus === null ? null : (
                    <StatusPill tone={member.agentStatus === 'active' ? 'positive' : 'neutral'}>
                      {member.agentStatus}
                    </StatusPill>
                  )}
                </div>
                <p className="aurum-intel-row-foot">
                  Team role: {member.role}
                  {member.reportsTo === null
                    ? ''
                    : ` · reports to ${membersById.get(member.reportsTo)?.agentSlug ?? member.reportsTo.slice(0, 8)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Objectives + budget + escalation. */}
      <Panel
        title="Objectives, budget and escalation"
        blurb="What the team exists for, what it may spend, and where its failures escalate — all versioned team contract content, never a silent config edit."
      >
        <ul className="aurum-intel-list">
          {view.objectives.map((objective) => (
            <li className="aurum-intel-row" key={objective.key}>
              <div className="aurum-intel-row-head">
                <span className="aurum-intel-row-title">Objective “{objective.key}”</span>
              </div>
              <p className="aurum-intel-row-text">{objective.objective}</p>
              {objective.successCriteria === null ? null : (
                <p className="aurum-intel-row-foot">Success: {objective.successCriteria}</p>
              )}
            </li>
          ))}
          <li className="aurum-intel-row">
            <div className="aurum-intel-row-head">
              <span className="aurum-intel-row-title">Budget envelope</span>
            </div>
            <p className="aurum-intel-row-foot">
              {moneyLabel(view.budget.amountMinor, view.budget.currency)} — the team-level envelope;
              executions record their own costs.
            </p>
          </li>
          {view.escalationRules.length === 0 ? (
            <li className="aurum-intel-row">
              <div className="aurum-intel-row-head">
                <span className="aurum-intel-row-title">Escalation</span>
              </div>
              <p className="aurum-intel-row-foot">
                No rules recorded — escalations default to the coordinator.
              </p>
            </li>
          ) : (
            view.escalationRules.map((rule, index) => (
              <li className="aurum-intel-row" key={`${rule.trigger}-${index}`}>
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">
                    On {rule.trigger.replace('-', ' ')}
                  </span>
                  <StatusPill tone="info">routes to {rule.route}</StatusPill>
                </div>
                <p className="aurum-intel-row-foot">
                  {rule.threshold === null
                    ? 'No threshold — the trigger fires on the gap itself.'
                    : `Threshold ${rule.threshold}`}
                </p>
              </li>
            ))
          )}
          <li className="aurum-intel-row">
            <div className="aurum-intel-row-head">
              <span className="aurum-intel-row-title">Accountable owner</span>
            </div>
            <p className="aurum-intel-row-foot">
              {team.ownerPrincipal ?? 'none recorded — escalations routed to the owner need one'}
            </p>
          </li>
        </ul>
      </Panel>

      {/* The gated lifecycle. */}
      <Panel
        title="Lifecycle"
        blurb="Activation is a recruitment executed by the team as a unit; dissolution is terminal and records its why. Both route through the authority gate."
      >
        <TeamLifecycleForm teamId={team.id} status={team.status} />
        {team.lastChangeRequestId === null ? null : (
          <p className="aurum-intel-row-foot" style={{ marginTop: 10 }}>
            The last transition was authorized by{' '}
            <Link className="aurum-learn-link" href="/approvals">
              gate request {team.lastChangeRequestId.slice(0, 8)}
            </Link>
            .
          </p>
        )}
        <p className="aurum-learn-separation" role="note" style={{ marginTop: 12 }}>
          {GATE_NOTE}
        </p>
      </Panel>

      {/* Outcome tracking. */}
      <Panel
        title="Outcome timeline"
        blurb="The team’s recorded outcomes — headline, the assessment against a shared objective, and cited evidence. Append-only: nothing rewrites or erases an outcome."
        meta={<>{view.outcomes.length} outcome{view.outcomes.length === 1 ? '' : 's'}</>}
      >
        {view.outcomes.length === 0 ? (
          <EmptyState
            title="No team outcomes yet"
            hint="Any tenant member may record a team outcome — evidence recording is not administration."
          />
        ) : (
          <ul className="aurum-intel-list">
            {view.outcomes.map((outcome) => (
              <li className="aurum-intel-row" key={outcome.id}>
                <div className="aurum-intel-row-head">
                  <span className="aurum-intel-row-title">{outcome.headline}</span>
                  <StatusPill tone={outcomeAssessmentTone(outcome.assessment)}>
                    {outcomeAssessmentLabel(outcome.assessment)}
                  </StatusPill>
                </div>
                {outcome.detail === null ? null : (
                  <p className="aurum-intel-row-text">{outcome.detail}</p>
                )}
                <p className="aurum-intel-row-foot">
                  {outcome.objectiveKey === null
                    ? 'Team-level overall'
                    : `Against objective “${outcome.objectiveKey}”`}{' '}
                  · {outcome.evidenceCount} evidence reference{outcome.evidenceCount === 1 ? '' : 's'} ·
                  recorded by {outcome.recordedByPrincipal.slice(0, 8)} ·{' '}
                  {dateLabel(outcome.recordedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* The version audit chain. */}
      <Panel
        title="Version chain"
        blurb="Every composition change and every gated transition, as append-only versions — the auditable history of what this team is."
        meta={<>{view.versions.length} version{view.versions.length === 1 ? '' : 's'}</>}
      >
        <ul className="aurum-intel-list">
          {view.versions.map((version) => (
            <li className="aurum-intel-row" key={version.id}>
              <div className="aurum-intel-row-head">
                <span className="aurum-intel-row-title">
                  v{version.version} — {version.changeKind}
                </span>
                <StatusPill tone={teamStatusTone(version.status)}>
                  {version.status}
                </StatusPill>
              </div>
              <p className="aurum-intel-row-foot">
                {version.rationale === null ? 'No rationale recorded.' : version.rationale} ·{' '}
                {dateLabel(version.recordedAt)}
                {version.actionRequestId === null
                  ? ''
                  : ` · gate request ${version.actionRequestId.slice(0, 8)}`}
              </p>
            </li>
          ))}
        </ul>
      </Panel>

      {view.degraded.length === 0 ? null : (
        <ErrorState
          title="Some sections are incomplete"
          detail={`Reads were unavailable just now (${view.degraded.join(', ')}) — retry in a moment.`}
          retryHref={`/interventions/teams/${team.id}`}
        />
      )}
    </>
  );
}
