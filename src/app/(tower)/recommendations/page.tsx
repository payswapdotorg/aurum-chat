// Management Control Tower (W033) — the Recommendations surface.
//
// The routed action feed (W009, ARCHITECTURE.md §20): every consequential
// action proposed to the authority matrix — OBSERVE / ANALYZE /
// RECOMMEND / ASK / PROPOSE / EXECUTE — with the deterministic
// evaluation snapshot that routed it. Requests are immutable history;
// decisions happen on the Approvals surface.

import { buildRecommendationsView } from '../lib/views/recommendations';
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
import { formatCount, formatInstant, titleCase } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function RecommendationsPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildRecommendationsView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Recommendations"
        description="Every consequential action routed through the authority matrix, with the deterministic evaluation that routed it: allowed, forbidden, or approval-required. Requests are immutable history the moment they are recorded — a changed proposal is a new request."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'Action requests (latest)', value: formatCount(view.total, view.capped) },
          { label: 'Pending', value: view.byStatus.find((s) => s.status === 'pending')?.count ?? 0 },
          { label: 'Approved', value: view.byStatus.find((s) => s.status === 'approved')?.count ?? 0 },
          { label: 'Rejected', value: view.byStatus.find((s) => s.status === 'rejected')?.count ?? 0 },
        ]}
      />
      <Card title="Action requests" meta={`${formatCount(view.total, view.capped)} latest · newest first`}>
        {view.items.length === 0 ? (
          <Empty
            title="No action requests"
            hint="The loop's recommendation stage proposes one consequential action per cycle; the matrix routes it."
          />
        ) : (
          <ul className="item-list">
            {view.items.map((item) => (
              <li key={item.id}>
                <ItemHead
                  title={titleCase(item.actionKind)}
                  badges={
                    <>
                      <Badge kind="accent">{item.authorityLevel}</Badge>
                      <StatusBadge status={item.status} />
                      <Badge kind="muted">{titleCase(item.evaluation.outcome)}</Badge>
                    </>
                  }
                />
                {item.justification === null ? null : <ItemText>{item.justification}</ItemText>}
                <ItemFoot>
                  <span>
                    routed via {item.evaluation.resolvedVia}
                    {item.evaluation.policy === null || item.evaluation.policy.actionKind === null
                      ? ''
                      : ` (${item.evaluation.policy.actionKind})`}
                  </span>
                  <span>requested {formatInstant(item.requestedAt)}</span>
                  {item.decidedAt === null ? null : <span>decided {formatInstant(item.decidedAt)}</span>}
                  <span className="mono">{item.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
