// Public domain types of the extensions module (W025 — Extension
// Contracts).
//
// W025 owns the CONTRACT layer of ARCHITECTURE.md §17's extension
// story: versioned extension manifests (immutable per version, strictly
// increasing per extension), the permission model that binds declared
// capabilities to a closed permission vocabulary, the extension
// lifecycle (REGISTERED → ACTIVE ⇄ SUSPENDED → DEPRECATED, terminal),
// and the derived verification states (UNVERIFIED / VERIFIED / FAILED)
// folded from append-only verification runs.
//
// What is deliberately NOT here: install-scoped runtime state, the
// declarative UI renderer, schedule execution, quota enforcement,
// deployment and rollback mechanics (W026 — the runtime consumes these
// contracts); the marketplace package lifecycle through INSTALLABLE and
// platform approval (W028); artifact/code custody and the builder
// workflow (W027). The manifest declares WHAT an extension needs; the
// requestedPermissions set is the ceiling any future install-time grant
// is bounded by — grants themselves are downstream scope.
//
// Types stay provider-neutral and tenant-scoped. The acting principal
// is always the TenantContext principal (opaque string, the house
// precedent); the lifecycle gate is the actions module's authority
// matrix (kind 'extension-deployment', level EXECUTE — §20 lists
// extension deployment among the consequential actions).

import type {
  ExtensionLifecycleState,
  ExtensionTransition,
} from './lifecycle';
import type {
  ExtensionCapabilities,
  ExtensionExternalParticipant,
  ExtensionPermission,
  ExtensionQuotas,
  ExtensionScheduleDeclaration,
  ExtensionStateScope,
  ExtensionUiSurface,
} from './manifest-rules';
import type { SemverParts } from './semver';
import type {
  ExtensionHttpMethod,
  ExtensionUiDocument,
} from './runtime';
import type {
  ExtensionVerificationCheckResult,
  ExtensionVerificationRunOutcome,
  ExtensionVerificationState,
  ManifestSchemaVersion,
} from './verification';

export type {
  ExtensionLifecycleState,
  ExtensionTransition,
} from './lifecycle';

export type {
  ExtensionCapabilities,
  ExtensionExternalParticipant,
  ExtensionPermission,
  ExtensionQuotas,
  ExtensionScheduleDeclaration,
  ExtensionStateScope,
  ExtensionUiSurface,
} from './manifest-rules';

export type { SemverParts } from './semver';

export type {
  ExtensionHttpMethod,
  ExtensionUiBlock,
  ExtensionUiDocument,
} from './runtime';

export type { ExtensionHttpCall, ExtensionHttpResponse } from './http';

export type {
  ExtensionVerificationCheckResult,
  ExtensionVerificationRunOutcome,
  ExtensionVerificationState,
  ManifestSchemaVersion,
} from './verification';

// ---------------------------------------------------------------------------
// Extensions (the tenant-scoped registry entries)
// ---------------------------------------------------------------------------

/**
 * One extension in the tenant registry: a stable key, a lifecycle
 * state, and its latest registered manifest version. The row is
 * tenant-scoped (ADR-0001); the key is unique per tenant — two tenants
 * may register extensions under the same key without any interaction.
 *
 * `latestVersion`/`latestManifestId` are derived (the newest version by
 * the semver order — which registration guarantees is also the newest
 * registered); both are null exactly for an extension with no
 * manifests, which cannot occur through the service (registration
 * creates the extension and its first manifest together) but keeps the
 * read model total.
 */
