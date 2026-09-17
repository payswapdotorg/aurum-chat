// Management Control Tower (W033) — the Goals surface.
//
// The tenant's declared direction (W008): versioned management goals
// with desired state, metrics, thresholds, horizon, owner and priority.
// The tower reads current views through the goals contract; the audit
// trail lives in the module (every version records who/when/what/why).

import { buildGoalsView } from '../lib/views/goals';
import { resolvePageContext, withScope } from '../lib/page-context';
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
import { formatCount, formatInstant, titleCase } from '../lib/format';
import type { GoalStatus } from '@/modules/goals/contract';

export const dynamic = 'force-dynamic';

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const resolution = await resolvePageContext(params);
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const status: GoalStatus = params['status'] === 'archived' ? 'archived' : 'active';
  const view = await buildGoalsView(resolution.context, status);

  return (
    <>
      <SurfaceHeader
        title="Goals"
        description="Versioned management goals: desired state, metrics and thresholds, horizon, owner and priority. Goal changes are auditable — every version records who, when, what and why."
        meta={
          <>
            Showing <strong>{status}</strong> goals ·{' '}
            {status === 'active' ? (
              <a href={withScope(params, { status: 'archived' })}>view archived</a>
            ) : (
              <a href={withScope(params, { status: null })}>view active</a>
            )}
            {' · '}Generated {formatInstant(view.generatedAt)}
          </>
        }
      />
      <StatTiles
        items={[
          { label: `${titleCase(status)} goals`, value: formatCount(view.total, view.capped) },
        ]}
      />
      <Card title={`${titleCase(status)} goals`} meta={`${view.goals.length} shown`}>
        {view.goals.length === 0 ? (
          <Empty
            title={`No ${status} goals`}
            hint="Goals are the basis for prioritizing Aurum's learning effort."
          />
        ) : (
          <ul className="item-list">
            {view.goals.map((goal) => (
              <li key={goal.id}>
                <ItemHead
                  title={goal.content.title}
                  badges={
                    <>
                      <StatusBadge status={goal.content.priority} />
                      <StatusBadge status={goal.content.status} />
                      <Badge kind="muted">v{goal.version}</Badge>
                    </>
                  }
                />
                <ItemText>{goal.content.objective}</ItemText>
                <ItemText>
                  <strong>Desired state:</strong> {goal.content.desiredState}
                </ItemText>
                {goal.content.metrics.length === 0 ? null : (
                  <ItemText>
                    <strong>Metrics:</strong>{' '}
                    {goal.content.metrics
                      .map((metric) => {
                        const target =
                          metric.direction === 'in_range'
                            ? `${metric.lowerBound ?? '…'}–${metric.upperBound ?? '…'}`
                            : `${metric.threshold ?? '…'}`;
                        const unit = metric.unit === null ? '' : ` ${metric.unit}`;
                        return `${metric.name} ${metric.direction.replace('_', ' ')} ${target}${unit}`;
                      })
                      .join(' · ')}
                  </ItemText>
                )}
                <ItemFoot>
                  <span>
                    owner: {goal.content.owner.label ?? goal.content.owner.id ?? goal.content.owner.kind}
                  </span>
                  <span>
                    horizon: {formatInstant(goal.content.horizon.start ?? goal.createdAt)} →{' '}
                    {formatInstant(goal.content.horizon.end)}
                  </span>
                  <span>updated {formatInstant(goal.updatedAt)}</span>
                  <span className="mono">{goal.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
