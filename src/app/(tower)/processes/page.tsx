// Management Control Tower (W033) — the Processes surface.
//
// Process intelligence (W016): reconstructed flows with deterministic
// findings — bottlenecks, duplication, handoffs, manual effort, errors —
// each citing the event/observation evidence that justifies it.

import { buildProcessesView } from '../lib/views/processes';
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
import { formatConfidence, formatCount, formatDuration, formatInstant, formatShare } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function ProcessesPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildProcessesView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Processes"
        description="How work actually happens, reconstructed from immutable events and observations: steps, flow variants and statistics, plus the deterministic findings — bottlenecks, duplication, handoffs, manual effort and errors — with the evidence that justifies each."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'Reconstructed processes', value: formatCount(view.total, view.capped) },
          {
            label: 'Findings (current versions)',
            value: view.processes.reduce(
              (sum, p) =>
                sum +
                p.findingCounts.bottleneck +
                p.findingCounts.duplication +
                p.findingCounts.handoff +
                p.findingCounts.manualEffort +
                p.findingCounts.error,
              0,
            ),
          },
        ]}
      />
      <Card title="Processes" meta={`${formatCount(view.total, view.capped)} current reconstructions`}>
        {view.processes.length === 0 ? (
          <Empty title="No processes reconstructed" hint="Reconstruction derives flows from events and observations." />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>v</th>
                  <th>Cases</th>
                  <th>Occurrences</th>
                  <th>Manual share</th>
                  <th>Avg duration</th>
                  <th>Findings</th>
                </tr>
              </thead>
              <tbody>
                {view.processes.map((process) => {
                  const total =
                    process.findingCounts.bottleneck +
                    process.findingCounts.duplication +
                    process.findingCounts.handoff +
                    process.findingCounts.manualEffort +
                    process.findingCounts.error;
                  return (
                    <tr key={process.id}>
                      <td>{process.name}</td>
                      <td>{process.version}</td>
                      <td>{process.stats.caseCount}</td>
                      <td>{process.stats.occurrenceCount}</td>
                      <td>{formatShare(process.stats.manualShare)}</td>
                      <td>
                        {process.stats.avgCaseDurationSeconds === null
                          ? '—'
                          : formatDuration(process.stats.avgCaseDurationSeconds)}
                      </td>
                      <td>
                        {total === 0 ? (
                          <Badge kind="ok">clean</Badge>
                        ) : (
                          <Badge kind="warn">{total}</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Latest findings" meta="deterministic, evidence-cited">
        {view.latestFindings.length === 0 ? (
          <Empty title="No findings" hint="Findings describe how work flows — never how a person performs." />
        ) : (
          <ul className="item-list">
            {view.latestFindings.map((item) => (
              <li key={item.finding.id}>
                <ItemHead
                  title={item.finding.summary}
                  badges={
                    <>
                      <StatusBadge status={item.finding.kind} />
                      <Badge kind="muted">{formatConfidence(item.finding.confidence)}</Badge>
                    </>
                  }
                />
                <ItemFoot>
                  <span>process: {item.processName}</span>
                  <span>
                    {item.finding.evidenceEventIds.length} events ·{' '}
                    {item.finding.evidenceObservationIds.length} observations cited
                  </span>
                  <span>subject: {item.finding.subject}</span>
                  <span>detected {formatInstant(item.finding.detectedAt)}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
