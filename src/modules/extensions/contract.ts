// ============================================================================
// extensions — the ONLY public surface of the extensions module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W025 — Extension Contracts:
// "Define versioned extension manifests, permissions, lifecycle and
//  verification states."
//
// VERSIONED EXTENSION MANIFESTS (ARCHITECTURE.md §17):
//   registerExtensionManifest — record one IMMUTABLE manifest version
//      (claim-gated 'extensions:administer'): the manifest format is
//      itself versioned (manifestSchemaVersion), the extension's own
//      release semver must STRICTLY increase per extension key (numeric
//      order — 1.2.10 > 1.2.9), and a changed declaration is always a
//      NEW version, never an edit. The first registration of a key
//      creates the extension in REGISTERED state.
//   getManifest / listManifests — tenant-scoped reads of the versioned
//      manifest history with each version's DERIVED verification state.
//
// PERMISSIONS (the closed vocabulary + the consistency rule):
//   The manifest declares capabilities (persistent tenant/install
//   scoped state, host-rendered declarative UI surfaces, schedules,
//   event subscriptions, scoped external participants, telemetry) and
//   requests permissions from a closed vocabulary. The requested set
//   must be EXACTLY what the declared capabilities require — no
//   capability undeclared (least privilege enforced), no permission
//   without its justifying capability (no scope hoarding). Enforced at
//   registration, by a storage trigger, and re-examined by the
//   `permissions-consistency` verification check. requestedPermissions
//   is the CEILING any install-time grant (W026/W028) is bounded by;
//   grants themselves are downstream scope.
//
// LIFECYCLE (the extension's own states, §17's tail):
//   REGISTERED → ACTIVE ⇄ SUSPENDED → DEPRECATED (terminal).
//   transitionExtension — route one lifecycle transition through the
//      actions module's authority matrix (kind 'extension-deployment',
//      level EXECUTE — §20's uniform gate for extension deployment).
//      allowed → applied immediately; approval_required → the
//      transition WAITS (applied: false, the gate request id returned;
//      re-invoke with the same idempotencyKey after the human decision
//      to complete it); forbidden → 'forbidden_by_policy' (the
//      rejection is recorded by the actions module). Activation
//      additionally requires the latest manifest version to be
//      VERIFIED — no unverified software capability is enabled.
//      Legality is re-checked at apply time; every applied transition
//      appends one immutable lifecycle event linking its gate request.
//   getExtension / listExtensions / listExtensionLifecycleEvents — the
//      registry reads and the append-only transition trail.
//
// VERIFICATION STATES (append-only evidence, derived state):
//   runManifestVerification — run the deterministic STATIC checks
//      (claim-gated) over a stored manifest version and append one
//      immutable run with per-check outcomes. The marketplace's
//      AUTOMATED_VERIFICATION phase (W028) and the builder's verify
//      step (W027) run the SAME exported pure checks — one semantics.
//   getManifestVerification / listManifestVerifications — a version's
//      derived state (UNVERIFIED / VERIFIED / FAILED — the latest run
//      decides) and its run history. Runs never mutate: a rule added
//      later fails an older manifest as a NEW run (drift detection),
//      never as a rewrite.
//   checkManifestCompatibility — the §17 "compatibility" read: may this
//      manifest run on a given host runtime version (declared semver
//      range)? The pure core (checkHostRuntimeCompatibility) is
//      exported for the runtime (W026).
//
// There is deliberately NO operation to update or delete a manifest, a
// verification run or a lifecycle event, and NO operation to
// un-deprecate an extension: history is immutable, retirement is
// terminal, and the storage-level triggers enforce it even for callers
// bypassing this service. Install-scoped runtime state, deployment and
// rollback mechanics are W026; marketplace publication states through
// INSTALLABLE and platform approval are W028; the builder workflow is
// W027.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's extensions,
// manifests, verifications and lifecycle events are indistinguishable
// from missing ones — no existence leak.
//
// Dependency posture: this module imports ONLY src/infra ports and the
// actions module's contract (the DAG's declared W009 → W025 edge) for
// the lifecycle authority gate. The kind 'extension-deployment' is one
// of the actions module's CANONICAL_ACTION_KINDS (§20's enumeration) —
// this module is where it gets used.
// ============================================================================

