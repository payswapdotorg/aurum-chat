// Public domain types of the execution-fabric module (W137 — Execution
// Environment / Agent Computer Fabric).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md §W137):
// "Implement interchangeable isolated workspace/browser/computer adapters.
//  Evaluate local container, Playwright/Chromium and E2B/equivalent remote
//  sandbox paths."
// Acceptance: "isolation, persistence where required, artifact handoff,
// takeover, cancellation, recovery and evidence are tested; vendor removal
// does not change domain contracts."
//
// WHAT THIS MODULE IS: the FABRIC that owns execution ENVIRONMENTS —
// vendor-neutral environment definitions, the lease/lifecycle state
// machine that binds an environment to an agent-exchange execution run
// (W136), and the adapter registry behind the W131 frozen
// ExecutionAdapter capability-shape. The catalog's three evaluated paths
// (local container, Playwright/Chromium, E2B/equivalent remote sandbox)
// are ADAPTERS behind the frozen kinds — the local container path serves
// the frozen 'workspace' kind (a container IS the canonical workspace:
// "a persistent file/command workspace (container or equivalent)"),
// the browser path serves 'browser', the remote sandbox path serves
// 'remote-sandbox'. The frozen 'local' kind remains legal for in-process
// fixture environments; no adapter in this delivery serves it yet.
//
// THE W131 LAW, inherited verbatim: an execution environment is an
// ADAPTER, never an authority. Vendor identity is METADATA
// (ExecutionAdapterVendorMetadata on the adapter's descriptor), never a
// type-system citizen — there is no 'e2b', 'playwright' or 'docker' type
// anywhere in this module's domain surface, and a vendor name may never
// appear in a definition, lease, event, artifact, evidence record or
// checkpoint (test-locked). Capabilities are DECLARATIONS the fabric
// verifies (an adapter that cannot serve a required domain declares
// supported:false and acquisition refuses explicitly — the honest-
// descriptor law); what MAY be done inside an environment is decided by
// the actions authority (W009) and tenant policy, never here.
// Consequential actions route through the action gateway by opaque id;
// this module references that routing only through the optional opaque
// authorityActionRef on a takeover, exactly as the frozen contracts do.
//
// WHAT THIS MODULE IS NOT: an execution authority. It never submits,
// dispatches, pumps or cancels agents-module executions (W021 owns
// execution), never drives a browser step plan itself (W093/W110
// computer-use owns governed browser automation — the fabric's browser
// adapter COMPOSES that module's BrowserDriver port as one vendor path
// behind the frozen shape) and never decides approvals (W009). It
// provides the isolated, leased, evidenced ENVIRONMENTS that execution
// runs execute in.
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's definitions, leases, events, artifacts, evidence or
// checkpoints are indistinguishable from missing (uniform not-found, no
// existence leak). Session isolation is STRUCTURAL: every isolation
// shape carries the literal tenantIsolated: true and credentials are
// created from OPAQUE references only (credentialHandling:
// 'opaque-ref-only') — a secret VALUE is inexpressible in these types.

import type {
  ExecutionAdapter,
  ExecutionAdapterCapabilityDomain,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentKind,
  ExecutionEnvironmentSession,
  ExecutionSessionOpenRequest,
  SessionIsolationProperties,
  SessionPersistenceGuarantees,
} from '@/modules/execution/contract';

// ---------------------------------------------------------------------------
// Vocabularies (fabric-owned; the frozen W131 vocabularies are consumed
// verbatim through the execution contract — see validation.ts for the
// compiler-pinned mirrors)
// ---------------------------------------------------------------------------

