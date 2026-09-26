// ============================================================================
// vertical-kits — the ONLY public surface of the vertical-kits module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W092 — Vertical Extension Starter Kits:
// "Create reusable specialist extension/agent starter kits and first deep
//  integrations for system-of-record-heavy industries without moving
//  vertical semantics into Aurum core."
// Acceptance: each pack is installable, permission-scoped, versioned,
// auditable and removable; core modules remain industry-independent.
//
//   WHAT A KIT IS (a versioned, signed-manifest content package for ONE
//   vertical): a release-semver'd manifest — strictly increasing per kit
//   key, a changed declaration is a NEW version, never an edit — that
//   carries EVERYTHING vertical: required capability declarations, starter
//   extension/agent definitions (validated with the extensions and agents
//   modules' own pure rule sets — one semantics, reused, never forked),
//   vertical data-schema hints, and the declared system-of-record edge
//   integrations. Every stored version carries the sha-256 digest of the
//   canonical JSON of its manifest; verification re-derives it over the
//   STORED bytes, so tampering is loudly visible.
//
//   THE REGISTRY
//     registerKitVersion  — record one IMMUTABLE kit version (claim-gated
//        'vertical-kits:administer'); registration refuses any manifest
//        that fails the deterministic verification checks (the
//        marketplace's AUTOMATED_VERIFICATION discipline folded into
//        registration — kits are first-party content, not third-party
//        submissions).
//     runKitVerification  — append one immutable deterministic run over a
//        STORED version (per-check outcomes; a rule added later, or a row
//        edited outside the service, fails as a NEW run — drift
//        detection, never a rewrite).
//     getKitVersion / listKitVersions — tenant-scoped reads with each
//        version's DERIVED verification state.
//
//   THE INSTALL LIFECYCLE (the extensions-registry + marketplace patterns,
//   deliberately not a forked second lifecycle model)
//     installKit          — freeze the verified version's required-
//        capability snapshot and route the tenant's grant review through
//        the actions module's authority gate (W009, kind
//        'vertical-kit-deployment' × EXECUTE — the built-in default matrix
//        waits for a human decision; tenant policy may auto-allow, when
//        the grants mint immediately, or forbid, when the install lands
//        'rejected' — the gate's own verdict, recorded not swallowed).
//     decideKitReview     — the human decision, delegated to the actions
//        contract's decideApproval (the approve claim, separation of
//        duties and first-decision-wins are enforced THERE). Approval
//        mints EXACTLY the declared capabilities as active kit grants
//        (the capability-grants pattern, kit-scoped); rejection mints
//        NOTHING — denial stops the kit.
//     activateKit / suspendKit / resumeKit — the administrative on/off
//        switches (claim-gated).
//     removeKit           — terminal: EVERY active grant is revoked with
//        the kit (no orphaned authority) while the append-only audit is
//        retained; a fresh lifecycle may then be installed.
//     getKitInstallation / listKitInstallations — the reads.
//
//   THE KIT RUNTIME (the capability-grants pattern, kit-scoped)
//     invokeKitCapability — the pre-execution authority gate: allowed
//        when the installation is active and holds an active grant for
//        the capability; denied otherwise with the deterministic,
//        task-grounded reason naming the EXACT missing scope. EVERY
//        verdict (allowed or denied) lands in the append-only invocation
//        ledger.
//     inspectKitIntegration / executeKitIntegration — the deep-integration
//        paths. Both consult the gate FIRST (a denial is returned as data
//        and stops the call), then ride the VerticalKitEdge port.
//
//   THE EDGE SEAM (DEFERRED-ON-W088)
//     setVerticalKitEdge / getVerticalKitEdge — infrastructure wiring
//        for the kit runtime's system-of-record port. NOTHING is wired by
//        default: the Edge Connector (W088, in flight in a parallel work
//        stream) is the future implementor, and once it lands an adapter
//        will implement this port over the brokered connections and
//        progressive grants (W082/W083), composing kit writes onto the
//        W084 deep-action pipeline (discover→inspect→propose→authorize→
//        execute→verify→reconcile) so every execution carries its full
//        evidence chain. Until then the inspect/execute paths fail
//        explicitly with `edge_unavailable` — the module never fakes
//        success, never stubs Edge internals and never guesses W088's
//        API. A wired edge's results are canonicalized and validated (a
//        provider object cannot cross the kit runtime — lock 16); the
//        only provider-minted values persisted are OPAQUE strings
//        (receipt ids, the edge's own wiring identity).
//
//   THE HONEST STATUS REPORT
//     getKitStatus        — what is installed, which capabilities hold
//        authority, which components are DEFINED (starter definitions,
//        never claimed as deployed software — materialization into the
//        extension/agent registries follows those modules' own governed
//        lifecycles downstream), and which integrations are
//        'deferred-on-w088' until an edge is wired.
//
//   THE LEDGERS (append-only at the storage level — triggers refuse
//   UPDATE/DELETE/TRUNCATE)
//     listKitInvocations  — every gate verdict, allowed or denied;
//     listKitEdgeActions  — every real execution through a wired edge;
//     listKitEvents       — the install/configure/remove audit trail
//        (every grant minted and revoked).
//
//   THE FIRST-CLASS CONTENT (the seeds this module ships)
//     STARTER_KITS / LEGAL_CASE_MANAGEMENT_KIT / ACCOUNTING_LEDGER_ERP_KIT
//        — the two system-of-record-heavy starter kits: legal /
//        case-management and accounting / ledger-ERP. Everything vertical
//        lives inside these manifests; no core module names, stores or
//        interprets anything vertical.
//
// There is deliberately NO operation to update or erase a kit version, a
// verification run, an invocation or an event, and NO operation to
// un-reject a review or un-remove an installation: history is immutable,
// rejection and removal are terminal, and a changed kit ships as a NEW
// version (a fresh install lifecycle). Learning never rewrites execution
// history (lock 14 mirrored).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's kit versions,
// verifications, installations, grants, invocations, edge actions or
// events are indistinguishable from missing (`kit_version_not_found` /
// `installation_not_found`) — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W092 ← W025, W026, W027, W084,
// W088): this module imports ONLY module contracts — actions (the W009
// approval gate), extensions (the W025 pure manifest rule sets + semver
// the kit layer reuses) and agents (the W021 vocabularies kit agent
// definitions are validated against). The W026 runtime and W027 builder
// surfaces compose downstream when kit component definitions are
// materialized into real extensions; the W084 deep-action pipeline is
// what kit integrations will ride once the W088 Edge Connector implements
// this module's edge port (DEFERRED-ON-W088, above).
// ============================================================================