export interface Extension {
  id: string;
  tenantId: string;
  /** Stable slug identity of the extension across versions. */
  extensionKey: string;
  lifecycleState: ExtensionLifecycleState;
  /** Newest registered version ('1.2.3'), or null when no manifests exist. */
  latestVersion: string | null;
  /** Id of the newest registered manifest, or null. */
  latestManifestId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Manifests (immutable, versioned)
// ---------------------------------------------------------------------------

/**
 * One immutable manifest version of one extension. The substantive
 * content is frozen the moment it is registered — a changed declaration
 * is a NEW version, never an edit (storage-level triggers enforce it).
 * Versions are strictly increasing per extension key (semver order).
 */
export interface ExtensionManifest {
  id: string;
  tenantId: string;
  extensionId: string;
  extensionKey: string;
  /** Release semver ('1.2.3'). */
  version: string;
  /** Parsed parts of `version` (numeric ordering — never compare strings). */
  versionParts: SemverParts;
  /** The versioned manifest FORMAT this record obeys. */
  manifestSchemaVersion: ManifestSchemaVersion;
  displayName: string;
  description: string | null;
  /** The requested permission ceiling, in canonical order. */
  requestedPermissions: ExtensionPermission[];
  /** The normalized capability declaration. */
  capabilities: ExtensionCapabilities;
  /** The declared resource ceilings. */
  quotas: ExtensionQuotas;
  /** The declared host-runtime compatibility range. */
  hostCompatibility: { minVersion: string; maxVersion: string | null };
  /** The TenantContext principal that registered this version. */
  registeredBy: string;
  registeredAt: string;
}

/** A manifest together with its derived verification state. */
export interface ExtensionManifestWithVerification extends ExtensionManifest {
  verification: {
    state: ExtensionVerificationState;
    /** The latest run, or null when UNVERIFIED. */
    latestRun: ExtensionManifestVerification | null;
  };
}

/** A manifest summary (list reads): the manifest plus its derived state. */
export interface ExtensionManifestSummary extends ExtensionManifest {
  verificationState: ExtensionVerificationState;
}

// ---------------------------------------------------------------------------
// Verification runs (append-only evidence)
// ---------------------------------------------------------------------------

/**
 * One deterministic verification run of one manifest version —
 * append-only evidence. The run records the outcome of every check in
 * the closed vocabulary plus a human-readable summary; runs are never
 * updated or deleted, so the verification history of a manifest is
 * reconstructable (ARCHITECTURE.md §24) and drift (a rule added later
 * failing an older manifest) is visible as a new run, not a rewrite.
 */
export interface ExtensionManifestVerification {
  id: string;
  tenantId: string;
  manifestId: string;
  outcome: ExtensionVerificationRunOutcome;
  /** Per-check outcomes, in canonical check order. */
  checks: ExtensionVerificationCheckResult[];
  summary: string;
  /** The TenantContext principal that ran the verification. */
  verifier: string;
  ranAt: string;
}

/** The derived verification posture of one manifest version. */
export interface ManifestVerificationInfo {
  manifestId: string;
  state: ExtensionVerificationState;
  latestRun: ExtensionManifestVerification | null;
}

// ---------------------------------------------------------------------------
// Lifecycle events (append-only trail)
// ---------------------------------------------------------------------------

/**
 * One applied lifecycle transition — the append-only trail that keeps
 * `who moved this extension's lifecycle, when, through which authority
 * decision` reconstructable (ARCHITECTURE.md §24). `actionRequestId`
 * references the actions module's approval-gate record that authorized
 * the transition (kind 'extension-deployment').
 */
export interface ExtensionLifecycleEvent {
  id: string;
  tenantId: string;
  extensionId: string;
  transition: ExtensionTransition;
  fromState: ExtensionLifecycleState;
  toState: ExtensionLifecycleState;
  /** The principal whose transition call was applied. */
  actor: string;
  /** The actions-module request that gated this transition. */
  actionRequestId: string | null;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Inputs and queries
// ---------------------------------------------------------------------------

/**
 * Input shape of `registerExtensionManifest` — the flat, caller-friendly
 * projection that validation normalizes into the canonical manifest.
 * `manifestSchemaVersion` and the host-runtime range are REQUIRED: a
 * versioned contract is explicit about its version, and §17 makes
 * compatibility a first-class declaration.
 */
export interface RegisterExtensionManifestInput {
  extensionKey: string;
  version: string;
  manifestSchemaVersion: number;
  displayName: string;
  description?: string | null;
  requestedPermissions?: ExtensionPermission[];
  stateScope?: ExtensionStateScope;
  uiSurfaces?: ExtensionUiSurface[];
  schedules?: ExtensionScheduleDeclaration[];
  eventSubscriptions?: string[];
  externalParticipants?: ExtensionExternalParticipant[];
  telemetry?: boolean;
  quotas?: Partial<ExtensionQuotas>;
  hostRuntime: { minVersion: string; maxVersion?: string | null };
}

/** What `registerExtensionManifest` returns: the version plus its extension. */
export interface RegisterExtensionManifestResult {
  extension: Extension;
  manifest: ExtensionManifest;
}

/**
 * Input shape of `transitionExtension`. `idempotencyKey` is optional but
 * load-bearing for gated transitions: the authority matrix's default
 * gates EXECUTE behind human approval, so a transition typically sits
 * `pending`; re-invoking the SAME transition with the SAME key after the
 * approval replays the original gate request (now approved) and applies.
 * The key also makes a retry after a crash between commit and response
 * replay the already-applied outcome instead of failing.
 */
export interface TransitionExtensionInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  transition: ExtensionTransition;
  idempotencyKey?: string | null;
}

/**
 * What `transitionExtension` returns. `applied` is false exactly when
 * the authority gate routed the request to `pending` — the extension is
 * unchanged, the gate request id is returned, and a later re-invocation
 * (same idempotency key) completes the transition once approved.
 */
export interface TransitionExtensionResult {
  extension: Extension;
  applied: boolean;
  /** The actions-module gate outcome for this transition request. */
  gate: {
    actionRequestId: string;
    status: 'pending' | 'approved' | 'rejected';
  };
}

/** Query shape of `getExtension` (exactly one of the two identifiers). */
export interface GetExtensionQuery {
  extensionId?: string;
  extensionKey?: string;
}

/** Query shape of `listExtensions`. */
export interface ListExtensionsQuery {
  lifecycleState?: ExtensionLifecycleState;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getManifest` / `getManifestVerification`. */
export interface GetManifestQuery {
  manifestId: string;
}

/** Query shape of `listManifests` (both filters optional). */
export interface ListManifestsQuery {
  extensionId?: string;
  extensionKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listManifestVerifications`. */
export interface ListManifestVerificationsQuery {
  manifestId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `runManifestVerification`. */
export interface RunManifestVerificationQuery {
  manifestId: string;
}

/** What `runManifestVerification` returns: the run plus the new derived state. */
export interface RunManifestVerificationResult {
  manifestId: string;
  run: ExtensionManifestVerification;
  state: ExtensionVerificationState;
}

/** Query shape of `checkManifestCompatibility`. */
export interface CheckManifestCompatibilityQuery {
  manifestId: string;
  /** The host runtime version to check against the manifest's declared range. */
  hostVersion: string;
}

/** What `checkManifestCompatibility` returns (§17 "compatibility"). */
export interface CompatibilityReport {
  manifestId: string;
  extensionKey: string;
  version: string;
  hostVersion: string;
  compatible: boolean;
  reasons: string[];
}

/** Query shape of `listExtensionLifecycleEvents`. */
export interface ListExtensionLifecycleEventsQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// W026 — General-Purpose Extension Runtime
//
// The runtime makes W025's contracts operational. Its nouns:
// deployments (version + grant, matrix-gated, append-only history),
// installs (a stable key deployments group under — 'default' when the
// caller does not distinguish), persistent scoped state (tenant or
// install namespace, quota-bounded), host-rendered declarative UI
// documents, schedule runs, event deliveries, external calls and
// extension telemetry — every activity record append-only evidence.
// ---------------------------------------------------------------------------

/** Which operation appended a deployment record. */
export type ExtensionDeploymentOperation = 'deploy' | 'rollback';

/**
 * One deployment of one manifest version into one install of an
 * extension — append-only history (triggers forbid UPDATE/DELETE).
 *
 * `grantedPermissions` is the effective grant of the deployment: a
 * subset of the deployed manifest's requestedPermissions ceiling (W025's
 * "install-time grant"). Every runtime operation checks the CURRENT
 * deployment's grant, so narrowing a grant is a redeploy, never a
 * mutation of history. `replacesDeploymentId` links the deployment the
 * apply-time current one superseded; `actionRequestId` links the
 * actions-module authority decision that authorized it.
 */
export interface ExtensionDeployment {
  id: string;
  tenantId: string;
  extensionId: string;
  extensionKey: string;
  /** The install this deployment belongs to (default: 'default'). */
  installKey: string;
  manifestId: string;
  /** The deployed release semver (denormalized from the manifest). */
  version: string;
  operation: ExtensionDeploymentOperation;
  /** The deployment this one superseded at apply time, or null. */
  replacesDeploymentId: string | null;
  /** Effective permissions, in canonical order. */
  grantedPermissions: ExtensionPermission[];
  /** The principal whose deployment call was applied. */
  deployedBy: string;
  deployedAt: string;
  /** Monotonic append order (identity column; the current fold's key). */
  seq: number;
}

/** Input shape of `deployExtensionVersion`. */
export interface DeployExtensionVersionInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  /** Exactly one of manifestId / version must be given. */
  manifestId?: string;
  version?: string;
  /** Install to deploy into; defaults to 'default'. */
  installKey?: string;
  /**
   * Effective grant — subset of the manifest's requestedPermissions
   * (canonical order). Defaults to the full requested set.
   */
  grantedPermissions?: ExtensionPermission[];
  idempotencyKey?: string | null;
}

/** What `deployExtensionVersion` returns (the W025 gate-result shape). */
export interface DeployExtensionVersionResult {
  /** Null exactly while the authority gate holds the deployment pending. */
  deployment: ExtensionDeployment | null;
  applied: boolean;
  gate: {
    actionRequestId: string;
    status: 'pending' | 'approved' | 'rejected';
  };
}

/** Input shape of `rollbackExtensionDeployment`. */
export interface RollbackExtensionDeploymentInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  /** The recorded deployment to roll back TO (same extension + install). */
  targetDeploymentId: string;
  /** Install being rolled back; defaults to 'default'. */
  installKey?: string;
  idempotencyKey?: string | null;
}

/** What `rollbackExtensionDeployment` returns. */
export interface RollbackExtensionDeploymentResult {
  deployment: ExtensionDeployment | null;
  applied: boolean;
  gate: {
    actionRequestId: string;
    status: 'pending' | 'approved' | 'rejected';
  };
}

/** Query shape of `getCurrentDeployment` / `listExtensionDeployments`. */
export interface DeploymentQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
}

