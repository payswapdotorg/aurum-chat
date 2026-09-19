// Integration tests for the product shell (W057) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port.
//
// The acceptance core of the work item — "notification entry, tenant/
// workspace switcher" backed by REAL module contracts, plus the shell's
// own API surface:
//
//   * SEED two tenants through real contracts only: owners, workspaces,
//     an active channel connection (so urgent notifications can deliver),
//     a digest policy for one kind, delivered + pending notifications in
//     tenant A, one notification in tenant B.
//   * BUILD the shell state and assert the chrome data flows end to end:
//     company + workspaces for the switcher, the attention feed for the
//     notification entry, tones and attention counting.
//   * TENANT ISOLATION at the shell boundary: a foreign principal sees the
//     quiet degraded company section (no existence leak, ADR-0001) and no
//     personal inferences; tenant B's state contains none of tenant A's
//     notifications.
//   * THE API SURFACE: /api/product/shell envelope shape, missing-tenant
//     and invalid-tenant handling, header and query seams.
//   * THE CONNECTIONS HUB: real channel/source/destination summaries for
//     tenant A and honest empties for tenant B.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

import {
  createWorkspace,
  provisionTenant,
} from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import {
  createNotification,
  listNotifications,
  setNotificationPolicy,
} from '@/modules/notifications/contract';
import type { Notification } from '@/modules/notifications/contract';
import {
  registerChannelConnection,
  setChannelTransport,
} from '@/modules/channels/contract';
import type {
  CanonicalDeliveryRequest,
  TransportReceipt,
} from '@/modules/channels/contract';
import { registerSource } from '@/modules/sources/contract';
import { registerDestination } from '@/modules/destinations/contract';

import { buildShellState } from '../lib/shell-state';
import type { ShellStateView } from '../lib/shell-state';
import { handleShellStateGet } from '../lib/api';
import { buildConnectionsView } from '../lib/connections-view';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function member(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

/** Always-delivering transport so urgent notifications reach 'delivered'. */
const deliveredReceipts: CanonicalDeliveryRequest[] = [];
const transport = {
  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    deliveredReceipts.push(request);
    return { status: 'delivered', providerMessageId: `prov-${newId()}`, detail: null };
  },
};

interface ShellFixture {
  tenantA: Tenant;
  tenantB: Tenant;
  ownerA: TenantContext;
  ownerB: TenantContext;
  adminA: TenantContext; // carries the notifications administer claim
}

let fixture: ShellFixture;
let pendingNotification: Notification;
let deliveredNotification: Notification;
let foreignNotification: Notification;

