// Implementation of the workflow module's data operations (W080 — see
// contract.ts for the public surface). Conventions (IMPLEMENTATION-STACK
// §3/§8): all SQL goes through the db port with `$n` placeholders; ids
// are uuids minted by PostgreSQL (`gen_random_uuid()`); timestamps come
// from the injectable clock and are never caller-supplied; every
// statement is scoped by the explicit TenantContext (ADR-0001) —
// cross-tenant access is indistinguishable from a missing record
// (`definition_not_found` / `run_not_found` / `schedule_not_found` /
// `event_not_found` — no existence leak).
//
// W080 acceptance properties carried here:
//   * IDEMPOTENCY — every materialization path (manual start, event
//     dispatch, schedule firing) writes through UNIQUE dedupe keys and
//     first-write-wins semantics, so retried/crashed/replayed callers
//     cannot double-start runs (the events module's replay discipline).
//   * DURABILITY — an event dispatch materializes the event row, all
//     triggered runs and all delivered signals in ONE transaction; a
//     crash mid-dispatch leaves either everything or nothing.
//   * DEFINITION VERSIONING — spec content lives in append-only
//     workflow_definition_versions; runs freeze their version, so run
//     history reconstructs against the exact program that produced it.
//
// The engine (engine.ts) composes these operations (plus its own claim /
// persist SQL) behind the port. Row mappers are exported for that
// purpose but deliberately NOT re-exported by contract.ts.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { EventsError, getEvent } from '@/modules/events/contract';
import { WorkflowError } from './errors';
import {
  cronOccurrencesBetween,
  nextCronOccurrence,
  parseCron,
} from './cron';
import { eventRunIdempotencyKey, scheduleRunIdempotencyKey } from './machine';
import {
  assertWorkflowTenantContext,
  validateCancelRunInput,
  validateCreateScheduleInput,
  validateDefinitionQuery,
  validateDispatchEventInput,
  validateEventQuery,
  validateListDefinitionsQuery,
  validateListRunsQuery,
  validateListSchedulesQuery,
  validateRegisterWorkflowInput,
  validateResumeRunInput,
  validateRunQuery,
  validateRunStepAttemptsQuery,
  validateRunStepsQuery,
  validateSetScheduleActiveInput,
  validateStartRunInput,
  MAX_SCHEDULE_OCCURRENCES_PER_SWEEP,
  type ValidatedStepSpec,
} from './validation';
import type {
  RegisterWorkflowInput,
  ResumeRunInput,
  ScheduleEvaluationResult,
  StartRunInput,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowEventDispatch,
  WorkflowRun,
  WorkflowRunSignal,
  WorkflowRunStep,
  WorkflowSchedule,
  WorkflowStepAttempt,
  CreateScheduleInput,
  CancelRunInput,
  DispatchWorkflowEventInput,
  GetRunQuery,
  GetWorkflowDefinitionQuery,
  GetWorkflowEventQuery,
  ListRunStepAttemptsQuery,
  ListRunStepsQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  ListWorkflowDefinitionsQuery,
  SetScheduleActiveInput,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes and mappers
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

interface DefinitionRow extends DbRow {
  id: string;
  tenant_id: string;
  key: string;
  version: number;
  status: 'active' | 'retired';
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  // Joined from the current version row.
  title: string;
  description: string | null;
  spec: { steps: ValidatedStepSpec[]; eventTriggers?: string[] };
}

/** Internal row shapes (exported for the engine's joined queries). */
export interface RunRow extends DbRow {
  id: string;
  tenant_id: string;
  definition_id: string;
  definition_key: string;
  definition_version: number;
  idempotency_key: string | null;
  status: WorkflowRun['status'];
  current_step: number;
  total_steps: number;
  trigger_kind: WorkflowRun['trigger'];
  trigger_event_id: string | null;
  trigger_schedule_id: string | null;
  trigger_reference: string | null;
  input: unknown;
  result: unknown;
  error_code: string | null;
  error_detail: string | null;
  cancel_requested_at: Date | string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  run_principal: string;
  run_authority: string[];
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

export interface StepRow extends DbRow {
  id: string;
  tenant_id: string;
  run_id: string;
  step_number: number;
  step_key: string;
  status: WorkflowRunStep['status'];
  invocation_count: number;
  attempt_count: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  lease_seconds: number;
  wait_kind: WorkflowRunStep['waitKind'];
  wait_resume_at: Date | string | null;
  wait_action_request_id: string | null;
  wait_event_type: string | null;
  wait_note: string | null;
  checkpoint: unknown;
  output: unknown;
  error_code: string | null;
  error_detail: string | null;
  retry_not_before: Date | string | null;
  lease_expires_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  updated_at: Date | string;
}

interface AttemptRow extends DbRow {
  id: string;
  tenant_id: string;
  run_id: string;
  step_number: number;
  invocation: number;
  outcome: WorkflowStepAttempt['outcome'];
  wait_kind: WorkflowStepAttempt['waitKind'];
  error_code: string | null;
  error_detail: string | null;
  checkpoint: unknown;
  started_at: Date | string;
  finished_at: Date | string;
  recorded_by: string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: unknown;
  domain_event_id: string | null;
  idempotency_key: string | null;
  occurred_at: Date | string;
  dispatched_by: string;
}

interface ScheduleRow extends DbRow {
  id: string;
  tenant_id: string;
  definition_key: string;
  cron: string;
  timezone: 'UTC';
  active: boolean;
  input: unknown;
  last_occurrence_at: Date | string | null;
  next_occurrence_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SignalRow extends DbRow {
  id: string;
  tenant_id: string;
  run_id: string;
  kind: 'event' | 'resume';
  payload: unknown;
  note: string | null;
  event_id: string | null;
  delivered_by: string;
  delivered_at: Date | string;
  consumed_at: Date | string | null;
}

/** Map a definition row (joined with its current version). */
export function mapDefinitionRow(row: DefinitionRow): WorkflowDefinition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    version: row.version,
    title: row.title,
    description: row.description,
    spec: {
      steps: row.spec.steps,
      eventTriggers: row.spec.eventTriggers ?? [],
    },
    status: row.status,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapRunRow(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    definitionId: row.definition_id,
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    trigger: row.trigger_kind,
    triggerEventId: row.trigger_event_id,
    triggerScheduleId: row.trigger_schedule_id,
    triggerReference: row.trigger_reference,
    input: row.input,
    result: row.result,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    cancelRequestedAt: toIsoOrNull(row.cancel_requested_at),
    cancelReason: row.cancel_reason,
    cancelledBy: row.cancelled_by,
    runPrincipal: row.run_principal,
    runAuthority: row.run_authority ?? [],
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: toIsoOrNull(row.started_at),
    finishedAt: toIsoOrNull(row.finished_at),
  };
}

export function mapStepRow(row: StepRow): WorkflowRunStep {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    stepNumber: row.step_number,
    stepKey: row.step_key,
    status: row.status,
    invocationCount: row.invocation_count,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    leaseSeconds: row.lease_seconds,
    waitKind: row.wait_kind,
    waitResumeAt: toIsoOrNull(row.wait_resume_at),
    waitActionRequestId: row.wait_action_request_id,
    waitEventType: row.wait_event_type,
    waitNote: row.wait_note,
    checkpoint: row.checkpoint,
    output: row.output,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    retryNotBefore: toIsoOrNull(row.retry_not_before),
    leaseExpiresAt: toIsoOrNull(row.lease_expires_at),
    startedAt: toIsoOrNull(row.started_at),
    finishedAt: toIsoOrNull(row.finished_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapAttemptRow(row: AttemptRow): WorkflowStepAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    stepNumber: row.step_number,
    invocation: row.invocation,
    outcome: row.outcome,
    waitKind: row.wait_kind,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    checkpoint: row.checkpoint,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    recordedBy: row.recorded_by,
  };
}

export function mapEventRow(row: EventRow): WorkflowEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    payload: row.payload,
    domainEventId: row.domain_event_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: toIso(row.occurred_at),
    dispatchedBy: row.dispatched_by,
  };
}

