// ============================================================================
// marketplace — the ONLY public surface of the marketplace module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W028 — Marketplace Governance:
// "Implement DRAFT→SUBMITTED→AUTOMATED_VERIFICATION→PENDING_REVIEW→
//  APPROVED/REJECTED→PUBLISHED→INSTALLABLE lifecycle for
//  ExtensionPackage and AgentPackage. Platform approval is mandatory."
//
// ARCHITECTURE.md §17 (frozen): "Marketplace lifecycle: DRAFT →
// SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW → APPROVED /
// REJECTED → PUBLISHED → INSTALLABLE → ACTIVE / SUSPENDED / DEPRECATED.
// The same governance applies to AgentPackages. Publication never
// implies tenant installation or activation. Platform approval is
// mandatory before third-party packages become installable." ADR-0004:
// marketplace artifacts have submission, verification, review,
// approval, publication, installation and activation states.
//
//   THE VENDOR SIDE (claim 'marketplace:submit'):
//   createPackage — freeze ONE artifact version as a DRAFT platform
//      package. ExtensionPackage: reads the manifest version ONCE
//      through the extensions contract under the caller's own tenant
//      context and freezes its content (the platform artifact is
//      self-contained — the platform never reaches into a tenant
//      registry at review time); the catalog key defaults to the
//      extension key. AgentPackage: the agent blueprint itself (role,
//      instructions, canonical runtime provider, permission scopes)
//      validated against the agents module's exported closed
//      vocabularies. Versions are release semvers, strictly increasing
//      per (kind, key) — a changed artifact is a NEW version, never an
//      edit; payloads are immutable from creation (storage trigger).
//   submitPackage — DRAFT → SUBMITTED: the vendor hands the frozen
//      artifact to the platform pipeline. Only the vendor tenant can
//      submit its own package (foreign ids are uniformly missing).
//
//   THE PLATFORM SIDE (claim 'marketplace:administer'):
//   runAutomatedVerification — SUBMITTED → AUTOMATED_VERIFICATION →
//      PENDING_REVIEW | REJECTED, atomically. The deterministic checks
//      are the extensions module's own five for extension packages (one
//      semantics with the registry and the builder — W025/W027/W028 run
//      the SAME exported pure checks) and the marketplace's four
//      agent-package checks, pinned to the agents module's exported
//      closed vocabularies. Per-check outcomes land as one append-only
//      run; a failed check set REJECTS the package with that evidence.
//   reviewPackage — PENDING_REVIEW → APPROVED | REJECTED: THE
//      mandatory platform decision (lock 27). Requires the administer
//      claim AND separation of duties — the reviewer is neither the
//      vendor principal nor the vendor tenant, so a vendor can never
//      approve its own package even with a mis-granted claim (the
//      storage trigger makes the bad row unrepresentable). Rejection
//      requires a reason; the decision is append-only evidence.
//   publishPackage — APPROVED → PUBLISHED (the platform's listing
//      decision; reachable only through an approval).
//   makePackageInstallable — PUBLISHED → INSTALLABLE (the platform's
//      installation-gating decision; also reachable only through an
//      approval).
//
//   READS:
//   getPackage / listPackages — the vendor view: the caller's OWN
//      packages in any state (nothing of another tenant's pre-publication
//      work is ever visible — no existence leak).
//   listCatalogPackages — the public catalog: exactly PUBLISHED and
//      INSTALLABLE versions, readable by every tenant. Publication never
//      implies installation or activation (lock 26): installation
//      records and the ACTIVE/SUSPENDED/DEPRECATED tail are downstream
//      scope (W026/W047); this module deliberately stops at INSTALLABLE.
//   listReviewQueue — the platform pipeline view (administer claim):
//      everything between submission and the platform decision.
//   getPackageVerification / listPackageVerifications — the append-only
//      automated-verification evidence (latest run decides the derived
//      unverified/verified/failed posture).
//   listPackageReviews / listPackageLifecycleEvents — the append-only
//      platform decision trail and the full transition trail (who moved
//      the package, when, from which state to which — §24
//      reconstructability).
//
// There is deliberately NO operation to edit a package payload, un-reject
// a rejection, un-publish, or delete anything: the catalog is append-only
// history (a fixed artifact ships as a new version), and the storage
// triggers enforce it even for callers bypassing the service. There is
// deliberately NO tenant-side install/activate operation in this module:
// W028 owns the governed catalog through INSTALLABLE, and lock 26 keeps
// publication and tenant installation separate.
//
// Tenancy (ADR-0001, adapted to the platform catalog — see
// migrations/001): the marketplace's tables are platform-level (listed
// in scripts/arch-allowlist.json per IMPLEMENTATION-STACK §3), so tenant
// isolation is enforced as a VISIBILITY rule on every operation: a
// package below PUBLISHED is visible only to its vendor tenant and
// platform operators; for every other tenant — on reads AND writes —
// someone else's draft/submitted/rejected package (and its evidence) is
// indistinguishable from a missing one.
//
// Dependency posture (MODULE-DEPENDENCY-MAP.md: `agents + extensions →
// marketplace`): this module imports ONLY src/infra ports and the
// agents + extensions contracts — the marketplace governs packages that
// REFERENCE those modules' closed vocabularies, and the one validated
// cross-module read (getManifest, under the vendor's own tenant
// context, at creation time only) is the sanctioned extensions edge.
// Platform approval deliberately does NOT route through the actions
// module's authority matrix: that matrix is tenant policy (§20), while
// marketplace approval is platform governance over third-party
// artifacts — no tenant's policy may approve a package on the platform's
// behalf (lock 27); separation of duties is enforced here and pinned by
// a storage trigger instead.
// ============================================================================

