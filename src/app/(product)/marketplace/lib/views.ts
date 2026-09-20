// Product surface (W064) — the marketplace area's view builders.
//
// Every view is a server-side composition of existing module contracts
// ONLY (lock 31/32: contracts, never persistence) — the same discipline
// the W057 shell hubs and the tower surfaces follow. Each view degrades
// honestly: a failed read renders the quiet error pattern, never fake
// emptiness, and cross-tenant pre-publication work is invisible by the
// marketplace contract's own visibility rule (no existence leak).
//
// VIEWS:
//   buildCatalogView      — the public catalog (browse) + the caller's
//                           installed-extensions summary.
//   buildPackageView      — one package: state, permissions, capability
//                           declaration, verification evidence, review
//                           decisions, lifecycle trail, and the actions
//                           THIS caller may legally take.
//   buildDeveloperView    — the builder sessions, the publishable
//                           manifest versions, the vendor's own packages
//                           and the platform review queue.
//   buildInstalledView    — the tenant's extension registry with each
//                           extension's verification posture and current
//                           deployment.
//   buildExtensionView    — one extension: manifests, deployments, the
//                           lifecycle trail, and the governance actions.

import type { TenantContext } from '@/infra/tenant';
import {
  EXTENSION_BUILD_LIVE_PHASES,
  EXTENSION_TRANSITIONS,
  ExtensionsError,
  canTransitionExtension,
  getCurrentDeployment,
  getExtension,
  listExtensionBuilds,
  listExtensionDeployments,
  listExtensionLifecycleEvents,
  listExtensions,
  listManifests,
} from '@/modules/extensions/contract';
import type {
  ExtensionBuild,
  ExtensionDeployment,
  ExtensionLifecycleEvent,
  ExtensionManifestSummary,
} from '@/modules/extensions/contract';
import { listAgents } from '@/modules/agents/contract';
import type { AgentDefinition } from '@/modules/agents/contract';
import { MarketplaceError } from '@/modules/marketplace/contract';
import {
  getPackage,
  getPackageVerification,
  isAgentPackage,
  isExtensionPackage,
  listCatalogPackages,
  listPackageLifecycleEvents,
  listPackageReviews,
  listPackageVerifications,
  listPackages,
  listReviewQueue,
} from '@/modules/marketplace/contract';
import type {
  MarketplacePackage,
  PackageLifecycleEvent,
  PackageReview,
  PackageVerificationInfo,
  PackageVerificationRun,
} from '@/modules/marketplace/contract';
import {
  AGENT_SCOPE_COPY,
  CLAIM_ADMINISTER,
  CLAIM_EXTENSIONS_ADMINISTER,
  EXTENSION_PERMISSION_COPY,
  PACKAGE_CHAIN,
  buildPhaseLabel,
  buildPhaseTone,
  canUseDeveloperSurface,
  capabilityLines,
  chainPosition,
  derivePackageActions,
  extensionStateExplanation,
  extensionStateLabel,
  extensionStateTone,
  packageKindLabel,
  packageStateExplanation,
  packageStateLabel,
  packageStateTone,
  permissionLines,
  quotaLines,
} from './labels';
import type { PackageActions } from './labels';
import type { PillTone } from '../../lib/states';

/** The pill tone as the marketplace views type it (re-anchored once). */
type PillToneAlias = PillTone;

// ---------------------------------------------------------------------------
// The public browsing context (documented, explicit — no ambient global)
// ---------------------------------------------------------------------------

/**
 * The catalog itself is public (that is what a marketplace IS), but
 * every contract call still needs an EXPLICIT TenantContext — there is
 * no ambient global (IMPLEMENTATION-STACK §8). Unscoped browsing uses
 * this fixed, well-formed, CLAIM-LESS context: it can read exactly the
 * PUBLISHED/INSTALLABLE catalog (the visibility rule grants nothing
 * else), can install nothing (no claims), and owns nothing (it is no
 * package's vendor). The tenant id is a well-formed uuid that is never
 * provisioned — it appears in no organization, so it is nobody.
 */
