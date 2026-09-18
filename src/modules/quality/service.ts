// Implementation of the quality module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`judgment_not_found` / `snapshot_not_found`), on reads
// AND on writes.
//
// W055 acceptance is carried by these deliberate properties, all tested:
//   1. METRICS, NOT TRUTH: the module computes the nine quality metric
//      families from records OTHER modules own (attention discovery
//      candidates, missions, acquisition plans, observations, learning
//      outcomes) — read through their contracts only — and persists the
//      results as append-only snapshots. Nothing here mutates another
//      module's state, and no operation feeds a metric back into ranking,
//      priors or policy (ADR-0019: the learning update path is the ONLY
//      channel from outcomes to future behavior — quality measurement
//      stays outside it).
//   2. GROUND TRUTH IS RECORDED, NEVER INFERRED: precision/recall and
//      source-selection quality need labels; evaluators record them as
//      provenance-bearing judgments through this contract. Corrections are
//      new rows; computation resolves the latest per target
//      deterministically (metrics.ts), so the audit trail is never
//      rewritten.
//   3. VERSIONED AND AUDITABLE: every snapshot freezes the window, the
//      requested families, METRIC_SCHEMA_VERSION and the full input audit
//      (considered counts + truncated-source flags) alongside the computed
//      payloads — each number is reconstructable from the recorded inputs
//      plus the versioned pure functions in metrics.ts. PostgreSQL itself
//      rejects UPDATE/DELETE/TRUNCATE on all three tables via migration
//      001 triggers.
//   4. BOUNDED AND HONEST: each source is fetched through its contract
//      under a fixed cap; a fetch that returns exactly its cap is named in
//      the snapshot's `truncated` list, so consumers always know when a
//      number was computed over a bounded prefix.

