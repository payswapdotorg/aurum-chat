// Implementation of the outcomes module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`intervention_not_found`), on reads AND on writes.
//
// W054 acceptance is carried by these deliberate properties, all tested:
//   1. THE CHAIN: every intervention is tied to exactly ONE measuring
//      learning-module outcome (validated readable AND open through the
//      learning contract at record time — the sanctioned W040 → W054
//      dependency; the UNIQUE (tenant_id, outcome_id) makes the 1:1 tie
//      unrepresentable any other way) and snapshots the outcome's immutable
//      definition (metric, direction, baseline, EXPECTED) at record time —
//      baseline/expected are committed BEFORE realization, exactly the
//      prediction hygiene that keeps expected-versus-realized honest. The
//      observed leg is composed live through the learning contract (never
//      its tables); the realized leg is CONSUMED from the learning module's
//      frozen outcome realization, never re-derived.
//   2. REALIZED VALUE AND VARIANCE RECORDED: realizeIntervention freezes
//      realized value, variance-vs-expected, improvement-vs-baseline, the
//      deterministic assessment and the evidence polarity onto the
//      terminal realization row; PostgreSQL rejects UPDATE/DELETE/TRUNCATE
//      on all three tables via migration 001 triggers.
//   3. NEGATIVE EVIDENCE RETAINED: failed interventions (assessment
//      'missed', polarity 'negative') are kept forever — there is no
//      delete, no exclusion, and abandonment is impossible once the
//      measuring outcome settled (evidence cannot be suppressed after the
//      fact).
//   4. LEARNED PRIORS: realizeIntervention appends ONE versioned
//      intervention_priors row per realization — the explicit,
//      evidence-linked learning update, computed by the pure
//      computePriorUpdate over every realized intervention of the
//      (kind, capability key). Later similar recommendations read the
//      RECORDED prior (getInterventionPriors); the prior table has exactly
//      one writer (this path) and one recommendation-facing reader.
//   5. NO HIDDEN OUTCOME LABELS LEAK: the recommendation-facing surface
//      returns ONLY prior aggregates + evidence REFERENCES. Settling an
//      outcome moves NOTHING on that surface; only the explicit learning
//      update does (ADR-0019: "The learning update path is the ONLY
//      channel from outcomes to future behavior").
//
// Storage shape: `interventions` (immutable definition), `intervention_
// realizations` (first-write-wins terminal records) and `intervention_
// priors` (append-only versioned learning updates). Reads derive the
// current view by LEFT JOINing the realization; the observed-outcome
// summary is composed through the learning contract per intervention.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getOutcome, LearningError } from '@/modules/learning/contract';
import type { Outcome as MeasuringOutcome } from '@/modules/learning/contract';
import { OutcomesError } from './errors';
import {
  assertOutcomesTenantContext,
  computePriorUpdate,
  escapeLike,
  isUuid,
  validateAbandonInterventionInput,
  validateGetInterventionPriorsQuery,
  validateListInterventionPriorVersionsQuery,
  validateListInterventionsQuery,
  validateRealizeInterventionInput,
  validateRecordInterventionInput,
  type PriorSampleEntry,
} from './validation';
import type {
  AbandonInterventionInput,
  EvidencePolarity,
  Intervention,
  InterventionActor,
  InterventionAssessment,
  InterventionAuthorizationRef,
  InterventionGoalRef,
  InterventionKind,
  InterventionOutcomeSummary,
  InterventionPrior,
  InterventionRealization,
  InterventionStatus,
  InterventionTarget,
  ListInterventionsQuery,
  GetInterventionPriorsQuery,
  ListInterventionPriorVersionsQuery,
  RealizeInterventionInput,
  RecordInterventionInput,
} from './types';

