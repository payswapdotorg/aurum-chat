// Implementation of the cognition module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`execution_not_found` / `step_not_found`), on
// reads AND on writes: advancing, suspending or abandoning a
// foreign-tenant execution id is reported as `execution_not_found`.
//
// W013 acceptance — "the canonical company intelligence loop as explicit
// asynchronous/resumable executions with policy gates and outcome
// recording" — is carried by these deliberate properties, all tested:
//
//   1. EXPLICIT (§19): a cognitive execution is a durable record with an
//      identity, a trigger, §25 correlation/causation identities, a
//      focus and an actor. `startExecution` records it and does NO stage
//      work — the loop is never implicit control flow.
//   2. CANONICAL: the twelve §19 stages run in frozen order, one
//      append-only step each (`cognitive_execution_steps`, unique
//      (execution, stage), storage-rejects mutation). The advance input
//      is validated against the execution's NEXT stage — skipping or
//      reordering is `stage_mismatch` at the contract boundary and
//      unrepresentable in storage (step stage_number = current_stage + 1
//      under the pointer guard).
//   3. ASYNCHRONOUS/RESUMABLE (lock 36): `runNextStage` is the explicit
//      worker pump — one bounded stage per call; the module owns no
//      background time (the notifications precedent). Suspensions are
//      first-class states: 'awaiting_input' (the planned acquisition has
//      no terminal outcome yet) and 'awaiting_approval' (the policy gate
//      holds the proposed action for a human); pumps re-check and either
//      complete the stage or return the unchanged execution. Terminal:
//      'completed' (after learning, outcome recorded) and 'abandoned'
//      (required reason).
//   4. POLICY-GATED (§20, GOVERNANCE "high-impact actions are
//      policy-gated"): the recommendation/ask/proposal/action stage
//      routes ONE consequential action through the actions authority
//      matrix (W009 authorizeAction) with the STABLE idempotency key
//      `cognition:<executionId>:action` — 'allowed' releases, 'forbidden'
//      refuses, 'approval_required' suspends until a human decides
//      (decideApproval between pumps releases the suspension). Refusals
//      and approvals are recorded on the step, never silently dropped.
//   5. OUTCOME-RECORDING (§24): the outcome stage writes the cycle's
//      outcome onto the execution (action-authorized / action-refused /
//      no-action, derived deterministically from the gate result) plus
//      the caller's summary; the learning stage captures the durable
//      learning as evidence-backed organizational memory (W010), citing
//      the cycle's observations. The whole chain — input → evidence →
//      … → policy → outcome → learning — reconstructs from the trace.
//   6. CORRELATED (§25): executions carry correlation/causation
//      identities; an execution-caused execution inherits its cause's
//      correlation id when none is supplied (the events module's rule,
//      applied within this module's own records).
//
// Storage shape: `cognitive_executions` (lifecycle state machine; the
// only mutable columns are the state-machine columns — every substantive
// field is fixed at insert) + `cognitive_execution_steps` (the
// append-only trace).
//
// Concurrency: each stage append runs inside one transaction that holds
// a transaction-scoped advisory lock keyed on (tenant, execution) and
// advances the pointer under an optimistic (current_stage, state) guard
// — a losing pump fails cleanly with `execution_conflict`, so two pumps
// cannot double-append a stage and an abandonment during a pump's stage
// work cannot be advanced past. Sibling-contract writes performed by a
// losing pump (e.g. recorded observations) remain legitimate domain
// records — they are simply not referenced by any step; evidence is
// append-only by design.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  getActionRequest,
  type ActionRequest,
} from '@/modules/actions/contract';
import {
  EpistemicsError,
  formBelief,
  recordClaim,
  recordUnknown,
  reviseBelief,
} from '@/modules/epistemics/contract';
import { GoalsError, getGoal, listGoals } from '@/modules/goals/contract';
import {
  KnowledgeAcquisitionError,
  getAcquisitionPlan,
  planNextAcquisition,
  type AcquisitionPlan,
} from '@/modules/knowledge-acquisition/contract';
import {
  MemoryError,
  listKnowledgeEntries,
  listTransactiveEntries,
  recordKnowledgeEntry,
} from '@/modules/memory/contract';
import {
  MissionsError,
  completeMission,
  createMission,
  getMission,
  reviseMission,
  type Mission,
} from '@/modules/missions/contract';
import {
  ObservationsError,
  getObservation,
  recordObservation,
  type Observation,
} from '@/modules/observations/contract';
import {
  WorldError,
  createEntity,
  createRelationship,
  updateEntity,
} from '@/modules/world/contract';
import { CognitionError } from './errors';
import {
  outcomeKindForActionGate,
  stageAtNumber,
  stageNumberOf,
  type ActionGateResult,
  type ExecutionState,
  type LoopStage,
} from './loop';
import { deriveAcquisitionSignals } from './signals';
import {
  assertCognitionTenantContext,
  isUuid,
  validateAbandonInput,
  validateAdvanceInput,
  validateListExecutionsQuery,
  validateStartExecutionInput,
  validateStepQuery,
  MAX_EVIDENCE_REFS,
  type ValidatedAdvance,
  type ValidatedStartInput,
} from './validation';
import type {
  CognitiveExecution,
  CognitiveExecutionStep,
  CognitiveExecutionTrace,
  ExecutionActor,
  ExecutionFocus,
  ExecutionOutcome,
  MissionLaunchInput,
  ObservationIntakeInput,
  StageResult,
  UnknownDerivationInput,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface ExecutionRow extends DbRow {
  id: string;
  tenant_id: string;
  trigger_kind: string;
  trigger_id: string | null;
  trigger_label: string | null;
  focus_topics: unknown;
  focus_entities: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  correlation_id: string;
  causation_kind: string | null;
  causation_id: string | null;
  state: string;
  current_stage: number | string;
  pending_plan_id: string | null;
  pending_request_id: string | null;
  outcome_kind: string | null;
  outcome_summary: string | null;
  outcome_recorded_at: Date | string | null;
  outcome_action_request_id: string | null;
  abandon_reason: string | null;
  abandoned_at: Date | string | null;
  rationale: string | null;
  started_by_principal: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface StepRow extends DbRow {
  id: string;
  tenant_id: string;
  execution_id: string;
  stage_number: number | string;
  stage: string;
  input: unknown;
  result: unknown;
  advanced_by_principal: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function executionNotFound(executionId: string): CognitionError {
  return new CognitionError(
    'execution_not_found',
    `cognitive execution '${executionId}' does not exist in this tenant`,
  );
}

function invalidReference(message: string): CognitionError {
  return new CognitionError('invalid_reference', message);
}

function stageWriteRejected(moduleName: string, error: unknown): CognitionError {
  const message = error instanceof Error ? error.message : String(error);
  return new CognitionError(
    'stage_write_rejected',
    `the ${moduleName} contract rejected the stage write: ${message}`,
  );
}

function stageInputError(message: string): CognitionError {
  return new CognitionError('invalid_stage_input', message);
}

function mapStrings(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapFocusEntities(
  value: unknown,
): { kind: string; id: string | null; label: string | null }[] {
  return Array.isArray(value)
    ? (value as { kind: string; id: string | null; label: string | null }[])
    : [];
}

function mapExecution(row: ExecutionRow): CognitiveExecution {
  const completedStages = toInt(row.current_stage);
  const state = row.state as CognitiveExecution['state']; // CHECK-constrained
  const terminal = state === 'completed' || state === 'abandoned';
  const outcome: ExecutionOutcome | null =
    row.outcome_kind === null
      ? null
      : {
          kind: row.outcome_kind as ExecutionOutcome['kind'], // CHECK-constrained
          summary: row.outcome_summary!,
          actionRequestId: row.outcome_action_request_id,
          recordedAt: toIso(row.outcome_recorded_at!),
        };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    trigger: {
      kind: row.trigger_kind as CognitiveExecution['trigger']['kind'], // CHECK-constrained
      id: row.trigger_id,
      label: row.trigger_label,
    },
    focus: {
      topics: mapStrings(row.focus_topics),
      entities: mapFocusEntities(row.focus_entities),
    } satisfies ExecutionFocus,
    actor: {
      kind: row.actor_kind as ExecutionActor['kind'], // CHECK-constrained
      id: row.actor_id,
      label: row.actor_label,
    } satisfies ExecutionActor,
    correlationId: row.correlation_id,
    causation:
      row.causation_kind === null
        ? null
        : {
            kind: row.causation_kind as NonNullable<CognitiveExecution['causation']>['kind'],
            id: row.causation_id!,
          },
    state,
    completedStages,
    nextStage: terminal ? null : stageAtNumber(completedStages + 1),
    pending: { planId: row.pending_plan_id, requestId: row.pending_request_id },
    outcome,
    abandonment:
      row.abandon_reason === null
        ? null
        : { reason: row.abandon_reason, abandonedAt: toIso(row.abandoned_at!) },
    rationale: row.rationale,
    startedByPrincipal: row.started_by_principal,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
  };
}

function mapStep(row: StepRow): CognitiveExecutionStep {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    stageNumber: toInt(row.stage_number),
    stage: row.stage as LoopStage, // CHECK-constrained
    input: row.input,
    result: row.result as StageResult, // write-validated by this service
    advancedByPrincipal: row.advanced_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapTrace(row: ExecutionRow, stepRows: StepRow[]): CognitiveExecutionTrace {
  return {
    ...mapExecution(row),
    steps: stepRows
      .slice()
      .sort((a, b) => toInt(a.stage_number) - toInt(b.stage_number))
      .map(mapStep),
  };
}

async function findExecutionRow(ctx: TenantContext, executionId: string): Promise<ExecutionRow> {
  const rows = await getDb().query<ExecutionRow>(
    `SELECT * FROM cognitive_executions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, executionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw executionNotFound(executionId);
  return row;
}

async function findStepRow(
  ctx: TenantContext,
  executionId: string,
  stageNumber: number,
): Promise<StepRow> {
  const rows = await getDb().query<StepRow>(
    `SELECT * FROM cognitive_execution_steps
      WHERE tenant_id = $1 AND execution_id = $2 AND stage_number = $3`,
    [ctx.tenantId, executionId, stageNumber],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new CognitionError(
      'step_not_found',
      `cognitive execution '${executionId}' has no step for stage number ${stageNumber}`,
    );
  }
  return row;
}

async function loadSteps(ctx: TenantContext, executionId: string): Promise<StepRow[]> {
  const rows = await getDb().query<StepRow>(
    `SELECT * FROM cognitive_execution_steps
      WHERE tenant_id = $1 AND execution_id = $2
      ORDER BY stage_number ASC`,
    [ctx.tenantId, executionId],
  );
  return rows.rows;
}

// ---------------------------------------------------------------------------
// startExecution
// ---------------------------------------------------------------------------

export async function startExecution(
  ctx: TenantContext,
  input: unknown,
): Promise<CognitiveExecutionTrace> {
  assertCognitionTenantContext(ctx);
  const valid: ValidatedStartInput = validateStartExecutionInput(input);

  // Observation triggers are validated readable through the observations
  // contract at start (the sanctioned dependency) — uniformly
  // invalid_start_input; no existence leak.
  if (valid.trigger.kind === 'observation') {
    try {
      await getObservation(ctx, valid.trigger.id!);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new CognitionError(
          'invalid_start_input',
          `trigger observation '${valid.trigger.id}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }

  // §25 correlation: explicit wins; an execution-caused execution
  // inherits its cause's correlation id; every root correlates to itself.
  let correlationId = valid.correlationId;
  if (correlationId === null && valid.causation !== null && valid.causation.kind === 'execution') {
    const cause = await getDb().query<{ correlation_id: string }>(
      `SELECT correlation_id FROM cognitive_executions WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.causation.id],
    );
    const causeRow = cause.rows[0];
    if (causeRow === undefined) {
      throw new CognitionError(
        'invalid_start_input',
        `causation execution '${valid.causation.id}' is not available in this tenant`,
      );
    }
    correlationId = causeRow.correlation_id;
  }
  if (correlationId === null) correlationId = newId();

  const recordedAt = now();
  const inserted = await getDb().query<ExecutionRow>(
    `INSERT INTO cognitive_executions (
       tenant_id, trigger_kind, trigger_id, trigger_label,
       focus_topics, focus_entities,
       actor_kind, actor_id, actor_label,
       correlation_id, causation_kind, causation_id,
       state, current_stage, rationale, started_by_principal,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4,
       $5::jsonb, $6::jsonb,
       $7, $8, $9,
       $10, $11, $12,
       'running', 0, $13, $14,
       $15::timestamptz, $15::timestamptz
     ) RETURNING *`,
    [
      ctx.tenantId,
      valid.trigger.kind,
      valid.trigger.id,
      valid.trigger.label,
      JSON.stringify(valid.focus.topics),
      JSON.stringify(valid.focus.entities),
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      correlationId,
      valid.causation === null ? null : valid.causation.kind,
      valid.causation === null ? null : valid.causation.id,
      valid.rationale,
      ctx.principalId,
      recordedAt,
    ],
  );
  return mapTrace(inserted.rows[0]!, []);
}

// ---------------------------------------------------------------------------
// The pointer transaction (step append + guarded lifecycle advance)
// ---------------------------------------------------------------------------

interface CommitStepParams {
  executionId: string;
  /** The stage number being committed (current_stage + 1). */
  stageNumber: number;
  stage: LoopStage;
  /** The validated stage input snapshot (persisted for audit). */
  input: unknown;
  result: StageResult;
  /** The state the guard requires before the advance. */
  fromState: ExecutionState;
  /** Outcome columns to write (the outcome stage only). */
  outcome?: { kind: string; summary: string; actionRequestId: string | null; recordedAt: Date };
  /** True when this step finishes the canonical sequence. */
  completes: boolean;
}

/**
 * Append one canonical step and advance the execution's pointer —
 * atomically, under a transaction-scoped advisory lock keyed on
 * (tenant, execution), with an optimistic (current_stage, state) guard.
 * A losing pump fails cleanly with `execution_conflict`.
 */
async function commitStep(ctx: TenantContext, params: CommitStepParams): Promise<ExecutionRow> {
  return getDb().transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `cognition:${ctx.tenantId}:${params.executionId}`,
    ]);

    await tx.query(
      `INSERT INTO cognitive_execution_steps (
         tenant_id, execution_id, stage_number, stage, input, result,
         advanced_by_principal, recorded_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::timestamptz)`,
      [
        ctx.tenantId,
        params.executionId,
        params.stageNumber,
        params.stage,
        JSON.stringify(params.input ?? {}),
        JSON.stringify(params.result),
        ctx.principalId,
        now(),
      ],
    ).catch((error: unknown) => {
      // A racing pump appended this stage first: the unique
      // (execution, stage) constraint fired before the pointer guard.
      if (
        error instanceof Error &&
        /duplicate key value/i.test(error.message) &&
        error.message.includes('cognitive_execution_steps')
      ) {
        throw new CognitionError(
          'execution_conflict',
          `cognitive execution '${params.executionId}' already carries stage ${params.stageNumber} — another pump advanced it`,
        );
      }
      throw error;
    });

    const stamp = now();
    // The state-machine columns always advance; the outcome columns are
    // written by the outcome stage ONLY (later stages — learning — must
    // not clobber them).
    const setFragments = [
      'current_stage = $4',
      'state = $5',
      'pending_plan_id = NULL',
      'pending_request_id = NULL',
      'updated_at = $6::timestamptz',
      'completed_at = $7::timestamptz',
    ];
    const values: unknown[] = [
      ctx.tenantId,
      params.executionId,
      params.stageNumber - 1,
      params.stageNumber,
      params.completes ? 'completed' : 'running',
      stamp,
      params.completes ? stamp : null,
    ];
    if (params.outcome !== undefined) {
      values.push(params.outcome.kind, params.outcome.summary, params.outcome.recordedAt, params.outcome.actionRequestId);
      const base = values.length - 4;
      setFragments.push(
        `outcome_kind = $${base + 1}`,
        `outcome_summary = $${base + 2}`,
        `outcome_recorded_at = $${base + 3}::timestamptz`,
        `outcome_action_request_id = $${base + 4}`,
      );
    }
    values.push(params.fromState);
    const guardState = `$${values.length}`;
    const updated = await tx.query<ExecutionRow>(
      `UPDATE cognitive_executions
         SET ${setFragments.join(', ')}
       WHERE tenant_id = $1 AND id = $2 AND current_stage = $3 AND state = ${guardState}
       RETURNING *`,
      values,
    );
    if (updated.rows.length !== 1) {
      throw new CognitionError(
        'execution_conflict',
        `cognitive execution '${params.executionId}' moved before this pump could commit stage ${params.stageNumber} — retry the stage`,
      );
    }
    return updated.rows[0]!;
  });
}

/** Suspend an execution: set state + pending pointer under the same optimistic guard. */
async function suspendExecution(
  ctx: TenantContext,
  params: {
    executionId: string;
    fromStageNumber: number; // current_stage at suspension time (stage NOT completed)
    state: 'awaiting_input' | 'awaiting_approval';
    pendingPlanId?: string | null;
    pendingRequestId?: string | null;
  },
): Promise<ExecutionRow> {
  return getDb().transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `cognition:${ctx.tenantId}:${params.executionId}`,
    ]);
    const updated = await tx.query<ExecutionRow>(
      `UPDATE cognitive_executions
         SET state = $3,
             pending_plan_id = $4,
             pending_request_id = $5,
             updated_at = $6::timestamptz
       WHERE tenant_id = $1 AND id = $2 AND current_stage = $7 AND state = 'running'
       RETURNING *`,
      [
        ctx.tenantId,
        params.executionId,
        params.state,
        params.pendingPlanId ?? null,
        params.pendingRequestId ?? null,
        now(),
        params.fromStageNumber,
      ],
    );
    if (updated.rows.length !== 1) {
      throw new CognitionError(
        'execution_conflict',
        `cognitive execution '${params.executionId}' moved before this pump could suspend it — retry`,
      );
    }
    return updated.rows[0]!;
  });
}

// ---------------------------------------------------------------------------
// Sibling-contract error mapping (uniform no-leak references)
// ---------------------------------------------------------------------------

function mapGoalsError(error: unknown, goalId: string): CognitionError {
  if (error instanceof GoalsError) {
    if (error.code === 'goal_not_found') {
      return invalidReference(`goal '${goalId}' is not available in this tenant to this principal`);
    }
    return stageWriteRejected('goals', error);
  }
  return stageWriteRejected('goals', error);
}

function mapObservationReadError(error: unknown, observationId: string): CognitionError {
  if (error instanceof ObservationsError) {
    return invalidReference(
      `observation '${observationId}' is not available in this tenant to this principal`,
    );
  }
  return invalidReference(`observation '${observationId}' is not available in this tenant to this principal`);
}

function mapEpistemicsError(error: unknown): CognitionError {
  if (error instanceof EpistemicsError) {
    if (error.code === 'invalid_evidence' || error.code === 'belief_not_found') {
      return invalidReference(error.message);
    }
    return stageWriteRejected('epistemics', error);
  }
  return stageWriteRejected('epistemics', error);
}

function mapMissionsError(error: unknown): CognitionError {
  if (error instanceof MissionsError) {
    if (error.code === 'mission_not_found' || error.code === 'invalid_unknown_ref') {
      return invalidReference(error.message);
    }
    return stageWriteRejected('missions', error);
  }
  return stageWriteRejected('missions', error);
}

function mapWorldError(error: unknown): CognitionError {
  if (error instanceof WorldError) {
    if (error.code === 'entity_not_found' || error.code === 'relationship_not_found') {
      return invalidReference(error.message);
    }
    return stageWriteRejected('world', error);
  }
  return stageWriteRejected('world', error);
}

function mapMemoryError(error: unknown): CognitionError {
  if (error instanceof MemoryError) {
    if (error.code === 'invalid_provenance' || error.code === 'knowledge_entry_not_found') {
      return invalidReference(error.message);
    }
    return stageWriteRejected('memory', error);
  }
  return stageWriteRejected('memory', error);
}

function mapKnowledgeAcquisitionError(error: unknown): CognitionError {
  if (error instanceof KnowledgeAcquisitionError) {
    if (error.code === 'mission_not_found' || error.code === 'plan_not_found') {
      return invalidReference(error.message);
    }
    return stageWriteRejected('knowledge-acquisition', error);
  }
  return stageWriteRejected('knowledge-acquisition', error);
}

function mapActionsError(error: unknown): CognitionError {
  if (error instanceof ActionsError) {
    if (error.code === 'action_request_not_found') {
      return invalidReference(error.message);
    }
    return stageWriteRejected('actions', error);
  }
  return stageWriteRejected('actions', error);
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

/** 1 — observation: ingest the cycle's evidence (W004). */
async function runObservationStage(
  ctx: TenantContext,
  row: ExecutionRow,
  payload: Extract<ValidatedAdvance, { stage: 'observation' }>,
): Promise<StageResult> {
  const recordedIds: string[] = [];
  for (const intake of payload.record) {
    try {
      const observation: Observation = await recordObservation(ctx, toObservationInput(intake) as Parameters<typeof recordObservation>[1]);
      recordedIds.push(observation.id);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new CognitionError(
          'observation_rejected',
          `the observation intake was rejected: ${error.message}`,
        );
      }
      throw error;
    }
  }
  for (const observationId of payload.reference) {
    try {
      await getObservation(ctx, observationId);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw mapObservationReadError(error, observationId);
      }
      throw error;
    }
  }
  const triggerObservationId = row.trigger_kind === 'observation' ? row.trigger_id : null;
  const observationIds = [
    ...new Set([...(triggerObservationId !== null ? [triggerObservationId] : []), ...recordedIds, ...payload.reference]),
  ].sort();
  if (observationIds.length < 1) {
    throw stageInputError(
      'the observation stage must ingest at least one observation — record or reference evidence, or start the execution from an observation trigger',
    );
  }
  return {
    stage: 'observation',
    observationIds,
    recordedObservationIds: [...new Set(recordedIds)].sort(),
  };
}

function toObservationInput(intake: ObservationIntakeInput): {
  kind: string;
  payload: unknown;
  observedAt: string;
  source: { kind: string; id?: string | null; label?: string | null };
  channel: string;
  lineage?: { method: string; parents?: string[]; extractor?: { provider: string; model: string; notes?: string | null } | null };
  permissions?: { visibility?: string; workspaceId?: string | null; principalId?: string | null; usage?: string[] };
  confidence: { value: number; method: string; basis?: string | null };
} {
  const input: ReturnType<typeof toObservationInput> = {
    kind: intake.kind,
    payload: intake.payload,
    observedAt: intake.observedAt,
    source: { kind: intake.source.kind, id: intake.source.id, label: intake.source.label },
    channel: intake.channel,
    confidence: { value: intake.confidence.value, method: intake.confidence.method, basis: intake.confidence.basis },
  };
  if (intake.lineage !== undefined && intake.lineage !== null) {
    input.lineage = {
      method: intake.lineage.method,
      parents: intake.lineage.parents,
      extractor: intake.lineage.extractor,
    };
  }
  if (intake.permissions !== undefined && intake.permissions !== null) {
    input.permissions = intake.permissions;
  }
  return input;
}

/** 2 — evidence/memory: retrieve relevant knowledge and transactive memory (W010). */
async function runEvidenceMemoryStage(ctx: TenantContext, row: ExecutionRow): Promise<StageResult> {
  const topics = mapStrings(row.focus_topics);
  const knowledge = await listKnowledgeEntries(ctx, { topics, limit: 50 });
  const transactive = await listTransactiveEntries(ctx, { topics, limit: 50 });
  return {
    stage: 'evidence-memory',
    knowledgeEntryIds: knowledge.map((entry) => entry.id),
    transactiveEntryIds: transactive.map((entry) => entry.id),
  };
}

/** 3 — world update: apply the cycle's world-model update (W005). */
async function runWorldUpdateStage(
  ctx: TenantContext,
  payload: Extract<ValidatedAdvance, { stage: 'world-update' }>,
): Promise<StageResult> {
  if (payload.update === null) {
    return { stage: 'world-update', update: null };
  }
  try {
    switch (payload.update.kind) {
      case 'create-entity': {
        const entity = await createEntity(ctx, payload.update.entity);
        return { stage: 'world-update', update: { kind: 'create-entity', entityId: entity.id } };
      }
      case 'update-entity': {
        const entity = await updateEntity(ctx, {
          entityId: payload.update.entityId,
          name: payload.update.name,
          description: payload.update.description,
          attributes: payload.update.attributes,
        });
        return { stage: 'world-update', update: { kind: 'update-entity', entityId: entity.id } };
      }
      case 'create-relationship': {
        const relationship = await createRelationship(ctx, {
          type: payload.update.relationship.type,
          fromEntityId: payload.update.relationship.fromEntityId,
          toEntityId: payload.update.relationship.toEntityId,
          attributes: payload.update.relationship.attributes,
        });
        return {
          stage: 'world-update',
          update: {
            kind: 'create-relationship',
            relationshipId: relationship.id,
            fromEntityId: relationship.fromEntityId,
            toEntityId: relationship.toEntityId,
          },
        };
      }
    }
  } catch (error) {
    throw mapWorldError(error);
  }
}

/** 4 — epistemic evaluation: record claims derived from evidence (W007). */
async function runEpistemicEvaluationStage(
  ctx: TenantContext,
  payload: Extract<ValidatedAdvance, { stage: 'epistemic-evaluation' }>,
): Promise<StageResult> {
  const claimIds: string[] = [];
  for (const claim of payload.claims) {
    try {
      const recorded = await recordClaim(ctx, {
        proposition: claim.proposition,
        subject: claim.subject,
        confidence: claim.confidence,
        evidenceObservationIds: claim.evidenceObservationIds,
        rationale: claim.rationale,
      });
      claimIds.push(recorded.id);
    } catch (error) {
      throw mapEpistemicsError(error);
    }
  }
  return { stage: 'epistemic-evaluation', claimIds };
}

/** 5 — goal evaluation: compare the focus with active goals (W008). */
async function runGoalEvaluationStage(
  ctx: TenantContext,
  payload: Extract<ValidatedAdvance, { stage: 'goal-evaluation' }>,
): Promise<StageResult> {
  const activeGoals = await listGoals(ctx, { status: 'active', limit: 500 });
  for (const goalId of payload.relatedGoalIds) {
    let goal;
    try {
      goal = await getGoal(ctx, goalId);
    } catch (error) {
      throw mapGoalsError(error, goalId);
    }
    if (goal.content.status !== 'active') {
      throw stageInputError(
        `related goal '${goalId}' is ${goal.content.status} — goal evaluation compares the focus with CURRENT direction`,
      );
    }
  }
  return {
    stage: 'goal-evaluation',
    goalIds: payload.relatedGoalIds,
    activeGoalCount: activeGoals.length,
  };
}

/** 6 — unknown/mission evaluation: identify unknowns, launch missions (W007 + W011). */
async function runUnknownMissionStage(
  ctx: TenantContext,
  row: ExecutionRow,
  payload: Extract<ValidatedAdvance, { stage: 'unknown-mission-evaluation' }>,
): Promise<StageResult> {
  const unknownIds: string[] = [];
  for (const unknown of payload.unknowns) {
    try {
      const recorded = await recordUnknown(ctx, toUnknownInput(unknown));
      unknownIds.push(recorded.id);
    } catch (error) {
      throw mapEpistemicsError(error);
    }
  }
  const actor = { kind: row.actor_kind, id: row.actor_id, label: row.actor_label };
  const missionIds: string[] = [];
  for (const mission of payload.missions) {
    try {
      const created = await createMission(ctx, toMissionCreateInput(mission, actor, row.id));
      missionIds.push(created.id);
    } catch (error) {
      throw mapMissionsError(error);
    }
  }
  return { stage: 'unknown-mission-evaluation', unknownIds, missionIds };
}

function toUnknownInput(unknown: UnknownDerivationInput): {
  question: string;
  consequence: string;
  subject?: { kind: string; id: string } | null;
  relatedObservationIds?: string[];
  relatedClaimIds?: string[];
  relatedBeliefIds?: string[];
  note?: string | null;
} {
  return {
    question: unknown.question,
    consequence: unknown.consequence,
    subject: unknown.subject,
    relatedObservationIds: unknown.relatedObservationIds,
    relatedClaimIds: unknown.relatedClaimIds,
    relatedBeliefIds: unknown.relatedBeliefIds,
    note: unknown.note,
  };
}

function toMissionCreateInput(
  mission: MissionLaunchInput,
  actor: { kind: string; id: string | null; label: string | null },
  executionId: string,
): Parameters<typeof createMission>[1] {
  return {
    title: mission.title,
    knowledgeObjective: mission.knowledgeObjective,
    affectedGoals: mission.affectedGoals,
    unknownIds: mission.unknownIds,
    informationValue: mission.informationValue,
    urgency: mission.urgency,
    currentConfidence: mission.currentConfidence,
    targetConfidence: mission.targetConfidence,
    investigationBudget: mission.investigationBudget,
    rewardBudget: mission.rewardBudget,
    rewardTerms: mission.rewardTerms,
    candidateSources: mission.candidateSources,
    completionCriteria: mission.completionCriteria,
    actor: { kind: actor.kind as 'person' | 'team' | 'agent' | 'system' | 'external', id: actor.id, label: actor.label },
    rationale: mission.rationale ?? `cognition execution ${executionId} · unknown-mission-evaluation`,
  };
}

/** 7 — knowledge acquisition (fresh): drive the W012 planner for one mission. */
async function runKnowledgeAcquisitionFresh(
  ctx: TenantContext,
  row: ExecutionRow,
  payload: Extract<ValidatedAdvance, { stage: 'knowledge-acquisition' }>,
): Promise<{ result: StageResult } | { suspend: { planId: string } }> {
  if (payload.missionId === null) {
    return {
      result: {
        stage: 'knowledge-acquisition',
        missionId: null,
        decision: 'no-mission',
        planId: null,
        chosen: null,
        action: null,
        outcome: null,
        missionConfidence: null,
        missionCompleted: false,
      },
    };
  }

  let mission: Mission;
  try {
    mission = await getMission(ctx, payload.missionId);
  } catch (error) {
    throw mapMissionsError(error);
  }
  if (mission.content.status !== 'active') {
    throw stageInputError(
      `mission '${payload.missionId}' is ${mission.content.status} — only an active mission can be acquired for; define a new mission instead`,
    );
  }

  // Deterministic workflow-level ADR-0018 signals from transactive memory
  // (W052 knowledge source ranking replaces this default later).
  const transactive = await listTransactiveEntries(ctx, {
    topics: mapStrings(row.focus_topics),
    limit: 500,
  });
  const signals = deriveAcquisitionSignals({
    focusTopics: mapStrings(row.focus_topics),
    menu: mission.content.candidateSources,
    transactive: transactive.map((entry) => ({
      actorKind: entry.actor.kind,
      actorId: entry.actor.id ?? null,
      topics: entry.topics,
    })),
  });

  let plan: AcquisitionPlan;
  try {
    plan = await planNextAcquisition(ctx, {
      missionId: payload.missionId,
      candidates: signals,
      actor: {
        kind: row.actor_kind as 'person' | 'team' | 'agent' | 'system' | 'external',
        id: row.actor_id,
        label: row.actor_label,
      },
      rationale: `cognition execution ${row.id} · knowledge-acquisition`,
    });
  } catch (error) {
    throw mapKnowledgeAcquisitionError(error);
  }

  if (plan.decision === 'no_candidate') {
    return {
      result: {
        stage: 'knowledge-acquisition',
        missionId: payload.missionId,
        decision: 'no_candidate',
        planId: plan.id,
        chosen: null,
        action: null,
        outcome: null,
        missionConfidence: null,
        missionCompleted: false,
      },
    };
  }

  // Selected: the acquisition happens in the world, not in a transaction —
  // suspend until the plan carries its terminal outcome (lock 36).
  return { suspend: { planId: plan.id } };
}

/** 7 — knowledge acquisition (resume): apply the landed outcome. */
async function runKnowledgeAcquisitionResume(
  ctx: TenantContext,
  row: ExecutionRow,
  planId: string,
): Promise<{ result: StageResult } | { stillAwaiting: true }> {
  let plan: AcquisitionPlan;
  try {
    plan = await getAcquisitionPlan(ctx, planId);
  } catch (error) {
    throw mapKnowledgeAcquisitionError(error);
  }
  if (plan.outcome === null) {
    return { stillAwaiting: true };
  }

  const actor = {
    kind: row.actor_kind as 'person' | 'team' | 'agent' | 'system' | 'external',
    id: row.actor_id,
    label: row.actor_label,
  };
  let missionConfidence: { from: number; to: number } | null = null;
  let missionCompleted = false;

  if (plan.outcome.outcome === 'answered' && plan.outcome.evidenceObservationId !== null) {
    // The answer's evidence confidence raises the mission's confidence —
    // exactly the orchestration the W012 contract documents as W013's job.
    let evidence: Observation;
    try {
      evidence = await getObservation(ctx, plan.outcome.evidenceObservationId);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw mapObservationReadError(error, plan.outcome.evidenceObservationId);
      }
      throw error;
    }
    const evidenceConfidence = evidence.confidence.value;
    let mission: Mission;
    try {
      mission = await getMission(ctx, plan.missionId);
    } catch (error) {
      throw mapMissionsError(error);
    }
    if (mission.content.status === 'active') {
      const from = mission.content.currentConfidence;
      const to = Math.max(from, evidenceConfidence);
      try {
        if (to >= mission.content.targetConfidence) {
          // The gap closed: the mission completes with what was achieved.
          await completeMission(ctx, {
            missionId: mission.id,
            achievedConfidence: to,
            outcome: `Cognition execution ${row.id} closed the confidence gap via acquisition plan ${planId} (evidence confidence ${to}).`,
            actor,
          });
          missionCompleted = true;
          missionConfidence = { from, to };
        } else if (to > from) {
          await reviseMission(ctx, {
            missionId: mission.id,
            currentConfidence: to,
            actor,
            rationale: `acquisition plan ${planId} answered with evidence confidence ${to}`,
          });
          missionConfidence = { from, to };
        }
      } catch (error) {
        throw mapMissionsError(error);
      }
    }
  }

  return {
    result: {
      stage: 'knowledge-acquisition',
      missionId: plan.missionId,
      decision: 'selected',
      planId: plan.id,
      chosen: plan.chosen,
      action: plan.action,
      outcome: {
        kind: plan.outcome.outcome,
        note: plan.outcome.note,
        evidenceObservationId: plan.outcome.evidenceObservationId,
      },
      missionConfidence,
      missionCompleted,
    },
  };
}

/** 8 — model update: form/revise the working understanding (W007). */
async function runModelUpdateStage(
  ctx: TenantContext,
  payload: Extract<ValidatedAdvance, { stage: 'model-update' }>,
): Promise<StageResult> {
  if (payload.belief === null) {
    return { stage: 'model-update', beliefId: null, beliefVersion: null };
  }
  const beliefInput = {
    proposition: payload.belief.proposition,
    confidence: payload.belief.confidence,
    supportingObservationIds: payload.belief.supportingObservationIds,
    supportingClaimIds: payload.belief.supportingClaimIds,
    alternatives: payload.belief.alternatives,
    disconfirmation: payload.belief.disconfirmation,
    subject: payload.belief.subject,
    validFrom: payload.belief.validFrom,
    rationale: payload.belief.rationale,
  };
  try {
    if (payload.belief.beliefId !== null && payload.belief.beliefId !== undefined) {
      const belief = await reviseBelief(ctx, { beliefId: payload.belief.beliefId, ...beliefInput });
      return { stage: 'model-update', beliefId: belief.id, beliefVersion: belief.version };
    }
    const belief = await formBelief(ctx, beliefInput);
    return { stage: 'model-update', beliefId: belief.id, beliefVersion: belief.version };
  } catch (error) {
    throw mapEpistemicsError(error);
  }
}

/** 9 — risk/opportunity/capability analysis: record the cycle's findings. */
async function runAnalysisStage(
  ctx: TenantContext,
  payload: Extract<ValidatedAdvance, { stage: 'risk-opportunity-capability-analysis' }>,
): Promise<StageResult> {
  for (const finding of payload.findings) {
    for (const observationId of finding.evidenceObservationIds ?? []) {
      try {
        await getObservation(ctx, observationId);
      } catch (error) {
        if (error instanceof ObservationsError) {
          throw mapObservationReadError(error, observationId);
        }
        throw error;
      }
    }
    for (const goalId of finding.affectedGoalIds ?? []) {
      try {
        await getGoal(ctx, goalId);
      } catch (error) {
        throw mapGoalsError(error, goalId);
      }
    }
  }
  return {
    stage: 'risk-opportunity-capability-analysis',
    findings: payload.findings.map((finding) => ({
      kind: finding.kind,
      statement: finding.statement,
      evidenceObservationIds: finding.evidenceObservationIds ?? [],
      affectedGoalIds: finding.affectedGoalIds ?? [],
    })),
  };
}

function actionRequestSnapshot(request: ActionRequest): ActionGateResult['actionRequest'] {
  return {
    id: request.id,
    actionKind: request.actionKind,
    authorityLevel: request.authorityLevel,
    status: request.status,
    outcome: request.evaluation.outcome,
    resolvedVia: request.evaluation.resolvedVia,
  };
}

/** 10 — recommendation/ask/proposal/action (fresh): THE POLICY GATE (W009). */
async function runActionStageFresh(
  ctx: TenantContext,
  row: ExecutionRow,
  payload: Extract<ValidatedAdvance, { stage: 'recommendation-ask-proposal-action' }>,
): Promise<{ result: StageResult } | { suspend: { requestId: string } }> {
  if (payload.action === null) {
    return { result: { stage: 'recommendation-ask-proposal-action', actionRequest: null, gate: null, resolution: null } };
  }
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: payload.action.actionKind,
      authorityLevel: payload.action.authorityLevel,
      payload: payload.action.payload,
      justification: payload.action.justification,
      // Stable per execution: retried authorizations from asynchronous
      // cognition never duplicate gate history (lock 36; the actions
      // module replays recorded keys).
      idempotencyKey: `cognition:${row.id}:action`,
    });
  } catch (error) {
    throw mapActionsError(error);
  }
  if (request.status === 'pending') {
    // The matrix routed the action to a human decision — suspend.
    return { suspend: { requestId: request.id } };
  }
  return {
    result: {
      stage: 'recommendation-ask-proposal-action',
      actionRequest: actionRequestSnapshot(request),
      gate: request.evaluation.outcome,
      resolution: null,
    },
  };
}

/** 10 — recommendation/ask/proposal/action (resume): re-check the gate. */
async function runActionStageResume(
  ctx: TenantContext,
  requestId: string,
): Promise<{ result: StageResult } | { stillAwaiting: true }> {
  let request: ActionRequest;
  try {
    request = await getActionRequest(ctx, { requestId });
  } catch (error) {
    throw mapActionsError(error);
  }
  if (request.status === 'pending') {
    return { stillAwaiting: true };
  }
  return {
    result: {
      stage: 'recommendation-ask-proposal-action',
      actionRequest: actionRequestSnapshot(request),
      gate: request.evaluation.outcome,
      resolution: request.status === 'approved' ? 'approved' : 'rejected',
    },
  };
}

/** 11 — outcome: record the cycle's outcome (derived from the gate result). */
async function runOutcomeStage(
  ctx: TenantContext,
  row: ExecutionRow,
  payload: Extract<ValidatedAdvance, { stage: 'outcome' }>,
): Promise<{ result: StageResult; outcome: NonNullable<CommitStepParams['outcome']> }> {
  const actionStep = await findStepRow(ctx, row.id, stageNumberOf('recommendation-ask-proposal-action'));
  const gate = actionStep.result as Extract<StageResult, { stage: 'recommendation-ask-proposal-action' }>;
  const kind = outcomeKindForActionGate(gate);
  const actionRequestId = gate.actionRequest === null ? null : gate.actionRequest.id;
  return {
    result: { stage: 'outcome', kind, summary: payload.summary, actionRequestId },
    outcome: {
      kind,
      summary: payload.summary,
      actionRequestId,
      recordedAt: now(),
    },
  };
}

/** 12 — learning: capture the durable learning (W010), then complete. */
async function runLearningStage(
  ctx: TenantContext,
  row: ExecutionRow,
  payload: Extract<ValidatedAdvance, { stage: 'learning' }>,
): Promise<StageResult> {
  if (payload.knowledge === null) {
    return { stage: 'learning', knowledgeEntryId: null };
  }
  const observationStep = await findStepRow(ctx, row.id, stageNumberOf('observation'));
  const observationResult = observationStep.result as Extract<StageResult, { stage: 'observation' }>;
  const citations = observationResult.observationIds.slice(0, MAX_EVIDENCE_REFS);
  if (citations.length < 1) {
    throw stageInputError(
      'capturing learning requires cycle evidence — the observation stage recorded none',
    );
  }
  try {
    const entry = await recordKnowledgeEntry(ctx, {
      kind: 'insight',
      title: payload.knowledge.title,
      summary: payload.knowledge.summary,
      topics: payload.knowledge.topics,
      entities: mapFocusEntities(row.focus_entities),
      evidenceObservationIds: citations,
    });
    return { stage: 'learning', knowledgeEntryId: entry.id };
  } catch (error) {
    throw mapMemoryError(error);
  }
}

// ---------------------------------------------------------------------------
// runNextStage — the worker pump
// ---------------------------------------------------------------------------

export async function runNextStage(
  ctx: TenantContext,
  input: unknown,
): Promise<CognitiveExecutionTrace> {
  assertCognitionTenantContext(ctx);

  // Early executionId extraction (validateAdvanceInput needs the expected
  // stage first — the loop's order is decided by the execution, not the caller).
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw stageInputError('advance input must be an object');
  }
  const rawId = (input as { executionId?: unknown }).executionId;
  if (!isUuid(rawId)) {
    throw stageInputError('executionId must be a uuid');
  }

  const row = await findExecutionRow(ctx, rawId);
  if (row.state === 'completed' || row.state === 'abandoned') {
    throw new CognitionError(
      'invalid_transition',
      `cognitive execution '${row.id}' is ${row.state} — terminal executions cannot advance; start a new cycle instead`,
    );
  }
  const stageNumber = toInt(row.current_stage) + 1;
  const expectedStage = stageAtNumber(stageNumber)!; // live states always have one (CHECK: current_stage = 12 ⇒ completed)
  const { payload } = validateAdvanceInput(input, expectedStage);

  // --- resumptions (lock 36) ---
  if (row.state === 'awaiting_input') {
    if (expectedStage !== 'knowledge-acquisition') {
      throw new CognitionError(
        'execution_conflict',
        `execution '${row.id}' is awaiting input at stage '${expectedStage}' — unexpected suspension shape`,
      );
    }
    const planId = row.pending_plan_id!;
    const resumed = await runKnowledgeAcquisitionResume(ctx, row, planId);
    if ('stillAwaiting' in resumed) {
      return mapTrace(row, await loadSteps(ctx, row.id));
    }
    const advanced = await commitStep(ctx, {
      executionId: row.id,
      stageNumber,
      stage: expectedStage,
      input: payload,
      result: resumed.result,
      fromState: 'awaiting_input',
      completes: false,
    });
    return mapTrace(advanced, await loadSteps(ctx, row.id));
  }

  if (row.state === 'awaiting_approval') {
    if (expectedStage !== 'recommendation-ask-proposal-action') {
      throw new CognitionError(
        'execution_conflict',
        `execution '${row.id}' is awaiting approval at stage '${expectedStage}' — unexpected suspension shape`,
      );
    }
    const requestId = row.pending_request_id!;
    const resumed = await runActionStageResume(ctx, requestId);
    if ('stillAwaiting' in resumed) {
      return mapTrace(row, await loadSteps(ctx, row.id));
    }
    const advanced = await commitStep(ctx, {
      executionId: row.id,
      stageNumber,
      stage: expectedStage,
      input: payload,
      result: resumed.result,
      fromState: 'awaiting_approval',
      completes: false,
    });
    return mapTrace(advanced, await loadSteps(ctx, row.id));
  }

  // --- fresh stage dispatch (state === 'running') ---
  switch (expectedStage) {
    case 'observation': {
      const result = await runObservationStage(ctx, row, payload as Extract<ValidatedAdvance, { stage: 'observation' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'evidence-memory': {
      const result = await runEvidenceMemoryStage(ctx, row);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'world-update': {
      const result = await runWorldUpdateStage(ctx, payload as Extract<ValidatedAdvance, { stage: 'world-update' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'epistemic-evaluation': {
      const result = await runEpistemicEvaluationStage(ctx, payload as Extract<ValidatedAdvance, { stage: 'epistemic-evaluation' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'goal-evaluation': {
      const result = await runGoalEvaluationStage(ctx, payload as Extract<ValidatedAdvance, { stage: 'goal-evaluation' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'unknown-mission-evaluation': {
      const result = await runUnknownMissionStage(ctx, row, payload as Extract<ValidatedAdvance, { stage: 'unknown-mission-evaluation' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'knowledge-acquisition': {
      const fresh = await runKnowledgeAcquisitionFresh(ctx, row, payload as Extract<ValidatedAdvance, { stage: 'knowledge-acquisition' }>);
      if ('suspend' in fresh) {
        const suspended = await suspendExecution(ctx, {
          executionId: row.id,
          fromStageNumber: toInt(row.current_stage),
          state: 'awaiting_input',
          pendingPlanId: fresh.suspend.planId,
        });
        return mapTrace(suspended, await loadSteps(ctx, row.id));
      }
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result: fresh.result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'model-update': {
      const result = await runModelUpdateStage(ctx, payload as Extract<ValidatedAdvance, { stage: 'model-update' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'risk-opportunity-capability-analysis': {
      const result = await runAnalysisStage(ctx, payload as Extract<ValidatedAdvance, { stage: 'risk-opportunity-capability-analysis' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'recommendation-ask-proposal-action': {
      const fresh = await runActionStageFresh(ctx, row, payload as Extract<ValidatedAdvance, { stage: 'recommendation-ask-proposal-action' }>);
      if ('suspend' in fresh) {
        const suspended = await suspendExecution(ctx, {
          executionId: row.id,
          fromStageNumber: toInt(row.current_stage),
          state: 'awaiting_approval',
          pendingRequestId: fresh.suspend.requestId,
        });
        return mapTrace(suspended, await loadSteps(ctx, row.id));
      }
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result: fresh.result,
        fromState: 'running',
        completes: false,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'outcome': {
      const { result, outcome } = await runOutcomeStage(ctx, row, payload as Extract<ValidatedAdvance, { stage: 'outcome' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: false,
        outcome,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
    case 'learning': {
      const result = await runLearningStage(ctx, row, payload as Extract<ValidatedAdvance, { stage: 'learning' }>);
      const advanced = await commitStep(ctx, {
        executionId: row.id,
        stageNumber,
        stage: expectedStage,
        input: payload,
        result,
        fromState: 'running',
        completes: true,
      });
      return mapTrace(advanced, await loadSteps(ctx, row.id));
    }
  }
}

// ---------------------------------------------------------------------------
// abandonExecution
// ---------------------------------------------------------------------------

export async function abandonExecution(
  ctx: TenantContext,
  input: unknown,
): Promise<CognitiveExecutionTrace> {
  assertCognitionTenantContext(ctx);
  const valid = validateAbandonInput(input);
  const row = await findExecutionRow(ctx, valid.executionId);
  if (row.state === 'completed' || row.state === 'abandoned') {
    throw new CognitionError(
      'invalid_transition',
      `cognitive execution '${row.id}' is ${row.state} — terminal executions cannot be abandoned`,
    );
  }
  const stamp = now();
  const updated = await getDb().query<ExecutionRow>(
    `UPDATE cognitive_executions
       SET state = 'abandoned',
           pending_plan_id = NULL,
           pending_request_id = NULL,
           abandon_reason = $3,
           abandoned_at = $4::timestamptz,
           updated_at = $4::timestamptz
     WHERE tenant_id = $1 AND id = $2
       AND state IN ('running', 'awaiting_input', 'awaiting_approval')
     RETURNING *`,
    [ctx.tenantId, valid.executionId, valid.reason, stamp],
  );
  if (updated.rows.length !== 1) {
    throw new CognitionError(
      'execution_conflict',
      `cognitive execution '${valid.executionId}' moved before it could be abandoned — retry`,
    );
  }
  return mapTrace(updated.rows[0]!, await loadSteps(ctx, valid.executionId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getExecution(
  ctx: TenantContext,
  query: { executionId: string },
): Promise<CognitiveExecutionTrace> {
  assertCognitionTenantContext(ctx);
  if (!isPlainObjectQuery(query) || !isUuid(query.executionId)) {
    throw new CognitionError('invalid_query', 'execution query must carry an executionId uuid');
  }
  const row = await findExecutionRow(ctx, query.executionId);
  return mapTrace(row, await loadSteps(ctx, row.id));
}

export async function getExecutionStep(
  ctx: TenantContext,
  query: unknown,
): Promise<CognitiveExecutionStep> {
  assertCognitionTenantContext(ctx);
  const valid = validateStepQuery(query);
  await findExecutionRow(ctx, valid.executionId); // uniform execution_not_found
  const step = await findStepRow(ctx, valid.executionId, stageNumberOf(valid.stage));
  return mapStep(step);
}

export async function listExecutions(
  ctx: TenantContext,
  query: unknown,
): Promise<CognitiveExecution[]> {
  assertCognitionTenantContext(ctx);
  const valid = validateListExecutionsQuery(query);
  const conditions = [`tenant_id = $1`];
  const params: unknown[] = [ctx.tenantId];
  if (valid.state !== null) {
    params.push(valid.state);
    conditions.push(`state = $${params.length}`);
  }
  if (valid.triggerKind !== null) {
    params.push(valid.triggerKind);
    conditions.push(`trigger_kind = $${params.length}`);
  }
  if (valid.correlationId !== null) {
    params.push(valid.correlationId);
    conditions.push(`correlation_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ExecutionRow>(
    `SELECT * FROM cognitive_executions
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapExecution);
}

function isPlainObjectQuery(value: unknown): value is { executionId?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
