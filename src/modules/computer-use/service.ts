// Implementation of the computer-use module's public operations (see
// contract.ts). W093 — Browser and Computer-Use Fallback.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by `newId()` where
// the id is needed before the insert; timestamps come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`task_not_found`), no
// existence leak.
//
// W093 acceptance — "browser task is disposable and resumable; session
// credentials are isolated; observed state is verified before being
// treated as a result; failure produces actionable evidence" — is
// carried by these deliberate properties, all tested:
//
//   1. DISPOSABLE SESSIONS, DURABLE TASKS: every start/resume mints a
//      NEW session row bound to the task's per-(tenant,task) profile
//      key; the run loop follows the deep-actions no-in-flight-state
//      discipline (the pre-run status stands while the loop drives, so a
//      hard-killed process can never strand the task); verified steps
//      are the durable CHECKPOINT and are never re-executed; the
//      per-step driver idempotency key keeps a crash between
//      accept-and-record exactly-once (a honoring driver replays the
//      accepted result).
//
//   2. CREDENTIAL ISOLATION: the task carries only the OPAQUE
//      credentialRef; the profile key is minted from BOTH tenant and
//      task (`computer-use:tenant:<tenantId>:task:<taskId>`), so no two
//      tasks — and no two tenants — ever share browser state; the
//      reference is handed to the driver ONCE per session start and
//      materialized only inside the isolated profile. No value this
//      module persists (steps, events, sessions, traces, observations,
//      reasons) is ever derived from the secret.
//
//   3. VERIFICATION BEFORE RESULT: an accepted driver action is verified
//      against the step's expected shape with the W084 reconciliation
//      VERBATIM (`reconcileOperation` from the deep-actions contract —
//      no second evidence model); only a MATCHED verdict promotes the
//      step to 'verified'. A divergence parks the step 'mismatched'
//      with the W084 StateMismatch[] diff recorded as immutable
//      evidence plus an epistemics unknown (the attention record) — the
//      task ends 'mismatched', never "completed with warnings".
//
//   4. GOVERNED AUTOMATION: the frozen plan is allowlist-checked at
//      creation, at dispatch (defense in depth — a step that could not
//      pass is 'blocked' with the decision as evidence) and by the
//      driver's own copy; the step budget bounds the plan; provider
//      objects never cross (canonicalization rejects them loudly).
//
//   5. EVERY FAILURE IS EVIDENCE: blocked (the allowlist decision),
//      refused (the driver receipt), failed (the transient receipt) and
//      mismatched (the verification diff) each record an immutable
//      observation through the W004 contract — the SAME ledger the
//      deep-action pipeline writes — and getBrowserFailureEvidence
//      assembles the actionable bundle (trace, screenshot reference,
//      allowlist decision, verification diff) on demand.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ObservationsError,
  recordObservation,
  type Observation,
} from '@/modules/observations/contract';
import {
  EpistemicsError,
  recordUnknown,
  type Unknown,
} from '@/modules/epistemics/contract';
import { clampDetail, reconcileOperation, type StateMismatch } from '@/modules/deep-actions/contract';
import { ComputerUseError } from './errors';
import {
  buildBrowserMismatchReason,
  buildBrowserMismatchUnknownConsequence,
  buildBrowserMismatchUnknownQuestion,
  toJsonSafeMismatches,
} from './verify';
import {
  allowlistDecisionFor,
  assertComputerUseTenantContext,
  MAX_SESSION_STEPS,
  validateCreateBrowserTaskInput,
  validateGetBrowserTaskQuery,
  validateListBrowserTaskEventsQuery,
  validateListBrowserTasksQuery,
  validateResumeBrowserTaskInput,
  validateStartBrowserTaskInput,
  type ValidatedAction,
  type ValidatedAllowlist,
  type ValidatedTaskContext,
} from './validation';
import type {
  BrowserAction,
  BrowserAllowlist,
  BrowserActionResult,
  BrowserDriver,
  BrowserSession,
  BrowserSessionEndRequest,
  BrowserStepState,
  BrowserTask,
  BrowserTaskContext,
  BrowserTaskDetail,
  BrowserTaskEvent,
  BrowserTaskEventType,
  BrowserTaskStep,
  BrowserTaskStatus,
  BrowserFailureEvidence,
  CreateBrowserTaskInput,
  CreateBrowserTaskResult,
} from './types';
import type { BrowserVerb } from './types';
import {
  OBSERVED_STATE_OBSERVATION_KIND,
  STEP_FAILURE_OBSERVATION_KIND,
  VERIFICATION_MISMATCH_OBSERVATION_KIND,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** The provider-neutral channel key recorded on the module's evidence. */
const COMPUTER_USE_CHANNEL = 'computer-use';

/** The canonical confidence record attached to this module's evidence. */
type EvidenceConfidence = { value: number; method: string; basis: string };

/** Confidence of an observed page state read through the driver port. */
const DRIVER_READ_CONFIDENCE: EvidenceConfidence = {
  value: 0.95,
  method: 'computer-use-driver',
  basis: 'observed browser page state read through the governed computer-use driver port',
};

/** Confidence of deterministic verification evidence. */
const VERIFICATION_CONFIDENCE: EvidenceConfidence = {
  value: 1,
  method: 'deterministic-comparison',
  basis: 'expected page state compared against the observed page state (the W084 reconciliation, re-used verbatim)',
};

/** Confidence of a recorded governance/refusal outcome. */
const GOVERNANCE_CONFIDENCE: EvidenceConfidence = {
  value: 1,
  method: 'computer-use-governance',
  basis: 'the recorded allowlist decision and the driver receipt',
};

// ---------------------------------------------------------------------------
// The driver port wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

let wiredDriver: BrowserDriver | null = null;

/** Wires (or clears) the browser driver — the fallback's exit seam. */
export function setBrowserDriver(driver: BrowserDriver | null): void {
  wiredDriver = driver;
}

/** The currently wired browser driver (null = none). */
export function getBrowserDriver(): BrowserDriver | null {
  return wiredDriver;
}

function requireDriver(): BrowserDriver {
  if (wiredDriver === null) {
    throw new ComputerUseError(
      'driver_unavailable',
      'no browser driver is wired — setBrowserDriver first; the fallback refuses to fake success',
    );
  }
  return wiredDriver;
}

// ---------------------------------------------------------------------------
// Driver-result canonicalization (provider objects never cross)
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

/** A canonical driver result after the guards (the receipt + the evidence). */
interface CanonicalDriverResult {
  receipt: { status: 'accepted' | 'rejected' | 'failed'; receiptId: string | null; detail: string | null };
  observedState: { found: boolean; state: unknown } | null;
  screenshotRef: string | null;
  actionTrace: Record<string, unknown> | null;
}

/**
 * Canonicalizes one driver result: plain JSON only, modest sizes, the
 * W084 receipt taxonomy, and — the module's core rule — an ACCEPTED
 * action MUST carry its observed state (an unobserved action is never a
 * result). A provider object (class instance, symbol, cycle, oversized
 * body) CANNOT cross the boundary — it is rejected loudly here.
 */
function canonicalizeDriverResult(result: unknown, stepKey: string): CanonicalDriverResult {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a non-object result for step '${stepKey}' — provider objects never cross the boundary`,
    );
  }
  const proto = Object.getPrototypeOf(result);
  if (proto !== Object.prototype && proto !== null) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a provider result object for step '${stepKey}' — provider objects never cross the boundary`,
    );
  }
  const candidate = result as Partial<BrowserActionResult>;
  if (candidate.receipt === undefined || typeof candidate.receipt !== 'object' || candidate.receipt === null) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned no receipt for step '${stepKey}' — every performed action reports one`,
    );
  }
  const receiptProto = Object.getPrototypeOf(candidate.receipt);
  if (receiptProto !== Object.prototype && receiptProto !== null) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a provider receipt object for step '${stepKey}' — provider objects never cross the boundary`,
    );
  }
  const status = candidate.receipt.status;
  if (status !== 'accepted' && status !== 'rejected' && status !== 'failed') {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a receipt with an unknown status '${String(status)}' for step '${stepKey}' (the W084/W088 taxonomy: accepted | rejected | failed)`,
    );
  }
  const receiptId = candidate.receipt.receiptId ?? null;
  if (receiptId !== null && (typeof receiptId !== 'string' || receiptId.length === 0 || receiptId.length > 200)) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a receipt id that is not an opaque string of 1..200 characters for step '${stepKey}'`,
    );
  }
  const detail = candidate.receipt.detail ?? null;
  if (detail !== null && (typeof detail !== 'string' || detail.length > 500)) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a receipt detail exceeding 500 characters for step '${stepKey}'`,
    );
  }

  let observedState: { found: boolean; state: unknown } | null = null;
  if (candidate.observedState !== undefined && candidate.observedState !== null) {
    const observed = candidate.observedState;
    if (typeof observed !== 'object' || Array.isArray(observed)) {
      throw new ComputerUseError(
        'invalid_driver_result',
        `the browser driver returned a non-object observed state for step '${stepKey}'`,
      );
    }
    if (typeof observed.found !== 'boolean') {
      throw new ComputerUseError(
        'invalid_driver_result',
        `the browser driver returned an observed state without a boolean 'found' for step '${stepKey}'`,
      );
    }
    const state = observed.state === undefined ? null : observed.state;
    if (!isPlainJsonValue(state)) {
      throw new ComputerUseError(
        'invalid_driver_result',
        `the browser driver returned a non-JSON observed state for step '${stepKey}' — provider objects never cross the boundary`,
      );
    }
    const serialized = JSON.stringify(state) ?? 'null';
    if (serialized.length > 262_144) {
      throw new ComputerUseError(
        'invalid_driver_result',
        `the browser driver returned an observed state exceeding 262144 bytes for step '${stepKey}' — large artifacts belong in object storage behind opaque references`,
      );
    }
    observedState = { found: observed.found, state };
  }
  if (status === 'accepted' && observedState === null) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver accepted step '${stepKey}' without reporting the observed state — an unobserved action is never treated as a result`,
    );
  }

  const screenshotRef = candidate.screenshotRef ?? null;
  if (screenshotRef !== null && (typeof screenshotRef !== 'string' || screenshotRef.length === 0 || screenshotRef.length > 512)) {
    throw new ComputerUseError(
      'invalid_driver_result',
      `the browser driver returned a screenshot reference that is not an opaque string of 1..512 characters for step '${stepKey}'`,
    );
  }

  let actionTrace: Record<string, unknown> | null = null;
  if (candidate.actionTrace !== undefined && candidate.actionTrace !== null) {
    if (!isPlainJsonValue(candidate.actionTrace) || Array.isArray(candidate.actionTrace)) {
      throw new ComputerUseError(
        'invalid_driver_result',
        `the browser driver returned a non-JSON action trace for step '${stepKey}' — provider objects never cross the boundary`,
      );
    }
    const trace = candidate.actionTrace as Record<string, unknown>;
    const serialized = JSON.stringify(trace) ?? 'null';
    if (serialized.length > 262_144) {
      throw new ComputerUseError(
        'invalid_driver_result',
        `the browser driver returned an action trace exceeding 262144 bytes for step '${stepKey}'`,
      );
    }
    actionTrace = trace;
  }

  return { receipt: { status, receiptId, detail }, observedState, screenshotRef, actionTrace };
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface TaskRow extends DbRow {
  id: string;
  tenant_id: string;
  task_context: { description: string; requestedFor: string | null };
  allowlist: { urlGlobs: string[]; verbs: BrowserVerb[] };
  credential_ref: string | null;
  step_count: number;
  status: BrowserTaskStatus;
  mismatch_count: number;
  abort_reason: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StepRow extends DbRow {
  id: string;
  tenant_id: string;
  task_id: string;
  step_key: string;
  position: number;
  action: BrowserAction;
  expectation: unknown;
  state: BrowserStepState;
  allowlist_decision: Record<string, unknown> | null;
  receipt_status: 'accepted' | 'rejected' | 'failed' | null;
  receipt_id: string | null;
  receipt_detail: string | null;
  observed_state: { found: boolean; state: unknown } | null;
  observed_state_observation_id: string | null;
  screenshot_ref: string | null;
  action_trace: Record<string, unknown> | null;
  session_id: string | null;
  mismatch_evidence_observation_id: string | null;
  mismatch_unknown_id: string | null;
  executed_at: Date | string | null;
  verified_at: Date | string | null;
}

interface SessionRow extends DbRow {
  id: string;
  tenant_id: string;
  task_id: string;
  sequence: number;
  profile_key: string;
  status: BrowserSession['status'];
  steps_executed: number;
  started_at: Date | string;
  ended_at: Date | string | null;
  end_reason: string | null;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  task_id: string;
  position: number;
  event: BrowserTaskEventType;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapTask(row: TaskRow): BrowserTask {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskContext: {
      description: row.task_context.description,
      requestedFor: row.task_context.requestedFor ?? null,
    },
    allowlist: { urlGlobs: row.allowlist.urlGlobs, verbs: row.allowlist.verbs },
    credentialRef: row.credential_ref,
    stepCount: row.step_count,
    status: row.status,
    mismatchCount: row.mismatch_count,
    abortReason: row.abort_reason,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapStep(row: StepRow): BrowserTaskStep {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    key: row.step_key,
    position: row.position,
    action: row.action,
    expectation: row.expectation,
    state: row.state,
    allowlistDecision: row.allowlist_decision,
    receiptStatus: row.receipt_status,
    receiptId: row.receipt_id,
    receiptDetail: row.receipt_detail,
    observedStateObservationId: row.observed_state_observation_id,
    observedState: row.observed_state,
    screenshotRef: row.screenshot_ref,
    actionTrace: row.action_trace,
    sessionId: row.session_id,
    mismatchEvidenceObservationId: row.mismatch_evidence_observation_id,
    mismatchUnknownId: row.mismatch_unknown_id,
    executedAt: toIso(row.executed_at),
    verifiedAt: toIso(row.verified_at),
  };
}

function mapSession(row: SessionRow): BrowserSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    sequence: row.sequence,
    profileKey: row.profile_key,
    status: row.status,
    stepsExecuted: row.steps_executed,
    startedAt: toIso(row.started_at)!,
    endedAt: toIso(row.ended_at),
    endReason: row.end_reason,
  };
}