export function mapScheduleRow(row: ScheduleRow): WorkflowSchedule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    definitionKey: row.definition_key,
    cron: row.cron,
    timezone: row.timezone,
    active: row.active,
    input: row.input,
    lastOccurrenceAt: toIsoOrNull(row.last_occurrence_at),
    nextOccurrenceAt: toIsoOrNull(row.next_occurrence_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapSignalRow(row: SignalRow): WorkflowRunSignal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    kind: row.kind,
    payload: row.payload,
    note: row.note,
    eventId: row.event_id,
    deliveredBy: row.delivered_by,
    deliveredAt: toIso(row.delivered_at),
    consumedAt: toIsoOrNull(row.consumed_at),
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON (content-equality for definition versioning)
// ---------------------------------------------------------------------------

/** Stable serialization: object keys sorted recursively. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const DEFINITION_SELECT = `
  SELECT d.id, d.tenant_id, d.key, d.version, d.status, d.created_by, d.created_at, d.updated_at,
         v.title, v.description, v.spec
    FROM workflow_definitions d
    JOIN workflow_definition_versions v
      ON v.definition_id = d.id AND v.tenant_id = d.tenant_id AND v.version = d.version
`;

export async function registerWorkflow(
  ctx: TenantContext,
  input: RegisterWorkflowInput,
): Promise<WorkflowDefinition> {
  assertWorkflowTenantContext(ctx);
  const valid = validateRegisterWorkflowInput(input);
  const db = getDb();
  const specJson = {
    steps: valid.spec.steps,
    eventTriggers: valid.spec.eventTriggers.length > 0 ? valid.spec.eventTriggers : undefined,
  };
  const specContent = canonicalJson({ spec: specJson, title: valid.title, description: valid.description });

  return db.transaction(async (tx) => {
    const existing = (
      await tx.query<DefinitionRow>(`${DEFINITION_SELECT} WHERE d.tenant_id = $1 AND d.key = $2`, [
        ctx.tenantId,
        valid.key,
      ])
    ).rows[0];
    const at = now();
    if (existing === undefined) {
      await tx.query(
        `INSERT INTO workflow_definitions (tenant_id, key, version, status, created_by, created_at, updated_at)
           VALUES ($1, $2, 1, 'active', $3, $4, $4)`,
        [ctx.tenantId, valid.key, ctx.principalId, at],
      );
      const definitionId = (
        await tx.query<{ id: string }>(
          `SELECT id FROM workflow_definitions WHERE tenant_id = $1 AND key = $2`,
          [ctx.tenantId, valid.key],
        )
      ).rows[0]!.id;
      await tx.query(
        `INSERT INTO workflow_definition_versions (tenant_id, definition_id, version, title, description, spec, created_by, created_at)
           VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7)`,
        [ctx.tenantId, definitionId, valid.title, valid.description, JSON.stringify(specJson), ctx.principalId, at],
      );
    } else {
      const existingContent = canonicalJson({
        spec: existing.spec,
        title: existing.title,
        description: existing.description,
      });
      if (existingContent !== specContent) {
        // Content changed — append the next version and move the pointer.
        const nextVersion = existing.version + 1;
        await tx.query(
          `INSERT INTO workflow_definition_versions (tenant_id, definition_id, version, title, description, spec, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [
            ctx.tenantId,
            existing.id,
            nextVersion,
            valid.title,
            valid.description,
            JSON.stringify(specJson),
            ctx.principalId,
            at,
          ],
        );
        await tx.query(
          `UPDATE workflow_definitions SET version = $1, updated_at = $2 WHERE tenant_id = $3 AND key = $4`,
          [nextVersion, at, ctx.tenantId, valid.key],
        );
      }
    }
    const stored = (
      await tx.query<DefinitionRow>(`${DEFINITION_SELECT} WHERE d.tenant_id = $1 AND d.key = $2`, [
        ctx.tenantId,
        valid.key,
      ])
    ).rows[0]!;
    return mapDefinitionRow(stored);
  });
}

export async function getWorkflowDefinition(
  ctx: TenantContext,
  query: GetWorkflowDefinitionQuery,
): Promise<WorkflowDefinition> {
  assertWorkflowTenantContext(ctx);
  const valid = validateDefinitionQuery(query);
  const row = (
    await getDb().query<DefinitionRow>(`${DEFINITION_SELECT} WHERE d.tenant_id = $1 AND d.key = $2`, [
      ctx.tenantId,
      valid.key,
    ])
  ).rows[0];
  if (row === undefined) {
    throw new WorkflowError(
      'definition_not_found',
      `no workflow definition '${valid.key}' exists in this tenant`,
    );
  }
  return mapDefinitionRow(row);
}

export async function listWorkflowDefinitions(
  ctx: TenantContext,
  query: ListWorkflowDefinitionsQuery,
): Promise<WorkflowDefinition[]> {
  assertWorkflowTenantContext(ctx);
  const valid = validateListDefinitionsQuery(query ?? {});
  let sql = `${DEFINITION_SELECT} WHERE d.tenant_id = $1`;
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND d.status = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY d.created_at DESC, d.key ASC LIMIT $${params.length}`;
  const rows = await getDb().query<DefinitionRow>(sql, params);
  return rows.rows.map(mapDefinitionRow);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The resolved definition a run materialization freezes. */
export interface ResolvedDefinition {
  id: string;
  key: string;
  version: number;
  status: 'active' | 'retired';
  spec: { steps: ValidatedStepSpec[]; eventTriggers?: string[] };
}

/** Tenant-scoped lookup of the CURRENT definition version (status included). */
export async function resolveDefinition(
  db: Queryable,
  tenantId: string,
  key: string,
): Promise<ResolvedDefinition | null> {
  const row = (
    await db.query<DefinitionRow>(`${DEFINITION_SELECT} WHERE d.tenant_id = $1 AND d.key = $2`, [
      tenantId,
      key,
    ])
  ).rows[0];
  if (row === undefined) return null;
  return { id: row.id, key: row.key, version: row.version, status: row.status, spec: row.spec };
}

export interface InsertRunParams {
  tenantId: string;
  definition: ResolvedDefinition;
  idempotencyKey: string | null;
  triggerKind: 'manual' | 'event' | 'schedule';
  triggerEventId?: string | null;
  triggerScheduleId?: string | null;
  triggerReference?: string | null;
  input: unknown;
  runPrincipal: string;
  runAuthority: string[];
  createdBy: string;
}

/**
 * Insert one run plus its full step plan inside the given transaction.
 * Returns null when the idempotency key already exists (first write won)
 * — the caller treats that as an idempotent replay. Internal (engine +
 * dispatch + schedules compose it).
 */
export async function insertRunTx(tx: Queryable, params: InsertRunParams): Promise<RunRow | null> {
  const at = now();
  const steps = params.definition.spec.steps;
  const inserted = await tx.query<RunRow>(
    `INSERT INTO workflow_runs (
       tenant_id, definition_id, definition_key, definition_version, idempotency_key,
       status, current_step, total_steps, trigger_kind, trigger_event_id, trigger_schedule_id,
       trigger_reference, input, run_principal, run_authority, created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14, $15, $15)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      params.tenantId,
      params.definition.id,
      params.definition.key,
      params.definition.version,
      params.idempotencyKey,
      steps.length,
      params.triggerKind,
      params.triggerEventId ?? null,
      params.triggerScheduleId ?? null,
      params.triggerReference ?? null,
      JSON.stringify(params.input ?? {}),
      params.runPrincipal,
      JSON.stringify(params.runAuthority ?? []),
      params.createdBy,
      at,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) return null;
  const stepValues: unknown[][] = steps.map((step, index) => [
    params.tenantId,
    row.id,
    index + 1,
    step.key,
    step.maxAttempts,
    step.retryBackoffSeconds,
    step.leaseSeconds,
    at,
  ]);
  const placeholders = stepValues
    .map((_, rowNumber) => {
      const base = rowNumber * 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    })
    .join(', ');
  const flatParams = stepValues.flat();
  await tx.query(
    `INSERT INTO workflow_run_steps (tenant_id, run_id, step_number, step_key, max_attempts, retry_backoff_seconds, lease_seconds, updated_at)
       VALUES ${placeholders}`,
    flatParams,
  );
  return row;
}

// ---------------------------------------------------------------------------
// Run lifecycle (public operations)
// ---------------------------------------------------------------------------

export async function startRun(ctx: TenantContext, input: StartRunInput): Promise<WorkflowRun> {
  assertWorkflowTenantContext(ctx);
  const valid = validateStartRunInput(input);
  const db = getDb();
  const definition = await resolveDefinition(db, ctx.tenantId, valid.definitionKey);
  if (definition === null) {
    throw new WorkflowError(
      'definition_not_found',
      `no workflow definition '${valid.definitionKey}' exists in this tenant`,
    );
  }
  if (definition.status !== 'active') {
    throw new WorkflowError(
      'definition_not_active',
      `workflow definition '${valid.definitionKey}' is retired in this tenant`,
    );
  }
  // Idempotent fast path: a recorded key replays the original run —
  // first write wins (the events module's replay semantics).
  if (valid.idempotencyKey !== null) {
    const existing = (
      await db.query<RunRow>(
        `SELECT * FROM workflow_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, valid.idempotencyKey],
      )
    ).rows[0];
    if (existing !== undefined) return mapRunRow(existing);
  }
  const row = await db.transaction(async (tx) =>
    insertRunTx(tx, {
      tenantId: ctx.tenantId,
      definition,
      idempotencyKey: valid.idempotencyKey,
      triggerKind: 'manual',
      triggerReference: valid.triggerReference,
      input: valid.input,
      runPrincipal: ctx.principalId,
      runAuthority: ctx.authority,
      createdBy: ctx.principalId,
    }),
  );
  if (row === null) {
    // A concurrent caller won the idempotency race — replay its run.
    const winner = (
      await db.query<RunRow>(
        `SELECT * FROM workflow_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, valid.idempotencyKey],
      )
    ).rows[0];
    if (winner === undefined) {
      throw new WorkflowError('invalid_run_input', 'idempotency key conflict could not be replayed');
    }
    return mapRunRow(winner);
  }
  return mapRunRow(row);
}

async function findRunRow(db: Queryable, tenantId: string, runId: string): Promise<RunRow | null> {
  const row = (
    await db.query<RunRow>(`SELECT * FROM workflow_runs WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      runId,
    ])
  ).rows[0];
  return row ?? null;
}

