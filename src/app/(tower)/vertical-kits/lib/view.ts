// Management Control Tower (W033 shell) — the Vertical Kits view (W092).
//
// The admin-managed catalog of vertical extension starter kits: the
// validated kit DATA (served generically through the vertical-kits
// contract — this file names no industry, no kit and no vertical term),
// the tenant's installed kits with their EXACT granted footprints and
// marketplace package bindings, the append-only lifecycle audit, and
// the recipe-reference trail that survives removal.
//
// The edge path renders its single honest status ('pending-w088') —
// this surface never claims edge execution (W088 is in flight on a
// sibling branch at this base).
//
// Route-tree discipline: this view builder imports ONLY the
// vertical-kits module contract (scripts/check-architecture.ts rule
// (c)); the shared tower primitives come from the tower's own app-level
// component and format helpers, exactly like every sibling surface.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  listKitCatalog,
  listVerticalKitEvents,
  listVerticalKitInstalls,
  listVerticalKitRecipeReferences,
} from '@/modules/vertical-kits/contract';
import type {
  VerticalKitEvent,
  VerticalKitInstall,
  VerticalKitRecipeReference,
  VerticalKitSummary,
} from '@/modules/vertical-kits/contract';

const EVENT_CAP = 20;
const REFERENCE_CAP = 20;

/** One kit card of the catalog (the pure data, plus rendered edge posture). */
export interface KitCard {
  kitKey: string;
  version: string;
  industry: string;
  description: string;
  outcomes: string[];
  notIncluded: string[];
  permissionFootprint: string[];
  manifests: {
    extensionKey: string;
    version: string;
    systemOfRecord: string;
    connectionKey: string;
    grantedPermissions: string[];
  }[];
  recipes: {
    recipeKey: string;
    description: string;
    operationCount: number;
    connectionKeys: string[];
  }[];
  connections: {
    key: string;
    label: string;
    brokerProvider: string;
    capabilityClasses: string[];
  }[];
  edge: { status: string; recipes: string[]; note: string };
  installedVersion: string | null;
}

/** The assembled view model. */
export interface VerticalKitsView {
  generatedAt: string;
  catalog: { total: number; kits: KitCard[] };
  installs: { total: number; items: VerticalKitInstall[] };
  events: { total: number; items: VerticalKitEvent[] };
  references: { total: number; items: VerticalKitRecipeReference[] };
}

/** Build the Vertical Kits view (contracts only; no persistence). */
export async function buildVerticalKitsView(ctx: TenantContext): Promise<VerticalKitsView> {
  const [catalog, installs, events, references] = await Promise.all([
    listKitCatalog(),
    listVerticalKitInstalls(ctx),
    listVerticalKitEvents(ctx, { limit: EVENT_CAP }),
    listVerticalKitRecipeReferences(ctx, { limit: REFERENCE_CAP }),
  ]);

  const installedVersions = new Map(installs.map((install) => [install.kitKey, install.kitVersion]));
  const grantsByExtension = new Map<string, string[]>();
  for (const install of installs) {
    for (const grant of install.grants) {
      grantsByExtension.set(grant.extensionKey, grant.grantedPermissions);
    }
  }

  const kits: KitCard[] = catalog.map((kit: VerticalKitSummary) => ({
    kitKey: kit.kitKey,
    version: kit.version,
    industry: kit.metadata.industry,
    description: kit.metadata.description,
    outcomes: kit.metadata.outcomes,
    notIncluded: kit.metadata.notIncluded,
    permissionFootprint: kit.permissionFootprint,
    manifests: kit.extensionManifests.map((spec) => ({
      extensionKey: spec.manifest.extensionKey,
      version: spec.manifest.version,
      systemOfRecord: spec.systemOfRecord,
      connectionKey: spec.connectionKey,
      grantedPermissions: grantsByExtension.get(spec.manifest.extensionKey) ?? [],
    })),
    recipes: kit.deepActionRecipes.map((recipe) => ({
      recipeKey: recipe.recipeKey,
      description: recipe.description,
      operationCount: recipe.operations.length,
      connectionKeys: [...new Set(recipe.operations.map((operation) => operation.connectionKey))],
    })),
    connections: kit.connectionRequirements.map((connection) => ({
      key: connection.key,
      label: connection.label,
      brokerProvider: connection.brokerProvider,
      capabilityClasses: connection.capabilityClasses,
    })),
    edge: {
      status: kit.edgeExecutionInfo.status,
      recipes: kit.edgeExecutionInfo.recipes,
      note: kit.edgeExecutionInfo.note,
    },
    installedVersion: installedVersions.get(kit.kitKey) ?? null,
  }));

  return {
    generatedAt: now().toISOString(),
    catalog: { total: kits.length, kits },
    installs: { total: installs.length, items: installs },
    events: { total: events.length, items: events },
    references: { total: references.length, items: references },
  };
}