export {
  // the registry
  registerKitVersion,
  runKitVerification,
  getKitVersion,
  listKitVersions,
  // the install lifecycle
  installKit,
  decideKitReview,
  activateKit,
  suspendKit,
  resumeKit,
  removeKit,
  getKitInstallation,
  listKitInstallations,
  // the kit runtime
  invokeKitCapability,
  inspectKitIntegration,
  executeKitIntegration,
  // the ledgers
  listKitInvocations,
  listKitEdgeActions,
  listKitEvents,
  // the honest status report
  getKitStatus,
  // the edge port wiring (the DEFERRED-ON-W088 seam)
  setVerticalKitEdge,
  getVerticalKitEdge,
} from './service';

export { VerticalKitsError } from './errors';
export type { VerticalKitsErrorCode } from './errors';

// Module-owned constants (the administration claim and the canonical
// W009 action kind of a kit install grant review).
export {
  VERTICAL_KITS_AUTHORITY_ADMINISTER,
  VERTICAL_KIT_ACTION_KIND,
} from './service';

// The first-class starter-kit content (the module's shipped seeds —
// everything vertical lives inside these manifests).
export {
  STARTER_KITS,
  LEGAL_CASE_MANAGEMENT_KIT,
  ACCOUNTING_LEDGER_ERP_KIT,
} from './kits';