export async function getRun(ctx: TenantContext, query: GetRunQuery): Promise<WorkflowRun> {
  assertWorkflowTenantContext(ctx);
  const valid = validateRunQuery(query);
  const row = await findRunRow(getDb(), ctx.tenantId, valid.runId);
  if (row === null) {
    throw new WorkflowError('run_not_found', `no workflow run '${valid.runId}' exists in this tenant`);
  }
  return mapRunRow(row);
}

export async function listRuns(ctx: TenantContext, query: ListRunsQuery): Promise<WorkflowRun[]> {
  assertWorkflowTenantContext(ctx);
  const valid = validateListRunsQuery(query ?? {});
  let sql = `SELECT * FROM workflow_runs WHERE tenant_id = $1`;
  const params: unknown[] = [ctx.tenantId];
  if (valid.definitionKey !== null) {
    params.push(valid.definitionKey);
    sql += ` AND definition_key = $${params.length}`;
  }
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  if (valid.trigger !== null) {
    params.push(valid.trigger);
    sql += ` AND trigger_kind = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY created_at DESC, id ASC LIMIT $${params.length}`;
  const rows = await getDb().query<RunRow>(sql, params);
  return rows.rows.map(mapRunRow);
}

export async function listRunSteps(
  ctx: TenantContext,
  query: ListRunStepsQuery,
): Promise<WorkflowRunStep[]> {
  assertWorkflowTenantContext(ctx);
  const valid = validateRunStepsQuery(query);
  const run = await findRunRow(getDb(), ctx.tenantId, valid.runId);
  if (run === null) {
    throw new WorkflowError('run_not_found', `no workflow run '${valid.runId}' exists in this tenant`);
  }
  const rows = await getDb().query<StepRow>(
    `SELECT * FROM workflow_run_steps WHERE tenant_id = $1 AND run_id = $2 ORDER BY step_number ASC`,
    [ctx.tenantId, valid.runId],
  );
  return rows.rows.map(mapStepRow);
}

export async function listRunStepAttempts(
  ctx: TenantContext,
  query: ListRunStepAttemptsQuery,
): Promise<WorkflowStepAttempt[]> {
  assertWorkflowTenantContext(ctx);
  const valid = validateRunStepAttemptsQuery(query);
  const run = await findRunRow(getDb(), ctx.tenantId, valid.runId);
  if (run === null) {
    throw new WorkflowError('run_not_found', `no workflow run '${valid.runId}' exists in this tenant`);
  }
  let sql = `SELECT * FROM workflow_step_attempts WHERE tenant_id = $1 AND run_id = $2`;
  const params: unknown[] = [ctx.tenantId, valid.runId];
  if (valid.stepNumber !== null) {
    params.push(valid.stepNumber);
    sql += ` AND step_number = $${params.length}`;
  }
  sql += ` ORDER BY step_number ASC, invocation ASC`;
  const rows = await getDb().query<AttemptRow>(sql, params);
  return rows.rows.map(mapAttemptRow);
}

export async function cancelRun(ctx: TenantContext, input: CancelRunInput): Promise<WorkflowRun> {
  assertWorkflowTenantContext(ctx);
  const valid = validateCancelRunInput(input);
  const db = getDb();
  return db.transaction(async (tx) => {
    const row = await findRunRow(tx, ctx.tenantId, valid.runId);
    if (row === null) {
      throw new WorkflowError(
        'run_not_found',
        `no workflow run '${valid.runId}' exists in this tenant`,
      );
    }
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      throw new WorkflowError(
        'not_cancellable',
        `workflow run '${valid.runId}' is already terminal (${row.status})`,
      );
    }
    const at = now();
    if (row.status === 'pending' || row.status === 'waiting') {
      // Nothing is executing right now — cancel outright and retire the
      // non-terminal steps (their waits are abandoned).
      await tx.query(
        `UPDATE workflow_runs
           SET status = 'cancelled', cancel_requested_at = $3, cancel_reason = $4,
               cancelled_by = $5, finished_at = $3, updated_at = $3
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.runId, at, valid.reason, ctx.principalId],
      );
      await tx.query(
        `UPDATE workflow_run_steps
           SET status = 'cancelled', wait_kind = NULL, wait_resume_at = NULL,
               wait_action_request_id = NULL, wait_event_type = NULL, wait_note = NULL,
               lease_expires_at = NULL, retry_not_before = NULL,
               finished_at = $3, updated_at = $3
           WHERE tenant_id = $1 AND run_id = $2 AND status IN ('pending', 'running', 'waiting')`,
        [ctx.tenantId, valid.runId, at],
      );
    } else {
      // A live executor may hold the run — record the cooperative
      // cancellation request; the pump finalizes once it observes it.
      await tx.query(
        `UPDATE workflow_runs
           SET status = 'cancelling', cancel_requested_at = $3, cancel_reason = $4,
               cancelled_by = $5, updated_at = $3
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.runId, at, valid.reason, ctx.principalId],
      );
    }
    const stored = await findRunRow(tx, ctx.tenantId, valid.runId);
    return mapRunRow(stored!);
  });
}

