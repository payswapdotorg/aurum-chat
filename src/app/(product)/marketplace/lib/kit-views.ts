// Product surface (W105) — the marketplace area's view builders for
// the W092 vertical starter kits, mirroring views.ts (the extension/
// agent views) for the KIT kind.
//
// Every view is a server-side composition of existing module contracts
// ONLY (lock 31/32: contracts, never persistence) — here the
// vertical-kits module's own contract: the shipped signed starter-kit
// manifests (STARTER_KITS), the pure deterministic verification +
// digest surfaces, and the tenant registry/lifecycle reads. Each view
// degrades honestly: a failed read renders the quiet error pattern,
// never fake emptiness, and another tenant's kit registry is invisible
// by the module's own tenant scoping (no existence leak).
//
// ADDITIVE-ONLY (W105): buildCatalogView / buildPackageView /
// buildInstalledView / buildDeveloperView / buildExtensionView are
// untouched; these are the kit-side companions:
//
//   buildKitsCatalogView   — the catalog's "Vertical starter kits"
//                            section: the shipped signed kits (public —
//                            first-party module content, no tenant
//                            data) plus the caller's registered kit
//                            versions and live install states (scoped).
//   buildKitDetailView     — one kit: identity, the signed version
//                            manifest, verification status, invocation
//                            ledger summary, and the install/lifecycle
//                            state with the actions THIS caller may
//                            legally take.
//   buildInstalledKitsView — the tenant's kit installations with their
//                            lifecycle states (the Installed surface's
//                            kit half).

import type { TenantContext } from '@/infra/tenant';
import { VerticalKitsError } from '@/modules/vertical-kits/contract';
import {
  STARTER_KITS,
  digestKitManifest,
  getKitInstallation,
  getKitStatus,
  getKitVersion,
  listKitEvents,
  listKitInstallations,
  listKitInvocations,
  listKitVersions,
  verifyKitManifest,
} from '@/modules/vertical-kits/contract';
import type {
  KitCapabilityDeclaration,
  KitInstallationStatus,
  VerticalKitManifest,
  VerticalKitVersionSummary,
} from '@/modules/vertical-kits/contract';
import { PUBLIC_CATALOG_TENANT, VIEW_LIMIT } from './views';
import {
  KIT_KIND_LABEL,
  deriveKitActions,
  kitCapabilityLines,
  kitComponentCounts,
  kitInstallPosture,
} from './kit-labels';
import type { KitActions, KitCapabilityLine } from './kit-labels';
import type { PillTone } from '../../lib/states';

/** How many ledger rows each kit detail view carries (progressive disclosure). */
const KIT_LEDGER_LIMIT = 8;

// ---------------------------------------------------------------------------
// The catalog's kits section
// ---------------------------------------------------------------------------

export interface KitCatalogItemView {
  kitKey: string;
  version: string;
  verticalKey: string;
  displayName: string;
  description: string;
  /** The full sha-256 manifest digest (the page renders a short form). */
  manifestDigest: string;
  verificationState: 'unverified' | 'verified' | 'failed';
  /** Where the verification posture is derived from (honest labeling). */
  verificationSource: 'shipped-manifest' | 'registry';
  /** Is the kit registered in the caller's tenant registry? */
  registered: boolean;
  /** The tenant's live install state (null when not installed / unscoped). */
  installStatus: KitInstallationStatus | null;
  installLabel: string;
  installTone: PillTone;
  counts: {
    capabilities: number;
    extensions: number;
    agents: number;
    integrations: number;
    schemaHints: number;
  };
  kindLabel: string;
  href: string;
}

export interface KitsCatalogView {
  ok: boolean;
  reason: string | null;
  generatedAt: string;
  scoped: boolean;
  items: KitCatalogItemView[];
  total: number;
}

/** The pure posture of a shipped kit: the module's own deterministic checks + digest. */
function shippedPosture(manifest: VerticalKitManifest): {
  verificationState: 'unverified' | 'verified' | 'failed';
  manifestDigest: string;
} {
  const outcome = verifyKitManifest(manifest);
  return {
    verificationState: outcome.outcome,
    manifestDigest: digestKitManifest(manifest),
  };
}