export const PUBLIC_CATALOG_TENANT = '00000000-0000-4000-8000-000000000064';

/** The catalog's anonymous reader principal (well-formed, never provisioned). */
export const PUBLIC_CATALOG_PRINCIPAL = '00000000-0000-4000-8000-0000000006b';

export function publicBrowsingContext(): TenantContext {
  return {
    tenantId: PUBLIC_CATALOG_TENANT,
    principalId: PUBLIC_CATALOG_PRINCIPAL,
    authority: [],
  };
}

/** How many items each list view carries (progressive disclosure, not a data dump). */
export const VIEW_LIMIT = 24;

// ---------------------------------------------------------------------------
// Catalog (browse)
// ---------------------------------------------------------------------------

export type CatalogKindFilter = 'all' | 'extension' | 'agent';

export interface CatalogItemView {
  id: string;
  kind: 'extension' | 'agent';
  kindLabel: string;
  packageKey: string;
  version: string;
  displayName: string;
  description: string | null;
  stateLabel: string;
  stateTone: PillToneAlias;
  vendorTenant: string;
  permissionCount: number;
  updatedAt: string;
}

export interface InstalledSummaryView {
  ok: boolean;
  total: number;
  active: number;
  suspended: number;
  registered: number;
  deprecated: number;
}

export interface CatalogView {
  ok: boolean;
  reason: string | null;
  generatedAt: string;
  kindFilter: CatalogKindFilter;
  items: CatalogItemView[];
  total: number;
  /** The caller's registry summary (null when browsing unscoped). */
  installed: InstalledSummaryView | null;
}

function toCatalogItem(pkg: MarketplacePackage): CatalogItemView {
  const permissionCount = isExtensionPackage(pkg)
    ? pkg.payload.subject.requestedPermissions.length
    : isAgentPackage(pkg)
      ? pkg.payload.permissions.length
      : 0;
  return {
    id: pkg.id,
    kind: pkg.kind,
    kindLabel: packageKindLabel(pkg.kind),
    packageKey: pkg.packageKey,
    version: pkg.version,
    displayName: pkg.displayName,
    description: pkg.description,
    stateLabel: packageStateLabel(pkg.state),
    stateTone: packageStateTone(pkg.state),
    vendorTenant: pkg.vendorTenant,
    permissionCount,
    updatedAt: pkg.updatedAt,
  };
}

/** Parse the ?kind= filter (unknown values fall back to 'all'). */
export function parseKindFilter(value: string | null | undefined): CatalogKindFilter {
  return value === 'extension' || value === 'agent' ? value : 'all';
}

/** Build the browse view: the public catalog for the effective context. */
export async function buildCatalogView(
  ctx: TenantContext,
  kindFilter: CatalogKindFilter,
): Promise<CatalogView> {
  const generatedAt = new Date().toISOString();
  let items: MarketplacePackage[] = [];
  let ok = true;
  let reason: string | null = null;
  try {
    items = await listCatalogPackages(ctx, {
      kind: kindFilter === 'all' ? undefined : kindFilter,
      limit: VIEW_LIMIT,
    });
  } catch {
    ok = false;
    reason = 'unavailable';
  }

  // The installed summary needs the caller's OWN registry — only a real
  // scoped context has one worth showing.
  let installed: InstalledSummaryView | null = null;
  if (ctx.tenantId !== PUBLIC_CATALOG_TENANT) {
    try {
      const extensions = await listExtensions(ctx, { limit: 500 });
      installed = {
        ok: true,
        total: extensions.length,
        active: extensions.filter((extension) => extension.lifecycleState === 'ACTIVE').length,
        suspended: extensions.filter((extension) => extension.lifecycleState === 'SUSPENDED').length,
        registered: extensions.filter((extension) => extension.lifecycleState === 'REGISTERED').length,
        deprecated: extensions.filter((extension) => extension.lifecycleState === 'DEPRECATED').length,
      };
    } catch {
      installed = { ok: false, total: 0, active: 0, suspended: 0, registered: 0, deprecated: 0 };
    }
  }

  return {
    ok,
    reason,
    generatedAt,
    kindFilter,
    items: items.map(toCatalogItem),
    total: items.length,
    installed,
  };
}