export async function resumeRun(ctx: TenantContext, input: ResumeRunInput): Promise<WorkflowRun> {
  assertWorkflowTenantContext(ctx);
  const valid = validateResumeRunInput(input);
  const db = getDb();
  return db.transaction(async (tx) => {
    const row = (
      await tx.query<RunRow & { step_wait_kind: string | null; step_status: string | null }>(
        `SELECT r.*, s.wait_kind AS step_wait_kind, s.status AS step_status
           FROM workflow_runs r
           LEFT JOIN workflow_run_steps s
             ON s.run_id = r.id AND s.tenant_id = r.tenant_id AND s.step_number = r.current_step
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [ctx.tenantId, valid.runId],
      )
    ).rows[0];
    if (row === undefined) {
      throw new WorkflowError(
        'run_not_found',
        `no workflow run '${valid.runId}' exists in this tenant`,
      );
    }
    if (row.status !== 'waiting' || row.step_status !== 'waiting' || row.step_wait_kind !== 'employee_response') {
      throw new WorkflowError(
        'not_waiting_employee_response',
        `workflow run '${valid.runId}' is not suspended on an employee-response wait (status '${row.status}')`,
      );
    }
    await tx.query(
      `INSERT INTO workflow_run_signals (tenant_id, run_id, kind, payload, note, delivered_by, delivered_at)
         VALUES ($1, $2, 'resume', $3::jsonb, $4, $5, $6)`,
      [ctx.tenantId, valid.runId, JSON.stringify(valid.payload ?? {}), valid.note, ctx.principalId, now()],
    );
    return mapRunRow(row);
  });
}

// ---------------------------------------------------------------------------
// Event triggers
// ---------------------------------------------------------------------------

export async function dispatchWorkflowEvent(
  ctx: TenantContext,
  input: DispatchWorkflowEventInput,
): Promise<WorkflowEventDispatch> {
  assertWorkflowTenantContext(ctx);
  const valid = validateDispatchEventInput(input);
  const db = getDb();

  // A domain event reference is validated readable through the events
  // contract before it may anchor a trigger (the missions/epistemics
  // validated-link precedent — never store unverified cross-module refs).
  if (valid.domainEventId !== null) {
    try {
      await getEvent(ctx, valid.domainEventId);
    } catch (error) {
      if (error instanceof EventsError) {
        throw new WorkflowError(
          'invalid_reference',
          `domain event '${valid.domainEventId}' is not readable in this tenant (${error.code})`,
        );
      }
      throw error;
    }
  }

  // Idempotent fast path: a recorded key replays the original dispatch —
  // the event, its runs and its signals committed atomically the first
  // time, so the replay reports no new materialization.
  if (valid.idempotencyKey !== null) {
    const existing = (
      await db.query<EventRow>(
        `SELECT * FROM workflow_events WHERE tenant_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, valid.idempotencyKey],
      )
    ).rows[0];
    if (existing !== undefined) {
      return {
        event: mapEventRow(existing),
        runsStarted: [],
        signalsDelivered: 0,
        replayed: true,
      };
    }
  }

  const at = now();
  const { eventId, runsStarted, signalsDelivered, replayed } = await db.transaction(async (tx) => {
    const inserted = await tx.query<EventRow>(
      `INSERT INTO workflow_events (tenant_id, event_type, payload, domain_event_id, idempotency_key, occurred_at, dispatched_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
      [
        ctx.tenantId,
        valid.eventType,
        JSON.stringify(valid.payload ?? {}),
        valid.domainEventId,
        valid.idempotencyKey,
        at,
        ctx.principalId,
      ],
    );
    const eventRow = inserted.rows[0];
    if (eventRow === undefined) {
      // Lost an idempotency race inside the transaction window — read
      // the winner and report the replay.
      const winner = (
        await tx.query<EventRow>(
          `SELECT * FROM workflow_events WHERE tenant_id = $1 AND idempotency_key = $2`,
          [ctx.tenantId, valid.idempotencyKey],
        )
      ).rows[0]!;
      return { eventId: winner.id, runsStarted: [] as RunRow[], signalsDelivered: 0, replayed: true };
    }

    // Materialize runs for every active definition subscribed to this
    // event type (one dedupe key per (event, definition)).
    const definitions = (
      await tx.query<DefinitionRow>(
        `${DEFINITION_SELECT}
          WHERE d.tenant_id = $1 AND d.status = 'active'
            AND jsonb_exists(COALESCE(v.spec->'eventTriggers', '[]'::jsonb), $2)`,
        [ctx.tenantId, valid.eventType],
      )
    ).rows;
    const started: RunRow[] = [];
    for (const definition of definitions) {
      const run = await insertRunTx(tx, {
        tenantId: ctx.tenantId,
        definition: {
          id: definition.id,
          key: definition.key,
          version: definition.version,
          status: definition.status,
          spec: definition.spec,
        },
        idempotencyKey: eventRunIdempotencyKey(eventRow.id, definition.id),
        triggerKind: 'event',
        triggerEventId: eventRow.id,
        input: valid.payload ?? {},
        runPrincipal: ctx.principalId,
        runAuthority: ctx.authority,
        createdBy: ctx.principalId,
      });
      if (run !== null) started.push(run);
    }

    // Deliver signals to waiting employee-response steps subscribed to
    // this event type (or unsubscribed waits, which accept any event).
    const waiting = (
      await tx.query<{ run_id: string }>(
        `SELECT s.run_id
           FROM workflow_run_steps s
           JOIN workflow_runs r
             ON r.id = s.run_id AND r.tenant_id = s.tenant_id AND r.status = 'waiting'
          WHERE s.tenant_id = $1 AND s.status = 'waiting' AND s.wait_kind = 'employee_response'
            AND (s.wait_event_type IS NULL OR s.wait_event_type = $2)`,
        [ctx.tenantId, valid.eventType],
      )
    ).rows;
    let delivered = 0;
    for (const target of waiting) {
      const signal = await tx.query(
        `INSERT INTO workflow_run_signals (tenant_id, run_id, kind, payload, note, event_id, delivered_by, delivered_at)
           VALUES ($1, $2, 'event', $3::jsonb, NULL, $4, $5, $6)
           ON CONFLICT (tenant_id, run_id, event_id) DO NOTHING`,
        [ctx.tenantId, target.run_id, JSON.stringify(valid.payload ?? {}), eventRow.id, ctx.principalId, at],
      );
      delivered += signal.rowCount ?? 0;
    }
    return { eventId: eventRow.id, runsStarted: started, signalsDelivered: delivered, replayed: false };
  });

  const event = mapEventRow(
    (await db.query<EventRow>(`SELECT * FROM workflow_events WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      eventId,
    ])).rows[0]!,
  );
  return {
    event,
    runsStarted: runsStarted.map(mapRunRow),
    signalsDelivered,
    replayed,
  };
}

