// Product shell (W057) — the Connections area.
//
// The connections hub reads REAL state: one summary per gateway family
// (channels, sources, destinations) through their contracts, so the area
// shows what is actually connected — or the honest empty/error state per
// family. The full connection center (connect/disconnect/configure,
// health, identity linking, checkpoints, delivery state) is W059's scope;
// this hub is its shell home with live data.

import { productContextFromSearchParams } from '../lib/context';
import type { PageSearchParams } from '../lib/context';
import { buildConnectionsView } from '../lib/connections-view';
import type { ConnectionGroupView } from '../lib/connections-view';
import {
  EmptyState,
  ErrorState,
  NotScoped,
  PageHead,
  Panel,
  StatusPill,
  Tag,
} from '../components/states';

export const dynamic = 'force-dynamic';

function FamilyPanel({ group }: { group: ConnectionGroupView }) {
  return (
    <Panel title={group.title} blurb={group.blurb} meta={`${group.count} shown`}>
      {!group.ok ? (
        <ErrorState
          title="Read failed"
          detail={`This family's connections could not be read right now. The connect/disconnect experience keeps working from here once the read recovers.`}
        />
      ) : group.items.length === 0 ? (
        <EmptyState
          title={`No ${group.title.toLowerCase()} yet`}
          hint="Connecting a channel, source or destination registers it here with its provider and status."
        />
      ) : (
        <ul className="aurum-item-list">
          {group.items.map((item) => (
            <li key={item.id}>
              <div className="aurum-item-head">
                <span className="aurum-item-title">{item.label}</span>
                <StatusPill tone={item.tone}>{item.statusLabel}</StatusPill>
              </div>
              <div className="aurum-item-foot">
                <span>{item.provider}</span>
                <span className="aurum-mono">{item.id}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="aurum-conn-providers">
        <Tag>connect · disconnect · configure</Tag>
        <Tag>health</Tag>
        <Tag>identity linking</Tag>
        <Tag>freshness &amp; delivery state</Tag>
      </div>
    </Panel>
  );
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  const resolution = productContextFromSearchParams(params);
  if (!resolution.ok) {
    return <NotScoped detail={resolution.detail} />;
  }
  const view = await buildConnectionsView(resolution.resolved.context);

  return (
    <>
      <PageHead
        title="Connections"
        description="Where Aurum touches the outside world: the channels people talk on, the systems company truth arrives from, and the destinations intelligence flows out to. Credentials stay tenant-owned, opaque references — never stored in memory or transcripts."
        meta={<span>Live read · generated {view.generatedAt}</span>}
      />
      {view.groups.map((group) => (
        <FamilyPanel key={group.family} group={group} />
      ))}
    </>
  );
}