/** The latest registered version per kit key (the list is version-desc per key). */
function latestPerKit(versions: readonly VerticalKitVersionSummary[]): Map<string, VerticalKitVersionSummary> {
  const latest = new Map<string, VerticalKitVersionSummary>();
  for (const version of versions) {
    if (!latest.has(version.kitKey)) latest.set(version.kitKey, version);
  }
  return latest;
}

/**
 * Build the catalog's kits section. The shipped signed starter kits are
 * first-party module content — public by construction (the manifest,
 * its digest and the deterministic verification need no tenant data).
 * A scoped caller additionally sees its registry's kit versions and
 * each kit's live install state; a failed registry read degrades to
 * the quiet error pattern while the shipped rows keep rendering.
 */
export async function buildKitsCatalogView(ctx: TenantContext): Promise<KitsCatalogView> {
  const generatedAt = new Date().toISOString();
  const scoped = ctx.tenantId !== PUBLIC_CATALOG_TENANT;

  let versions: VerticalKitVersionSummary[] = [];
  let installs: { kitKey: string; status: KitInstallationStatus }[] = [];
  let ok = true;
  let reason: string | null = null;
  if (scoped) {
    try {
      const rows = await listKitVersions(ctx, {});
      versions = rows;
    } catch {
      ok = false;
      reason = 'registry_unavailable';
    }
    try {
      const rows = await listKitInstallations(ctx, {});
      installs = rows
        .filter((installation) => installation.status !== 'removed')
        .map((installation) => ({ kitKey: installation.kitKey, status: installation.status }));
    } catch {
      ok = false;
      reason = reason ?? 'installations_unavailable';
    }
  }

  const registry = latestPerKit(versions);
  const items: KitCatalogItemView[] = [];

  // The shipped signed kits — always listed, in the module's stable order.
  for (const manifest of STARTER_KITS) {
    const registered = registry.get(manifest.kitKey) ?? null;
    const posture =
      registered === null
        ? shippedPosture(manifest)
        : {
            verificationState: registered.verificationState,
            manifestDigest: registered.manifestDigest,
          };
    const install = installs.find((candidate) => candidate.kitKey === manifest.kitKey) ?? null;
    const postureView = kitInstallPosture(install?.status ?? null);
    items.push({
      kitKey: manifest.kitKey,
      version: registered?.version ?? manifest.version,
      verticalKey: manifest.verticalKey,
      displayName: manifest.displayName,
      description: manifest.description,
      manifestDigest: posture.manifestDigest,
      verificationState: posture.verificationState,
      verificationSource: registered === null ? 'shipped-manifest' : 'registry',
      registered: registered !== null,
      installStatus: install?.status ?? null,
      installLabel: postureView.label,
      installTone: postureView.tone,
      counts: kitComponentCounts(manifest),
      kindLabel: KIT_KIND_LABEL,
      href: `/marketplace/kit/${manifest.kitKey}`,
    });
  }

  // A scoped caller's registered kits beyond the shipped two — the
  // tenant's own registry content, visible only to itself.
  if (scoped) {
    for (const [kitKey, version] of registry) {
      if (STARTER_KITS.some((kit) => kit.kitKey === kitKey)) continue;
      const install = installs.find((candidate) => candidate.kitKey === kitKey) ?? null;
      const postureView = kitInstallPosture(install?.status ?? null);
      items.push({
        kitKey,
        version: version.version,
        verticalKey: version.verticalKey,
        displayName: version.displayName,
        description: version.description,
        manifestDigest: version.manifestDigest,
        verificationState: version.verificationState,
        verificationSource: 'registry',
        registered: true,
        installStatus: install?.status ?? null,
        installLabel: postureView.label,
        installTone: postureView.tone,
        counts: kitComponentCounts(version.manifest),
        kindLabel: KIT_KIND_LABEL,
        href: `/marketplace/kit/${kitKey}`,
      });
    }
  }

  return { ok, reason, generatedAt, scoped, items, total: items.length };
}

