// Implementation of the deep-actions module's public operations (see
// contract.ts). W084 — Deep Action Gateway and Reconciliation.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by `newId()` where
// the id is needed before the insert; timestamps come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`task_not_found`), no
// existence leak.
//
// W084 acceptance — "multi-system task can execute from Aurum; action
// receipt and downstream state are verified; reconciliation detects
// mismatches and creates attention/evidence; provider objects never cross
// the gateway" — is carried by these deliberate properties, all tested:
//
//   1. THE PIPELINE IS THE PRODUCT: every phase is an explicit, bounded,
//      tenant-scoped contract call that leaves its links behind (surface
//      snapshot, pre/post-state observations, the W009 gate record, the
//      W083 invocation evidence, the opaque action receipts, the
//      mismatch evidence and attention unknowns). Nothing executes
//      without the whole chain having been walked — a write can never
//      happen before propose/authorize, and nothing is believed without
//      verify/reconcile.
//
//   2. DENIAL STOPS THE WRITE: authorization consults the W083
//      capability gate per operation; a denied invocation parks the task
//      'rejected' with the gate's own human-readable reason recorded —
//      the refusal is data, never a swallowed error.
//
//   3. VERIFICATION IS TWO-SIDED: the recorded action receipt must be
//      'accepted' AND the downstream state is read back through the read
//      path as fresh immutable evidence before reconciliation compares
//      it against the frozen expectation.
//
//   4. MISMATCHES CREATE ATTENTION AND EVIDENCE: reconciliation is a
//      pure deterministic computation (reconcile.ts); every mismatch
//      records a third immutable observation (the evidence) and an
//      epistemics unknown (the attention — a consequential gap, lock 7),
//      both linked back to the task and operation.
//
//   5. PROVIDER OBJECTS NEVER CROSS: the transport port is the exit seam;
//      its results are canonicalized and validated (a non-JSON value, a
//      class instance, an oversized body → `invalid_transport_result`).
//      The only provider-minted values that persist are opaque strings
//      (receipt ids).
//
//   6. THE W080 COMPOSITION: the same phases compose into durable,
//      resumable workflow runs (createDeepActionWorkflowBindings +
//      startDeepActionRun) — the approval wait survives worker death, and
//      the task's own durable status IS the resume checkpoint.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  getActionRequest,
  type ActionRequest,
} from '@/modules/actions/contract';
import {
  CapabilityGrantsError,
  getConnectionAccess,
  invokeCapability,
  type CapabilityInvocation,
  type ConnectionAccessView,
} from '@/modules/capability-grants/contract';
import {
  ConnectionBrokerError,
  getConnection,
  type BrokerConnection,
} from '@/modules/connection-broker/contract';
import {
  IntegrationError,
  getSystem,
  type InventorySystem,
} from '@/modules/integration-intelligence/contract';
import {
  ObservationsError,
  getObservation,
  recordObservation,
  type Observation,
} from '@/modules/observations/contract';
import {
  EpistemicsError,
  recordUnknown,
  type Unknown,
} from '@/modules/epistemics/contract';
import {
  WorkflowStepError,
  registerWorkflow,
  startRun,
  type WorkflowRun,
  type WorkflowExecutorBindings,
  type WorkflowStepInvocation,
  type WorkflowStepResult,
} from '@/modules/workflow/contract';
import { DeepActionsError } from './errors';
import {
  clampDetail,
  buildMismatchReason,
  buildMismatchUnknownConsequence,
  buildMismatchUnknownQuestion,
  reconcileOperation,
  verifyReceipt,
} from './reconcile';
import {
  assertDeepActionsTenantContext,
  readCapabilityKeyOf,
  validateCreateDeepActionInput,
  validateDiscoverSurfaceInput,
  validateInspectTargetsInput,
  validateProposeDeepActionInput,
  validateAuthorizeDeepActionInput,
  validateExecuteDeepActionInput,
  validateVerifyDeepActionInput,
  validateReconcileDeepActionInput,
  validateGetDeepActionQuery,
  validateListDeepActionsQuery,
  validateListDeepActionEventsQuery,
  type ValidatedTaskContext,
} from './validation';
import type {
  CreateDeepActionInput,
  CreateDeepActionResult,
  DeepActionDetail,
  DeepActionEvent,
  DeepActionOperation,
  DeepActionOperationState,
  DeepActionReceipt,
  DeepActionState,
  DeepActionStatus,
  DeepActionSurfaceEntry,
  DeepActionTask,
  DeepActionTaskContext,
  DeepActionTransport,
  DeepActionEventType,
  GetDeepActionQuery,
  ListDeepActionsQuery,
  ListDeepActionEventsQuery,
  OperationReconciliation,
  ReconcileResult,
} from './types';
import {
  MISMATCH_OBSERVATION_KIND,
  POST_STATE_OBSERVATION_KIND,
  PRE_STATE_OBSERVATION_KIND,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** The canonical W009 action kind of a deep-action proposal. */
export const DEEP_ACTION_ACTION_KIND = 'deep-action';

/** The canonical W080 workflow definition key of the deep-action pipeline. */
export const DEEP_ACTION_WORKFLOW_KEY = 'deep-actions.execute';

/** The single step key of the deep-action workflow program. */
export const DEEP_ACTION_WORKFLOW_STEP = 'run-task';

const DEEP_ACTION_WORKFLOW_TITLE = 'Deep action execution';
const DEEP_ACTION_WORKFLOW_DESCRIPTION =
  'Drives one deep-action task through discover, inspect, the W009 approval wait, authorize, execute, verify and reconcile. The task\u2019s own durable status is the resume checkpoint; a fresh engine against the same database resumes correctly.';

/** The provider-neutral channel key recorded on the module's evidence. */
const DEEP_ACTION_CHANNEL = 'deep-action';

/** Confidence of a canonical state read through the transport. */
const TRANSPORT_READ_CONFIDENCE = {
  value: 0.95,
  method: 'deep-action-transport',
  basis: 'canonical state read through the deep-action gateway',
} as const;

/** Confidence of deterministic reconciliation evidence. */
const RECONCILIATION_CONFIDENCE = {
  value: 1,
  method: 'deterministic-comparison',
  basis: 'expected post-state compared against the observed post-state (reconcile.ts)',
} as const;

// ---------------------------------------------------------------------------
// The transport port wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

let wiredTransport: DeepActionTransport | null = null;

/** Wires (or clears) the deep-action transport — the gateway's exit seam. */
export function setDeepActionTransport(transport: DeepActionTransport | null): void {
  wiredTransport = transport;
}

/** The currently wired deep-action transport (null = none). */
export function getDeepActionTransport(): DeepActionTransport | null {
  return wiredTransport;
}

function requireTransport(): DeepActionTransport {
  if (wiredTransport === null) {
    throw new DeepActionsError(
      'transport_unavailable',
      'no deep-action transport is wired — setDeepActionTransport first; the pipeline refuses to fake success',
    );
  }
  return wiredTransport;
}

// ---------------------------------------------------------------------------
// Transport-result canonicalization (provider objects never cross)
// ---------------------------------------------------------------------------

function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  if (Array.isArray(value)) return value.every((entry) => isPlainJsonValue(entry));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isPlainJsonValue(entry));
}

/**
 * Canonicalizes one transport state read: plain JSON only, modest size.
 * A provider object (class instance, symbol, cycle, oversized body)
 * CANNOT cross the gateway — it is rejected loudly here.
 */