/** Query shape of `listExtensionDeployments`. */
export interface ListExtensionDeploymentsQuery extends DeploymentQuery {
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Persistent scoped state
// ---------------------------------------------------------------------------

/**
 * One stored state entry of an extension namespace. `revision` counts
 * the writes of the key (1 on creation); `installKey` is null exactly
 * when the deployed manifest's stateScope is 'tenant' (the namespace
 * shared across installs and deployments).
 */
export interface ExtensionStateEntry {
  key: string;
  /** The stored JSON value (null is a legal stored value). */
  value: unknown;
  bytes: number;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

/** Query shape of `readExtensionState`. */
export interface ReadExtensionStateQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  /** Required when the deployed manifest's stateScope is 'install'. */
  installKey?: string;
  key: string;
}

/** Input shape of `writeExtensionState`. */
export interface WriteExtensionStateInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  key: string;
  /** Any JSON value (bounded; null clears while keeping the key). */
  value: unknown;
}

// ---------------------------------------------------------------------------
// Declarative UI (host-rendered)
// ---------------------------------------------------------------------------

/** Input shape of `publishExtensionUi`. */
export interface PublishExtensionUiInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  surface: ExtensionUiSurface;
  document: ExtensionUiDocument;
}

/** Query shape of `getExtensionUi`. */
export interface GetExtensionUiQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  surface: ExtensionUiSurface;
}

