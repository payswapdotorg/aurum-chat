// Public domain types of the marketplace module (W028 — Marketplace
// Governance).
//
// W028 owns the PACKAGE half of ARCHITECTURE.md §17's marketplace story:
// the governed catalog chain
// `DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW →
// APPROVED / REJECTED → PUBLISHED → INSTALLABLE`
// for BOTH package kinds — ExtensionPackage and AgentPackage ("The same
// governance applies to AgentPackages"). Platform approval is mandatory
// (lock 27): nothing reaches PUBLISHED or INSTALLABLE without the
// platform review decision, and publication never implies tenant
// installation or activation (lock 26) — this module deliberately stops
// at INSTALLABLE; the ACTIVE/SUSPENDED/DEPRECATED tail is the extension's
// own tenant-registry lifecycle (W025) and install-scoped runtime state
// is W026.
//
// WHAT A PACKAGE IS. A marketplace package is a PLATFORM-level catalog
// artifact: one immutable row per (kind, package key, version) carrying
// the FROZEN artifact content (the payload), the vendor provenance (the
// submitting tenant + principal — the ownership chain) and the governed
// lifecycle state. The catalog is not tenant-scoped data (a published
// package is the vendor's offered artifact, visible to every tenant —
// that is the marketplace's purpose); tenancy is therefore a VISIBILITY
// rule, not a column: pre-publication packages are visible only to the
// vendor tenant and platform operators, and the tables are listed in
// scripts/arch-allowlist.json as IMPLEMENTATION-STACK §3 provides.
//
// WHAT EACH KIND FREEZES:
//   * ExtensionPackage — the manifest content of one extension version
//     from the vendor tenant's extensions registry (read ONCE through
//     the extensions contract at creation and frozen: the platform never
//     reaches back into a tenant registry at review time). The manifest
//     id is an opaque forward reference (no cross-module FK — the
//     learning module's subject precedent); the frozen subject is what
//     the AUTOMATED_VERIFICATION phase re-examines with the extensions
//     module's own checks.
//   * AgentPackage — the agent spec itself (role, operating
//     instructions, canonical runtime provider, granted permission
//     scopes), validated against the agents module's exported closed
//     vocabularies. The agents module has no versioned artifact store,
//     so the marketplace owns this payload shape directly; a changed
//     spec is a NEW package version, never an edit.
//
// Versions are release semvers, strictly increasing per (kind, key) —
// the extensions module's manifest discipline, reusing its pure semver
// order. There is deliberately NO operation to edit a payload, un-reject
// a rejection, or delete a package: the catalog is append-only history
// (a rejected version is evidence; the fixed artifact ships as a new
// version).

import type {
  AgentPermissionScope,
  AgentRuntimeProvider,
} from '@/modules/agents/contract';
import type {
  ExtensionCapabilities,
  ExtensionQuotas,
  SemverParts,
} from '@/modules/extensions/contract';
import type { MarketplacePackageState, MarketplacePackageTransition } from './lifecycle';
import type {
  PackageVerificationCheckResult,
  PackageVerificationRunOutcome,
} from './verification';

export type { PackageVerificationCheckResult, PackageVerificationRunOutcome } from './verification';
export type {
  AgentPackageCheck,
  ExtensionPackageCheck,
  PackageVerificationCheck,
} from './verification';

// ---------------------------------------------------------------------------
// Packages (the platform catalog entries)
// ---------------------------------------------------------------------------

/** The two governed package kinds (§17: "The same governance applies to AgentPackages"). */
export type MarketplacePackageKind = 'extension' | 'agent';

/**
 * One marketplace package: a frozen artifact version in the platform
 * catalog plus its governed lifecycle state. The row is a PLATFORM
 * artifact (no tenant column); the vendor provenance columns are the
 * ownership chain, and pre-publication rows are visible only to the
 * vendor tenant and platform operators (the service enforces it; see
 * errors.ts for the no-leak discipline).
 *
 * `versionParts` are the parsed semver columns (numeric ordering — never
 * compare strings).
 */