import { getDb, type DbRow } from '@/infra/db';
import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { AttentionError, getDiscoveryCandidate, getDiscoveryRun, listDiscoveryRuns } from '@/modules/attention/contract';
import { CognitionError, getExecution } from '@/modules/cognition/contract';
import { KnowledgeAcquisitionError, getAcquisitionPlan, listAcquisitionPlans } from '@/modules/knowledge-acquisition/contract';
import { listOutcomes } from '@/modules/learning/contract';
import { listMissions } from '@/modules/missions/contract';
import { listObservations } from '@/modules/observations/contract';
import { QualityError } from './errors';
import {
  JUDGMENTS_FETCH_LIMIT,
  SOURCE_FETCH_LIMIT,
  assertQualityTenantContext,
  validateComputeSnapshotInput,
  validateGetJudgmentQuery,
  validateGetSnapshotQuery,
  validateListJudgmentsQuery,
  validateListSnapshotsQuery,
  validateRecordJudgmentInput,
  type ValidatedJudgmentInput,
  type ValidatedListJudgmentsQuery,
  type ValidatedListSnapshotsQuery,
  type ValidatedSnapshotInput,
} from './validation';
import {
  METRIC_SCHEMA_VERSION,
  computeMetric,
  type CandidateFact,
  type JudgmentFact,
  type ObservationFact,
  type PlanFact,
  type ResolvedMissionFact,
  type SettledOutcomeFact,
} from './metrics';
import type {
  ComputeQualitySnapshotInput,
  GetJudgmentQuery,
  GetQualitySnapshotQuery,
  ListJudgmentsQuery,
  ListQualitySnapshotsQuery,
  QualityJudgment,
  QualityMetricKind,
  QualityMetricResult,
  QualityParty,
  QualitySnapshot,
  QualitySnapshotInputs,
  QualitySnapshotSummary,
  RecordJudgmentInput,
  TruncatedSource,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes and mappers
// ---------------------------------------------------------------------------

interface JudgmentRow extends DbRow {
  id: string;
  tenant_id: string;
  judgment_kind: string;
  gap_key: string | null;
  candidate_id: string | null;
  plan_id: string | null;
  window_from: Date | string | null;
  window_to: Date | string | null;
  verdict: string;
  evaluator_kind: string;
  evaluator_id: string | null;
  evaluator_label: string | null;
  note: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

interface SnapshotRow extends DbRow {
  id: string;
  tenant_id: string;
  window_from: Date | string;
  window_to: Date | string;
  metric_kinds: unknown;
  metric_version: number;
  inputs: unknown;
  origin_execution_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  computed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface ResultRow extends DbRow {
  id: string;
  tenant_id: string;
  snapshot_id: string;
  metric_kind: string;
  payload: unknown;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toMs(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function mapParty(
  row: { kind: string; id: string | null; label: string | null },
): QualityParty {
  return {
    kind: row.kind as QualityParty['kind'], // CHECK-constrained by migration 001
    id: row.id,
    label: row.label,
  };
}

function mapJudgment(row: JudgmentRow): QualityJudgment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.judgment_kind as QualityJudgment['kind'], // CHECK-constrained
    gapKey: row.gap_key,
    candidateId: row.candidate_id,
    planId: row.plan_id,
    windowFrom: row.window_from === null ? null : toIso(row.window_from),
    windowTo: row.window_to === null ? null : toIso(row.window_to),
    verdict: row.verdict,
    evaluator: mapParty({ kind: row.evaluator_kind, id: row.evaluator_id, label: row.evaluator_label }),
    note: row.note,
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

function judgmentFact(row: JudgmentRow): JudgmentFact {
  return {
    id: row.id,
    kind: row.judgment_kind as JudgmentFact['kind'], // CHECK-constrained
    gapKey: row.gap_key,
    candidateId: row.candidate_id,
    planId: row.plan_id,
    windowFromMs: toMs(row.window_from),
    windowToMs: toMs(row.window_to),
    verdict: row.verdict,
    recordedAtMs: row.recorded_at instanceof Date ? row.recorded_at.getTime() : new Date(row.recorded_at).getTime(),
  };
}

function mapMetricKinds(value: unknown): QualityMetricKind[] {
  return Array.isArray(value) ? (value as QualityMetricKind[]) : [];
}

function mapInputs(value: unknown): QualitySnapshotInputs {
  const empty: QualitySnapshotInputs = {
    discoveryRunsConsidered: 0,
    discoveryCandidatesConsidered: 0,
    acquisitionPlansConsidered: 0,
    missionsConsidered: 0,
    outcomesConsidered: 0,
    observationsConsidered: 0,
    judgmentsConsidered: 0,
    truncated: [],
  };
  if (typeof value !== 'object' || value === null) return empty;
  const record = value as Partial<QualitySnapshotInputs>;
  return {
    discoveryRunsConsidered: record.discoveryRunsConsidered ?? 0,
    discoveryCandidatesConsidered: record.discoveryCandidatesConsidered ?? 0,
    acquisitionPlansConsidered: record.acquisitionPlansConsidered ?? 0,
    missionsConsidered: record.missionsConsidered ?? 0,
    outcomesConsidered: record.outcomesConsidered ?? 0,
    observationsConsidered: record.observationsConsidered ?? 0,
    judgmentsConsidered: record.judgmentsConsidered ?? 0,
    truncated: Array.isArray(record.truncated) ? record.truncated : [],
  };
}

function mapSnapshotSummary(row: SnapshotRow): QualitySnapshotSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    windowFrom: toIso(row.window_from),
    windowTo: toIso(row.window_to),
    metricKinds: mapMetricKinds(row.metric_kinds),
    metricVersion: row.metric_version,
    inputs: mapInputs(row.inputs),
    originExecutionId: row.origin_execution_id,
    actor: mapParty({ kind: row.actor_kind, id: row.actor_id, label: row.actor_label }),
    computedByPrincipal: row.computed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function judgmentNotFound(judgmentId: string): QualityError {
  return new QualityError('judgment_not_found', `judgment '${judgmentId}' does not exist in this tenant`);
}

function snapshotNotFound(snapshotId: string): QualityError {
  return new QualityError('snapshot_not_found', `snapshot '${snapshotId}' does not exist in this tenant`);
}

// ---------------------------------------------------------------------------
// Cross-module reference validation (uniform not-found semantics)
// ---------------------------------------------------------------------------

/**
 * The attention discovery candidate a judgment targets must exist and be
 * readable in this tenant, verified through the attention contract.
 * Missing, malformed and foreign-tenant candidate ids are uniformly
 * `invalid_candidate_ref` (no existence leak).
 */
async function validateCandidateRef(ctx: TenantContext, candidateId: string): Promise<void> {
  try {
    await getDiscoveryCandidate(ctx, { candidateId });
  } catch (error) {
    if (error instanceof AttentionError) {
      throw new QualityError(
        'invalid_candidate_ref',
        `discovery candidate '${candidateId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * The acquisition plan a judgment targets must exist and be readable in
 * this tenant, verified through the knowledge-acquisition contract.
 */
async function validatePlanRef(ctx: TenantContext, planId: string): Promise<void> {
  try {
    await getAcquisitionPlan(ctx, planId);
  } catch (error) {
    if (error instanceof KnowledgeAcquisitionError) {
      throw new QualityError(
        'invalid_plan_ref',
        `acquisition plan '${planId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * The originating cognitive execution of a snapshot must exist and be
 * readable in this tenant, verified through the cognition contract (the
 * sanctioned W013 dependency; the learning/attention precedent).
 */
async function validateOriginExecutionRef(ctx: TenantContext, executionId: string): Promise<void> {
  try {
    await getExecution(ctx, { executionId });
  } catch (error) {
    if (error instanceof CognitionError) {
      throw new QualityError(
        'invalid_origin_ref',
        `originating execution '${executionId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// recordJudgment
// ---------------------------------------------------------------------------

export async function recordJudgment(
  ctx: TenantContext,
  input: RecordJudgmentInput,
): Promise<QualityJudgment> {
  assertQualityTenantContext(ctx);
  const valid: ValidatedJudgmentInput = validateRecordJudgmentInput(input);

  if (valid.kind === 'unknown-consequentiality' && valid.candidateId !== null) {
    await validateCandidateRef(ctx, valid.candidateId);
  }
  if (valid.kind === 'source-selection') {
    await validatePlanRef(ctx, valid.planId);
  }

  const recordedAt = now();
  const inserted = await getDb().query<JudgmentRow>(
    `INSERT INTO quality_judgments (
       tenant_id, judgment_kind, gap_key, candidate_id, plan_id,
       window_from, window_to, verdict,
       evaluator_kind, evaluator_id, evaluator_label, note,
       recorded_by_principal, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::timestamptz, $7::timestamptz, $8,
       $9, $10, $11, $12,
       $13, $14::timestamptz
     ) RETURNING *`,
    valid.kind === 'unknown-consequentiality'
      ? [
          ctx.tenantId,
          valid.kind,
          valid.gapKey,
          valid.candidateId,
          null,
          valid.windowFromMs === null ? null : new Date(valid.windowFromMs).toISOString(),
          valid.windowToMs === null ? null : new Date(valid.windowToMs).toISOString(),
          valid.verdict,
          valid.evaluator.kind,
          valid.evaluator.id,
          valid.evaluator.label,
          valid.note,
          ctx.principalId,
          recordedAt,
        ]
      : [
          ctx.tenantId,
          valid.kind,
          null,
          null,
          valid.planId,
          null,
          null,
          valid.verdict,
          valid.evaluator.kind,
          valid.evaluator.id,
          valid.evaluator.label,
          valid.note,
          ctx.principalId,
          recordedAt,
        ],
  );
  return mapJudgment(inserted.rows[0]!);
}

// ---------------------------------------------------------------------------
// Judgment reads
// ---------------------------------------------------------------------------

export async function getJudgment(
  ctx: TenantContext,
  query: GetJudgmentQuery,
): Promise<QualityJudgment> {
  assertQualityTenantContext(ctx);
  const valid = validateGetJudgmentQuery(query);
  const rows = await getDb().query<JudgmentRow>(
    `SELECT * FROM quality_judgments WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.judgmentId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw judgmentNotFound(valid.judgmentId);
  return mapJudgment(row);
}

export async function listJudgments(
  ctx: TenantContext,
  query: ListJudgmentsQuery = {},
): Promise<QualityJudgment[]> {
  assertQualityTenantContext(ctx);
  const valid: ValidatedListJudgmentsQuery = validateListJudgmentsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.kind !== null) add('judgment_kind = $#', valid.kind);
  if (valid.gapKey !== null) add('gap_key = $#', valid.gapKey);
  if (valid.planId !== null) add('plan_id = $#', valid.planId);

  const rows = await getDb().query<JudgmentRow>(
    `SELECT * FROM quality_judgments WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapJudgment);
}

// ---------------------------------------------------------------------------
// computeQualitySnapshot
// ---------------------------------------------------------------------------

/**
 * The bounded contract fetches one computation performs, derived from the
 * requested metric families. Each fetcher returns its facts plus the
 * counters it contributes to the input audit; a fetch that returns exactly
 * its cap names itself as truncated (honest bounds).
 */
interface FetchedFacts {
  candidates: CandidateFact[];
  plans: PlanFact[];
  missions: ResolvedMissionFact[];
  observations: ObservationFact[];
  outcomes: SettledOutcomeFact[];
  settledAtMs: (outcomeId: string) => number | null;
  judgments: JudgmentFact[];
  inputs: QualitySnapshotInputs;
}

const NEEDS: Record<QualityMetricKind, { attention: boolean; plans: boolean; missions: boolean; outcomes: boolean; observations: boolean; judgments: boolean }> = {
  'unknown-discovery': { attention: true, plans: false, missions: false, outcomes: false, observations: false, judgments: true },
  'source-selection': { attention: false, plans: true, missions: false, outcomes: false, observations: false, judgments: true },
  'mission-resolution-efficiency': { attention: false, plans: true, missions: true, outcomes: false, observations: false, judgments: false },
  'evidence-quality': { attention: false, plans: false, missions: false, outcomes: false, observations: true, judgments: false },
  'recommendation-calibration': { attention: false, plans: false, missions: false, outcomes: true, observations: false, judgments: false },
  'intervention-success': { attention: false, plans: false, missions: false, outcomes: true, observations: false, judgments: false },
  'realized-value': { attention: false, plans: false, missions: false, outcomes: true, observations: false, judgments: false },
  'investigation-cost': { attention: false, plans: true, missions: true, outcomes: false, observations: false, judgments: false },
  'time-to-useful-understanding': { attention: false, plans: true, missions: true, outcomes: false, observations: false, judgments: false },
};

async function fetchFacts(
  ctx: TenantContext,
  valid: ValidatedSnapshotInput,
): Promise<FetchedFacts> {
  const needs = {
    attention: valid.metricKinds.some((kind) => NEEDS[kind].attention),
    plans: valid.metricKinds.some((kind) => NEEDS[kind].plans),
    missions: valid.metricKinds.some((kind) => NEEDS[kind].missions),
    outcomes: valid.metricKinds.some((kind) => NEEDS[kind].outcomes),
    observations: valid.metricKinds.some((kind) => NEEDS[kind].observations),
    judgments: valid.metricKinds.some((kind) => NEEDS[kind].judgments),
  };
  const truncated: TruncatedSource[] = [];
  const inputs: QualitySnapshotInputs = {
    discoveryRunsConsidered: 0,
    discoveryCandidatesConsidered: 0,
    acquisitionPlansConsidered: 0,
    missionsConsidered: 0,
    outcomesConsidered: 0,
    observationsConsidered: 0,
    judgmentsConsidered: 0,
    truncated,
  };

  // Attention: promoted discovery candidates (runs first, then the full
  // run records — candidates are embedded there).
  const candidates: CandidateFact[] = [];
  if (needs.attention) {
    const runs = await listDiscoveryRuns(ctx, {
      disposition: 'promoted',
      limit: SOURCE_FETCH_LIMIT,
    });
    inputs.discoveryRunsConsidered = runs.length;
    if (runs.length === SOURCE_FETCH_LIMIT) truncated.push('discovery-runs');
    for (const summary of runs) {
      const run = await getDiscoveryRun(ctx, { runId: summary.id });
      for (const candidate of run.candidates) {
        if (candidate.disposition !== 'promoted') continue;
        inputs.discoveryCandidatesConsidered += 1;
        candidates.push({
          candidateId: candidate.id,
          gapKey: candidate.gapKey,
          recordedAtMs: Date.parse(candidate.recordedAt),
        });
      }
    }
  }

  // Knowledge acquisition: selected plans with their terminal outcomes.
  const plans: PlanFact[] = [];
  if (needs.plans) {
    const fetched = await listAcquisitionPlans(ctx, {
      decision: 'selected',
      limit: SOURCE_FETCH_LIMIT,
    });
    inputs.acquisitionPlansConsidered = fetched.length;
    if (fetched.length === SOURCE_FETCH_LIMIT) truncated.push('acquisition-plans');
    for (const plan of fetched) {
      if (plan.decision !== 'selected') continue; // defense in depth
      plans.push({
        planId: plan.id,
        missionId: plan.missionId,
        action: plan.action ?? '',
        recordedAtMs: Date.parse(plan.recordedAt),
        estimatedCost: plan.estimatedCost,
        budgetCurrency: plan.budgetCurrency,
        outcomeKind: plan.outcome === null ? null : plan.outcome.outcome,
        outcomeRecordedAtMs: plan.outcome === null ? null : Date.parse(plan.outcome.recordedAt),
      });
    }
  }

  // Missions: completed missions (creation → completion timings).
  const missions: ResolvedMissionFact[] = [];
  if (needs.missions) {
    const fetched = await listMissions(ctx, { status: 'completed', limit: SOURCE_FETCH_LIMIT });
    inputs.missionsConsidered = fetched.length;
    if (fetched.length === SOURCE_FETCH_LIMIT) truncated.push('missions');
    for (const mission of fetched) {
      if (mission.content.status !== 'completed') continue; // defense in depth
      missions.push({
        missionId: mission.id,
        createdAtMs: Date.parse(mission.createdAt),
        completedAtMs: Date.parse(mission.updatedAt),
        budgetCurrency: mission.content.investigationBudget.currency,
      });
    }
  }

  // Learning: settled outcomes with their frozen realizations.
  const outcomes: SettledOutcomeFact[] = [];
  const settledAt = new Map<string, number>();
  if (needs.outcomes) {
    const fetched = await listOutcomes(ctx, { status: 'settled', limit: SOURCE_FETCH_LIMIT });
    inputs.outcomesConsidered = fetched.length;
    if (fetched.length === SOURCE_FETCH_LIMIT) truncated.push('outcomes');
    for (const outcome of fetched) {
      if (outcome.realization === null) continue; // defense in depth
      settledAt.set(outcome.id, Date.parse(outcome.realization.settledAt));
      outcomes.push({
        outcomeId: outcome.id,
        subjectKind: outcome.subject.kind,
        direction: outcome.direction,
        baseline: outcome.baseline,
        expected: outcome.expected,
        realized: outcome.realization.realizedValue,
        assessment: outcome.realization.assessment,
      });
    }
  }

  // Observations: evidence observed within the window, as readable to the
  // computing principal (the observations module's own visibility rule).
  const observations: ObservationFact[] = [];
  if (needs.observations) {
    const fetched = await listObservations(ctx, {
      observedFrom: new Date(valid.windowFromMs).toISOString(),
      observedTo: new Date(valid.windowToMs).toISOString(),
      limit: SOURCE_FETCH_LIMIT,
    });
    inputs.observationsConsidered = fetched.length;
    if (fetched.length === SOURCE_FETCH_LIMIT) truncated.push('observations');
    for (const observation of fetched) {
      observations.push({
        confidenceValue: observation.confidence.value,
        confidenceBasis: observation.confidence.basis,
        lineageParentCount: observation.lineage.parents.length,
      });
    }
  }

  // Quality-owned judgments: the tenant's ground truth, newest first.
  const judgments: JudgmentFact[] = [];
  if (needs.judgments) {
    const rows = await getDb().query<JudgmentRow>(
      `SELECT * FROM quality_judgments WHERE tenant_id = $1
         ORDER BY recorded_at DESC, id DESC LIMIT ${JUDGMENTS_FETCH_LIMIT}`,
      [ctx.tenantId],
    );
    inputs.judgmentsConsidered = rows.rows.length;
    if (rows.rows.length === JUDGMENTS_FETCH_LIMIT) truncated.push('judgments');
    for (const row of rows.rows) judgments.push(judgmentFact(row));
  }

  return {
    candidates,
    plans,
    missions,
    observations,
    outcomes,
    settledAtMs: (outcomeId) => settledAt.get(outcomeId) ?? null,
    judgments,
    inputs,
  };
}

export async function computeQualitySnapshot(
  ctx: TenantContext,
  input: ComputeQualitySnapshotInput,
): Promise<QualitySnapshot> {
  assertQualityTenantContext(ctx);
  const valid: ValidatedSnapshotInput = validateComputeSnapshotInput(input);
  if (valid.originExecutionId !== null) {
    await validateOriginExecutionRef(ctx, valid.originExecutionId);
  }

  const facts = await fetchFacts(ctx, valid);
  const window = { fromMs: valid.windowFromMs, toMs: valid.windowToMs };

  // Compute every requested family through the versioned pure functions.
  const results: { metricKind: QualityMetricKind; payload: Record<string, unknown> }[] = [];
  for (const metricKind of valid.metricKinds) {
    const payload = computeMetric(metricKind, {
      window,
      candidates: facts.candidates,
      judgments: facts.judgments,
      plans: facts.plans,
      missions: facts.missions,
      observations: facts.observations,
      outcomes: facts.outcomes,
      settledAtMs: facts.settledAtMs,
    });
    const { metricKind: kind, ...rest } = payload;
    results.push({ metricKind: kind, payload: rest as Record<string, unknown> });
  }

  const recordedAt = now();
  const windowFromIso = new Date(valid.windowFromMs).toISOString();
  const windowToIso = new Date(valid.windowToMs).toISOString();

  const snapshotId = await getDb().transaction(async (tx) => {
    const inserted = await tx.query<SnapshotRow>(
      `INSERT INTO quality_snapshots (
         tenant_id, window_from, window_to, metric_kinds, metric_version, inputs,
         origin_execution_id, actor_kind, actor_id, actor_label,
         computed_by_principal, rationale, recorded_at
       ) VALUES (
         $1, $2::timestamptz, $3::timestamptz, $4::jsonb, $5, $6::jsonb,
         $7, $8, $9, $10,
         $11, $12, $13::timestamptz
       ) RETURNING *`,
      [
        ctx.tenantId,
        windowFromIso,
        windowToIso,
        JSON.stringify(valid.metricKinds),
        METRIC_SCHEMA_VERSION,
        JSON.stringify(facts.inputs),
        valid.originExecutionId,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        valid.rationale,
        recordedAt,
      ],
    );
    const snapshotRow = inserted.rows[0]!;
    for (const result of results) {
      await tx.query<ResultRow>(
        `INSERT INTO quality_metric_results (
           tenant_id, snapshot_id, metric_kind, payload, recorded_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [ctx.tenantId, snapshotRow.id, result.metricKind, JSON.stringify(result.payload), recordedAt],
      );
    }
    return snapshotRow.id;
  });

  return getQualitySnapshot(ctx, { snapshotId });
}

// ---------------------------------------------------------------------------
// Snapshot reads
// ---------------------------------------------------------------------------

export async function getQualitySnapshot(
  ctx: TenantContext,
  query: GetQualitySnapshotQuery,
): Promise<QualitySnapshot> {
  assertQualityTenantContext(ctx);
  const valid = validateGetSnapshotQuery(query);
  const rows = await getDb().query<SnapshotRow>(
    `SELECT * FROM quality_snapshots WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.snapshotId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw snapshotNotFound(valid.snapshotId);

  const resultRows = await getDb().query<ResultRow>(
    `SELECT * FROM quality_metric_results WHERE tenant_id = $1 AND snapshot_id = $2`,
    [ctx.tenantId, valid.snapshotId],
  );
  // Canonical order — deterministic regardless of row return order.
  const order = new Map(mapMetricKinds(row.metric_kinds).map((kind, index) => [kind, index]));
  const results: QualityMetricResult[] = resultRows.rows
    .map((resultRow) => ({
      metricKind: resultRow.metric_kind as QualityMetricKind, // CHECK-constrained
      payload: (resultRow.payload ?? {}) as Record<string, unknown>,
    }))
    .sort(
      (a, b) => (order.get(a.metricKind) ?? 99) - (order.get(b.metricKind) ?? 99),
    );

  return { ...mapSnapshotSummary(row), results };
}

export async function listQualitySnapshots(
  ctx: TenantContext,
  query: ListQualitySnapshotsQuery = {},
): Promise<QualitySnapshotSummary[]> {
  assertQualityTenantContext(ctx);
  const valid: ValidatedListSnapshotsQuery = validateListSnapshotsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.metricKind !== null) {
    params.push(JSON.stringify([valid.metricKind]));
    conditions.push(`metric_kinds @> $${params.length}::jsonb`);
  }

  const rows = await getDb().query<SnapshotRow>(
    `SELECT * FROM quality_snapshots WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT ${valid.limit}`,
    params,
  );
  return rows.rows.map(mapSnapshotSummary);
}
