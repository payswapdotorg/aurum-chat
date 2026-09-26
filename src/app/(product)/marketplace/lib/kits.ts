// Product surface (W105) — the vertical starter kits' marketplace path.
//
// Journey J22's blocked component was exactly this: the W092 vertical
// kits (two signed starter kits living in the vertical-kits module with
// versioned manifests, an invocation ledger, verification and their own
// install lifecycle) had NO user-visible path. This library gives them
// one through the marketplace surfaces the journey already traverses —
// ADDITIVELY, without touching any extension/agent listing semantics.
//
// WHY A KITS SECTION, NOT CATALOG PACKAGES (the honest wiring): the
// governed marketplace catalog (W028) is a PLATFORM-level artifact
// registry whose chain is DRAFT → SUBMITTED → AUTOMATED_VERIFICATION →
// PENDING_REVIEW → APPROVED/REJECTED → PUBLISHED → INSTALLABLE for
// exactly two kinds (extension, agent). The kits are NOT third-party
// submissions to that pipeline: they are FIRST-PARTY shipped content —
// versioned, SIGNED (every manifest carries the sha-256 digest of its
// canonical JSON) and verified by the vertical-kits module's own
// deterministic checks folded into registration, with a TENANT-side
// install lifecycle (pending-review → granted → active ⇄ suspended →
// removed) routed through the W009 authority gate. Forcing them through
// the package chain would fake governance states they do not have; this
// section instead reads the REAL states from the vertical-kits contract
// and renders them with the marketplace's own listing vocabulary
// (panels, pills, tags, honest empty/error states).
//
// The same discipline the marketplace views follow (lock 31/32):
// server-side composition of existing module contracts ONLY — every
// read degrades honestly (a failed read renders the quiet error
// pattern, never fake emptiness), and every write is one contract
// operation behind the area's API adapter (lib/api.ts).
//
// VIEWS:
//   shippedStarterKits      — the pure read-model over the module's
//                             shipped content (digests + counts).
//   buildKitCatalogSection  — the catalog's kits panel (the two signed
//                             starter kits +, when scoped, the caller's
//                             registry/verification/installation state).
//   buildKitDetailView      — one kit: identity, the signed version
//                             manifest, verification (the shipped
//                             posture + the recorded runs), the required
//                             capabilities, starter components, data
//                             schema hints, integration readiness, the
//                             invocation ledger summary and the
//                             install/lifecycle state + the actions
//                             THIS caller may legally take.
//   buildKitInstalledSection— the installed view's kits panel (the
//                             tenant's kit installations with their
//                             lifecycle states, grants and invocation
//                             counts).

import type { TenantContext } from '@/infra/tenant';
import {
  STARTER_KITS,
  VERTICAL_KITS_AUTHORITY_ADMINISTER,
  digestKitManifest,
  getKitStatus,
  getKitVersion,
  getVerticalKitEdge,
  listKitEvents,
  listKitInstallations,
  listKitInvocations,
  listKitVersions,
  verifyKitManifest,
} from '@/modules/vertical-kits/contract';
import type {
  KitCapabilityInvocation,
  KitInstallation,
  KitInstallationEvent,
  KitInstallationStatus,
  KitStatusReport,
  VerticalKitManifest,
  VerticalKitVersionSummary,
  VerticalKitVerification,
} from '@/modules/vertical-kits/contract';
import { PUBLIC_CATALOG_TENANT } from './views';
import type { PillTone } from '../../lib/states';

/** How many ledger/audit rows the detail view carries (progressive disclosure). */
export const KIT_LEDGER_LIMIT = 10;

/** The claim the actions module's decision gate checks (decideKitReview rides it). */
const CLAIM_ACTIONS_APPROVE = 'actions:approve';

// ---------------------------------------------------------------------------
// The kit lifecycle vocabulary (the module's own states, human-labeled)
// ---------------------------------------------------------------------------

