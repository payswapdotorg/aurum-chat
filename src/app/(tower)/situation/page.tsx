// Management Control Tower (W033) — the Situation surface.
//
// The current working picture (ARCHITECTURE.md §4): the world model's
// entities and relationships (mutable understanding), active beliefs
// with provenance (versioned working understanding, lock 11), recent
// claims and the open contradictions deliberately retained (lock 12).

import { buildSituationView } from '../lib/views/situation';
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
  SurfaceHeader,
} from '../components/view-ui';
import { formatConfidence, formatInstant } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function SituationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolution = await resolvePageContext(await searchParams);
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildSituationView(resolution.context);

  return (
    <>
      <SurfaceHeader
        title="Situation"
        description="The company's current working picture: world-model entities and relationships, the beliefs that form the working understanding (with provenance), and the conflicting evidence retained rather than merged."
        meta={<>Generated {formatInstant(view.generatedAt)}</>}
      />
      <StatTiles
        items={[
          { label: 'World entities', value: view.world.total },
          { label: 'Relationships', value: view.world.relationshipCount },
          { label: 'Active beliefs', value: view.beliefs.activeCount },
          { label: 'Open contradictions', value: view.contradictions.openCount },
        ]}
      />

      <Card title="World model" meta={`${view.world.total} entities`}>
        {view.world.entities.length === 0 ? (
          <Empty title="No world entities" hint="Reality is immutable; understanding is mutable — this is the mutable half." />
        ) : (
          <div className="tt-wrap">
            <table className="tt">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {view.world.entities.map((entity) => (
                  <tr key={entity.id}>
                    <td>
                      <Badge kind="muted">{entity.kind}</Badge>
                    </td>
                    <td>{entity.name}</td>
                    <td>{entity.description ?? '—'}</td>
                    <td>{formatInstant(entity.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view.world.byKind.length === 0 ? null : (
          <div className="card-section">
            <h4>Entities by kind</h4>
            <p className="item-text">
              {view.world.byKind.map((k) => `${k.kind} (${k.count})`).join(' · ')}
            </p>
          </div>
        )}
      </Card>

      <Card title="Working understanding (beliefs)" meta={`${view.beliefs.activeCount} active`}>
        {view.beliefs.latest.length === 0 ? (
          <Empty title="No active beliefs" hint="Beliefs are versioned statements with provenance, uncertainty and disconfirmation." />
        ) : (
          <ul className="item-list">
            {view.beliefs.latest.map((belief) => (
              <li key={belief.id}>
                <ItemHead
                  title={belief.proposition}
                  badges={
                    <>
                      <Badge kind="info">{formatConfidence(belief.confidence)}</Badge>
                      <Badge kind="muted">v{belief.version}</Badge>
                    </>
                  }
                />
                <ItemFoot>
                  <span>valid from {formatInstant(belief.validFrom)}</span>
                  <span>{belief.provenanceCount} supporting observations</span>
                  <span className="mono">{belief.id}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent claims" meta="derived from evidence">
        {view.claims.length === 0 ? (
          <Empty title="No claims recorded" />
        ) : (
          <ul className="item-list">
            {view.claims.map((claim) => (
              <li key={claim.id}>
                <ItemHead
                  title={claim.proposition}
                  badges={<Badge kind="info">{formatConfidence(claim.confidence)}</Badge>}
                />
                <ItemFoot>
                  <span>{claim.evidenceCount} evidence observations</span>
                  <span>recorded {formatInstant(claim.recordedAt)}</span>
                </ItemFoot>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Retained contradictions"
        meta={`${view.contradictions.openCount} open — never merged`}
      >
        {view.contradictions.latest.length === 0 ? (
          <Empty title="No open contradictions" hint="Contradictory evidence is retained, not merged away." />
        ) : (
          <ul className="item-list">
            {view.contradictions.latest.map((contradiction) => (
              <li key={contradiction.id}>
                <ItemHead title={contradiction.note} />
                <ItemText>
                  {contradiction.evidenceA.kind} vs {contradiction.evidenceB.kind} — the two
                  evidence sides stay readable and frozen at registration.
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
    </>
  );
}
