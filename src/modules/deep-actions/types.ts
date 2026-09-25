// Public domain types of the deep-actions module (W084 — Deep Action
// Gateway and Reconciliation).
//
// W084 owns the EXECUTION half of the integration journey's action model
// (spec/WORK-ITEM-CATALOG.md):
//
//   "Implement discover→inspect→propose→authorize→execute→verify→
//    reconcile with evidence and outcome links across external systems."
//   Acceptance: "multi-system task can execute from Aurum; action receipt
//   and downstream state are verified; reconciliation detects mismatches
//   and creates attention/evidence; provider objects never cross the
//   gateway."
//
// The canonical chain maps onto forward-only task phase state, each phase
// an explicit contract call (the destinations dispatch/retry discipline —
// bounded, tenant-scoped, auditable units):
//
//   draft ──discover──▶ discovered ──inspect──▶ inspected ──propose──▶
//   proposed ──authorize──▶ authorized ──execute──▶ executed ──verify──▶
//   verified ──reconcile──▶ reconciled | mismatched
//                (rejected = a human/policy refusal or a capability
//                 denial; failed = a permanent execution failure)
//
// Every phase leaves its links behind:
//   * discover  — the execution surface (one snapshot row per distinct
//     connection: the W081 system, the W083 read-only floor, the gated
//     writes, the active grants);
//   * inspect  — per-operation PRE-STATE evidence (immutable observation
//     recorded through the W004 contract);
//   * propose  — the W009 action request (kind 'deep-action', level
//     EXECUTE — the approver-facing payload carries the full plan);
//   * authorize — per-operation W083 capability invocations (an allowed
//     write's authority evidence, or the recorded denial that STOPS the
//     write — denial is a first-class outcome, never a swallowed error);
//   * execute  — per-operation action receipts (the provider's opaque
//     receipt id, status and detail — the only provider-minted values on
//     this surface, opaque strings by construction);
//   * verify   — receipt verification (accepted) plus per-operation
//     POST-STATE evidence (another immutable observation);
//   * reconcile — the deterministic comparison of expectation vs observed
//     post-state (reconcile.ts): matched operations close the chain;
//     every mismatch records a THIRD immutable observation (the mismatch
//     evidence) and an epistemics unknown (the attention record — a
//     consequential gap demanding investigation, lock 7).
//
// PROVIDER ISOLATION (lock 16; the acceptance's last clause): everything
// here is provider-neutral BY CONSTRUCTION. External systems appear only
// as the OPAQUE broker-connection id (W082), the W081 plain-language
// system/capability descriptors and the opaque external `target` string.
// The provider-neutral transport port (DeepActionTransport below) is the
// gateway's exit seam: its implementations compose provider-native
// requests from the canonical shapes INSIDE this module's adapters folder
// and normalize provider responses back to canonical values; a
// non-canonical transport result is rejected loudly
// (`invalid_transport_result`) — a provider object cannot cross.
// Credential VALUES never appear on this surface (the W082 discipline:
// the opaque credentialRef passes straight through to the transport).

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/**
 * The forward-only phase state of a deep-action task — the canonical
 * discover→inspect→propose→authorize→execute→verify→reconcile chain, one
 * phase per transition, plus the two non-happy terminals:
 *   * 'rejected' — a human/policy refusal at the W009 gate, or a W083
 *     capability denial at authorization (denial stops the write);
 *   * 'failed'  — a permanent execution failure (a provider 'rejected'
 *     receipt; a transient 'failed' receipt also parks here but remains
 *     resumable — already-executed operations are never re-executed).
 */
export type DeepActionStatus =
  | 'draft'
  | 'discovered'
  | 'inspected'
  | 'proposed'
  | 'authorized'
  | 'executed'
  | 'verified'
  | 'reconciled'
  | 'mismatched'
  | 'rejected'
  | 'failed';

/** Terminal statuses (the end of a task's lifecycle). */
export const DEEP_ACTION_TERMINAL_STATUSES: readonly DeepActionStatus[] = [
  'reconciled',
  'mismatched',
  'rejected',
  'failed',
] as const;