beforeAll(async () => {
  await runMigrations(db);

  const platform = {
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };

  const ownerAPrincipalId = newId();
  const ownerBPrincipalId = newId();
  const tenantA = await provisionTenant(platform, {
    name: 'Northwind Traders',
    ownerPrincipalId: ownerAPrincipalId,
    defaultWorkspaceName: 'Company HQ',
  });
  const tenantB = await provisionTenant(platform, {
    name: 'Initech',
    ownerPrincipalId: ownerBPrincipalId,
  });

  fixture = {
    tenantA,
    tenantB,
    ownerA: member(tenantA.id, ownerAPrincipalId),
    ownerB: member(tenantB.id, ownerBPrincipalId),
    adminA: member(tenantA.id, newId(), ['notifications:administer']),
  };

  // Tenant A: a second workspace + an active slack connection + a digest
  // policy for one kind, so the shell sees delivered AND pending state.
  await createWorkspace(fixture.ownerA, { name: 'Growth', slug: 'growth' });
  await registerChannelConnection(fixture.ownerA, {
    provider: 'slack',
    providerAccountId: 'NORTHWINDOPS',
    credentialRef: 'secret-store://slack-northwind',
  });
  await setNotificationPolicy(fixture.adminA, {
    notificationKind: 'shell.digest.kind',
    deliveryClass: 'digest',
    maxAttempts: 2,
    retryBackoffSeconds: 60,
    dedupeWindowSeconds: 60,
    digestWindowSeconds: 3600,
    requireAcknowledgment: false,
  });

  setChannelTransport(transport);

  const delivered = await createNotification(fixture.ownerA, {
    kind: 'approval.requested',
    recipient: { provider: 'slack', providerAccountId: 'UOPSLEAD' },
    subject: 'Approval requested: collections agent recruitment',
    body: 'Please review the proposed agent recruitment for the collections job.',
  });
  deliveredNotification = delivered.notification;

  const pending = await createNotification(fixture.ownerA, {
    kind: 'shell.digest.kind',
    recipient: { provider: 'slack', providerAccountId: 'UOPSLEAD' },
    subject: 'Daily intelligence digest',
    body: 'Accumulating for the digest window.',
  });
  pendingNotification = pending.notification;

  // Tenant B: one notification of its own.
  await registerChannelConnection(fixture.ownerB, {
    provider: 'slack',
    providerAccountId: 'INITECHOPS',
    credentialRef: 'secret-store://slack-initech',
  });
  const foreign = await createNotification(fixture.ownerB, {
    kind: 'approval.requested',
    recipient: { provider: 'slack', providerAccountId: 'UBLEAD' },
    subject: 'Initech approval',
    body: 'B-side only.',
  });
  foreignNotification = foreign.notification;

  // One source and one destination for the connections hub summary.
  await registerSource(fixture.ownerA, {
    provider: 'hubspot',
    providerAccountId: '24681357',
    displayName: 'Northwind CRM',
    authKind: 'credentials',
    credentialRef: 'secret-store://hubspot-northwind',
  });
  await registerDestination(fixture.ownerA, {
    provider: 'google-sheets',
    providerAccountId: 'northwind-reporting',
    displayName: 'Northwind reporting sheet',
    authKind: 'credentials',
    credentialRef: 'secret-store://sheets-northwind',
  });

  expect(deliveredReceipts.length).toBeGreaterThan(0);
});