/**
 * The lease lifecycle (the fabric's own state machine, composed from the
 * two frozen vocabularies — the W131 session phases requested/
 * provisioning/live/suspended/ended/failed and the W131 worker-run
 * statuses lost/recovering — into the one machine the fabric owns):
 *
 *   acquire       → preparing   (the lease exists; the adapter session is
 *                               not yet provisioned)
 *   prepare       → live        (the adapter opened the disposable
 *                               session; the run lease is active)
 *   takeover      → suspended   (a HUMAN holds control — the W131
 *                               'Take control' pattern; resume by
 *                               explicit hand-back only)
 *   handback      → live        (the explicit hand-back)
 *   markLost      → lost        (lease death — the run record survives;
 *                               NOT terminal, parked for recovery)
 *   recover       → live        (a FRESH session from the checkpoint;
 *                               covered work is never re-executed)
 *   cancel        → cancelled   (terminal — the fabric closes the
 *                               session itself; lease cancellation is
 *                               fabric-executed, not cooperative)
 *   release       → released    (terminal — the clean close)
 *   fail          → failed      (terminal — the vendor path failed
 *                               permanently; actionable evidence retained)
 *
 * The frozen worker-run 'cancelling'/'recovering' intermediates belong to
 * the RUN side (W021/W140 own the cooperative cancellation window); the
 * fabric lease closes the ENVIRONMENT directly, so its cancellation has
 * no cooperative window and its recovery window is the recover operation
 * itself (a documented ruling — see WORK-NOTES).
 */
export type FabricLeaseStatus =
  | 'preparing'
  | 'live'
  | 'suspended'
  | 'lost'
  | 'released'
  | 'cancelled'
  | 'failed';

/** The lifecycle moves the fabric's operations perform (the transition names). */
export type FabricLeaseTransition =
  | 'prepare'
  | 'takeover'
  | 'handback'
  | 'markLost'
  | 'recover'
  | 'cancel'
  | 'release'
  | 'fail';

/** The lease event tail (append-only evidence — §24). */
export type FabricLeaseEventKind =
  | 'acquired'
  | 'prepared'
  | 'takeover'
  | 'handback'
  | 'loss'
  | 'recovery'
  | 'cancellation'
  | 'release'
  | 'failure'
  | 'artifact'
  | 'evidence'
  | 'checkpoint';

/** Direction of one artifact handed across the environment boundary. */
export type ArtifactHandoffDirection = 'in' | 'out';

/** The verification state of one captured evidence record (the W093 inherited discipline: observed state is verified before it is treated as a result). */
export type EvidenceVerification = 'unverified' | 'verified' | 'mismatched';

/** The definition lifecycle: one-way active → retired. */
export type EnvironmentDefinitionStatus = 'active' | 'retired';

// ---------------------------------------------------------------------------
// The adapter SPI (the frozen W131 capability-shape, consumed verbatim
// with ONE additive optional field — see FabricAdapterSessionRequest)
// ---------------------------------------------------------------------------

/**
 * The fabric's open-request: the frozen ExecutionSessionOpenRequest
 * VERBATIM plus the optional additive `subjectRef` — the fabric's opaque
 * lease id. The frozen request carries the isolation CLASS (tenant +
 * profile scope); task-scoped profiles (the W093 per-(tenant,task)
 * discipline) additionally need the SUBJECT the state is scoped to, and
 * the frozen shape has no field for it. `subjectRef` is additive and
 * optional: a vanilla frozen ExecutionAdapter that ignores it still
 * serves session- and environment-scoped definitions correctly.
 */
export interface FabricAdapterSessionRequest extends ExecutionSessionOpenRequest {
  /**
   * The fabric's subject reference (the acquiring lease's opaque id).
   * Adapters derive per-subject profile keys from it when the declared
   * scope is 'task'. Opaque to the frozen contracts.
   */
  subjectRef?: string;
}

/**
 * THE ADAPTER SPI — the frozen W131 ExecutionAdapter capability-shape
 * (probe/open/resume/close) with the additive optional subjectRef on the
 * open request. Every FabricAdapter IS an ExecutionAdapter (the extension
 * only widens what the adapter MAY read); the fabric verifies descriptors
 * honestly at acquisition (an adapter that cannot serve a required
 * capability domain refuses explicitly — never a fabricated success).
 */
export interface FabricAdapter extends ExecutionAdapter {
  open(request: FabricAdapterSessionRequest): Promise<ExecutionEnvironmentSession>;
}