/** Human label for one kit installation state (the pill's text). */
export function kitInstallationStateLabel(state: KitInstallationStatus): string {
  switch (state) {
    case 'pending-review':
      return 'Pending grant review';
    case 'rejected':
      return 'Rejected';
    case 'granted':
      return 'Granted';
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
    case 'removed':
      return 'Removed';
  }
}

/** The pill tone for one kit installation state. */
export function kitInstallationStateTone(state: KitInstallationStatus): PillTone {
  switch (state) {
    case 'active':
      return 'positive';
    case 'pending-review':
    case 'suspended':
      return 'warning';
    case 'rejected':
      return 'error';
    case 'granted':
      return 'info';
    case 'removed':
      return 'neutral';
  }
}

/** One plain sentence explaining what an installation state means. */
export function kitInstallationStateExplanation(state: KitInstallationStatus): string {
  switch (state) {
    case 'pending-review':
      return 'Installed but the grant review is waiting for a human decision — the W009 authority gate holds the kit until an authorized principal (not the requester) approves or rejects it.';
    case 'rejected':
      return 'The grant review (or the tenant policy) refused the kit — terminal for this install; denial minted no grant. A fresh install lifecycle may be started.';
    case 'granted':
      return 'The grant review approved; exactly the declared capabilities are minted as kit grants. The kit is not yet switched on.';
    case 'active':
      return 'Activated and usable — capability invocations pass the gate when the kit holds the matching active grant.';
    case 'suspended':
      return 'Temporarily disabled — every invocation is denied while suspended; resuming returns the kit to active.';
    case 'removed':
      return 'Removed — terminal. Every grant was revoked with the kit (no orphaned authority); the append-only audit trail is retained.';
  }
}

/** Is a kit installation state live (not yet removed)? */
export function isLiveKitInstallation(status: KitInstallationStatus): boolean {
  return status !== 'removed';
}

/** The verification posture of a kit version, human-labeled. */
export function kitVerificationLabel(state: 'unverified' | 'verified' | 'failed'): string {
  switch (state) {
    case 'verified':
      return 'Verified';
    case 'failed':
      return 'Verification failed';
    case 'unverified':
      return 'Not verified';
  }
}

// ---------------------------------------------------------------------------
// The shipped starter kits (the pure read-model over the module's content)
// ---------------------------------------------------------------------------

/** One shipped starter kit as the catalog lists it (pure — no database). */
export interface ShippedKitView {
  kitKey: string;
  displayName: string;
  description: string;
  verticalKey: string;
  /** The shipped release semver. */
  version: string;
  /** The sha-256 digest of the canonical JSON of the shipped manifest — its integrity signature. */
  manifestDigest: string;
  capabilityCount: number;
  extensionDefinitionCount: number;
  agentDefinitionCount: number;
  integrationCount: number;
  schemaHintCount: number;
}

function toShippedKit(manifest: VerticalKitManifest): ShippedKitView {
  return {
    kitKey: manifest.kitKey,
    displayName: manifest.displayName,
    description: manifest.description,
    verticalKey: manifest.verticalKey,
    version: manifest.version,
    manifestDigest: digestKitManifest(manifest),
    capabilityCount: manifest.requiredCapabilities.length,
    extensionDefinitionCount: manifest.extensionDefinitions.length,
    agentDefinitionCount: manifest.agentDefinitions.length,
    integrationCount: manifest.edgeIntegrations.length,
    schemaHintCount: manifest.dataSchemaHints.length,
  };
}

/** The module's shipped starter kits, digested (pure, total, honest). */
export function shippedStarterKits(): ShippedKitView[] {
  return STARTER_KITS.map(toShippedKit);
}

/** Find one shipped starter kit by its stable key (pure). */
export function findShippedKit(kitKey: string): VerticalKitManifest | null {
  return STARTER_KITS.find((manifest) => manifest.kitKey === kitKey) ?? null;
}

