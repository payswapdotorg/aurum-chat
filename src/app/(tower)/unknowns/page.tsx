// Management Control Tower (W033) — the Unknowns surface.
//
// Unknown is first-class (lock 7): a question Aurum cannot answer plus
// the consequence of the gap. The tower lists the open knowledge debt
// and recently resolved gaps, through the epistemics contract only.

import { buildUnknownsView } from '../lib/views/unknowns';
import { requireTowerScope } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  ItemText,
  StatTiles,
  SurfaceHeader,
} from '../components/view-ui';
import { formatCount, formatInstant } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function UnknownsPage() {
  // W058: authenticated routing — the session carries the tenant scope.
  const scope = await requireTowerScope('/unknowns');
  const view = await buildUnknownsView(scope.context);

  return (
    <>
      <SurfaceHeader
        title="Unknowns"
        description="Consequential gaps in knowledge: the question Aurum cannot answer, and why not knowing it matters. Open unknowns are the tenant's knowledge debt; material ones become learning missions."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          {
            label: 'Open unknowns',
            value: formatCount(view.open.total, view.open.capped),
          },
          { label: 'Recently resolved', value: view.resolved.total },
        ]}
      />
      <Card title="Open unknowns" meta={`${formatCount(view.open.total, view.open.capped)} open`}>
        {view.open.items.length === 0 ? (
          <Empty title="No open unknowns" hint="A gap without consequence is not first-class — these all have one." />
        ) : (
          <ul className="item-list">
            {view.open.items.map((unknown) => (
              <li key={unknown.id}>
                <ItemHead
                  title={unknown.question}
                  badges={
                    unknown.subject === null ? undefined : (
                      <Badge kind="muted">{unknown.subject.kind}</Badge>
                    )
                  }
                />
                <ItemText>
                  <strong>Why it matters:</strong> {unknown.consequence}
                </ItemText>
                <ItemFoot>
                  <span>
                    bounded by {unknown.related.observations} observations ·{' '}
                    {unknown.related.claims} claims · {unknown.related.beliefs} beliefs
                  </span>
                  <span>recorded {formatInstant(unknown.recordedAt)}</span>
                  <span className="mono">{unknown.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recently resolved" meta="how the gaps were closed">
        {view.resolved.items.length === 0 ? (
          <Empty title="No resolved unknowns yet" />
        ) : (
          <ul className="item-list">
            {view.resolved.items.map((unknown) => (
              <li key={unknown.id}>
                <ItemHead title={unknown.question} />
                {unknown.resolutionNote === null ? null : (
                  <ItemText>{unknown.resolutionNote}</ItemText>
                )}
                <ItemFoot>
                  <span>resolved {formatInstant(unknown.resolvedAt ?? unknown.recordedAt)}</span>
                  <span className="mono">{unknown.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