export interface MarketplacePackage {
  id: string;
  kind: MarketplacePackageKind;
  /** Stable catalog identity of the package across versions (global per kind). */
  packageKey: string;
  /** Release semver ('1.2.3') — strictly increasing per (kind, packageKey). */
  version: string;
  /** Parsed parts of `version` (numeric ordering — never compare strings). */
  versionParts: SemverParts;
  displayName: string;
  description: string | null;
  state: MarketplacePackageState;
  /** The frozen artifact content (discriminated by `kind`). */
  payload: ExtensionPackagePayload | AgentPackagePayload;
  /** The vendor tenant that owns this package from DRAFT onward. */
  vendorTenant: string;
  /** The vendor principal whose call created the package. */
  vendorPrincipal: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on lifecycle transitions only. */
  updatedAt: string;
}

/** Type guard: is this package an ExtensionPackage? */
export function isExtensionPackage(
  pkg: MarketplacePackage,
): pkg is MarketplacePackage & { kind: 'extension'; payload: ExtensionPackagePayload } {
  return pkg.kind === 'extension';
}

/** Type guard: is this package an AgentPackage? */
export function isAgentPackage(
  pkg: MarketplacePackage,
): pkg is MarketplacePackage & { kind: 'agent'; payload: AgentPackagePayload } {
  return pkg.kind === 'agent';
}

// ---------------------------------------------------------------------------
// The frozen payloads
// ---------------------------------------------------------------------------

/**
 * The frozen content of an ExtensionPackage: the manifest subject of one
 * extension version plus the opaque manifest reference it was frozen
 * from (the vendor tenant's extensions registry is the verification
 * point for that reference — no cross-module FK).
 */
export interface ExtensionPackagePayload {
  /** The manifest version this package freezes (opaque forward reference). */
  manifestId: string;
  /** The extension key the manifest belongs to (may differ from packageKey). */
  extensionKey: string;
  /** The frozen manifest subject AUTOMATED_VERIFICATION re-examines. */
  subject: {
    manifestSchemaVersion: number;
    requestedPermissions: string[];
    capabilities: ExtensionCapabilities;
    quotas: ExtensionQuotas;
    hostCompatibility: { minVersion: string; maxVersion: string | null };
  };
}

/**
 * The frozen content of an AgentPackage: the recruitable agent blueprint
 * (role, operating instructions, canonical runtime provider, granted
 * permission scopes). Deliberately NO runtime configuration: opaque
 * adapter configuration is supplied by the installer, never offered by a
 * vendor artifact (the requested permission set IS the ceiling any
 * install-time grant is bounded by — the extensions module's
 * least-privilege posture, applied to agent packages).
 */
