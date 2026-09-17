// Management Control Tower (W033) — the Today surface.
//
// The attention dashboard: what needs a manager's decision or awareness
// right now, assembled live from the module contracts (approvals gate,
// missions, unknowns, live cognition, loop findings, discovery, goals,
// evidence). Derived intelligence only (lock 34).

import { buildTodayView } from '../lib/views/today';
import { resolvePageContext } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  ItemText,
  NotScoped,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatCount, formatConfidence, formatInstant } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolution = await resolvePageContext(await searchParams);
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildTodayView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Today"
        description="What needs your attention right now: pending decisions, urgent knowledge missions, open unknowns and the live intelligence loop."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          {
            label: 'Pending approvals',
            value: formatCount(view.approvals.pending.count, view.approvals.pending.capped),
            hint: 'awaiting a human decision',
          },
          {
            label: 'Active missions',
            value: formatCount(view.missions.active.count, view.missions.active.capped),
            hint: view.missions.byUrgency
              .filter((u) => u.count > 0)
              .map((u) => `${u.count} ${u.urgency}`)
              .join(' · ') || 'none',
          },
          {
            label: 'Open unknowns',
            value: formatCount(view.unknowns.open.count, view.unknowns.open.capped),
            hint: 'consequential knowledge gaps',
          },
          {
            label: 'Live cognition',
            value: formatCount(view.cognition.live.count, view.cognition.live.capped),
            hint: `${formatCount(view.cognition.awaitingApproval.count, view.cognition.awaitingApproval.capped)} awaiting approval`,
          },
          {
            label: 'Active goals',
            value: formatCount(view.goals.active.count, view.goals.active.capped),
            hint: view.goals.byPriority
              .filter((p) => p.count > 0)
              .map((p) => `${p.count} ${p.priority}`)
              .join(' · ') || 'none',
          },
        ]}
      />

      <Card
        title="Approvals waiting for a decision"
        meta={`${formatCount(view.approvals.pending.count, view.approvals.pending.capped)} pending`}
      >
        {view.approvals.latest.length === 0 ? (
          <Empty title="No pending approvals" hint="The authority gate holds nothing for you right now." />
        ) : (
          <ul className="item-list">
            {view.approvals.latest.map((item) => (
              <li key={item.id}>
                <ItemHead
                  title={item.actionKind}
                  badges={
                    <>
                      <Badge kind="accent">{item.authorityLevel}</Badge>
                      <StatusBadge status="pending" />
                    </>
                  }
                />
                {item.justification === null ? null : <ItemText>{item.justification}</ItemText>}
                <ItemFoot>
                  <span>requested {formatInstant(item.requestedAt)}</span>
                  <span className="mono">{item.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Most urgent active missions"
        meta={`${formatCount(view.missions.active.count, view.missions.active.capped)} active`}
      >
        {view.missions.urgent.length === 0 ? (
          <Empty title="No active learning missions" hint="Missions launch when goals expose material knowledge gaps." />
        ) : (
          <ul className="item-list">
            {view.missions.urgent.map((mission) => (
              <li key={mission.id}>
                <ItemHead
                  title={mission.title}
                  badges={
                    <>
                      <StatusBadge status={mission.urgency} />
                      <Badge kind="muted">value {formatConfidence(mission.informationValue)}</Badge>
                    </>
                  }
                />
                <ItemFoot>
                  <span>
                    confidence {formatConfidence(mission.currentConfidence)} →{' '}
                    {formatConfidence(mission.targetConfidence)}
                  </span>
                  <span className="mono">{mission.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Open unknowns" meta={`${formatCount(view.unknowns.open.count, view.unknowns.open.capped)} open`}>
        {view.unknowns.latest.length === 0 ? (
          <Empty title="No open unknowns" hint="Unknown is first-class: a question plus the consequence of not knowing." />
        ) : (
          <ul className="item-list">
            {view.unknowns.latest.map((unknown) => (
              <li key={unknown.id}>
                <ItemHead title={unknown.question} />
                <ItemFoot>
                  <span>recorded {formatInstant(unknown.recordedAt)}</span>
                  <span className="mono">{unknown.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Live cognitive executions"
        meta={`${formatCount(view.cognition.live.count, view.cognition.live.capped)} running · ${formatCount(
          view.cognition.awaitingApproval.count,
          view.cognition.awaitingApproval.capped,
        )} gated`}
      >
        {view.cognition.latest.length === 0 ? (
          <Empty title="No live executions" hint="The intelligence loop is idle: explicit, asynchronous, resumable." />
        ) : (
          <ul className="item-list">
            {view.cognition.latest.map((execution) => (
              <li key={execution.id}>
                <ItemHead
                  title={`Trigger: ${execution.triggerKind}${execution.triggerLabel === null ? '' : ` — ${execution.triggerLabel}`}`}
                  badges={<StatusBadge status={execution.state} />}
                />
                <ItemFoot>
                  <span>next: {execution.nextStage ?? '—'}</span>
                  <span>updated {formatInstant(execution.updatedAt)}</span>
                  <span className="mono">{execution.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Latest analysis findings" meta="from the risk/opportunity/capability stage">
        {view.findings.length === 0 ? (
          <Empty title="No findings recorded yet" hint="Findings are derived intelligence on cognition traces." />
        ) : (
          <ul className="item-list">
            {view.findings.map((finding, index) => (
              <li key={`${finding.executionId}-${index}`}>
                <ItemHead title={finding.statement} badges={<StatusBadge status={finding.kind} />} />
                <ItemFoot>
                  <span>detected {formatInstant(finding.detectedAt)}</span>
                  <span className="mono">{finding.executionId}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Latest goal-gap discovery pass"
        meta={view.discovery === null ? 'no runs yet' : `trigger: ${view.discovery.triggerKind}`}
      >
        {view.discovery === null ? (
          <Empty
            title="No discovery runs"
            hint="Unprompted unknown discovery derives candidates from active goals and their evidence (ADR-0017)."
          />
        ) : (
          <>
            <p className="item-text">
              {view.discovery.counts.total} candidates: {view.discovery.counts.promoted} promoted
              to unknown + mission, {view.discovery.counts.alreadyCovered} already covered,{' '}
              {view.discovery.counts.dismissed} dismissed below the materiality thresholds.
            </p>
            <ItemFoot>
              <span>run {formatInstant(view.discovery.recordedAt)}</span>
              <span className="mono">{view.discovery.runId}</span>
            </ItemFoot>
          </>
        )}
      </Card>

      <Card title="Freshest evidence" meta="immutable observations">
        {view.evidence.latest.length === 0 ? (
          <Empty title="No observations recorded" />
        ) : (
          <ul className="item-list">
            {view.evidence.latest.map((observation, index) => (
              <li key={index}>
                <ItemHead
                  title={observation.kind}
                  badges={<Badge kind="muted">{observation.channel}</Badge>}
                />
                <ItemFoot>
                  <span>observed {formatInstant(observation.observedAt)}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