/**
 * The current declarative UI document of one (extension, surface) — the
 * host's render read. Replaceable (a declaration of what to render,
 * like a policy); identity immutable; never deleted through the runtime.
 */
export interface ExtensionUiDeclaration {
  extensionId: string;
  extensionKey: string;
  surface: ExtensionUiSurface;
  document: ExtensionUiDocument;
  updatedBy: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** Input shape of `triggerExtensionSchedule`. */
export interface TriggerExtensionScheduleInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** Must be declared by the current deployment's manifest. */
  scheduleName: string;
}

/**
 * One schedule invocation — append-only evidence. The cron is recorded
 * from the manifest at invocation time (what fired, not what would fire
 * today). The extension's handler runs in the host's execution
 * environment; this record is the runtime's half.
 */
export interface ExtensionScheduleRun {
  id: string;
  tenantId: string;
  extensionId: string;
  extensionKey: string;
  installKey: string;
  scheduleName: string;
  cron: string;
  invokedBy: string;
  invokedAt: string;
}

/** Query shape of `listExtensionScheduleRuns`. */
export interface ListExtensionScheduleRunsQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

/** Input shape of `dispatchExtensionEvent`. */
export interface DispatchExtensionEventInput {
  /** Canonical topic slug (the manifest eventSubscriptions vocabulary). */
  topic: string;
  /** Bounded opaque JSON payload handed to every delivery. */
  payload?: unknown;
}

