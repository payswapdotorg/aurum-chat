// Pure lifecycle logic of the marketplace module (W028 — Marketplace
// Governance). No database, no context, no time.
//
// THE PACKAGE LIFECYCLE (ARCHITECTURE.md §17, frozen):
//   `DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW →
//    APPROVED / REJECTED → PUBLISHED → INSTALLABLE`
//
// W028's work item: "Implement DRAFT→SUBMITTED→AUTOMATED_VERIFICATION→
// PENDING_REVIEW→APPROVED/REJECTED→PUBLISHED→INSTALLABLE lifecycle for
// ExtensionPackage and AgentPackage. Platform approval is mandatory."
// The same state machine governs BOTH package kinds (§17: "The same
// governance applies to AgentPackages") — the kind changes WHAT is being
// governed (an extension manifest artifact vs an agent package spec),
// never HOW it is governed.
//
// Named transitions (deterministic state machine, pure functions):
//
//   submit               : DRAFT → SUBMITTED
//   verify               : SUBMITTED → AUTOMATED_VERIFICATION
//   verification-passed  : AUTOMATED_VERIFICATION → PENDING_REVIEW
//   verification-failed  : AUTOMATED_VERIFICATION → REJECTED
//   approve              : PENDING_REVIEW → APPROVED
//   reject               : PENDING_REVIEW → REJECTED
//   publish              : APPROVED → PUBLISHED
//   make-installable     : PUBLISHED → INSTALLABLE
//
// The tail of §17's chain — `INSTALLABLE → ACTIVE / SUSPENDED /
// DEPRECATED` — is deliberately NOT here: the extensions module already
// owns that tail as the EXTENSION's own tenant-registry lifecycle (W025,
// lifecycle.ts), and lock 26 makes publication and tenant
// installation/activation separate states. This module ends at
// INSTALLABLE; what a tenant does after installing is downstream scope
// (W026/W047).
//
// REJECTED is TERMINAL (both arrival routes: automated-verification
// failure and platform review rejection). A rejected submission is
// evidence — the vendor fixes the artifact and submits a NEW package
// version (versions are immutable and strictly increasing per package
// key, the extensions module's manifest precedent). There is no
// un-reject, no resurrection and no DRAFT rollback: a submitted package
// is already frozen platform history. INSTALLABLE is the end of W028's
// governed chain — it is terminal HERE while remaining the entry point
// of the installation story owned elsewhere.

/** The marketplace package lifecycle states, in canonical pipeline order. */
export const MARKETPLACE_PACKAGE_STATES = [
  'DRAFT',
  'SUBMITTED',
  'AUTOMATED_VERIFICATION',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'INSTALLABLE',
] as const;

export type MarketplacePackageState = (typeof MARKETPLACE_PACKAGE_STATES)[number];

export function isMarketplacePackageState(
  value: unknown,
): value is MarketplacePackageState {
  return (
    typeof value === 'string' &&
    (MARKETPLACE_PACKAGE_STATES as readonly string[]).includes(value)
  );
}

/**
 * The states from which platform approval has NOT yet been granted —
 * a package in any of these can never be installed by a tenant.
 */
export const MARKETPLACE_PRE_APPROVAL_STATES = [
  'DRAFT',
  'SUBMITTED',
  'AUTOMATED_VERIFICATION',
  'PENDING_REVIEW',
  'REJECTED',
] as const;

/** The states a package may be in AFTER platform approval. */
export const MARKETPLACE_POST_APPROVAL_STATES = ['APPROVED', 'PUBLISHED', 'INSTALLABLE'] as const;

/**
 * The states in which a package is visible to every tenant (the public
 * catalog). Publication never implies tenant installation or activation
 * (lock 26) — but only PUBLISHED/INSTALLABLE packages are catalog-
 * visible at all: nothing pre-publication ever leaks across tenants.
 */
export const MARKETPLACE_PUBLIC_STATES = ['PUBLISHED', 'INSTALLABLE'] as const;

/**
 * The pipeline states a platform reviewer watches (the review queue):
 * everything between submission and the platform decision.
 */
export const MARKETPLACE_REVIEW_QUEUE_STATES = [
  'SUBMITTED',
  'AUTOMATED_VERIFICATION',
  'PENDING_REVIEW',
] as const;

/** The named lifecycle transitions. */
export const MARKETPLACE_PACKAGE_TRANSITIONS = [
  'submit',
  'verify',
  'verification-passed',
  'verification-failed',
  'approve',
  'reject',
  'publish',
  'make-installable',
] as const;

export type MarketplacePackageTransition = (typeof MARKETPLACE_PACKAGE_TRANSITIONS)[number];

export function isMarketplacePackageTransition(
  value: unknown,
): value is MarketplacePackageTransition {
  return (
    typeof value === 'string' &&
    (MARKETPLACE_PACKAGE_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** The state a transition targets (total: every named transition has one). */
export function targetPackageState(
  transition: MarketplacePackageTransition,
): MarketplacePackageState {
  switch (transition) {
    case 'submit':
      return 'SUBMITTED';
    case 'verify':
      return 'AUTOMATED_VERIFICATION';
    case 'verification-passed':
      return 'PENDING_REVIEW';
    case 'verification-failed':
      return 'REJECTED';
    case 'approve':
      return 'APPROVED';
    case 'reject':
      return 'REJECTED';
    case 'publish':
      return 'PUBLISHED';
    case 'make-installable':
      return 'INSTALLABLE';
  }
}

/**
 * The legal source states of each transition — the entire state machine
 * in one table. Kept private; `canTransitionPackage` is the surface.
 */
const TRANSITION_SOURCES: Record<
  MarketplacePackageTransition,
  readonly MarketplacePackageState[]
> = {
  submit: ['DRAFT'],
  verify: ['SUBMITTED'],
  'verification-passed': ['AUTOMATED_VERIFICATION'],
  'verification-failed': ['AUTOMATED_VERIFICATION'],
  approve: ['PENDING_REVIEW'],
  reject: ['PENDING_REVIEW'],
  publish: ['APPROVED'],
  'make-installable': ['PUBLISHED'],
};

/**
 * May `transition` be applied to a package currently in `from`? Pure and
 * total — the service checks it BEFORE mutating (fail fast on nonsense)
 * and the storage-level direction CHECK (migrations/001) re-pins every
 * legal (transition, from, to) triple for writes bypassing the service.
 */
export function canTransitionPackage(
  from: MarketplacePackageState,
  transition: MarketplacePackageTransition,
): boolean {
  return TRANSITION_SOURCES[transition].includes(from);
}

/**
 * The transitions a package in `state` may still undergo. DRAFT may be
 * submitted; REJECTED and INSTALLABLE are the two ends of the governed
 * chain (REJECTED dead-ends here, INSTALLABLE hands over to the
 * installation story owned by W026/W047).
 */
export function availableTransitions(
  state: MarketplacePackageState,
): MarketplacePackageTransition[] {
  return MARKETPLACE_PACKAGE_TRANSITIONS.filter((transition) =>
    canTransitionPackage(state, transition),
  );
}

/** Is `state` a dead end of W028's governed chain? */
export function isTerminalPackageState(state: MarketplacePackageState): boolean {
  return availableTransitions(state).length === 0;
}
