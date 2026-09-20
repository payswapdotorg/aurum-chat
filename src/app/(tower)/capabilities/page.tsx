// Management Control Tower (W033) — the Capabilities surface.
//
// The capability graph (W017): active capabilities joined with the
// module's deterministic gap analysis (recomputed per read, never
// persisted — lock 10). Supplies come from the six supplier kinds —
// employee, team, agent, software, supplier, partner.

import { buildCapabilitiesView } from '../lib/views/capabilities';
import { requireTowerScope } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatCount, formatInstant, joinList } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function CapabilitiesPage() {
  // W058: authenticated routing — the session carries the tenant scope.
  const scope = await requireTowerScope('/capabilities');
  const view = await buildCapabilitiesView(scope.context);

  const gapped = view.capabilities.filter((c) => c.gapStatus !== 'covered' && c.gapStatus !== 'no_demand');
  const covered = view.capabilities.filter((c) => c.gapStatus === 'covered');

  return (
    <>
      <SurfaceHeader
        title="Capabilities"
        description="What the company can do, who supplies it (employees, teams, agents, software, suppliers, partners), what demands it and where the gaps are. Gaps and alternatives are recomputed from current records on every read."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'Active capabilities', value: formatCount(view.total, view.capped) },
          { label: 'With gaps', value: gapped.length },
          { label: 'Covered (demanded)', value: covered.length },
        ]}
      />
      <Card title="Capability graph" meta={`${formatCount(view.total, view.capped)} active`}>
        {view.capabilities.length === 0 ? (
          <Empty title="No capabilities registered" />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Gap status</th>
                  <th>Demand</th>
                  <th>Supply</th>
                  <th>Best level</th>
                  <th>Supplied by</th>
                </tr>
              </thead>
              <tbody>
                {view.capabilities.map((capability) => (
                  <tr key={capability.id}>
                    <td>{capability.name}</td>
                    <td>
                      {capability.gapStatus === 'no_demand' ? (
                        <Badge kind="muted">no demand</Badge>
                      ) : (
                        <StatusBadge status={capability.gapStatus} />
                      )}
                    </td>
                    <td>{capability.activeRequirementCount}</td>
                    <td>{capability.activeSupplyCount}</td>
                    <td>{capability.bestActiveLevel ?? '—'}</td>
                    <td>
                      {joinList(
                        Object.entries(capability.alternatives.activeByKind)
                          .filter(([, count]) => count > 0)
                          .map(([kind, count]) => `${count} ${kind}`),
                        6,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-section">
          <h4>Gap legend</h4>
          <p className="item-text">
            <Badge kind="risk">uncovered</Badge> demanded, no active supply ·{' '}
            <Badge kind="warn">level_shortfall</Badge> best supply below a required level ·{' '}
            <Badge kind="warn">capacity_shortfall</Badge> declared capacity below a required
            capacity · <Badge kind="ok">covered</Badge> demand met ·{' '}
            <Badge kind="muted">no demand</Badge> nothing actively requires it
          </p>
        </div>
      </Card>
      {gapped.length === 0 ? null : (
        <Card title="Unmet demand detail" meta={`${gapped.length} capabilities with gaps`}>
          <ul className="item-list">
            {gapped.map((capability) => (
              <li key={capability.id}>
                <div className="item-head">
                  <span className="item-title">{capability.name}</span>
                  <StatusBadge status={capability.gapStatus} />
                </div>
                <div className="item-foot">
                  <span>
                    {capability.unmetCount} unmet requirement
                    {capability.unmetCount === 1 ? '' : 's'}
                  </span>
                  <span>{capability.activeSupplyCount} active supplies</span>
                  <span className="mono">{capability.id}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