// ---------------------------------------------------------------------------
// Package detail (permission inspection + status + evidence + actions)
// ---------------------------------------------------------------------------

export interface PackageEvidenceView {
  verification: PackageVerificationInfo;
  runs: PackageVerificationRun[];
  reviews: PackageReview[];
  lifecycle: PackageLifecycleEvent[];
}

export interface PackageView {
  generatedAt: string;
  pkg: MarketplacePackage;
  stateLabel: string;
  stateTone: PillToneAlias;
  stateExplanation: string;
  kindLabel: string;
  chain: { state: string; label: string; reached: boolean; isRejected: boolean }[];
  permissions: { key: string; label: string; description: string }[];
  capabilities: { label: string; detail: string }[];
  quotas: { label: string; detail: string }[];
  evidence: PackageEvidenceView;
  actions: PackageActions;
}

export type PackageViewResult =
  | { ok: true; view: PackageView }
  | { ok: false; failure: 'not_found' | 'unavailable' };

/**
 * Build one package's detail view for THIS caller. A package that is
 * not visible to the caller (another tenant's pre-publication work) is
 * indistinguishable from a missing one — the honest not-found state.
 */
export async function buildPackageView(
  ctx: TenantContext,
  packageId: string,
): Promise<PackageViewResult> {
  let pkg: MarketplacePackage;
  try {
    pkg = await getPackage(ctx, { packageId });
  } catch (error) {
    if (error instanceof MarketplaceError && error.code === 'package_not_found') {
      return { ok: false, failure: 'not_found' };
    }
    return { ok: false, failure: 'unavailable' };
  }

  // Evidence: each read degrades to empty rather than failing the page.
  const emptyEvidence: PackageEvidenceView = {
    verification: { packageId: pkg.id, outcome: 'unverified', latestRun: null },
    runs: [],
    reviews: [],
    lifecycle: [],
  };
  let evidence: PackageEvidenceView;
  try {
    const [verification, runs, reviews, lifecycle] = await Promise.all([
      getPackageVerification(ctx, { packageId: pkg.id }),
      listPackageVerifications(ctx, { packageId: pkg.id, limit: VIEW_LIMIT }),
      listPackageReviews(ctx, { packageId: pkg.id, limit: VIEW_LIMIT }),
      listPackageLifecycleEvents(ctx, { packageId: pkg.id, limit: VIEW_LIMIT }),
    ]);
    evidence = { verification, runs, reviews, lifecycle };
  } catch {
    evidence = emptyEvidence;
  }

  const position = chainPosition(pkg.state);
  const chain = PACKAGE_CHAIN.map((state) => ({
    state,
    label: packageStateLabel(state),
    reached: chainPosition(state) <= position,
    isRejected: pkg.state === 'REJECTED' && state === 'PENDING_REVIEW',
  }));

  const permissions = isExtensionPackage(pkg)
    ? permissionLines(pkg.payload.subject.requestedPermissions, EXTENSION_PERMISSION_COPY)
    : permissionLines(
        isAgentPackage(pkg) ? pkg.payload.permissions : [],
        AGENT_SCOPE_COPY,
      );

  const capabilities = isExtensionPackage(pkg)
    ? capabilityLines(pkg.payload.subject.capabilities)
    : [];
  const quotas = isExtensionPackage(pkg) ? quotaLines(pkg.payload.subject.quotas) : [];

  return {
    ok: true,
    view: {
      generatedAt: new Date().toISOString(),
      pkg,
      stateLabel: packageStateLabel(pkg.state),
      stateTone: packageStateTone(pkg.state),
      stateExplanation: packageStateExplanation(pkg.state),
      kindLabel: packageKindLabel(pkg.kind),
      chain,
      permissions,
      capabilities,
      quotas,
      evidence,
      actions: derivePackageActions(ctx, pkg),
    },
  };
}