export {
  checkManifestCompatibility,
  getExtension,
  getManifest,
  getManifestVerification,
  listExtensionLifecycleEvents,
  listExtensions,
  listManifests,
  listManifestVerifications,
  registerExtensionManifest,
  runManifestVerification,
  transitionExtension,
} from './service';

export {
  EXTENSIONS_AUTHORITY_ADMINISTER,
  EXTENSION_ACTION_KIND,
  EXTENSION_AUTHORITY_LEVEL,
} from './service';

// W026 — General-Purpose Extension Runtime: deployment/rollback and
// every capability operation.
export {
  deployExtensionVersion,
  dispatchExtensionEvent,
  emitExtensionTelemetry,
  executeExtensionExternalCall,
  getCurrentDeployment,
  getExtensionUi,
  listExtensionDeployments,
  listExtensionEventDeliveries,
  listExtensionExternalCalls,
  listExtensionScheduleRuns,
  listExtensionTelemetryEvents,
  publishExtensionUi,
  readExtensionState,
  rollbackExtensionDeployment,
  triggerExtensionSchedule,
  writeExtensionState,
} from './service';

export { ExtensionsError } from './errors';
export type { ExtensionsErrorCode } from './errors';

// Pure vocabularies and state machines (usable without a database).
export {
  EXTENSION_LIFECYCLE_STATES,
  EXTENSION_TRANSITIONS,
  canTransitionExtension,
  isExtensionLifecycleState,
  isExtensionTransition,
  targetLifecycleState,
} from './lifecycle';

export {
  EXTENSION_PERMISSIONS,
  EXTENSION_STATE_SCOPES,
  EXTENSION_UI_SURFACES,
  capabilityDeclarationProblems,
  capabilityPermissionProblems,
  capabilityQuotaProblems,
  isEventTopic,
  isExtensionPermission,
  isExtensionStateScope,
  isExtensionUiSurface,
  isHttpsOrigin,
  isNameSlug,
  isValidCronExpression,
  requiredPermissionsForCapabilities,
} from './manifest-rules';

export {
  MAX_EVENT_TOPICS,
  MAX_EXTERNAL_CALLS_PER_DAY,
  MAX_EXTERNAL_PARTICIPANTS,
  MAX_SCHEDULES,
  MAX_SCHEDULE_INVOCATIONS_PER_DAY,
  MAX_STATE_BYTES,
} from './manifest-rules';

export {
  compareSemver,
  formatSemver,
  isSemver,
  parseSemver,
} from './semver';
export { checkHostRuntimeCompatibility } from './semver';

// W026 — the runtime's pure vocabularies, bounds and rule sets (usable
// without a database; the same rules validation and the service run,
// and the ones W027/W028 will reuse for builder verification and
// marketplace review).
export {
  DEFAULT_INSTALL_KEY,
  EXTENSION_HTTP_METHODS,
  EXTENSION_RUNTIME_HOST_PARTS,
  EXTENSION_RUNTIME_HOST_VERSION,
  EXTENSION_UI_BLOCK_TYPES,
  EXTERNAL_PATH_PATTERN,
  INSTALL_KEY_PATTERN,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EXTERNAL_BODY_BYTES,
  MAX_EXTERNAL_HEADER_COUNT,
  MAX_EXTERNAL_HEADER_NAME_CHARS,
  MAX_EXTERNAL_HEADER_VALUE_CHARS,
  MAX_EXTERNAL_PATH_CHARS,
  MAX_STATE_VALUE_BYTES,
  MAX_TELEMETRY_PAYLOAD_BYTES,
  MAX_UI_BLOCKS,
  MAX_UI_LIST_ITEMS,
  MAX_UI_TABLE_COLUMNS,
  MAX_UI_TABLE_ROWS,
  MAX_UI_TEXT_CHARS,
  STATE_KEY_PATTERN,
  TELEMETRY_NAME_PATTERN,
  byteLength,
  isExtensionHttpMethod,
  isExtensionUiBlockType,
  isExternalPath,
  isInstallKey,
  isStateKey,
  isTelemetryName,
  jsonByteLength,
  participantForOrigin,
  uiDocumentProblems,
  utcDayStart,
} from './runtime';

