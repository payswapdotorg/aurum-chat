// W044 — Tenant Isolation Verification · the vertical-kits sweep (W092).
//
// The vertical-kits module (W092 — Vertical Extension Starter Kits)
// owns tenant-scoped tables for its concepts: the kit installation
// lifecycle (one row per tenant × kit), the per-manifest grants with
// their marketplace package bindings, the append-only lifecycle events,
// and the removal-surviving recipe references.
//
// This sweep proves the tenant boundary at the APPLICATION level, per
// the W044 doctrine — two tenants side by side, zero leakage:
//   * tenant A's kit lifecycle (installs, grants, events, recipe
//     references) is invisible to tenant B: every read and every
//     lifecycle call through tenant B is uniformly not-installed (no
//     existence leak);
//   * tenant B can install the SAME platform-public kit for itself —
//     its lifecycle rows, grants and events stay entirely its own,
//     and tenant A's state never moves;
//   * each tenant's listings show exactly its own lifecycle.
//
// The deep five-probe acceptance cases live in the module's own suite
// (src/modules/vertical-kits/tests/); this sweep is the two-tenant
// proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import { setAuthorityPolicy } from '@/modules/actions/contract';
import {
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
  VERTICAL_KITS_AUTHORITY_ADMINISTER,
  getKitDefinition,
  getVerticalKitInstall,
  installVerticalKit,
  listVerticalKitEvents,
  listVerticalKitInstalls,
  listVerticalKitRecipeReferences,
  recordVerticalKitRecipeUse,
  removeVerticalKit,
} from '@/modules/vertical-kits/contract';
import { VerticalKitsError } from '@/modules/vertical-kits/errors';

const db = getDb();

// The platform side: the vendor tenant offering the kit, the platform
// reviewer approving it — and the two tenants the sweep walks side by
// side.
const tenantVendor = newId();
const tenantPlatform = newId();
const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function kitAdminOf(tenantId: string): TenantContext {
  return memberOf(tenantId, [VERTICAL_KITS_AUTHORITY_ADMINISTER, 'extensions:administer']);
}

async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected VerticalKitsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof VerticalKitsError)) throw error;
    expect(error.code).toBe(code);
  }
}