// ---------------------------------------------------------------------------
// Environment definitions
// ---------------------------------------------------------------------------

/**
 * One vendor-neutral environment DEFINITION: what a tenant wants an
 * execution environment to BE — the frozen kind, the isolation
 * properties and the persistence policy — plus the capability domains
 * any serving adapter must declare supported. Content is IMMUTABLE from
 * creation (a changed definition is a NEW definition — the house law);
 * only the one-way active → retired lifecycle moves. Vendor identity
 * lives on the ADAPTER's descriptor (metadata), never here: two
 * adapters of the same kind serve the same definition interchangeably
 * (test-locked — the vendor-removal clause).
 */
export interface EnvironmentDefinition {
  id: string;
  tenantId: string;
  /** Unique within the tenant (slug grammar — deterministic referencing). */
  defKey: string;
  displayName: string;
  /** The frozen W131 environment kind. */
  kind: ExecutionEnvironmentKind;
  /** Isolation guarantees, frozen verbatim from the W131 contract shape. */
  isolation: SessionIsolationProperties;
  /** Persistence policy, frozen verbatim from the W131 contract shape. */
  persistence: SessionPersistenceGuarantees;
  /** Capability domains a serving adapter must declare supported (subset of the frozen domain set). */
  requiredCapabilities: ExecutionAdapterCapabilityDomain[];
  status: EnvironmentDefinitionStatus;
  note: string | null;
  createdBy: string;
  createdAt: string;
  retiredAt: string | null;
}

/** Input shape of `registerEnvironmentDefinition`. */
export interface RegisterEnvironmentDefinitionInput {
  defKey: string;
  displayName: string;
  kind: ExecutionEnvironmentKind;
  profileScope: SessionIsolationProperties['profileScope'];
  networkEgress: SessionIsolationProperties['networkEgress'];
  survivesRestart: boolean;
  checkpoint: SessionPersistenceGuarantees['checkpoint'];
  persistentScope?: string | null;
  requiredCapabilities?: ExecutionAdapterCapabilityDomain[];
  note?: string | null;
}

/** Input shape of `retireEnvironmentDefinition` (the one-way transition). */
export interface RetireEnvironmentDefinitionInput {
  definitionId: string;
}

// ---------------------------------------------------------------------------
// Fabric leases
// ---------------------------------------------------------------------------

/**
 * One fabric lease: an execution environment acquired for ONE
 * agent-exchange execution run (W136 — validated readable and
 * tenant-owned at acquisition), driven through the lifecycle state
 * machine, and evidenced by the append-only event/artifact/evidence/
 * checkpoint tails. The lease is the FABRIC's durable truth; the adapter
 * session is DISPOSABLE (a lost lease recovers into a FRESH session and
 * the covered-work law holds — W131's "sessions are disposable; runs are
 * the durable truth", applied to the lease).
 */
export interface FabricLease {
  id: string;
  tenantId: string;
  definitionId: string;
  /** The definition's defKey at read time (denormalized for display). */
  definitionKey: string;
  /** The definition's frozen kind at read time (denormalized for display). */
  definitionKind: ExecutionEnvironmentKind;
  /** The W136 execution plan the run belongs to (validated ACTIVE at acquisition). */
  planId: string;
  /** The W136 execution run this environment serves (validated readable at acquisition). */
  executionRunId: string;
  /** The run's task key, denormalized from the run at acquisition. */
  taskKey: string;
  /** The run's agent, denormalized from the run at acquisition. */
  agentId: string;
  status: FabricLeaseStatus;
  /** The resolved adapter's opaque instance id (the descriptor's adapterId), stamped at acquisition. */
  adapterId: string | null;
  /** The adapter-minted disposable session id (stamped at prepare; REPLACED by the fresh session at recover). */
  sessionId: string | null;
  /** The requested lease window in minutes (1..1440, default 60). */
  leaseMinutes: number;
  /** When the lease expires (live leases renew through heartbeats). */
  leaseUntil: string | null;
  lastHeartbeatAt: string | null;
  /** First liveness (the prepare transition); recoveries keep it. */
  openedAt: string | null;
  takenOverAt: string | null;
  /** 'human' while the takeover holds; cleared by the explicit hand-back (history lives in the event tail). */
  takeoverHolder: 'human' | null;
  takeoverReason: string | null;
  /** The opaque W009 consequential-action ref, when the takeover routed through the action gateway. */
  authorityActionRef: string | null;
  handbackAt: string | null;
  handbackNote: string | null;
  cancellationRequestedAt: string | null;
  cancelReason: string | null;
  lostAt: string | null;
  lostDetail: string | null;
  recoveryDetectedAt: string | null;
  recoveredAt: string | null;
  /** The checkpoint ref recovery resumed from (the latest checkpoint's cursor, or the prior session id when none exists). */
  recoveredFromCheckpointRef: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  failedAt: string | null;
  failureDetail: string | null;
  acquiredBy: string;
  createdAt: string;
}