// ---------------------------------------------------------------------------
// The catalog section (the kits panel on /marketplace)
// ---------------------------------------------------------------------------

/** What the catalog pill shows for one kit (its strongest current state). */
export type KitCatalogState =
  | { kind: 'installation'; status: KitInstallationStatus }
  | { kind: 'verification'; state: 'unverified' | 'verified' | 'failed' }
  | { kind: 'shipped' }
  | { kind: 'unknown' };

/** The state of one kit as THIS caller's tenant has it (scoped reads only). */
export interface KitTenantState {
  /** The latest registered version in the tenant's registry (null = none). */
  registered: { id: string; version: string; verificationState: 'unverified' | 'verified' | 'failed' } | null;
  /** The live installation (null = no lifecycle running). */
  installation: { id: string; status: KitInstallationStatus } | null;
}

/** One catalog kit item (shipped content + the caller's tenant state). */
export interface KitCatalogItemView extends ShippedKitView {
  /** The catalog pill's state (the strongest current fact). */
  state: KitCatalogState;
  stateLabel: string;
  stateTone: PillTone;
  /** The caller's tenant state (null when browsing unscoped / registry read failed). */
  tenant: KitTenantState | null;
}

export interface KitCatalogSectionView {
  ok: boolean;
  reason: string | null;
  generatedAt: string;
  tenantScoped: boolean;
  /** True when the caller is scoped but the registry reads failed (honest degrade). */
  registryUnavailable: boolean;
  items: KitCatalogItemView[];
  total: number;
}

/** The label for the catalog pill (pure). */
export function kitCatalogStateLabel(state: KitCatalogState): string {
  switch (state.kind) {
    case 'installation':
      return kitInstallationStateLabel(state.status);
    case 'verification':
      return kitVerificationLabel(state.state);
    case 'shipped':
      return 'Signed starter kit';
    case 'unknown':
      return 'State unavailable';
  }
}

/** The tone for the catalog pill (pure). */
export function kitCatalogStateTone(state: KitCatalogState): PillTone {
  switch (state.kind) {
    case 'installation':
      return kitInstallationStateTone(state.status);
    case 'verification':
      switch (state.state) {
        case 'verified':
          return 'positive';
        case 'failed':
          return 'error';
        default:
          return 'neutral';
      }
    case 'shipped':
      return 'info';
    case 'unknown':
      return 'neutral';
  }
}

/**
 * Build the catalog's kits section: the shipped starter kits always,
 * enriched with the caller's registry/installation state when the
 * context is a real scoped tenant. Each read degrades honestly — a
 * failed registry read keeps the section working and marks the tenant
 * state unavailable (never a fake "not registered").
 */
export async function buildKitCatalogSection(ctx: TenantContext): Promise<KitCatalogSectionView> {
  const generatedAt = new Date().toISOString();
  const shipped = shippedStarterKits();
  const tenantScoped = ctx.tenantId !== PUBLIC_CATALOG_TENANT;

  let versionsByKit = new Map<string, VerticalKitVersionSummary[]>();
  let installationsByKit = new Map<string, KitInstallation>();
  let registryUnavailable = false;
  if (tenantScoped) {
    try {
      const all = await listKitVersions(ctx, {});
      for (const version of all) {
        const list = versionsByKit.get(version.kitKey) ?? [];
        list.push(version);
        versionsByKit.set(version.kitKey, list);
      }
    } catch {
      registryUnavailable = true;
      versionsByKit = new Map();
    }
    try {
      const installations = await listKitInstallations(ctx, {});
      for (const installation of installations) {
        if (isLiveKitInstallation(installation.status)) {
          installationsByKit.set(installation.kitKey, installation);
        }
      }
    } catch {
      registryUnavailable = true;
      installationsByKit = new Map();
    }
  }

  const items: KitCatalogItemView[] = shipped.map((kit) => {
    const versions = versionsByKit.get(kit.kitKey) ?? [];
    const latest = versions[0] ?? null;
    const installation = installationsByKit.get(kit.kitKey) ?? null;
    const tenant: KitTenantState | null = tenantScoped
      ? {
          registered:
            latest === null
              ? null
              : { id: latest.id, version: latest.version, verificationState: latest.verificationState },
          installation:
            installation === null ? null : { id: installation.id, status: installation.status },
        }
      : null;
    const state: KitCatalogState = !tenantScoped
      ? { kind: 'shipped' }
      : installation !== null
        ? { kind: 'installation', status: installation.status }
        : latest !== null
          ? { kind: 'verification', state: latest.verificationState }
          : registryUnavailable
            ? { kind: 'unknown' }
            : { kind: 'shipped' };
    return {
      ...kit,
      state,
      stateLabel: kitCatalogStateLabel(state),
      stateTone: kitCatalogStateTone(state),
      tenant,
    };
  });

  return {
    ok: true,
    reason: null,
    generatedAt,
    tenantScoped,
    registryUnavailable,
    items,
    total: items.length,
  };
}

