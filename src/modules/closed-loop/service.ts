// The closed-loop module's service (W140 — Unified Closed-Loop
// Learning). Everything the contract exposes is implemented here; the
// contract re-exports the public surface only.
//
// SEAM MAP (consumed through their public contracts ONLY — reads,
// never mutations; every citation gated on the BASE connection BEFORE
// the mutation transaction, the W134 law):
//
//   goals W008            getGoal            the loop's subject goal
//                                           (ACTIVE at record time,
//                                           version snapshotted)
//   agent-exchange W136   listExecutionRuns  reality deviations citing
//                                           execution runs (plan-scoped)
//   execution-fabric W137 getFabricLease    reality deviations citing
//                                           fabric leases
//   org-lab W135          getRecommendation  reality deviations citing
//                                           calibrated organization
//                                           recommendations
//   coverage W125         listGaps           knowledge deviations
//                                           citing material coverage
//                                           gaps (snapshot-scoped)
//   learning W053         listLearningUpdates knowledge deviations
//                                           citing CompanyModel
//                                           learning events;
//                                           isCompanyModelSubjectKind
//                                           for company-model signal
//                                           targets
//   info-strategy W134    getStrategy        ranking-signal targets
//                                           (goal-matched with the
//                                           cycle's goal)
//   org-lab W135          getCandidate       ranking-signal targets
//
// NO SECOND LEARNING AUTHORITY (acceptance clause 2, structural): this
// service never calls any seam's mutation. Learning reaches future
// ranking ONLY through recorded, advisory, reviewable ranking signals
// addressed to the three ranking input channels; policy and settings
// surfaces are refused with the dedicated typed code. The unit suite
// locks the import surface: every seam import above is a read.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding): PGlite is
// single-connection, so a base-connection read inside an open
// db.transaction(...) starves the embedded database. EVERY cross-module
// evidence gate and every own-table metric computation therefore runs
// BEFORE the transaction opens; each mutation then keeps its spine
// write + evidence appends atomic in ONE transaction whose statements
// touch only this module's tables:
//
//   * recordLoopCycle — all seam gates first, then ONE transaction
//     minting the per-(tenant, goal) cycle number and appending the
//     spine + both deviation classes.
//   * applyRankingSignal — the cycle + target gates first, then ONE
//     transaction re-checking the cycle is still open under a FOR
//     UPDATE row lock before the signal append.
//   * closeLoopCycle — the metric computation (own tables, base
//     connection) first, then ONE transaction re-checking the open
//     state under a FOR UPDATE row lock before the one-way close.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by newId(); semantic
// timestamps come from the injectable clock and are never
// caller-supplied; principals are system-captured from the explicit
// TenantContext; every statement is scoped by tenant (ADR-0001) —
// cross-tenant access is indistinguishable from missing records
// (uniform typed not-found, no existence leak).
//
// Deterministic orders (test-locked): cycles newest-recorded first for
// lists (recorded_at DESC, id DESC), ascending by cycle number for the
// trajectory; deviations and signals in timeline order within a cycle
// (recorded_at ASC, id ASC).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { listExecutionRuns, AgentExchangeError } from '@/modules/agent-exchange/contract';
import { getFabricLease, ExecutionFabricError } from '@/modules/execution-fabric/contract';
import { listGaps, CoverageError } from '@/modules/coverage/contract';
import {
  listLearningUpdates,
  LearningError,
} from '@/modules/learning/contract';
import { getStrategy, InfoStrategyError } from '@/modules/info-strategy/contract';
import { getCandidate, getRecommendation, OrgLabError } from '@/modules/org-lab/contract';
import { ClosedLoopError } from './errors';
import {
  calibrationErrorOf,
  deviationRecurrenceOf,
  gapClosureRateOf,
  observedScoreOf,
  assertClosedLoopTenantContext,
  validateApplyRankingSignalInput,
  validateCloseLoopCycleInput,
  validateGetLoopCycleQuery,
  validateGetLoopTrajectoryQuery,
  validateListLoopCyclesQuery,
  validateListRankingSignalsQuery,
  validateRecordLoopCycleInput,
  validateSummarizeLoopImprovementQuery,
  improvementVerdictOf,
  isCompanyModelSubjectKey,
  magnitudeOf,
} from './validation';
import type {
  ImprovementVerdict,
  KnowledgeDeviation,
  ListLoopCyclesQuery,
  ListRankingSignalsQuery,
  LoopCycle,
  LoopCycleMetrics,
  LoopCycleSummary,
  LoopImprovementSummary,
  LoopTrajectory,
  LoopTrajectoryPoint,
  RankingSignal,
  RealityDeviation,
} from './types';

