// Management Control Tower (W033) — the Automation surface.
//
// Lock 19: process intelligence creates explicit automation findings.
// The automation module (W018 — AutomationOpportunity records with
// candidate solution types, expected ROI and outcome measurement) is not
// delivered at this base; this surface presents the W016 process
// findings automation candidates are built from, with their evidence.

import { buildAutomationView } from '../lib/views/automation';
import { requireTowerScope } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  ItemFoot,
  ItemHead,
  Notice,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { formatConfidence, formatInstant, titleCase } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function AutomationPage() {
  // W058: authenticated routing — the session carries the tenant scope.
  const scope = await requireTowerScope('/automation');
  const view = await buildAutomationView(scope.context);

  return (
    <>
      <SurfaceHeader
        title="Automation"
        description="Automation candidates from process intelligence: manual effort, duplication and bottlenecks observed in reconstructed flows — the evidence the automation module builds opportunity records from."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      {view.notices.map((notice) => (
        <Notice key={notice}>{notice}</Notice>
      ))}
      <StatTiles
        items={[
          { label: 'Candidates', value: view.candidates.length, hint: 'manual effort · duplication · bottlenecks' },
          { label: 'Manual effort findings', value: view.totalsByKind.manual_effort },
          { label: 'Duplication findings', value: view.totalsByKind.duplication },
          { label: 'Bottleneck findings', value: view.totalsByKind.bottleneck },
          { label: 'Uncovered capabilities', value: view.capabilityGaps.length, hint: 'potential automation demand' },
        ]}
      />
      <Card title="Automation candidates" meta="W016 findings — evidence-cited">
        {view.candidates.length === 0 ? (
          <Empty
            title="No automation candidates"
            hint="Candidates appear when reconstruction detects manual effort, duplication or bottlenecks."
          />
        ) : (
          <ul className="item-list">
            {view.candidates.map((candidate) => (
              <li key={candidate.finding.id}>
                <ItemHead
                  title={candidate.finding.summary}
                  badges={
                    <>
                      <StatusBadge status={candidate.finding.kind} />
                      <Badge kind="muted">{formatConfidence(candidate.finding.confidence)}</Badge>
                    </>
                  }
                />
                <ItemFoot>
                  <span>process: {candidate.processName}</span>
                  <span>subject: {candidate.finding.subject}</span>
                  <span>
                    {candidate.finding.evidenceEventIds.length} events ·{' '}
                    {candidate.finding.evidenceObservationIds.length} observations cited
                  </span>
                  <span>detected {formatInstant(candidate.finding.detectedAt)}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Uncovered capabilities" meta="demand automation could supply">
        {view.capabilityGaps.length === 0 ? (
          <Empty title="No uncovered capabilities" />
        ) : (
          <ul className="item-list">
            {view.capabilityGaps.map((gap) => (
              <li key={gap.capability.id}>
                <ItemHead
                  title={gap.capability.name}
                  badges={<StatusBadge status={gap.status} />}
                />
                <ItemFoot>
                  <span>
                    {gap.unmetCount} unmet requirement{gap.unmetCount === 1 ? '' : 's'}
                  </span>
                  <span className="mono">{gap.capability.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
        <div className="card-section">
          <h4>Kind legend</h4>
          <p className="item-text">
            <StatusBadge status="manual_effort" /> {titleCase('manual_effort')} — human-performed
            activity in the flow · <StatusBadge status="duplication" /> repeated activity across
            actors · <StatusBadge status="bottleneck" /> wait-time heavy edges
          </p>
        </div>
      </Card>
    </>
  );
}
