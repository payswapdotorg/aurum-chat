// ============================================================================
// execution — the ONLY public surface of the execution module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// TL-frozen contract surface, additive-only, semantic changes require TL
// integration approval.
//
// W131 — Execution Platform and Cross-Platform Architecture Study
// (spec/EXECUTION-PLATFORM-CONTRACTS-2026-10-04.md): the frozen
// contract vocabulary for interchangeable execution environments,
// durable task workers, browser/computer sessions, the shared
// client/runtime surface and cross-device continuity. TYPES ONLY by
// work-order law — no service, no runtime logic, no migrations live in
// this module. Later work items (W137 execution fabric, W139
// cross-platform product, the W135 Lab's execution evaluation surface)
// build against this exact surface; it is their stable interface.
//
// THE LAW (frozen): an execution environment is an ADAPTER, never an
// authority. Vendor identity is metadata (ExecutionAdapterVendorMetadata)
// — never a type-system citizen. Consequential authority stays in the
// actions module (W009); these contracts reference it by opaque id
// (ConsequentialActionBoundary.authorityActionRef) and never duplicate
// it. Server-side state is authoritative; clients are projections.
// ============================================================================

export {
  // The module identity surface
  EXECUTION_CONTRACT_VERSION,
  EXECUTION_CONTRACT_SCOPES,
} from './types';

// The frozen vocabulary constants (Group 1–5). Constants are the frozen
// source of truth for every closed union in the contract surface — the
// house `types.ts` convention, exported through the contract only.
export {
  // Group 1
  EXECUTION_ENVIRONMENT_KINDS,
  EXECUTION_ADAPTER_CAPABILITY_DOMAINS,
  EXECUTION_ADAPTER_HEALTH_STATES,
  EXECUTION_ENVIRONMENT_SESSION_PHASES,
  // Group 2
  TASK_WORKER_RUN_STATUSES,
  TASK_WORKER_RUN_TERMINAL_STATUSES,
  TASK_WORKER_RUN_CANCELLABLE_STATUSES,
  TASK_WORKER_RUN_RECOVERABLE_STATUSES,
  TASK_WORKER_EVENT_KINDS,
  // Group 3
  COMPUTER_SESSION_CONTROL_MODES,
  COMPUTER_SESSION_PHASES,
  // Group 4
  CLIENT_PLATFORM_KINDS,
  CANONICAL_CLIENT_PLATFORM,
  CLIENT_SESSION_STATES,
  CLIENT_DEGRADATION_STATES,
  CLIENT_OFFLINE_ADMISSION_NEGATIVES,
  CLIENT_QUEUED_INTENT_STATES,
  // Group 5
  CONTINUITY_ANCHOR_KINDS,
} from './contracts';

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
  // The module scope surface
  ExecutionContractScope,
} from './types';