// ---------------------------------------------------------------------------
// Row types + mappers (own tables only)
// ---------------------------------------------------------------------------

interface CycleRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  goal_version: string | number;
  cycle_number: string | number;
  status: string;
  predicted_score: string | number;
  observed_score: string | number | null;
  calibration_error: string | number | null;
  gap_closure_rate: string | number | null;
  deviation_recurrence: string | number | null;
  reality_count: string | number;
  knowledge_count: string | number;
  rationale: string;
  close_note: string | null;
  recorded_by: string;
  recorded_at: Date | string;
  closed_at: Date | string | null;
  closed_by: string | null;
}

interface RealityRow extends DbRow {
  id: string;
  tenant_id: string;
  cycle_id: string;
  source_kind: string;
  source_ref: string;
  plan_ref: string | null;
  expected: string | number;
  observed: string | number;
  magnitude: string | number;
  note: string;
  recorded_at: Date | string;
}

interface KnowledgeRow extends DbRow {
  id: string;
  tenant_id: string;
  cycle_id: string;
  source_kind: string;
  source_ref: string;
  snapshot_ref: string | null;
  severity: string | number;
  note: string;
  recorded_at: Date | string;
}

interface SignalRow extends DbRow {
  id: string;
  tenant_id: string;
  cycle_id: string;
  target_seam: string;
  target_ref: string;
  direction: string;
  magnitude: string | number;
  basis: string;
  rationale: string;
  recorded_by: string;
  recorded_at: Date | string;
}

function isoRequired(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function numRequired(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function intRequired(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function mapReality(row: RealityRow): RealityDeviation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cycleId: row.cycle_id,
    sourceKind: row.source_kind as RealityDeviation['sourceKind'],
    sourceRef: row.source_ref,
    planRef: row.plan_ref,
    expected: numRequired(row.expected),
    observed: numRequired(row.observed),
    magnitude: numRequired(row.magnitude),
    note: row.note,
    recordedAt: isoRequired(row.recorded_at),
  };
}

function mapKnowledge(row: KnowledgeRow): KnowledgeDeviation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cycleId: row.cycle_id,
    sourceKind: row.source_kind as KnowledgeDeviation['sourceKind'],
    sourceRef: row.source_ref,
    snapshotRef: row.snapshot_ref,
    severity: numRequired(row.severity),
    note: row.note,
    recordedAt: isoRequired(row.recorded_at),
  };
}

function mapSignal(row: SignalRow): RankingSignal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cycleId: row.cycle_id,
    targetSeam: row.target_seam as RankingSignal['targetSeam'],
    targetRef: row.target_ref,
    direction: row.direction as RankingSignal['direction'],
    magnitude: numRequired(row.magnitude),
    basis: row.basis as RankingSignal['basis'],
    rationale: row.rationale,
    // Minted — advisory only, never caller-suppliable (the policy-
    // authority law; the learning module's W041/W053 precedent).
    authoritative: false,
    recordedBy: row.recorded_by,
    recordedAt: isoRequired(row.recorded_at),
  };
}