// ---------------------------------------------------------------------------
// Kit detail (identity + signed manifest + verification + ledger + lifecycle)
// ---------------------------------------------------------------------------

export interface KitVerificationView {
  state: 'unverified' | 'verified' | 'failed';
  /** 'registry-run' — the append-only run over the STORED version; 'shipped-manifest' — the same deterministic checks over the shipped content (not yet registered). */
  source: 'shipped-manifest' | 'registry-run';
  checks: { check: string; passed: boolean; detail: string | null }[];
  summary: string;
  ranAt: string | null;
}

export interface KitGrantView {
  capabilityKey: string;
  label: string;
  dataCategories: string[];
  status: 'active' | 'revoked';
  grantedAt: string;
}

export interface KitInvocationRowView {
  capabilityKey: string;
  outcome: 'allowed' | 'denied';
  basis: string;
  denialReason: string | null;
  invokedAt: string;
  invokedBy: string;
}

export interface KitInstallationView {
  id: string;
  status: KitInstallationStatus;
  installedBy: string;
  installedAt: string;
  reviewedAt: string | null;
  activatedAt: string | null;
  removedAt: string | null;
  removalReason: string | null;
  requiredCapabilities: KitCapabilityDeclaration[];
  grants: KitGrantView[];
}

export interface KitRuntimeView {
  grants: { active: number; revoked: number };
  invocations: { allowed: number; denied: number };
  recentInvocations: KitInvocationRowView[];
  extensions: { definitionKey: string; displayName: string; state: string }[];
  agents: { definitionKey: string; displayName: string; state: string }[];
  integrations: {
    integrationKey: string;
    systemLabel: string;
    readiness: 'deferred-on-w088' | 'ready';
  }[];
  edgeWired: string | null;
  events: { event: string; detail: string | null; recordedAt: string; recordedBy: string }[];
}

export interface KitDetailView {
  generatedAt: string;
  scoped: boolean;
  shipped: boolean;
  registered: boolean;
  kitKey: string;
  manifest: VerticalKitManifest;
  manifestDigest: string;
  registeredAt: string | null;
  versions: { id: string; version: string; verificationState: string; registeredAt: string }[];
  verification: KitVerificationView;
  capabilities: KitCapabilityLine[];
  installation: KitInstallationView | null;
  runtime: KitRuntimeView | null;
  /** Removed lifecycles retained as append-only audit (visible in the trail of the kit detail's lifecycle history). */
  removedCount: number;
  actions: KitActions;
}

export type KitViewResult =
  | { ok: true; view: KitDetailView }
  | { ok: false; failure: 'not_found' | 'unavailable' };

/**
 * Build one kit's detail view for THIS caller. A kit key that is
 * neither a shipped starter kit nor registered in the caller's tenant
 * registry is indistinguishable from a missing one — the honest
 * not-found state (another tenant's registry is invisible by design).
 */