function canonicalizeStateResult(result: unknown, operationKey: string): DeepActionState {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a non-object state result for operation '${operationKey}' — provider objects never cross the gateway`,
    );
  }
  const candidate = result as Partial<DeepActionState>;
  if (typeof candidate.found !== 'boolean') {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a state result without a boolean 'found' for operation '${operationKey}'`,
    );
  }
  const state = candidate.state === undefined ? null : candidate.state;
  if (!isPlainJsonValue(state)) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a non-JSON state for operation '${operationKey}' — provider objects never cross the gateway`,
    );
  }
  const serialized = JSON.stringify(state) ?? 'null';
  if (serialized.length > 262_144) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a state exceeding 262144 bytes for operation '${operationKey}' — large artifacts belong in object storage`,
    );
  }
  return { found: candidate.found, state };
}

/** Canonicalizes one transport receipt (opaque strings only). */
function canonicalizeReceipt(receipt: unknown, operationKey: string): DeepActionReceipt {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a non-object receipt for operation '${operationKey}' — provider objects never cross the gateway`,
    );
  }
  const proto = Object.getPrototypeOf(receipt);
  if (proto !== Object.prototype && proto !== null) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a provider receipt object for operation '${operationKey}' — provider objects never cross the gateway`,
    );
  }
  const candidate = receipt as Partial<DeepActionReceipt>;
  if (
    candidate.status !== 'accepted' &&
    candidate.status !== 'rejected' &&
    candidate.status !== 'failed'
  ) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a receipt with an unknown status '${String(candidate.status)}' for operation '${operationKey}'`,
    );
  }
  const receiptId = candidate.receiptId ?? null;
  if (receiptId !== null && (typeof receiptId !== 'string' || receiptId.length === 0 || receiptId.length > 200)) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a receipt id that is not an opaque string of 1..200 characters for operation '${operationKey}'`,
    );
  }
  const detail = candidate.detail ?? null;
  if (detail !== null && (typeof detail !== 'string' || detail.length > 500)) {
    throw new DeepActionsError(
      'invalid_transport_result',
      `the transport returned a receipt detail exceeding 500 characters for operation '${operationKey}'`,
    );
  }
  return { status: candidate.status, receiptId, detail };
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface TaskRow extends DbRow {
  id: string;
  tenant_id: string;
  task_context: { description: string; requestedFor: string | null };
  operation_count: number;
  status: DeepActionStatus;
  action_request_id: string | null;
  rejection_reason: string | null;
  mismatch_count: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OperationRow extends DbRow {
  id: string;
  tenant_id: string;
  task_id: string;
  op_key: string;
  position: number;
  connection_id: string;
  system_id: string | null;
  system_key: string | null;
  system_display_name: string | null;
  capability_key: string;
  read_capability_key: string | null;
  target: string;
  payload: unknown;
  expectation: unknown;
  state: DeepActionOperationState;
  invocation_id: string | null;
  denial_invocation_id: string | null;
  receipt_status: 'accepted' | 'rejected' | 'failed' | null;
  receipt_id: string | null;
  receipt_detail: string | null;
  pre_state_observation_id: string | null;
  post_state_observation_id: string | null;
  mismatch_evidence_observation_id: string | null;
  mismatch_unknown_id: string | null;
  executed_at: Date | string | null;
  verified_at: Date | string | null;
  reconciled_at: Date | string | null;
}

interface SurfaceRow extends DbRow {
  id: string;
  tenant_id: string;
  task_id: string;
  connection_id: string;
  system_id: string;
  system_key: string;
  system_display_name: string;
  read_capabilities: unknown[];
  write_capabilities: unknown[];
  active_grant_keys: string[];
  connection_mode: 'read-only' | 'elevated';
  discovered_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  task_id: string;
  position: number;
  event: DeepActionEventType;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapTask(row: TaskRow): DeepActionTask {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskContext: {
      description: row.task_context.description,
      requestedFor: row.task_context.requestedFor ?? null,
    },
    operationCount: row.operation_count,
    status: row.status,
    actionRequestId: row.action_request_id,
    rejectionReason: row.rejection_reason,
    mismatchCount: row.mismatch_count,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapOperation(row: OperationRow): DeepActionOperation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    key: row.op_key,
    position: row.position,
    connectionId: row.connection_id,
    systemId: row.system_id,
    systemKey: row.system_key,
    systemDisplayName: row.system_display_name,
    capabilityKey: row.capability_key,
    readCapabilityKey: row.read_capability_key,
    target: row.target,
    payload: row.payload,
    expectation: row.expectation,
    state: row.state,
    invocationId: row.invocation_id,
    denialInvocationId: row.denial_invocation_id,
    receiptStatus: row.receipt_status,
    receiptId: row.receipt_id,
    receiptDetail: row.receipt_detail,
    preStateObservationId: row.pre_state_observation_id,
    postStateObservationId: row.post_state_observation_id,
    mismatchEvidenceObservationId: row.mismatch_evidence_observation_id,
    mismatchUnknownId: row.mismatch_unknown_id,
    executedAt: toIso(row.executed_at),
    verifiedAt: toIso(row.verified_at),
    reconciledAt: toIso(row.reconciled_at),
  };
}

function mapSurface(row: SurfaceRow): DeepActionSurfaceEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    connectionId: row.connection_id,
    systemId: row.system_id,
    systemKey: row.system_key,
    systemDisplayName: row.system_display_name,
    readCapabilities: row.read_capabilities,
    writeCapabilities: row.write_capabilities,
    activeGrantKeys: row.active_grant_keys,
    connectionMode: row.connection_mode,
    discoveredAt: toIso(row.discovered_at)!,
  };
}

function mapEvent(row: EventRow): DeepActionEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    event: row.event,
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at)!,
  };
}