export interface AgentPackagePayload {
  role: string;
  instructions: string;
  provider: AgentRuntimeProvider;
  /** Canonical §20 order, deduplicated (the agents module's normalization). */
  permissions: AgentPermissionScope[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Input shape of `createPackage` for an ExtensionPackage: the manifest
 * version to freeze (read through the extensions contract under the
 * caller's tenant context) and an optional catalog key — defaults to
 * the manifest's extension key.
 */
export interface CreateExtensionPackageInput {
  kind: 'extension';
  /** The manifest version to freeze (the vendor tenant's registry). */
  manifestId: string;
  /** Catalog key; defaults to the manifest's extensionKey. */
  packageKey?: string;
}

/**
 * Input shape of `createPackage` for an AgentPackage: the full agent
 * blueprint. `version` starts a new strictly-increasing version chain
 * for `packageKey` (or continues an existing one).
 */
export interface CreateAgentPackageInput {
  kind: 'agent';
  packageKey: string;
  version: string;
  displayName: string;
  description?: string | null;
  role: string;
  instructions: string;
  provider: AgentRuntimeProvider;
  permissions: AgentPermissionScope[];
}

/** The discriminated input of `createPackage`. */
export type CreatePackageInput = CreateExtensionPackageInput | CreateAgentPackageInput;

/** Input shape of `submitPackage` (DRAFT → SUBMITTED — the vendor's hand-off). */
export interface SubmitPackageInput {
  packageId: string;
}

/**
 * Input shape of `runAutomatedVerification` (SUBMITTED →
 * AUTOMATED_VERIFICATION → PENDING_REVIEW | REJECTED — the platform's
 * deterministic phase).
 */
export interface RunPackageVerificationInput {
  packageId: string;
}

/**
 * Input shape of `reviewPackage` (PENDING_REVIEW → APPROVED |
 * REJECTED — the mandatory platform decision). `reason` is REQUIRED on
 * rejection (terminal transitions record their why) and optional on
 * approval.
 */
export interface ReviewPackageInput {
  packageId: string;
  decision: 'approve' | 'reject';
  reason?: string | null;
}

/** Input shape of `publishPackage` (APPROVED → PUBLISHED). */
export interface PublishPackageInput {
  packageId: string;
}

/** Input shape of `makePackageInstallable` (PUBLISHED → INSTALLABLE). */
export interface MakePackageInstallableInput {
  packageId: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** What `runAutomatedVerification` returns: the package plus the recorded run. */
export interface RunPackageVerificationResult {
  package: MarketplacePackage;
  run: PackageVerificationRun;
}

/** What `reviewPackage` returns: the package plus the recorded decision. */
export interface ReviewPackageResult {
  package: MarketplacePackage;
  review: PackageReview;
}

// ---------------------------------------------------------------------------
// Verification runs (append-only platform evidence)
// ---------------------------------------------------------------------------

/**
 * One deterministic automated-verification run of one package —
 * append-only evidence with per-check outcomes. Runs are never updated
 * or deleted (storage-level triggers), so the verification history of a
 * package is reconstructable and drift is visible as a new run.
 */
export interface PackageVerificationRun {
  id: string;
  packageId: string;
  outcome: PackageVerificationRunOutcome;
  /** Per-check outcomes, in the kind's canonical check order. */
  checks: PackageVerificationCheckResult[];
  summary: string;
  /** The platform operator tenant whose call ran the phase. */
  ranByTenant: string;
  /** The platform operator principal whose call ran the phase. */
  ranByPrincipal: string;
  ranAt: string;
}

/** The derived verification posture of a package (latest run decides). */
export interface PackageVerificationInfo {
  packageId: string;
  outcome: 'unverified' | 'verified' | 'failed';
  latestRun: PackageVerificationRun | null;
}

// ---------------------------------------------------------------------------
// Review decisions (append-only platform evidence)
// ---------------------------------------------------------------------------

/**
 * One platform review decision — the mandatory human judgment (lock 27).
 * Recorded by a platform operator principal that is provably distinct
 * from the package's vendor (separation of duties, the actions module's
 * decideApproval discipline applied to the platform catalog).
 */
export interface PackageReview {
  id: string;
  packageId: string;
  decision: 'approve' | 'reject';
  /** Required on rejection, optional on approval. */
  reason: string | null;
  reviewedByTenant: string;
  reviewedByPrincipal: string;
  reviewedAt: string;
}

// ---------------------------------------------------------------------------
// Lifecycle events (append-only platform trail)
// ---------------------------------------------------------------------------

/**
 * One applied lifecycle transition — the append-only trail that keeps
 * `who moved this package through the governed chain, when, from which
 * state to which` reconstructable (§24). `actorTenant`/`actor` are the
 * vendor principal for 'submit' and the platform operator principal for
 * every platform-side transition.
 */
export interface PackageLifecycleEvent {
  id: string;
  packageId: string;
  transition: MarketplacePackageTransition;
  fromState: MarketplacePackageState;
  toState: MarketplacePackageState;
  actorTenant: string;
  actor: string;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Query shape of `getPackage`. */
export interface GetPackageQuery {
  packageId: string;
}

/** Query shape of `listPackages` — the caller's vendor view (own packages only). */
export interface ListPackagesQuery {
  kind?: MarketplacePackageKind;
  states?: MarketplacePackageState[];
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listCatalogPackages` — the public catalog (PUBLISHED + INSTALLABLE). */
export interface ListCatalogPackagesQuery {
  kind?: MarketplacePackageKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listReviewQueue` — the platform pipeline view. */
export interface ListReviewQueueQuery {
  kind?: MarketplacePackageKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getPackageVerification`. */
export interface GetPackageVerificationQuery {
  packageId: string;
}

/** Query shape of `listPackageVerifications` (newest first). */
export interface ListPackageVerificationsQuery {
  packageId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listPackageReviews` (newest first). */
export interface ListPackageReviewsQuery {
  packageId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listPackageLifecycleEvents` (newest first). */
export interface ListPackageLifecycleEventsQuery {
  packageId: string;
  /** 1..500, default 50. */
  limit?: number;
}
