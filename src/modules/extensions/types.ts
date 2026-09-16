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