/** Input shape of `acquireFabricLease`. */
export interface AcquireFabricLeaseInput {
  definitionId: string;
  /** The W136 execution plan that owns the run (the exchange's reads are plan-scoped). */
  planId: string;
  /** The W136 execution run the environment is acquired for. */
  executionRunId: string;
  /** OPAQUE credential reference (W082 discipline) — a VALUE here is a contract violation. */
  credentialRef?: string | null;
  /** The lease window in minutes (1..1440, default 60). */
  leaseMinutes?: number | null;
}

/** Input shape of `prepareFabricLease`. */
export interface PrepareFabricLeaseInput {
  leaseId: string;
}

/** Input shape of `takeoverFabricLease` (a HUMAN takes control). */
export interface TakeoverFabricLeaseInput {
  leaseId: string;
  /** Required takeover reason (1..512 chars), retained. */
  reason: string;
  /** The opaque W009 consequential-action ref, when the takeover routed through the action gateway. */
  authorityActionRef?: string | null;
}

/** Input shape of `handbackFabricLease` (the explicit hand-back). */
export interface HandbackFabricLeaseInput {
  leaseId: string;
  note?: string | null;
}

/** Input shape of `heartbeatFabricLease`. */
export interface HeartbeatFabricLeaseInput {
  leaseId: string;
}

/** Input shape of `markFabricLeaseLost` (the detection point). */
export interface MarkFabricLeaseLostInput {
  leaseId: string;
  /** Required loss detail (1..512 chars) — what detected the death. */
  detail: string;
}

/** Input shape of `recoverFabricLease` (lost → live, fresh session). */
export interface RecoverFabricLeaseInput {
  leaseId: string;
}

/** Input shape of `cancelFabricLease` (terminal). */
export interface CancelFabricLeaseInput {
  leaseId: string;
  /** Required cancellation reason (1..512 chars), retained. */
  reason: string;
}

/** Input shape of `releaseFabricLease` (the clean terminal close). */
export interface ReleaseFabricLeaseInput {
  leaseId: string;
  /** Required release reason (1..512 chars), retained. */
  reason: string;
}

