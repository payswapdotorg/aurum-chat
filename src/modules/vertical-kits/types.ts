// Public domain types of the vertical-kits module (W092 — Vertical
// Extension Starter Kits).
//
// W092 owns the KIT layer of the extension story:
//
//   "Create reusable specialist extension/agent starter kits and first
//    deep integrations for system-of-record-heavy industries without
//    moving vertical semantics into Aurum core."
//   Acceptance: "each pack is installable, permission-scoped, versioned,
//   auditable and removable; core modules remain industry-independent."
//
// A KIT IS DATA, NOT CODE. One kit is one versioned BUNDLE (release
// semver, the extensions module's discipline) of five DATA parts:
//
//   1. extension manifests — one per system-of-record integration, each
//      an ordinary `RegisterExtensionManifestInput` of the extensions
//      contract (W025) COMPOSED, never forked: the kit adds only the
//      connection it rides and a plain-language system-of-record label;
//   2. the permission-scope declaration — the kit's capability
//      footprint, EXACTLY the union of the manifests' requested
//      permission sets (fail-closed at validation: the declared
//      footprint must equal the union, neither more nor less);
//   3. deep-action recipe templates — canonical operation plans shaped
//      after the deep-actions gateway's contract (W084) as DATA: each
//      operation names a kit connection requirement and a W081 write
//      capability key, carries a canonical payload and the expected
//      downstream state reconciliation will verify against. NO
//      execution logic lives here — a recipe instantiates into a
//      `CreateDeepActionInput` at use time (see validation.ts);
//   4. connection-class requirements — the broker connection templates
//      the kit needs: one W082 `BrokerProvider` plus the W081
//      capability classes that connection must offer;
//   5. honest kit metadata — the industry label, intended outcomes and,
//      explicitly, what is NOT included.
//
// VERTICAL SEMANTICS NEVER ENTER CORE MODULES, AND THEY DO NOT ENTER
// THIS MODULE'S LOGIC EITHER: the module code (validation, service,
// reads) is industry-blind — the two starter kits ship as REGISTERED
// DATA records (kits.ts) that this module validates and serves
// generically. The core-independence test under tests/ proves both
// directions at grep level: no kit-content term appears in any other
// module, and no kit-content term appears in this module outside the
// data file.
//
// THE HONEST PENDING-EDGE DECLARATION (the W092/W088 boundary): the
// `edgeExecution` field declares WHICH recipes expect the Edge
// Connector (W088, in flight on a sibling branch at this base). It is
// VALIDATED here (unknown recipe keys are refused) and rendered as the
// literal status 'pending-w088' everywhere it surfaces — this module
// never claims edge execution and contains no edge code path.
//
// Tenancy (ADR-0001): kit definitions are platform-supplied data with
// no tenant state; installation, grants, lifecycle events and recipe
// references are tenant-scoped rows (migrations/001) — another tenant's
// kit lifecycle is indistinguishable from missing.

import type {
  BrokerProvider,
} from '@/modules/connection-broker/contract';
import type {
  ExtensionCapabilities,
  ExtensionPermission,
  ExtensionQuotas,
  RegisterExtensionManifestInput,
  SemverParts,
} from '@/modules/extensions/contract';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The kit lifecycle event vocabulary — the append-only audit trail a
 * kit's installation history lands on (install / upgrade / remove:
 * who, when, from which version to which, with exactly what grants and
 * package bindings).
 */
export const VERTICAL_KIT_EVENT_TYPES = ['install', 'upgrade', 'remove'] as const;

export type VerticalKitEventType = (typeof VERTICAL_KIT_EVENT_TYPES)[number];

/**
 * The edge-execution compatibility status. There is exactly ONE value
// at this base on purpose: the W088 Edge Connector is in flight on a
// sibling branch, so every edge-expecting kit operation renders the
// SAME honest status. When W088 lands, its work item widens this
 * vocabulary — never a silent rewrite here.
 */
export const EDGE_EXECUTION_STATUS = 'pending-w088' as const;

export type EdgeExecutionStatus = typeof EDGE_EXECUTION_STATUS;

// ---------------------------------------------------------------------------
// Kit definitions (the versioned DATA bundles)
// ---------------------------------------------------------------------------

/**
 * One connection-class requirement: the broker connection template a
 * kit needs — one W082 `BrokerProvider` (validated against the closed
// `BROKER_PROVIDERS` vocabulary) plus the W081 capability classes
 * (validated against the closed `CAPABILITY_CLASS_KEYS` vocabulary)
 * that connection must offer. The kit's recipe operations ride these.
 */
export interface KitConnectionRequirement {
  /** Stable slug naming the requirement within the kit. */
  key: string;
  /** Plain-language label of the system-of-record family. */
  label: string;
  /** The W082 broker provider the connection template rides. */
  brokerProvider: BrokerProvider;
  /** The W081 capability classes the connection must offer. */
  capabilityClasses: string[];
}