export {
  // The governed chain
  createPackage,
  submitPackage,
  runAutomatedVerification,
  reviewPackage,
  publishPackage,
  makePackageInstallable,
  // Reads
  getPackage,
  listPackages,
  listCatalogPackages,
  listReviewQueue,
  getPackageVerification,
  listPackageVerifications,
  listPackageReviews,
  listPackageLifecycleEvents,
} from './service';

// Module-owned authority claims and constants.
export {
  MARKETPLACE_AUTHORITY_ADMINISTER,
  MARKETPLACE_AUTHORITY_SUBMIT,
} from './service';

export { MarketplaceError } from './errors';
export type { MarketplaceErrorCode } from './errors';

// Pure vocabularies and the state machine (usable without a database).
export {
  MARKETPLACE_PACKAGE_STATES,
  MARKETPLACE_PACKAGE_TRANSITIONS,
  MARKETPLACE_POST_APPROVAL_STATES,
  MARKETPLACE_PRE_APPROVAL_STATES,
  MARKETPLACE_PUBLIC_STATES,
  MARKETPLACE_REVIEW_QUEUE_STATES,
  availableTransitions,
  canTransitionPackage,
  isMarketplacePackageState,
  isMarketplacePackageTransition,
  isTerminalPackageState,
  targetPackageState,
} from './lifecycle';

// Pure automated-verification logic (the AUTOMATED_VERIFICATION phase's
// deterministic checks — the same exported pure checks the extensions
// module's registry and builder run, plus the agent-package set).
export {
  AGENT_PACKAGE_CHECKS,
  EXTENSION_PACKAGE_CHECKS,
  MAX_PACKAGE_VERIFICATION_SUMMARY_CHARS,
  isAgentPackageCheck,
  packageVerificationOutcomeFor,
  runAgentPackageVerificationChecks,
  summarizePackageVerificationRun,
} from './verification';
export type {
  AgentPackageCheck,
  AgentSubjectLike,
  ExtensionPackageCheck,
  ManifestSubjectLike,
  PackageVerificationCheck,
  PackageVerificationCheckResult,
  PackageVerificationRunOutcome,
} from './verification';

// Lifecycle vocabulary types.
export type {
  MarketplacePackageState,
  MarketplacePackageTransition,
} from './lifecycle';

// Validation surface (bounds + guards, usable without a database).
export {
  DEFAULT_LIST_LIMIT,
  MARKETPLACE_PACKAGE_KINDS,
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_LIST_LIMIT,
  MAX_REVIEW_REASON_CHARS,
  PACKAGE_KEY_PATTERN,
  assertMarketplaceTenantContext,
  isMarketplacePackageKind,
  isPackageKey,
} from './validation';
export type {
  ValidatedCreateAgentInput,
  ValidatedCreateExtensionInput,
  ValidatedCreateInput,
  ValidatedEvidenceQuery,
  ValidatedListKindQuery,
  ValidatedListPackagesQuery,
  ValidatedPackageIdInput,
  ValidatedReviewInput,
} from './validation';

// Public domain types.
export type {
  AgentPackagePayload,
  CreateAgentPackageInput,
  CreateExtensionPackageInput,
  CreatePackageInput,
  GetPackageQuery,
  GetPackageVerificationQuery,
  ListCatalogPackagesQuery,
  ListPackageLifecycleEventsQuery,
  ListPackageReviewsQuery,
  ListPackageVerificationsQuery,
  ListPackagesQuery,
  ListReviewQueueQuery,
  MakePackageInstallableInput,
  MarketplacePackage,
  MarketplacePackageKind,
  PackageLifecycleEvent,
  PackageReview,
  PackageVerificationInfo,
  PackageVerificationRun,
  PublishPackageInput,
  ReviewPackageInput,
  ReviewPackageResult,
  RunPackageVerificationInput,
  RunPackageVerificationResult,
  SubmitPackageInput,
} from './types';

// Package-kind type guards (values, not types).
export { isAgentPackage, isExtensionPackage } from './types';