async function findTaskRow(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
): Promise<TaskRow | null> {
  const rows = await db.query<TaskRow>(
    `SELECT * FROM deep_action_tasks WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, taskId],
  );
  return rows.rows[0] ?? null;
}

async function loadTask(ctx: TenantContext, taskId: string): Promise<TaskRow> {
  const row = await findTaskRow(getDb(), ctx, taskId);
  if (row === null) {
    throw new DeepActionsError(
      'task_not_found',
      `no deep-action task '${taskId}' exists in this tenant`,
    );
  }
  return row;
}

function requireTaskStatus(row: TaskRow, expected: readonly DeepActionStatus[]): TaskRow {
  if (!expected.includes(row.status)) {
    throw new DeepActionsError(
      'task_not_pending_phase',
      `deep-action task '${row.id}' is '${row.status}' — this phase requires ${expected.join(' or ')}`,
    );
  }
  return row;
}

async function listOperationRows(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
): Promise<OperationRow[]> {
  const rows = await db.query<OperationRow>(
    `SELECT * FROM deep_action_operations WHERE tenant_id = $1 AND task_id = $2 ORDER BY position`,
    [ctx.tenantId, taskId],
  );
  return rows.rows;
}

async function listSurfaceRows(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
): Promise<SurfaceRow[]> {
  const rows = await db.query<SurfaceRow>(
    `SELECT * FROM deep_action_surface WHERE tenant_id = $1 AND task_id = $2 ORDER BY connection_id`,
    [ctx.tenantId, taskId],
  );
  return rows.rows;
}

async function recordEvent(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
  event: DeepActionEventType,
  detail: string | null,
  at: Date,
): Promise<void> {
  // Monotonic per-task position: the service clock can hold still within
  // one phase (test-controllable time), so the audit feed stays ordered.
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM deep_action_events
       WHERE tenant_id = $1 AND task_id = $2`,
    [ctx.tenantId, taskId],
  );
  await db.query(
    `INSERT INTO deep_action_events (id, tenant_id, task_id, position, event, detail, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), ctx.tenantId, taskId, next.rows[0]?.next ?? 1, event, detail, ctx.principalId, at],
  );
}

/** Forward-only task status transition (guarded; returns null when lost). */
async function transitionTask(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
  from: readonly DeepActionStatus[],
  to: DeepActionStatus,
  at: Date,
  extra?: { actionRequestId?: string; rejectionReason?: string | null; mismatchCount?: number },
): Promise<TaskRow | null> {
  const rows = await db.query<TaskRow>(
    `UPDATE deep_action_tasks SET
       status = $3,
       action_request_id = COALESCE($4, action_request_id),
       rejection_reason = $5,
       mismatch_count = $6,
       updated_at = $7
     WHERE tenant_id = $1 AND id = $2 AND status = ANY($8::text[])
     RETURNING *`,
    [
      ctx.tenantId,
      taskId,
      to,
      extra?.actionRequestId ?? null,
      extra?.rejectionReason ?? null,
      extra?.mismatchCount ?? 0,
      at,
      [...from],
    ],
  );
  return rows.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cross-module loaders (tenant-scoped through the owning contracts)
// ---------------------------------------------------------------------------

/** Loads a broker connection through the connection-broker contract (W082). */
async function loadConnection(ctx: TenantContext, connectionId: string): Promise<BrokerConnection> {
  try {
    return await getConnection(ctx, { connectionId });
  } catch (error) {
    if (error instanceof ConnectionBrokerError && error.code === 'connection_not_found') {
      throw new DeepActionsError(
        'connection_not_found',
        `no connection '${connectionId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

/** Loads a connection's progressive-access envelope (W083). */
async function loadAccess(ctx: TenantContext, connectionId: string): Promise<ConnectionAccessView> {
  try {
    return await getConnectionAccess(ctx, { connectionId });
  } catch (error) {
    if (error instanceof CapabilityGrantsError) {
      if (error.code === 'connection_not_found') {
        throw new DeepActionsError(
          'connection_not_found',
          `no connection '${connectionId}' exists in this tenant`,
        );
      }
      if (error.code === 'connection_not_connected') {
        throw new DeepActionsError('connection_not_connected', error.message);
      }
      if (error.code === 'access_not_found') {
        throw new DeepActionsError(
          'access_not_established',
          `no capability access established for connection '${connectionId}' — establish the read-only start first (W083)`,
        );
      }
      if (error.code === 'connection_not_bound' || error.code === 'system_not_found') {
        throw new DeepActionsError('access_stale', error.message);
      }
    }
    throw error;
  }
}

/** Loads a Tool & System Inventory entry through the W081 contract. */
async function loadSystem(ctx: TenantContext, systemId: string): Promise<InventorySystem> {
  try {
    return await getSystem(ctx, { systemId });
  } catch (error) {
    if (error instanceof IntegrationError && error.code === 'system_not_found') {
      throw new DeepActionsError(
        'system_not_found',
        `no inventory system '${systemId}' exists in this tenant`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Evidence helpers (immutable observations through the W004 contract)
// ---------------------------------------------------------------------------

async function recordStateObservation(
  ctx: TenantContext,
  input: {
    kind: string;
    operation: DeepActionOperation;
    taskId: string;
    state: DeepActionState;
    receipt?: { status: string; receiptId: string | null } | null;
    at: Date;
  },
): Promise<Observation> {
  try {
    return await recordObservation(ctx, {
      kind: input.kind,
      payload: {
        taskId: input.taskId,
        operationKey: input.operation.key,
        target: input.operation.target,
        found: input.state.found,
        state: input.state.state,
        ...(input.receipt === undefined || input.receipt === null
          ? {}
          : { receipt: { status: input.receipt.status, receiptId: input.receipt.receiptId } }),
      },
      observedAt: input.at.toISOString(),
      source: {
        kind: 'system',
        id: input.operation.systemId,
        label: input.operation.systemDisplayName,
      },
      channel: DEEP_ACTION_CHANNEL,
      confidence: { ...TRANSPORT_READ_CONFIDENCE },
    });
  } catch (error) {
    if (error instanceof ObservationsError) {
      // Our evidence inputs are system-minted; a rejection here contradicts
      // the observations contract — stay loud rather than silently unevidenced.
      throw new Error(
        `the observations contract rejected a pre-validated deep-action evidence record (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Reads the recorded `state` field out of a state observation's payload. */
function stateOfObservation(observation: Observation): unknown {
  const payload = observation.payload as { state?: unknown } | null;
  if (payload === null || typeof payload !== 'object') return null;
  return payload.state ?? null;
}

// ---------------------------------------------------------------------------
// createDeepAction — the plan, frozen
// ---------------------------------------------------------------------------

export async function createDeepAction(
  ctx: TenantContext,
  input: CreateDeepActionInput,
): Promise<CreateDeepActionResult> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateCreateDeepActionInput(input);

  const db = getDb();
  const at = now();

  // Idempotent replay: a recorded key returns the original task.
  if (valid.idempotencyKey !== null) {
    const existing = await db.query<TaskRow>(
      `SELECT t.* FROM deep_action_tasks t
         JOIN deep_action_idempotency k ON k.task_id = t.id AND k.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1 AND k.idempotency_key = $2`,
      [ctx.tenantId, valid.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      return {
        task: mapTask(row),
        operations: (await listOperationRows(db, ctx, row.id)).map(mapOperation),
        created: false,
      };
    }
  }

  const taskId = newId();
  const operationIds = valid.operations.map(() => newId());

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO deep_action_tasks (
         id, tenant_id, task_context, operation_count, status,
         mismatch_count, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, 'draft', 0, $5, $6, $6)`,
      [
        taskId,
        ctx.tenantId,
        JSON.stringify(taskRecord(valid.taskContext)),
        valid.operations.length,
        ctx.principalId,
        at,
      ],
    );
    for (const [index, operation] of valid.operations.entries()) {
      await tx.query(
        `INSERT INTO deep_action_operations (
           id, tenant_id, task_id, op_key, position, connection_id,
           capability_key, target, payload, expectation, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'pending')`,
        [
          operationIds[index],
          ctx.tenantId,
          taskId,
          operation.key,
          index + 1,
          operation.connectionId,
          operation.capabilityKey,
          operation.target,
          JSON.stringify(operation.payload),
          JSON.stringify(operation.expectation),
        ],
      );
    }
    if (valid.idempotencyKey !== null) {
      await tx.query(
        `INSERT INTO deep_action_idempotency (id, tenant_id, task_id, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), ctx.tenantId, taskId, valid.idempotencyKey, at],
      );
    }
    await recordEvent(tx, ctx, taskId, 'created', clampDetail(valid.taskContext.description), at);
  });

  const task = mapTask((await findTaskRow(db, ctx, taskId))!);
  const operations = (await listOperationRows(db, ctx, taskId)).map(mapOperation);
  return { task, operations, created: true };
}

function taskRecord(task: ValidatedTaskContext): DeepActionTaskContext {
  return { description: task.description, requestedFor: task.requestedFor };
}

// ---------------------------------------------------------------------------
// DISCOVER — the execution surface across every connected system
// ---------------------------------------------------------------------------

export async function discoverExecutionSurface(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateDiscoverSurfaceInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['draft']);
  const operations = await listOperationRows(db, ctx, task.id);

  // Resolve every DISTINCT connection the plan touches (in plan order),
  // through the owning contracts: the broker connection (W082), the
  // progressive-access envelope (W083) and the live inventory surface
  // (W081). Nothing is discovered that is not connected and enveloped.
  const connectionOrder: string[] = [];
  const byConnection = new Map<string, OperationRow[]>();
  for (const operation of operations) {
    if (!byConnection.has(operation.connection_id)) {
      byConnection.set(operation.connection_id, []);
      connectionOrder.push(operation.connection_id);
    }
    byConnection.get(operation.connection_id)!.push(operation);
  }

  const at = now();
  const surfaceRows: Array<{
    connectionId: string;
    system: InventorySystem;
    access: ConnectionAccessView;
    readKeyByWriteKey: Map<string, string>;
  }> = [];

  for (const connectionId of connectionOrder) {
    const connection = await loadConnection(ctx, connectionId);
    if (connection.status !== 'connected') {
      throw new DeepActionsError(
        'connection_not_connected',
        `connection '${connectionId}' is '${connection.status}', not 'connected' — a disconnected connection confers no capability`,
      );
    }
    const access = await loadAccess(ctx, connectionId);
    const system = await loadSystem(ctx, access.systemId);

    // Every planned operation on this connection must be executable AND
    // verifiable: the WRITE capability must be on the live surface, and a
    // READ capability of the same class must exist (verification is part
    // of the contract — a write you cannot verify is not a deep action).
    const readKeyByWriteKey = new Map<string, string>();
    for (const operation of byConnection.get(connectionId)!) {
      const capability = system.capabilities.find((entry) => entry.key === operation.capability_key);
      if (capability === undefined) {
        throw new DeepActionsError(
          'capability_not_offered',
          `capability '${operation.capability_key}' is not on the surface of '${system.displayName}' — the offered capabilities are ${system.capabilities.map((c) => c.key).join(', ')}`,
        );
      }
      if (capability.mode !== 'write') {
        throw new DeepActionsError(
          'capability_not_offered',
          `capability '${operation.capability_key}' on '${system.displayName}' is a ${capability.mode} capability — deep-action operations exercise WRITE capabilities`,
        );
      }
      const readKey = readCapabilityKeyOf(operation.capability_key);
      const readCapability = system.capabilities.find(
        (entry) => entry.key === readKey && entry.mode === 'read',
      );
      if (readCapability === undefined) {
        throw new DeepActionsError(
          'read_capability_missing',
          `no read capability '${readKey}' on the surface of '${system.displayName}' — the downstream state of '${operation.target}' could not be verified, so the write is refused`,
        );
      }
      readKeyByWriteKey.set(operation.capability_key, readKey);
    }
    surfaceRows.push({ connectionId, system, access, readKeyByWriteKey });
  }

  await db.transaction(async (tx) => {
    for (const entry of surfaceRows) {
      await tx.query(
        `INSERT INTO deep_action_surface (
           id, tenant_id, task_id, connection_id, system_id, system_key,
           system_display_name, read_capabilities, write_capabilities,
           active_grant_keys, connection_mode, discovered_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
         ON CONFLICT (tenant_id, task_id, connection_id) DO UPDATE SET
           system_id = EXCLUDED.system_id,
           system_key = EXCLUDED.system_key,
           system_display_name = EXCLUDED.system_display_name,
           read_capabilities = EXCLUDED.read_capabilities,
           write_capabilities = EXCLUDED.write_capabilities,
           active_grant_keys = EXCLUDED.active_grant_keys,
           connection_mode = EXCLUDED.connection_mode,
           discovered_at = EXCLUDED.discovered_at`,
        [
          newId(),
          ctx.tenantId,
          task.id,
          entry.connectionId,
          entry.system.id,
          entry.system.systemKey,
          entry.system.displayName,
          JSON.stringify(entry.access.readCapabilities),
          JSON.stringify(entry.access.writeCapabilities),
          JSON.stringify(entry.access.activeGrants.map((grant) => grant.key)),
          entry.access.connectionMode,
          at,
        ],
      );
    }
    for (const entry of surfaceRows) {
      for (const operation of byConnection.get(entry.connectionId)!) {
        await tx.query(
          `UPDATE deep_action_operations SET
             system_id = $3, system_key = $4, system_display_name = $5,
             read_capability_key = $6
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            operation.id,
            entry.system.id,
            entry.system.systemKey,
            entry.system.displayName,
            entry.readKeyByWriteKey.get(operation.capability_key)!,
          ],
        );
      }
    }
    const transitioned = await transitionTask(tx, ctx, task.id, ['draft'], 'discovered', at);
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        'surface-discovered',
        clampDetail(
          `${surfaceRows.length} connected system(s): ${surfaceRows.map((s) => s.system.displayName).join(', ')}`,
        ),
        at,
      );
    }
  });

  return getDeepActionDetail(ctx, task.id);
}

// ---------------------------------------------------------------------------
// INSPECT — the pre-execution state of every target, as evidence
// ---------------------------------------------------------------------------

export async function inspectTargets(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateInspectTargetsInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['discovered']);
  const operations = await listOperationRows(db, ctx, task.id);
  const transport = requireTransport();

  const connections = new Map<string, BrokerConnection>();
  for (const operation of operations) {
    if (!connections.has(operation.connection_id)) {
      connections.set(operation.connection_id, await loadConnection(ctx, operation.connection_id));
    }
  }

  const at = now();
  const evidence = new Map<string, Observation>();
  for (const operation of operations) {
    // Crash-resumable at operation granularity: an operation that already
    // carries its pre-state evidence is not re-read.
    if (operation.pre_state_observation_id !== null) continue;

    const connection = connections.get(operation.connection_id)!;
    await invokeReadCapability(ctx, operation, task);
    const rawState = await transport.inspect({
      connectionId: operation.connection_id,
      credentialRef: connection.credentialRef ?? '',
      systemKey: operation.system_key!,
      capabilityKey: operation.read_capability_key!,
      target: operation.target,
      idempotencyKey: `deep-action:${task.id}:${operation.id}:inspect`,
    });
    const state = canonicalizeStateResult(rawState, operation.op_key);
    const observation = await recordStateObservation(ctx, {
      kind: PRE_STATE_OBSERVATION_KIND,
      operation: mapOperation(operation),
      taskId: task.id,
      state,
      at,
    });
    evidence.set(operation.id, observation);
  }

  await db.transaction(async (tx) => {
    for (const [operationId, observation] of evidence) {
      await tx.query(
        `UPDATE deep_action_operations SET pre_state_observation_id = $3
           WHERE tenant_id = $1 AND id = $2 AND pre_state_observation_id IS NULL`,
        [ctx.tenantId, operationId, observation.id],
      );
    }
    const transitioned = await transitionTask(tx, ctx, task.id, ['discovered'], 'inspected', at);
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        'targets-inspected',
        clampDetail(`${operations.length} target(s) read as pre-execution evidence`),
        at,
      );
    }
  });

  return getDeepActionDetail(ctx, task.id);
}