// ---------------------------------------------------------------------------
// Developer surface (builder + publish + platform review queue)
// ---------------------------------------------------------------------------

export interface DeveloperBuildView {
  id: string;
  extensionKey: string;
  version: string;
  brief: string;
  phase: string;
  phaseLabel: string;
  phaseTone: PillToneAlias;
  failureCode: string | null;
  failureDetail: string | null;
  manifestId: string | null;
  deploymentId: string | null;
  createdAt: string;
  canAdvance: boolean;
  canCancel: boolean;
}

export interface PublishableManifestView {
  manifestId: string;
  extensionKey: string;
  version: string;
  displayName: string;
  verificationState: string;
  permissionCount: number;
}

export interface DeveloperPackageView {
  id: string;
  kind: 'extension' | 'agent';
  kindLabel: string;
  packageKey: string;
  version: string;
  displayName: string;
  stateLabel: string;
  stateTone: PillToneAlias;
  stateExplanation: string;
  updatedAt: string;
  nextAction: DeveloperNextAction;
}

export type DeveloperNextAction =
  | 'submit'
  | 'await-verification'
  | 'await-review'
  | 'await-publish'
  | 'await-installable'
  | 'rejected'
  | 'none';

export interface ReviewQueueItemView {
  id: string;
  kind: 'extension' | 'agent';
  kindLabel: string;
  packageKey: string;
  version: string;
  displayName: string;
  stateLabel: string;
  stateTone: PillToneAlias;
  vendorTenant: string;
  updatedAt: string;
}

export interface DeveloperView {
  generatedAt: string;
  scoped: boolean;
  usable: boolean;
  builds: { ok: boolean; items: DeveloperBuildView[] };
  builderAgents: {
    ok: boolean;
    items: { id: string; slug: string; displayName: string; role: string; provider: string; status: string }[];
  };
  manifests: { ok: boolean; items: PublishableManifestView[] };
  packages: { ok: boolean; items: DeveloperPackageView[] };
  reviewQueue: { ok: boolean; allowed: boolean; items: ReviewQueueItemView[] };
}

/** The next move a vendor has on a package (the chain's own order). */
export function nextPackageAction(state: string): DeveloperNextAction {
  switch (state) {
    case 'DRAFT':
      return 'submit';
    case 'SUBMITTED':
      return 'await-verification';
    case 'AUTOMATED_VERIFICATION':
    case 'PENDING_REVIEW':
      return 'await-review';
    case 'APPROVED':
      return 'await-publish';
    case 'PUBLISHED':
      return 'await-installable';
    case 'REJECTED':
      return 'rejected';
    default:
      return 'none';
  }
}

