// Product surface (W105) — the marketplace area's pure vocabulary for
// the W092 vertical starter kits: human labels, pill tones, lifecycle
// chain math and the action-availability rules, mirroring labels.ts
// (the extension/agent vocabulary) for the KIT kind. No database, no
// framework — everything here is unit-testable and shared by the
// server views (kit-views.ts), the client forms (via plain props) and
// the API layer (kit-api.ts), so the three can never drift.
//
// ADDITIVE-ONLY (W105): nothing in labels.ts is renamed or re-typed;
// this file owns the kit vocabulary the new surfaces render. The
// extension/agent listing semantics are untouched.
//
// HONEST STATES (the work order's rule): the kits are SIGNED (the
// sha-256 digest of the canonical manifest JSON — the module's own
// integrity signature) and VERIFIED (the module's own deterministic
// checks) per the vertical-kits module; the labels below surface
// exactly those states — never marketplace package states the kits do
// not have. The kit install lifecycle is the vertical-kits module's
// own (pending-review → granted → active ⇄ suspended → removed, with
// rejected terminal), NOT the marketplace DRAFT→…→INSTALLABLE chain.

import { verificationTone } from './labels';
import type { PillTone } from '../../lib/states';
import {
  KIT_INSTALLATION_STATES,
  KIT_INSTALLATION_TRANSITIONS,
  VERTICAL_KITS_AUTHORITY_ADMINISTER,
  availableInstallationTransitions,
} from '@/modules/vertical-kits/contract';
import type {
  KitCapabilityDeclaration,
  KitInstallationStatus,
  VerticalKitManifest,
} from '@/modules/vertical-kits/contract';

/** The named kit installation transitions (the module's own vocabulary). */
export type KitInstallationTransition = (typeof KIT_INSTALLATION_TRANSITIONS)[number];

/** The authority claim the vertical-kits module's writes check. */
export const CLAIM_KIT_ADMINISTER = VERTICAL_KITS_AUTHORITY_ADMINISTER;

/** The kind label of a vertical starter kit (a distinct catalog category). */
export const KIT_KIND_LABEL = 'Vertical starter kit';

// ---------------------------------------------------------------------------
// The kit installation lifecycle vocabulary (the vertical-kits module's
// own states — W092, surfaced honestly)
// ---------------------------------------------------------------------------

/** Human label for a kit installation state (the pill's text). */
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

/** The pill tone for a kit installation state. */
export function kitInstallationStateTone(state: KitInstallationStatus): PillTone {
  switch (state) {
    case 'pending-review':
      return 'warning';
    case 'rejected':
      return 'error';
    case 'granted':
      return 'info';
    case 'active':
      return 'positive';
    case 'suspended':
      return 'warning';
    case 'removed':
      return 'neutral';
  }
}

/** One plain sentence explaining what a kit installation state means. */
export function kitInstallationStateExplanation(state: KitInstallationStatus): string {
  switch (state) {
    case 'pending-review':
      return 'The install routed the tenant grant review through the authority gate (kind vertical-kit-deployment); a human decision is still open — approval mints exactly the declared capabilities, rejection mints nothing.';
    case 'rejected':
      return 'The grant review (or the tenant policy) refused the kit. Terminal for this install — denial stops the kit; a fresh install of the same or newer version runs the review again.';
    case 'granted':
      return 'The review approved; exactly the declared capabilities are minted as kit grants. The kit is not yet switched on — activation is a separate step.';
    case 'active':
      return 'Activated and usable: capability invocations are allowed against the minted grants, and every verdict lands in the append-only invocation ledger.';
    case 'suspended':
      return 'Temporarily disabled; resuming returns it to active. Grants are retained while suspended.';
    case 'removed':
      return 'Terminal: every active grant was revoked with the kit (no orphaned authority) while the append-only audit trail is retained. A fresh lifecycle may be installed.';
  }
}

/** The tenant's install posture label for a catalog row (null = not installed). */
export function kitInstallPosture(
  status: KitInstallationStatus | null,
): { label: string; tone: PillTone } {
  if (status === null) return { label: 'Not installed', tone: 'neutral' };
  return { label: kitInstallationStateLabel(status), tone: kitInstallationStateTone(status) };
}

/**
 * The kit install lifecycle as the surface renders it — the module's
 * own happy-path order (pending-review → granted → active ⇄ suspended →
 * removed). 'rejected' is a TERMINAL branch off pending-review and
 * renders there (kitChainRejected), exactly the way the marketplace
 * chain hangs REJECTED at the review position.
 */
export const KIT_CHAIN: readonly KitInstallationStatus[] = [
  'pending-review',
  'granted',
  'active',
  'suspended',
  'removed',
];

/**
 * Which chain nodes a given installation has reached — computed from
 * the CURRENT status plus the append-only event trail (a resumed kit
 * was suspended; a removed-after-grant kit was granted), never guessed.
 */
export function kitChainReached(
  status: KitInstallationStatus,
  eventTypes: readonly string[],
): boolean[] {
  const seen = (event: string): boolean => eventTypes.includes(event);
  return [
    // pending-review: every install routes the gate before anything else.
    true,
    // granted: an approved review (or policy auto-allow) minted grants.
    seen('review-approved') || status === 'granted' || status === 'active' || status === 'suspended',
    // active: activated at some point (suspended kits were active).
    seen('activated') || status === 'active' || status === 'suspended',
    // suspended: parked at some point (resumed kits were suspended).
    seen('suspended') || status === 'suspended',
    // removed: terminal.
    status === 'removed' || seen('removed'),
  ];
}

/** Does the installation hang REJECTED at the review node? */
export function kitChainRejected(status: KitInstallationStatus): boolean {
  return status === 'rejected';
}