/** Input shape of `failFabricLease` (the explicit vendor-failure report). */
export interface FailFabricLeaseInput {
  leaseId: string;
  /** Required failure detail (1..512 chars) — actionable evidence. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Artifact handoff / evidence / checkpoints (append-only evidence)
// ---------------------------------------------------------------------------

/**
 * One artifact handed across the environment boundary — always by OPAQUE
 * reference, never an embedded payload; the optional digest makes the
 * handoff tamper-evident (verified where the fabric is asked to, never
 * an authority). Append-only.
 */
export interface LeaseArtifactHandoff {
  id: string;
  tenantId: string;
  leaseId: string;
  direction: ArtifactHandoffDirection;
  /** Opaque artifact reference (the artifact store owns the bytes). */
  artifactRef: string;
  artifactKind: string;
  digest: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordArtifactHandoff`. */
export interface RecordArtifactHandoffInput {
  leaseId: string;
  direction: ArtifactHandoffDirection;
  artifactRef: string;
  artifactKind: string;
  digest?: string | null;
}

/**
 * One captured evidence record: a screenshot-equivalent observation, an
 * action trace, a DOM/console capture — always an OPAQUE artifact
 * reference with redaction APPLIED (the literal law: credentials never
 * ride in observations) and the verification state of the observed
 * state (the W093 discipline: nothing is treated as a result before
 * verification). Append-only.
 */
export interface LeaseEvidenceRecord {
  id: string;
  tenantId: string;
  leaseId: string;
  /** The frozen W131 capture vocabulary (screenshot | action-trace | dom-snapshot | console). */
  captureKind: 'screenshot' | 'action-trace' | 'dom-snapshot' | 'console';
  artifactRef: string;
  verification: EvidenceVerification;
  detail: string | null;
  /** Literal: redaction is applied before storage. */
  redaction: 'applied';
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordLeaseEvidence`. */
export interface RecordLeaseEvidenceInput {
  leaseId: string;
  captureKind: LeaseEvidenceRecord['captureKind'];
  artifactRef: string;
  verification: EvidenceVerification;
  detail?: string | null;
}

/**
 * One durable checkpoint cut by the driving worker: an OPAQUE cursor
 * (each adapter/work kind owns its own grammar — for this module's
 * adapters the documented convention is `<session-id>@<worker-cursor>`)
 * plus the covered evidence references, so replay never re-executes
 * covered work (the W131 resume semantics). Append-only.
 */
export interface LeaseCheckpoint {
  id: string;
  tenantId: string;
  leaseId: string;
  cursor: string;
  coveredEvidenceRefs: string[];
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordLeaseCheckpoint`. */
export interface RecordLeaseCheckpointInput {
  leaseId: string;
  cursor: string;
  coveredEvidenceRefs?: string[];
}

// ---------------------------------------------------------------------------
// The event tail
// ---------------------------------------------------------------------------

/**
 * One append-only lifecycle/evidence event. The `payload` is a
 * per-kind plain-JSON record (validated shapes; every reference opaque).
 * The kinds align with the frozen W131 TaskWorkerEvent vocabulary where
 * one exists (takeover, recovery, cancellation, artifact, evidence) and
 * add the fabric's own lifecycle points (acquired, prepared, handback,
 * loss, release, failure, checkpoint) — the frozen union governs
 * worker-run events; the lease tail is fabric-owned.
 */
export interface FabricLeaseEvent {
  id: string;
  tenantId: string;
  leaseId: string;
  kind: FabricLeaseEventKind;
  payload: Record<string, unknown>;
  recordedBy: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Query shape of `getEnvironmentDefinition`. */
export interface GetEnvironmentDefinitionQuery {
  definitionId: string;
}

/** Query shape of `listEnvironmentDefinitions`. All filters AND-combined. */
export interface ListEnvironmentDefinitionsQuery {
  status?: EnvironmentDefinitionStatus;
  kind?: ExecutionEnvironmentKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getFabricLease`. */
export interface GetFabricLeaseQuery {
  leaseId: string;
}

/** Query shape of `listFabricLeases`. All filters AND-combined. */
export interface ListFabricLeasesQuery {
  executionRunId?: string;
  definitionId?: string;
  status?: FabricLeaseStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listLeaseEvents`. */
export interface ListLeaseEventsQuery {
  leaseId: string;
  kind?: FabricLeaseEventKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listArtifactHandoffs` (the artifact manifest). */
export interface ListArtifactHandoffsQuery {
  leaseId: string;
  direction?: ArtifactHandoffDirection;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listLeaseEvidence`. */
export interface ListLeaseEvidenceQuery {
  leaseId: string;
  captureKind?: LeaseEvidenceRecord['captureKind'];
  verification?: EvidenceVerification;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listLeaseCheckpoints`. */
export interface ListLeaseCheckpointsQuery {
  leaseId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** One registered adapter's descriptor + registration order (vendor identity as METADATA — the only place it is visible). */
export interface RegisteredAdapterView {
  descriptor: ExecutionEnvironmentDescriptor;
  registrationIndex: number;
}