function metricsOf(row: CycleRow): LoopCycleMetrics | null {
  if (row.status !== 'closed') return null;
  return {
    observedScore: num(row.observed_score),
    calibrationError: num(row.calibration_error),
    gapClosureRate: num(row.gap_closure_rate),
    deviationRecurrence: num(row.deviation_recurrence),
    realityCount: intRequired(row.reality_count),
    knowledgeCount: intRequired(row.knowledge_count),
  };
}

// ---------------------------------------------------------------------------
// Own-table loaders (tenant-scoped; uniform not-found)
// ---------------------------------------------------------------------------

function cycleNotFound(cycleId: string): ClosedLoopError {
  return new ClosedLoopError(
    'cycle_not_found',
    `loop cycle '${cycleId}' does not exist in this tenant`,
  );
}

async function loadCycleRow(
  db: Queryable,
  ctx: TenantContext,
  cycleId: string,
  forUpdate: boolean,
): Promise<CycleRow> {
  const result = await db.query<CycleRow>(
    `SELECT * FROM loop_cycles
      WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, cycleId],
  );
  const row = result.rows[0];
  if (!row) throw cycleNotFound(cycleId);
  return row;
}

async function listRealityRows(db: Queryable, ctx: TenantContext, cycleId: string): Promise<RealityRow[]> {
  const result = await db.query<RealityRow>(
    `SELECT * FROM loop_reality_deviations
      WHERE tenant_id = $1 AND cycle_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, cycleId],
  );
  return result.rows;
}

async function listKnowledgeRows(db: Queryable, ctx: TenantContext, cycleId: string): Promise<KnowledgeRow[]> {
  const result = await db.query<KnowledgeRow>(
    `SELECT * FROM loop_knowledge_deviations
      WHERE tenant_id = $1 AND cycle_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, cycleId],
  );
  return result.rows;
}

async function listSignalRows(db: Queryable, ctx: TenantContext, cycleId: string): Promise<SignalRow[]> {
  const result = await db.query<SignalRow>(
    `SELECT * FROM loop_ranking_signals
      WHERE tenant_id = $1 AND cycle_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, cycleId],
  );
  return result.rows;
}