function mapEvent(row: EventRow): BrowserTaskEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    position: row.position,
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
    `SELECT * FROM browser_tasks WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, taskId],
  );
  return rows.rows[0] ?? null;
}

async function loadTask(ctx: TenantContext, taskId: string): Promise<TaskRow> {
  const row = await findTaskRow(getDb(), ctx, taskId);
  if (row === null) {
    throw new ComputerUseError(
      'task_not_found',
      `no browser task '${taskId}' exists in this tenant`,
    );
  }
  return row;
}

function requireTaskStatus(row: TaskRow, expected: readonly BrowserTaskStatus[]): TaskRow {
  if (!expected.includes(row.status)) {
    throw new ComputerUseError(
      'task_not_pending_phase',
      `browser task '${row.id}' is '${row.status}' — this operation requires ${expected.join(' or ')}`,
    );
  }
  return row;
}

async function listStepRows(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
): Promise<StepRow[]> {
  const rows = await db.query<StepRow>(
    `SELECT * FROM browser_task_steps WHERE tenant_id = $1 AND task_id = $2 ORDER BY position`,
    [ctx.tenantId, taskId],
  );
  return rows.rows;
}

async function listSessionRows(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
): Promise<SessionRow[]> {
  const rows = await db.query<SessionRow>(
    `SELECT * FROM browser_sessions WHERE tenant_id = $1 AND task_id = $2 ORDER BY sequence`,
    [ctx.tenantId, taskId],
  );
  return rows.rows;
}

async function recordEvent(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
  event: BrowserTaskEventType,
  detail: string | null,
  at: Date,
): Promise<void> {
  // Monotonic per-task position: the service clock can hold still within
  // one run (test-controllable time), so the audit feed stays ordered.
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM browser_task_events
        WHERE tenant_id = $1 AND task_id = $2`,
    [ctx.tenantId, taskId],
  );
  await db.query(
    `INSERT INTO browser_task_events (id, tenant_id, task_id, position, event, detail, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), ctx.tenantId, taskId, next.rows[0]?.next ?? 1, event, detail, ctx.principalId, at],
  );
}

/** Forward-only task status transition (guarded; returns null when lost). */
async function transitionTask(
  db: Queryable,
  ctx: TenantContext,
  taskId: string,
  from: readonly BrowserTaskStatus[],
  to: BrowserTaskStatus,
  at: Date,
  extra?: { abortReason?: string | null; mismatchCount?: number },
): Promise<TaskRow | null> {
  const rows = await db.query<TaskRow>(
    `UPDATE browser_tasks SET
        status = $3,
        abort_reason = $4,
        mismatch_count = $5,
        updated_at = $6
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($7::text[])
      RETURNING *`,
    [
      ctx.tenantId,
      taskId,
      to,
      extra?.abortReason ?? null,
      extra?.mismatchCount ?? 0,
      at,
      [...from],
    ],
  );
  return rows.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Evidence helpers (immutable observations through the W004 contract)
// ---------------------------------------------------------------------------

function evidenceSource(): { kind: 'external'; id: null; label: string } {
  return { kind: 'external', id: null, label: 'computer-use browser driver' };
}

async function recordEvidenceObservation(
  ctx: TenantContext,
  input: {
    kind: string;
    taskId: string;
    payload: Record<string, unknown>;
    confidence: EvidenceConfidence;
    at: Date;
  },
): Promise<Observation> {
  try {
    return await recordObservation(ctx, {
      kind: input.kind,
      payload: {
        taskId: input.taskId,
        ...input.payload,
      },
      observedAt: input.at.toISOString(),
      source: evidenceSource(),
      channel: COMPUTER_USE_CHANNEL,
      confidence: { ...input.confidence },
    });
  } catch (error) {
    if (error instanceof ObservationsError) {
      // Our evidence inputs are system-minted; a rejection here
      // contradicts the observations contract — stay loud rather than
      // silently unevidenced.
      throw new Error(
        `the observations contract rejected a pre-validated computer-use evidence record (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function recordAttentionUnknown(
  ctx: TenantContext,
  input: {
    taskId: string;
    stepKey: string;
    url: string;
    question: string;
    consequence: string;
    reason: string;
    relatedObservationIds: string[];
    at: Date;
  },
): Promise<Unknown> {
  try {
    return await recordUnknown(ctx, {
      question: input.question,
      consequence: input.consequence,
      subject: { kind: 'computer-use.task', id: input.taskId },
      relatedObservationIds: input.relatedObservationIds,
      note: `browser task ${input.taskId}, step '${input.stepKey}' on ${input.url}: ${input.reason}`,
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
}

// ---------------------------------------------------------------------------
// createBrowserTask — the governed plan, frozen
// ---------------------------------------------------------------------------

export async function createBrowserTask(
  ctx: TenantContext,
  input: CreateBrowserTaskInput,
): Promise<CreateBrowserTaskResult> {
  assertComputerUseTenantContext(ctx);
  const valid = validateCreateBrowserTaskInput(input);

  const db = getDb();
  const at = now();

  // Idempotent replay: a recorded key returns the original task.
  if (valid.idempotencyKey !== null) {
    const existing = await db.query<TaskRow>(
      `SELECT t.* FROM browser_tasks t
          JOIN browser_task_idempotency k ON k.task_id = t.id AND k.tenant_id = t.tenant_id
         WHERE t.tenant_id = $1 AND k.idempotency_key = $2`,
      [ctx.tenantId, valid.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      return {
        task: mapTask(row),
        steps: (await listStepRows(db, ctx, row.id)).map(mapStep),
        created: false,
      };
    }
  }

  const taskId = newId();
  const stepIds = valid.steps.map(() => newId());

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO browser_tasks (
          id, tenant_id, task_context, allowlist, credential_ref, step_count,
          status, mismatch_count, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 'draft', 0, $7, $8, $8)`,
      [
        taskId,
        ctx.tenantId,
        JSON.stringify(taskRecord(valid.taskContext)),
        JSON.stringify(allowlistRecord(valid.allowlist)),
        valid.credentialRef,
        valid.steps.length,
        ctx.principalId,
        at,
      ],
    );
    for (const [index, step] of valid.steps.entries()) {
      await tx.query(
        `INSERT INTO browser_task_steps (
            id, tenant_id, task_id, step_key, position, action, expectation, state
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending')`,
        [
          stepIds[index],
          ctx.tenantId,
          taskId,
          step.key,
          index + 1,
          JSON.stringify(actionRecord(step.action)),
          JSON.stringify(step.expectation),
        ],
      );
    }
    if (valid.idempotencyKey !== null) {
      await tx.query(
        `INSERT INTO browser_task_idempotency (id, tenant_id, task_id, idempotency_key, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
        [newId(), ctx.tenantId, taskId, valid.idempotencyKey, at],
      );
    }
    await recordEvent(tx, ctx, taskId, 'created', clampDetail(valid.taskContext.description), at);
  });

  const task = mapTask((await findTaskRow(db, ctx, taskId))!);
  const steps = (await listStepRows(db, ctx, taskId)).map(mapStep);
  return { task, steps, created: true };
}

function taskRecord(task: ValidatedTaskContext): BrowserTaskContext {
  return { description: task.description, requestedFor: task.requestedFor };
}

function allowlistRecord(allowlist: ValidatedAllowlist): BrowserAllowlist {
  return { urlGlobs: [...allowlist.urlGlobs], verbs: [...allowlist.verbs] };
}

function actionRecord(action: ValidatedAction): BrowserAction {
  return {
    verb: action.verb,
    url: action.url,
    selector: action.selector,
    value: action.value,
    secretField: action.secretField,
  };
}

// ---------------------------------------------------------------------------
// The governed run loop (start / resume share it)
// ---------------------------------------------------------------------------

/**
 * The ISOLATED per-(tenant,task) browser profile key — minted from BOTH
 * the tenant and the task, so no two tasks (and no two tenants) ever
 * share browser profile state. The driver keeps profile state (cookies,
 * storage, the materialized credential store) scoped to exactly this key.
 */
export function browserProfileKey(tenantId: string, taskId: string): string {
  return `computer-use:tenant:${tenantId}:task:${taskId}`;
}

export async function startBrowserTask(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<BrowserTaskDetail> {
  assertComputerUseTenantContext(ctx);
  const valid = validateStartBrowserTaskInput(input);
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['draft']);
  return runGovernedLoop(ctx, task, 'started');
}

export async function resumeBrowserTask(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<BrowserTaskDetail> {
  assertComputerUseTenantContext(ctx);
  const valid = validateResumeBrowserTaskInput(input);
  const task = requireTaskStatus(await loadTask(ctx, valid.taskId), ['suspended', 'failed']);
  return runGovernedLoop(ctx, task, 'resumed');
}

/**
 * THE GOVERNED RUN LOOP — one disposable session drives the frozen plan
 * from the durable checkpoint (the first non-verified step). The loop
 * ends on the first verdict that is not a verified step: every ending
 * (completed, failed, suspended, mismatched, aborted) leaves its links
 * behind on the task, the step, the session and the evidence ledger.
 */
async function runGovernedLoop(
  ctx: TenantContext,
  task: TaskRow,
  lifecycleEvent: 'started' | 'resumed',
): Promise<BrowserTaskDetail> {
  requireDriver(); // fail fast before any session is minted (drivePlan re-requires)
  const db = getDb();
  const at = now();
  const steps = await listStepRows(db, ctx, task.id);
  const sessions = await listSessionRows(db, ctx, task.id);

  // Mint the NEXT disposable session, bound to the isolated profile.
  const sessionId = newId();
  const sequence = sessions.length + 1;
  const profileKey = browserProfileKey(ctx.tenantId, task.id);
  const allowlist: BrowserAllowlist = {
    urlGlobs: task.allowlist.urlGlobs,
    verbs: task.allowlist.verbs,
  };

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO browser_sessions (
          id, tenant_id, task_id, sequence, profile_key, status, steps_executed, started_at
        ) VALUES ($1, $2, $3, $4, $5, 'running', 0, $6)`,
      [sessionId, ctx.tenantId, task.id, sequence, profileKey, at],
    );
    await recordEvent(
      tx,
      ctx,
      task.id,
      lifecycleEvent,
      clampDetail(`session ${sequence} on profile ${profileKey}`),
      at,
    );
  });

  let run: DrivePlanResult;
  try {
    run = await drivePlan(ctx, task, steps, sessionId, profileKey, allowlist);
  } catch (error) {
    // An unexpected mid-run failure (a non-canonical driver result, an
    // evidence-contract refusal): park resumable exactly like a worker
    // death — but propagate loudly (a wiring bug must never look like
    // success).
    await parkInterrupted(
      ctx,
      task,
      sessionId,
      sequence,
      null,
      clampDetail(
        `the run failed unexpectedly mid-loop: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    throw error;
  }

  if (run.ending === 'crashed') {
    // THE SUSPEND PATH: the worker/session died without a verdict. Open
    // steps stay open; the task parks resumable at the checkpoint; the
    // session is marked 'interrupted'.
    await parkInterrupted(
      ctx,
      task,
      sessionId,
      sequence,
      run.stepsExecuted,
      clampDetail(
        `the browser driver died mid-run at step '${run.crashedStepKey}': ${run.crashedMessage ?? 'no detail'}`,
      ),
    );
    return await getBrowserTaskDetail(ctx, task.id);
  }

  if (run.ending === 'completed') {
    // Every step verified: the only outcome state.
    const doneAt = now();
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE browser_sessions SET
            status = 'completed', ended_at = $3, end_reason = $4, steps_executed = $5
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, sessionId, doneAt, 'all steps verified', run.stepsExecuted],
      );
      const transitioned = await transitionTask(tx, ctx, task.id, [task.status], 'completed', doneAt);
      if (transitioned !== null) {
        await recordEvent(
          tx,
          ctx,
          task.id,
          'completed',
          clampDetail(`all ${steps.length} step(s) executed and verified in session ${sequence}`),
          doneAt,
        );
      }
    });
  }
  // 'ended': a governed ending (failed/aborted/mismatched) already
  // transitioned the task and closed the session inside the loop.
  return await getBrowserTaskDetail(ctx, task.id);
}

// ---------------------------------------------------------------------------
// The plan driver — one session's walk over the frozen plan
// ---------------------------------------------------------------------------

/** What driving the plan produced for the orchestrating run loop. */
interface DrivePlanResult {
  /**
   * 'completed' — every step verified (the orchestrator completes the
   * task); 'ended' — a governed ending (failed/aborted/mismatched)
   * already transitioned inside the loop; 'crashed' — the driver died
   * mid-run (the orchestrator parks the task resumable).
   */
  ending: 'completed' | 'ended' | 'crashed';
  crashedStepKey: string | null;
  crashedMessage: string | null;
  stepsExecuted: number;
}

/**
 * THE GOVERNED RUN LOOP'S CORE — one disposable session drives the frozen
 * plan from the durable checkpoint (the first open step). Owns the
 * driver-session lifecycle: the session is closed (best effort) on EVERY
 * exit path, and an unexpected internal failure is rethrown after the
 * close so the orchestrator can park the task resumable.
 */
async function drivePlan(
  ctx: TenantContext,
  task: TaskRow,
  steps: StepRow[],
  sessionId: string,
  profileKey: string,
  allowlist: BrowserAllowlist,
): Promise<DrivePlanResult> {
  const driver = requireDriver();
  const db = getDb();
  let sessionKey: string | null = null;
  let sessionSteps = 0;
  let sessionReason: 'completed' | 'failed' | 'aborted' | 'mismatched' = 'completed';
  let crashedStepKey: string | null = null;
  let crashedMessage: string | null = null;
  let unexpected = false;
  const ended = (): DrivePlanResult => ({
    ending: 'ended',
    crashedStepKey: null,
    crashedMessage: null,
    stepsExecuted: sessionSteps,
  });

  try {
    const started = await driver.startSession({
      taskId: task.id,
      profileKey,
      credentialRef: task.credential_ref,
      allowlist,
    });
    if (
      typeof started !== 'object' ||
      started === null ||
      typeof started.sessionKey !== 'string' ||
      started.sessionKey.length === 0 ||
      started.sessionKey.length > 200
    ) {
      throw new ComputerUseError(
        'invalid_driver_result',
        'the browser driver returned a session key that is not an opaque string of 1..200 characters',
      );
    }
    sessionKey = started.sessionKey;

    // The previous verified step's observed state (the verification
    // pre-state — the "accepted but the page never moved" flag).
    let previousVerifiedState: unknown = null;
    for (const step of steps) {
      if (step.state === 'verified' && step.observed_state !== null) {
        previousVerifiedState = step.observed_state.state;
      }
    }

    for (const step of steps) {
      // THE CHECKPOINT: verified steps are never re-executed — their
      // evidence already stands (mismatched/blocked/refused steps can
      // never be reached: those endings park the task terminally). A
      // 'failed' step IS open — a transient failure retries in the
      // fresh session (the deep-actions resume discipline).
      if (
        step.state === 'verified' ||
        step.state === 'mismatched' ||
        step.state === 'blocked' ||
        step.state === 'refused'
      ) {
        continue;
      }

      // The session budget guard (defense in depth — see validation.ts).
      if (sessionSteps >= MAX_SESSION_STEPS) {
        sessionReason = 'failed';
        await endRun(ctx, task, sessionId, 'failed', {
          stepsExecuted: sessionSteps,
          event: 'step-failed',
          eventDetail: clampDetail(
            `the session step budget (${MAX_SESSION_STEPS}) was exhausted before step '${step.step_key}' — the run is parked resumable`,
          ),
          endReason: clampDetail(`session step budget (${MAX_SESSION_STEPS}) exhausted`),
        });
        return ended();
      }

      // THE SERVICE-SIDE ALLOWLIST CHECK (defense in depth: the plan was
      // already checked at creation — a step that could not pass now is
      // 'blocked' with the decision itself as evidence).
      const decision = allowlistDecisionFor(allowlist, step.action);
      if (!decision.allowed) {
        sessionReason = 'aborted';
        await endRun(ctx, task, sessionId, 'aborted', {
          stepsExecuted: sessionSteps,
          step,
          stepState: 'blocked',
          stepPatch: { allowlist_decision: decision as unknown as Record<string, unknown>, session_id: sessionId },
          event: 'step-blocked',
          eventDetail: clampDetail(
            `step '${step.step_key}' blocked by the allowlist: ${decision.reason}`,
          ),
          abortReason: clampDetail(
            `step '${step.step_key}' blocked by the governed allowlist: ${decision.reason}`,
          ),
          evidence: {
            kind: STEP_FAILURE_OBSERVATION_KIND,
            payload: {
              stepKey: step.step_key,
              position: step.position,
              url: step.action.url,
              failureKind: 'blocked',
              allowlistDecision: decision,
            },
            confidence: GOVERNANCE_CONFIDENCE,
          },
        });
        return ended();
      }

      // Drive the canonical action envelope through the port.
      let rawResult: unknown;
      try {
        rawResult = await driver.performAction({
          sessionKey,
          taskId: task.id,
          stepKey: step.step_key,
          idempotencyKey: `computer-use:${task.id}:${step.id}:perform`,
          action: step.action,
        });
      } catch (error) {
        // THE WORKER/SESSION DEATH: the driver itself died mid-run. The
        // session is disposable — the task parks resumable at the
        // checkpoint; the profile's continuity is what survives.
        crashedStepKey = step.step_key;
        crashedMessage = error instanceof Error ? error.message : String(error);
        break;
      }
      const result = canonicalizeDriverResult(rawResult, step.step_key);
      sessionSteps += 1;

      if (result.receipt.status === 'rejected') {
        sessionReason = 'aborted';
        await endRun(ctx, task, sessionId, 'aborted', {
          stepsExecuted: sessionSteps,
          step,
          stepState: 'refused',
          stepPatch: {
            allowlist_decision: decision as unknown as Record<string, unknown>,
            receipt_status: 'rejected',
            receipt_id: result.receipt.receiptId,
            receipt_detail: result.receipt.detail,
            session_id: sessionId,
          },
          event: 'step-refused',
          eventDetail: clampDetail(
            `step '${step.step_key}' permanently refused by the browser driver: ${result.receipt.detail ?? 'no detail'}`,
          ),
          abortReason: clampDetail(
            `step '${step.step_key}' permanently refused by the browser driver: ${result.receipt.detail ?? 'no detail'}`,
          ),
          evidence: {
            kind: STEP_FAILURE_OBSERVATION_KIND,
            payload: {
              stepKey: step.step_key,
              position: step.position,
              url: step.action.url,
              failureKind: 'refused',
              allowlistDecision: decision,
              receipt: {
                status: result.receipt.status,
                receiptId: result.receipt.receiptId,
                detail: result.receipt.detail,
              },
            },
            confidence: GOVERNANCE_CONFIDENCE,
          },
        });
        return ended();
      }

      if (result.receipt.status === 'failed') {
        sessionReason = 'failed';
        await endRun(ctx, task, sessionId, 'failed', {
          stepsExecuted: sessionSteps,
          step,
          stepState: 'failed',
          stepPatch: {
            allowlist_decision: decision as unknown as Record<string, unknown>,
            receipt_status: 'failed',
            receipt_id: result.receipt.receiptId,
            receipt_detail: result.receipt.detail,
            session_id: sessionId,
          },
          event: 'step-failed',
          eventDetail: clampDetail(
            `step '${step.step_key}' failed transiently: ${result.receipt.detail ?? 'no detail'} — the task is resumable in a fresh session`,
          ),
          evidence: {
            kind: STEP_FAILURE_OBSERVATION_KIND,
            payload: {
              stepKey: step.step_key,
              position: step.position,
              url: step.action.url,
              failureKind: 'step-failed',
              allowlistDecision: decision,
              receipt: {
                status: result.receipt.status,
                receiptId: result.receipt.receiptId,
                detail: result.receipt.detail,
              },
            },
            confidence: GOVERNANCE_CONFIDENCE,
          },
        });
        return ended();
      }

      // ACCEPTED: the observed page state is recorded as immutable
      // evidence FIRST (with the screenshot reference and the redacted
      // action trace) — then, and only then, verified.
      const observedObservation = await recordEvidenceObservation(ctx, {
        kind: OBSERVED_STATE_OBSERVATION_KIND,
        taskId: task.id,
        payload: {
          stepKey: step.step_key,
          position: step.position,
          verb: step.action.verb,
          url: step.action.url,
          found: result.observedState!.found,
          observedState: result.observedState!.state,
          receipt: {
            status: result.receipt.status,
            receiptId: result.receipt.receiptId,
          },
          screenshotRef: result.screenshotRef,
          actionTrace: result.actionTrace,
        },
        confidence: DRIVER_READ_CONFIDENCE,
        at: now(),
      });

      // VERIFICATION BEFORE RESULT: the W084 reconciliation, verbatim.
      const verdict = reconcileOperation(
        step.expectation,
        result.observedState!.state,
        previousVerifiedState,
      );

      if (!verdict.matched) {
        // A verification failure is EVIDENCE, not a result: the diff
        // (W084 StateMismatch[], JSON-safe — absence encodes as null) is
        // recorded as a second immutable observation and an attention
        // unknown — the task ends 'mismatched', never "completed with
        // warnings".
        const mismatches = toJsonSafeMismatches(verdict.mismatches);
        const reason = buildBrowserMismatchReason({
          taskDescription: task.task_context.description,
          stepKey: step.step_key,
          url: step.action.url,
          mismatches,
          stateUnchanged: verdict.stateUnchanged,
        });
        const mismatchObservation = await recordEvidenceObservation(ctx, {
          kind: VERIFICATION_MISMATCH_OBSERVATION_KIND,
          taskId: task.id,
          payload: {
            stepKey: step.step_key,
            position: step.position,
            url: step.action.url,
            mismatches,
            stateUnchanged: verdict.stateUnchanged,
            reason,
          },
          confidence: VERIFICATION_CONFIDENCE,
          at: now(),
        });
        const unknown = await recordAttentionUnknown(ctx, {
          taskId: task.id,
          stepKey: step.step_key,
          url: step.action.url,
          question: buildBrowserMismatchUnknownQuestion({
            taskDescription: task.task_context.description,
            stepKey: step.step_key,
            url: step.action.url,
          }),
          consequence: buildBrowserMismatchUnknownConsequence({
            stepKey: step.step_key,
            url: step.action.url,
          }),
          reason,
          relatedObservationIds: [observedObservation.id, mismatchObservation.id],
          at: now(),
        });
        sessionReason = 'mismatched';
        await endRun(ctx, task, sessionId, 'mismatched', {
          stepsExecuted: sessionSteps,
          step,
          stepState: 'mismatched',
          stepPatch: {
            allowlist_decision: decision as unknown as Record<string, unknown>,
            receipt_status: 'accepted',
            receipt_id: result.receipt.receiptId,
            receipt_detail: result.receipt.detail,
            observed_state: result.observedState,
            observed_state_observation_id: observedObservation.id,
            screenshot_ref: result.screenshotRef,
            action_trace: result.actionTrace,
            session_id: sessionId,
            mismatch_evidence_observation_id: mismatchObservation.id,
            mismatch_unknown_id: unknown.id,
            executed_at: now(),
          },
          event: 'step-mismatch-detected',
          eventDetail: clampDetail(
            `step '${step.step_key}' executed and accepted, but the observed state diverged (${mismatches.length} field(s)) — mismatch evidence and attention recorded`,
          ),
          taskStatus: 'mismatched',
          mismatchCount: 1,
        });
        return ended();
      }

      // VERIFIED — the checkpoint advances.
      const verifiedAt = now();
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE browser_task_steps SET
              state = 'verified',
              allowlist_decision = $3::jsonb,
              receipt_status = 'accepted',
              receipt_id = $4,
              receipt_detail = $5,
              observed_state = $6::jsonb,
              observed_state_observation_id = $7,
              screenshot_ref = $8,
              action_trace = $9::jsonb,
              session_id = $10,
              executed_at = $11,
              verified_at = $11
            WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            step.id,
            JSON.stringify(decision),
            result.receipt.receiptId,
            result.receipt.detail,
            JSON.stringify(result.observedState),
            observedObservation.id,
            result.screenshotRef,
            JSON.stringify(result.actionTrace),
            sessionId,
            verifiedAt,
          ],
        );
        await recordEvent(
          tx,
          ctx,
          task.id,
          'step-executed',
          clampDetail(
            `step '${step.step_key}' accepted${result.receipt.receiptId === null ? '' : ` (driver receipt ${result.receipt.receiptId})`}`,
          ),
          verifiedAt,
        );
        await recordEvent(
          tx,
          ctx,
          task.id,
          'step-verified',
          clampDetail(
            `step '${step.step_key}' observed state verified against the expected shape${result.screenshotRef === null ? '' : ` (screenshot ${result.screenshotRef})`}`,
          ),
          verifiedAt,
        );
      });
      previousVerifiedState = result.observedState!.state;
    }

    if (crashedStepKey !== null) {
      return {
        ending: 'crashed',
        crashedStepKey,
        crashedMessage,
        stepsExecuted: sessionSteps,
      };
    }
    return {
      ending: 'completed',
      crashedStepKey: null,
      crashedMessage: null,
      stepsExecuted: sessionSteps,
    };
  } catch (error) {
    // An unexpected internal failure (non-canonical driver result, an
    // evidence-contract refusal): rethrow after the session close below —
    // the orchestrator parks the task resumable and the error propagates.
    unexpected = true;
    throw error;
  } finally {
    // The session is DISPOSABLE: close it on every exit path (best
    // effort — a crashed driver may refuse; the session row is the
    // service-side truth either way).
    if (sessionKey !== null) {
      const reason: BrowserSessionEndRequest['reason'] =
        crashedStepKey !== null || unexpected ? 'interrupted' : sessionReason;
      try {
        await driver.endSession({ sessionKey, reason, detail: null });
      } catch {
        // A driver that died cannot close its own session — the
        // disposable half of the model means this is expected, not fatal.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The suspend path (worker death / unexpected mid-run failure)
// ---------------------------------------------------------------------------

/**
 * Parks a run mid-flight as RESUMABLE: the live session is marked
 * 'interrupted' (only if it is still 'running' — a terminal session is
 * evidence that must not be rewritten) and the task transitions to
 * 'suspended' from its pre-run status (the guarded transition no-ops on
 * an already-terminal task). The verified steps ARE the checkpoint a
 * fresh session resumes from — worker death never loses the task.
 */
async function parkInterrupted(
  ctx: TenantContext,
  task: TaskRow,
  sessionId: string,
  sequence: number,
  sessionSteps: number | null,
  reason: string,
): Promise<void> {
  const at = now();
  await getDb().transaction(async (tx) => {
    await tx.query(
      `UPDATE browser_sessions SET
          status = 'interrupted', ended_at = $3, end_reason = $4,
          steps_executed = COALESCE($5, steps_executed)
        WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
      [ctx.tenantId, sessionId, at, reason, sessionSteps],
    );
    const transitioned = await transitionTask(tx, ctx, task.id, [task.status], 'suspended', at);
    if (transitioned !== null) {
      await recordEvent(
        tx,
        ctx,
        task.id,
        'suspended',
        clampDetail(
          `session ${sequence} interrupted — the task is resumable from the checkpoint (${reason})`,
        ),
        at,
      );
    }
  });
}

/** One ending of the run loop: step patch + session end + task transition + event (+ evidence). */
async function endRun(
  ctx: TenantContext,
  task: TaskRow,
  sessionId: string,
  sessionStatus: 'failed' | 'aborted' | 'mismatched',
  input: {
    stepsExecuted: number;
    step?: StepRow;
    stepState?: BrowserStepState;
    stepPatch?: Record<string, unknown>;
    event: BrowserTaskEventType;
    eventDetail: string | null;
    abortReason?: string;
    taskStatus?: BrowserTaskStatus;
    mismatchCount?: number;
    endReason?: string;
    evidence?: {
      kind: string;
      payload: Record<string, unknown>;
      confidence: EvidenceConfidence;
    };
  },
): Promise<void> {
  const at = now();
  // EVERY FAILURE IS EVIDENCE: the immutable observation is recorded
  // through the W004 contract BEFORE the state moves (the same ledger
  // the deep-action pipeline writes).
  if (input.evidence !== undefined) {
    await recordEvidenceObservation(ctx, {
      kind: input.evidence.kind,
      taskId: task.id,
      payload: input.evidence.payload,
      confidence: input.evidence.confidence,
      at,
    });
  }

  // The patchable step columns (fixed vocabulary — identifiers cannot
  // be parameterized in SQL, so the keys are pinned here, never
  // caller-supplied).
  const PATCHABLE_STEP_COLUMNS = new Set([
    'allowlist_decision',
    'receipt_status',
    'receipt_id',
    'receipt_detail',
    'observed_state',
    'observed_state_observation_id',
    'screenshot_ref',
    'action_trace',
    'session_id',
    'mismatch_evidence_observation_id',
    'mismatch_unknown_id',
    'executed_at',
  ]);
  const JSON_STEP_COLUMNS = new Set(['allowlist_decision', 'observed_state', 'action_trace']);

  await getDb().transaction(async (tx) => {
    if (input.step !== undefined && input.stepState !== undefined) {
      const patch = { ...(input.stepPatch ?? {}) };
      const sets: string[] = ['state = $3'];
      const values: unknown[] = [ctx.tenantId, input.step.id, input.stepState];
      let parameter = 4;
      for (const [column, value] of Object.entries(patch)) {
        if (!PATCHABLE_STEP_COLUMNS.has(column)) {
          throw new Error(
            `internal invariant violation: unpatchable step column '${column}'`,
          );
        }
        const json = JSON_STEP_COLUMNS.has(column);
        sets.push(`${column} = ${json ? `$${parameter}::jsonb` : `$${parameter}`}`);
        values.push(json ? JSON.stringify(value) : value);
        parameter += 1;
      }
      await tx.query(
        `UPDATE browser_task_steps SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`,
        values,
      );
    }
    await tx.query(
      `UPDATE browser_sessions SET
          status = $3, ended_at = $4, end_reason = $5, steps_executed = $6
        WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        sessionId,
        sessionStatus,
        at,
        clampDetail(input.endReason ?? input.eventDetail ?? sessionStatus),
        input.stepsExecuted,
      ],
    );
    const transitioned = await transitionTask(
      tx,
      ctx,
      task.id,
      [task.status],
      input.taskStatus ?? (sessionStatus === 'failed' ? 'failed' : 'aborted'),
      at,
      {
        abortReason: input.abortReason ?? null,
        mismatchCount: input.mismatchCount ?? 0,
      },
    );
    if (transitioned !== null) {
      await recordEvent(tx, ctx, task.id, input.event, input.eventDetail, at);
    }
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getBrowserTaskDetail(ctx: TenantContext, taskId: string): Promise<BrowserTaskDetail> {
  const task = await loadTask(ctx, taskId);
  const db = getDb();
  return {
    task: mapTask(task),
    steps: (await listStepRows(db, ctx, task.id)).map(mapStep),
    sessions: (await listSessionRows(db, ctx, task.id)).map(mapSession),
  };
}

export async function getBrowserTask(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<BrowserTaskDetail> {
  assertComputerUseTenantContext(ctx);
  const valid = validateGetBrowserTaskQuery(input);
  return getBrowserTaskDetail(ctx, valid.taskId);
}

export async function listBrowserTasks(
  ctx: TenantContext,
  input: Record<string, unknown> | undefined | null,
): Promise<BrowserTask[]> {
  assertComputerUseTenantContext(ctx);
  const valid = validateListBrowserTasksQuery(input);
  const rows = await getDb().query<TaskRow>(
    `SELECT * FROM browser_tasks WHERE tenant_id = $1
       AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
    [ctx.tenantId, valid.status, valid.limit],
  );
  return rows.rows.map(mapTask);
}

export async function listBrowserTaskEvents(
  ctx: TenantContext,
  input: { taskId: string; limit?: number },
): Promise<BrowserTaskEvent[]> {
  assertComputerUseTenantContext(ctx);
  const valid = validateListBrowserTaskEventsQuery(input);
  await loadTask(ctx, valid.taskId); // uniform not-found, no existence leak
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM browser_task_events WHERE tenant_id = $1 AND task_id = $2
       ORDER BY recorded_at DESC, position DESC
       LIMIT $3`,
    [ctx.tenantId, valid.taskId, valid.limit],
  );
  return rows.rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// getBrowserFailureEvidence — the actionable bundle
// ---------------------------------------------------------------------------

export async function getBrowserFailureEvidence(
  ctx: TenantContext,
  input: { taskId: string },
): Promise<BrowserFailureEvidence | null> {
  assertComputerUseTenantContext(ctx);
  const valid = validateGetBrowserTaskQuery(input);
  const task = await loadTask(ctx, valid.taskId);
  if (task.status === 'draft' || task.status === 'completed') {
    // Nothing ran (draft) or nothing failed (completed): no bundle.
    return null;
  }
  const db = getDb();
  const steps = await listStepRows(db, ctx, task.id);
  const sessions = (await listSessionRows(db, ctx, task.id)).map(mapSession);

  const failing = steps.find(
    (step) => step.state === 'blocked' || step.state === 'refused' || step.state === 'failed' || step.state === 'mismatched',
  );
  const interruptedSession = sessions.find((session) => session.status === 'interrupted');
  const lastSession = sessions[sessions.length - 1] ?? null;

  // The verification diff is RECOMPUTED deterministically from the
  // stored expectation and observed states (reconciliation is a
  // computation, not an opinion — lock 10), then JSON-encoded exactly as
  // the recorded evidence encodes it.
  let mismatches: StateMismatch[] = [];
  let stateUnchanged: boolean | null = null;
  if (failing !== undefined && failing.state === 'mismatched' && failing.observed_state !== null) {
    const priorVerified = steps
      .filter((step) => step.position < failing.position && step.state === 'verified' && step.observed_state !== null)
      .pop();
    const verdict = reconcileOperation(
      failing.expectation,
      failing.observed_state.state,
      priorVerified?.observed_state?.state ?? null,
    );
    mismatches = toJsonSafeMismatches(verdict.mismatches);
    stateUnchanged = verdict.stateUnchanged;
  }

  if (failing !== undefined) {
    const failureKind =
      failing.state === 'blocked'
        ? 'blocked'
        : failing.state === 'refused'
          ? 'refused'
          : failing.state === 'failed'
            ? 'step-failed'
            : 'mismatch';
    const reason =
      failing.state === 'mismatched'
        ? buildBrowserMismatchReason({
            taskDescription: task.task_context.description,
            stepKey: failing.step_key,
            url: failing.action.url,
            mismatches,
            stateUnchanged: stateUnchanged ?? false,
          })
        : failing.state === 'blocked'
          ? `Step '${failing.step_key}' was blocked by the governed allowlist: ${
              (failing.allowlist_decision as { reason?: string } | null)?.reason ?? 'no recorded reason'
            }. The refusal is evidence: widen the allowlist deliberately or change the plan (a changed plan is a new task).`
          : `Step '${failing.step_key}' was ${failing.state === 'refused' ? 'permanently refused' : 'transiently failed'} by the browser driver: ${failing.receipt_detail ?? 'no detail'}${
              failing.state === 'failed' ? '. The task is resumable — a fresh session retries the step.' : '. The refusal is evidence — the driver cannot execute this action.'
            }`;
    return {
      taskId: task.id,
      failureKind,
      reason,
      step: {
        key: failing.step_key,
        position: failing.position,
        action: failing.action,
        state: failing.state,
        allowlistDecision: failing.allowlist_decision,
        receiptStatus: failing.receipt_status,
        receiptId: failing.receipt_id,
        receiptDetail: failing.receipt_detail,
        screenshotRef: failing.screenshot_ref,
        actionTrace: failing.action_trace,
        observedStateObservationId: failing.observed_state_observation_id,
        mismatchEvidenceObservationId: failing.mismatch_evidence_observation_id,
        mismatchUnknownId: failing.mismatch_unknown_id,
        mismatches,
        stateUnchanged,
      },
      session:
        sessions.find((session) => session.id === failing.session_id) ?? lastSession,
    };
  }

  if (task.status === 'aborted') {
    return {
      taskId: task.id,
      failureKind: 'blocked',
      reason: task.abort_reason ?? 'the task was aborted',
      step: null,
      session: lastSession,
    };
  }

  if (interruptedSession !== undefined) {
    return {
      taskId: task.id,
      failureKind: 'interrupted',
      reason: `The browser session was interrupted mid-run (${interruptedSession.endReason ?? 'no recorded reason'}). The task is resumable: verified steps are the durable checkpoint, and a fresh session continues from the first open step.`,
      step: null,
      session: interruptedSession,
    };
  }

  return {
    taskId: task.id,
    failureKind: 'budget',
    reason: 'The run parked resumable without a step-level verdict (the session step budget guard).',
    step: null,
    session: lastSession,
  };
}