// ---------------------------------------------------------------------------
// Action availability (what THIS caller may do with THIS kit — pure)
// ---------------------------------------------------------------------------

/** The actions surface for one kit as one derivable record (pure). */
export interface KitActions {
  /** True when the caller has a real company scope (any action needs one). */
  scoped: boolean;
  /** True when the caller carries the vertical-kits administer claim. */
  canAdminister: boolean;
  canRegister: boolean;
  registerBlockedReason: string | null;
  /** The latest registered version exists and may be re-verified (drift detection). */
  canRunVerification: boolean;
  verificationBlockedReason: string | null;
  canInstall: boolean;
  installBlockedReason: string | null;
  canDecideReview: boolean;
  decideBlockedReason: string | null;
  canActivate: boolean;
  canSuspend: boolean;
  canResume: boolean;
  canRemove: boolean;
}

/** The kit facts the action derivation needs (registry + installation reads). */
export interface KitActionFacts {
  /** The shipped version the surface offers to register (null when unknown kit). */
  shippedVersion: string | null;
  /** The tenant's registered versions of this kit (empty = none). */
  registeredVersions: readonly { version: string; verificationState: 'unverified' | 'verified' | 'failed' }[];
  /** The live installation (null = none). */
  installation: Pick<KitInstallation, 'status' | 'installedBy'> | null;
}

function isVerified(facts: KitActionFacts): boolean {
  return facts.registeredVersions.some((version) => version.verificationState === 'verified');
}

/** Is the shipped starter version already in the tenant's registry? (pure) */
export function shippedVersionRegistered(facts: KitActionFacts): boolean {
  return (
    facts.shippedVersion !== null &&
    facts.registeredVersions.some((version) => version.version === facts.shippedVersion)
  );
}

/**
 * Derive what a caller (tenant + principal + authority claims) may do
 * with one kit — the exact rules the vertical-kits contract enforces,
 * so the UI never offers an action the contract would refuse (and never
 * hides one it would allow). Pure and total.
 */
