// ============================================================================
// execution — W131 frozen contract vocabulary (TYPES ONLY; no runtime
// logic, no migrations, no service — this file is the stable interface
// W135/W137/W139 build against).
//
// TL-frozen contract surface, additive-only, semantic changes require TL
// integration approval.
//
// W131 — Execution Platform and Cross-Platform Architecture Study
// (spec/EXECUTION-PLATFORM-CONTRACTS-2026-10-04.md is the study record;
// this file is the frozen vocabulary it delivers). The patterns of
// ZCode, OpenMuse, Meta Muse, Epoch and Flauz are converted here into
// AURUM-OWNED contracts. Nothing is copied from any reference; external
// projects are DESIGN REFERENCES ONLY (study record law 4) and no
// execution vendor is an architectural authority (law 4 + lock 24/30
// applied to execution environments).
//
// THE ONE LAW THIS MODULE BAKES INTO ITS TYPES:
//   an execution environment is an ADAPTER, never an authority.
//   Vendor identity is METADATA (ExecutionAdapterVendorMetadata), never
//   a type-system citizen — there is no 'e2b' type, no 'playwright'
//   type, no 'docker' type anywhere in this file, and adding one is a
//   semantic change requiring TL approval. Capabilities are declared
//   (ExecutionAdapterCapability); permission is NOT — consequential
//   authority stays in the existing actions module (W009 matrix), which
//   these contracts reference ONLY by opaque id (ConsequentialAction-
//   Boundary.authorityActionRef) and never duplicate.
//
// Self-containment (deliberate): this file imports NOTHING. It composes
// with computer-use (W093/W110), environment (W014), agents (W021),
// marketplace (W028), workflow (W080), realtime (W086) and extensions by
// CONTRACT-LEVEL ALIGNMENT and opaque references — the house precedent
// ("the port's shapes are deliberately aligned at the CONTRACT LEVEL …
// no edge internals are imported here"). The alignment points are
// recorded in the study record and in JSDoc at each site.
// ============================================================================

// ---------------------------------------------------------------------------
// Group 1 — the ExecutionEnvironment adapter contract
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of execution environment KINDS (capability level,
 * vendor-neutral). 'local' is an in-process/fixture environment; 'browser'
 * is a governed browser session substrate; 'workspace' is a persistent
 * file/command workspace (container or equivalent); 'remote-sandbox' is a
 * remotely provisioned isolated machine. Concrete vendors (E2B, Playwright,
 * Docker, a local fixture double) are ADAPTERS behind these kinds — vendor
 * identity lives in ExecutionAdapterVendorMetadata and nowhere else.
 */
export type ExecutionEnvironmentKind = 'local' | 'browser' | 'workspace' | 'remote-sandbox';

/** Frozen source of truth for {@link ExecutionEnvironmentKind}. */
export const EXECUTION_ENVIRONMENT_KINDS: readonly ExecutionEnvironmentKind[] = [
  'local',
  'browser',
  'workspace',
  'remote-sandbox',
] as const;

/**
 * What an adapter declares it CAN do. A capability is a DECLARATION the
 * fabric (W137) verifies; it is never a permission — what MAY be done is
 * decided by the actions authority (W009) and tenant policy, never by an
 * environment.
 */
export type ExecutionAdapterCapabilityDomain =
  | 'filesystem'
  | 'commands'
  | 'network-egress'
  | 'display'
  | 'browser-profile'
  | 'artifact-store'
  | 'session-persistence'
  | 'checkpoint'
  | 'observation-capture';

/** Frozen source of truth for {@link ExecutionAdapterCapabilityDomain}. */
export const EXECUTION_ADAPTER_CAPABILITY_DOMAINS: readonly ExecutionAdapterCapabilityDomain[] =
  [
    'filesystem',
    'commands',
    'network-egress',
    'display',
    'browser-profile',
    'artifact-store',
    'session-persistence',
    'checkpoint',
    'observation-capture',
  ] as const;

