// Product surface (W064) — the marketplace area's pure vocabulary and
// derivation logic: human labels, pill tones, permission copy and the
// action-availability rules. No database, no framework — everything here
// is unit-testable and shared by the server views, the client forms and
// the API layer, so the three can never drift.
//
// VISUAL DIRECTION (frozen): status pills pair a colored dot with a text
// label (never color alone); gold/amber stays reserved for degraded /
// warning states. All copy stays in the product's honest voice — states
// are what they are, never marketing.

import type { PillTone } from '../../lib/states';
import type {
  MarketplacePackage,
  MarketplacePackageKind,
  MarketplacePackageState,
} from '@/modules/marketplace/contract';
import type { ExtensionLifecycleState } from '@/modules/extensions/contract';
import type { AgentRuntimeProvider } from '@/modules/agents/contract';

// ---------------------------------------------------------------------------
// Marketplace package states (W028's governed chain)
// ---------------------------------------------------------------------------

/** Human label for a marketplace package state (the pill's text). */
export function packageStateLabel(state: MarketplacePackageState): string {
  switch (state) {
    case 'DRAFT':
      return 'Draft';
    case 'SUBMITTED':
      return 'Submitted';
    case 'AUTOMATED_VERIFICATION':
      return 'Automated verification';
    case 'PENDING_REVIEW':
      return 'Pending platform review';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'PUBLISHED':
      return 'Published';
    case 'INSTALLABLE':
      return 'Installable';
  }
}

/** The pill tone for a marketplace package state. */
export function packageStateTone(state: MarketplacePackageState): PillTone {
  switch (state) {
    case 'PENDING_REVIEW':
    case 'AUTOMATED_VERIFICATION':
      return 'warning';
    case 'REJECTED':
      return 'error';
    case 'APPROVED':
    case 'PUBLISHED':
    case 'INSTALLABLE':
      return 'positive';
    default:
      return 'neutral';
  }
}

/** One plain sentence explaining what a state means (progressive disclosure). */
export function packageStateExplanation(state: MarketplacePackageState): string {
  switch (state) {
    case 'DRAFT':
      return 'The artifact is frozen and owned by its vendor, but has not entered the platform pipeline yet.';
    case 'SUBMITTED':
      return 'The vendor handed the artifact to the platform pipeline; automated verification has not run yet.';
    case 'AUTOMATED_VERIFICATION':
      return 'The deterministic verification phase — every package passes it before any human sees it.';
    case 'PENDING_REVIEW':
      return 'Automated verification passed; the mandatory platform review decision is still open.';
    case 'APPROVED':
      return 'The platform approved the artifact; the platform can now publish it to the catalog.';
    case 'REJECTED':
      return 'The platform rejected this version — terminal for this artifact; the fixed artifact ships as a new version.';
    case 'PUBLISHED':
      return 'Listed in the public catalog. Publication never implies installation — installation is gated separately.';
    case 'INSTALLABLE':
      return 'Listed and cleared for tenant installation. Installing never activates anything on its own.';
  }
}

/** The two package kinds, human-labeled. */
export function packageKindLabel(kind: MarketplacePackageKind): string {
  return kind === 'extension' ? 'Extension package' : 'Agent package';
}

/**
 * The governed chain as the surface renders it (the state machine's own
 * order — DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW →
 * APPROVED / REJECTED → PUBLISHED → INSTALLABLE).
 */
export const PACKAGE_CHAIN: readonly MarketplacePackageState[] = [
  'DRAFT',
  'SUBMITTED',
  'AUTOMATED_VERIFICATION',
  'PENDING_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'INSTALLABLE',
];

/** Where a package sits in the rendered chain (REJECTED hangs at review). */
export function chainPosition(state: MarketplacePackageState): number {
  if (state === 'REJECTED') return PACKAGE_CHAIN.indexOf('PENDING_REVIEW');
  return PACKAGE_CHAIN.indexOf(state);
}