export async function getWorkflowEvent(
  ctx: TenantContext,
  query: GetWorkflowEventQuery,
): Promise<WorkflowEvent> {
  assertWorkflowTenantContext(ctx);
  const valid = validateEventQuery(query);
  const row = (
    await getDb().query<EventRow>(`SELECT * FROM workflow_events WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      valid.eventId,
    ])
  ).rows[0];
  if (row === undefined) {
    throw new WorkflowError(
      'event_not_found',
      `no workflow event '${valid.eventId}' exists in this tenant`,
    );
  }
  return mapEventRow(row);
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function createSchedule(
  ctx: TenantContext,
  input: CreateScheduleInput,
): Promise<WorkflowSchedule> {
  assertWorkflowTenantContext(ctx);
  const valid = validateCreateScheduleInput(input);
  const db = getDb();
  const definition = await resolveDefinition(db, ctx.tenantId, valid.definitionKey);
  if (definition === null) {
    throw new WorkflowError(
      'definition_not_found',
      `no workflow definition '${valid.definitionKey}' exists in this tenant`,
    );
  }
  if (definition.status !== 'active') {
    throw new WorkflowError(
      'definition_not_active',
      `workflow definition '${valid.definitionKey}' is retired in this tenant`,
    );
  }
  const at = now();
  const parsed = parseCron(valid.cron);
  const next = nextCronOccurrence(parsed, at);
  const row = (
    await db.query<ScheduleRow>(
      `INSERT INTO workflow_schedules (tenant_id, definition_key, cron, timezone, active, input, next_occurrence_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'UTC', $4, $5::jsonb, $6, $7, $8, $8)
         RETURNING *`,
      [
        ctx.tenantId,
        valid.definitionKey,
        valid.cron,
        valid.active,
        JSON.stringify(valid.input ?? {}),
        next,
        ctx.principalId,
        at,
      ],
    )
  ).rows[0]!;
  return mapScheduleRow(row);
}

export async function listSchedules(
  ctx: TenantContext,
  query: ListSchedulesQuery,
): Promise<WorkflowSchedule[]> {
  assertWorkflowTenantContext(ctx);
  const valid = validateListSchedulesQuery(query ?? {});
  let sql = `SELECT * FROM workflow_schedules WHERE tenant_id = $1`;
  const params: unknown[] = [ctx.tenantId];
  if (valid.activeOnly) {
    params.push(true);
    sql += ` AND active = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY created_at DESC, id ASC LIMIT $${params.length}`;
  const rows = await getDb().query<ScheduleRow>(sql, params);
  return rows.rows.map(mapScheduleRow);
}

export async function setScheduleActive(
  ctx: TenantContext,
  input: SetScheduleActiveInput,
): Promise<WorkflowSchedule> {
  assertWorkflowTenantContext(ctx);
  const valid = validateSetScheduleActiveInput(input);
  const row = (
    await getDb().query<ScheduleRow>(
      `UPDATE workflow_schedules SET active = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, valid.scheduleId, valid.active, now()],
    )
  ).rows[0];
  if (row === undefined) {
    throw new WorkflowError(
      'schedule_not_found',
      `no workflow schedule '${valid.scheduleId}' exists in this tenant`,
    );
  }
  return mapScheduleRow(row);
}

