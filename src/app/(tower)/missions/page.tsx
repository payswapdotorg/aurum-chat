// Management Control Tower (W033) — the Missions surface.
//
// Learning missions (W011, lock 8): the knowledge-investment vehicle of
// the intelligence loop — objective, affected goals, information value,
// urgency, confidence gap, budgets, candidate sources and completion
// criteria. Active missions are ordered by urgency rank by the contract.

import { buildMissionsView } from '../lib/views/missions';
import { requireTowerScope } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  ItemText,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import {
  formatConfidence,
  formatCount,
  formatInstant,
  formatMinorUnits,
} from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function MissionsPage() {
  // W058: authenticated routing — the session carries the tenant scope.
  const scope = await requireTowerScope('/missions');
  const view = await buildMissionsView(scope.context);

  return (
    <>
      <SurfaceHeader
        title="Missions"
        description="First-class learning missions: what knowledge is missing, why it matters, how sure it must become, what it may cost and where it may come from. Missions are versioned and auditable; completion and abandonment are terminal by design."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          {
            label: 'Active missions',
            value: formatCount(view.active.total, view.active.capped),
          },
          { label: 'Completed', value: view.completed.total },
          { label: 'Abandoned', value: view.abandoned.total },
        ]}
      />
      <Card
        title="Active missions"
        meta={`${formatCount(view.active.total, view.active.capped)} active · urgency order`}
      >
        {view.active.items.length === 0 ? (
          <Empty
            title="No active missions"
            hint="Missions launch from the loop's unknown-mission evaluation or goal-gap discovery."
          />
        ) : (
          <ul className="item-list">
            {view.active.items.map((mission) => (
              <li key={mission.id}>
                <ItemHead
                  title={mission.title}
                  badges={
                    <>
                      <StatusBadge status={mission.urgency} />
                      <Badge kind="muted">v{mission.version}</Badge>
                    </>
                  }
                />
                <ItemText>{mission.knowledgeObjective}</ItemText>
                <ItemFoot>
                  <span>
                    confidence {formatConfidence(mission.currentConfidence)} →{' '}
                    {formatConfidence(mission.targetConfidence)}
                  </span>
                  <span>value {formatConfidence(mission.informationValue)}</span>
                  <span>
                    investigation budget{' '}
                    {formatMinorUnits(mission.investigationBudget.amount, mission.investigationBudget.currency)}
                  </span>
                  <span>
                    {mission.affectedGoals.length} affected goal
                    {mission.affectedGoals.length === 1 ? '' : 's'}
                  </span>
                  <span>{mission.candidateCount} candidate sources</span>
                  <span>updated {formatInstant(mission.updatedAt)}</span>
                  <span className="mono">{mission.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Completed missions" meta="terminal — a returning need is a new mission">
        {view.completed.items.length === 0 ? (
          <Empty title="No completed missions yet" />
        ) : (
          <ul className="item-list">
            {view.completed.items.map((mission) => (
              <li key={mission.id}>
                <ItemHead title={mission.title} badges={<StatusBadge status="completed" />} />
                {mission.completion === null ? null : (
                  <ItemText>
                    Achieved confidence {formatConfidence(mission.completion.achievedConfidence)} —{' '}
                    {mission.completion.outcome}
                  </ItemText>
                )}
                <ItemFoot>
                  <span>updated {formatInstant(mission.updatedAt)}</span>
                  <span className="mono">{mission.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Abandoned missions" meta="terminal, with recorded reason">
        {view.abandoned.items.length === 0 ? (
          <Empty title="No abandoned missions" />
        ) : (
          <ul className="item-list">
            {view.abandoned.items.map((mission) => (
              <li key={mission.id}>
                <ItemHead title={mission.title} badges={<StatusBadge status="abandoned" />} />
                <ItemFoot>
                  <span>updated {formatInstant(mission.updatedAt)}</span>
                  <span className="mono">{mission.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