/** Build the developer console view (builder + publish + review queue). */
export async function buildDeveloperView(ctx: TenantContext): Promise<DeveloperView> {
  const generatedAt = new Date().toISOString();
  const scoped = ctx.tenantId !== PUBLIC_CATALOG_TENANT;
  const usable = canUseDeveloperSurface(ctx.authority);
  const livePhases = EXTENSION_BUILD_LIVE_PHASES as readonly string[];

  // Builder sessions: the extensions registry's own builds.
  let builds: DeveloperBuildView[] = [];
  let buildsOk = true;
  try {
    const rows: ExtensionBuild[] = await listExtensionBuilds(ctx, { limit: VIEW_LIMIT });
    builds = rows.map((build) => ({
      id: build.id,
      extensionKey: build.extensionKey,
      version: build.version,
      brief: build.brief,
      phase: build.phase,
      phaseLabel: buildPhaseLabel(build.phase),
      phaseTone: buildPhaseTone(build.phase),
      failureCode: build.failureCode,
      failureDetail: build.failureDetail,
      manifestId: build.manifestId,
      deploymentId: build.deploymentId,
      createdAt: build.createdAt,
      canAdvance: livePhases.includes(build.phase),
      canCancel: livePhases.includes(build.phase),
    }));
  } catch {
    buildsOk = false;
  }

  // Builder agents: the tenant's registered agents (the builder needs one).
  let builderAgents: DeveloperView['builderAgents']['items'] = [];
  let agentsOk = true;
  try {
    const agents: AgentDefinition[] = await listAgents(ctx, { limit: 100 });
    builderAgents = agents.map((agent) => ({
      id: agent.id,
      slug: agent.slug,
      displayName: agent.displayName ?? agent.slug,
      role: agent.role,
      provider: agent.provider,
      status: agent.status,
    }));
  } catch {
    agentsOk = false;
  }

  // Publishable manifests: the tenant registry's versions, newest first.
  let manifests: PublishableManifestView[] = [];
  let manifestsOk = true;
  try {
    const rows: ExtensionManifestSummary[] = await listManifests(ctx, { limit: VIEW_LIMIT });
    manifests = rows.map((manifest) => ({
      manifestId: manifest.id,
      extensionKey: manifest.extensionKey,
      version: manifest.version,
      displayName: manifest.displayName,
      verificationState: manifest.verificationState,
      permissionCount: manifest.requestedPermissions.length,
    }));
  } catch {
    manifestsOk = false;
  }

  // The vendor's own packages, in any state.
  let packages: DeveloperPackageView[] = [];
  let packagesOk = true;
  try {
    const rows = await listPackages(ctx, { limit: VIEW_LIMIT });
    packages = rows.map((pkg) => ({
      id: pkg.id,
      kind: pkg.kind,
      kindLabel: packageKindLabel(pkg.kind),
      packageKey: pkg.packageKey,
      version: pkg.version,
      displayName: pkg.displayName,
      stateLabel: packageStateLabel(pkg.state),
      stateTone: packageStateTone(pkg.state),
      stateExplanation: packageStateExplanation(pkg.state),
      updatedAt: pkg.updatedAt,
      nextAction: nextPackageAction(pkg.state),
    }));
  } catch {
    packagesOk = false;
  }

  // The platform review queue (administer claim only).
  let reviewQueue: ReviewQueueItemView[] = [];
  let reviewOk = true;
  const reviewAllowed = ctx.authority.includes(CLAIM_ADMINISTER);
  if (reviewAllowed) {
    try {
      const rows = await listReviewQueue(ctx, { limit: VIEW_LIMIT });
      reviewQueue = rows.map((pkg) => ({
        id: pkg.id,
        kind: pkg.kind,
        kindLabel: packageKindLabel(pkg.kind),
        packageKey: pkg.packageKey,
        version: pkg.version,
        displayName: pkg.displayName,
        stateLabel: packageStateLabel(pkg.state),
        stateTone: packageStateTone(pkg.state),
        vendorTenant: pkg.vendorTenant,
        updatedAt: pkg.updatedAt,
      }));
    } catch {
      reviewOk = false;
    }
  }

  return {
    generatedAt,
    scoped,
    usable,
    builds: { ok: buildsOk, items: builds },
    builderAgents: { ok: agentsOk, items: builderAgents },
    manifests: { ok: manifestsOk, items: manifests },
    packages: { ok: packagesOk, items: packages },
    reviewQueue: { ok: reviewOk, allowed: reviewAllowed, items: reviewQueue },
  };
}

// ---------------------------------------------------------------------------
// Installed extensions (tenant registry governance)
// ---------------------------------------------------------------------------