/**
 * One system-of-record integration of a kit: an ordinary extensions
 * contract manifest input (composed, never forked) plus the kit-side
 * declaration of WHICH connection requirement it rides. The manifest's
 * own `requestedPermissions` is the ceiling the install-time grant is
 * bounded by (W025's least-privilege rule, unchanged).
 */
export interface KitExtensionManifestSpec {
  /** Which kit connection requirement this integration rides. */
  connectionKey: string;
  /** Plain-language system-of-record label (display metadata only). */
  systemOfRecord: string;
  /** The extensions-contract manifest input, composed as-is. */
  manifest: RegisterExtensionManifestInput;
}

/**
 * One operation of a deep-action recipe template: a canonical write
 * plan shaped after `DeepActionOperationInput` (W084) with the
 * provider-neutral placeholders a template carries — the connection is
 * named by kit requirement (an install resolves it to a concrete W082
 * connection id), the target is a template string. DATA ONLY: no
 * execution logic exists anywhere in this module.
 */
export interface KitRecipeOperationTemplate {
  /** Unique key within the recipe (the W084 operation-key discipline). */
  key: string;
  /** Which kit connection requirement this operation rides. */
  connectionKey: string;
  /** The W081 WRITE capability key this operation exercises. */
  capabilityKey: string;
  /** Opaque external-target template (the record being written). */
  targetTemplate: string;
  /** The canonical write payload (plain JSON object). */
  payload: Record<string, unknown>;
  /**
   * The canonical EXPECTED downstream state — the W084 expectation
   * reconciliation verifies against (subset semantics, reconcile.ts).
   */
  expectation: Record<string, unknown>;
}

/**
 * One deep-action recipe template: a multi-system plan a tenant
 * instantiates through the deep-actions gateway's own createDeepAction
 * at use time. 1..16 operations (the W084 bound); every operation
 * rides a kit connection requirement and a W081 write capability.
 */
export interface DeepActionRecipeTemplate {
  /** Stable slug naming the recipe within the kit. */
  recipeKey: string;
  /** What the recipe accomplishes, in plain organizational language. */
  description: string;
  /** The planned operations, in execution order. */
  operations: KitRecipeOperationTemplate[];
}

/**
 * The edge-execution compatibility declaration: which of the kit's
 * recipes expect the Edge Connector (W088). Validated (every entry
 * must be a known recipe key) and rendered 'pending-w088' — see
 * EDGE_EXECUTION_STATUS.
 */
export interface EdgeExecutionDeclaration {
  /** Recipe keys whose operations expect the W088 edge. */
  recipeKeys: string[];
  /** Why the edge is expected, in plain language. */
  note: string;
}

/** Honest kit metadata: what the kit is FOR and what it is NOT. */
export interface KitMetadata {
  /** The industry label (display metadata only — never logic). */
  industry: string;
  /** What the kit targets, in plain language. */
  description: string;
  /** The intended outcomes (plain language, display only). */
  outcomes: string[];
  /** What is explicitly NOT included — the honest boundary. */
  notIncluded: string[];
}

/** One immutable versioned starter-kit bundle. */
export interface VerticalKitDefinition {
  /** Stable slug identity of the kit across versions. */
  kitKey: string;
  /** Release semver ('1.0.0') — the extensions module's discipline. */
  version: string;
  /** Parsed parts of `version` (numeric ordering — never strings). */
  versionParts: SemverParts;
  /** Honest metadata (industry, outcomes, not-included). */
  metadata: KitMetadata;
  /**
   * The kit's capability footprint: EXACTLY the union of the manifests'
   * requested permission sets, in canonical order. Installing the kit
   * grants exactly this — nothing more (fail-closed at validation).
   */
  permissionFootprint: ExtensionPermission[];
  /** The system-of-record integrations (≥ 2 per kit, at validation). */
  extensionManifests: KitExtensionManifestSpec[];
  /** The deep-action recipe templates (≥ 1 per kit, at validation). */
  deepActionRecipes: DeepActionRecipeTemplate[];
  /** The broker connection templates the kit needs (≥ 1, at validation). */
  connectionRequirements: KitConnectionRequirement[];
  /** The honest pending-W088 edge declaration. */
  edgeExecution: EdgeExecutionDeclaration;
}

// ---------------------------------------------------------------------------
// Served read models (what the contract hands the surfaces)
// ---------------------------------------------------------------------------

/**
 * The normalized manifest subject of a kit integration — exactly the
 * shape an ExtensionPackage freezes (W028) and the install path
 * compares against, so a package binding is honest only when the
 * frozen subject equals the kit's normalized declaration.
 */
export interface KitManifestSubject {
  manifestSchemaVersion: number;
  requestedPermissions: string[];
  capabilities: ExtensionCapabilities;
  quotas: ExtensionQuotas;
  hostCompatibility: { minVersion: string; maxVersion: string | null };
}

/**
 * The edge-execution posture of a kit as surfaces render it: the
 * expecting recipes plus the single honest status. NEVER an execution
 * claim — 'pending-w088' is the whole vocabulary at this base.
 */