// ---------------------------------------------------------------------------
// Extension lifecycle (the tenant registry's own states — W025)
// ---------------------------------------------------------------------------

export function extensionStateLabel(state: ExtensionLifecycleState): string {
  switch (state) {
    case 'REGISTERED':
      return 'Registered';
    case 'ACTIVE':
      return 'Active';
    case 'SUSPENDED':
      return 'Suspended';
    case 'DEPRECATED':
      return 'Deprecated';
  }
}

export function extensionStateTone(state: ExtensionLifecycleState): PillTone {
  switch (state) {
    case 'ACTIVE':
      return 'positive';
    case 'SUSPENDED':
      return 'warning';
    case 'DEPRECATED':
      return 'neutral';
    default:
      return 'info';
  }
}

export function extensionStateExplanation(state: ExtensionLifecycleState): string {
  switch (state) {
    case 'REGISTERED':
      return 'Manifest versions are recorded in your registry; the extension is inert until activated.';
    case 'ACTIVE':
      return 'Enabled — deployments and runtime capabilities are authorized downstream.';
    case 'SUSPENDED':
      return 'Temporarily disabled; resuming returns it to ACTIVE.';
    case 'DEPRECATED':
      return 'Retired. Terminal — a deprecated extension accepts no new versions or transitions.';
  }
}

// ---------------------------------------------------------------------------
// Builder phases (W027) and verification postures
// ---------------------------------------------------------------------------

/** Human label for a build phase (unknown values render as-is). */
export function buildPhaseLabel(phase: string): string {
  switch (phase) {
    case 'designing':
      return 'Designing';
    case 'building':
      return 'Building';
    case 'built':
      return 'Built';
    case 'verified':
      return 'Verified';
    case 'deploying':
      return 'Deploying';
    case 'deployed':
      return 'Deployed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return phase;
  }
}

export function buildPhaseTone(phase: string): PillTone {
  switch (phase) {
    case 'deployed':
      return 'positive';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'neutral';
    default:
      return 'info';
  }
}

export function buildPhaseExplanation(phase: string): string {
  switch (phase) {
    case 'designing':
      return 'The builder agent produces a capability design; advancing pumps one phase at a time.';
    case 'building':
      return 'The builder agent turns the validated design into a complete manifest declaration.';
    case 'built':
      return 'The declaration registered as a manifest version; verification has not run yet.';
    case 'verified':
      return 'The same deterministic checks the platform runs passed on the manifest.';
    case 'deploying':
      return 'Activation and deployment are being brought to your authority gate.';
    case 'deployed':
      return 'Terminal: the version is registered, verified, active and deployed.';
    case 'failed':
      return 'Terminal with recorded evidence — the failure code and detail say why.';
    case 'cancelled':
      return 'Terminal: a live build was cancelled with a reason.';
    default:
      return phase;
  }
}

