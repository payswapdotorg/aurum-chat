// ============================================================================
// deep-actions — the ONLY public surface of the deep-actions module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W084 — Deep Action Gateway and Reconciliation:
// "Implement discover→inspect→propose→authorize→execute→verify→reconcile
//  with evidence and outcome links across external systems."
// Acceptance: multi-system task can execute from Aurum; action receipt
// and downstream state are verified; reconciliation detects mismatches
// and creates attention/evidence; provider objects never cross the
// gateway.
//
//   THE PIPELINE (each phase an explicit, bounded, tenant-scoped call;
//   the destinations dispatch/retry discipline):
//     createDeepAction         — freeze the multi-system plan (1..16
//        operations, each a canonical write + expected downstream state)
//        with its concrete task context; idempotent by caller key.
//     discoverExecutionSurface — DISCOVER: resolve every DISTINCT
//        connection the plan touches through the owning contracts — the
//        W082 broker connection (connected), the W083 progressive-access
//        envelope (established) and the W081 inventory surface (the write
//        capability offered; a read capability of the same class exists —
//        a write you cannot verify is refused). One surface row per
//        connection: system, read-only floor, gated writes, active
//        grants.
//     inspectTargets           — INSPECT: read every target's current
//        state through the transport's read path (each read rides the
//        W083 floor invocation) and record it as immutable PRE-STATE
//        evidence (observations contract, W004).
//     proposeDeepAction        — PROPOSE: route the full plan through
//        the actions module's gate (W009: kind 'deep-action' @ EXECUTE —
//        the built-in default matrix waits for a human decision; tenant
//        policy may auto-allow or forbid). The approver-facing payload
//        carries every system, capability, target, payload and
//        expectation, plus the pre-state evidence links.
//     authorizeDeepAction      — AUTHORIZE: require the W009 decision
//        (approved), then invoke every operation's WRITE capability
//        through the W083 gate. DENIAL STOPS THE WRITE: the first denied
//        invocation parks the task 'rejected' with the gate's own
//        human-readable reason recorded (W083's reason, verbatim).
//     executeDeepAction        — EXECUTE: carry each write out through
//        the transport with a stable per-operation idempotency key
//        (exactly-once external effects for honoring transports);
//        record the provider's OPAQUE action receipt per operation.
//        Resumable: executed operations are never re-executed; a
//        transient 'failed' receipt parks the task 'failed' for retry,
//        a permanent 'rejected' receipt refuses re-execution.
//     verifyDeepAction         — VERIFY: the two-sided verification —
//        every recorded receipt must be 'accepted' AND every target's
//        downstream state is read back and recorded as immutable
//        POST-STATE evidence.
//     reconcileDeepAction      — RECONCILE: the deterministic comparison
//        (reconcile.ts) of each operation's frozen expectation against
//        its observed post-state. Matched operations close the chain;
//        every mismatch records a THIRD immutable observation (the
//        mismatch evidence, derived from the two state reads) and an
//        epistemics unknown (the ATTENTION record — a consequential
//        gap, lock 7) linked to all three observations. The task ends
//        'reconciled' (clean) or 'mismatched' (attention created).
//
//   THE READS
//     getDeepAction / listDeepActions / listDeepActionEvents — the task
//        with its ordered operations and discovered surface; the task
//        feed; the append-only lifecycle audit.
//
//   THE TRANSPORT PORT (the gateway's provider-neutral exit seam)
//     setDeepActionTransport / getDeepActionTransport — infrastructure
//        wiring for the DeepActionTransport port (the sources/destinations
//        transport precedent). No transport is wired by default: the
//        inspect/execute/verify phases fail explicitly with
//        `transport_unavailable` rather than faking success. Transport
//        results are canonicalized and validated — a provider object
//        (class instance, symbol, cycle, oversized body) is rejected
//        loudly (`invalid_transport_result`): provider objects never
//        cross the gateway.
//
//   THE W080 COMPOSITION (durable, resumable deep-action runs)
//     registerDeepActionWorkflow / startDeepActionRun /
//     createDeepActionWorkflowBindings — the same phases composed into
//        ONE workflow run under the canonical definition
//        `deep-actions.execute`: the proposal rides the engine's own
//        approval wait (routed through authorizeAction under the run's
//        ORIGINAL durable context — no forked W009 semantics), each
//        phase checkpoints, and the task's own durable status IS the
//        resume checkpoint: kill/restart workers mid-run and a fresh
//        engine resumes exactly where the task stands (W080 acceptance,
//        lock 36).
//
// There is deliberately NO operation to update or erase a task's plan,
// re-decide a gate, un-write a receipt or un-record evidence: the plan is
// frozen at creation, the gate decision is the actions module's
// append-only history, receipts and observations are immutable, and a
// changed plan is a NEW task (the actions module's discipline). Learning
// never rewrites execution history (lock 14 mirrored).
//
// PROVIDER ISOLATION (lock 16): everything exported below is
// provider-neutral BY CONSTRUCTION. External systems appear only as the
// OPAQUE broker-connection id (W082), the W081 plain-language
// system/capability descriptors and opaque external target strings; the
// only provider-minted values on this surface are OPAQUE strings (action
// receipt ids). Credential VALUES never appear here — the opaque
// credentialRef passes straight through to the transport (W082
// discipline).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's tasks,
// operations, surface or events are indistinguishable from missing
// (`task_not_found`) — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W084 ← W009, W037, W080, W082,
// W083): this module imports ONLY module contracts — actions (the W009
// approval gate), capability-grants (the W083 invocation gate and access
// envelope), connection-broker (the W082 connection records),
// integration-intelligence (the W081 inventory surface), observations
// (the W004 evidence), epistemics (the attention unknowns) and workflow
// (the W080 durable runtime). The W037 destinations posture (outbound
// deliveries as 'data-export' through their own gated transport) is the
// EXPORT cousin of this gateway's task-execution path — the two stay
// separate on purpose: a deep action executes a TASK's plan under
// task-scoped capability grants; a destination delivery exports findings
// under the export gate.
// ============================================================================

