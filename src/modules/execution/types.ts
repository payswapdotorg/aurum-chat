// Public domain types of the execution module (W131 — Execution Platform
// and Cross-Platform Architecture Study).
//
// TL-frozen contract surface, additive-only, semantic changes require TL
// integration approval.
//
// This module is TYPES ONLY by work-order law: no service, no runtime
// logic, no migrations. The frozen contract vocabulary lives in
// ./contracts.ts (the stable interface W135/W137/W139 build against);
// this file follows the house module convention (types.ts as the
// module's domain-type home) by carrying the module identity surface and
// re-exporting the domain types so later work items extend this module
// without introducing a second convention.
//
// The frozen vocabulary composes with the existing modules by
// CONTRACT-LEVEL ALIGNMENT and opaque references only (the house
// precedent): computer-use (W093/W110 — browser/computer governance),
// environment (W014), agents (W021 — the agent gateway), marketplace
// (W028), workflow (W080 — the durable-run composition), realtime
// (W086) and extensions. Nothing here imports another module: there is
// no second authority model and no forked evidence model.

/** The version of this frozen contract surface (additive-only from here on). */
export const EXECUTION_CONTRACT_VERSION = '1.0.0';

/** The module's frozen scope, recorded in the type system for downstream surfaces. */
export type ExecutionContractScope =
  | 'execution-environment-adapter'
  | 'task-worker-durability'
  | 'computer-session-control'
  | 'shared-client-runtime'
  | 'cross-device-continuity';

/** Frozen source of truth for {@link ExecutionContractScope}. */
export const EXECUTION_CONTRACT_SCOPES: readonly ExecutionContractScope[] = [
  'execution-environment-adapter',
  'task-worker-durability',
  'computer-session-control',
  'shared-client-runtime',
  'cross-device-continuity',
] as const;

// The frozen domain type surface (Group 1–5 of the W131 study). The
// vocabulary constants ship with their types in ./contracts.ts and are
// re-exported here so `contract.ts` stays the single public surface.
export type {
  // Group 1 — the ExecutionEnvironment adapter contract
  ExecutionEnvironmentKind,
  ExecutionAdapterCapabilityDomain,
  ExecutionAdapterCapability,
  ExecutionAdapterVendorMetadata,
  ExecutionAdapterHealth,
  ExecutionEnvironmentDescriptor,
  SessionIsolationProperties,
  SessionPersistenceGuarantees,
  SessionArtifactHandoff,
  ExecutionEnvironmentSessionPhase,
  ExecutionEnvironmentSession,
  ExecutionAdapter,
  ExecutionSessionOpenRequest,
  // Group 2 — the TaskWorker durability contract
  TaskWorkerRunStatus,
  TaskWorkerLease,
  TaskWorkerCheckpoint,
  TaskWorkerResumeSemantics,
  TaskWorkerTakeover,
  TaskWorkerCancellation,
  TaskWorkerRecovery,
  TaskWorkerRun,
  TaskWorkerEventKind,
  TaskWorkerEventBase,
  TaskWorkerProgressEvent,
  TaskWorkerEvidenceEvent,
  TaskWorkerArtifactEvent,
  TaskWorkerStatusEvent,
  TaskWorkerTakeoverEvent,
  TaskWorkerRecoveryEvent,
  TaskWorkerCancellationEvent,
  TaskWorkerEvent,
  // Group 3 — the Browser/Computer session control contract
  ComputerSessionControlMode,
  ComputerSessionPhase,
  ComputerSessionTakeoverPoint,
  SessionObservationCapture,
  ConsequentialActionBoundary,
  ComputerSessionControlContract,
  // Group 4 — the shared client/runtime contract
  ClientPlatformKind,
  ClientSessionState,
  ClientSessionRef,
  SharedClientSession,
  CompanyStateProjectionRef,
  ClientRealtimeSubscription,
  ClientDegradationState,
  ClientDegradedBehavior,
  ClientOfflineAdmissionNegative,
  ClientQueuedIntentState,
  ClientQueuedIntent,
  // Group 5 — the cross-device continuity contract
  ContinuityAnchorKind,
  ContinuityAnchor,
  ContinuityHandoffSemantics,
  ContinuityHandoff,
  ContinuityConflictResolution,
  ContinuityConflict,
} from './contracts';
