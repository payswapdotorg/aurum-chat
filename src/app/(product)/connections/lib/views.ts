// Connection & Integration Hub (W059) — the read model.
//
// `buildConnectionsView` composes the four domain contracts the hub is
// allowed to consume (channels W030, sources W036, destinations W037,
// identity/people W002) plus the freshness module's canonical source
// classification (W006) and the conversations transcript (W029 — the only
// legal window onto "which identities have been active on which channels").
// The hub is a DERIVED surface: it records nothing, decides nothing and
// becomes no second source of organizational truth (plan §10) — every fact
// shown is read straight from a contract.
//
// Composition notes (honest limits surfaced as `notices`):
//   * channel "activity" is the newest transcript turn per provider, read
//     through the conversations contract — the channels contract itself
//     exposes no activity listing;
//   * channel identities are DISCOVERED from that same recent-transcript
//     window (inbound turns carry their identity reference); the identity
//     contract exposes no tenant-wide identity enumeration, so identities
//     outside the window are reachable through the explicit provider+account
//     lookup (see actions.ts / the page's lookup form);
//   * a subject linked to a verified identity is resolved to its person
//     record through the people contract when possible, and stays an opaque
//     id otherwise (the tower's honest-degradation discipline).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  getChannelTransport,
  listChannelConnections,
} from '@/modules/channels/contract';
import type { ChannelConnection, ChannelProvider } from '@/modules/channels/contract';
import {
  getSourceCheckpoint,
  listSourceCheckpoints,
  listSources,
} from '@/modules/sources/contract';
import type { Source, SourceCheckpoint, SourceCheckpointEntry } from '@/modules/sources/contract';
import {
  listDeliveries,
  listDestinations,
} from '@/modules/destinations/contract';
import type { Delivery, Destination } from '@/modules/destinations/contract';
import {
  evaluateSourceFreshness,
} from '@/modules/freshness/contract';
import type { SourceFreshness } from '@/modules/freshness/contract';
import {
  findExternalIdentityByProviderKey,
  getExternalIdentity,
} from '@/modules/identity/contract';
import type { ExternalIdentity } from '@/modules/identity/contract';
import { getPerson } from '@/modules/people/contract';
import type { Person } from '@/modules/people/contract';
import { listMessages } from '@/modules/conversations/contract';
import type { Message } from '@/modules/conversations/contract';

import {
  channelCatalog,
  sourceCatalog,
  destinationCatalog,
  destinationCategoryOf,
} from './catalog';
import type { CatalogEntry } from './catalog';
import {
  channelHealth,
  countByLevel,
  destinationHealth,
  sourceHealth,
  type DestinationDeliverySummary,
  type Health,
} from './health';

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** How many recent transcript turns per channel the identity window reads. */
export const IDENTITY_DISCOVERY_WINDOW = 50;

export interface ChannelCard {
  kind: 'channel';
  provider: ChannelProvider;
  label: string;
  description: string;
  accountIdHint: string;
  connection: {
    id: string;
    providerAccountId: string;
    displayName: string | null;
    credentialRef: string;
    status: 'active' | 'disabled';
    createdAt: string;
    updatedAt: string;
  } | null;
  /** Delivery transport wired for this provider (process state, honest dev signal). */
  transportWired: boolean;
  lastActivityAt: string | null;
  /** Inbound identities seen in the discovery window on this provider. */
  identitiesSeen: number;
  health: Health;
}

export interface SourceCard {
  kind: 'source';
  id: string;
  provider: string;
  label: string;
  providerAccountId: string;
  displayName: string | null;
  authKind: 'oauth' | 'credentials';
  credentialRef: string;
  oauthScopes: string[];
  oauthExpiresAt: string | null;
  status: 'active' | 'disabled';
  modes: ('polling' | 'webhook')[];
  createdAt: string;
  updatedAt: string;
  checkpoint: { cursor: string | null; updatedAt: string } | null;
  recentCheckpoints: { id: string; cursor: string | null; origin: 'poll' | 'replay'; recordedAt: string }[];
  freshness: {
    status: 'current' | 'aging' | 'stale' | 'unknown';
    latestObservedAt: string | null;
    ageSeconds: number | null;
    maxLatencySeconds: number | null;
    observationsConsidered: number;
  };
  health: Health;
}