/** One declared capability of one adapter (a declaration, never a permission). */
export interface ExecutionAdapterCapability {
  domain: ExecutionAdapterCapabilityDomain;
  /** False lets the fabric fail explicitly instead of guessing (the `driver_unavailable` discipline). */
  supported: boolean;
  /** Declared limits (e.g. max session minutes, egress policy name, output cap) — non-sensitive strings. */
  limits?: Record<string, string>;
}

/**
 * Vendor identity as METADATA — the only place a vendor name may appear.
 * Non-sensitive strings only; no credential, token or secret value may
 * ever appear here (the discovery-metadata discipline: credentials never
 * ride along with capability discovery).
 */
export interface ExecutionAdapterVendorMetadata {
  vendorName: string;
  vendorProduct?: string;
  vendorAdapterVersion?: string;
}

/** Adapter availability as observed by the fabric — never a permission. */
export type ExecutionAdapterHealth = 'available' | 'degraded' | 'unavailable' | 'unconfigured';

/** Frozen source of truth for {@link ExecutionAdapterHealth}. */
export const EXECUTION_ADAPTER_HEALTH_STATES: readonly ExecutionAdapterHealth[] = [
  'available',
  'degraded',
  'unavailable',
  'unconfigured',
] as const;

/**
 * The adapter-instance descriptor: what the environment IS and CAN DO.
 * Descriptors are honest — an adapter that cannot serve a capability
 * declares `supported: false` and the fabric surfaces that, rather than
 * fabricating success.
 */
export interface ExecutionEnvironmentDescriptor {
  /** Opaque adapter instance id (stable while the instance serves). */
  adapterId: string;
  kind: ExecutionEnvironmentKind;
  displayName: string;
  /** Vendor identity — metadata only; never a type-system citizen (see module law). */
  vendor: ExecutionAdapterVendorMetadata;
  capabilities: ExecutionAdapterCapability[];
  health: ExecutionAdapterHealth;
}

/**
 * Isolation properties of one session. `tenantIsolated` is the literal
 * `true`: a session that is not tenant-isolated is INEXPRESSIBLE in these
 * types (lock 3 — every business datum is tenant-scoped; ADR-0001).
 */
export interface SessionIsolationProperties {
  tenantIsolated: true;
  /** Profile scope of the disposable state (the W093 per-(tenant,task) profile discipline). */
  profileScope: 'session' | 'task' | 'environment';
  networkEgress: 'disabled' | 'restricted' | 'open';
  /** Literal: sessions are created from OPAQUE credential references only. */
  credentialHandling: 'opaque-ref-only';
}

/** What survives across a session's death, declared per environment. */
export interface SessionPersistenceGuarantees {
  /** True when disposable session state survives restart (e.g. a persistent workspace path). */
  survivesRestart: boolean;
  /**
   * The durable-truth level: 'none' (session is wholly disposable),
   * 'session' (state restore), 'durable-checkpoint' (the run record is
   * the resume truth — the W093 discipline).
   */
  checkpoint: 'none' | 'session' | 'durable-checkpoint';
  /** Declared persistent scope (e.g. '/workspace') when one exists. */
  persistentScope?: string;
}

/** One artifact handed across the environment boundary — always by opaque reference, never an embedded payload. */
export interface SessionArtifactHandoff {
  artifactRef: string;
  direction: 'in' | 'out';
  artifactKind: string;
  /** Content digest when the fabric verifies handoff integrity (tamper-evident, never authority). */
  digest?: string;
}

/** Session lifecycle phases (aligned at the contract level with realtime session statuses). */
export type ExecutionEnvironmentSessionPhase =
  | 'requested'
  | 'provisioning'
  | 'live'
  | 'suspended'
  | 'ending'
  | 'ended'
  | 'failed';

/** Frozen source of truth for {@link ExecutionEnvironmentSessionPhase}. */
export const EXECUTION_ENVIRONMENT_SESSION_PHASES: readonly ExecutionEnvironmentSessionPhase[] = [
  'requested',
  'provisioning',
  'live',
  'suspended',
  'ending',
  'ended',
  'failed',
] as const;

/**
 * One disposable execution environment session. Sessions are DISPOSABLE;
 * the durable truth lives in the task/worker records (Group 2) and the
 * authoritative domain state — never in a session.
 */