/**
 * The forward-only state of one operation of a deep-action task:
 * 'pending' (planned) → 'authorized' (its write capability was invoked
 * and allowed) → 'executed' (its write was carried out and accepted) →
 * 'verified' (receipt + downstream state verified) → 'matched' |
 * 'mismatched' (reconciled). 'denied' = the W083 gate refused the write
 * (the task stops); 'failed' = the provider refused or the transport
 * failed the write.
 */
export type DeepActionOperationState =
  | 'pending'
  | 'authorized'
  | 'denied'
  | 'executed'
  | 'verified'
  | 'matched'
  | 'mismatched'
  | 'failed';

/** The provider-neutral outcome of an executed write (the action receipt). */
export type DeepActionReceiptStatus = 'accepted' | 'rejected' | 'failed';

/** The append-only lifecycle event vocabulary. */
export type DeepActionEventType =
  | 'created'
  | 'surface-discovered'
  | 'targets-inspected'
  | 'proposed'
  | 'gate-rejected'
  | 'authorized'
  | 'operation-denied'
  | 'operation-executed'
  | 'execution-failed'
  | 'executed'
  | 'verified'
  | 'reconciled'
  | 'mismatch-detected';

/** The canonical observation kinds this module records (W004 evidence). */
export const PRE_STATE_OBSERVATION_KIND = 'deep-action.pre-state';
export const POST_STATE_OBSERVATION_KIND = 'deep-action.post-state';
export const MISMATCH_OBSERVATION_KIND = 'deep-action.reconciliation-mismatch';

/** The canonical W009 action kind of a deep-action proposal (module-owned). */
export const DEEP_ACTION_ACTION_KIND = 'deep-action';

// ---------------------------------------------------------------------------
// The concrete task and its operations
// ---------------------------------------------------------------------------

/**
 * The concrete multi-system task (mirrors the W083 task-context shape):
 * the human-readable what-and-why, frozen at creation and replayed onto
 * every gate the task routes through.
 */
export interface DeepActionTaskContext {
  /** What the task is, in plain organizational language (1..2000 chars). */
  description: string;
  /** Optional plain-language link to what the task is for. */
  requestedFor?: string | null;
}

/**
 * One planned operation of a deep-action task: a single canonical write
 * against one external entity through one broker connection, plus the
 * canonical expectation reconciliation will verify against.
 */
export interface DeepActionOperationInput {
  /** Unique key within the task (1..128, canonical pattern). */
  key: string;
  /** The connection-broker connection (W082, opaque id). */
  connectionId: string;
  /** The plain-language WRITE capability to exercise (W081/W083 key). */
  capabilityKey: string;
  /** Opaque external entity reference (the record being written). */
  target: string;
  /** The canonical write payload (plain JSON object, ≤ 256 KiB). */
  payload: Record<string, unknown>;
  /**
   * The canonical EXPECTED downstream state: a plain JSON object of
   * expected field values. Reconciliation requires every entry to be
   * present and deep-equal in the observed post-state (subset semantics,
   * deterministic — reconcile.ts).
   */
  expectation: Record<string, unknown>;
}

/** Input shape of `createDeepAction`. */
export interface CreateDeepActionInput {
  taskContext: DeepActionTaskContext;
  /** 1..16 planned operations; keys unique; positions follow array order. */
  operations: DeepActionOperationInput[];
  /** Caller-supplied dedupe key; a recorded key replays the original task. */
  idempotencyKey?: string | null;
}