export function verificationTone(outcome: 'unverified' | 'verified' | 'failed'): PillTone {
  switch (outcome) {
    case 'verified':
      return 'positive';
    case 'failed':
      return 'error';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Permission inspection copy (the closed vocabularies, explained)
// ---------------------------------------------------------------------------

export interface PermissionLine {
  key: string;
  label: string;
  description: string;
}

/** Human copy for every extension permission in the closed vocabulary. */
export const EXTENSION_PERMISSION_COPY: Record<string, PermissionLine> = {
  'state:read': {
    key: 'state:read',
    label: 'Read its own state',
    description: 'Read back the persistent state the extension itself owns.',
  },
  'state:write': {
    key: 'state:write',
    label: 'Write its own state',
    description: 'Persist its own scoped state — bounded by the declared quota.',
  },
  'ui:render': {
    key: 'ui:render',
    label: 'Render host UI',
    description: 'Contribute declarative UI blocks the HOST renders — extensions never ship their own UI runtime.',
  },
  'schedule:run': {
    key: 'schedule:run',
    label: 'Run on schedules',
    description: 'Be invoked on the declared cron schedules, bounded per day.',
  },
  'events:subscribe': {
    key: 'events:subscribe',
    label: 'Subscribe to events',
    description: 'Receive the declared domain event topics.',
  },
  'external:participate': {
    key: 'external:participate',
    label: 'Call external origins',
    description: 'Make scoped HTTPS calls — only to the declared origins, bounded per day.',
  },
  'telemetry:emit': {
    key: 'telemetry:emit',
    label: 'Emit telemetry',
    description: 'Emit its own telemetry events for observability.',
  },
};

/** Human copy for the agents module's six §20 authority scopes. */
export const AGENT_SCOPE_COPY: Record<string, PermissionLine> = {
  observe: {
    key: 'observe',
    label: 'Observe',
    description: 'Read tenant-scoped state (authority level OBSERVE).',
  },
  analyze: {
    key: 'analyze',
    label: 'Analyze',
    description: 'Compute over observed state (authority level ANALYZE).',
  },
  recommend: {
    key: 'recommend',
    label: 'Recommend',
    description: 'Propose non-binding recommendations (authority level RECOMMEND).',
  },
  ask: {
    key: 'ask',
    label: 'Ask',
    description: 'Ask humans targeted questions (authority level ASK).',
  },
  propose: {
    key: 'propose',
    label: 'Propose',
    description: 'Propose consequential actions that still need human approval (authority level PROPOSE).',
  },
  execute: {
    key: 'execute',
    label: 'Execute',
    description: 'Execute approved actions directly (authority level EXECUTE) — the highest scope.',
  },
};

/** Render a permission list as inspection lines (unknown keys stay honest). */
export function permissionLines(
  keys: readonly string[],
  copy: Record<string, PermissionLine>,
): PermissionLine[] {
  return keys.map((key) => {
    const line = copy[key];
    return line ?? { key, label: key, description: 'Unrecognized permission key — treated as requested.' };
  });
}

// ---------------------------------------------------------------------------
// Capability summary (the extension declaration, in plain words)
// ---------------------------------------------------------------------------

export interface CapabilityLine {
  label: string;
  detail: string;
}

/** Flatten one capability declaration into plain-word lines (pure). */
export function capabilityLines(capabilities: {
  stateScope: string;
  uiSurfaces: readonly string[];
  schedules: readonly { name: string; cron: string }[];
  eventSubscriptions: readonly string[];
  externalParticipants: readonly { label: string; origin: string }[];
  telemetry: boolean;
}): CapabilityLine[] {
  const lines: CapabilityLine[] = [];
  if (capabilities.stateScope !== 'none') {
    lines.push({
      label: 'Persistent state',
      detail: `${capabilities.stateScope === 'tenant' ? 'tenant-scoped' : 'install-scoped'} — bounded by the declared quota`,
    });
  }
  if (capabilities.uiSurfaces.length > 0) {
    lines.push({
      label: 'Host-rendered UI',
      detail: capabilities.uiSurfaces.join(', '),
    });
  }
  if (capabilities.schedules.length > 0) {
    lines.push({
      label: 'Schedules',
      detail: capabilities.schedules.map((s) => `${s.name} (${s.cron})`).join(', '),
    });
  }
  if (capabilities.eventSubscriptions.length > 0) {
    lines.push({
      label: 'Event subscriptions',
      detail: capabilities.eventSubscriptions.join(', '),
    });
  }
  if (capabilities.externalParticipants.length > 0) {
    lines.push({
      label: 'External participants',
      detail: capabilities.externalParticipants.map((p) => `${p.label} — ${p.origin}`).join(', '),
    });
  }
  if (capabilities.telemetry) {
    lines.push({ label: 'Telemetry', detail: 'emits its own telemetry events' });
  }
  if (lines.length === 0) {
    lines.push({ label: 'No capabilities', detail: 'the declaration requests no runtime capability' });
  }
  return lines;
}

/** The quotas of a subject, human-readable (extension packages). */
export function quotaLines(quotas: {
  maxStateBytes: number;
  maxScheduleInvocationsPerDay: number;
  maxExternalCallsPerDay: number;
}): CapabilityLine[] {
  return [
    { label: 'State ceiling', detail: formatBytes(quotas.maxStateBytes) },
    { label: 'Schedule invocations / day', detail: String(quotas.maxScheduleInvocationsPerDay) },
    { label: 'External calls / day', detail: String(quotas.maxExternalCallsPerDay) },
  ];
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Action availability (what THIS caller may do with THIS package)
// ---------------------------------------------------------------------------

/** The claims each side of the governance surface needs. */
export const CLAIM_SUBMIT = 'marketplace:submit';
export const CLAIM_ADMINISTER = 'marketplace:administer';
export const CLAIM_EXTENSIONS_ADMINISTER = 'extensions:administer';
export const CLAIM_AGENTS_ADMINISTER = 'agents:administer';

/** The action surface for one package as one derivable record (pure). */
export interface PackageActions {
  isVendor: boolean;
  canSubmit: boolean;
  canRunVerification: boolean;
  canReview: boolean;
  canPublish: boolean;
  canMakeInstallable: boolean;
  canInstall: boolean;
  /** True when review is blocked ONLY by separation of duties. */
  reviewBlockedBySeparation: boolean;
  /** Why install is unavailable (null when available). */
  installBlockedReason: string | null;
}

/**
 * Derive what a caller (tenant + principal + authority claims) may do
 * with one package — the exact rules the domain contracts enforce, so
 * the UI never offers an action the contract would refuse (and never
 * hides one it would allow).
 */
export function derivePackageActions(
  caller: { tenantId: string; principalId: string; authority: readonly string[] },
  pkg: Pick<MarketplacePackage, 'kind' | 'state' | 'vendorTenant' | 'vendorPrincipal'>,
): PackageActions {
  const claims = caller.authority;
  const isVendor = pkg.vendorTenant === caller.tenantId;
  const administer = claims.includes(CLAIM_ADMINISTER);
  const separationBlocked =
    pkg.vendorTenant === caller.tenantId || pkg.vendorPrincipal === caller.principalId;

  let installBlockedReason: string | null = null;
  if (pkg.state !== 'INSTALLABLE') {
    installBlockedReason = 'only INSTALLABLE packages can be installed';
  }
  const neededClaim =
    pkg.kind === 'extension' ? CLAIM_EXTENSIONS_ADMINISTER : CLAIM_AGENTS_ADMINISTER;
  if (installBlockedReason === null && !claims.includes(neededClaim)) {
    installBlockedReason = `installing ${pkg.kind === 'extension' ? 'an extension' : 'an agent'} package requires the '${neededClaim}' authority claim`;
  }

  return {
    isVendor,
    canSubmit: isVendor && pkg.state === 'DRAFT' && claims.includes(CLAIM_SUBMIT),
    canRunVerification: administer && pkg.state === 'SUBMITTED',
    canReview: administer && pkg.state === 'PENDING_REVIEW' && !separationBlocked,
    canPublish: administer && pkg.state === 'APPROVED',
    canMakeInstallable: administer && pkg.state === 'PUBLISHED',
    canInstall: installBlockedReason === null,
    reviewBlockedBySeparation: administer && pkg.state === 'PENDING_REVIEW' && separationBlocked,
    installBlockedReason,
  };
}

/** The agent runtime provider, human-labeled (closed vocabulary). */
export function agentProviderLabel(provider: AgentRuntimeProvider): string {
  return provider;
}

/** May this caller drive the builder/publish developer surface at all? */
export function canUseDeveloperSurface(authority: readonly string[]): boolean {
  return (
    authority.includes(CLAIM_SUBMIT) ||
    authority.includes(CLAIM_ADMINISTER) ||
    authority.includes(CLAIM_EXTENSIONS_ADMINISTER)
  );
}