export interface ExecutionEnvironmentSession {
  /** Opaque session id. */
  sessionId: string;
  /** The adapter instance that serves this session (opaque). */
  adapterId: string;
  phase: ExecutionEnvironmentSessionPhase;
  openedAt: string;
  endedAt?: string;
  isolation: SessionIsolationProperties;
  persistence: SessionPersistenceGuarantees;
  artifacts: SessionArtifactHandoff[];
}

/**
 * THE ADAPTER CAPABILITY-SHAPE — the interface the W137 fabric implements
 * per environment kind. TYPES ONLY: these are the frozen signatures; the
 * fabric owns all runtime behavior. The adapter answers what it CAN do
 * (probe/open/resume/close); it never decides what MAY be done —
 * authority stays in the actions module, referenced by opaque id.
 */
export interface ExecutionAdapter {
  readonly adapterId: string;
  readonly kind: ExecutionEnvironmentKind;
  /** Report the honest current descriptor (health included). */
  probe(): Promise<ExecutionEnvironmentDescriptor>;
  /** Open one disposable session under the declared isolation. */
  open(request: ExecutionSessionOpenRequest): Promise<ExecutionEnvironmentSession>;
  /**
   * Resume from durable state — a FRESH session from the checkpoint;
   * covered work is never re-executed (the W093 resume discipline).
   */
  resume(checkpointRef: string): Promise<ExecutionEnvironmentSession>;
  /** End the session (disposable by construction). */
  close(sessionId: string, reason: string): Promise<ExecutionEnvironmentSession>;
}

/** The request shape for opening a session (opaque credential ref only). */
export interface ExecutionSessionOpenRequest {
  tenantId: string;
  environmentKind: ExecutionEnvironmentKind;
  /** Opaque reference into the secret store — a VALUE here is a contract violation. */
  credentialRef?: string;
  profileScope: SessionIsolationProperties['profileScope'];
}

// ---------------------------------------------------------------------------
// Group 2 — the TaskWorker durability contract
// ---------------------------------------------------------------------------

/**
 * The closed status vocabulary of a durable worker run. Cancellation and
 * recovery are first-class: 'cancelling' (requested, not yet finalized),
 * 'cancelled' (terminal), 'lost' (the lease died — the run is durably
 * parked awaiting recovery, NOT terminal), 'recovering' (a worker is
 * replaying from the checkpoint), 'suspended' (parked — human pause,
 * takeover, or an approval gate).
 */
export type TaskWorkerRunStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'awaiting_approval'
  | 'cancelling'
  | 'recovering'
  | 'lost'
  | 'cancelled'
  | 'succeeded'
  | 'failed';

/** Frozen source of truth for {@link TaskWorkerRunStatus}. */
export const TASK_WORKER_RUN_STATUSES: readonly TaskWorkerRunStatus[] = [
  'queued',
  'running',
  'suspended',
  'awaiting_approval',
  'cancelling',
  'recovering',
  'lost',
  'cancelled',
  'succeeded',
  'failed',
] as const;

/** The terminal subset — no transition leaves these. */
export const TASK_WORKER_RUN_TERMINAL_STATUSES: readonly TaskWorkerRunStatus[] = [
  'cancelled',
  'succeeded',
  'failed',
] as const;

/** The subset a cancellation request may legally start from. */
export const TASK_WORKER_RUN_CANCELLABLE_STATUSES: readonly TaskWorkerRunStatus[] = [
  'queued',
  'running',
  'suspended',
  'awaiting_approval',
] as const;

/** The recoverable subset — 'lost' runs are parked, never dead. */
export const TASK_WORKER_RUN_RECOVERABLE_STATUSES: readonly TaskWorkerRunStatus[] = [
  'lost',
] as const;

/**
 * The lease that makes a worker claim durable and detectable. A claim
 * whose lease expires is a 'lost' run — the run record survives the
 * worker's death (lock 36: long-running execution is asynchronous,
 * resumable and traceable).
 */
export interface TaskWorkerLease {
  leaseId: string;
  leaseUntil: string;
  lastHeartbeatAt: string;
}

/**
 * A durable checkpoint. The cursor is OPAQUE to these contracts (each
 * run-kind owns its own cursor grammar); covered evidence refs are listed
 * so replay never re-executes covered work.
 */
