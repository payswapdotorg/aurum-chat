// ============================================================================
// provider-sdk — the ONLY public surface of the provider-sdk module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W089 — Provider Adapter SDK and OSS Technology Registry:
// "Standardize provider adapter lifecycle, conformance tests, health/
//  capability mapping, provider hot-swap evidence and technology
//  evaluation records including license/security/maintenance/exit path."
//
//   ADAPTER LIFECYCLE CONTRACT (lifecycle.ts):
//   the shared, provider-agnostic lifecycle
//   registered → discovered → configured → verified → active ⇄ degraded → retired
//   with canonical state transitions (PROVIDER_LIFECYCLE_TRANSITIONS),
//   an append-only tracker (ProviderLifecycleTracker) and failure→event /
//   failure→health mapping (§9 failure isolation: a provider outage never
//   becomes a domain failure — it becomes canonical capability/error state).
//
//   ERROR NORMALIZATION (normalization.ts):
//   CANONICAL_FAILURE_SEMANTICS is the single source of truth binding every
//   CanonicalErrorCategory to retryable/recovery/health-impact semantics;
//   normalizeProviderError turns ANY thrown value into a
//   CanonicalProviderFailure (provider classifier → SDK heuristics →
//   unknown_failure). Provider-native error objects never cross an adapter
//   boundary as themselves.
//
//   ADAPTER DEFINITION TEMPLATE (definition.ts):
//   createProviderAdapterDefinition — the template every conforming
//   provider fills in (descriptor keys, capability declaration, error
//   mapping). Deliberately NO execution method and NO selection logic:
//   provider selection stays in the owning gateway's routing/policy
//   (W089 acceptance; handoff §4.6 "no provider is architecturally
//   privileged"). PROVE-IT-TWICE: the llm module's openai + anthropic
//   adapters conform to this contract (their conformance suites live in
//   the llm module's tests) — a third adapter is creatable from the kit
//   alone (demonstrated in this module's tests).
//
//   CONFORMANCE TEST KIT (conformance.ts):
//   collectAdapterConformanceChecks / defineAdapterConformanceSuite — a
//   framework-agnostic check engine + thin vitest glue proving lifecycle
//   transitions, health/capability reporting, error normalization and
//   hot-swap evidence emission for ANY adapter.
//
//   HOT-SWAP EVIDENCE FORMAT (evidence.ts):
//   the canonical, gateway-agnostic HotSwapEvidenceRecord (request digest,
//   two differing targets, deterministic STRUCTURAL comparison — semantic
//   judgment stays with the caller), a deterministic builder
//   (buildHotSwapEvidence) and a validator (validateHotSwapEvidenceRecord).
//   Builds on the llm module's hot-swap verification precedent.
//
//   OSS TECHNOLOGY REGISTRY (registry.ts + registry/technologies.json):
//   the committed, machine-readable record of evaluated technologies with
//   the §15 due-diligence fields, seeded from
//   spec/TECHNOLOGY-RESEARCH-2026-09-23.md with strict provenance, plus
//   typed query functions and a Tech-Lead review summary (queryable; CLI:
//   scripts/technology-registry.ts).
//
// PURITY (handoff §9 provider isolation; `bun run arch`): this module
// imports NO provider SDKs, NO next/*, NO react, and NO other module's
// contract — it is a leaf every gateway may depend on. Provider objects
// never enter this module's types.
// ============================================================================

export { ProviderSdkError } from './errors';
export type { ProviderSdkErrorCode } from './errors';

// --- shared canonical types (types.ts) --------------------------------------

export { PROVIDER_ADAPTER_SDK_VERSION } from './types';
export type {
  CanonicalErrorCategory,
  CanonicalFailureRecovery,
  CanonicalFailureSemantics,
  CanonicalHealthImpact,
  CanonicalProviderFailure,
  HotSwapEvidenceInput,
  HotSwapEvidenceRecord,
  HotSwapOutcome,
  HotSwapTargetDescriptor,
  ProviderAdapterDefinition,
  ProviderAdapterDefinitionInput,
  ProviderCapabilitySet,
  ProviderErrorClassifier,
  ProviderHealthStatus,
  ProviderLifecycleEvent,
  ProviderLifecycleState,
  ProviderLifecycleTransition,
} from './types';

// --- adapter lifecycle --------------------------------------------------------

export {
  PROVIDER_LIFECYCLE_EVENTS,
  PROVIDER_LIFECYCLE_TRANSITIONS,
  ProviderLifecycleTracker,
  applyFailureToHealth,
  applySuccessToHealth,
  canTransitionProviderLifecycle,
  isProviderLifecycleEvent,
  isProviderLifecycleState,
  isRetirable,
  providerLifecycleTransitionError,
  suggestedLifecycleEventForFailure,
} from './lifecycle';
export type {
  ProviderLifecycleDescriptor,
  ProviderLifecycleDispatchOptions,
} from './lifecycle';

// --- canonical error normalization -------------------------------------------

export {
  CANONICAL_FAILURE_SEMANTICS,
  canonicalFailure,
  canonicalFailureSemantics,
  classifyProviderErrorHeuristically,
  healthImpactForCategory,
  isCanonicalErrorCategory,
  normalizeProviderError,
  recoveryForCategory,
  retryAfterMsFrom,
  safeErrorDetail,
} from './normalization';
export type { CanonicalFailureContext } from './normalization';

// --- adapter definition template ---------------------------------------------

export { createProviderAdapterDefinition } from './definition';

// --- conformance test kit ------------------------------------------------------

export {
  collectAdapterConformanceChecks,
  defineAdapterConformanceSuite,
} from './conformance';
export type {
  AdapterConformanceSubject,
  AdapterErrorSpecimen,
  ConformanceCheck,
  ConformanceFramework,
} from './conformance';

// --- hot-swap evidence format ---------------------------------------------------

export {
  buildHotSwapEvidence,
  canonicalRequestDigest,
  stableCanonicalJson,
  validateHotSwapEvidenceRecord,
} from './evidence';

// --- OSS technology registry ------------------------------------------------------

export {
  TECHNOLOGY_REGISTRY_SCHEMA_VERSION,
  findTechnologyEntry,
  listTechnologyCapabilities,
  listTechnologyEntries,
  listTechnologyEntriesByAdapterStatus,
  listTechnologyEntriesByCapability,
  listTechnologyEntriesByPriority,
  technologyRegistryReviewSummary,
  validateTechnologyRegistryEntry,
} from './registry';
export type {
  LicenseSourceAvailability,
  MaintenanceHealth,
  OperationsFit,
  SecurityPosture,
  TechnologyAdapterStatus,
  TechnologyCostPerformance,
  TechnologyDataHandling,
  TechnologyExitStrategy,
  TechnologyLicense,
  TechnologyMaintenance,
  TechnologyOperations,
  TechnologyPriority,
  TechnologyRegistryEntry,
  TechnologySecurity,
} from './registry';