/** Result shape of `createDeepAction`. */
export interface CreateDeepActionResult {
  task: DeepActionTask;
  operations: DeepActionOperation[];
  /** false when a recorded idempotency key replayed an existing task. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

/** One multi-system deep-action task — the pipeline's durable state. */
export interface DeepActionTask {
  id: string;
  tenantId: string;
  taskContext: DeepActionTaskContext;
  operationCount: number;
  status: DeepActionStatus;
  /** The actions module's request the proposal routed through (W009). */
  actionRequestId: string | null;
  /** Why the task was refused or failed (terminal 'rejected'/'failed'). */
  rejectionReason: string | null;
  /** How many operations mismatched at reconciliation. */
  mismatchCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One operation of a deep-action task — the plan frozen at creation plus
 * the outcome links each phase fills in: the W083 invocation evidence
 * (allowed write or the recorded denial), the opaque provider action
 * receipt, and the pre-state / post-state / mismatch observation links
 * plus the attention unknown link.
 */
export interface DeepActionOperation {
  id: string;
  tenantId: string;
  taskId: string;
  key: string;
  /** 1-based execution order. */
  position: number;
  connectionId: string;
  /** The W081 inventory system (null until the DISCOVER phase resolves it). */
  systemId: string | null;
  systemKey: string | null;
  systemDisplayName: string | null;
  /** The WRITE capability exercised. */
  capabilityKey: string;
  /** The READ capability of the same class (null until discover resolves it). */
  readCapabilityKey: string | null;
  target: string;
  payload: unknown;
  expectation: unknown;
  state: DeepActionOperationState;
  /** The W083 invocation that allowed the write (null until authorized). */
  invocationId: string | null;
  /** The W083 invocation whose denial stopped this write, when it did. */
  denialInvocationId: string | null;
  receiptStatus: DeepActionReceiptStatus | null;
  /** The provider's opaque action-receipt id (null when it gave none). */
  receiptId: string | null;
  receiptDetail: string | null;
  preStateObservationId: string | null;
  postStateObservationId: string | null;
  mismatchEvidenceObservationId: string | null;
  /** The epistemics unknown created for a mismatch (the attention link). */
  mismatchUnknownId: string | null;
  executedAt: string | null;
  verifiedAt: string | null;
  reconciledAt: string | null;
}

/** One connection's discovered execution surface (frozen at discover). */
export interface DeepActionSurfaceEntry {
  id: string;
  tenantId: string;
  taskId: string;
  connectionId: string;
  systemId: string;
  systemKey: string;
  systemDisplayName: string;
  /** The read-only floor ({key,label,dataCategories} descriptors). */
  readCapabilities: unknown[];
  /** The write-gated set ({key,label,dataCategories} descriptors). */
  writeCapabilities: unknown[];
  /** Capability keys active grants covered at discover time. */
  activeGrantKeys: string[];
  connectionMode: 'read-only' | 'elevated';
  discoveredAt: string;
}

/** One append-only lifecycle event of a deep-action task. */
export interface DeepActionEvent {
  id: string;
  tenantId: string;
  taskId: string;
  event: DeepActionEventType;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** The full task view: the task, its ordered operations and its surface. */
export interface DeepActionDetail {
  task: DeepActionTask;
  operations: DeepActionOperation[];
  surface: DeepActionSurfaceEntry[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface GetDeepActionQuery {
  taskId: string;
}

export interface ListDeepActionsQuery {
  status?: DeepActionStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListDeepActionEventsQuery {
  taskId: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Phase-transition inputs
// ---------------------------------------------------------------------------

/** Input of `discoverExecutionSurface` (the DISCOVER phase). */
export interface DiscoverSurfaceInput {
  taskId: string;
}

/** Input of `inspectTargets` (the INSPECT phase). */
export interface InspectTargetsInput {
  taskId: string;
}

/** Input of `proposeDeepAction` (the PROPOSE phase). */
export interface ProposeDeepActionInput {
  taskId: string;
}

/** Input of `authorizeDeepAction` (the AUTHORIZE phase). */
export interface AuthorizeDeepActionInput {
  taskId: string;
}

/** Input of `executeDeepAction` (the EXECUTE phase; resumable on 'failed'). */
export interface ExecuteDeepActionInput {
  taskId: string;
}

/** Input of `verifyDeepAction` (the VERIFY phase). */
export interface VerifyDeepActionInput {
  taskId: string;
}

/** Input of `reconcileDeepAction` (the RECONCILE phase). */
export interface ReconcileDeepActionInput {
  taskId: string;
}

// ---------------------------------------------------------------------------
// The transport port (the gateway's provider-neutral exit seam)
// ---------------------------------------------------------------------------

/** A canonical state read of one external entity (INSPECT/VERIFY path). */
export interface DeepActionInspectRequest {
  /** The connection-broker connection (opaque W082 id). */
  connectionId: string;
  /** Opaque broker credential-store reference — the transport resolves it. */
  credentialRef: string;
  /** The W081 canonical system key of the system behind the connection. */
  systemKey: string;
  /** The READ capability being exercised (plain-language W081 key). */
  capabilityKey: string;
  /** Opaque external entity reference. */
  target: string;
  /** Stable dedupe key — `deep-action:<taskId>:<operationId>:<phase>`. */
  idempotencyKey: string;
}

/** The canonical (provider-neutral) state of one external entity. */
export interface DeepActionState {
  /** False when the external system reports no such entity. */
  found: boolean;
  /** The normalized entity state (null when not found). */
  state: unknown;
}

/** One canonical write against one external entity (EXECUTE path). */
export interface DeepActionExecuteRequest {
  connectionId: string;
  credentialRef: string;
  systemKey: string;
  /** The WRITE capability being exercised (plain-language W081 key). */
  capabilityKey: string;
  target: string;
  /** The canonical write payload (the adapter composes the native request). */
  payload: unknown;
  /** Stable dedupe key — `deep-action:<taskId>:<operationId>:execute`. */
  idempotencyKey: string;
}

/**
 * The provider-neutral action receipt of one executed write. `receiptId`
 * is the provider's own opaque acknowledgment id (null when it gave
 * none); `status` follows the destinations transport taxonomy:
 * 'accepted' (the write was taken), 'rejected' (permanent refusal),
 * 'failed' (transient — the execution stays resumable).
 */
export interface DeepActionReceipt {
  status: DeepActionReceiptStatus;
  receiptId: string | null;
  detail: string | null;
}

/**
 * THE DEEP-ACTION TRANSPORT PORT — the gateway's exit seam. Real
 * transports that touch provider SDKs/HTTP live inside
 * `src/modules/deep-actions/adapters/` (IMPLEMENTATION-STACK §6 provider
 * isolation) and are wired at process start via `setDeepActionTransport`.
 * No transport is wired by default — the pipeline then fails explicitly
 * with `transport_unavailable` (the sources/destinations discipline:
 * never a fake success).
 *
 * Implementations MUST return canonical values only: a non-canonical
 * result (a provider object, a class instance, a symbol) is rejected
 * loudly by the service (`invalid_transport_result`) — provider objects
 * never cross the gateway.
 */
export interface DeepActionTransport {
  /** Read the current canonical state of one external entity. */
  inspect(request: DeepActionInspectRequest): Promise<DeepActionState>;
  /** Carry one canonical write out; return its provider-neutral receipt. */
  execute(request: DeepActionExecuteRequest): Promise<DeepActionReceipt>;
}

// ---------------------------------------------------------------------------
// Reconciliation (the pure deterministic comparison — reconcile.ts)
// ---------------------------------------------------------------------------

/** One expectation entry that did not hold in the observed post-state. */
export interface StateMismatch {
  /** Dotted path into the expected/observed state (e.g. 'stage'). */
  path: string;
  expected: unknown;
  actual: unknown;
}

/** The deterministic reconciliation verdict of one operation. */
export interface OperationReconciliation {
  /** True when every expectation entry held in the observed post-state. */
  matched: boolean;
  /** The expectation entries that did not hold (empty when matched). */
  mismatches: StateMismatch[];
  /** True when the observed post-state deep-equals the pre-state. */
  stateUnchanged: boolean;
}

/** The result of `reconcileDeepAction`. */
export interface ReconcileResult {
  task: DeepActionTask;
  operations: DeepActionOperation[];
  /** The ids of the mismatch-evidence observations recorded. */
  mismatchEvidenceObservationIds: string[];
  /** The ids of the attention unknowns recorded. */
  mismatchUnknownIds: string[];
}