export interface TaskWorkerCheckpoint {
  checkpointId: string;
  cursor: string;
  recordedAt: string;
  coveredEvidenceRefs: string[];
}

/** Takeover/resume semantics, baked into the types: covered work is never re-executed. */
export interface TaskWorkerResumeSemantics {
  resumeFrom: 'checkpoint';
  /** Literal: verified/covered work is never re-executed — its evidence already stands. */
  replay: 'never-reexecute-covered';
  /** A FRESH session/environment is minted on resume; sessions are disposable. */
  freshSession: true;
}

/**
 * A human takeover of a run. Takeover parks the run ('suspended'), never
 * destroys it: the human decides, the record stands, and resume is
 * explicit.
 */
export interface TaskWorkerTakeover {
  takenOverAt: string;
  /** Literal: a takeover is BY a human (the 'Take control' pattern, adopted). */
  holder: 'human';
  reason: string;
  /** The opaque id of the consequential-action record routed through the actions authority, when one exists. */
  authorityActionRef?: string;
}

/** A finalized cancellation (terminal). */
export interface TaskWorkerCancellation {
  requestedAt: string;
  finalizedAt: string;
  reason: string;
}

/** A completed recovery of a 'lost' run. */
export interface TaskWorkerRecovery {
  detectedAt: string;
  recoveredAt: string;
  recoveredFromCheckpointRef: string;
}

/**
 * A durable worker run: identity, environment reference, status and the
 * durability apparatus. The run is the DURABLE TRUTH; workers and sessions
 * are disposable (lock 35: PostgreSQL is authoritative).
 */
export interface TaskWorkerRun {
  /** Opaque run id. */
  runId: string;
  tenantId: string;
  /** What kind of run this is (opaque slug — owned by the commissioning module, not this one). */
  runKind: string;
  /** The environment serving this run (opaque session + adapter references). */
  environmentSessionRef: string;
  environmentAdapterRef: string;
  status: TaskWorkerRunStatus;
  createdAt: string;
  updatedAt: string;
  lease?: TaskWorkerLease;
  checkpoint?: TaskWorkerCheckpoint;
  takeover?: TaskWorkerTakeover;
  cancellation?: TaskWorkerCancellation;
  recovery?: TaskWorkerRecovery;
  /** Immutable evidence references (observations) — append-only. */
  evidenceRefs: string[];
  /** Artifact references handed off by the run — opaque, never embedded. */
  artifactRefs: string[];
  /** Correlation/causation identity (the §25 discipline). */
  correlationId: string;
  causationId?: string;
  /** How this run resumes — the frozen semantics above. */
  resumeSemantics: TaskWorkerResumeSemantics;
}

/** The kinds of append-only worker events (a discriminated union on `kind`). */
export type TaskWorkerEventKind =
  | 'progress'
  | 'evidence'
  | 'artifact'
  | 'status'
  | 'takeover'
  | 'recovery'
  | 'cancellation';

/** Frozen source of truth for {@link TaskWorkerEventKind}. */
export const TASK_WORKER_EVENT_KINDS: readonly TaskWorkerEventKind[] = [
  'progress',
  'evidence',
  'artifact',
  'status',
  'takeover',
  'recovery',
  'cancellation',
] as const;

/** Shared event shape (events are APPEND-ONLY — no event is ever updated or erased). */
export interface TaskWorkerEventBase {
  eventId: string;
  runRef: string;
  at: string;
}

export interface TaskWorkerProgressEvent extends TaskWorkerEventBase {
  kind: 'progress';
  fraction?: number;
  note?: string;
}

export interface TaskWorkerEvidenceEvent extends TaskWorkerEventBase {
  kind: 'evidence';
  /** Opaque observation reference — never an embedded payload. */
  observationRef: string;
  evidenceKind: string;
}

export interface TaskWorkerArtifactEvent extends TaskWorkerEventBase {
  kind: 'artifact';
  artifactRef: string;
  artifactKind: string;
  digest?: string;
}