// ---------------------------------------------------------------------------
// The signed-manifest + verification vocabulary (the kit's real states)
// ---------------------------------------------------------------------------

/** The human label of a kit verification posture. */
export function kitVerificationLabel(outcome: 'unverified' | 'verified' | 'failed'): string {
  return outcome === 'verified' ? 'Verified' : outcome === 'failed' ? 'Failed' : 'Unverified';
}

/** The pill tone of a kit verification posture (the same mapping as packages). */
export function kitVerificationTone(outcome: 'unverified' | 'verified' | 'failed'): PillTone {
  return verificationTone(outcome);
}

/** The display form of a sha-256 manifest digest (head + ellipsis; the full value rides the title attribute). */
export function shortDigest(digest: string): string {
  return `${digest.slice(0, 16)}…`;
}

/** One required-capability line, reviewer-facing (the grant review's payload). */
export interface KitCapabilityLine {
  key: string;
  label: string;
  mode: 'read' | 'write';
  dataCategories: string[];
}

/** Flatten the manifest's required capabilities into display lines. */
export function kitCapabilityLines(
  capabilities: readonly KitCapabilityDeclaration[],
): KitCapabilityLine[] {
  return capabilities.map((capability) => ({
    key: capability.key,
    label: capability.label,
    mode: capability.mode,
    dataCategories: [...capability.dataCategories],
  }));
}

/** Component counts of a kit manifest (the catalog row's metadata chips). */
export function kitComponentCounts(manifest: VerticalKitManifest): {
  capabilities: number;
  extensions: number;
  agents: number;
  integrations: number;
  schemaHints: number;
} {
  return {
    capabilities: manifest.requiredCapabilities.length,
    extensions: manifest.extensionDefinitions.length,
    agents: manifest.agentDefinitions.length,
    integrations: manifest.edgeIntegrations.length,
    schemaHints: manifest.dataSchemaHints.length,
  };
}

// ---------------------------------------------------------------------------
// Action derivation (the same rules the vertical-kits contract enforces)
// ---------------------------------------------------------------------------

export interface KitLifecyclePosture {
  /** Is the kit registered in the caller's tenant registry? */
  registered: boolean;
  /** The registered version's derived verification state (null when unregistered). */
  verificationState: 'unverified' | 'verified' | 'failed' | null;
  /** The live installation row (null when none). */
  installation: { status: KitInstallationStatus } | null;
}

export interface KitActions {
  /** Does the caller hold the vertical-kits administer claim? */
  canGovern: boolean;
  canInstall: boolean;
  installBlockedReason: string | null;
  canReview: boolean;
  canActivate: boolean;
  canSuspend: boolean;
  canResume: boolean;
  canRemove: boolean;
}

/** The governance copy for each legal kit lifecycle transition. */
export const KIT_TRANSITION_COPY: Record<
  KitInstallationTransition,
  { label: string; description: string }
> = {
  'review-approve': {
    label: 'Approve the grant review',
    description:
      "pending-review → granted. Approval mints EXACTLY the declared capabilities as kit grants — the reviewer's decision, recorded as append-only evidence.",
  },
  'review-reject': {
    label: 'Reject the grant review',
    description:
      'pending-review → rejected. Rejection mints NOTHING — denial stops the kit. Terminal for this install.',
  },
  activate: {
    label: 'Activate',
    description: 'granted → active. The kit becomes usable: capability invocations gate against the minted grants.',
  },
  suspend: {
    label: 'Suspend',
    description: 'active → suspended. Temporarily disable the kit; grants are retained while suspended.',
  },
  resume: {
    label: 'Resume',
    description: 'suspended → active. Undo a suspension.',
  },
  remove: {
    label: 'Remove',
    description:
      'any live state → removed. Terminal — every active grant is revoked with the kit (no orphaned authority); the append-only audit is retained.',
  },
};

/**
 * Derive exactly the kit actions THIS caller may legally take — the
 * same rules the vertical-kits contract enforces (the administer
 * claim; one live lifecycle per kit; install requires a VERIFIED
 * version; the lifecycle state machine's own transition sources).
 */
export function deriveKitActions(
  caller: { authority: readonly string[] },
  posture: KitLifecyclePosture,
): KitActions {
  const canGovern = caller.authority.includes(CLAIM_KIT_ADMINISTER);

  let installBlockedReason: string | null = null;
  if (posture.installation !== null) {
    installBlockedReason = `this kit already has a live installation ('${posture.installation.status}') — remove it before installing again`;
  } else if (posture.registered && posture.verificationState !== 'verified') {
    installBlockedReason = `the registered version is '${posture.verificationState}' — only a verified version can be installed`;
  } else if (!canGovern) {
    installBlockedReason = `installing a kit requires the '${CLAIM_KIT_ADMINISTER}' authority claim`;
  }

  const status = posture.installation?.status ?? null;
  const legal =
    status === null
      ? []
      : availableInstallationTransitions(status);
  const may = (transition: KitInstallationTransition): boolean =>
    canGovern && legal.includes(transition);

  return {
    canGovern,
    canInstall: installBlockedReason === null,
    installBlockedReason,
    canReview: may('review-approve') || may('review-reject'),
    canActivate: may('activate'),
    canSuspend: may('suspend'),
    canResume: may('resume'),
    canRemove: may('remove'),
  };
}

/** Totality guard: every kit installation state has human copy (unit-pinned). */
export function everyKitStateLabeled(): boolean {
  return KIT_INSTALLATION_STATES.every(
    (state) =>
      kitInstallationStateLabel(state).length > 0 &&
      kitInstallationStateExplanation(state).length > 20,
  );
}