beforeAll(async () => {
  await runMigrations(db);
  for (const tenantId of [tenantA, tenantB]) {
    await setAuthorityPolicy(memberOf(tenantId, ['actions:administer']), {
      actionKind: 'extension-deployment',
      approvalLevels: [],
    });
  }
  // Offer the professional-services 1.0.0 kit through the REAL governed
  // catalog (the vendor walks the full W028 chain to INSTALLABLE).
  const vendor = memberOf(tenantVendor, ['extensions:administer', 'marketplace:submit']);
  const platform = memberOf(tenantPlatform, ['marketplace:administer']);
  const kit = getKitDefinition('professional-services', '1.0.0');
  for (const spec of kit.extensionManifests) {
    const registered = await registerExtensionManifest(vendor, spec.manifest);
    await runManifestVerification(vendor, { manifestId: registered.manifest.id });
    const pkg = await createPackage(vendor, {
      kind: 'extension',
      manifestId: registered.manifest.id,
    });
    await submitPackage(vendor, { packageId: pkg.id });
    await runAutomatedVerification(platform, { packageId: pkg.id });
    await reviewPackage(platform, { packageId: pkg.id, decision: 'approve' });
    await publishPackage(platform, { packageId: pkg.id });
    await makePackageInstallable(platform, { packageId: pkg.id });
  }
  // Tenant A installs the kit and records one recipe use.
  await installVerticalKit(kitAdminOf(tenantA), {
    kitKey: 'professional-services',
    version: '1.0.0',
  });
  await recordVerticalKitRecipeUse(kitAdminOf(tenantA), {
    kitKey: 'professional-services',
    recipeKey: 'close-engagement-month',
    reference: 'tenant-a-task-1',
  });
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The two-tenant boundary
// ---------------------------------------------------------------------------

describe('the vertical-kits tenant boundary (W092 · W044 sweep)', () => {
  it("tenant B sees none of tenant A's kit lifecycle (no existence leak)", async () => {
    const b = kitAdminOf(tenantB);
    await expectCode('kit_not_installed', () =>
      getVerticalKitInstall(b, { kitKey: 'professional-services' }),
    );
    await expectCode('kit_not_installed', () =>
      removeVerticalKit(b, { kitKey: 'professional-services' }),
    );
    await expectCode('kit_not_installed', () =>
      recordVerticalKitRecipeUse(b, {
        kitKey: 'professional-services',
        recipeKey: 'close-engagement-month',
        reference: 'tenant-b-task-1',
      }),
    );
    expect(await listVerticalKitInstalls(b)).toEqual([]);
    expect(await listVerticalKitEvents(b, {})).toEqual([]);
    expect(await listVerticalKitRecipeReferences(b, {})).toEqual([]);
  });

  it('cross-tenant SQL rows do not exist for tenant B (the storage floor)', async () => {
    const rows = await db.query(
      `SELECT 'installs' AS source, COUNT(*)::int AS n FROM vertical_kit_installs WHERE tenant_id = $1
        UNION ALL SELECT 'grants', COUNT(*)::int FROM vertical_kit_grants WHERE tenant_id = $1
        UNION ALL SELECT 'events', COUNT(*)::int FROM vertical_kit_events WHERE tenant_id = $1
        UNION ALL SELECT 'references', COUNT(*)::int FROM vertical_kit_recipe_references WHERE tenant_id = $1`,
      [tenantB],
    );
    expect(rows.rows.map((row) => Number(row.n))).toEqual([0, 0, 0, 0]);
    const aRows = await db.query(
      `SELECT 'installs' AS source, COUNT(*)::int AS n FROM vertical_kit_installs WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(Number(aRows.rows[0]!.n)).toBe(1);
  });

  it("tenant B can install the same platform-public kit — and tenant A's state never moves", async () => {
    const aBefore = await getVerticalKitInstall(kitAdminOf(tenantA), {
      kitKey: 'professional-services',
    });
    const aEventsBefore = await listVerticalKitEvents(kitAdminOf(tenantA), {});

    const installed = await installVerticalKit(kitAdminOf(tenantB), {
      kitKey: 'professional-services',
      version: '1.0.0',
    });
    expect(installed.created).toBe(true);
    expect(installed.install.tenantId).toBe(tenantB);

    // Tenant A's install row, grants and events are untouched.
    const aAfter = await getVerticalKitInstall(kitAdminOf(tenantA), {
      kitKey: 'professional-services',
    });
    expect(aAfter.id).toBe(aBefore.id);
    expect(aAfter.grants.map((grant) => grant.id).sort()).toEqual(
      aBefore.grants.map((grant) => grant.id).sort(),
    );
    expect(await listVerticalKitEvents(kitAdminOf(tenantA), {})).toHaveLength(
      aEventsBefore.length,
    );

    // Each tenant's listing shows exactly its own lifecycle.
    const aInstalls = await listVerticalKitInstalls(kitAdminOf(tenantA));
    const bInstalls = await listVerticalKitInstalls(kitAdminOf(tenantB));
    expect(aInstalls.map((install) => install.tenantId)).toEqual([tenantA]);
    expect(bInstalls.map((install) => install.tenantId)).toEqual([tenantB]);
    // ...and each holds its own event trail (B's install event is B's).
    const bEvents = await listVerticalKitEvents(kitAdminOf(tenantB), {});
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]!.eventType).toBe('install');
    expect(bEvents[0]!.tenantId).toBe(tenantB);
  });

  it('recipe references stay tenant-scoped: B records its own, never seeing A\'s', async () => {
    const own = await recordVerticalKitRecipeUse(kitAdminOf(tenantB), {
      kitKey: 'professional-services',
      recipeKey: 'close-engagement-month',
      reference: 'tenant-b-task-1',
    });
    expect(own.tenantId).toBe(tenantB);
    expect(own.kitRemoved).toBe(false);

    const bReferences = await listVerticalKitRecipeReferences(kitAdminOf(tenantB), {});
    expect(bReferences.map((entry) => entry.reference)).toEqual(['tenant-b-task-1']);

    const aReferences = await listVerticalKitRecipeReferences(kitAdminOf(tenantA), {});
    expect(aReferences.map((entry) => entry.reference)).toEqual(['tenant-a-task-1']);
  });

  it("tenant B's removal never disturbs tenant A's lifecycle", async () => {
    const removed = await removeVerticalKit(kitAdminOf(tenantB), {
      kitKey: 'professional-services',
    });
    expect(removed.survivingReferences.map((entry) => entry.reference)).toEqual([
      'tenant-b-task-1',
    ]);

    // Tenant A's kit is still installed with its grants intact.
    const aInstall = await getVerticalKitInstall(kitAdminOf(tenantA), {
      kitKey: 'professional-services',
    });
    expect(aInstall.kitVersion).toBe('1.0.0');
    expect(aInstall.grants).toHaveLength(2);
    // ...and A's recipe reference still renders as installed.
    const aReferences = await listVerticalKitRecipeReferences(kitAdminOf(tenantA), {});
    expect(aReferences[0]!.kitRemoved).toBe(false);
  });
});