export interface TaskWorkerStatusEvent extends TaskWorkerEventBase {
  kind: 'status';
  from: TaskWorkerRunStatus;
  to: TaskWorkerRunStatus;
  reason?: string;
}

export interface TaskWorkerTakeoverEvent extends TaskWorkerEventBase {
  kind: 'takeover';
  holder: 'human';
  reason: string;
  authorityActionRef?: string;
}

export interface TaskWorkerRecoveryEvent extends TaskWorkerEventBase {
  kind: 'recovery';
  recoveredFromCheckpointRef: string;
}

export interface TaskWorkerCancellationEvent extends TaskWorkerEventBase {
  kind: 'cancellation';
  reason: string;
}

/** The append-only worker event union — narrows on `kind`. */
export type TaskWorkerEvent =
  | TaskWorkerProgressEvent
  | TaskWorkerEvidenceEvent
  | TaskWorkerArtifactEvent
  | TaskWorkerStatusEvent
  | TaskWorkerTakeoverEvent
  | TaskWorkerRecoveryEvent
  | TaskWorkerCancellationEvent;

// ---------------------------------------------------------------------------
// Group 3 — the Browser/Computer session control contract
// ---------------------------------------------------------------------------

/** Who holds control of a computer session at a moment. */
export type ComputerSessionControlMode = 'automation' | 'human' | 'automation-yielding';

/** Frozen source of truth for {@link ComputerSessionControlMode}. */
export const COMPUTER_SESSION_CONTROL_MODES: readonly ComputerSessionControlMode[] = [
  'automation',
  'human',
  'automation-yielding',
] as const;

/** Session phases for the browser/computer control surface (realtime-status aligned). */
export type ComputerSessionPhase =
  | 'requested'
  | 'provisioning'
  | 'live'
  | 'suspended'
  | 'ended'
  | 'failed';

/** Frozen source of truth for {@link ComputerSessionPhase}. */
export const COMPUTER_SESSION_PHASES: readonly ComputerSessionPhase[] = [
  'requested',
  'provisioning',
  'live',
  'suspended',
  'ended',
  'failed',
] as const;

/**
 * A human takeover point on a controlled session. Takeover is observed,
 * recorded and reversible; the human decides — the session automation
 * yields ('automation-yielding') and never resumes without an explicit
 * hand-back.
 */
export interface ComputerSessionTakeoverPoint {
  takeoverId: string;
  at: string;
  from: ComputerSessionControlMode;
  to: ComputerSessionControlMode;
  reason: string;
  /** How control returns: explicit hand-back only. */
  resumePolicy: 'explicit-handback-only';
}

/** What one observation capture recorded — always an OPAQUE artifact reference, redaction applied. */
export interface SessionObservationCapture {
  captureKind: 'screenshot' | 'action-trace' | 'dom-snapshot' | 'console';
  artifactRef: string;
  /** Literal: redaction is applied before storage (credentials never ride in observations). */
  redaction: 'applied';
  recordedAt: string;
}

/**
 * THE SAFETY/AUTHORITY BOUNDARY of a controlled session. The two literals
 * make the rule inexpressible to bypass: consequential actions ALWAYS
 * route through the existing actions authority (the W009 matrix via the
 * action gateway) — this contract references that routing by OPAQUE ID
 * and never duplicates the authority. A session adapter that executes a
 * consequential action locally violates this frozen contract.
 */
export interface ConsequentialActionBoundary {
  /** Literal `true`: cannot be weakened to false without TL integration approval. */
  requiresActionGateway: true;
  /** Literal: session-local execution of consequential actions is never allowed. */
  sessionLocalExecution: 'never-for-consequential';
  /**
   * The opaque id of the consequential-action record routed through the
   * actions authority — referenced, never duplicated (the module law).
   */
  authorityActionRef?: string;
  /** The action kind slug as known to the actions module (opaque here). */
  actionKindRef?: string;
}

/**
 * The controlled browser/computer session contract: lifecycle, control
 * mode, takeover points, observation/evidence capture and the safety
 * boundary. Composes at the CONTRACT LEVEL with the computer-use module
 * (W093/W110): the receipt taxonomy ('accepted' | 'rejected' | 'failed')
 * and the observed-state shape ({found, state}) are aligned BY SHAPE, not
 * imported — no second evidence model, no fork.
 */