export interface DestinationCard {
  kind: 'destination';
  id: string;
  provider: string;
  label: string;
  category: string;
  providerAccountId: string;
  displayName: string | null;
  authKind: 'oauth' | 'credentials';
  credentialRef: string;
  oauthScopes: string[];
  oauthExpiresAt: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  deliveries: DestinationDeliverySummary & { latest: { id: string; kind: string; status: string; requestedAt: string; updatedAt: string } | null };
  health: Health;
}

export interface IdentityCard {
  id: string;
  provider: string;
  label: string;
  providerAccountId: string;
  displayName: string | null;
  status: 'unverified' | 'pending' | 'verified' | 'revoked';
  verificationMethod: string | null;
  verifiedAt: string | null;
  revokedReason: string | null;
  subject: { id: string; fullName: string; resolvable: boolean } | null;
  linkedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  discovered: boolean;
}

export interface ConnectionsView {
  generatedAt: string;
  tenantId: string;
  channels: {
    cards: ChannelCard[];
    catalogSize: number;
    connected: number;
    active: number;
    byLevel: ReturnType<typeof countByLevel>;
  };
  sources: {
    cards: SourceCard[];
    connected: number;
    active: number;
    byLevel: ReturnType<typeof countByLevel>;
  };
  destinations: {
    cards: DestinationCard[];
    connected: number;
    active: number;
    byLevel: ReturnType<typeof countByLevel>;
  };
  identities: {
    cards: IdentityCard[];
    byStatus: Record<'unverified' | 'pending' | 'verified' | 'revoked', number>;
    discoveryWindow: number;
    /** Explicit lookup result (provider+account form), when requested. */
    lookup: IdentityCard | null;
    lookupMiss: string | null;
  };
  catalog: {
    channels: CatalogEntry[];
    sources: CatalogEntry[];
    destinations: { category: string; label: string; entries: CatalogEntry[] }[];
  };
  notices: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelFrom(catalog: CatalogEntry[], key: string): string {
  return catalog.find((entry) => entry.key === key)?.label ?? key;
}

async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Newest turns + distinct inbound identity ids for one provider (contract window). */
async function channelActivity(
  ctx: TenantContext,
  provider: ChannelProvider,
): Promise<{ lastActivityAt: string | null; identityIds: string[]; identityLastSeen: Map<string, string> }> {
  const messages: Message[] = await safely(
    () => listMessages(ctx, { channel: provider, order: 'desc', limit: IDENTITY_DISCOVERY_WINDOW }),
    [],
  );
  const identityLastSeen = new Map<string, string>();
  let lastActivityAt: string | null = null;
  for (const message of messages) {
    if (lastActivityAt === null) lastActivityAt = message.recordedAt;
    const identityId = message.actor.identityId;
    if (identityId !== null && !identityLastSeen.has(identityId)) {
      identityLastSeen.set(identityId, message.recordedAt);
    }
  }
  return {
    lastActivityAt,
    identityIds: [...identityLastSeen.keys()],
    identityLastSeen,
  };
}

function summarizeDeliveries(deliveries: Delivery[]): DestinationDeliverySummary & {
  latest: { id: string; kind: string; status: string; requestedAt: string; updatedAt: string } | null;
} {
  const summary: DestinationDeliverySummary & {
    latest: { id: string; kind: string; status: string; requestedAt: string; updatedAt: string } | null;
  } = {
    total: deliveries.length,
    pending: 0,
    delivered: 0,
    failed: 0,
    rejected: 0,
    lastStatus: null,
    lastAt: null,
    latest: null,
  };
  for (const delivery of deliveries) {
    switch (delivery.status) {
      case 'pending':
        summary.pending += 1;
        break;
      case 'delivered':
        summary.delivered += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'rejected':
        summary.rejected += 1;
        break;
    }
  }
  if (deliveries.length > 0) {
    // listDeliveries returns newest-first (recorded ordering); trust the first row.
    const newest = deliveries[0]!;
    summary.lastStatus = newest.status;
    summary.lastAt = newest.updatedAt;
    summary.latest = {
      id: newest.id,
      kind: newest.kind,
      status: newest.status,
      requestedAt: newest.requestedAt,
      updatedAt: newest.updatedAt,
    };
  }
  return summary;
}

async function identityCard(
  ctx: TenantContext,
  identity: ExternalIdentity,
  lastSeenAt: string | null,
  discovered: boolean,
): Promise<IdentityCard> {
  let subject: { id: string; fullName: string; resolvable: boolean } | null = null;
  const subjectId = identity.subjectId;
  if (subjectId !== null) {
    const person: Person | null = await safely(() => getPerson(ctx, subjectId), null);
    subject = {
      id: subjectId,
      fullName: person?.fullName ?? subjectId,
      resolvable: person !== null,
    };
  }
  return {
    id: identity.id,
    provider: identity.provider,
    label: labelFrom(channelCatalog(), identity.provider),
    providerAccountId: identity.providerAccountId,
    displayName: identity.displayName,
    status: identity.status,
    verificationMethod: identity.verificationMethod,
    verifiedAt: identity.verifiedAt,
    revokedReason: identity.revokedReason,
    subject,
    linkedAt: identity.linkedAt,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    lastSeenAt,
    discovered,
  };
}

// ---------------------------------------------------------------------------
// The view builder
// ---------------------------------------------------------------------------

export interface ConnectionsViewOptions {
  /** Explicit identity lookup (provider + account) requested by the page. */
  identityLookup?: { provider: string; providerAccountId: string } | null;
}

export async function buildConnectionsView(
  ctx: TenantContext,
  options: ConnectionsViewOptions = {},
): Promise<ConnectionsView> {
  const generatedAt = now().toISOString();

  const [channelConnections, sources, destinations] = await Promise.all([
    listChannelConnections(ctx, { limit: 500 }),
    listSources(ctx, { limit: 500 }),
    listDestinations(ctx, { limit: 500 }),
  ]);

  // ---- Channels: catalog + connections + transport wiring + activity ----
  const channelsCatalog = channelCatalog();
  const transportWired = getChannelTransport() !== null;
  const providersWithConnections = new Set(channelConnections.map((c) => c.provider));
  const activityByProvider = new Map<ChannelProvider, Awaited<ReturnType<typeof channelActivity>>>();
  for (const provider of providersWithConnections) {
    activityByProvider.set(provider, await channelActivity(ctx, provider));
  }

  const connectionByProvider = new Map<ChannelProvider, ChannelConnection>();
  for (const connection of channelConnections) {
    // First connection per provider is the card's primary; extra endpoints
    // on the same provider are still counted (connected list below).
    if (!connectionByProvider.has(connection.provider)) {
      connectionByProvider.set(connection.provider, connection);
    }
  }

  const channelCards: ChannelCard[] = channelsCatalog.map((entry) => {
    const provider = entry.key as ChannelProvider;
    const connection = connectionByProvider.get(provider) ?? null;
    const activity = activityByProvider.get(provider);
    const health = channelHealth({
      status: connection?.status ?? null,
      transportWired,
      lastActivityAt: activity?.lastActivityAt ?? null,
      now: generatedAt,
    });
    return {
      kind: 'channel',
      provider,
      label: entry.label,
      description: entry.description,
      accountIdHint: entry.accountIdHint,
      connection:
        connection === null
          ? null
          : {
              id: connection.id,
              providerAccountId: connection.providerAccountId,
              displayName: connection.displayName,
              credentialRef: connection.credentialRef,
              status: connection.status,
              createdAt: connection.createdAt,
              updatedAt: connection.updatedAt,
            },
      transportWired,
      lastActivityAt: activity?.lastActivityAt ?? null,
      identitiesSeen: activity?.identityIds.length ?? 0,
      health,
    };
  });

  // ---- Sources: connections + checkpoints + canonical freshness ----
  const sourcesCatalog = sourceCatalog();
  const checkpoints = new Map<string, SourceCheckpoint | null>();
  const checkpointHistory = new Map<string, SourceCheckpointEntry[]>();
  const freshness = new Map<string, SourceFreshness | null>();
  for (const source of sources) {
    checkpoints.set(
      source.id,
      await safely(() => getSourceCheckpoint(ctx, { sourceId: source.id }), null),
    );
    checkpointHistory.set(
      source.id,
      await safely(() => listSourceCheckpoints(ctx, { sourceId: source.id, limit: 3 }), []),
    );
    freshness.set(
      source.id,
      await safely(
        () => evaluateSourceFreshness(ctx, { sourceKind: 'source', sourceId: source.id, asOf: generatedAt }),
        null,
      ),
    );
  }

  const sourceCards: SourceCard[] = sources.map((source: Source) => {
    const checkpoint = checkpoints.get(source.id) ?? null;
    const fresh = freshness.get(source.id) ?? null;
    const health = sourceHealth({
      status: source.status,
      oauthExpiresAt: source.oauthExpiresAt,
      checkpointUpdatedAt: checkpoint?.updatedAt ?? null,
      freshness: fresh?.status ?? 'unknown',
      now: generatedAt,
    });
    return {
      kind: 'source',
      id: source.id,
      provider: source.provider,
      label: labelFrom(sourcesCatalog, source.provider),
      providerAccountId: source.providerAccountId,
      displayName: source.displayName,
      authKind: source.authKind,
      credentialRef: source.credentialRef,
      oauthScopes: source.oauthScopes,
      oauthExpiresAt: source.oauthExpiresAt,
      status: source.status,
      modes: source.modes,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      checkpoint:
        checkpoint === null
          ? null
          : { cursor: checkpoint.cursor, updatedAt: checkpoint.updatedAt },
      recentCheckpoints: (checkpointHistory.get(source.id) ?? []).map((entry) => ({
        id: entry.id,
        cursor: entry.cursor,
        origin: entry.origin,
        recordedAt: entry.recordedAt,
      })),
      freshness: {
        status: fresh?.status ?? 'unknown',
        latestObservedAt: fresh?.latestObservedAt ?? null,
        ageSeconds: fresh?.ageSeconds ?? null,
        maxLatencySeconds: fresh?.maxObservedLatencySeconds ?? null,
        observationsConsidered: fresh?.observationsConsidered ?? 0,
      },
      health,
    };
  });

  // ---- Destinations: connections + delivery ledger state ----
  const deliveriesByDestination = new Map<string, Delivery[]>();
  for (const destination of destinations) {
    deliveriesByDestination.set(
      destination.id,
      await safely(() => listDeliveries(ctx, { destinationId: destination.id, limit: 50 }), []),
    );
  }

  const destinationCards: DestinationCard[] = destinations.map((destination: Destination) => {
    const deliveries = deliveriesByDestination.get(destination.id) ?? [];
    const deliverySummary = summarizeDeliveries(deliveries);
    const health = destinationHealth({
      status: destination.status,
      oauthExpiresAt: destination.oauthExpiresAt,
      deliveries: deliverySummary,
      now: generatedAt,
    });
    return {
      kind: 'destination',
      id: destination.id,
      provider: destination.provider,
      label: labelFrom(destinationCatalog().flatMap((g) => g.entries), destination.provider),
      category: destinationCategoryOf(destination.provider),
      providerAccountId: destination.providerAccountId,
      displayName: destination.displayName,
      authKind: destination.authKind,
      credentialRef: destination.credentialRef,
      oauthScopes: destination.oauthScopes,
      oauthExpiresAt: destination.oauthExpiresAt,
      status: destination.status,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
      deliveries: deliverySummary,
      health,
    };
  });

  // ---- Identities: discovered from the recent transcript window ----
  const discoveredIdentities: IdentityCard[] = [];
  const seenIdentityIds = new Set<string>();
  for (const activity of activityByProvider.values()) {
    for (const identityId of activity.identityIds) {
      if (seenIdentityIds.has(identityId)) continue;
      const identity: ExternalIdentity | null = await safely(
        () => getExternalIdentity(ctx, identityId),
        null,
      );
      if (identity === null) continue; // foreign or deleted — uniform no-leak
      seenIdentityIds.add(identityId);
      discoveredIdentities.push(
        await identityCard(ctx, identity, activity.identityLastSeen.get(identityId) ?? null, true),
      );
    }
  }

  // Explicit lookup (provider + account), when the page requested one.
  let lookup: IdentityCard | null = null;
  let lookupMiss: string | null = null;
  if (options.identityLookup !== undefined && options.identityLookup !== null) {
    const lookupInput = options.identityLookup;
    const found = await safely(
      () =>
        findExternalIdentityByProviderKey(ctx, {
          provider: lookupInput.provider as ChannelProvider,
          providerAccountId: lookupInput.providerAccountId,
        }),
      null,
    );
    if (found === null) {
      lookupMiss = 'No identity found for that provider account in this tenant.';
    } else {
      lookup = await identityCard(ctx, found, null, false);
    }
  }

  const byStatus: Record<'unverified' | 'pending' | 'verified' | 'revoked', number> = {
    unverified: 0,
    pending: 0,
    verified: 0,
    revoked: 0,
  };
  for (const card of discoveredIdentities) byStatus[card.status] += 1;

  const notices: string[] = [
    'Authentication lands with W058 — until then this surface resolves its tenant context from explicit headers/query parameters (documented dev seam).',
    'No channel/source/destination transports are wired by default (provider isolation): polls, outbound sends and challenge deliveries fail explicitly with provider_unavailable until infrastructure wires them.',
    `Channel identities are discovered from the newest ${IDENTITY_DISCOVERY_WINDOW} transcript turns per channel; the identity contract exposes no tenant-wide enumeration, so use the provider+account lookup for accounts outside that window.`,
    'Re-registering a source or destination is its re-authorization path ("configure"); channel endpoints are immutable after registration — only their status moves.',
  ];

  return {
    generatedAt,
    tenantId: ctx.tenantId,
    channels: {
      cards: channelCards,
      catalogSize: channelsCatalog.length,
      connected: channelConnections.length,
      active: channelConnections.filter((c) => c.status === 'active').length,
      byLevel: countByLevel(channelCards.filter((c) => c.connection !== null).map((c) => c.health.level)),
    },
    sources: {
      cards: sourceCards,
      connected: sources.length,
      active: sources.filter((s) => s.status === 'active').length,
      byLevel: countByLevel(sourceCards.map((c) => c.health.level)),
    },
    destinations: {
      cards: destinationCards,
      connected: destinations.length,
      active: destinations.filter((d) => d.status === 'active').length,
      byLevel: countByLevel(destinationCards.map((c) => c.health.level)),
    },
    identities: {
      cards: discoveredIdentities,
      byStatus,
      discoveryWindow: IDENTITY_DISCOVERY_WINDOW,
      lookup,
      lookupMiss,
    },
    catalog: {
      channels: channelsCatalog,
      sources: sourcesCatalog,
      destinations: destinationCatalog(),
    },
    notices,
  };
}
