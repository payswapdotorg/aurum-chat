// Management Control Tower (W033) — the Evidence surface.
//
// Immutable observations with full provenance (W004, lock 5): source,
// channel, observed/recorded times, lineage, permissions and confidence.
// The tower lists evidence through the observations contract only — no
// mutation, no promotion, no verification (lock 10: observations are
// never authoritative truth).

import { buildEvidenceView } from '../lib/views/evidence';
import { requireTowerScope } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  StatTiles,
  SurfaceHeader,
} from '../components/view-ui';
import { formatConfidence, formatCount, formatInstant, joinList, titleCase } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function EvidencePage() {
  // W058: authenticated routing — the session carries the tenant scope.
  const scope = await requireTowerScope('/evidence');
  const view = await buildEvidenceView(scope.context);

  return (
    <>
      <SurfaceHeader
        title="Evidence"
        description="The immutable observation record: every business datum Aurum has perceived, with source, channel, timestamps, extraction lineage, permissions and confidence. Corrections and contradictions are new observations — nothing here is ever edited, merged away or promoted to truth."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'Observations (latest)', value: formatCount(view.total, view.capped) },
          {
            label: 'Distinct kinds',
            value: view.byKind.length,
            hint: joinList(view.byKind.slice(0, 4).map((k) => k.kind), 4),
          },
        ]}
      />
      <Card title="Observation feed" meta={`${formatCount(view.total, view.capped)} latest · newest first`}>
        {view.items.length === 0 ? (
          <Empty title="No observations recorded" hint="The loop's observation stage ingests the evidence every cycle stands on." />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Channel</th>
                  <th>Source</th>
                  <th>Observed</th>
                  <th>Recorded</th>
                  <th>Confidence</th>
                  <th>Visibility</th>
                  <th>Lineage</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.kind}</td>
                    <td>
                      <Badge kind="muted">{item.channel}</Badge>
                    </td>
                    <td>
                      {titleCase(item.source.kind)}
                      {item.source.label === null ? '' : ` — ${item.source.label}`}
                    </td>
                    <td>{formatInstant(item.observedAt)}</td>
                    <td>{formatInstant(item.recordedAt)}</td>
                    <td>{formatConfidence(item.confidence.value)}</td>
                    <td>{item.visibility}</td>
                    <td>{item.lineageMethod === null ? '—' : titleCase(item.lineageMethod)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