export interface KitEdgeExecutionInfo {
  recipes: string[];
  status: EdgeExecutionStatus;
  note: string;
}

/** A kit as the catalog serves it (validated, edge posture rendered). */
export interface VerticalKitSummary extends VerticalKitDefinition {
  edgeExecutionInfo: KitEdgeExecutionInfo;
}

// ---------------------------------------------------------------------------
// Installation lifecycle (tenant-scoped rows)
// ---------------------------------------------------------------------------

/** One granted permission bundle of an installed kit (per manifest). */
export interface VerticalKitGrant {
  id: string;
  tenantId: string;
  /** The install this grant belongs to. */
  installId: string;
  kitKey: string;
  /** The extension this grant deployed (the extensions registry key). */
  extensionKey: string;
  /** The deployed manifest version (denormalized from the manifest). */
  extensionVersion: string;
  /** The marketplace ExtensionPackage the binding rode (W028). */
  packageId: string;
  /** The marketplace catalog key of that package. */
  packageKey: string;
  /** Exactly what installing granted, in canonical order. */
  grantedPermissions: ExtensionPermission[];
  deployedAt: string;
}

/** One tenant's current installation of one kit. */
export interface VerticalKitInstall {
  id: string;
  tenantId: string;
  kitKey: string;
  /** The installed kit version (a record of what was granted). */
  kitVersion: string;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
  /** The per-manifest grants + package bindings (removed on uninstall). */
  grants: VerticalKitGrant[];
  /** The rendered edge posture of the installed version. */
  edgeExecutionInfo: KitEdgeExecutionInfo;
}

/** One append-only lifecycle event of a tenant's kit history. */
export interface VerticalKitEvent {
  id: string;
  tenantId: string;
  kitKey: string;
  eventType: VerticalKitEventType;
  /** The version before the event (null for install). */
  fromVersion: string | null;
  /** The version after the event (null for remove). */
  toVersion: string | null;
  /** The TenantContext principal whose call was applied. */
  actor: string;
  occurredAt: string;
  /**
   * The WHAT of the event, frozen at append time: the exact granted
   * permissions and package bindings the event installed, upgraded or
   * removed. Append-only evidence (storage triggers forbid mutation).
   */
  detail: {
    grants: {
      extensionKey: string;
      extensionVersion: string;
      packageId: string;
      packageKey: string;
      grantedPermissions: string[];
    }[];
  };
}

/**
 * A recorded use of a kit recipe template — the honest reference trail:
 * references record WHICH kit version a deep-action plan was
 * instantiated from and stay readable after the kit is removed (no
 * silent data loss; the versioned definition renders beside a removed
 * flag instead of disappearing).
 */
export interface VerticalKitRecipeReference {
  id: string;
  tenantId: string;
  kitKey: string;
  /** The kit version the template was instantiated from. */
  kitVersion: string;
  recipeKey: string;
  /** Opaque caller reference (e.g. the deep-action task id). */
  reference: string;
  recordedBy: string;
  recordedAt: string;
  /** True when the kit is no longer installed for this tenant. */
  kitRemoved: boolean;
}

// ---------------------------------------------------------------------------
// Inputs and queries
// ---------------------------------------------------------------------------

/** Input shape of `installVerticalKit` / `upgradeVerticalKit`. */
export interface InstallVerticalKitInput {
  kitKey: string;
  /** The kit version to install; defaults to the registry's latest. */
  version?: string | null;
  /** Caller-supplied dedupe key; a recorded key replays the install. */
  idempotencyKey?: string | null;
}

/** Input shape of `removeVerticalKit`. */
export interface RemoveVerticalKitInput {
  kitKey: string;
  idempotencyKey?: string | null;
}

/** Input shape of `recordVerticalKitRecipeUse`. */
export interface RecordRecipeUseInput {
  kitKey: string;
  /** Defaults to the tenant's installed version; explicit allowed. */
  version?: string | null;
  recipeKey: string;
  /** Opaque reference (e.g. the deep-action task id). */
  reference: string;
}

/** Query shape of `getVerticalKitInstall`. */
export interface GetVerticalKitInstallQuery {
  kitKey: string;
}

/** Query shape of `listVerticalKitEvents`. */
export interface ListVerticalKitEventsQuery {
  kitKey?: string | null;
  limit?: number | null;
}

/** Query shape of `listVerticalKitRecipeReferences`. */
export interface ListRecipeReferencesQuery {
  kitKey?: string | null;
  limit?: number | null;
}

/** What `installVerticalKit` / `upgradeVerticalKit` return. */
export interface InstallVerticalKitResult {
  install: VerticalKitInstall;
  /** false when an idempotency replay returned the recorded install. */
  created: boolean;
}

/** What `removeVerticalKit` returns. */
export interface RemoveVerticalKitResult {
  /** The recipe references that survive the removal (the honest trail). */
  survivingReferences: VerticalKitRecipeReference[];
}
