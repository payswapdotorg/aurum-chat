// Pure lifecycle logic of the vertical-kits module (W092). No database,
// no context, no time.
//
// THE INSTALL LIFECYCLE — deliberately the extensions-registry and
// marketplace patterns composed (NOT a forked second lifecycle model):
//
//   registry side (the extensions manifest discipline, W025):
//     versions are immutable and strictly increasing per kit key; a
//     changed declaration is a NEW version, never an edit; install
//     requires the version's derived verification state VERIFIED (the
//     marketplace's AUTOMATED_VERIFICATION discipline, W028).
//
//   install side (the extensions lifecycle tail, W025 + lock 26's
//     publication/installation separation, with the capability-grants
//     review discipline, W083):
//
//     installKit          → 'pending-review' (the W009 gate routed; the
//                            tenant's grant review waits for a human)
//                        ↘ 'rejected'         (tenant policy refused the
//                            kind outright — the gate's own verdict)
//                        ↘ 'granted'          (tenant policy auto-allowed
//                            the kind — grants minted without a wait)
//     decideKitReview    : 'pending-review' → 'rejected' (the human review
//                            refused the kit; NO grant is minted — denial
//                            stops the kit)
//                        : 'pending-review' → 'granted' (the human review
//                            approved; exactly the declared capabilities
//                            are minted as kit grants)
//     activateKit        : 'granted' → 'active'
//     suspendKit         : 'active' → 'suspended'
//     resumeKit          : 'suspended' → 'active'
//     removeKit          : any live state → 'removed' (every active grant
//                            revoked — no orphaned authority; the
//                            append-only audit is retained)
//
// 'rejected' and 'removed' are TERMINAL. A rejected install is evidence
// — the tenant re-installs the (same or newer) version and the review
// runs again; a removed installation stays as history while the unique
// live-per-kit index frees the kit for a fresh install lifecycle.

/** The installation lifecycle states, in canonical order. */
export const KIT_INSTALLATION_STATES = [
  'pending-review',
  'rejected',
  'granted',
  'active',
  'suspended',
  'removed',
] as const;

export type KitInstallationLifecycleState = (typeof KIT_INSTALLATION_STATES)[number];

export function isKitInstallationState(value: unknown): value is KitInstallationLifecycleState {
  return (
    typeof value === 'string' && (KIT_INSTALLATION_STATES as readonly string[]).includes(value)
  );
}

/** The named installation transitions. */
export const KIT_INSTALLATION_TRANSITIONS = [
  'review-approve',
  'review-reject',
  'activate',
  'suspend',
  'resume',
  'remove',
] as const;

export type KitInstallationTransition = (typeof KIT_INSTALLATION_TRANSITIONS)[number];

export function isKitInstallationTransition(
  value: unknown,
): value is KitInstallationTransition {
  return (
    typeof value === 'string' &&
    (KIT_INSTALLATION_TRANSITIONS as readonly string[]).includes(value)
  );
}

/**
 * The legal source states of each transition — the entire state machine
 * in one table. Kept private; `canTransitionInstallation` is the
 * surface, and the service checks it BEFORE mutating (fail fast on
 * nonsense) while the storage-level CHECK constraints in migrations/001
 * re-pin the state vocabulary for writes bypassing the service.
 */
const TRANSITION_SOURCES: Record<KitInstallationTransition, readonly KitInstallationLifecycleState[]> = {
  'review-approve': ['pending-review'],
  'review-reject': ['pending-review'],
  activate: ['granted'],
  suspend: ['active'],
  resume: ['suspended'],
  remove: ['pending-review', 'rejected', 'granted', 'active', 'suspended'],
};

/**
 * May `transition` be applied to an installation currently in `from`?
 * Pure and total.
 */
export function canTransitionInstallation(
  from: KitInstallationLifecycleState,
  transition: KitInstallationTransition,
): boolean {
  return TRANSITION_SOURCES[transition].includes(from);
}

/**
 * The state a transition targets (total: every named transition has
 * one).
 */
export function targetInstallationState(
  transition: KitInstallationTransition,
): KitInstallationLifecycleState {
  switch (transition) {
    case 'review-approve':
      return 'granted';
    case 'review-reject':
      return 'rejected';
    case 'activate':
      return 'active';
    case 'suspend':
      return 'suspended';
    case 'resume':
      return 'active';
    case 'remove':
      return 'removed';
  }
}

/**
 * The transitions an installation in `state` may still undergo.
 * 'rejected' may still be removed (cleanup of the record's live
 * footprint); 'removed' is the terminal dead end.
 */
export function availableInstallationTransitions(
  state: KitInstallationLifecycleState,
): KitInstallationTransition[] {
  return KIT_INSTALLATION_TRANSITIONS.filter((transition) =>
    canTransitionInstallation(state, transition),
  );
}

/** Is `state` a dead end of the install lifecycle? */
export function isTerminalInstallationState(state: KitInstallationLifecycleState): boolean {
  return availableInstallationTransitions(state).length === 0;
}

/**
 * The states in which an installation holds LIVE kit authority (active
 * capability grants). Only these were minted by an approved review and
 * not yet revoked: 'granted' (approved, not yet activated — grants
 * exist), 'active' and 'suspended' (activated then possibly parked).
 * Removal revokes them all.
 */
export const KIT_AUTHORITY_HOLDING_STATES = ['granted', 'active', 'suspended'] as const;

/** Does an installation in `state` hold live kit authority? */
export function holdsKitAuthority(state: KitInstallationLifecycleState): boolean {
  return (KIT_AUTHORITY_HOLDING_STATES as readonly string[]).includes(state);
}

/**
 * The states in which the kit runtime may be USED (capability
 * invocations allowed, edge paths reachable). Only 'active' — a
 * granted-but-not-activated kit holds authority but is not yet on.
 */
export function isKitUsableState(state: KitInstallationLifecycleState): boolean {
  return state === 'active';
}

/** The derived verification states of a registered kit version. */
export const KIT_VERIFICATION_STATES = ['unverified', 'verified', 'failed'] as const;

export type KitVerificationState = (typeof KIT_VERIFICATION_STATES)[number];

export function isKitVerificationState(value: unknown): value is KitVerificationState {
  return (
    typeof value === 'string' && (KIT_VERIFICATION_STATES as readonly string[]).includes(value)
  );
}

/** The append-only installation event vocabulary. */
export const KIT_INSTALLATION_EVENT_TYPES = [
  'installed',
  'review-approved',
  'review-rejected',
  'grant-minted',
  'activated',
  'suspended',
  'resumed',
  'grant-revoked',
  'removed',
] as const;

export type KitInstallationEventType = (typeof KIT_INSTALLATION_EVENT_TYPES)[number];

export function isKitInstallationEventType(value: unknown): value is KitInstallationEventType {
  return (
    typeof value === 'string' &&
    (KIT_INSTALLATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}