export async function buildKitDetailView(
  ctx: TenantContext,
  kitKey: string,
): Promise<KitViewResult> {
  const generatedAt = new Date().toISOString();
  const scoped = ctx.tenantId !== PUBLIC_CATALOG_TENANT;
  const shipped = STARTER_KITS.find((kit) => kit.kitKey === kitKey) ?? null;

  // The caller's registry rows for this kit key (scoped only).
  let versions: VerticalKitVersionSummary[] = [];
  if (scoped) {
    try {
      versions = await listKitVersions(ctx, { kitKey });
    } catch (error) {
      if (error instanceof VerticalKitsError && error.code === 'invalid_query') {
        return { ok: false, failure: 'not_found' };
      }
      return { ok: false, failure: 'unavailable' };
    }
  }

  if (shipped === null && versions.length === 0) {
    return { ok: false, failure: 'not_found' };
  }

  // The manifest authority: the tenant's REGISTERED latest version when
  // present (the stored, digest-signed bytes the registry governs), else
  // the shipped module content.
  const latest = versions[0] ?? null;
  const manifest = latest?.manifest ?? shipped!;
  const manifestDigest = latest?.manifestDigest ?? digestKitManifest(shipped!);
  const registered = latest !== null;

  // Verification: the registry's append-only run over the STORED version
  // when registered; else the same deterministic checks over the shipped
  // manifest (labeled honestly — no registry run exists yet).
  let verification: KitVerificationView;
  if (registered) {
    try {
      const withRun = await getKitVersion(ctx, { kitVersionId: latest!.id });
      verification = {
        state: withRun.verification.state,
        source: 'registry-run',
        checks: (withRun.verification.latestRun?.checks ?? []).map((check) => ({
          check: check.check,
          passed: check.passed,
          detail: check.detail,
        })),
        summary: withRun.verification.latestRun?.summary ?? 'no verification run recorded yet',
        ranAt: withRun.verification.latestRun?.ranAt ?? null,
      };
    } catch {
      verification = {
        state: latest!.verificationState,
        source: 'registry-run',
        checks: [],
        summary: 'the verification run could not be read right now',
        ranAt: null,
      };
    }
  } else {
    const outcome = verifyKitManifest(manifest);
    verification = {
      state: outcome.outcome,
      source: 'shipped-manifest',
      checks: outcome.checks.map((check) => ({
        check: check.check,
        passed: check.passed,
        detail: check.detail,
      })),
      summary: outcome.summary,
      ranAt: null,
    };
  }

  // The tenant's installations for this kit (scoped only): the LIVE one
  // governs; removed lifecycles are retained history.
  let installations: {
    id: string;
    status: KitInstallationStatus;
  }[] = [];
  if (scoped) {
    try {
      const rows = await listKitInstallations(ctx, {});
      installations = rows
        .filter((installation) => installation.kitKey === kitKey)
        .map((installation) => ({ id: installation.id, status: installation.status }));
    } catch {
      installations = [];
    }
  }
  const live = installations.find((installation) => installation.status !== 'removed') ?? null;
  const removedCount = installations.filter((installation) => installation.status === 'removed').length;

  // The installation read model + the honest runtime status + the ledgers.
  let installation: KitInstallationView | null = null;
  let runtime: KitRuntimeView | null = null;
  if (scoped && live !== null) {
    try {
      const detail = await getKitInstallation(ctx, { installationId: live.id });
      installation = {
        id: detail.installation.id,
        status: detail.installation.status,
        installedBy: detail.installation.installedBy,
        installedAt: detail.installation.installedAt,
        reviewedAt: detail.installation.reviewedAt,
        activatedAt: detail.installation.activatedAt,
        removedAt: detail.installation.removedAt,
        removalReason: detail.installation.removalReason,
        requiredCapabilities: detail.requiredCapabilities,
        grants: detail.grants.map((grant) => ({
          capabilityKey: grant.capabilityKey,
          label: grant.label,
          dataCategories: [...grant.dataCategories],
          status: grant.status,
          grantedAt: grant.grantedAt,
        })),
      };
    } catch {
      installation = null;
    }
    try {
      const [status, invocations, events] = await Promise.all([
        getKitStatus(ctx, { installationId: live.id }),
        listKitInvocations(ctx, { installationId: live.id, limit: KIT_LEDGER_LIMIT }),
        listKitEvents(ctx, { installationId: live.id, limit: VIEW_LIMIT }),
      ]);
      runtime = {
        grants: status.grants,
        invocations: status.invocations,
        recentInvocations: invocations.map((invocation) => ({
          capabilityKey: invocation.capabilityKey,
          outcome: invocation.outcome,
          basis: invocation.basis,
          denialReason: invocation.denialReason,
          invokedAt: invocation.invokedAt,
          invokedBy: invocation.invokedBy,
        })),
        extensions: status.extensions.map((component) => ({
          definitionKey: component.definitionKey,
          displayName: component.displayName,
          state: component.state,
        })),
        agents: status.agents.map((component) => ({
          definitionKey: component.definitionKey,
          displayName: component.displayName,
          state: component.state,
        })),
        integrations: status.integrations.map((integration) => ({
          integrationKey: integration.integrationKey,
          systemLabel: integration.systemLabel,
          readiness: integration.readiness,
        })),
        edgeWired: status.edgeWired,
        events: events.map((event) => ({
          event: event.event,
          detail: event.detail,
          recordedAt: event.recordedAt,
          recordedBy: event.recordedBy,
        })),
      };
    } catch {
      runtime = null;
    }
  }

  const actions = deriveKitActions(ctx, {
    registered,
    verificationState: registered ? latest!.verificationState : verification.state,
    installation: live === null ? null : { status: live.status },
  });

  return {
    ok: true,
    view: {
      generatedAt,
      scoped,
      shipped: shipped !== null,
      registered,
      kitKey,
      manifest,
      manifestDigest,
      registeredAt: latest?.registeredAt ?? null,
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        verificationState: version.verificationState,
        registeredAt: version.registeredAt,
      })),
      verification,
      capabilities: kitCapabilityLines(manifest.requiredCapabilities),
      installation,
      runtime,
      removedCount,
      actions,
    },
  };
}