// The runtime's injectable egress port (scoped external participation).
export {
  EXTENSION_HTTP_TIMEOUT_MS,
  MAX_RESPONSE_BODY_CHARS,
  extensionHttpPort,
  setExtensionHttpPort,
} from './http';
export type { ExtensionHttpCall, ExtensionHttpResponse } from './http';
export type { ExtensionHttpPort } from './http';

export {
  EXTENSION_VERIFICATION_CHECKS,
  EXTENSION_VERIFICATION_STATES,
  MANIFEST_SCHEMA_VERSIONS,
  deriveVerificationState,
  isExtensionVerificationCheck,
  isExtensionVerificationState,
  isSupportedManifestSchemaVersion,
  runManifestVerificationChecks,
  summarizeVerificationRun,
  verificationOutcomeFor,
} from './verification';
export type { ManifestVerificationSubject } from './verification';

export {
  DEFAULT_LIST_LIMIT,
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_PARTICIPANT_LABEL_CHARS,
  isUuid,
} from './validation';

export type {
  ValidatedRegisterInput,
  ValidatedTransitionInput,
} from './validation';

export type {
  ValidatedDeployInput,
  ValidatedDeploymentQuery,
  ValidatedRollbackInput,
} from './validation';

export type {
  CheckManifestCompatibilityQuery,
  CompatibilityReport,
  DeployExtensionVersionInput,
  DeployExtensionVersionResult,
  DeploymentQuery,
  DispatchExtensionEventInput,
  DispatchExtensionEventResult,
  EmitExtensionTelemetryInput,
  ExecuteExtensionExternalCallInput,
  Extension,
  ExtensionCapabilities,
  ExtensionDeployment,
  ExtensionDeploymentOperation,
  ExtensionEventDelivery,
  ExtensionExternalCall,
  ExtensionExternalParticipant,
  ExtensionLifecycleEvent,
  ExtensionLifecycleState,
  ExtensionManifest,
  ExtensionManifestSummary,
  ExtensionManifestVerification,
  ExtensionManifestWithVerification,
  ExtensionPermission,
  ExtensionQuotas,
  ExtensionScheduleDeclaration,
  ExtensionScheduleRun,
  ExtensionStateEntry,
  ExtensionStateScope,
  ExtensionTelemetryEvent,
  ExtensionTransition,
  ExtensionUiBlock,
  ExtensionUiDeclaration,
  ExtensionUiDocument,
  ExtensionUiSurface,
  ExtensionVerificationCheckResult,
  ExtensionVerificationRunOutcome,
  ExtensionVerificationState,
  GetExtensionQuery,
  GetExtensionUiQuery,
  GetManifestQuery,
  ListExtensionDeploymentsQuery,
  ListExtensionEventDeliveriesQuery,
  ListExtensionExternalCallsQuery,
  ListExtensionLifecycleEventsQuery,
  ListExtensionScheduleRunsQuery,
  ListExtensionTelemetryEventsQuery,
  ListExtensionsQuery,
  ListManifestsQuery,
  ListManifestVerificationsQuery,
  ManifestSchemaVersion,
  ManifestVerificationInfo,
  PublishExtensionUiInput,
  ReadExtensionStateQuery,
  RegisterExtensionManifestInput,
  RegisterExtensionManifestResult,
  RollbackExtensionDeploymentInput,
  RollbackExtensionDeploymentResult,
  RunManifestVerificationQuery,
  RunManifestVerificationResult,
  SemverParts,
  TransitionExtensionInput,
  TransitionExtensionResult,
  TriggerExtensionScheduleInput,
  WriteExtensionStateInput,
} from './types';
