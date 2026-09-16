// Pure lifecycle logic of the extensions module (W025 — Extension
// Contracts). No database, no context, no time.
//
// THE EXTENSION LIFECYCLE (the catalog entry's third noun). ARCHITECTURE
// §17 gives the marketplace-package chain
// `... → INSTALLABLE → ACTIVE / SUSPENDED / DEPRECATED` and states
// "Publication never implies tenant installation or activation" — so
// the ACTIVE/SUSPENDED/DEPRECATED tail is the EXTENSION's own lifecycle
// in the tenant registry, which W025 owns. Marketplace publication
// states through INSTALLABLE are W028's ExtensionPackage lifecycle;
// install-scoped runtime state is W026. This module defines the
// extension (definition-level) lifecycle those work items drive:
//
//   REGISTERED — manifests recorded, the extension is inert;
//   ACTIVE     — enabled (deployment/use is authorized downstream);
//   SUSPENDED  — temporarily disabled (§17 "disablement");
//   DEPRECATED — retired; TERMINAL.
//
// Legal transitions (deterministic state machine, pure functions):
//
//   activate   : REGISTERED → ACTIVE
//   suspend    : ACTIVE     → SUSPENDED
//   resume     : SUSPENDED  → ACTIVE
//   deprecate  : REGISTERED | ACTIVE | SUSPENDED → DEPRECATED
//
// Everything else is illegal — including any transition out of
// DEPRECATED (retired is retired: no resurrection, no re-suspension)
// and suspending an extension that was never activated. The service
// routes every transition through the actions authority matrix (kind
// 'extension-deployment', level EXECUTE — §20 names extension
// deployment among the consequential actions the matrix governs
// uniformly), re-checks legality at apply time, and appends one
// immutable lifecycle event per applied transition.

/** The extension lifecycle states, in canonical order. */
export const EXTENSION_LIFECYCLE_STATES = [
  'REGISTERED',
  'ACTIVE',
  'SUSPENDED',
  'DEPRECATED',
] as const;

export type ExtensionLifecycleState = (typeof EXTENSION_LIFECYCLE_STATES)[number];

export function isExtensionLifecycleState(
  value: unknown,
): value is ExtensionLifecycleState {
  return (
    typeof value === 'string' &&
    (EXTENSION_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

/** The named lifecycle transitions. */
export const EXTENSION_TRANSITIONS = ['activate', 'suspend', 'resume', 'deprecate'] as const;

export type ExtensionTransition = (typeof EXTENSION_TRANSITIONS)[number];

export function isExtensionTransition(value: unknown): value is ExtensionTransition {
  return (
    typeof value === 'string' &&
    (EXTENSION_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** The state a transition targets (total: every named transition has one). */
export function targetLifecycleState(transition: ExtensionTransition): ExtensionLifecycleState {
  switch (transition) {
    case 'activate':
      return 'ACTIVE';
    case 'suspend':
      return 'SUSPENDED';
    case 'resume':
      return 'ACTIVE';
    case 'deprecate':
      return 'DEPRECATED';
  }
}

/**
 * The legal source states of each transition — the entire state machine
 * in one table. Kept private; `canTransitionExtension` is the surface.
 */
const TRANSITION_SOURCES: Record<ExtensionTransition, readonly ExtensionLifecycleState[]> = {
  activate: ['REGISTERED'],
  suspend: ['ACTIVE'],
  resume: ['SUSPENDED'],
  deprecate: ['REGISTERED', 'ACTIVE', 'SUSPENDED'],
};

/**
 * May `transition` be applied to an extension currently in `from`?
 * Pure and total — the service checks it BEFORE authorizing (fail fast
 * on nonsense) and AGAIN inside the apply transaction (the state may
 * have moved while an approval was pending).
 */
export function canTransitionExtension(
  from: ExtensionLifecycleState,
  transition: ExtensionTransition,
): boolean {
  return TRANSITION_SOURCES[transition].includes(from);
}