/** Invokes an operation's READ capability through the W083 gate (the floor). */
async function invokeReadCapability(
  ctx: TenantContext,
  operation: OperationRow,
  task: TaskRow,
): Promise<CapabilityInvocation> {
  const invocation = await invokeCapability(ctx, {
    connectionId: operation.connection_id,
    capabilityKey: operation.read_capability_key!,
    taskContext: {
      description: task.task_context.description,
      requestedFor: task.task_context.requestedFor,
    },
  });
  if (invocation.outcome === 'denied') {
    // A denied READ means the capability left the surface between discover
    // and inspect — verification is impossible, so the read refuses.
    throw new DeepActionsError(
      'read_capability_missing',
      `the read capability '${operation.read_capability_key}' was denied on connection '${operation.connection_id}' — the downstream state of '${operation.target}' cannot be verified`,
    );
  }
  return invocation;
}

// ---------------------------------------------------------------------------
// PROPOSE — the plan through the W009 gate
// ---------------------------------------------------------------------------

/** The approver-facing payload: the full plan, exactly as it will execute. */
function buildProposalPayload(
  task: TaskRow,
  operations: OperationRow[],
  surface: SurfaceRow[],
): unknown {
  return {
    taskId: task.id,
    taskContext: task.task_context,
    surface: surface.map((entry) => ({
      system: entry.system_display_name,
      connectionMode: entry.connection_mode,
      activeGrantKeys: entry.active_grant_keys,
    })),
    operations: operations.map((operation) => ({
      key: operation.op_key,
      system: operation.system_display_name,
      capability: operation.capability_key,
      target: operation.target,
      payload: operation.payload,
      expectation: operation.expectation,
      preStateObservationId: operation.pre_state_observation_id,
    })),
  };
}