/**
 * One delivery of one dispatched topic to one subscribed install —
 * append-only evidence. `outcome` is 'not_granted' when the install's
 * current deployment grant omits events:subscribe: a grant downgrade
 * is visible as evidence, never silent.
 */
export interface ExtensionEventDelivery {
  id: string;
  tenantId: string;
  extensionId: string;
  extensionKey: string;
  installKey: string;
  topic: string;
  payload: unknown;
  outcome: 'delivered' | 'not_granted';
  deliveredAt: string;
}

/** What `dispatchExtensionEvent` returns. */
export interface DispatchExtensionEventResult {
  topic: string;
  delivered: number;
  notGranted: number;
  deliveries: ExtensionEventDelivery[];
}

/** Query shape of `listExtensionEventDeliveries`. */
export interface ListExtensionEventDeliveriesQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Scoped external participation
// ---------------------------------------------------------------------------

/** Input shape of `executeExtensionExternalCall`. */
export interface ExecuteExtensionExternalCallInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** Must EXACTLY match a declared participant origin of the current deployment. */
  origin: string;
  method: ExtensionHttpMethod;
  /** Request path (starts with '/', bounded, no fragment). */
  path: string;
  /** JSON body for POST/PUT/PATCH (bounded; null for GET/DELETE). */
  body?: unknown;
  /**
   * Bounded plain string headers for the call — passed to the egress
   * port, NEVER recorded in call evidence (secrets do not become data).
   */
  headers?: Record<string, string>;
}

/**
 * One external participation call — append-only evidence. The outcome
 * vocabulary: 'succeeded' (2xx), 'http_error' (non-2xx, status
 * recorded), 'failed' (the egress port threw — network, timeout,
 * DNS). Response bodies are never stored; `detail` is a bounded
 * diagnostic.
 */
export interface ExtensionExternalCall {
  id: string;
  tenantId: string;
  extensionId: string;
  extensionKey: string;
  installKey: string;
  origin: string;
  method: ExtensionHttpMethod;
  path: string;
  requestBodyBytes: number;
  outcome: 'succeeded' | 'http_error' | 'failed';
  responseStatus: number | null;
  detail: string | null;
  requestedBy: string;
  requestedAt: string;
}

/** Query shape of `listExtensionExternalCalls`. */
export interface ListExtensionExternalCallsQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Input shape of `emitExtensionTelemetry`. */
export interface EmitExtensionTelemetryInput {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** Telemetry event name (slug). */
  name: string;
  /** Bounded opaque JSON payload. */
  payload?: unknown;
}

/** One extension-emitted telemetry event — append-only evidence. */
export interface ExtensionTelemetryEvent {
  id: string;
  tenantId: string;
  extensionId: string;
  extensionKey: string;
  installKey: string;
  name: string;
  payload: unknown;
  emittedBy: string;
  emittedAt: string;
}

/** Query shape of `listExtensionTelemetryEvents`. */
export interface ListExtensionTelemetryEventsQuery {
  /** Exactly one of extensionId / extensionKey must be given. */
  extensionId?: string;
  extensionKey?: string;
  installKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}