export function deriveKitActions(
  caller: { tenantId: string; principalId: string; authority: readonly string[] },
  facts: KitActionFacts,
): KitActions {
  const scoped = caller.tenantId !== PUBLIC_CATALOG_TENANT;
  const canAdminister = caller.authority.includes(VERTICAL_KITS_AUTHORITY_ADMINISTER);
  const canApprove = caller.authority.includes(CLAIM_ACTIONS_APPROVE);
  const installation = facts.installation;

  // --- register (the shipped starter version into this tenant's registry)
  let registerBlockedReason: string | null = null;
  if (!scoped) {
    registerBlockedReason = 'registering a kit needs your company scope — sign in first';
  } else if (!canAdminister) {
    registerBlockedReason = `registering a kit version requires the '${VERTICAL_KITS_AUTHORITY_ADMINISTER}' authority claim`;
  } else if (facts.shippedVersion === null) {
    registerBlockedReason = 'this kit is not shipped starter content';
  } else if (shippedVersionRegistered(facts)) {
    registerBlockedReason = `version ${facts.shippedVersion} is already registered in your registry`;
  }

  // --- verify (a recorded, append-only run over the stored version)
  let verificationBlockedReason: string | null = null;
  if (!scoped) {
    verificationBlockedReason = 'running verification needs your company scope — sign in first';
  } else if (!canAdminister) {
    verificationBlockedReason = `running kit verification requires the '${VERTICAL_KITS_AUTHORITY_ADMINISTER}' authority claim`;
  } else if (facts.registeredVersions.length === 0) {
    verificationBlockedReason = 'no version of this kit is registered in your registry yet';
  }

  // --- install (the vertical-kits lifecycle — NOT the extension flow)
  let installBlockedReason: string | null = null;
  if (!scoped) {
    installBlockedReason = 'installing a kit needs your company scope — sign in first';
  } else if (!canAdminister) {
    installBlockedReason = `installing a kit requires the '${VERTICAL_KITS_AUTHORITY_ADMINISTER}' authority claim`;
  } else if (!isVerified(facts)) {
    installBlockedReason =
      facts.registeredVersions.length === 0
        ? 'register a version of this kit first — install requires a registered, verified version'
        : 'only a verified version can be installed — run the verification first';
  } else if (installation !== null) {
    installBlockedReason = `this kit already has a live installation ('${kitInstallationStateLabel(installation.status)}') — remove it before installing again`;
  }

  // --- decide the pending grant review (the W009 gate's human decision)
  let decideBlockedReason: string | null = null;
  if (!scoped) {
    decideBlockedReason = 'deciding a grant review needs your company scope — sign in first';
  } else if (installation === null || installation.status !== 'pending-review') {
    decideBlockedReason = 'no pending grant review on this kit right now';
  } else if (!canApprove) {
    decideBlockedReason = `deciding the grant review requires the '${CLAIM_ACTIONS_APPROVE}' authority claim`;
  } else if (installation.installedBy === caller.principalId) {
    decideBlockedReason =
      'separation of duties: the principal who requested this install never decides its own grant review — another authorized principal decides it';
  }

  // --- the administrative lifecycle transitions (claim-gated, state-gated)
  const lifecycleAvailable =
    scoped &&
    canAdminister &&
    installation !== null &&
    (installation.status === 'granted' ||
      installation.status === 'active' ||
      installation.status === 'suspended' ||
      installation.status === 'pending-review' ||
      installation.status === 'rejected');

  return {
    scoped,
    canAdminister,
    canRegister: registerBlockedReason === null,
    registerBlockedReason,
    canRunVerification: verificationBlockedReason === null,
    verificationBlockedReason,
    canInstall: installBlockedReason === null,
    installBlockedReason,
    canDecideReview: decideBlockedReason === null,
    decideBlockedReason,
    canActivate: lifecycleAvailable && installation !== null && installation.status === 'granted',
    canSuspend: lifecycleAvailable && installation !== null && installation.status === 'active',
    canResume: lifecycleAvailable && installation !== null && installation.status === 'suspended',
    canRemove: lifecycleAvailable,
  };
}

// ---------------------------------------------------------------------------
// The kit detail view (/marketplace/kit/<kitKey>)
// ---------------------------------------------------------------------------

/** One required capability of the kit, as the detail page inspects it. */
export interface KitCapabilityLine {
  key: string;
  label: string;
  dataCategories: string[];
  mode: 'read' | 'write';
}

/** One starter component definition (honestly 'defined', never deployed software). */
export interface KitComponentLine {
  definitionKey: string;
  displayName: string;
  description: string;
  componentKind: 'extension' | 'agent';
}