export interface ComputerSessionControlContract {
  sessionId: string;
  tenantId: string;
  phase: ComputerSessionPhase;
  controlMode: ComputerSessionControlMode;
  takeoverPoints: ComputerSessionTakeoverPoint[];
  observations: SessionObservationCapture[];
  boundary: ConsequentialActionBoundary;
  /** The execution environment serving this session (opaque refs — Group 1 composition). */
  environmentSessionRef: string;
  environmentAdapterRef: string;
}

// ---------------------------------------------------------------------------
// Group 4 — the shared client/runtime contract
// ---------------------------------------------------------------------------

/**
 * The closed platform vocabulary. Web is the CANONICAL client; Desktop
 * (Tauri 2) is the power client; Mobile (Expo/React Native) is the field
 * client. All three consume the SAME semantic contracts — server-side
 * state is authoritative, clients are projections (the frozen cross-
 * platform conclusion, adopted from the Epoch client topology).
 */
export type ClientPlatformKind = 'web' | 'desktop' | 'mobile';

/** Frozen source of truth for {@link ClientPlatformKind}. */
export const CLIENT_PLATFORM_KINDS: readonly ClientPlatformKind[] = [
  'web',
  'desktop',
  'mobile',
] as const;

/** The canonical platform (a frozen constant, not a policy knob). */
export const CANONICAL_CLIENT_PLATFORM: ClientPlatformKind = 'web';

/** Session states on the client side (a projection of an authentication result). */
export type ClientSessionState = 'active' | 'expired' | 'revoked';

/** Frozen source of truth for {@link ClientSessionState}. */
export const CLIENT_SESSION_STATES: readonly ClientSessionState[] = [
  'active',
  'expired',
  'revoked',
] as const;

/** The minimal session reference carried by every client/runtime call. */
export interface ClientSessionRef {
  sessionId: string;
  platform: ClientPlatformKind;
}

/** The shared client session projection (server-issued; never client-minted). */
export interface SharedClientSession {
  sessionId: string;
  tenantId: string;
  principalId: string;
  platform: ClientPlatformKind;
  issuedAt: string;
  expiresAt: string;
  state: ClientSessionState;
}

/**
 * A reference to server-authoritative company state, bound to the exact
 * revision and digest. Clients hold PROJECTIONS; a projection reference
 * is opaque, tenant-scoped and content-addressed — embedding the
 * underlying object is not expressible (there is no field for it).
 */
export interface CompanyStateProjectionRef {
  projectionKind: string;
  targetId: string;
  tenantId: string;
  revision: number;
  digest: string;
}

/** One realtime subscription shape a client holds (aligned with the realtime module's stream surfaces by shape). */
export interface ClientRealtimeSubscription {
  subscriptionId: string;
  /** Opaque topic kind owned by the realtime module (e.g. its session/kind vocabulary). */
  topicKind: string;
  filterRef?: string;
  lastSeenCursor?: string;
  state: 'live' | 'paused';
}

/** The connectivity/degradation states of a client runtime. */
export type ClientDegradationState = 'online' | 'degraded' | 'offline';

/** Frozen source of truth for {@link ClientDegradationState}. */
export const CLIENT_DEGRADATION_STATES: readonly ClientDegradationState[] = [
  'online',
  'degraded',
  'offline',
] as const;

/**
 * What a degraded/offline client may do — frozen. Cache reads are
 * allowed; queued intents are PENDING PROJECTIONS of user intent only;
 * authoritative state stays server-only. The five named negatives below
 * are the offline admission rules (adopted from the application-gateway
 * pattern; Aurum-owned vocabulary).
 */
export interface ClientDegradedBehavior {
  cacheReads: 'allowed';
  queuedIntents: 'projection-only';
  authoritativeState: 'server-only';
}

/**
 * The named offline admission negatives — typed so a client cannot
 * express the forbidden things: a local approval is never authority;
 * local semantic mutation is rejected; local identity minting is
 * rejected; local digest forgery is rejected; an idempotency key is
 * required for every queued intent.
 */