// The pure lifecycle state machine (usable without a database).
export {
  KIT_INSTALLATION_STATES,
  KIT_INSTALLATION_TRANSITIONS,
  KIT_AUTHORITY_HOLDING_STATES,
  availableInstallationTransitions,
  canTransitionInstallation,
  isKitInstallationState,
  isKitInstallationTransition,
  isKitUsableState,
  isTerminalInstallationState,
  targetInstallationState,
} from './lifecycle';

// The pure signed-manifest digest surface (unit-tested; the integrity
// signature of a kit manifest).
export {
  canonicalKitJson,
  digestKitManifest,
  isManifestDigest,
} from './digest';

// The pure deterministic verification surface (unit-tested; the same
// checks registration enforces and runKitVerification re-examines).
export {
  KIT_VERIFICATION_CHECKS,
  agentDefinitionProblemsForKit,
  capabilityDeclarationProblemsForKit,
  extensionDefinitionProblemsForKit,
  integrationReferenceProblems,
  manifestShapeProblems,
  schemaHintProblemsForKit,
  verifyKitManifest,
} from './verification';
export type {
  KitVerificationCheck,
  KitVerificationOutcome,
} from './verification';

// The pure deterministic-reason surface (unit-tested; the
// human-readable language of kit capability denials, built with no LLM,
// no clock, no randomness — lock 10).
export {
  buildInactiveInstallationReason,
  buildMissingGrantReason,
  clampDetail,
  joinAnd,
  taskPhrase,
} from './reason';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_LIST_LIMIT,
  KIT_GRANT_STATUSES,
  KIT_INSTALLATION_INVOCATION_OUTCOMES,
  KIT_INVOCATION_BASES,
  KIT_RECEIPT_STATUSES,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_JUSTIFICATION_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MANIFEST_BYTES,
  MAX_NOTE_LENGTH,
  MAX_RECEIPT_DETAIL_LENGTH,
  MAX_RECEIPT_ID_LENGTH,
  MAX_REMOVAL_REASON_LENGTH,
  MAX_REQUESTED_FOR_LENGTH,
  MAX_TARGET_LENGTH,
  MAX_VALUE_BYTES,
  MIN_TASK_DESCRIPTION_LENGTH,
  assertVerticalKitsTenantContext,
  isUuid,
  parseKitSemver,
} from './validation';

export type {
  // the manifest and its sections
  KitAgentDefinition,
  KitCapabilityDeclaration,
  KitDataSchemaHint,
  KitEdgeIntegrationDeclaration,
  KitExtensionDefinition,
  KitSchemaHintField,
  VerticalKitManifest,
  // registry rows
  VerticalKitVersion,
  VerticalKitVersionSummary,
  VerticalKitVersionWithVerification,
  VerticalKitVerification,
  KitVerificationCheckResult,
  // installations
  KitInstallation,
  KitInstallationDetail,
  KitInstallationStatus,
  KitCapabilityGrant,
  KitTaskContext,
  KitCapabilityInvocation,
  KitInvocationBasis,
  KitEdgeAction,
  KitInstallationEvent,
  // the status report
  KitStatusReport,
  KitComponentStatus,
  KitIntegrationReadiness,
  // the edge port
  VerticalKitEdge,
  VerticalKitEdgeInspectRequest,
  VerticalKitEdgeExecuteRequest,
  VerticalKitEdgeReceipt,
  VerticalKitEdgeState,
  // inputs, queries and results
  RegisterKitVersionInput,
  RegisterKitVersionResult,
  InstallKitInput,
  DecideKitReviewInput,
  InstallationTargetInput,
  SuspendedRemovalInput,
  InvokeKitCapabilityInput,
  InspectKitIntegrationInput,
  InspectKitIntegrationResult,
  ExecuteKitIntegrationInput,
  ExecuteKitIntegrationResult,
  GetKitVersionQuery,
  ListKitVersionsQuery,
  GetInstallationQuery,
  ListKitInstallationsQuery,
  ListInstallationRecordsQuery,
} from './types';