export interface InstalledExtensionView {
  id: string;
  extensionKey: string;
  lifecycleState: string;
  stateLabel: string;
  stateTone: PillToneAlias;
  latestVersion: string | null;
  verificationState: string | null;
  deployment: { version: string; grantedCount: number; deployedAt: string } | null;
  updatedAt: string;
}

export interface InstalledView {
  ok: boolean;
  generatedAt: string;
  items: InstalledExtensionView[];
  total: number;
}

/** Build the tenant's installed-extensions governance summary. */
export async function buildInstalledView(ctx: TenantContext): Promise<InstalledView> {
  const generatedAt = new Date().toISOString();
  try {
    const extensions = await listExtensions(ctx, { limit: VIEW_LIMIT });
    const items: InstalledExtensionView[] = await Promise.all(
      extensions.map(async (extension) => {
        let verificationState: string | null = null;
        if (extension.latestManifestId !== null) {
          try {
            const manifests = await listManifests(ctx, {
              extensionKey: extension.extensionKey,
              limit: 500,
            });
            verificationState =
              manifests.find((manifest) => manifest.id === extension.latestManifestId)
                ?.verificationState ?? null;
          } catch {
            verificationState = null;
          }
        }
        let deployment: InstalledExtensionView['deployment'] = null;
        try {
          const current = await getCurrentDeployment(ctx, {
            extensionKey: extension.extensionKey,
          });
          if (current !== null) {
            deployment = {
              version: current.version,
              grantedCount: current.grantedPermissions.length,
              deployedAt: current.deployedAt,
            };
          }
        } catch {
          deployment = null;
        }
        return {
          id: extension.id,
          extensionKey: extension.extensionKey,
          lifecycleState: extension.lifecycleState,
          stateLabel: extensionStateLabel(extension.lifecycleState),
          stateTone: extensionStateTone(extension.lifecycleState),
          latestVersion: extension.latestVersion,
          verificationState,
          deployment,
          updatedAt: extension.updatedAt,
        };
      }),
    );
    return { ok: true, generatedAt, items, total: items.length };
  } catch {
    return { ok: false, generatedAt, items: [], total: 0 };
  }
}

// ---------------------------------------------------------------------------
// One installed extension (the governance drill-down)
// ---------------------------------------------------------------------------

export interface ExtensionManifestView {
  manifestId: string;
  version: string;
  displayName: string;
  verificationState: string;
  permissionCount: number;
  /** The requested ceiling (for the deploy form's grant narrowing). */
  requestedPermissions: string[];
  registeredAt: string;
  isDeployable: boolean;
}

export interface DeploymentRowView {
  id: string;
  version: string;
  installKey: string;
  operation: string;
  grantedPermissions: string[];
  deployedBy: string;
  deployedAt: string;
  isCurrent: boolean;
  isRollbackTarget: boolean;
}

export interface ExtensionDetailView {
  generatedAt: string;
  extension: {
    id: string;
    extensionKey: string;
    lifecycleState: string;
    stateLabel: string;
    stateTone: PillToneAlias;
    stateExplanation: string;
    latestVersion: string | null;
    updatedAt: string;
  };
  manifests: ExtensionManifestView[];
  deployments: DeploymentRowView[];
  lifecycleEvents: ExtensionLifecycleEvent[];
  currentDeployment: ExtensionDeployment | null;
  /** The legal transitions from the current state (pure state machine). */
  availableTransitions: { transition: string; label: string; description: string }[];
  canGovern: boolean;
}

export type ExtensionViewResult =
  | { ok: true; view: ExtensionDetailView }
  | { ok: false; failure: 'not_found' | 'unavailable' };