/** The most recent CLOSED cycle of the same goal before `cycleNumber`. */
async function loadPreviousClosedCycle(
  db: Queryable,
  ctx: TenantContext,
  goalId: string,
  cycleNumber: number,
): Promise<CycleRow | null> {
  const result = await db.query<CycleRow>(
    `SELECT * FROM loop_cycles
      WHERE tenant_id = $1 AND goal_id = $2 AND status = 'closed' AND cycle_number < $3
      ORDER BY cycle_number DESC
      LIMIT 1`,
    [ctx.tenantId, goalId, cycleNumber],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The seam gates (BASE connection, BEFORE every mutation — the W134 law)
// ---------------------------------------------------------------------------

async function gateSubjectGoal(ctx: TenantContext, goalId: string): Promise<Goal> {
  try {
    const goal = await getGoal(ctx, goalId);
    if (goal.content.status !== 'active') {
      throw new ClosedLoopError(
        'goal_not_active',
        `goal '${goalId}' is ${goal.content.status} — the loop runs against current direction only`,
      );
    }
    return goal;
  } catch (error) {
    if (error instanceof ClosedLoopError) throw error;
    if (error instanceof GoalsError) {
      throw new ClosedLoopError('goal_not_found', `goal '${goalId}' does not exist in this tenant`);
    }
    throw error;
  }
}

async function gateRealityDeviations(
  ctx: TenantContext,
  deviations: readonly {
    sourceKind: string;
    sourceRef: string;
    planRef: string | null;
  }[],
): Promise<void> {
  for (const deviation of deviations) {
    if (deviation.sourceKind === 'execution_run') {
      try {
        const runs = await listExecutionRuns(ctx, { planId: deviation.planRef as string, limit: 200 });
        if (!runs.some((run) => run.id === deviation.sourceRef)) {
          throw new ClosedLoopError(
            'run_not_found',
            `execution run '${deviation.sourceRef}' is not recorded on plan '${deviation.planRef}'`,
          );
        }
      } catch (error) {
        if (error instanceof ClosedLoopError) throw error;
        if (error instanceof AgentExchangeError) {
          throw new ClosedLoopError(
            'run_not_found',
            `execution run '${deviation.sourceRef}' is not recorded on plan '${deviation.planRef}'`,
          );
        }
        throw error;
      }
    } else if (deviation.sourceKind === 'fabric_lease') {
      try {
        await getFabricLease(ctx, { leaseId: deviation.sourceRef });
      } catch (error) {
        if (error instanceof ExecutionFabricError) {
          throw new ClosedLoopError(
            'lease_not_found',
            `fabric lease '${deviation.sourceRef}' does not exist in this tenant`,
          );
        }
        throw error;
      }
    } else if (deviation.sourceKind === 'org_calibration') {
      try {
        await getRecommendation(ctx, { recommendationId: deviation.sourceRef });
      } catch (error) {
        if (error instanceof OrgLabError) {
          throw new ClosedLoopError(
            'recommendation_not_found',
            `org-lab recommendation '${deviation.sourceRef}' does not exist in this tenant`,
          );
        }
        throw error;
      }
    }
    // 'goal_metric' citations cite the cycle's own goal — gated above.
  }
}

async function gateKnowledgeDeviations(
  ctx: TenantContext,
  deviations: readonly {
    sourceKind: string;
    sourceRef: string;
    snapshotRef: string | null;
  }[],
): Promise<void> {
  for (const deviation of deviations) {
    if (deviation.sourceKind === 'coverage_gap') {
      try {
        const gaps = await listGaps(ctx, { snapshotId: deviation.snapshotRef as string, limit: 200 });
        if (!gaps.some((gap) => gap.id === deviation.sourceRef)) {
          throw new ClosedLoopError(
            'gap_not_found',
            `coverage gap '${deviation.sourceRef}' is not part of snapshot '${deviation.snapshotRef}'`,
          );
        }
      } catch (error) {
        if (error instanceof ClosedLoopError) throw error;
        if (error instanceof CoverageError) {
          throw new ClosedLoopError(
            'gap_not_found',
            `coverage gap '${deviation.sourceRef}' does not resolve on snapshot '${deviation.snapshotRef}'`,
          );
        }
        throw error;
      }
    } else if (deviation.sourceKind === 'learning_update') {
      try {
        const updates = await listLearningUpdates(ctx, { limit: 200 });
        if (!updates.some((update) => update.id === deviation.sourceRef)) {
          throw new ClosedLoopError(
            'learning_update_not_found',
            `CompanyModel learning update '${deviation.sourceRef}' does not exist in this tenant`,
          );
        }
      } catch (error) {
        if (error instanceof LearningError) {
          throw new ClosedLoopError(
            'learning_update_not_found',
            `CompanyModel learning update '${deviation.sourceRef}' does not exist in this tenant`,
          );
        }
        throw error;
      }
    }
  }
}

/**
 * Validates a company-model signal target: a CompanyModel subject key
 * ('company', or '<kind>:<uuid-or-slug>' with the kind checked through
 * the LEARNING contract's own vocabulary guard — never a re-derivation).
 */
function gateCompanyModelTarget(targetRef: string): void {
  if (!isCompanyModelSubjectKey(targetRef)) {
    throw new ClosedLoopError(
      'invalid_signal_input',
      `targetRef '${targetRef}' is not a CompanyModel subject key ('company' or '<kind>:<key>')`,
    );
  }
}

// ---------------------------------------------------------------------------
// recordLoopCycle — append the longitudinal record
// ---------------------------------------------------------------------------

export async function recordLoopCycle(
  ctx: TenantContext,
  input: unknown,
): Promise<LoopCycle> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateRecordLoopCycleInput(input);
  const db = getDb();

  // EVIDENCE GATES on the BASE connection, BEFORE the mutation (W134).
  const goal = await gateSubjectGoal(ctx, valid.goalId);
  await gateRealityDeviations(ctx, valid.realityDeviations);
  await gateKnowledgeDeviations(ctx, valid.knowledgeDeviations);

  const cycleId = newId();
  const recordedAt = now();

  await db.transaction(async (tx) => {
    // Mint the per-(tenant, goal) cycle number inside the transaction.
    const next = await tx.query<{ n: string | number }>(
      `SELECT COALESCE(MAX(cycle_number), 0) + 1 AS n FROM loop_cycles
        WHERE tenant_id = $1 AND goal_id = $2`,
      [ctx.tenantId, valid.goalId],
    );
    const cycleNumber = intRequired((next.rows[0] as { n: string | number }).n);

    await tx.query(
      `INSERT INTO loop_cycles (
         id, tenant_id, goal_id, goal_version, cycle_number, status,
         predicted_score, reality_count, knowledge_count,
         rationale, recorded_by, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, 'open', $6, 0, 0, $7, $8, $9)`,
      [
        cycleId,
        ctx.tenantId,
        valid.goalId,
        goal.version,
        cycleNumber,
        valid.predictedScore,
        valid.rationale,
        ctx.principalId,
        recordedAt,
      ],
    );

    for (const deviation of valid.realityDeviations) {
      await tx.query(
        `INSERT INTO loop_reality_deviations (
           id, tenant_id, cycle_id, source_kind, source_ref, plan_ref,
           expected, observed, magnitude, note, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          newId(),
          ctx.tenantId,
          cycleId,
          deviation.sourceKind,
          deviation.sourceRef,
          deviation.planRef,
          deviation.expected,
          deviation.observed,
          magnitudeOf(deviation.expected, deviation.observed),
          deviation.note,
          recordedAt,
        ],
      );
    }

    for (const deviation of valid.knowledgeDeviations) {
      await tx.query(
        `INSERT INTO loop_knowledge_deviations (
           id, tenant_id, cycle_id, source_kind, source_ref, snapshot_ref,
           severity, note, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newId(),
          ctx.tenantId,
          cycleId,
          deviation.sourceKind,
          deviation.sourceRef,
          deviation.snapshotRef,
          deviation.severity,
          deviation.note,
          recordedAt,
        ],
      );
    }
  });

  return getLoopCycle(ctx, { cycleId });
}

// ---------------------------------------------------------------------------
// applyRankingSignal — the policy-safe learning application
// ---------------------------------------------------------------------------

export async function applyRankingSignal(
  ctx: TenantContext,
  input: unknown,
): Promise<RankingSignal> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateApplyRankingSignalInput(input);
  const db = getDb();

  // GATES on the BASE connection, BEFORE the mutation (W134).
  const cycle = await loadCycleRow(db, ctx, valid.cycleId, false);
  if (cycle.status !== 'open') {
    throw new ClosedLoopError(
      'cycle_not_open',
      `loop cycle '${valid.cycleId}' is closed — signals are derived from a live cycle's evidence`,
    );
  }

  if (valid.targetSeam === 'info_strategy') {
    let strategyGoalId: string;
    try {
      const strategy = await getStrategy(ctx, { strategyId: valid.targetRef });
      strategyGoalId = strategy.goalId;
    } catch (error) {
      if (error instanceof InfoStrategyError) {
        throw new ClosedLoopError(
          'strategy_not_found',
          `info-strategy '${valid.targetRef}' does not exist in this tenant`,
        );
      }
      throw error;
    }
    if (strategyGoalId !== cycle.goal_id) {
      throw new ClosedLoopError(
        'strategy_goal_mismatch',
        `info-strategy '${valid.targetRef}' belongs to goal '${strategyGoalId}', not the cycle's goal '${cycle.goal_id}'`,
      );
    }
  } else if (valid.targetSeam === 'org_lab') {
    try {
      await getCandidate(ctx, { candidateId: valid.targetRef });
    } catch (error) {
      if (error instanceof OrgLabError) {
        throw new ClosedLoopError(
          'candidate_not_found',
          `org-lab candidate '${valid.targetRef}' does not exist in this tenant`,
        );
      }
      throw error;
    }
  } else {
    gateCompanyModelTarget(valid.targetRef);
  }

  const signalId = newId();
  const recordedAt = now();

  await db.transaction(async (tx) => {
    // FOR UPDATE staleness re-check: a racing close owns the terminal
    // state, and signals never attach to closed cycles.
    const row = await loadCycleRow(tx, ctx, valid.cycleId, true);
    if (row.status !== 'open') {
      throw new ClosedLoopError(
        'cycle_not_open',
        `loop cycle '${valid.cycleId}' is closed — signals are derived from a live cycle's evidence`,
      );
    }
    await tx.query(
      `INSERT INTO loop_ranking_signals (
         id, tenant_id, cycle_id, target_seam, target_ref, direction,
         magnitude, basis, rationale, recorded_by, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        signalId,
        ctx.tenantId,
        valid.cycleId,
        valid.targetSeam,
        valid.targetRef,
        valid.direction,
        valid.magnitude,
        valid.basis,
        valid.rationale,
        ctx.principalId,
        recordedAt,
      ],
    );
  });

  return {
    id: signalId,
    tenantId: ctx.tenantId,
    cycleId: valid.cycleId,
    targetSeam: valid.targetSeam,
    targetRef: valid.targetRef,
    direction: valid.direction,
    magnitude: valid.magnitude,
    basis: valid.basis,
    rationale: valid.rationale,
    authoritative: false,
    recordedBy: ctx.principalId,
    recordedAt: isoRequired(recordedAt),
  };
}

// ---------------------------------------------------------------------------
// closeLoopCycle — the one-way terminal transition
// ---------------------------------------------------------------------------

export async function closeLoopCycle(ctx: TenantContext, input: unknown): Promise<LoopCycle> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateCloseLoopCycleInput(input);
  const db = getDb();

  // The metric inputs are computed on the BASE connection (own tables
  // only) BEFORE the transaction opens (the W134 law).
  const cycle = await loadCycleRow(db, ctx, valid.cycleId, false);
  if (cycle.status === 'closed') {
    throw new ClosedLoopError(
      'cycle_already_closed',
      `loop cycle '${valid.cycleId}' is already closed — the lifecycle is one-way, terminal`,
    );
  }

  const realityRows = await listRealityRows(db, ctx, valid.cycleId);
  const knowledgeRows = await listKnowledgeRows(db, ctx, valid.cycleId);

  const previous = await loadPreviousClosedCycle(
    db,
    ctx,
    cycle.goal_id,
    intRequired(cycle.cycle_number),
  );
  const previousRealitySources: string[] | null = previous
    ? (await listRealityRows(db, ctx, previous.id)).map((row) => row.source_ref)
    : null;
  const previousKnowledgeSources: string[] = previous
    ? (await listKnowledgeRows(db, ctx, previous.id)).map((row) => row.source_ref)
    : [];

  const observedScore = observedScoreOf(realityRows.map((row) => numRequired(row.observed)));
  const calibrationError =
    observedScore === null ? null : calibrationErrorOf(numRequired(cycle.predicted_score), observedScore);
  const gapClosureRate = gapClosureRateOf(
    previousKnowledgeSources,
    knowledgeRows.map((row) => row.source_ref),
  );
  const deviationRecurrence = deviationRecurrenceOf(
    previousRealitySources,
    realityRows.map((row) => row.source_ref),
  );

  const closedAt = now();

  await db.transaction(async (tx) => {
    // FOR UPDATE staleness re-check: a racing close owns the terminal
    // state (the one-way transition commits exactly once).
    const row = await loadCycleRow(tx, ctx, valid.cycleId, true);
    if (row.status !== 'open') {
      throw new ClosedLoopError(
        'cycle_already_closed',
        `loop cycle '${valid.cycleId}' is already closed — the lifecycle is one-way, terminal`,
      );
    }
    await tx.query(
      `UPDATE loop_cycles
         SET status = 'closed',
             observed_score = $3,
             calibration_error = $4,
             gap_closure_rate = $5,
             deviation_recurrence = $6,
             reality_count = $7,
             knowledge_count = $8,
             close_note = $9,
             closed_at = $10,
             closed_by = $11
       WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        valid.cycleId,
        observedScore,
        calibrationError,
        gapClosureRate,
        deviationRecurrence,
        realityRows.length,
        knowledgeRows.length,
        valid.note,
        closedAt,
        ctx.principalId,
      ],
    );
  });

  return getLoopCycle(ctx, { cycleId: valid.cycleId });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLoopCycle(ctx: TenantContext, query: unknown): Promise<LoopCycle> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateGetLoopCycleQuery(query);
  const db = getDb();

  const row = await loadCycleRow(db, ctx, valid.cycleId, false);
  const [realityRows, knowledgeRows, signalRows] = await Promise.all([
    listRealityRows(db, ctx, valid.cycleId),
    listKnowledgeRows(db, ctx, valid.cycleId),
    listSignalRows(db, ctx, valid.cycleId),
  ]);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    goalVersion: intRequired(row.goal_version),
    cycleNumber: intRequired(row.cycle_number),
    status: row.status as LoopCycle['status'],
    predictedScore: numRequired(row.predicted_score),
    metrics: metricsOf(row),
    realityDeviations: realityRows.map(mapReality),
    knowledgeDeviations: knowledgeRows.map(mapKnowledge),
    signals: signalRows.map(mapSignal),
    rationale: row.rationale,
    recordedBy: row.recorded_by,
    recordedAt: isoRequired(row.recorded_at),
    closedAt: row.closed_at ? isoRequired(row.closed_at) : null,
    closedBy: row.closed_by,
    closeNote: row.close_note,
  };
}