/** The deterministic human-readable justification the approver reads. */
function buildProposalJustification(task: TaskRow, surface: SurfaceRow[]): string {
  const systems = surface.map((entry) => entry.system_display_name).join(', ');
  return `execute the multi-system task "${task.task_context.description}" across ${surface.length} connected system${surface.length === 1 ? '' : 's'} (${systems}): ${task.operation_count} authorized write${task.operation_count === 1 ? '' : 's'}, each verified against its expected downstream state`;
}

export async function proposeDeepAction(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateProposeDeepActionInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['inspected']);
  const operations = await listOperationRows(db, ctx, task.id);
  const surface = await listSurfaceRows(db, ctx, task.id);

  const at = now();
  // The consequential gate: kind 'deep-action' at EXECUTE — under the
  // built-in default matrix this WAITS for a human decision (W009).
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: DEEP_ACTION_ACTION_KIND,
      authorityLevel: 'EXECUTE',
      payload: buildProposalPayload(task, operations, surface),
      justification: buildProposalJustification(task, surface),
      idempotencyKey: `deep-action:${task.id}:gate`,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      // Our gate inputs are pre-validated; a rejection here contradicts
      // the actions contract — stay loud rather than silently ungated.
      throw new Error(
        `the authority gate rejected a pre-validated deep-action proposal (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  const rejected = request.status === 'rejected';
  await db.transaction(async (tx) => {
    const transitioned = await transitionTask(
      tx,
      ctx,
      task.id,
      ['inspected'],
      rejected ? 'rejected' : 'proposed',
      at,
      {
        actionRequestId: request.id,
        rejectionReason: rejected
          ? 'the tenant authority policy forbids executing this deep action (policy decision at proposal)'
          : undefined,
      },
    );
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        rejected ? 'gate-rejected' : 'proposed',
        clampDetail(`W009 action request ${request.id} — ${request.status}`),
        at,
      );
    }
  });

  return getDeepActionDetail(ctx, task.id);
}

// ---------------------------------------------------------------------------
// AUTHORIZE — the W009 decision plus the per-operation W083 capability gate
// ---------------------------------------------------------------------------

export async function authorizeDeepAction(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateAuthorizeDeepActionInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['proposed']);
  const operations = await listOperationRows(db, ctx, task.id);

  // The W009 gate record decides first — a pending proposal has no
  // authority to invoke anything.
  let request: ActionRequest;
  try {
    request = await getActionRequest(ctx, { requestId: task.action_request_id! });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'action_request_not_found') {
      throw new Error(
        `deep-action task '${task.id}' references action request '${task.action_request_id}' which no longer exists (internal invariant violation)`,
        { cause: error },
      );
    }
    throw error;
  }
  if (request.status === 'pending') {
    throw new DeepActionsError(
      'gate_not_decided',
      `the proposal for deep-action task '${task.id}' is still awaiting its human approval (W009 action request ${request.id})`,
    );
  }
  if (request.status === 'rejected') {
    const at = now();
    await db.transaction(async (tx) => {
      const transitioned = await transitionTask(
        tx,
        ctx,
        task.id,
        ['proposed'],
        'rejected',
        at,
        {
          rejectionReason:
            'the human approver rejected the deep-action proposal (W009 decision)',
        },
      );
      if (transitioned !== null) {
        await recordEvent(
          tx,
          ctx,
          task.id,
          'gate-rejected',
          clampDetail(`W009 action request ${request.id} rejected`),
          at,
        );
      }
    });
    return getDeepActionDetail(ctx, task.id);
  }

  // Approved: every operation's write capability rides through the W083
  // gate. DENIAL STOPS THE WRITE — the first denied invocation parks the
  // whole task 'rejected' with the gate's own human-readable reason.
  const at = now();
  const allowed = new Map<string, CapabilityInvocation>();
  let denial: { operation: OperationRow; invocation: CapabilityInvocation } | null = null;
  for (const operation of operations) {
    if (operation.invocation_id !== null) continue; // crash-resumable
    const invocation = await invokeCapability(ctx, {
      connectionId: operation.connection_id,
      capabilityKey: operation.capability_key,
      taskContext: {
        description: task.task_context.description,
        requestedFor: task.task_context.requestedFor,
      },
    });
    if (invocation.outcome === 'denied') {
      denial = { operation, invocation };
      break;
    }
    allowed.set(operation.id, invocation);
  }

  await db.transaction(async (tx) => {
    for (const [operationId, invocation] of allowed) {
      await tx.query(
        `UPDATE deep_action_operations SET invocation_id = $3, state = 'authorized'
           WHERE tenant_id = $1 AND id = $2 AND invocation_id IS NULL`,
        [ctx.tenantId, operationId, invocation.id],
      );
    }
    if (denial !== null) {
      await tx.query(
        `UPDATE deep_action_operations SET denial_invocation_id = $3, state = 'denied'
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, denial.operation.id, denial.invocation.id],
      );
      const transitioned = await transitionTask(
        tx,
        ctx,
        task.id,
        ['proposed'],
        'rejected',
        at,
        {
          rejectionReason: clampDetail(
            denial.invocation.denial?.reason ??
              `the capability gate denied '${denial.operation.capability_key}' on '${denial.operation.system_display_name}'`,
            2000,
          ),
        },
      );
      if (transitioned !== null) {
        await recordEvent(
          tx,
          ctx,
          task.id,
          'operation-denied',
          clampDetail(
            `operation '${denial.operation.op_key}' denied at the capability gate (invocation ${denial.invocation.id})`,
          ),
          at,
        );
      }
      return;
    }
    const transitioned = await transitionTask(tx, ctx, task.id, ['proposed'], 'authorized', at);
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        'authorized',
        clampDetail(`${operations.length} operation(s) authorized under active grants`),
        at,
      );
    }
  });

  return getDeepActionDetail(ctx, task.id);
}

// ---------------------------------------------------------------------------
// EXECUTE — the writes, one receipt per operation
// ---------------------------------------------------------------------------