/**
 * The schedule evaluation sweep (the worker loop's clock half): for each
 * active schedule of the tenant, materialize every cron occurrence in
 * (last_occurrence, now] as a run — each firing guarded by the UNIQUE
 * (tenant, schedule, occurrence) ledger plus the run's derived
 * idempotency key, so restarted or duplicate sweeps fire each occurrence
 * exactly once. The cursor advances past skipped occurrences too (a
 * retired definition does not stall the clock).
 */
export async function evaluateSchedules(ctx: TenantContext): Promise<ScheduleEvaluationResult> {
  assertWorkflowTenantContext(ctx);
  const db = getDb();
  const schedules = (
    await db.query<ScheduleRow>(
      `SELECT * FROM workflow_schedules WHERE tenant_id = $1 AND active = true ORDER BY created_at ASC, id ASC`,
      [ctx.tenantId],
    )
  ).rows;
  const at = now();
  const runsStarted: WorkflowRun[] = [];
  let occurrencesFired = 0;
  for (const schedule of schedules) {
    let parsed;
    try {
      parsed = parseCron(schedule.cron);
    } catch {
      // Stored schedules are validated at creation; a corrupted row is
      // skipped (the sweep must never die on one bad schedule).
      continue;
    }
    const from =
      schedule.last_occurrence_at !== null
        ? new Date(schedule.last_occurrence_at)
        : new Date(schedule.created_at);
    const occurrences = cronOccurrencesBetween(parsed, from, at, MAX_SCHEDULE_OCCURRENCES_PER_SWEEP);
    let lastProcessed: Date | null = null;
    for (const occurrence of occurrences) {
      const definition = await resolveDefinition(db, ctx.tenantId, schedule.definition_key);
      if (definition !== null && definition.status === 'active') {
        const fired = await db.transaction(async (tx) => {
          const run = await insertRunTx(tx, {
            tenantId: ctx.tenantId,
            definition,
            idempotencyKey: scheduleRunIdempotencyKey(schedule.id, occurrence.getTime()),
            triggerKind: 'schedule',
            triggerScheduleId: schedule.id,
            input: schedule.input ?? {},
            runPrincipal: ctx.principalId,
            runAuthority: ctx.authority,
            createdBy: ctx.principalId,
          });
          if (run === null) return null;
          await tx.query(
            `INSERT INTO workflow_schedule_firings (tenant_id, schedule_id, occurrence_at, run_id, fired_at)
               VALUES ($1, $2, $3, $4, $5)`,
            [ctx.tenantId, schedule.id, occurrence, run.id, at],
          );
          return run;
        });
        if (fired !== null) {
          occurrencesFired += 1;
          runsStarted.push(mapRunRow(fired));
        }
      }
      lastProcessed = occurrence;
    }
    const next = nextCronOccurrence(parsed, at);
    await db.query(
      `UPDATE workflow_schedules SET last_occurrence_at = $3, next_occurrence_at = $4, updated_at = $5
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, schedule.id, lastProcessed ?? schedule.last_occurrence_at, next, at],
    );
  }
  return { schedulesEvaluated: schedules.length, occurrencesFired, runsStarted };
}