// ---------------------------------------------------------------------------
// Installed kits (the Installed surface's kit half)
// ---------------------------------------------------------------------------

export interface InstalledKitView {
  installationId: string;
  kitKey: string;
  kitVersion: string;
  status: KitInstallationStatus;
  stateLabel: string;
  stateTone: PillTone;
  installedAt: string;
  verificationState: string | null;
  grants: { active: number; revoked: number } | null;
}

export interface InstalledKitsView {
  ok: boolean;
  generatedAt: string;
  items: InstalledKitView[];
  total: number;
  /** Removed lifecycles retained as append-only audit (not live installs). */
  removedCount: number;
}

/**
 * Build the tenant's installed-kits governance summary: the LIVE kit
 * installations (the vertical-kits lifecycle's own states), each with
 * the verification posture of its installed version and its grant
 * counts. Removed lifecycles are counted, not listed — their audit
 * trail stays on the kit detail page.
 */
export async function buildInstalledKitsView(ctx: TenantContext): Promise<InstalledKitsView> {
  const generatedAt = new Date().toISOString();
  try {
    const installations = await listKitInstallations(ctx, {});
    const live = installations.filter((installation) => installation.status !== 'removed');
    const removedCount = installations.length - live.length;

    // The registry's version postures, one read, keyed by version id.
    let versions: VerticalKitVersionSummary[] = [];
    try {
      versions = await listKitVersions(ctx, {});
    } catch {
      versions = [];
    }
    const byVersionId = new Map(versions.map((version) => [version.id, version] as const));

    const items: InstalledKitView[] = await Promise.all(
      live.map(async (installation) => {
        const version = byVersionId.get(installation.kitVersionId) ?? null;
        let grants: { active: number; revoked: number } | null;
        try {
          const detail = await getKitInstallation(ctx, { installationId: installation.id });
          grants = {
            active: detail.grants.filter((grant) => grant.status === 'active').length,
            revoked: detail.grants.filter((grant) => grant.status === 'revoked').length,
          };
        } catch {
          grants = null;
        }
        const posture = kitInstallPosture(installation.status);
        return {
          installationId: installation.id,
          kitKey: installation.kitKey,
          kitVersion: installation.kitVersion,
          status: installation.status,
          stateLabel: posture.label,
          stateTone: posture.tone,
          installedAt: installation.installedAt,
          verificationState: version?.verificationState ?? null,
          grants,
        };
      }),
    );
    return { ok: true, generatedAt, items, total: items.length, removedCount };
  } catch {
    return { ok: false, generatedAt, items: [], total: 0, removedCount: 0 };
  }
}