export async function executeDeepAction(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateExecuteDeepActionInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['authorized', 'failed']);
  const operations = await listOperationRows(db, ctx, task.id);
  const transport = requireTransport();

  // A permanent provider refusal cannot be retried into success.
  const permanentlyRefused = operations.find(
    (operation) => operation.state === 'failed' && operation.receipt_status === 'rejected',
  );
  if (permanentlyRefused !== undefined) {
    throw new DeepActionsError(
      'operation_rejected',
      `operation '${permanentlyRefused.op_key}' carries a permanent provider refusal — the deep-action task cannot be re-executed`,
    );
  }

  const connections = new Map<string, BrokerConnection>();
  for (const operation of operations) {
    if (!connections.has(operation.connection_id)) {
      connections.set(operation.connection_id, await loadConnection(ctx, operation.connection_id));
    }
  }

  const at = now();
  let failure: { operation: OperationRow; receipt: DeepActionReceipt } | null = null;
  for (const operation of operations) {
    // Resumable: executed operations are never re-executed (their receipts
    // and evidence already stand); the first open operation continues.
    if (operation.state === 'executed' || operation.state === 'verified') continue;

    const connection = connections.get(operation.connection_id)!;
    const rawReceipt = await transport.execute({
      connectionId: operation.connection_id,
      credentialRef: connection.credentialRef ?? '',
      systemKey: operation.system_key!,
      capabilityKey: operation.capability_key,
      target: operation.target,
      payload: operation.payload,
      idempotencyKey: `deep-action:${task.id}:${operation.id}:execute`,
    });
    const receipt = canonicalizeReceipt(rawReceipt, operation.op_key);

    await db.transaction(async (tx) => {
      if (receipt.status === 'accepted') {
        await tx.query(
          `UPDATE deep_action_operations SET
             state = 'executed', receipt_status = 'accepted', receipt_id = $3,
             receipt_detail = $4, executed_at = $5
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, operation.id, receipt.receiptId, receipt.detail, at],
        );
        await recordEvent(
          tx,
          ctx,
          task.id,
          'operation-executed',
          clampDetail(
            `operation '${operation.op_key}' accepted${receipt.receiptId === null ? '' : ` (provider receipt ${receipt.receiptId})`}`,
          ),
          at,
        );
      } else {
        failure = { operation, receipt };
        await tx.query(
          `UPDATE deep_action_operations SET
             state = 'failed', receipt_status = $3, receipt_id = $4, receipt_detail = $5
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, operation.id, receipt.status, receipt.receiptId, receipt.detail],
        );
        await recordEvent(
          tx,
          ctx,
          task.id,
          'execution-failed',
          clampDetail(
            `operation '${operation.op_key}' ${receipt.status}: ${receipt.detail ?? 'no detail'}`,
          ),
          at,
        );
      }
    });
    if (failure !== null) break;
  }

  if (failure !== null) {
    await db.transaction(async (tx) => {
      await transitionTask(tx, ctx, task.id, ['authorized', 'failed'], 'failed', at, {
        rejectionReason: clampDetail(
          `operation '${failure!.operation.op_key}' ${failure!.receipt.status}: ${failure!.receipt.detail ?? 'no detail'}`,
          2000,
        ),
      });
    });
    return getDeepActionDetail(ctx, task.id);
  }

  await db.transaction(async (tx) => {
    const transitioned = await transitionTask(tx, ctx, task.id, ['authorized', 'failed'], 'executed', at);
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        'executed',
        clampDetail(`${operations.length} operation(s) executed and accepted`),
        at,
      );
    }
  });

  return getDeepActionDetail(ctx, task.id);
}

// ---------------------------------------------------------------------------
// VERIFY — the action receipt AND the downstream state
// ---------------------------------------------------------------------------

export async function verifyDeepAction(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateVerifyDeepActionInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['executed']);
  const operations = await listOperationRows(db, ctx, task.id);
  const transport = requireTransport();

  const connections = new Map<string, BrokerConnection>();
  for (const operation of operations) {
    if (!connections.has(operation.connection_id)) {
      connections.set(operation.connection_id, await loadConnection(ctx, operation.connection_id));
    }
  }

  const at = now();
  const evidence = new Map<string, Observation>();
  for (const operation of operations) {
    // Crash-resumable at operation granularity.
    if (operation.post_state_observation_id !== null) continue;

    // 1. THE ACTION RECEIPT is verified: an executed write must carry an
    //    'accepted' receipt (verifyReceipt is the single definition).
    const receiptVerification = verifyReceipt(operation.receipt_status, operation.receipt_id);
    if (!receiptVerification.verified) {
      throw new DeepActionsError(
        'invalid_transport_result',
        `operation '${operation.op_key}' cannot be verified: ${receiptVerification.reason}`,
      );
    }

    // 2. THE DOWNSTREAM STATE is read back through the read path and
    //    recorded as fresh immutable evidence.
    const connection = connections.get(operation.connection_id)!;
    await invokeReadCapability(ctx, operation, task);
    const rawState = await transport.inspect({
      connectionId: operation.connection_id,
      credentialRef: connection.credentialRef ?? '',
      systemKey: operation.system_key!,
      capabilityKey: operation.read_capability_key!,
      target: operation.target,
      idempotencyKey: `deep-action:${task.id}:${operation.id}:verify`,
    });
    const state = canonicalizeStateResult(rawState, operation.op_key);
    const observation = await recordStateObservation(ctx, {
      kind: POST_STATE_OBSERVATION_KIND,
      operation: mapOperation(operation),
      taskId: task.id,
      state,
      receipt: { status: operation.receipt_status!, receiptId: operation.receipt_id },
      at,
    });
    evidence.set(operation.id, observation);
  }

  await db.transaction(async (tx) => {
    for (const [operationId, observation] of evidence) {
      const updated = await tx.query(
        `UPDATE deep_action_operations SET
           state = 'verified', post_state_observation_id = $3, verified_at = $4
         WHERE tenant_id = $1 AND id = $2 AND post_state_observation_id IS NULL
         RETURNING id`,
        [ctx.tenantId, operationId, observation.id, at],
      );
      if ((updated.rowCount ?? 0) === 0) {
        // The state CHECK requires executed_at for 'verified' — it is
        // always set by the execute phase; guard against drift loudly.
        throw new DeepActionsError(
          'operation_not_found',
          `operation '${operationId}' could not be marked verified — it may have been verified concurrently`,
        );
      }
    }
    const transitioned = await transitionTask(tx, ctx, task.id, ['executed'], 'verified', at);
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        'verified',
        clampDetail(`${operations.length} receipt(s) and downstream state(s) verified`),
        at,
      );
    }
  });

  return getDeepActionDetail(ctx, task.id);
}

// ---------------------------------------------------------------------------
// RECONCILE — expectation vs observed downstream state
// ---------------------------------------------------------------------------