/** One vertical data-schema hint (the entities the kit works with). */
export interface KitSchemaHintLine {
  entity: string;
  label: string;
  fieldCount: number;
  requiredFields: string[];
}

/** One declared system-of-record integration with its honest readiness. */
export interface KitIntegrationLine {
  integrationKey: string;
  systemLabel: string;
  description: string;
  readCapabilityKey: string;
  writeCapabilityKey: string | null;
  readiness: 'deferred-on-w088' | 'ready';
}

/** One registered version in the tenant's kit registry. */
export interface KitRegistryVersionView {
  id: string;
  version: string;
  verificationState: 'unverified' | 'verified' | 'failed';
  registeredAt: string;
}

/** The live installation with its ledgers (scoped reads only). */
export interface KitInstallationView {
  id: string;
  status: KitInstallationStatus;
  stateLabel: string;
  stateTone: PillTone;
  stateExplanation: string;
  kitVersion: string;
  installedAt: string;
  reviewedAt: string | null;
  activatedAt: string | null;
  removedAt: string | null;
  removalReason: string | null;
  /** The W009 gate record the review routed through. */
  actionRequestId: string;
  installedBy: string;
  grants: { active: number; revoked: number };
  invocations: { allowed: number; denied: number };
  recentEvents: KitInstallationEvent[];
  recentInvocations: KitCapabilityInvocation[];
}

export interface KitDetailView {
  generatedAt: string;
  // identity + the signed shipped manifest
  kitKey: string;
  displayName: string;
  description: string;
  verticalKey: string;
  shippedVersion: string;
  manifestDigest: string;
  // the shipped content's deterministic-check posture (computed over the
  // shipped bytes NOW — honestly labeled, never claimed as a recorded run)
  shippedChecks: { check: string; passed: boolean; detail: string | null }[];
  shippedChecksOutcome: 'verified' | 'failed';
  // the permission inspection (the kit's requested authority)
  capabilities: KitCapabilityLine[];
  // starter components + data hints + integrations (honest states)
  components: KitComponentLine[];
  schemaHints: KitSchemaHintLine[];
  integrations: KitIntegrationLine[];
  // the tenant's registry (null when browsing unscoped)
  registry: {
    ok: boolean;
    versions: KitRegistryVersionView[];
    /** The latest recorded verification run (null = none recorded). */
    latestRun: VerticalKitVerification | null;
  } | null;
  // the live installation (null when none or unscoped)
  installation: KitInstallationView | null;
  // the actions THIS caller may legally take
  actions: KitActions;
}

export type KitDetailResult =
  | { ok: true; view: KitDetailView }
  | { ok: false; failure: 'not_found' | 'unavailable' };

/**
 * Build one kit's detail view for THIS caller. An unknown kit key is the
 * honest not-found state; every tenant-scoped read degrades honestly
 * (the shipped content keeps rendering, the registry/installation
 * sections say what failed).
 */