export async function listLoopCycles(
  ctx: TenantContext,
  query?: ListLoopCyclesQuery,
): Promise<LoopCycleSummary[]> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateListLoopCyclesQuery(query);

  const conditions = ['c.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.goalId !== null) {
    params.push(valid.goalId);
    conditions.push(`c.goal_id = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`c.status = $${params.length}`);
  }
  params.push(valid.limit);

  const result = await getDb().query<CycleRow & { signal_count: string | number }>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM loop_ranking_signals s
              WHERE s.tenant_id = c.tenant_id AND s.cycle_id = c.id) AS signal_count
       FROM loop_cycles c
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.recorded_at DESC, c.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    cycleNumber: intRequired(row.cycle_number),
    status: row.status as LoopCycle['status'],
    predictedScore: numRequired(row.predicted_score),
    calibrationError: num(row.calibration_error),
    realityCount: intRequired(row.reality_count),
    knowledgeCount: intRequired(row.knowledge_count),
    signalCount: intRequired(row.signal_count),
    recordedAt: isoRequired(row.recorded_at),
    closedAt: row.closed_at ? isoRequired(row.closed_at) : null,
  }));
}

export async function listRankingSignals(
  ctx: TenantContext,
  query?: ListRankingSignalsQuery,
): Promise<RankingSignal[]> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateListRankingSignalsQuery(query);

  const conditions = ['s.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.cycleId !== null) {
    params.push(valid.cycleId);
    conditions.push(`s.cycle_id = $${params.length}`);
  }
  if (valid.goalId !== null) {
    params.push(valid.goalId);
    conditions.push(`s.cycle_id IN (SELECT id FROM loop_cycles WHERE tenant_id = $1 AND goal_id = $${params.length})`);
  }
  if (valid.targetSeam !== null) {
    params.push(valid.targetSeam);
    conditions.push(`s.target_seam = $${params.length}`);
  }
  if (valid.basis !== null) {
    params.push(valid.basis);
    conditions.push(`s.basis = $${params.length}`);
  }
  params.push(valid.limit);

  const result = await getDb().query<SignalRow>(
    `SELECT s.* FROM loop_ranking_signals s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.recorded_at DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapSignal);
}

