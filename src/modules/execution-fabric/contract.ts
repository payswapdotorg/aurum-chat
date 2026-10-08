// ============================================================================
// execution-fabric — the ONLY public surface of the execution-fabric
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W137 — Execution Environment / Agent Computer Fabric (spec/work-items/
// WORK-ITEM-CATALOG.md §W137):
// "Implement interchangeable isolated workspace/browser/computer adapters.
//  Evaluate local container, Playwright/Chromium and E2B/equivalent remote
//  sandbox paths."
// Acceptance: "isolation, persistence where required, artifact handoff,
//  takeover, cancellation, recovery and evidence are tested; vendor
//  removal does not change domain contracts."
//
//   The vendor-neutral definitions:
//   registerEnvironmentDefinition — append ONE immutable definition (the
//      frozen W131 kind + isolation + persistence + the required
//      capability domains; a changed definition is a NEW definition
//      under a NEW key — content immutable from creation);
//   retireEnvironmentDefinition — the one-way active → retired close
//      (existing leases continue; new acquisitions refuse).
//
//   The lease lifecycle (the fabric's state machine — validation.ts's
//   fabricLeaseTransitionProblem is THE single legality definition,
//   mirrored by the storage guard):
//   acquireFabricLease — bind ONE environment definition to ONE
//      agent-exchange execution run (W136): the definition must be
//      active, the plan readable and ACTIVE, the run recorded on the
//      plan (all gated on the base connection BEFORE the mutation — the
//      W134 law), and a REGISTERED adapter must serve the definition's
//      kind with every required capability domain declared supported
//      (the honest-descriptor law: supported:false refuses explicitly,
//      success is never fabricated);
//   prepareFabricLease — the adapter opens the disposable session
//      (adapter I/O outside every transaction; a vendor failure stamps
//      the lease 'failed' with the actionable detail, then refuses
//      typed);
//   takeoverFabricLease / handbackFabricLease — the W131 'Take control'
//      cycle: a HUMAN holds control (holder 'human', reason retained,
//      optional opaque W009 authorityActionRef); control returns by
//      EXPLICIT HAND-BACK ONLY;
//   heartbeatFabricLease — the live lease renews its window;
//   markFabricLeaseLost — lease death parks the lease 'lost' (NOT
//      terminal — the run record survives, the disposable session does
//      not);
//   recoverFabricLease — a FRESH session from the checkpoint (covered
//      work is never re-executed; a durable-checkpoint lease without a
//      recorded checkpoint refuses — persistence where required);
//   cancelFabricLease — fabric-executed cancellation (no cooperative
//      window: the terminal state commits first, the vendor session is
//      closed best-effort after);
//   releaseFabricLease — the clean terminal close (a human-held lease
//      refuses — explicit hand-back first, or cancel);
//   failFabricLease — the explicit vendor-failure report (actionable
//      detail retained).
//
//   The append-only evidence tails (§24):
//   recordArtifactHandoff — one artifact handed across the environment
//      boundary by OPAQUE reference (+ optional digest);
//   recordLeaseEvidence — one captured observation (frozen W131 capture
//      vocabulary, verification state, redaction applied by law);
//   recordLeaseCheckpoint — one durable checkpoint cut by the driving
//      worker (opaque cursor + covered evidence refs — replay never
//      re-executes covered work);
//   the four list reads (events, artifacts, evidence, checkpoints) and
//   the definition/lease reads.
//
//   The adapter wiring (in-memory, NEVER domain state):
//   registerExecutionAdapter — probe-at-registration (the completed
//      handshake), re-registration replaces with a fresh generation;
//   unregisterExecutionAdapter — THE VENDOR-REMOVAL OPERATION: reads of
//      served leases still work; prepare/recover refuse
//      adapter_not_registered; the domain contracts did not change;
//   listRegisteredAdapters — the discovery view (vendor identity is
//      METADATA on the descriptor — the only place it is visible);
//   the three evaluated catalog paths behind the frozen shape:
//   createLocalContainerAdapter (path a — deterministic simulation,
//   'workspace'), createBrowserEnvironmentAdapter (path b — the
//   W093/W110 BrowserDriver port, 'browser'), createRemoteSandboxAdapter
//   (path c — the E2B-equivalent remote path behind an injectable
//   transport, 'remote-sandbox').
//
// NO SECOND EXECUTION AUTHORITY (structural): nothing on this surface
// submits, dispatches, pumps or cancels an agents-module execution,
// never drives a browser step plan (computer-use owns governed browser
// automation — the browser adapter only COMPOSES its driver port) and
// never decides an approval (the W009 actions matrix decides; the
// takeover's authorityActionRef is an opaque reference, never a
// decision). The frozen 'local' kind stays legal for in-process fixture
// environments; no adapter in this delivery serves it yet.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's definitions,
// leases, events, artifacts, evidence or checkpoints are
// indistinguishable from missing — no existence leak.
// ============================================================================

export {
  // The vendor-neutral definitions
  registerEnvironmentDefinition,
  retireEnvironmentDefinition,
  // The lease lifecycle
  acquireFabricLease,
  prepareFabricLease,
  takeoverFabricLease,
  handbackFabricLease,
  heartbeatFabricLease,
  markFabricLeaseLost,
  recoverFabricLease,
  cancelFabricLease,
  releaseFabricLease,
  failFabricLease,
  // The append-only evidence tails
  recordArtifactHandoff,
  recordLeaseEvidence,
  recordLeaseCheckpoint,
  // Reads
  getEnvironmentDefinition,
  listEnvironmentDefinitions,
  getFabricLease,
  listFabricLeases,
  listLeaseEvents,
  listArtifactHandoffs,
  listLeaseEvidence,
  listLeaseCheckpoints,
  // The adapter wiring (in-memory, never domain state)
  registerExecutionAdapter,
  unregisterExecutionAdapter,
  listRegisteredAdapters,
} from './service';

export { ExecutionFabricError } from './errors';
export type { ExecutionFabricErrorCode } from './errors';

// Guards + vocabularies + limits (pure; unit-testable without a database).
export {
  DEFAULT_LEASE_MINUTES,
  DEFAULT_LIST_LIMIT,
  FABRIC_ARTIFACT_DIRECTIONS,
  FABRIC_CAPABILITY_DOMAINS,
  FABRIC_CHECKPOINT_LEVELS,
  FABRIC_ENVIRONMENT_KINDS,
  FABRIC_EVIDENCE_VERIFICATIONS,
  FABRIC_LEASE_ARTIFACT_SERVABLE_STATUSES,
  FABRIC_LEASE_CANCELLABLE_STATUSES,
  FABRIC_LEASE_CHECKPOINT_SERVABLE_STATUSES,
  FABRIC_LEASE_EVIDENCE_SERVABLE_STATUSES,
  FABRIC_LEASE_LOSABLE_STATUSES,
  FABRIC_LEASE_RECOVERABLE_STATUSES,
  FABRIC_LEASE_RELEASABLE_STATUSES,
  FABRIC_LEASE_STATUSES,
  FABRIC_LEASE_TERMINAL_STATUSES,
  FABRIC_NETWORK_EGRESS,
  FABRIC_PROFILE_SCOPES,
  MAX_ARTIFACT_KIND_CHARS,
  MAX_ARTIFACT_REF_CHARS,
  MAX_COVERED_EVIDENCE_REFS,
  MAX_CREDENTIAL_REF_CHARS,
  MAX_CURSOR_CHARS,
  MAX_DEF_KEY_CHARS,
  MAX_DETAIL_CHARS,
  MAX_DIGEST_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_EVIDENCE_REF_CHARS,
  MAX_LEASE_MINUTES,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_PERSISTENT_SCOPE_CHARS,
  MAX_REASON_CHARS,
  MIN_LEASE_MINUTES,
  assertExecutionFabricTenantContext,
  fabricLeaseTransitionProblem,
  isFabricArtifactDirection,
  isFabricCapabilityDomain,
  isFabricCaptureKind,
  isFabricCheckpointLevel,
  isFabricEnvironmentKind,
  isFabricEvidenceVerification,
  isFabricLeaseEventKind,
  isFabricLeaseStatus,
  isFabricNetworkEgress,
  isFabricProfileScope,
  isTerminalFabricLeaseStatus,
  isUuid,
  validateAcquireFabricLeaseInput,
  validateCancelFabricLeaseInput,
  validateFailFabricLeaseInput,
  validateGetEnvironmentDefinitionQuery,
  validateGetFabricLeaseQuery,
  validateHandbackFabricLeaseInput,
  validateListArtifactHandoffsQuery,
  validateListEnvironmentDefinitionsQuery,
  validateListFabricLeasesQuery,
  validateListLeaseCheckpointsQuery,
  validateListLeaseEventsQuery,
  validateListLeaseEvidenceQuery,
  validateMarkFabricLeaseLostInput,
  validateRecordArtifactHandoffInput,
  validateRecordLeaseCheckpointInput,
  validateRecordLeaseEvidenceInput,
  validateRegisterEnvironmentDefinitionInput,
  validateReleaseFabricLeaseInput,
  validateRetireEnvironmentDefinitionInput,
  validateTakeoverFabricLeaseInput,
} from './validation';
export type {
  ValidatedAcquireInput,
  ValidatedArtifactInput,
  ValidatedCheckpointInput,
  ValidatedDefinitionIdInput,
  ValidatedDetailInput,
  ValidatedEvidenceInput,
  ValidatedGetDefinitionQuery,
  ValidatedGetLeaseQuery,
  ValidatedHandbackInput,
  ValidatedListArtifactsQuery,
  ValidatedListDefinitionsQuery,
  ValidatedListEventsQuery,
  ValidatedListEvidenceQuery,
  ValidatedListLeasesQuery,
  ValidatedReasonInput,
  ValidatedRegisterDefinitionInput,
  ValidatedTakeoverInput,
} from './validation';

// The domain vocabularies (types.ts is their single home).
export type {
  AcquireFabricLeaseInput,
  ArtifactHandoffDirection,
  CancelFabricLeaseInput,
  EnvironmentDefinition,
  EnvironmentDefinitionStatus,
  FailFabricLeaseInput,
  FabricAdapter,
  FabricAdapterSessionRequest,
  FabricLease,
  FabricLeaseEvent,
  FabricLeaseEventKind,
  FabricLeaseStatus,
  FabricLeaseTransition,
  GetEnvironmentDefinitionQuery,
  GetFabricLeaseQuery,
  HandbackFabricLeaseInput,
  HeartbeatFabricLeaseInput,
  LeaseArtifactHandoff,
  LeaseCheckpoint,
  LeaseEvidenceRecord,
  ListArtifactHandoffsQuery,
  ListEnvironmentDefinitionsQuery,
  ListFabricLeasesQuery,
  ListLeaseCheckpointsQuery,
  ListLeaseEventsQuery,
  ListLeaseEvidenceQuery,
  MarkFabricLeaseLostInput,
  PrepareFabricLeaseInput,
  RecordArtifactHandoffInput,
  RecordLeaseCheckpointInput,
  RecordLeaseEvidenceInput,
  RegisteredAdapterView,
  RegisterEnvironmentDefinitionInput,
  ReleaseFabricLeaseInput,
  RetireEnvironmentDefinitionInput,
  TakeoverFabricLeaseInput,
} from './types';

// The three evaluated catalog paths behind the frozen W131 shape.
// Adapters are wiring artifacts, not domain records: a tenant registers
// them through the wiring seam and the fabric resolves them at
// acquisition by KIND + capability declaration only — vendor identity is
// metadata on the descriptor (the W131 law).
export { createLocalContainerAdapter } from './adapters/local-container';
export type {
  LocalContainerAdapter,
  LocalContainerAdapterOptions,
  LocalContainerAdapterState,
  LocalSimSessionRecord,
} from './adapters/local-container';

export { createBrowserEnvironmentAdapter } from './adapters/browser-adapter';
export type {
  BrowserAdapterState,
  BrowserEnvironmentAdapter,
  BrowserEnvironmentAdapterOptions,
} from './adapters/browser-adapter';

export {
  createFakeRemoteSandboxTransport,
  createRemoteSandboxAdapter,
  fetchRemoteSandboxTransport,
  RemoteSandboxHttpError,
} from './adapters/remote-sandbox';
export type {
  RemoteSandboxAdapter,
  RemoteSandboxAdapterOptions,
  RemoteSandboxAdapterState,
  RemoteSandboxRecord,
  RemoteSandboxTransport,
} from './adapters/remote-sandbox';

// The frozen cross-module vocabularies this surface speaks, re-exported
// TYPE-ONLY through their owning contracts (the single legal
// cross-module imports, enforced by the architecture gate) so consumers
// never need to know where each union was frozen.
export type {
  ExecutionAdapter,
  ExecutionAdapterCapability,
  ExecutionAdapterCapabilityDomain,
  ExecutionAdapterHealth,
  ExecutionAdapterVendorMetadata,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentKind,
  ExecutionEnvironmentSession,
  ExecutionSessionOpenRequest,
  SessionArtifactHandoff,
  SessionIsolationProperties,
  SessionPersistenceGuarantees,
} from '@/modules/execution/contract';