/** Row shape of `interventions` (the immutable definition). */
interface InterventionRow extends DbRow {
  id: string;
  tenant_id: string;
  intervention_kind: string;
  capability_key: string;
  capability_label: string;
  target: unknown;
  origin_goal_ids: unknown;
  origin_recommendation_id: string | null;
  authorization_ref: unknown;
  origin_execution_id: string | null;
  outcome_id: string;
  metric_name: string;
  metric_unit: string;
  direction: string;
  baseline: number;
  expected: number;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of `intervention_realizations` (the terminal records). */
interface RealizationRow extends DbRow {
  id: string;
  tenant_id: string;
  intervention_id: string;
  disposition: string;
  realized_value: number | null;
  variance_vs_expected: number | null;
  improvement_vs_baseline: number | null;
  assessment: string | null;
  polarity: string | null;
  realized_from_measurement_id: string | null;
  outcome_settled_at: Date | string | null;
  note: string | null;
  reason: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  realized_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of the derived current-view join (definition ⊕ realization). */
interface ViewRow extends InterventionRow {
  realization_disposition: string | null;
  view_realized_value: number | null;
  view_variance_vs_expected: number | null;
  view_improvement_vs_baseline: number | null;
  view_assessment: string | null;
  view_polarity: string | null;
  view_from_measurement_id: string | null;
  view_outcome_settled_at: Date | string | null;
  realization_note: string | null;
  abandonment_reason: string | null;
  realization_actor_kind: string | null;
  realization_actor_id: string | null;
  realization_actor_label: string | null;
  realized_by_principal: string | null;
  realized_at: Date | string | null;
}

/** Row shape of `intervention_priors` (the versioned learning updates). */
interface PriorRow extends DbRow {
  id: string;
  tenant_id: string;
  intervention_kind: string;
  capability_key: string;
  prior_version: number | string;
  sample_size: number | string;
  successes: number | string;
  failures: number | string;
  success_rate: number;
  expected_sum: number;
  realized_sum: number;
  net_variance: number;
  mean_variance: number;
  triggered_by_intervention_id: string;
  evidence_intervention_ids: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  updated_by_principal: string;
  recorded_at: Date | string;
}

/** One realized intervention's contribution, as the prior sample scan reads it. */
interface SampleRow extends DbRow {
  intervention_id: string;
  assessment: string;
  expected: number;
  realized_value: number;
  variance_vs_expected: number;
}

// The derived current view, shared by getIntervention and listInterventions.
const CURRENT_VIEW_FROM = `FROM interventions i
  LEFT JOIN intervention_realizations r
    ON r.intervention_id = i.id AND r.tenant_id = i.tenant_id`;

const CURRENT_VIEW_COLUMNS = `SELECT
    i.id, i.tenant_id, i.intervention_kind, i.capability_key,
    i.capability_label, i.target, i.origin_goal_ids, i.origin_recommendation_id,
    i.authorization_ref, i.origin_execution_id, i.outcome_id,
    i.metric_name, i.metric_unit, i.direction, i.baseline, i.expected,
    i.actor_kind, i.actor_id, i.actor_label, i.recorded_by_principal,
    i.rationale, i.recorded_at,
    r.disposition AS realization_disposition,
    r.realized_value AS view_realized_value,
    r.variance_vs_expected AS view_variance_vs_expected,
    r.improvement_vs_baseline AS view_improvement_vs_baseline,
    r.assessment AS view_assessment,
    r.polarity AS view_polarity,
    r.realized_from_measurement_id AS view_from_measurement_id,
    r.outcome_settled_at AS view_outcome_settled_at,
    r.note AS realization_note,
    r.reason AS abandonment_reason,
    r.actor_kind AS realization_actor_kind,
    r.actor_id AS realization_actor_id,
    r.actor_label AS realization_actor_label,
    r.realized_by_principal,
    r.recorded_at AS realized_at`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function mapActor(row: {
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
}): InterventionActor {
  return {
    kind: row.actor_kind as InterventionActor['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapGoalRefs(value: unknown): InterventionGoalRef[] {
  return Array.isArray(value) ? (value as InterventionGoalRef[]) : [];
}

function mapTarget(value: unknown): InterventionTarget | null {
  if (value === null || value === undefined) return null;
  return value as InterventionTarget; // write-validated shape {kind, id, label}
}

function mapAuthorizationRef(value: unknown): InterventionAuthorizationRef | null {
  if (value === null || value === undefined) return null;
  return value as InterventionAuthorizationRef; // write-validated shape
}

function mapEvidenceIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function interventionNotFound(interventionId: string): OutcomesError {
  return new OutcomesError(
    'intervention_not_found',
    `intervention '${interventionId}' does not exist in this tenant`,
  );
}

/** True when `error` is a PostgreSQL unique violation naming `fragment`. */
function isDuplicateKeyOn(error: unknown, fragment: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(fragment)
  );
}

/**
 * Cross-module measuring-outcome read (the sanctioned `W040 → W054`
 * dependency): the intervention's outcome must exist and be readable in
 * this tenant, verified through the learning contract — never its tables.
 * Missing, malformed and foreign-tenant outcome ids are uniformly
 * `invalid_outcome_ref` (no existence leak).
 */
async function readMeasuringOutcome(ctx: TenantContext, outcomeId: string): Promise<MeasuringOutcome> {
  try {
    return await getOutcome(ctx, outcomeId);
  } catch (error) {
    if (error instanceof LearningError) {
      throw new OutcomesError(
        'invalid_outcome_ref',
        `the measuring outcome '${outcomeId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** The live observed-outcome summary (the ADR-0019 "observed" leg). */
function outcomeSummaryOf(outcome: MeasuringOutcome): InterventionOutcomeSummary {
  return {
    outcomeId: outcome.id,
    status: outcome.status,
    measurementCount: outcome.measurementCount,
    latestObservedValue: outcome.latestMeasurement === null ? null : outcome.latestMeasurement.value,
  };
}

/**
 * Assembles the derived current view from a view-join row plus the live
 * measuring-outcome read: status from the realization's existence, the
 * frozen realized record on realizations, the abandonment audit on
 * abandonments.
 */
function mapIntervention(row: ViewRow, outcome: MeasuringOutcome): Intervention {
  const disposition = row.realization_disposition as InterventionStatus | null; // CHECK-constrained

  let realization: InterventionRealization | null = null;
  let abandonment: Intervention['abandonment'] = null;
  if (disposition === 'realized') {
    realization = {
      realizedValue: row.view_realized_value!,
      varianceVsExpected: row.view_variance_vs_expected!,
      improvementVsBaseline: row.view_improvement_vs_baseline!,
      assessment: row.view_assessment as InterventionAssessment, // CHECK-constrained
      polarity: row.view_polarity as EvidencePolarity, // CHECK-constrained
      fromMeasurementId: row.view_from_measurement_id!,
      outcomeSettledAt: toIso(row.view_outcome_settled_at!),
      note: row.realization_note,
      actor: {
        kind: row.realization_actor_kind as InterventionActor['kind'], // CHECK-constrained
        id: row.realization_actor_id,
        label: row.realization_actor_label,
      },
      realizedByPrincipal: row.realized_by_principal!,
      realizedAt: toIso(row.realized_at!),
    };
  } else if (disposition === 'abandoned') {
    abandonment = {
      reason: row.abandonment_reason!,
      actor: {
        kind: row.realization_actor_kind as InterventionActor['kind'], // CHECK-constrained
        id: row.realization_actor_id,
        label: row.realization_actor_label,
      },
      abandonedByPrincipal: row.realized_by_principal!,
      abandonedAt: toIso(row.realized_at!),
    };
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.intervention_kind as InterventionKind, // CHECK-constrained
    capabilityKey: row.capability_key,
    capabilityLabel: row.capability_label,
    target: mapTarget(row.target),
    originGoalIds: mapGoalRefs(row.origin_goal_ids),
    originRecommendationId: row.origin_recommendation_id,
    authorizationRef: mapAuthorizationRef(row.authorization_ref),
    originExecutionId: row.origin_execution_id,
    outcomeId: row.outcome_id,
    metric: {
      metricName: row.metric_name,
      metricUnit: row.metric_unit,
      direction: row.direction as Intervention['metric']['direction'], // CHECK-constrained
      baseline: row.baseline,
      expected: row.expected,
    },
    status: disposition ?? 'active',
    realization,
    abandonment,
    outcomeSummary: outcomeSummaryOf(outcome),
    rationale: row.rationale,
    actor: mapActor(row),
    recordedByPrincipal: row.recorded_by_principal,
    createdAt: toIso(row.recorded_at),
  };
}

function mapPrior(row: PriorRow): InterventionPrior {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    interventionKind: row.intervention_kind as InterventionKind, // CHECK-constrained
    capabilityKey: row.capability_key,
    priorVersion: toInt(row.prior_version),
    sampleSize: toInt(row.sample_size),
    successes: toInt(row.successes),
    failures: toInt(row.failures),
    successRate: row.success_rate,
    expectedSum: row.expected_sum,
    realizedSum: row.realized_sum,
    netVariance: row.net_variance,
    meanVariance: row.mean_variance,
    triggeredByInterventionId: row.triggered_by_intervention_id,
    evidenceInterventionIds: mapEvidenceIds(row.evidence_intervention_ids),
    actor: mapActor(row),
    updatedByPrincipal: row.updated_by_principal,
    updatedAt: toIso(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// recordIntervention
// ---------------------------------------------------------------------------

export async function recordIntervention(
  ctx: TenantContext,
  input: RecordInterventionInput,
): Promise<Intervention> {
  assertOutcomesTenantContext(ctx);
  const valid = validateRecordInterventionInput(input);

  // The ONE validated cross-module link: the measuring outcome must be
  // readable through the learning contract and still OPEN — the
  // intervention record is committed BEFORE realization (ADR-0019's
  // chain), and the outcome's immutable definition is what makes the
  // prediction honest.
  const outcome = await readMeasuringOutcome(ctx, valid.outcomeId);
  if (outcome.status !== 'open') {
    throw new OutcomesError(
      'invalid_transition',
      outcome.status === 'settled'
        ? `outcome '${valid.outcomeId}' is already settled — an intervention record must be committed before realization; tie the subject to a new outcome instead`
        : `outcome '${valid.outcomeId}' was abandoned — tie the intervention to a new outcome instead`,
    );
  }
  const recordedAt = now();

  let inserted: DbResult<InterventionRow>;
  try {
    inserted = await getDb().query<InterventionRow>(
      `INSERT INTO interventions (
         tenant_id, intervention_kind, capability_key, capability_label,
         target, origin_goal_ids, origin_recommendation_id, authorization_ref,
         origin_execution_id, outcome_id,
         metric_name, metric_unit, direction, baseline, expected,
         actor_kind, actor_id, actor_label, recorded_by_principal, rationale, recorded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5::jsonb, $6::jsonb, $7, $8::jsonb,
         $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21::timestamptz
       ) RETURNING *`,
      [
        ctx.tenantId,
        valid.kind,
        valid.capabilityKey,
        valid.capabilityLabel,
        valid.target === null ? null : JSON.stringify(valid.target),
        JSON.stringify(valid.originGoalIds),
        valid.originRecommendationId,
        valid.authorizationRef === null ? null : JSON.stringify(valid.authorizationRef),
        valid.originExecutionId,
        valid.outcomeId,
        outcome.metricName,
        outcome.metricUnit,
        outcome.direction,
        outcome.baseline,
        outcome.expected,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        valid.rationale,
        recordedAt,
      ],
    );
  } catch (error) {
    // The 1:1 measuring tie: another intervention is already measured by
    // this outcome — an outcome measures ONE intervention's effect.
    if (isDuplicateKeyOn(error, 'interventions_outcome_unique')) {
      throw new OutcomesError(
        'intervention_conflict',
        `another intervention is already measured by outcome '${valid.outcomeId}' — an outcome measures one intervention's effect; tie the new intervention to a new outcome`,
      );
    }
    throw error;
  }
  const row = inserted.rows[0]!;

  // A fresh intervention: active, no realization, the just-read observed
  // state of its measuring outcome.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.intervention_kind as InterventionKind, // CHECK-constrained
    capabilityKey: row.capability_key,
    capabilityLabel: row.capability_label,
    target: mapTarget(row.target),
    originGoalIds: mapGoalRefs(row.origin_goal_ids),
    originRecommendationId: row.origin_recommendation_id,
    authorizationRef: mapAuthorizationRef(row.authorization_ref),
    originExecutionId: row.origin_execution_id,
    outcomeId: row.outcome_id,
    metric: {
      metricName: row.metric_name,
      metricUnit: row.metric_unit,
      direction: row.direction as Intervention['metric']['direction'], // CHECK-constrained
      baseline: row.baseline,
      expected: row.expected,
    },
    status: 'active',
    realization: null,
    abandonment: null,
    outcomeSummary: outcomeSummaryOf(outcome),
    rationale: row.rationale,
    actor: mapActor(row),
    recordedByPrincipal: row.recorded_by_principal,
    createdAt: toIso(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// Shared mutation core (realize / abandon)
// ---------------------------------------------------------------------------

/**
 * Locks the intervention definition row (FOR UPDATE — concurrent terminal
 * writers serialize here) and returns it, or `intervention_not_found`
 * (uniform for missing, malformed and foreign-tenant ids).
 */
async function lockIntervention(
  tx: Queryable,
  ctx: TenantContext,
  interventionId: string,
): Promise<InterventionRow> {
  const locked = await tx.query<InterventionRow>(
    `SELECT * FROM interventions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.tenantId, interventionId],
  );
  const row = locked.rows[0];
  if (row === undefined) throw interventionNotFound(interventionId);
  return row;
}

/** The intervention's terminal record, if any (tenant-scoped). */
async function findRealization(
  tx: Queryable,
  ctx: TenantContext,
  interventionId: string,
): Promise<RealizationRow | null> {
  const rows = await tx.query<RealizationRow>(
    `SELECT * FROM intervention_realizations WHERE tenant_id = $1 AND intervention_id = $2`,
    [ctx.tenantId, interventionId],
  );
  return rows.rows[0] ?? null;
}

/** Guards a mutation with the lifecycle gate: terminal interventions accept nothing. */
function assertActive(realization: RealizationRow | null, interventionId: string): void {
  if (realization !== null) {
    throw new OutcomesError(
      'invalid_transition',
      `intervention '${interventionId}' is ${realization.disposition} — a ${realization.disposition} intervention is terminal; a returning need is a new intervention tied to a new outcome`,
    );
  }
}

/** Assembles the derived current view from a definition + terminal record + outcome. */
function assembleIntervention(
  definition: InterventionRow,
  realization: RealizationRow,
  outcome: MeasuringOutcome,
): Intervention {
  const view: ViewRow = {
    ...definition,
    realization_disposition: realization.disposition,
    view_realized_value: realization.realized_value,
    view_variance_vs_expected: realization.variance_vs_expected,
    view_improvement_vs_baseline: realization.improvement_vs_baseline,
    view_assessment: realization.assessment,
    view_polarity: realization.polarity,
    view_from_measurement_id: realization.realized_from_measurement_id,
    view_outcome_settled_at: realization.outcome_settled_at,
    realization_note: realization.note,
    abandonment_reason: realization.reason,
    realization_actor_kind: realization.actor_kind,
    realization_actor_id: realization.actor_id,
    realization_actor_label: realization.actor_label,
    realized_by_principal: realization.realized_by_principal,
    realized_at: realization.recorded_at,
  };
  return mapIntervention(view, outcome);
}

// ---------------------------------------------------------------------------
// realizeIntervention (active → realized, terminal) + the learning update
// ---------------------------------------------------------------------------

export async function realizeIntervention(
  ctx: TenantContext,
  input: RealizeInterventionInput,
): Promise<Intervention> {
  assertOutcomesTenantContext(ctx);
  const valid = validateRealizeInterventionInput(input);
  if (!isUuid(valid.interventionId)) {
    // Malformed ids are indistinguishable from missing interventions (no leak).
    throw interventionNotFound(valid.interventionId);
  }

  // The measuring outcome is read through the learning contract BEFORE the
  // mutation transaction: its terminal states are stable (a settled outcome
  // stays settled — the learning module has no un-settle), so this read
  // cannot go stale under the transaction.
  const preRead = await getDb().query<InterventionRow>(
    `SELECT * FROM interventions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.interventionId],
  );
  if (preRead.rows[0] === undefined) throw interventionNotFound(valid.interventionId);
  const outcome = await readMeasuringOutcome(ctx, preRead.rows[0].outcome_id);
  if (outcome.status !== 'settled' || outcome.realization === null) {
    throw new OutcomesError(
      'invalid_transition',
      outcome.status === 'open'
        ? `the measuring outcome '${preRead.rows[0].outcome_id}' is still open — record measurements and settle it before realizing the intervention`
        : `the measuring outcome '${preRead.rows[0].outcome_id}' was abandoned — nothing was realized; abandon the intervention instead`,
    );
  }
  // The FROZEN expected-versus-realized record (never a re-derivation).
  const frozen = outcome.realization;
  const polarity: EvidencePolarity = frozen.assessment === 'missed' ? 'negative' : 'positive';
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    const definition = await lockIntervention(tx, ctx, valid.interventionId);
    const existing = await findRealization(tx, ctx, valid.interventionId);
    assertActive(existing, valid.interventionId);

    let inserted: DbResult<RealizationRow>;
    try {
      inserted = await tx.query<RealizationRow>(
        `INSERT INTO intervention_realizations (
           tenant_id, intervention_id, disposition,
           realized_value, variance_vs_expected, improvement_vs_baseline,
           assessment, polarity, realized_from_measurement_id, outcome_settled_at,
           note, actor_kind, actor_id, actor_label, realized_by_principal, recorded_at
         ) VALUES (
           $1, $2, 'realized',
           $3, $4, $5,
           $6, $7, $8, $9::timestamptz,
           $10, $11, $12, $13, $14, $15::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          valid.interventionId,
          frozen.realizedValue,
          frozen.varianceVsExpected,
          frozen.improvementVsBaseline,
          frozen.assessment,
          polarity,
          frozen.fromMeasurementId,
          new Date(frozen.settledAt),
          valid.note,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'intervention_realizations_intervention_unique')) {
        throw new OutcomesError(
          'intervention_conflict',
          'a concurrent change realized this intervention first; re-read the intervention and retry',
        );
      }
      throw error;
    }

    // THE LEARNING UPDATE — appended atomically with the realization: the
    // deterministic aggregate over every realized intervention of this
    // (kind, capability key), as one new prior version.
    const samples = await tx.query<SampleRow>(
      `SELECT i.id AS intervention_id, r.assessment, i.expected,
              r.realized_value, r.variance_vs_expected
         FROM interventions i
         JOIN intervention_realizations r
           ON r.tenant_id = i.tenant_id AND r.intervention_id = i.id
        WHERE i.tenant_id = $1 AND i.intervention_kind = $2 AND i.capability_key = $3
          AND r.disposition = 'realized'
        ORDER BY r.recorded_at ASC, i.id ASC`,
      [ctx.tenantId, definition.intervention_kind, definition.capability_key],
    );
    const aggregate = computePriorUpdate(
      samples.rows.map((row): PriorSampleEntry => ({
        interventionId: row.intervention_id,
        assessment: row.assessment as InterventionAssessment, // CHECK-constrained
        expected: row.expected,
        realizedValue: row.realized_value,
        varianceVsExpected: row.variance_vs_expected,
      })),
    );
    const versioned = await tx.query<{ next_version: number | string }>(
      `SELECT COALESCE(MAX(prior_version), 0) + 1 AS next_version
         FROM intervention_priors
        WHERE tenant_id = $1 AND intervention_kind = $2 AND capability_key = $3`,
      [ctx.tenantId, definition.intervention_kind, definition.capability_key],
    );
    try {
      await tx.query(
        `INSERT INTO intervention_priors (
           tenant_id, intervention_kind, capability_key, prior_version,
           sample_size, successes, failures, success_rate,
           expected_sum, realized_sum, net_variance, mean_variance,
           triggered_by_intervention_id, evidence_intervention_ids,
           actor_kind, actor_id, actor_label, updated_by_principal, recorded_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14::jsonb,
           $15, $16, $17, $18, $19::timestamptz
         )`,
        [
          ctx.tenantId,
          definition.intervention_kind,
          definition.capability_key,
          toInt(versioned.rows[0]!.next_version),
          aggregate.sampleSize,
          aggregate.successes,
          aggregate.failures,
          aggregate.successRate,
          aggregate.expectedSum,
          aggregate.realizedSum,
          aggregate.netVariance,
          aggregate.meanVariance,
          valid.interventionId,
          JSON.stringify(aggregate.evidenceInterventionIds),
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'intervention_priors_version_unique')) {
        throw new OutcomesError(
          'intervention_conflict',
          'a concurrent learning update versioned this prior first; re-read the intervention and retry',
        );
      }
      throw error;
    }

    return assembleIntervention(definition, inserted.rows[0]!, outcome);
  });
}

// ---------------------------------------------------------------------------
// abandonIntervention (active → abandoned, terminal)
// ---------------------------------------------------------------------------

export async function abandonIntervention(
  ctx: TenantContext,
  input: AbandonInterventionInput,
): Promise<Intervention> {
  assertOutcomesTenantContext(ctx);
  const valid = validateAbandonInterventionInput(input);
  if (!isUuid(valid.interventionId)) throw interventionNotFound(valid.interventionId);

  // Abandonment is only possible while the measuring outcome has NOT
  // settled: a settled outcome means the evidence exists, and abandoning
  // then would suppress it (failed interventions are retained as negative
  // evidence — ADR-0019). The outcome's terminal states are stable, so
  // this pre-transaction read cannot go stale under the transaction.
  const preRead = await getDb().query<InterventionRow>(
    `SELECT * FROM interventions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.interventionId],
  );
  if (preRead.rows[0] === undefined) throw interventionNotFound(valid.interventionId);
  const outcome = await readMeasuringOutcome(ctx, preRead.rows[0].outcome_id);
  if (outcome.status === 'settled') {
    throw new OutcomesError(
      'invalid_transition',
      `the measuring outcome '${preRead.rows[0].outcome_id}' settled — the evidence exists and cannot be suppressed; realize the intervention instead`,
    );
  }
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    const definition = await lockIntervention(tx, ctx, valid.interventionId);
    const existing = await findRealization(tx, ctx, valid.interventionId);
    assertActive(existing, valid.interventionId);

    let inserted: DbResult<RealizationRow>;
    try {
      inserted = await tx.query<RealizationRow>(
        `INSERT INTO intervention_realizations (
           tenant_id, intervention_id, disposition, reason,
           actor_kind, actor_id, actor_label, realized_by_principal, recorded_at
         ) VALUES (
           $1, $2, 'abandoned', $3,
           $4, $5, $6, $7, $8::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          valid.interventionId,
          valid.reason,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'intervention_realizations_intervention_unique')) {
        throw new OutcomesError(
          'intervention_conflict',
          'a concurrent change terminated this intervention first; re-read the intervention and retry',
        );
      }
      throw error;
    }

    // Abandonments contribute NO evidence to priors (nothing was realized);
    // the intervention record itself stays retained, append-only.
    return assembleIntervention(definition, inserted.rows[0]!, outcome);
  });
}

// ---------------------------------------------------------------------------
// Reads: getIntervention / listInterventions
// ---------------------------------------------------------------------------

export async function getIntervention(
  ctx: TenantContext,
  interventionId: string,
): Promise<Intervention> {
  assertOutcomesTenantContext(ctx);
  if (!isUuid(interventionId)) throw interventionNotFound(interventionId);

  const rows = await getDb().query<ViewRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE i.tenant_id = $1 AND i.id = $2`,
    [ctx.tenantId, interventionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw interventionNotFound(interventionId);

  // The observed leg is composed live through the learning contract.
  const outcome = await readMeasuringOutcome(ctx, row.outcome_id);
  return mapIntervention(row, outcome);
}

export async function listInterventions(
  ctx: TenantContext,
  query: ListInterventionsQuery,
): Promise<Intervention[]> {
  assertOutcomesTenantContext(ctx);
  const valid = validateListInterventionsQuery(query);

  const conditions: string[] = ['i.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.interventionKind !== null) add('i.intervention_kind = $#', valid.interventionKind);
  if (valid.capabilityKey !== null) add('i.capability_key = $#', valid.capabilityKey);
  if (valid.status !== null) {
    // Status is derived from the realization row's existence/disposition.
    if (valid.status === 'active') conditions.push('r.disposition IS NULL');
    else add('r.disposition = $#', valid.status);
  }
  if (valid.polarity !== null) add('r.polarity = $#', valid.polarity);
  if (valid.outcomeId !== null) add('i.outcome_id = $#', valid.outcomeId);
  if (valid.search !== null) {
    // escaped substring match on the capability label — caller text is
    // never a wildcard pattern.
    params.push(escapeLike(valid.search));
    conditions.push(`i.capability_label ILIKE '%' || $${params.length} || '%'`);
  }
  params.push(valid.limit);
  const limitIndex = params.length;

  const rows = await getDb().query<ViewRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY i.recorded_at DESC, i.id DESC
      LIMIT $${limitIndex}`,
    params,
  );

  // The observed leg is composed live through the learning contract, one
  // contract read per intervention (bounded by the list limit).
  const views: Intervention[] = [];
  for (const row of rows.rows) {
    const outcome = await readMeasuringOutcome(ctx, row.outcome_id);
    views.push(mapIntervention(row, outcome));
  }
  return views;
}

// ---------------------------------------------------------------------------
// The learned priors: recommendation-facing current read + version history
// ---------------------------------------------------------------------------

export async function getInterventionPriors(
  ctx: TenantContext,
  query: GetInterventionPriorsQuery,
): Promise<InterventionPrior[]> {
  assertOutcomesTenantContext(ctx);
  const valid = validateGetInterventionPriorsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.interventionKind !== null) add('intervention_kind = $#', valid.interventionKind);
  if (valid.capabilityKey !== null) add('capability_key = $#', valid.capabilityKey);

  // The CURRENT prior per (kind, capability key) = the highest version.
  // DISTINCT ON needs the key columns leading; the outer query re-sorts
  // most-recently-updated first and applies the caller's limit.
  params.push(valid.limit);
  const limitIndex = params.length;
  const rows = await getDb().query<PriorRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (intervention_kind, capability_key) *
         FROM intervention_priors
        WHERE ${conditions.join(' AND ')}
        ORDER BY intervention_kind, capability_key, prior_version DESC
     ) AS current_priors
     ORDER BY recorded_at DESC, id DESC
     LIMIT $${limitIndex}`,
    params,
  );
  return rows.rows.map(mapPrior);
}

export async function listInterventionPriorVersions(
  ctx: TenantContext,
  query: ListInterventionPriorVersionsQuery,
): Promise<InterventionPrior[]> {
  assertOutcomesTenantContext(ctx);
  const valid = validateListInterventionPriorVersionsQuery(query);

  const rows = await getDb().query<PriorRow>(
    `SELECT * FROM intervention_priors
      WHERE tenant_id = $1 AND intervention_kind = $2 AND capability_key = $3
      ORDER BY prior_version ASC
      LIMIT $4`,
    [ctx.tenantId, valid.interventionKind, valid.capabilityKey, valid.limit],
  );
  return rows.rows.map(mapPrior);
}