export async function buildKitDetailView(
  ctx: TenantContext,
  kitKey: string,
): Promise<KitDetailResult> {
  const manifest = findShippedKit(kitKey);
  if (manifest === null) {
    return { ok: false, failure: 'not_found' };
  }

  const generatedAt = new Date().toISOString();
  const digest = digestKitManifest(manifest);

  // The shipped content's posture: the SAME deterministic checks
  // registration enforces, computed over the shipped bytes (pure).
  const shipped = verifyKitManifest(manifest, digest);
  const shippedChecks = shipped.checks.map((check) => ({
    check: check.check,
    passed: check.passed,
    detail: check.detail,
  }));

  const capabilities: KitCapabilityLine[] = manifest.requiredCapabilities.map((capability) => ({
    key: capability.key,
    label: capability.label,
    dataCategories: [...capability.dataCategories],
    mode: capability.mode,
  }));

  const components: KitComponentLine[] = [
    ...manifest.extensionDefinitions.map((definition) => ({
      definitionKey: definition.definitionKey,
      displayName: definition.displayName,
      description: definition.description,
      componentKind: 'extension' as const,
    })),
    ...manifest.agentDefinitions.map((definition) => ({
      definitionKey: definition.definitionKey,
      displayName: definition.displayName,
      description: definition.description,
      componentKind: 'agent' as const,
    })),
  ];

  const schemaHints: KitSchemaHintLine[] = manifest.dataSchemaHints.map((hint) => ({
    entity: hint.entity,
    label: hint.label,
    fieldCount: hint.fields.length,
    requiredFields: hint.fields.filter((field) => field.required).map((field) => field.name),
  }));

  // Honest integration readiness: the deep-integration paths wait on the
  // Edge Connector (W088) behind the module's own edge seam.
  const wired = getVerticalKitEdge();
  const integrations: KitIntegrationLine[] = manifest.edgeIntegrations.map((integration) => ({
    integrationKey: integration.integrationKey,
    systemLabel: integration.systemLabel,
    description: integration.description,
    readCapabilityKey: integration.readCapabilityKey,
    writeCapabilityKey: integration.writeCapabilityKey,
    readiness: wired === null ? 'deferred-on-w088' : 'ready',
  }));

  const tenantScoped = ctx.tenantId !== PUBLIC_CATALOG_TENANT;

  // --- the tenant's registry (honest degrade per read) ------------------
  let registry: KitDetailView['registry'] = null;
  let registeredVersions: KitRegistryVersionView[] = [];
  let latestRun: VerticalKitVerification | null = null;
  let liveInstallation: KitInstallation | null = null;
  let installationView: KitInstallationView | null = null;

  if (tenantScoped) {
    let registryOk = true;
    try {
      const versions = await listKitVersions(ctx, { kitKey });
      registeredVersions = versions.map((version) => ({
        id: version.id,
        version: version.version,
        verificationState: version.verificationState,
        registeredAt: version.registeredAt,
      }));
      const latest = versions[0] ?? null;
      if (latest !== null) {
        try {
          const detail = await getKitVersion(ctx, { kitVersionId: latest.id });
          latestRun = detail.verification.latestRun;
        } catch {
          latestRun = null;
        }
      }
    } catch {
      registryOk = false;
      registeredVersions = [];
    }
    registry = { ok: registryOk, versions: registeredVersions, latestRun };

    // --- the live installation (with its ledgers) ----------------------
    try {
      const installations = await listKitInstallations(ctx, {});
      liveInstallation = installations.find((row) => row.kitKey === kitKey && isLiveKitInstallation(row.status)) ?? null;
    } catch {
      liveInstallation = null;
    }

    if (liveInstallation !== null) {
      let statusReport: KitStatusReport | null;
      try {
        statusReport = await getKitStatus(ctx, { installationId: liveInstallation.id });
      } catch {
        statusReport = null; // the counts degrade to the honest unavailable below
      }
      let recentEvents: KitInstallationEvent[];
      try {
        recentEvents = await listKitEvents(ctx, {
          installationId: liveInstallation.id,
          limit: KIT_LEDGER_LIMIT,
        });
      } catch {
        recentEvents = [];
      }
      let recentInvocations: KitCapabilityInvocation[];
      try {
        recentInvocations = await listKitInvocations(ctx, {
          installationId: liveInstallation.id,
          limit: KIT_LEDGER_LIMIT,
        });
      } catch {
        recentInvocations = [];
      }
      installationView = {
        id: liveInstallation.id,
        status: liveInstallation.status,
        stateLabel: kitInstallationStateLabel(liveInstallation.status),
        stateTone: kitInstallationStateTone(liveInstallation.status),
        stateExplanation: kitInstallationStateExplanation(liveInstallation.status),
        kitVersion: liveInstallation.kitVersion,
        installedAt: liveInstallation.installedAt,
        reviewedAt: liveInstallation.reviewedAt,
        activatedAt: liveInstallation.activatedAt,
        removedAt: liveInstallation.removedAt,
        removalReason: liveInstallation.removalReason,
        actionRequestId: liveInstallation.actionRequestId,
        installedBy: liveInstallation.installedBy,
        grants: statusReport?.grants ?? { active: 0, revoked: 0 },
        invocations: statusReport?.invocations ?? { allowed: 0, denied: 0 },
        recentEvents,
        recentInvocations,
      };
    }
  }

  const facts: KitActionFacts = {
    shippedVersion: manifest.version,
    registeredVersions: registeredVersions.map((version) => ({
      version: version.version,
      verificationState: version.verificationState,
    })),
    installation:
      liveInstallation === null
        ? null
        : { status: liveInstallation.status, installedBy: liveInstallation.installedBy },
  };

  return {
    ok: true,
    view: {
      generatedAt,
      kitKey: manifest.kitKey,
      displayName: manifest.displayName,
      description: manifest.description,
      verticalKey: manifest.verticalKey,
      shippedVersion: manifest.version,
      manifestDigest: digest,
      shippedChecks,
      shippedChecksOutcome: shipped.outcome,
      capabilities,
      components,
      schemaHints,
      integrations,
      registry,
      installation: installationView,
      actions: deriveKitActions(ctx, facts),
    },
  };
}

