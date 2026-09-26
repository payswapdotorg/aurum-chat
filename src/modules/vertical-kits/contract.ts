// ============================================================================
// vertical-kits — the ONLY public surface of the vertical-kits module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W092 — Vertical Extension Starter Kits:
// "Create reusable specialist extension/agent starter kits and first
//  deep integrations for system-of-record-heavy industries without
//  moving vertical semantics into Aurum core."
// Acceptance: "each pack is installable, permission-scoped, versioned,
// auditable and removable; core modules remain industry-independent."
//
//   THE KIT CATALOG (validated DATA, served generically)
//     listKitCatalog / getKitDefinition — the registered starter kits:
//      versioned data bundles (extension manifests composed from the
//      extensions contract's own input shape, the fail-closed
//      permission footprint, deep-action recipe templates shaped after
//      the W084 operation contract, broker connection-class
//      requirements, honest metadata). Every resolve re-validates the
//      record against the contracts it rides — a registry entry that
//      stops being valid is refused at read time. The module's code is
//      industry-blind: kit content lives in kits.ts and nowhere else.
//
//   THE INSTALL LIFECYCLE (marketplace-package-driven, tenant-scoped)
//     installVerticalKit — resolve every kit manifest to its
//      INSTALLABLE marketplace ExtensionPackage (W028, fail-closed on
//      content drift), register + verify + activate + deploy each
//      manifest in the TENANT's own extensions registry (W025/W026)
//      with the granted permissions EXACTLY the kit's declared
//      footprint, and record the install idempotently with one
//      append-only lifecycle event freezing the full WHAT. A W009 gate
//      that waits surfaces honestly as 'approval_required'; re-invoking
//      after the human decision replays idempotently.
//     upgradeVerticalKit — a STRICTLY GREATER version install: the
//      grant set is replaced and BOTH states live on in the audit
//      trail (no silent in-place mutation of granted permissions).
//     removeVerticalKit — the grants and package bindings are removed;
//      the append-only events and the immutable recipe references
//      survive, so in-flight references keep rendering "this template
//      came from kit vX" after removal — no silent data loss.
//
//   THE READS + THE HONEST EDGE DECLARATION
//     getVerticalKitInstall / listVerticalKitInstalls /
//     listVerticalKitEvents / recordVerticalKitRecipeUse /
//     listVerticalKitRecipeReferences — the lifecycle reads, the
//      append-only audit and the removal-surviving reference trail.
//      Every served kit carries its edgeExecution posture rendered as
//      the single honest status 'pending-w088' — the W088 Edge
//      Connector is in flight on a sibling branch at this base, and
//      NOTHING in this module claims or performs edge execution.
//
//   THE PURE COMPOSITION SEAM
//     composeDeepActionInput — how a kit recipe template becomes the
//      deep-actions gateway's own input shape (DATA ONLY; the gateway's
//      own gates and evidence discipline stay entirely in W084).
//
// There is deliberately NO operation to edit a kit definition (a
// changed bundle is a NEW version record in the registry — the
// extensions module's manifest discipline applied to kits), no
// operation to rewrite or drop a lifecycle event or a recipe reference
// (append-only by storage triggers), and NO edge execution path.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's installs,
// grants, events or references are indistinguishable from missing —
// no existence leak.
//
// Dependency posture: this module imports ONLY src/infra ports and
// module contracts — extensions (registry, verification, runtime
// grant), marketplace (the governed catalog through INSTALLABLE),
// deep-actions / connection-broker / integration-intelligence (the
// closed vocabularies the pure validation rides). Vertical semantics
// never cross this boundary into any other module.
// ============================================================================

export {
  // the kit catalog (validated DATA, served generically)
  getKitDefinition,
  listKitCatalog,
  edgeExecutionInfoOf,
  KIT_REGISTRY,
  // the install lifecycle (marketplace-package-driven)
  installVerticalKit,
  upgradeVerticalKit,
  removeVerticalKit,
  // the reads + the honest edge declaration
  getVerticalKitInstall,
  listVerticalKitInstalls,
  listVerticalKitEvents,
  recordVerticalKitRecipeUse,
  listVerticalKitRecipeReferences,
} from './service';

// Module-owned authority claim.
export { VERTICAL_KITS_AUTHORITY_ADMINISTER } from './service';
export { assertVerticalKitsTenantContext } from './service';

export { VerticalKitsError } from './errors';
export type { VerticalKitsErrorCode } from './errors';

// The pure composition seam (recipe template → the gateway's own
// input shape; DATA ONLY).
export { composeDeepActionInput } from './compose';

// Pure vocabularies, guards and validation (usable without a database).
export {
  EDGE_EXECUTION_STATUS,
  VERTICAL_KIT_EVENT_TYPES,
} from './types';
export type {
  EdgeExecutionStatus,
  VerticalKitEventType,
} from './types';

export {
  KIT_KEY_PATTERN,
  MAX_CONNECTIONS_PER_KIT,
  MAX_INDUSTRY_CHARS,
  MAX_MANIFESTS_PER_KIT,
  MAX_METADATA_ITEM_CHARS,
  MAX_METADATA_TEXT_CHARS,
  MAX_NOT_INCLUDED_ITEMS,
  MAX_OUTCOME_ITEMS,
  MAX_RECIPES_PER_KIT,
  isVerticalKitKey,
  isVerticalKitsUuid,
  kitManifestSubject,
  normalizeKitManifest,
  unionPermissionsOf,
  validateKitDefinition,
} from './validation';

// Public domain types.
export type {
  DeepActionRecipeTemplate,
  EdgeExecutionDeclaration,
  InstallVerticalKitInput,
  InstallVerticalKitResult,
  KitConnectionRequirement,
  KitEdgeExecutionInfo,
  KitExtensionManifestSpec,
  KitManifestSubject,
  KitMetadata,
  RecordRecipeUseInput,
  RemoveVerticalKitInput,
  RemoveVerticalKitResult,
  VerticalKitDefinition,
  VerticalKitEvent,
  VerticalKitGrant,
  VerticalKitInstall,
  VerticalKitRecipeReference,
  VerticalKitSummary,
} from './types';