afterAll(async () => {
  setChannelTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// Shell state (the chrome's data)
// ---------------------------------------------------------------------------

describe('buildShellState', () => {
  it('composes company, workspaces and the attention feed for a member', async () => {
    const view: ShellStateView = await buildShellState(fixture.ownerA, 'growth');
    expect(view.tenantId).toBe(fixture.tenantA.id);
    expect(view.workspace).toBe('growth');

    expect(view.company.ok).toBe(true);
    if (view.company.ok) {
      expect(view.company.tenant.name).toBe('Northwind Traders');
      const workspaces = view.company.workspaces;
      // The default workspace keeps the canonical 'default' slug; the name
      // we provisioned ('Company HQ') is its display name.
      expect(workspaces.map((workspace) => workspace.slug)).toEqual([
        'default',
        'growth',
      ]);
      expect(workspaces[0]?.name).toBe('Company HQ');
    }

    expect(view.notifications.ok).toBe(true);
    const ids = view.notifications.items.map((item) => item.id);
    expect(ids).toContain(deliveredNotification.id);
    expect(ids).toContain(pendingNotification.id);
    expect(ids).not.toContain(foreignNotification.id);

    const deliveredItem = view.notifications.items.find(
      (item) => item.id === deliveredNotification.id,
    );
    expect(deliveredItem?.tone).toBe('positive');
    expect(deliveredItem?.needsAttention).toBe(false);
    const pendingItem = view.notifications.items.find(
      (item) => item.id === pendingNotification.id,
    );
    expect(pendingItem?.tone).toBe('info');
    expect(pendingItem?.needsAttention).toBe(true);
    expect(view.notifications.attentionCount).toBe(1);
  });

  it('degrades quietly for a principal that is not a member (no existence leak)', async () => {
    const stranger = member(fixture.tenantA.id, newId());
    const view = await buildShellState(stranger, null);
    expect(view.company).toEqual({ ok: false, reason: 'unavailable' });
    // The notifications feed stays tenant-scoped and honest: the stranger
    // reads the tenant's feed shape, never membership inference.
    expect(view.notifications.ok).toBe(true);
  });

  it('tenant B sees only its own notifications (isolation at the shell boundary)', async () => {
    const view = await buildShellState(fixture.ownerB, null);
    const ids = view.notifications.items.map((item) => item.id);
    expect(ids).toEqual([foreignNotification.id]);
    if (view.company.ok) {
      expect(view.company.tenant.name).toBe('Initech');
      expect(view.company.workspaces.map((w) => w.slug)).toEqual(['default']);
    }
  });

  it('the attention feed agrees with the contract read', async () => {
    const contractList = await listNotifications(fixture.ownerA, { limit: 50 });
    const view = await buildShellState(fixture.ownerA, null);
    expect(view.notifications.totalShown).toBe(contractList.length);
  });
});

// ---------------------------------------------------------------------------
// The shell API surface
// ---------------------------------------------------------------------------

describe('handleShellStateGet', () => {
  it('returns the envelope for a scoped request (headers seam)', async () => {
    const request = new Request('https://aurum.test/api/product/shell', {
      headers: {
        'x-aurum-tenant': fixture.tenantA.id,
        'x-aurum-principal': fixture.ownerA.principalId,
      },
    });
    const result = await handleShellStateGet(request);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.shell).toBe('state');
      expect(result.body.tenantId).toBe(fixture.tenantA.id);
      expect(result.body.view.company.ok).toBe(true);
    }
  });

  it('returns the envelope for a scoped request (query seam, workspace too)', async () => {
    const request = new Request(
      `https://aurum.test/api/product/shell?tenant=${fixture.tenantA.id}&principal=${fixture.ownerA.principalId}&workspace=growth`,
    );
    const result = await handleShellStateGet(request);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.view.workspace).toBe('growth');
    }
  });

  it('rejects missing and invalid tenants with 400 + honest detail', async () => {
    const missing = await handleShellStateGet(
      new Request('https://aurum.test/api/product/shell'),
    );
    expect(missing.status).toBe(400);
    if (missing.status === 400) {
      expect(missing.body.error).toBe('missing_tenant');
    }
    const invalid = await handleShellStateGet(
      new Request('https://aurum.test/api/product/shell?tenant=globex'),
    );
    expect(invalid.status).toBe(400);
    if (invalid.status === 400) {
      expect(invalid.body.error).toBe('invalid_tenant');
    }
  });
});

// ---------------------------------------------------------------------------
// Connections hub
// ---------------------------------------------------------------------------

describe('buildConnectionsView', () => {
  it('summarizes the three families with real state for tenant A', async () => {
    const view = await buildConnectionsView(fixture.ownerA);
    expect(view.groups).toHaveLength(3);
    const channels = view.groups.find((group) => group.family === 'channels');
    const sources = view.groups.find((group) => group.family === 'sources');
    const destinations = view.groups.find((group) => group.family === 'destinations');
    expect(channels?.ok).toBe(true);
    expect(channels?.items[0]?.provider).toBe('slack');
    expect(channels?.items[0]?.statusLabel).toBe('Active');
    expect(channels?.items[0]?.tone).toBe('positive');
    expect(sources?.ok).toBe(true);
    expect(sources?.items[0]?.label).toBe('Northwind CRM');
    expect(destinations?.ok).toBe(true);
    expect(destinations?.items[0]?.provider).toBe('google-sheets');
  });

  it('shows honest empties for tenant B (no cross-tenant leakage)', async () => {
    const view = await buildConnectionsView(fixture.ownerB);
    for (const group of view.groups) {
      expect(group.ok).toBe(true);
      if (group.family === 'channels') {
        // B registered its own slack connection.
        expect(group.items.map((item) => item.provider)).toEqual(['slack']);
      } else {
        expect(group.items).toEqual([]);
        expect(group.count).toBe(0);
      }
    }
  });
});