export {
  // the pipeline
  createDeepAction,
  discoverExecutionSurface,
  inspectTargets,
  proposeDeepAction,
  authorizeDeepAction,
  executeDeepAction,
  verifyDeepAction,
  reconcileDeepAction,
  // the reads
  getDeepAction,
  listDeepActions,
  listDeepActionEvents,
  // the transport port wiring
  setDeepActionTransport,
  getDeepActionTransport,
  // the W080 composition
  registerDeepActionWorkflow,
  startDeepActionRun,
  createDeepActionWorkflowBindings,
} from './service';

export { DeepActionsError } from './errors';
export type { DeepActionsErrorCode } from './errors';

// Module-owned constants (the canonical W009 action kind, the canonical
// W080 workflow definition, the evidence observation kinds).
export {
  DEEP_ACTION_ACTION_KIND,
  DEEP_ACTION_WORKFLOW_KEY,
  DEEP_ACTION_WORKFLOW_STEP,
} from './service';
export {
  MISMATCH_OBSERVATION_KIND,
  POST_STATE_OBSERVATION_KIND,
  PRE_STATE_OBSERVATION_KIND,
} from './types';

// The pure deterministic-reconciliation surface (unit-tested; exported
// for tests and downstream surfaces exactly like the capability-grants
// reason helpers — lock 10: reconciliation is a computation, not an
// opinion).
export {
  buildMismatchReason,
  buildMismatchUnknownConsequence,
  buildMismatchUnknownQuestion,
  clampDetail,
  describeMismatch,
  joinAnd,
  jsonDeepEqual,
  reconcileOperation,
  verifyReceipt,
} from './reconcile';
export type { ReceiptVerification } from './reconcile';

// Validation vocabularies + guards (the house pattern).
export {
  DEEP_ACTION_EVENT_TYPES,
  DEEP_ACTION_OPERATION_STATES,
  DEEP_ACTION_RECEIPT_STATUSES,
  DEEP_ACTION_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_OPERATIONS,
  MAX_OPERATION_KEY_LENGTH,
  MAX_RECEIPT_DETAIL_LENGTH,
  MAX_RECEIPT_ID_LENGTH,
  MAX_REQUESTED_FOR_LENGTH,
  MAX_TARGET_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_VALUE_BYTES,
  MIN_TASK_DESCRIPTION_LENGTH,
  assertDeepActionsTenantContext,
  isDeepActionEventType,
  isDeepActionOperationState,
  isDeepActionReceiptStatus,
  isDeepActionStatus,
  isUuid,
  readCapabilityKeyOf,
} from './validation';

export type {
  ValidatedCreateInput,
  ValidatedGetQuery,
  ValidatedListEventsQuery,
  ValidatedListQuery,
  ValidatedOperationInput,
  ValidatedTaskContext,
  ValidatedTaskIdInput,
} from './validation';

export type {
  AuthorizeDeepActionInput,
  CreateDeepActionInput,
  CreateDeepActionResult,
  DeepActionDetail,
  DeepActionEvent,
  DeepActionEventType,
  DeepActionExecuteRequest,
  DeepActionInspectRequest,
  DeepActionOperation,
  DeepActionOperationInput,
  DeepActionOperationState,
  DeepActionReceipt,
  DeepActionReceiptStatus,
  DeepActionState,
  DeepActionStatus,
  DeepActionSurfaceEntry,
  DeepActionTask,
  DeepActionTaskContext,
  DeepActionTransport,
  DiscoverSurfaceInput,
  ExecuteDeepActionInput,
  GetDeepActionQuery,
  InspectTargetsInput,
  ListDeepActionEventsQuery,
  ListDeepActionsQuery,
  OperationReconciliation,
  ProposeDeepActionInput,
  ReconcileDeepActionInput,
  ReconcileResult,
  StateMismatch,
  VerifyDeepActionInput,
} from './types';
export { DEEP_ACTION_TERMINAL_STATUSES } from './types';
