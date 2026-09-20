// Management Control Tower (W033) — the Risks surface.
//
// Risk exposure from three derived-intelligence surfaces (each labeled
// with its source module): the loop's recorded risk findings on
// cognition traces, retained open contradictions between evidence, and
// unmet capability demand. Derived intelligence — never authoritative
// state (lock 34).

import { buildRisksView } from '../lib/views/risks';
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
import { formatInstant, joinList, titleCase } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function RisksPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildRisksView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Risks"
        description="Recorded risk findings from the intelligence loop, conflicting evidence retained as open contradictions, and capabilities whose demand is not met. Each section names its source — everything here is derived from evidence, never asserted as authoritative truth."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'Risk findings', value: view.findings.length, hint: 'cognition traces' },
          { label: 'Open contradictions', value: view.contradictions.length, hint: 'epistemics' },
          { label: 'Unmet capability demand', value: view.capabilityGaps.length, hint: 'capability graph' },
        ]}
      />
      <Card title="Risk findings" meta="source: cognitive executions (risk/opportunity/capability stage)">
        {view.findings.length === 0 ? (
          <Empty
            title="No risk findings recorded"
            hint="The loop records findings with their evidence and affected goals; first-class risk objects arrive with the environment/opportunity modules."
          />
        ) : (
          <ul className="item-list">
            {view.findings.map((finding, index) => (
              <li key={`${finding.executionId}-${index}`}>
                <ItemHead title={finding.statement} badges={<StatusBadge status="risk" />} />
                <ItemFoot>
                  <span>
                    evidence: {joinList(finding.evidenceObservationIds.map((id) => id.slice(0, 8)), 3)}
                  </span>
                  <span>
                    affected goals:{' '}
                    {finding.affectedGoalIds.length === 0 ? '—' : joinList(finding.affectedGoalIds.map((id) => id.slice(0, 8)), 3)}
                  </span>
                  <span>detected {formatInstant(finding.detectedAt)}</span>
                  <span className="mono">{finding.executionId}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Open contradictions" meta="source: epistemics — conflicting evidence is retained (lock 12)">
        {view.contradictions.length === 0 ? (
          <Empty title="No open contradictions" />
        ) : (
          <ul className="item-list">
            {view.contradictions.map((contradiction) => (
              <li key={contradiction.id}>
                <ItemHead title={contradiction.note} badges={<StatusBadge status="open" />} />
                <ItemText>
                  {titleCase(contradiction.evidenceA.kind)} vs {titleCase(contradiction.evidenceB.kind)} — both sides stay
                  readable and frozen at registration.
                </ItemText>
                <ItemFoot>
                  <span>detected {formatInstant(contradiction.detectedAt)}</span>
                  <span className="mono">{contradiction.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Unmet capability demand" meta="source: capability graph gap analysis">
        {view.capabilityGaps.length === 0 ? (
          <Empty title="No capability gaps" hint="Every actively demanded capability is covered." />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Gap</th>
                  <th>Unmet requirements</th>
                  <th>Active demand</th>
                  <th>Active supply</th>
                </tr>
              </thead>
              <tbody>
                {view.capabilityGaps.map((gap) => (
                  <tr key={gap.capability.id}>
                    <td>{gap.capability.name}</td>
                    <td>
                      <StatusBadge status={gap.status} />
                    </td>
                    <td>{gap.unmetCount}</td>
                    <td>{gap.activeRequirementCount}</td>
                    <td>{gap.activeSupplyCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-section">
          <h4>Gap legend</h4>
          <p className="item-text">
            <Badge kind="risk">uncovered</Badge> no active supply ·{' '}
            <Badge kind="warn">level_shortfall</Badge> best supply below required level ·{' '}
            <Badge kind="warn">capacity_shortfall</Badge> declared capacity below required
          </p>
        </div>
      </Card>
    </>
  );
}