export async function getLoopTrajectory(ctx: TenantContext, query: unknown): Promise<LoopTrajectory> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateGetLoopTrajectoryQuery(query);
  const db = getDb();

  const cycles = await db.query<CycleRow & { signal_count: string | number }>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM loop_ranking_signals s
              WHERE s.tenant_id = c.tenant_id AND s.cycle_id = c.id) AS signal_count
       FROM loop_cycles c
      WHERE c.tenant_id = $1 AND c.goal_id = $2 AND c.status = 'closed'
      ORDER BY c.cycle_number ASC`,
    [ctx.tenantId, valid.goalId],
  );

  const points: LoopTrajectoryPoint[] = cycles.rows.map((row) => ({
    cycleNumber: intRequired(row.cycle_number),
    predictedScore: numRequired(row.predicted_score),
    observedScore: num(row.observed_score),
    calibrationError: num(row.calibration_error),
    gapClosureRate: num(row.gap_closure_rate),
    deviationRecurrence: num(row.deviation_recurrence),
    signalCount: intRequired(row.signal_count),
    closedAt: isoRequired(row.closed_at as Date | string),
  }));

  return {
    tenantId: ctx.tenantId,
    goalId: valid.goalId,
    points,
    generatedAt: isoRequired(now()),
  };
}

export async function summarizeLoopImprovement(
  ctx: TenantContext,
  query: unknown,
): Promise<LoopImprovementSummary> {
  assertClosedLoopTenantContext(ctx);
  const valid = validateSummarizeLoopImprovementQuery(query);
  const db = getDb();

  const trajectory = await getLoopTrajectory(ctx, { goalId: valid.goalId });

  const signals = await db.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM loop_ranking_signals s
      WHERE s.tenant_id = $1
        AND s.cycle_id IN (SELECT id FROM loop_cycles WHERE tenant_id = $1 AND goal_id = $2)`,
    [ctx.tenantId, valid.goalId],
  );

  const errors = trajectory.points.map((point) => point.calibrationError);
  const verdict: ImprovementVerdict = improvementVerdictOf(errors);

  const first = trajectory.points[0] ?? null;
  const last = trajectory.points[trajectory.points.length - 1] ?? null;
  const firstError = first ? first.calibrationError : null;
  const lastError = last ? last.calibrationError : null;
  const closureValues = trajectory.points
    .map((point) => point.gapClosureRate)
    .filter((one): one is number => one !== null);

  return {
    tenantId: ctx.tenantId,
    goalId: valid.goalId,
    closedCycleCount: trajectory.points.length,
    firstCalibrationError: firstError,
    lastCalibrationError: lastError,
    calibrationDelta:
      firstError !== null && lastError !== null
        ? Math.round((firstError - lastError) * 10 ** 4) / 10 ** 4
        : null,
    gapClosureMean:
      closureValues.length > 0
        ? Math.round((closureValues.reduce((acc, one) => acc + one, 0) / closureValues.length) * 10 ** 4) / 10 ** 4
        : null,
    recurrenceFirst: first ? first.deviationRecurrence : null,
    recurrenceLast: last ? last.deviationRecurrence : null,
    signalCount: intRequired((signals.rows[0] as { count: string | number }).count),
    verdict,
    generatedAt: isoRequired(now()),
  };
}
