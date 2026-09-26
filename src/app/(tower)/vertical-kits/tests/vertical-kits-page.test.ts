// Route-tree tests for the Vertical Kits tower surface (W092) — the
// (tower) house pattern: the view builder is exercised against the
// embedded PostgreSQL through REAL contracts (a vendor walks the
// marketplace chain to INSTALLABLE, the tenant installs the kit, a
// recipe use is recorded, the kit is removed), then the assembled view
// is asserted to surface the real state — and a second tenant's view
// stays empty (tenant isolation at the surface boundary).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';
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
  installVerticalKit,
  recordVerticalKitRecipeUse,
  removeVerticalKit,
} from '@/modules/vertical-kits/contract';
import { buildVerticalKitsView } from '../lib/view';

const db = getDb();

const tenantVendor = newId();
const tenantPlatform = newId();
const tenantA = newId();
const tenantB = newId();

function ctx(tenantId: string, authority: string[]): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

beforeAll(async () => {
  await runMigrations(db);
  for (const tenantId of [tenantA, tenantB]) {
    await setAuthorityPolicy(ctx(tenantId, ['actions:administer']), {
      actionKind: 'extension-deployment',
      approvalLevels: [],
    });
  }
  // Walk the professional-services 1.0.0 manifests through the REAL
  // marketplace chain so tenantA can install the kit.
  const vendor = ctx(tenantVendor, ['extensions:administer', 'marketplace:submit']);
  const platform = ctx(tenantPlatform, ['marketplace:administer']);
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
  await installVerticalKit(ctx(tenantA, [VERTICAL_KITS_AUTHORITY_ADMINISTER, 'extensions:administer']), {
    kitKey: 'professional-services',
    version: '1.0.0',
  });
});

afterAll(async () => {
  await closeDb();
});

describe('the Vertical Kits tower view (real contracts, real state)', () => {
  it('renders the pure catalog generically (both starter kits, honest pending-w088 edge)', async () => {
    const view = await buildVerticalKitsView(ctx(tenantB, []));
    expect(view.catalog.total).toBe(2);
    const industries = view.catalog.kits.map((kit) => kit.industry).sort();
    expect(industries).toEqual(['Logistics operations', 'Professional services']);
    for (const kit of view.catalog.kits) {
      expect(kit.edge.status).toBe('pending-w088');
      expect(kit.permissionFootprint.length).toBeGreaterThan(0);
      expect(kit.manifests.length).toBeGreaterThanOrEqual(2);
      expect(kit.recipes.length).toBeGreaterThanOrEqual(1);
      expect(kit.notIncluded.length).toBeGreaterThanOrEqual(1);
    }
    // The logistics kit is the one declaring an edge-expecting recipe.
    const logistics = view.catalog.kits.find((kit) => kit.kitKey === 'logistics-operations')!;
    expect(logistics.edge.recipes).toEqual(['expedite-shipment-replan']);
  });

  it('surfaces the installed kit with its exact grants and package bindings', async () => {
    const view = await buildVerticalKitsView(ctx(tenantA, [VERTICAL_KITS_AUTHORITY_ADMINISTER]));
    expect(view.installs.total).toBe(1);
    const install = view.installs.items[0]!;
    expect(install.kitKey).toBe('professional-services');
    expect(install.kitVersion).toBe('1.0.0');
    expect(install.grants).toHaveLength(2);
    const engagement = install.grants.find((g) => g.extensionKey === 'ps-engagement-sync')!;
    expect(engagement.packageKey).toBe('ps-engagement-sync');
    expect(engagement.grantedPermissions).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'events:subscribe',
      'external:participate',
    ]);

    // The catalog card for the installed kit shows the granted set and
    // the installed version (the view joins the two halves).
    const kitCard = view.catalog.kits.find((kit) => kit.kitKey === 'professional-services')!;
    expect(kitCard.installedVersion).toBe('1.0.0');
    const cardEngagement = kitCard.manifests.find((m) => m.extensionKey === 'ps-engagement-sync')!;
    expect(cardEngagement.grantedPermissions).toEqual(engagement.grantedPermissions);

    // The install event is on the audit surface.
    expect(view.events.total).toBe(1);
    expect(view.events.items[0]!.eventType).toBe('install');
  });

  it('keeps the recipe-reference trail honest across removal (no silent data loss)', async () => {
    const admin = ctx(tenantA, [VERTICAL_KITS_AUTHORITY_ADMINISTER, 'extensions:administer']);
    await recordVerticalKitRecipeUse(admin, {
      kitKey: 'professional-services',
      recipeKey: 'close-engagement-month',
      reference: 'deep-action-task-77',
    });
    const before = await buildVerticalKitsView(admin);
    expect(before.references.total).toBe(1);
    expect(before.references.items[0]!.kitRemoved).toBe(false);

    await removeVerticalKit(admin, { kitKey: 'professional-services' });

    const after = await buildVerticalKitsView(admin);
    expect(after.installs.total).toBe(0);
    expect(after.events.items.map((event) => event.eventType)).toEqual(['remove', 'install']);
    // The reference SURVIVES with its version and the honest removed flag.
    expect(after.references.total).toBe(1);
    expect(after.references.items[0]!.kitVersion).toBe('1.0.0');
    expect(after.references.items[0]!.kitRemoved).toBe(true);
  });

  it('isolates tenants at the surface boundary (tenant B sees none of tenant A)', async () => {
    const viewB = await buildVerticalKitsView(ctx(tenantB, []));
    expect(viewB.installs.total).toBe(0);
    expect(viewB.events.total).toBe(0);
    expect(viewB.references.total).toBe(0);
    // The pure catalog is shared data — it renders for every tenant.
    expect(viewB.catalog.total).toBe(2);
    const kitCard = viewB.catalog.kits.find((kit) => kit.kitKey === 'professional-services')!;
    expect(kitCard.installedVersion).toBeNull();
    expect(kitCard.manifests.every((manifest) => manifest.grantedPermissions.length === 0)).toBe(
      true,
    );
  });
});
