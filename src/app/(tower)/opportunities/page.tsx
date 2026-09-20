// Management Control Tower (W033) — the Opportunities surface.
//
// Evidence-backed opportunities from the surfaces that exist at this
// base: the loop's recorded opportunity findings (cognition traces) and
// the capability graph's available alternatives (W017). The first-class
// Opportunity model (W015 — estimated value, confidence, required
// capabilities) is not delivered yet; this surface presents the evidence
// it will be built from.

import { buildOpportunitiesView } from '../lib/views/opportunities';
import { resolvePageContext } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  NotScoped,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatInstant, joinList } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function OpportunitiesPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildOpportunitiesView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Opportunities"
        description="Evidence-backed opportunities recorded by the intelligence loop, plus the capability graph's available alternatives for unmet demand. First-class opportunity objects (estimated value, confidence, required capabilities) arrive with the opportunity engine."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'Opportunity findings', value: view.findings.length, hint: 'cognition traces' },
          {
            label: 'Gap-filling alternatives',
            value: view.alternatives.reduce((sum, item) => sum + item.activeSupplies.length, 0),
            hint: 'capability graph',
          },
        ]}
      />
      <Card title="Opportunity findings" meta="source: cognitive executions">
        {view.findings.length === 0 ? (
          <Empty
            title="No opportunity findings recorded"
            hint="Findings cite their evidence and affected goals — opportunities without evidence do not appear here."
          />
        ) : (
          <ul className="item-list">
            {view.findings.map((finding, index) => (
              <li key={`${finding.executionId}-${index}`}>
                <ItemHead title={finding.statement} badges={<StatusBadge status="opportunity" />} />
                <ItemFoot>
                  <span>
                    evidence: {joinList(finding.evidenceObservationIds.map((id) => id.slice(0, 8)), 3)}
                  </span>
                  <span>
                    affected goals:{' '}
                    {finding.affectedGoalIds.length === 0
                      ? '—'
                      : joinList(finding.affectedGoalIds.map((id) => id.slice(0, 8)), 3)}
                  </span>
                  <span>detected {formatInstant(finding.detectedAt)}</span>
                  <span className="mono">{finding.executionId}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card
        title="Available alternatives for unmet demand"
        meta="source: capability graph — active supplies are alternatives to each other"
      >
        {view.alternatives.length === 0 ? (
          <Empty title="No capability alternatives to show" hint="Alternatives appear when demanded capabilities have gaps." />
        ) : (
          <ul className="item-list">
            {view.alternatives.map((item) => (
              <li key={item.capability.id}>
                <ItemHead
                  title={item.capability.name}
                  badges={
                    <>
                      <StatusBadge status={item.gapStatus} />
                      <Badge kind="muted">{item.unmetCount} unmet</Badge>
                    </>
                  }
                />
                <ItemFoot>
                  <span>
                    {item.activeSupplies.length} active alternative
                    {item.activeSupplies.length === 1 ? '' : 's'} (
                    {joinList(
                      item.activeSupplies.map(
                        (supply) => `${supply.supplier.kind}${supply.supplier.label === null ? '' : `: ${supply.supplier.label}`}`,
                      ),
                      4,
                    )}
                    )
                  </span>
                  {item.retiredSupplies.length === 0 ? null : (
                    <span>
                      {item.retiredSupplies.length} retired (reactivation candidates)
                    </span>
                  )}
                  <span className="mono">{item.capability.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