/** The governance copy for each legal lifecycle transition. */
const TRANSITION_COPY: Record<string, { label: string; description: string }> = {
  activate: {
    label: 'Activate',
    description: 'REGISTERED → ACTIVE. The latest manifest version must be VERIFIED.',
  },
  suspend: {
    label: 'Suspend',
    description: 'ACTIVE → SUSPENDED. Temporarily disable the extension.',
  },
  resume: {
    label: 'Resume',
    description: 'SUSPENDED → ACTIVE. Undo a suspension.',
  },
  deprecate: {
    label: 'Deprecate',
    description: 'Any live state → DEPRECATED. Terminal — no new versions, no return.',
  },
};

/** Build one installed extension's governance view. */
export async function buildExtensionView(
  ctx: TenantContext,
  extensionKey: string,
): Promise<ExtensionViewResult> {
  let extension;
  try {
    extension = await getExtension(ctx, { extensionKey });
  } catch (error) {
    if (error instanceof ExtensionsError && error.code === 'extension_not_found') {
      return { ok: false, failure: 'not_found' };
    }
    return { ok: false, failure: 'unavailable' };
  }

  let manifests: ExtensionManifestSummary[];
  try {
    manifests = await listManifests(ctx, { extensionKey, limit: VIEW_LIMIT });
  } catch {
    manifests = [];
  }

  let deployments: ExtensionDeployment[];
  try {
    deployments = await listExtensionDeployments(ctx, { extensionKey, limit: VIEW_LIMIT });
  } catch {
    deployments = [];
  }

  let lifecycleEvents: ExtensionLifecycleEvent[];
  try {
    lifecycleEvents = await listExtensionLifecycleEvents(ctx, { extensionKey, limit: VIEW_LIMIT });
  } catch {
    lifecycleEvents = [];
  }

  let currentDeployment: ExtensionDeployment | null = null;
  try {
    currentDeployment = await getCurrentDeployment(ctx, { extensionKey });
  } catch {
    currentDeployment = null;
  }

  const manifestViews: ExtensionManifestView[] = manifests.map((manifest) => ({
    manifestId: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    verificationState: manifest.verificationState,
    permissionCount: manifest.requestedPermissions.length,
    requestedPermissions: [...manifest.requestedPermissions],
    registeredAt: manifest.registeredAt,
    isDeployable: manifest.verificationState === 'VERIFIED' && extension.lifecycleState === 'ACTIVE',
  }));

  const deploymentViews: DeploymentRowView[] = deployments.map((deployment) => ({
    id: deployment.id,
    version: deployment.version,
    installKey: deployment.installKey,
    operation: deployment.operation,
    grantedPermissions: deployment.grantedPermissions,
    deployedBy: deployment.deployedBy,
    deployedAt: deployment.deployedAt,
    isCurrent: currentDeployment?.id === deployment.id,
    isRollbackTarget:
      currentDeployment !== null &&
      currentDeployment.id !== deployment.id &&
      deployment.installKey === currentDeployment.installKey,
  }));

  const availableTransitions = (EXTENSION_TRANSITIONS as readonly string[])
    .filter((transition) =>
      canTransitionExtension(
        extension.lifecycleState,
        transition as (typeof EXTENSION_TRANSITIONS)[number],
      ),
    )
    .map((transition) => ({
      transition,
      label: TRANSITION_COPY[transition]?.label ?? transition,
      description: TRANSITION_COPY[transition]?.description ?? '',
    }));

  return {
    ok: true,
    view: {
      generatedAt: new Date().toISOString(),
      extension: {
        id: extension.id,
        extensionKey: extension.extensionKey,
        lifecycleState: extension.lifecycleState,
        stateLabel: extensionStateLabel(extension.lifecycleState),
        stateTone: extensionStateTone(extension.lifecycleState),
        stateExplanation: extensionStateExplanation(extension.lifecycleState),
        latestVersion: extension.latestVersion,
        updatedAt: extension.updatedAt,
      },
      manifests: manifestViews,
      deployments: deploymentViews,
      lifecycleEvents,
      currentDeployment,
      availableTransitions,
      canGovern: ctx.authority.includes(CLAIM_EXTENSIONS_ADMINISTER),
    },
  };
}