// ---------------------------------------------------------------------------
// The installed view's kits section (/marketplace/installed)
// ---------------------------------------------------------------------------

/** One installed kit as the installed view lists it. */
export interface KitInstalledItemView {
  id: string;
  kitKey: string;
  kitVersion: string;
  status: KitInstallationStatus;
  stateLabel: string;
  stateTone: PillTone;
  stateExplanation: string;
  installedAt: string;
  grants: { active: number; revoked: number } | null;
  invocations: { allowed: number; denied: number } | null;
  /** True when the installation is the kit's live lifecycle. */
  live: boolean;
}

export interface KitInstalledSectionView {
  ok: boolean;
  reason: string | null;
  generatedAt: string;
  items: KitInstalledItemView[];
  total: number;
}

/**
 * Build the installed view's kits section: the tenant's kit
 * installations — live lifecycles first with their grants and
 * invocation counts, the terminal (removed/rejected) history retained
 * below, consistent with how the extensions list keeps deprecated rows.
 */
export async function buildKitInstalledSection(ctx: TenantContext): Promise<KitInstalledSectionView> {
  const generatedAt = new Date().toISOString();
  try {
    const installations = await listKitInstallations(ctx, {});
    const items: KitInstalledItemView[] = [];
    for (const installation of installations) {
      let grants: { active: number; revoked: number } | null = null;
      let invocations: { allowed: number; denied: number } | null = null;
      try {
        const report = await getKitStatus(ctx, { installationId: installation.id });
        grants = report.grants;
        invocations = report.invocations;
      } catch {
        // The counts degrade to null (rendered honestly as unavailable);
        // the installation row itself still lists.
      }
      items.push({
        id: installation.id,
        kitKey: installation.kitKey,
        kitVersion: installation.kitVersion,
        status: installation.status,
        stateLabel: kitInstallationStateLabel(installation.status),
        stateTone: kitInstallationStateTone(installation.status),
        stateExplanation: kitInstallationStateExplanation(installation.status),
        installedAt: installation.installedAt,
        grants,
        invocations,
        live: isLiveKitInstallation(installation.status),
      });
    }
    // Live lifecycles first, then the terminal history (newest first).
    items.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.installedAt.localeCompare(a.installedAt);
    });
    return { ok: true, reason: null, generatedAt, items, total: items.length };
  } catch {
    return { ok: false, reason: 'unavailable', generatedAt, items: [], total: 0 };
  }
}