export type ClientOfflineAdmissionNegative =
  | 'local-approval-not-authority'
  | 'local-semantic-mutation-rejected'
  | 'local-identity-minting-rejected'
  | 'local-digest-forgery-rejected'
  | 'idempotency-key-required';

/** Frozen source of truth for {@link ClientOfflineAdmissionNegative}. */
export const CLIENT_OFFLINE_ADMISSION_NEGATIVES: readonly ClientOfflineAdmissionNegative[] = [
  'local-approval-not-authority',
  'local-semantic-mutation-rejected',
  'local-identity-minting-rejected',
  'local-digest-forgery-rejected',
  'idempotency-key-required',
] as const;

/** Lifecycle states of a queued offline intent. */
export type ClientQueuedIntentState = 'pending' | 'draining' | 'drained' | 'rejected';

/** Frozen source of truth for {@link ClientQueuedIntentState}. */
export const CLIENT_QUEUED_INTENT_STATES: readonly ClientQueuedIntentState[] = [
  'pending',
  'draining',
  'drained',
  'rejected',
] as const;

/**
 * One queued OFFLINE intent — a PENDING PROJECTION of a user intent,
 * never a local decision. It carries an idempotency key (replays never
 * double-apply) and replays through the server authority on resync.
 */
export interface ClientQueuedIntent {
  queueId: string;
  sessionId: string;
  tenantId: string;
  /** Literal: a queued intent is a projection of intent only — the server decides. */
  intentClass: 'pending-projection';
  idempotencyKey: string;
  operationRef: string;
  enqueuedAt: string;
  state: ClientQueuedIntentState;
  attempts: number;
  lastErrorCode?: string;
}

// ---------------------------------------------------------------------------
// Group 5 — the cross-device continuity contract
// ---------------------------------------------------------------------------

/** What a continuity anchor points at — units of ACTIVE work that move across devices. */
export type ContinuityAnchorKind = 'task-run' | 'session' | 'review' | 'approval';

/** Frozen source of truth for {@link ContinuityAnchorKind}. */
export const CONTINUITY_ANCHOR_KINDS: readonly ContinuityAnchorKind[] = [
  'task-run',
  'session',
  'review',
  'approval',
] as const;

/**
 * A unit of active work that can move across devices. The anchor carries
 * PROJECTION references (opaque ids + revisions) — never semantic
 * payload. The receiving device re-projects from server state.
 */
export interface ContinuityAnchor {
  anchorId: string;
  tenantId: string;
  anchorKind: ContinuityAnchorKind;
  /** Opaque reference to the underlying object (run id, session id, approval id…). */
  focusRef: string;
  /** Revision of the focus object the anchor last presented. */
  focusRevision: number;
  origin: ClientSessionRef;
  anchorRevision: number;
  lastActiveAt: string;
  /** Where the anchor is currently open (the cross-platform journey surface). */
  openOn: ClientPlatformKind;
}

/**
 * The handoff semantics, frozen as literals: the receiving device gets a
 * RE-PROJECTION from server state; NO authority transfers; the payload is
 * projection references only. A handoff that tried to carry authority or
 * semantic payload is inexpressible in these types.
 */
export interface ContinuityHandoffSemantics {
  reprojection: 'from-server-state';
  authorityTransfer: 'none';
  payload: 'projection-refs-only';
}

/** One recorded handoff of an anchor between devices. */
export interface ContinuityHandoff {
  handoffId: string;
  anchorRef: string;
  from: ClientSessionRef;
  to: ClientSessionRef;
  at: string;
  semantics: ContinuityHandoffSemantics;
}

/**
 * The conflict rule, frozen: server state wins. The resolution vocabulary
 * has exactly ONE member — a client creating competing semantic state is
 * not expressible here; a stale client projection is discarded on resync.
 */
export type ContinuityConflictResolution = 'server-state-wins';

/** One recorded continuity conflict (a stale client projection discarded on resync). */
export interface ContinuityConflict {
  conflictId: string;
  anchorRef: string;
  conflictKind: 'stale-client-projection';
  resolution: ContinuityConflictResolution;
  discardedClientRevision: number;
  resolvedAt: string;
}