export async function reconcileDeepAction(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<ReconcileResult> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateReconcileDeepActionInput(input);
  const db = getDb();
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['verified']);
  const operations = await listOperationRows(db, ctx, task.id);

  const at = now();
  const reconciliations = new Map<
    string,
    { verdict: OperationReconciliation; mismatchObservationId: string | null; unknownId: string | null }
  >();

  for (const operation of operations) {
    // Crash-resumable: already-reconciled operations stand.
    if (operation.state === 'matched' || operation.state === 'mismatched') continue;

    const [preState, postState] = await Promise.all([
      loadStateObservation(ctx, operation.pre_state_observation_id!, operation, 'pre-state'),
      loadStateObservation(ctx, operation.post_state_observation_id!, operation, 'post-state'),
    ]);
    const verdict = reconcileOperation(
      operation.expectation,
      stateOfObservation(postState),
      stateOfObservation(preState),
    );

    if (verdict.matched) {
      reconciliations.set(operation.id, {
        verdict,
        mismatchObservationId: null,
        unknownId: null,
      });
      continue;
    }

    // A MISMATCH creates ATTENTION and EVIDENCE (the acceptance core):
    // a third immutable observation (transformation of the two state
    // reads) and a consequential epistemics unknown linked to all three.
    const reason = buildMismatchReason({
      taskDescription: task.task_context.description,
      systemDisplayName: operation.system_display_name!,
      operationKey: operation.op_key,
      target: operation.target,
      mismatches: verdict.mismatches,
      stateUnchanged: verdict.stateUnchanged,
    });
    let mismatchObservation: Observation;
    try {
      mismatchObservation = await recordObservation(ctx, {
        kind: MISMATCH_OBSERVATION_KIND,
        payload: {
          taskId: task.id,
          operationKey: operation.op_key,
          target: operation.target,
          expectation: operation.expectation,
          observedState: stateOfObservation(postState),
          mismatches: verdict.mismatches,
          stateUnchanged: verdict.stateUnchanged,
          reason,
        },
        observedAt: at.toISOString(),
        source: { kind: 'system', id: operation.system_id, label: operation.system_display_name },
        channel: DEEP_ACTION_CHANNEL,
        lineage: {
          method: 'transformation',
          parents: [operation.pre_state_observation_id!, operation.post_state_observation_id!],
        },
        confidence: { ...RECONCILIATION_CONFIDENCE },
      });
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new Error(
          `the observations contract rejected a pre-validated reconciliation evidence record (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    let attention: Unknown;
    try {
      attention = await recordUnknown(ctx, {
        question: buildMismatchUnknownQuestion({
          taskDescription: task.task_context.description,
          systemDisplayName: operation.system_display_name!,
          operationKey: operation.op_key,
          target: operation.target,
        }),
        consequence: buildMismatchUnknownConsequence({
          systemDisplayName: operation.system_display_name!,
          target: operation.target,
          mismatchCount: verdict.mismatches.length,
        }),
        subject: { kind: 'deep-actions.task', id: task.id },
        relatedObservationIds: [
          operation.pre_state_observation_id!,
          operation.post_state_observation_id!,
          mismatchObservation.id,
        ],
        note: `deep-action task ${task.id}, operation '${operation.op_key}' (${operation.capability_key} on ${operation.system_display_name})`,
      });
    } catch (error) {
      if (error instanceof EpistemicsError) {
        throw new Error(
          `the epistemics contract rejected a pre-validated attention unknown (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    reconciliations.set(operation.id, {
      verdict,
      mismatchObservationId: mismatchObservation.id,
      unknownId: attention.id,
    });
  }

  const mismatchCount = operations.filter(
    (operation) =>
      operation.state === 'mismatched' ||
      reconciliations.get(operation.id)?.verdict.matched === false,
  ).length;

  await db.transaction(async (tx) => {
    for (const [operationId, result] of reconciliations) {
      await tx.query(
        `UPDATE deep_action_operations SET
           state = $3, mismatch_evidence_observation_id = $4, mismatch_unknown_id = $5,
           reconciled_at = $6
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          operationId,
          result.verdict.matched ? 'matched' : 'mismatched',
          result.mismatchObservationId,
          result.unknownId,
          at,
        ],
      );
    }
    const finalStatus: DeepActionStatus = mismatchCount > 0 ? 'mismatched' : 'reconciled';
    const transitioned = await transitionTask(tx, ctx, task.id, ['verified'], finalStatus, at, {
      mismatchCount,
    });
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        mismatchCount > 0 ? 'mismatch-detected' : 'reconciled',
        clampDetail(
          mismatchCount > 0
            ? `${mismatchCount} operation(s) mismatched — evidence and attention unknowns recorded`
            : `${operations.length} operation(s) reconciled clean`,
        ),
        at,
      );
    }
  });

  const detail = await getDeepActionDetail(ctx, task.id);
  return {
    task: detail.task,
    operations: detail.operations,
    mismatchEvidenceObservationIds: detail.operations
      .map((operation) => operation.mismatchEvidenceObservationId)
      .filter((id): id is string => id !== null),
    mismatchUnknownIds: detail.operations
      .map((operation) => operation.mismatchUnknownId)
      .filter((id): id is string => id !== null),
  };
}

/** Loads one of an operation's state observations (validated readable). */
async function loadStateObservation(
  ctx: TenantContext,
  observationId: string,
  operation: OperationRow,
  phase: 'pre-state' | 'post-state',
): Promise<Observation> {
  try {
    return await getObservation(ctx, observationId);
  } catch (error) {
    if (error instanceof ObservationsError && error.code === 'observation_not_found') {
      throw new Error(
        `deep-action operation '${operation.op_key}' references a ${phase} observation '${observationId}' that is no longer readable (internal invariant violation)`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getDeepActionDetail(ctx: TenantContext, taskId: string): Promise<DeepActionDetail> {
  const task = await loadTask(ctx, taskId);
  const operations = await listOperationRows(getDb(), ctx, taskId);
  const surface = await listSurfaceRows(getDb(), ctx, taskId);
  return {
    task: mapTask(task),
    operations: operations.map(mapOperation),
    surface: surface.map(mapSurface),
  };
}

export async function getDeepAction(
  ctx: TenantContext,
  query: GetDeepActionQuery,
): Promise<DeepActionDetail> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateGetDeepActionQuery(query);
  return getDeepActionDetail(ctx, valid.taskId);
}

export async function listDeepActions(
  ctx: TenantContext,
  query: ListDeepActionsQuery,
): Promise<DeepActionTask[]> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateListDeepActionsQuery(query);
  const rows = valid.status === null
    ? await getDb().query<TaskRow>(
        `SELECT * FROM deep_action_tasks
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC LIMIT $2`,
        [ctx.tenantId, valid.limit],
      )
    : await getDb().query<TaskRow>(
        `SELECT * FROM deep_action_tasks
          WHERE tenant_id = $1 AND status = $2
          ORDER BY created_at DESC, id DESC LIMIT $3`,
        [ctx.tenantId, valid.status, valid.limit],
      );
  return rows.rows.map(mapTask);
}

export async function listDeepActionEvents(
  ctx: TenantContext,
  query: ListDeepActionEventsQuery,
): Promise<DeepActionEvent[]> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateListDeepActionEventsQuery(query);
  // The task must exist in this tenant (no existence leak on the feed).
  await loadTask(ctx, valid.taskId);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM deep_action_events
       WHERE tenant_id = $1 AND task_id = $2
       ORDER BY recorded_at DESC, position DESC LIMIT $3`,
    [ctx.tenantId, valid.taskId, valid.limit],
  );
  return rows.rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// The W080 composition bridge — durable deep-action workflow runs
// ---------------------------------------------------------------------------

/** Registers the canonical deep-action workflow definition (idempotent). */
export async function registerDeepActionWorkflow(ctx: TenantContext): Promise<void> {
  await registerWorkflow(ctx, {
    key: DEEP_ACTION_WORKFLOW_KEY,
    title: DEEP_ACTION_WORKFLOW_TITLE,
    description: DEEP_ACTION_WORKFLOW_DESCRIPTION,
    spec: {
      steps: [
        {
          key: DEEP_ACTION_WORKFLOW_STEP,
          maxAttempts: 8,
          retryBackoffSeconds: 5,
          leaseSeconds: 600,
        },
      ],
    },
  });
}

/**
 * Starts (or replays) the durable workflow run of one deep-action task.
 * The task must still be 'draft' — the workflow owns the whole chain from
 * discover onward, so exactly one gate record ever exists per task.
 */
export async function startDeepActionRun(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<WorkflowRun> {
  assertDeepActionsTenantContext(ctx);
  const valid = validateDiscoverSurfaceInput(input);
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['draft']);
  await registerDeepActionWorkflow(ctx);
  return startRun(ctx, {
    definitionKey: DEEP_ACTION_WORKFLOW_KEY,
    input: { taskId: task.id },
    idempotencyKey: `deep-action-run:${task.id}`,
    triggerReference: task.id,
  });
}

/**
 * Executor bindings for the canonical deep-action workflow
 * (`deep-actions.execute`): ONE step drives the task through the whole
 * chain, checkpointing after each phase — the task's own durable status
 * IS the resume checkpoint, so a crashed worker's run resumes from
 * exactly where the task stands (W080 acceptance, lock 36).
 *
 * The proposal rides the workflow engine's own approval wait: the engine
 * routes it through `authorizeAction` under the run's ORIGINAL durable
 * context with the stable key `wf:<runId>:<stepNumber>:approval` (no
 * forked W009 semantics), and the wait survives worker death. On release
 * the binding freezes that gate record onto the task, then authorizes
 * (the W083 capability gates), executes, verifies and reconciles — one
 * phase per invocation, every phase a bounded unit of work.
 */
export function createDeepActionWorkflowBindings(ctx: TenantContext): WorkflowExecutorBindings {
  return {
    [DEEP_ACTION_WORKFLOW_KEY]: {
      [DEEP_ACTION_WORKFLOW_STEP]: async (
        invocation: WorkflowStepInvocation,
      ): Promise<WorkflowStepResult> => {
        const taskId = workflowTaskId(invocation.input);

        // A released approval wait is the only thing that moves a task
        // from 'inspected' onward in the workflow path. The const local
        // keeps TypeScript's narrowing inside the transaction closures.
        const wait = invocation.wait;
        if (wait !== null && wait.kind === 'approval') {
          if (wait.decision === 'rejected') {
            const at = now();
            await getDb().transaction(async (tx) => {
              const transitioned = await transitionTask(
                tx,
                ctx,
                taskId,
                ['inspected'],
                'rejected',
                at,
                {
                  actionRequestId: wait.requestId,
                  rejectionReason:
                    'the human approver rejected the deep-action proposal (W009 decision)',
                },
              );
              if (transitioned !== null) {
                await recordEvent(
                  tx,
                  ctx,
                  taskId,
                  'gate-rejected',
                  clampDetail(`W009 action request ${wait.requestId} rejected`),
                  at,
                );
              }
            });
            // DETERMINISTIC: a rejected approval is a human decision —
            // retrying the step cannot un-reject it.
            throw new WorkflowStepError(
              'deep_action_approval_rejected',
              'the deep-action approval was rejected — the run cannot proceed',
            );
          }
          // Approved: freeze the engine's gate record onto the task (the
          // one W009 decision that authorized this task).
          const at = now();
          await getDb().transaction(async (tx) => {
            const transitioned = await transitionTask(
              tx,
              ctx,
              taskId,
              ['inspected'],
              'proposed',
              at,
              { actionRequestId: wait.requestId },
            );
            if (transitioned !== null) {
              await recordEvent(
                tx,
                ctx,
                taskId,
                'proposed',
                clampDetail(`W009 action request ${wait.requestId} approved`),
                at,
              );
            }
          });
        }

        const current = await loadTask(ctx, taskId);
        switch (current.status) {
          case 'draft': {
            await discoverExecutionSurface(ctx, { taskId });
            await inspectTargets(ctx, { taskId });
            return approvalWaitOf(ctx, taskId);
          }
          case 'discovered': {
            await inspectTargets(ctx, { taskId });
            return approvalWaitOf(ctx, taskId);
          }
          case 'inspected': {
            return approvalWaitOf(ctx, taskId);
          }
          case 'proposed': {
            // Crash-recovery shape: the wait already released and the
            // gate record is frozen — continue into the capability gates.
            await authorizeDeepAction(ctx, { taskId });
            const authorized = await loadTask(ctx, taskId);
            if (authorized.status === 'rejected') {
              throw new WorkflowStepError(
                'deep_action_capability_denied',
                authorized.rejection_reason ?? 'the capability gate denied the write',
              );
            }
            return { type: 'checkpoint', progress: { phase: 'authorized' } };
          }
          case 'authorized': {
            await executeDeepAction(ctx, { taskId });
            const executed = await loadTask(ctx, taskId);
            if (executed.status === 'failed') {
              // Transient execution failure: the engine's retry policy
              // re-invokes this step; already-executed operations stand.
              throw new Error(
                `deep-action task ${taskId} failed during execution: ${executed.rejection_reason ?? 'unknown failure'}`,
              );
            }
            return { type: 'checkpoint', progress: { phase: 'executed' } };
          }
          case 'failed': {
            // Resume path (transient receipt): re-execute the open
            // operations. A permanent refusal dead-letters deterministically.
            try {
              await executeDeepAction(ctx, { taskId });
            } catch (error) {
              if (
                error instanceof DeepActionsError &&
                error.code === 'operation_rejected'
              ) {
                throw new WorkflowStepError('deep_action_operation_rejected', error.message);
              }
              throw error;
            }
            const executed = await loadTask(ctx, taskId);
            if (executed.status === 'failed') {
              throw new Error(
                `deep-action task ${taskId} failed during execution: ${executed.rejection_reason ?? 'unknown failure'}`,
              );
            }
            return { type: 'checkpoint', progress: { phase: 'executed' } };
          }
          case 'executed': {
            await verifyDeepAction(ctx, { taskId });
            return { type: 'checkpoint', progress: { phase: 'verified' } };
          }
          case 'verified': {
            const result = await reconcileDeepAction(ctx, { taskId });
            return {
              type: 'done',
              output: {
                taskId,
                status: result.task.status,
                mismatchCount: result.task.mismatchCount,
                mismatchUnknownIds: result.mismatchUnknownIds,
              },
            };
          }
          case 'reconciled':
          case 'mismatched': {
            return {
              type: 'done',
              output: {
                taskId,
                status: current.status,
                mismatchCount: current.mismatch_count,
              },
            };
          }
          case 'rejected': {
            throw new WorkflowStepError(
              'deep_action_rejected',
              current.rejection_reason ?? 'the deep-action task was rejected',
            );
          }
          default: {
            throw new WorkflowStepError(
              'deep_action_unexpected_state',
              `deep-action task ${taskId} is in an unexpected state '${current.status}'`,
            );
          }
        }
      },
    },
  };
}

/** Builds the approval-wait result for a task that has finished inspecting. */
async function approvalWaitOf(ctx: TenantContext, taskId: string): Promise<WorkflowStepResult> {
  const task = await loadTask(ctx, taskId);
  const operations = await listOperationRows(getDb(), ctx, taskId);
  const surface = await listSurfaceRows(getDb(), ctx, taskId);
  return {
    type: 'wait',
    wait: {
      kind: 'approval',
      approval: {
        actionKind: DEEP_ACTION_ACTION_KIND,
        authorityLevel: 'EXECUTE',
        payload: buildProposalPayload(task, operations, surface),
        justification: buildProposalJustification(task, surface),
      },
    },
  };
}

/** Validates the workflow run input ({ taskId }). */
function workflowTaskId(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    throw new WorkflowStepError('deep_action_invalid_input', 'the run input must be an object');
  }
  const taskId = (input as { taskId?: unknown }).taskId;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new WorkflowStepError('deep_action_invalid_input', "the run input must carry a 'taskId'");
  }
  return taskId;
}
