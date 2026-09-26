// Integration tests for the vertical-kits module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W092
// acceptance — "each pack is installable, permission-scoped, versioned,
// auditable and removable; core modules remain industry-independent" —
// with the five acceptance-clause probes, driven END TO END through the
// REAL contracts only:
//
//   * INSTALL (marketplace-package-driven, idempotent, tenant-scoped):
//     a kit install resolves every manifest to an INSTALLABLE
//     marketplace ExtensionPackage (a vendor walked the full W028 chain
//     DRAFT→…→INSTALLABLE first), registers + verifies + activates +
//     deploys each manifest in the tenant's OWN extensions registry
//     through the W025/W026 contracts, and records the install with its
//     grants and package bindings. Before the platform publishes:
//     kit_not_available. A tampered catalog artifact: package_mismatch.
//     A W009 gate that waits: approval_required, completed on replay
//     after the human decision.
//   * PERMISSION-SCOPED (fail-closed): installing grants EXACTLY the
//     kit's declared footprint — the per-manifest deployments carry the
//     manifests' requested permission sets and nothing else; claim-less
//     callers are forbidden; the composed extensions-administer claim
//     is required and stated.
//   * VERSIONED: the install records its version; an upgrade to a
//     strictly greater version REPLACES the grant set (the 1.1.0
//     footprint grows by telemetry:emit — visible in the grants, NOT
//     silently mutated), same-version and downgrade installs are
//     refused, and BOTH states live on in the audit trail.
//   * AUDITABLE: the lifecycle events are append-only (install →
//     upgrade → remove, who/when/what with the frozen grant snapshots);
//     the storage triggers forbid UPDATE/DELETE even for bypassing
//     writes.
//   * REMOVABLE: uninstall removes the grants and package bindings,
//     appends the remove event, and the recipe references SURVIVE —
//     rendering "this template came from kit vX" with an honest
//     removed flag (no silent data loss).
//
// The hostile-manifest/footprint probes at the pure level are in
// vertical-kits-unit.test.ts; the repository-scan core-independence
// probe is core-independence.test.ts.

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
  decideApproval,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import {
  getCurrentDeployment,
  listExtensionDeployments,
  registerExtensionManifest,
  runManifestVerification,
} from '@/modules/extensions/contract';
import {
  createPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import {
  EDGE_EXECUTION_STATUS,
  VERTICAL_KITS_AUTHORITY_ADMINISTER,
  getKitDefinition,
  getVerticalKitInstall,
  installVerticalKit,
  listKitCatalog,
  listVerticalKitEvents,
  listVerticalKitInstalls,
  listVerticalKitRecipeReferences,
  recordVerticalKitRecipeUse,
  removeVerticalKit,
  upgradeVerticalKit,
} from '../contract';
import { VerticalKitsError } from '../errors';

const db = getDb();

// Dedicated tenants keep each concern's data isolated (the marketplace
// suite's discipline): the vendor that offers the kits, the platform
// reviewer that approves them, the installer that walks the happy
// paths, a tenant that keeps the DEFAULT authority matrix (the honest
// approval_required probe), and an isolation tenant.
const tenantVendor = newId();
const tenantPlatform = newId();
const tenantInstaller = newId();
const tenantGate = newId();
const tenantOther = newId();

function ctx(tenantId: string, authority: string[], principalId = newId()): TenantContext {
  return { tenantId, principalId, authority };
}

/** The vendor side: registers manifests and offers them as packages. */
function vendor(): TenantContext {
  return ctx(tenantVendor, ['extensions:administer', 'marketplace:submit']);
}

/** The platform side: reviews, publishes, makes installable. */
function platform(): TenantContext {
  return ctx(tenantPlatform, ['marketplace:administer']);
}

/** The tenant-side kit administrator (both required claims). */
function kitAdmin(tenantId: string): TenantContext {
  return ctx(tenantId, [VERTICAL_KITS_AUTHORITY_ADMINISTER, 'extensions:administer']);
}

/** A claim-less member of the installer tenant. */
function member(tenantId: string): TenantContext {
  return ctx(tenantId, []);
}

/** Async-aware error-code assertion. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(VerticalKitsError);
    expect((error as VerticalKitsError).code).toBe(code);
  }
}

beforeAll(async () => {
  await runMigrations(db);
  // The installer tenant pins "extension-deployment EXECUTE is allowed"
  // so the happy-path installs apply immediately; tenantGate deliberately
  // keeps the built-in default matrix (the pending → human → replay
  // flow — the honest approval_required probe).
  for (const tenantId of [tenantInstaller, tenantOther]) {
    await setAuthorityPolicy(ctx(tenantId, ['actions:administer']), {
      actionKind: 'extension-deployment',
      approvalLevels: [],
    });
  }
});

afterAll(async () => {
  await closeDb();
});

/** Walk one kit manifest through the FULL marketplace chain to INSTALLABLE. */
async function publishManifest(marketplaceVendor: TenantContext, manifestInput: Parameters<typeof registerExtensionManifest>[1]): Promise<void> {
  const registered = await registerExtensionManifest(marketplaceVendor, manifestInput);
  await runManifestVerification(marketplaceVendor, { manifestId: registered.manifest.id });
  const pkg = await createPackage(marketplaceVendor, {
    kind: 'extension',
    manifestId: registered.manifest.id,
  });
  await submitPackage(marketplaceVendor, { packageId: pkg.id });
  await runAutomatedVerification(platform(), { packageId: pkg.id });
  await reviewPackage(platform(), { packageId: pkg.id, decision: 'approve' });
  await publishPackage(platform(), { packageId: pkg.id });
  await makePackageInstallable(platform(), { packageId: pkg.id });
}

/** Publish every manifest of a kit version. */
async function publishKit(kitKey: string, version: string): Promise<void> {
  const kit = getKitDefinition(kitKey, version);
  for (const spec of kit.extensionManifests) {
    await publishManifest(vendor(), spec.manifest);
  }
}

// ---------------------------------------------------------------------------
// PROBE 1 — INSTALL: marketplace-package-driven, idempotent, tenant-scoped
// ---------------------------------------------------------------------------

describe('install (marketplace-package-driven, idempotent, tenant-scoped)', () => {
  it('refuses kit_not_available before the platform has made the manifests INSTALLABLE', async () => {
    await expectCode('kit_not_available', () =>
      installVerticalKit(kitAdmin(tenantInstaller), {
        kitKey: 'professional-services',
        version: '1.0.0',
      }),
    );
  });

  it('refuses unknown kits and malformed inputs', async () => {
    await expectCode('kit_not_found', () =>
      installVerticalKit(kitAdmin(tenantInstaller), { kitKey: 'no-such-kit' }),
    );
    await expectCode('invalid_input', () =>
      installVerticalKit(kitAdmin(tenantInstaller), {
        kitKey: 'professional-services',
        version: 'not-semver',
      } as never),
    );
  });

  it('requires the vertical-kits administer claim (fail-closed)', async () => {
    await expectCode('forbidden', () =>
      installVerticalKit(member(tenantInstaller), {
        kitKey: 'professional-services',
        version: '1.0.0',
      }),
    );
  });

  it('requires the composed extensions-administer claim and says so', async () => {
    await publishKit('professional-services', '1.0.0');
    await expectCode('forbidden', () =>
      installVerticalKit(ctx(tenantInstaller, [VERTICAL_KITS_AUTHORITY_ADMINISTER]), {
        kitKey: 'professional-services',
        version: '1.0.0',
      }),
    );
  });

  it('installs through the real contracts: packages bound, manifests deployed at the exact footprint', async () => {
    const installer = kitAdmin(tenantInstaller);
    const result = await installVerticalKit(installer, {
      kitKey: 'professional-services',
      version: '1.0.0',
    });
    expect(result.created).toBe(true);
    expect(result.install.kitVersion).toBe('1.0.0');
    expect(result.install.installedBy).toBe(installer.principalId);
    expect(result.install.grants).toHaveLength(2);

    // The grants carry the REAL marketplace package bindings.
    const engagement = result.install.grants.find(
      (grant) => grant.extensionKey === 'ps-engagement-sync',
    )!;
    const bridge = result.install.grants.find(
      (grant) => grant.extensionKey === 'ps-time-expense-bridge',
    )!;
    expect(engagement.packageKey).toBe('ps-engagement-sync');
    expect(bridge.packageKey).toBe('ps-time-expense-bridge');
    expect(engagement.packageId).not.toBe(bridge.packageId);

    // PROBE 2 (permission-scoped): the grants are EXACTLY the manifests'
    // requested permission sets — nothing more, nothing less.
    expect(engagement.grantedPermissions).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'events:subscribe',
      'external:participate',
    ]);
    expect(bridge.grantedPermissions).toEqual([
      'state:read',
      'state:write',
      'schedule:run',
      'external:participate',
    ]);

    // The extensions registry really holds the deployed versions, with
    // the install-time grant the runtime recorded (W026 discipline).
    const currentEngagement = await getCurrentDeployment(
      member(tenantInstaller),
      { extensionKey: 'ps-engagement-sync' },
    );
    expect(currentEngagement?.version).toBe('1.0.0');
    expect(currentEngagement?.grantedPermissions).toEqual(engagement.grantedPermissions);
    const deployments = await listExtensionDeployments(member(tenantInstaller), {
      extensionKey: 'ps-time-expense-bridge',
    });
    expect(deployments).toHaveLength(1);
    expect(deployments[0]!.grantedPermissions).toEqual(bridge.grantedPermissions);

    // The install event froze the full WHAT (who, when, which grants
    // through which packages).
    const events = await listVerticalKitEvents(installer, { kitKey: 'professional-services' });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('install');
    expect(events[0]!.fromVersion).toBeNull();
    expect(events[0]!.toVersion).toBe('1.0.0');
    expect(events[0]!.actor).toBe(installer.principalId);
    expect(events[0]!.detail.grants.map((grant) => grant.extensionKey).sort()).toEqual([
      'ps-engagement-sync',
      'ps-time-expense-bridge',
    ]);

    // The honest edge posture renders on the install (never a claim).
    expect(result.install.edgeExecutionInfo.status).toBe(EDGE_EXECUTION_STATUS);
  });

  it('is idempotent: a same-version re-install replays the recorded install and appends nothing', async () => {
    const installer = kitAdmin(tenantInstaller);
    const first = await getVerticalKitInstall(installer, { kitKey: 'professional-services' });
    const replay = await installVerticalKit(installer, {
      kitKey: 'professional-services',
      version: '1.0.0',
    });
    expect(replay.created).toBe(false);
    expect(replay.install.id).toBe(first.id);
    expect(replay.install.kitVersion).toBe('1.0.0');
    expect(await listVerticalKitEvents(installer, { kitKey: 'professional-services' })).toHaveLength(1);
    // No duplicate deployments either (the extensions replay discipline).
    expect(
      await listExtensionDeployments(member(tenantInstaller), { extensionKey: 'ps-engagement-sync' }),
    ).toHaveLength(1);
  });

  it('refuses to install a DIFFERENT version over a recorded one (that is an upgrade)', async () => {
    await expectCode('kit_conflict', () =>
      installVerticalKit(kitAdmin(tenantInstaller), {
        kitKey: 'professional-services',
        version: '1.1.0',
      }),
    );
  });

  it('refuses a tampered catalog artifact (package_mismatch — fail-closed binding)', async () => {
    // The vendor offers a 'logistics-shipment-tracker' 1.0.0 package whose
    // frozen content DIFFERS from the kit's declaration (no telemetry).
    // A kit install must refuse to bind it.
    await publishManifest(vendor(), {
      extensionKey: 'logistics-shipment-tracker',
      version: '1.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Shipment Tracker',
      description: 'A drifted artifact occupying the identity the kit expects.',
      hostRuntime: { minVersion: '1.0.0', maxVersion: null },
      requestedPermissions: ['state:read', 'state:write', 'events:subscribe', 'external:participate'],
      stateScope: 'tenant',
      uiSurfaces: [],
      schedules: [],
      eventSubscriptions: ['goal.updated', 'observation.recorded'],
      externalParticipants: [
        { label: 'Order and shipment system of record', origin: 'https://shipment-sor.example.test' },
      ],
      telemetry: false,
      quotas: {
        maxStateBytes: 4_194_304,
        maxScheduleInvocationsPerDay: 0,
        maxExternalCallsPerDay: 20_000,
      },
    });
    await expectCode('package_mismatch', () =>
      installVerticalKit(kitAdmin(tenantInstaller), { kitKey: 'logistics-operations' }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROBE 3 — VERSIONED: upgrade = a new version install, grants replaced,
// both states on the audit trail (no silent in-place mutation)
// ---------------------------------------------------------------------------

describe('versioned upgrades (record of installed version, no silent grant mutation)', () => {
  it('refuses upgrade discipline violations before any work', async () => {
    const installer = kitAdmin(tenantInstaller);
    await expectCode('invalid_input', () =>
      upgradeVerticalKit(installer, { kitKey: 'professional-services' }),
    );
    await expectCode('kit_not_installed', () =>
      upgradeVerticalKit(kitAdmin(tenantOther), {
        kitKey: 'professional-services',
        version: '1.1.0',
      }),
    );
    await expectCode('kit_conflict', () =>
      upgradeVerticalKit(installer, {
        kitKey: 'professional-services',
        version: '1.0.0',
      }),
    );
  });

  it('upgrades to the strictly greater version: the grant set is REPLACED and both snapshots stay on the trail', async () => {
    await publishKit('professional-services', '1.1.0');
    const installer = kitAdmin(tenantInstaller);
    const upgraded = await upgradeVerticalKit(installer, {
      kitKey: 'professional-services',
      version: '1.1.0',
    });
    expect(upgraded.created).toBe(true);
    expect(upgraded.install.kitVersion).toBe('1.1.0');

    // The 1.1.0 footprint grew by telemetry:emit (the bridge's new
    // capability) — the REPLACED grant set shows it; the 1.0.0 grant
    // set is gone from the live state.
    const bridge = upgraded.install.grants.find(
      (grant) => grant.extensionKey === 'ps-time-expense-bridge',
    )!;
    expect(bridge.grantedPermissions).toEqual([
      'state:read',
      'state:write',
      'schedule:run',
      'external:participate',
      'telemetry:emit',
    ]);
    const current = await getCurrentDeployment(member(tenantInstaller), {
      extensionKey: 'ps-time-expense-bridge',
    });
    expect(current?.version).toBe('1.1.0');
    expect(current?.grantedPermissions).toEqual(bridge.grantedPermissions);

    // The extensions registry holds BOTH deployments (append-only history
    // there too — an upgrade is a redeploy, never a mutation).
    expect(
      await listExtensionDeployments(member(tenantInstaller), {
        extensionKey: 'ps-time-expense-bridge',
      }),
    ).toHaveLength(2);

    // PROBE 4 (auditable, first half): install(1.0.0) → upgrade(1.1.0),
    // each event freezing its own grant snapshot — the 1.0.0 install
    // event shows the OLD footprint, the upgrade event the NEW one.
    const events = await listVerticalKitEvents(installer, { kitKey: 'professional-services' });
    expect(events.map((event) => event.eventType)).toEqual(['upgrade', 'install']);
    const installEvent = events.find((event) => event.eventType === 'install')!;
    const upgradeEvent = events.find((event) => event.eventType === 'upgrade')!;
    expect(installEvent.toVersion).toBe('1.0.0');
    expect(upgradeEvent.fromVersion).toBe('1.0.0');
    expect(upgradeEvent.toVersion).toBe('1.1.0');
    const installBridge = installEvent.detail.grants.find(
      (grant) => grant.extensionKey === 'ps-time-expense-bridge',
    )!;
    const upgradeBridge = upgradeEvent.detail.grants.find(
      (grant) => grant.extensionKey === 'ps-time-expense-bridge',
    )!;
    expect(installBridge.grantedPermissions).not.toContain('telemetry:emit');
    expect(upgradeBridge.grantedPermissions).toContain('telemetry:emit');

    // Downgrades are refused too: upgrading back to 1.0.0 after the
    // 1.1.0 upgrade is a version-order violation, not an install.
    await expectCode('kit_conflict', () =>
      upgradeVerticalKit(installer, {
        kitKey: 'professional-services',
        version: '1.0.0',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROBE 4 — AUDITABLE: append-only lifecycle events (storage-enforced)
// ---------------------------------------------------------------------------

describe('auditable lifecycle (append-only events, storage-enforced)', () => {
  it('the event tables refuse UPDATE and DELETE even for bypassing writes', async () => {
    const events = await db.query<{ id: string }>(
      `SELECT id FROM vertical_kit_events WHERE tenant_id = $1 LIMIT 1`,
      [tenantInstaller],
    );
    const eventId = events.rows[0]!.id;
    await expect(
      db.query(`UPDATE vertical_kit_events SET actor = 'attacker' WHERE id = $1`, [eventId]),
    ).rejects.toThrowError(/append-only/);
    await expect(
      db.query(`DELETE FROM vertical_kit_events WHERE id = $1`, [eventId]),
    ).rejects.toThrowError(/append-only/);
  });

  it('recorded grants are immutable rows (replacement is delete-and-reinsert through the service)', async () => {
    const grants = await db.query<{ id: string }>(
      `SELECT id FROM vertical_kit_grants WHERE tenant_id = $1 LIMIT 1`,
      [tenantInstaller],
    );
    const grantId = grants.rows[0]!.id;
    await expect(
      db.query(
        `UPDATE vertical_kit_grants SET granted_permissions = '["state:read"]'::jsonb WHERE id = $1`,
        [grantId],
      ),
    ).rejects.toThrowError(/immutable once recorded/);
  });
});

// ---------------------------------------------------------------------------
// PROBE 5 — REMOVABLE: grants + bindings removed, references survive
// honestly (no silent data loss)
// ---------------------------------------------------------------------------

describe('removable kits (honest references survive removal)', () => {
  it('records a recipe use against the installed version', async () => {
    const installer = kitAdmin(tenantInstaller);
    const reference = await recordVerticalKitRecipeUse(installer, {
      kitKey: 'professional-services',
      recipeKey: 'close-engagement-month',
      reference: 'deep-action-task-42',
    });
    expect(reference.kitVersion).toBe('1.1.0');
    expect(reference.kitRemoved).toBe(false);
    // recording the same use twice replays (no duplicates)
    const replay = await recordVerticalKitRecipeUse(installer, {
      kitKey: 'professional-services',
      recipeKey: 'close-engagement-month',
      reference: 'deep-action-task-42',
    });
    expect(replay.id).toBe(reference.id);
  });

  it('refuses unknown recipes and unversioned uses without an install', async () => {
    const installer = kitAdmin(tenantInstaller);
    await expectCode('invalid_input', () =>
      recordVerticalKitRecipeUse(installer, {
        kitKey: 'professional-services',
        recipeKey: 'no-such-recipe',
        reference: 'ref-1',
      }),
    );
    await expectCode('kit_not_installed', () =>
      recordVerticalKitRecipeUse(kitAdmin(tenantOther), {
        kitKey: 'professional-services',
        recipeKey: 'close-engagement-month',
        reference: 'ref-2',
      }),
    );
  });

  it('removes the grants and package bindings, keeps the events and references honest', async () => {
    const installer = kitAdmin(tenantInstaller);
    const removal = await removeVerticalKit(installer, { kitKey: 'professional-services' });

    // The grants and bindings are GONE (that is what removal means).
    await expectCode('kit_not_installed', () =>
      getVerticalKitInstall(installer, { kitKey: 'professional-services' }),
    );
    expect(await listVerticalKitInstalls(installer)).toEqual([]);
    const leftoverGrants = await db.query(
      `SELECT * FROM vertical_kit_grants WHERE tenant_id = $1 AND kit_key = 'professional-services'`,
      [tenantInstaller],
    );
    expect(leftoverGrants.rows).toEqual([]);

    // The remove event froze what was removed (from 1.1.0, with the
    // removed grant snapshot).
    const events = await listVerticalKitEvents(installer, { kitKey: 'professional-services' });
    expect(events.map((event) => event.eventType)).toEqual(['remove', 'upgrade', 'install']);
    const removeEvent = events[0]!;
    expect(removeEvent.fromVersion).toBe('1.1.0');
    expect(removeEvent.toVersion).toBeNull();
    expect(removeEvent.detail.grants).toHaveLength(2);

    // PROBE 5's honest tail: the recipe references SURVIVE the removal,
    // still naming the kit version the template came from.
    expect(removal.survivingReferences).toHaveLength(1);
    const surviving = removal.survivingReferences[0]!;
    expect(surviving.kitVersion).toBe('1.1.0');
    expect(surviving.recipeKey).toBe('close-engagement-month');
    expect(surviving.reference).toBe('deep-action-task-42');
    expect(surviving.kitRemoved).toBe(true);

    const references = await listVerticalKitRecipeReferences(installer, {
      kitKey: 'professional-services',
    });
    expect(references).toHaveLength(1);
    expect(references[0]!.kitRemoved).toBe(true);
    expect(references[0]!.kitVersion).toBe('1.1.0');

    // Recipe references are immutable history (no silent rewrite).
    await expect(
      db.query(`UPDATE vertical_kit_recipe_references SET kit_version = '0.0.1' WHERE tenant_id = $1`, [
        tenantInstaller,
      ]),
    ).rejects.toThrowError(/append-only/);
  });

  it('re-installs cleanly after a removal (the registry replays, a fresh install event lands)', async () => {
    const installer = kitAdmin(tenantInstaller);
    const reinstalled = await installVerticalKit(installer, {
      kitKey: 'professional-services',
    });
    expect(reinstalled.created).toBe(true);
    expect(reinstalled.install.kitVersion).toBe('1.1.0');
    const events = await listVerticalKitEvents(installer, { kitKey: 'professional-services' });
    expect(events.map((event) => event.eventType)).toEqual([
      'install',
      'remove',
      'upgrade',
      'install',
    ]);
    // The old reference still renders honestly beside the new install.
    const references = await listVerticalKitRecipeReferences(installer, {
      kitKey: 'professional-services',
    });
    expect(references[0]!.kitRemoved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The honest W009 gate probe (approval_required → human → replay)
// ---------------------------------------------------------------------------

describe('the authority gate surfaces honestly (approval_required, completed on replay)', () => {
  it('holds the install at the gate, then completes after the human decisions', async () => {
    // tenantGate keeps the built-in default matrix: EXECUTE waits.
    const gateAdmin = kitAdmin(tenantGate);
    const approver = ctx(tenantGate, ['actions:approve']);

    await expectCode('approval_required', () =>
      installVerticalKit(gateAdmin, {
        kitKey: 'professional-services',
        version: '1.0.0',
      }),
    );

    // Approve every pending extension-deployment request, then re-invoke
    // the install — the activations and deployments replay idempotently
    // until the whole composition applies (each manifest's activation
    // and deployment is one gated call, held one at a time).
    for (let round = 0; round < 8; round += 1) {
      const pending = await listActionRequests(gateAdmin, {
        actionKind: 'extension-deployment',
        status: 'pending',
      });
      for (const request of pending) {
        await decideApproval(approver, { requestId: request.id, decision: 'approve' });
      }
      try {
        const attempt = await installVerticalKit(gateAdmin, {
          kitKey: 'professional-services',
          version: '1.0.0',
        });
        expect(attempt.created).toBe(true);
        expect(attempt.install.kitVersion).toBe('1.0.0');
        expect(attempt.install.grants).toHaveLength(2);
        expect(
          await listVerticalKitEvents(gateAdmin, { kitKey: 'professional-services' }),
        ).toHaveLength(1);
        return;
      } catch (error) {
        if (!(error instanceof VerticalKitsError) || error.code !== 'approval_required') {
          throw error;
        }
      }
    }
    expect.unreachable('the gated install never completed after the human decisions');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001 at this module's boundary)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('another tenant sees none of the installer tenant\'s kit lifecycle', async () => {
    const other = kitAdmin(tenantOther);
    await expectCode('kit_not_installed', () =>
      getVerticalKitInstall(other, { kitKey: 'professional-services' }),
    );
    await expectCode('kit_not_installed', () =>
      removeVerticalKit(other, { kitKey: 'professional-services' }),
    );
    expect(await listVerticalKitInstalls(other)).toEqual([]);
    expect(await listVerticalKitEvents(other, {})).toEqual([]);
    expect(await listVerticalKitRecipeReferences(other, {})).toEqual([]);
  });

  it('another tenant records its own references and never sees the installer\'s', async () => {
    const other = kitAdmin(tenantOther);
    const own = await recordVerticalKitRecipeUse(other, {
      kitKey: 'logistics-operations',
      version: '1.0.0',
      recipeKey: 'expedite-shipment-replan',
      reference: 'other-tenant-ref-1',
    });
    expect(own.kitVersion).toBe('1.0.0');
    const mine = await listVerticalKitRecipeReferences(other, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reference).toBe('other-tenant-ref-1');
  });

  it('the catalog itself is served generically (pure data, no tenant state)', () => {
    const catalog = listKitCatalog();
    expect(catalog.map((kit) => kit.kitKey).sort()).toEqual([
      'logistics-operations',
      'professional-services',
    ]);
  });
});
