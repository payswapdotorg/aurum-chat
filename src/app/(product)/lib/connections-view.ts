// Product shell (W057) — the Connections hub's view builder.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §4 (W059) owns the full connection
// center (connect/disconnect/configure, health, identity linking,
// checkpoints, delivery state). W057's hub is the shell-level summary: one
// honest read per gateway family — channels, sources, destinations —
// through their contracts, so the area shows REAL state (or its real
// absence) instead of pretending. Each family degrades independently;
// a failed read renders the quiet error pattern, never fake emptiness.

import type { TenantContext } from '@/infra/tenant';
import { listChannelConnections } from '@/modules/channels/contract';
import type { ChannelConnection } from '@/modules/channels/contract';
import { listDestinations } from '@/modules/destinations/contract';
import type { Destination } from '@/modules/destinations/contract';
import { listSources } from '@/modules/sources/contract';
import type { Source } from '@/modules/sources/contract';
import { connectionStatusLabel, connectionStatusTone } from './states';
import type { PillTone } from './states';

/** How many items per family the summary carries (the hub is not a list UI). */
export const CONNECTIONS_FAMILY_LIMIT = 8;

export type ConnectionFamily = 'channels' | 'sources' | 'destinations';

export interface ConnectionItemView {
  id: string;
  provider: string;
  label: string;
  status: string;
  statusLabel: string;
  tone: PillTone;
  updatedAt: string;
}

export interface ConnectionGroupView {
  family: ConnectionFamily;
  title: string;
  blurb: string;
  ok: boolean;
  reason: string | null;
  count: number;
  items: ConnectionItemView[];
}

export interface ConnectionsView {
  generatedAt: string;
  groups: ConnectionGroupView[];
}

function toItemView(
  item: ChannelConnection | Source | Destination,
): ConnectionItemView {
  return {
    id: item.id,
    provider: item.provider,
    label:
      item.displayName === null || item.displayName === ''
        ? item.providerAccountId
        : item.displayName,
    status: item.status,
    statusLabel: connectionStatusLabel(item.status),
    tone: connectionStatusTone(item.status),
    updatedAt: item.updatedAt,
  };
}

async function family(
  ctx: TenantContext,
  view: Omit<ConnectionGroupView, 'ok' | 'reason' | 'count' | 'items'>,
  read: () => Promise<(ChannelConnection | Source | Destination)[]>,
): Promise<ConnectionGroupView> {
  try {
    const items = (await read()).slice(0, CONNECTIONS_FAMILY_LIMIT).map(toItemView);
    return { ...view, ok: true, reason: null, count: items.length, items };
  } catch {
    return { ...view, ok: false, reason: 'unavailable', count: 0, items: [] };
  }
}

/** Build the three-family connections summary for one tenant. */
export async function buildConnectionsView(
  ctx: TenantContext,
): Promise<ConnectionsView> {
  const [channels, sources, destinations] = await Promise.all([
    family(
      ctx,
      {
        family: 'channels',
        title: 'Channels',
        blurb: 'Where people talk to Aurum — chat apps, email, SMS and voice.',
      },
      async () =>
        listChannelConnections(ctx, { limit: CONNECTIONS_FAMILY_LIMIT }),
    ),
    family(
      ctx,
      {
        family: 'sources',
        title: 'Source systems',
        blurb: 'Where company truth arrives from — CRM, tickets, files, finance.',
      },
      async () => listSources(ctx, { limit: CONNECTIONS_FAMILY_LIMIT }),
    ),
    family(
      ctx,
      {
        family: 'destinations',
        title: 'Destinations',
        blurb: 'Where intelligence flows out — BI, warehouses, spreadsheets, webhooks.',
      },
      async () => listDestinations(ctx, { limit: CONNECTIONS_FAMILY_LIMIT }),
    ),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    groups: [channels, sources, destinations],
  };
}
