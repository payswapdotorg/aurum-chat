// Implementation of the learning module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`outcome_not_found` / `measurement_not_found`), on
// reads AND on writes (measuring, settling and abandoning a foreign-tenant
// outcome id read the same as a missing one).
//
// W040 acceptance is carried by these deliberate properties, all tested:
//   1. TIED: every outcome names ONE subject (recommendation / agent /
//      extension / mission — an opaque uuid forward reference; the owning
//      module stays the verification point, no cross-module FK) plus
//      optional affected goals (the missions module's affected-goals
//      precedent) and an optional originating cognitive execution — the
//      one validated cross-module link, checked readable through the
//      cognition contract at write time (the sanctioned W013 → W040
//      dependency; ADR-0019's "originating execution").
//   2. MEASURABLE: the definition freezes metric name + unit, direction,
//      baseline and EXPECTED value at definition time — there is no
//      revision operation anywhere (a prediction that can be rewritten
//      after realization is worthless for expected-versus-realized
//      honesty), and PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on
//      all three tables via migration 001 triggers.
//   3. EVIDENCE-GROUNDED REALIZATION: settling requires a measurement OF
//      THE SAME OUTCOME — the realized value IS that measurement's value
//      (the composite FK (realized_from_measurement_id, tenant_id,
//      outcome_id) makes a foreign or cross-outcome grounding
//      unrepresentable in SQL). The service then freezes the
//      expected-versus-realized record (variance vs expected, improvement
//      vs baseline, deterministic met/exceeded/missed assessment) onto the
//      terminal realization row; it is never recomputed or edited.
//   4. TERMINAL: a realization row's existence IS the terminal status
//      (derived — never stored on the definition); first write wins via
//      UNIQUE (tenant_id, outcome_id) under a FOR UPDATE lock on the
//      definition row, so a raced terminal write loses cleanly with
//      `outcome_conflict` / `invalid_transition` and measurements can
//      never sneak onto a terminal outcome.
//
// Storage shape: `outcomes` (immutable definition), `outcome_measurements`
// (append-only observation series) and `outcome_realizations`
// (first-write-wins terminal records). Reads derive the current view by
// LEFT JOINing the realization and the latest measurement.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, CognitionError } from '@/modules/cognition/contract';
import { LearningError } from './errors';
import {
  assertLearningTenantContext,
  assessRealization,
  escapeLike,
  isUuid,
  OUTCOME_SUBJECT_KINDS,
  RANK_DOMAIN_FAMILIES,
  scoreCandidateSet,
  validateAbandonOutcomeInput,
  validateDefineOutcomeInput,
  validateGetCompanyModelQuery,
  validateListCompanyAssertionsQuery,
  validateListLearningUpdatesQuery,
  validateListMeasurementsQuery,
  validateListOutcomesQuery,
  validateRankCandidatesInput,
  validateRecordLearningUpdateInput,
  validateRecordMeasurementInput,
  validateSettleOutcomeInput,
  validateSummarizeRealizationQuery,
  type ScoreableAssertion,
  type ValidatedDefineInput,
} from './validation';
import type {
  AbandonOutcomeInput,
  AssertionDisposition,
  AssertionProvenanceRef,
  CompanyModel,
  CompanyModelAssertion,
  CompanyModelAssertionStatus,
  CompanyModelArea,
  CompanyModelRanking,
  DefineOutcomeInput,
  GetCompanyModelQuery,
  LearningUpdate,
  ListCompanyAssertionsQuery,
  ListLearningUpdatesQuery,
  ListMeasurementsQuery,
  ListOutcomesQuery,
  Outcome,
  OutcomeActor,
  OutcomeAssessment,
  OutcomeDirection,
  OutcomeEvidenceRef,
  OutcomeGoalRef,
  OutcomeMeasurement,
  OutcomeRealization,
  OutcomeStatus,
  OutcomeSubject,
  RankedCandidate,
  RankCandidatesInput,
  RealizationBucket,
  RealizationSummary,
  RecordLearningUpdateInput,
  RecordMeasurementInput,
  SettleOutcomeInput,
  SummarizeRealizationQuery,
} from './types';

/** Row shape of `outcomes` (the immutable definition). */
interface OutcomeRow extends DbRow {
  id: string;
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  subject_label: string | null;
  metric_name: string;
  metric_unit: string;
  direction: string;
  baseline: number;
  expected: number;
  horizon: string | null;
  affected_goals: unknown;
  origin_execution_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  defined_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of `outcome_measurements` (the append-only observation series). */
interface MeasurementRow extends DbRow {
  id: string;
  tenant_id: string;
  outcome_id: string;
  value: number;
  note: string | null;
  evidence: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of `outcome_realizations` (the terminal records). */
interface RealizationRow extends DbRow {
  id: string;
  tenant_id: string;
  outcome_id: string;
  disposition: string;
  realized_value: number | null;
  variance_vs_expected: number | null;
  improvement_vs_baseline: number | null;
  assessment: string | null;
  realized_from_measurement_id: string | null;
  note: string | null;
  reason: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  realized_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of the derived current-view join (definition ⊕ realization ⊕ latest measurement). */
interface ViewRow extends OutcomeRow {
  realization_disposition: string | null;
  realized_value: number | null;
  variance_vs_expected: number | null;
  improvement_vs_baseline: number | null;
  assessment: string | null;
  realized_from_measurement_id: string | null;
  realization_note: string | null;
  abandonment_reason: string | null;
  realization_actor_kind: string | null;
  realization_actor_id: string | null;
  realization_actor_label: string | null;
  realized_by_principal: string | null;
  realized_at: Date | string | null;
  measurement_count: number | string;
  latest_measurement_id: string | null;
  latest_value: number | null;
  latest_note: string | null;
  latest_evidence: unknown;
  latest_actor_kind: string | null;
  latest_actor_id: string | null;
  latest_actor_label: string | null;
  latest_recorded_by_principal: string | null;
  latest_recorded_at: Date | string | null;
}

// The derived current view, shared by getOutcome and listOutcomes. The
// LATERAL join picks the most recent measurement deterministically
// (recorded_at DESC, id DESC); the scalar subquery counts the series.
const CURRENT_VIEW_FROM = `FROM outcomes o
  LEFT JOIN outcome_realizations r
    ON r.outcome_id = o.id AND r.tenant_id = o.tenant_id
  LEFT JOIN LATERAL (
    SELECT m.* FROM outcome_measurements m
     WHERE m.tenant_id = o.tenant_id AND m.outcome_id = o.id
     ORDER BY m.recorded_at DESC, m.id DESC
     LIMIT 1
  ) lm ON true`;

const CURRENT_VIEW_COLUMNS = `SELECT
    o.id, o.tenant_id, o.subject_kind, o.subject_id, o.subject_label,
    o.metric_name, o.metric_unit, o.direction, o.baseline, o.expected,
    o.horizon, o.affected_goals, o.origin_execution_id,
    o.actor_kind, o.actor_id, o.actor_label, o.defined_by_principal,
    o.rationale, o.recorded_at,
    r.disposition AS realization_disposition,
    r.realized_value, r.variance_vs_expected, r.improvement_vs_baseline,
    r.assessment, r.realized_from_measurement_id,
    r.note AS realization_note, r.reason AS abandonment_reason,
    r.actor_kind AS realization_actor_kind, r.actor_id AS realization_actor_id,
    r.actor_label AS realization_actor_label, r.realized_by_principal,
    r.recorded_at AS realized_at,
    (SELECT count(*)::int FROM outcome_measurements m
       WHERE m.tenant_id = o.tenant_id AND m.outcome_id = o.id) AS measurement_count,
    lm.id AS latest_measurement_id, lm.value AS latest_value, lm.note AS latest_note,
    lm.evidence AS latest_evidence, lm.actor_kind AS latest_actor_kind,
    lm.actor_id AS latest_actor_id, lm.actor_label AS latest_actor_label,
    lm.recorded_by_principal AS latest_recorded_by_principal,
    lm.recorded_at AS latest_recorded_at`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function mapActor(row: { actor_kind: string; actor_id: string | null; actor_label: string | null }): OutcomeActor {
  return {
    kind: row.actor_kind as OutcomeActor['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapGoalRefs(value: unknown): OutcomeGoalRef[] {
  return Array.isArray(value) ? (value as OutcomeGoalRef[]) : [];
}

function mapEvidence(value: unknown): OutcomeEvidenceRef[] {
  return Array.isArray(value) ? (value as OutcomeEvidenceRef[]) : [];
}

function mapSubject(row: { subject_kind: string; subject_id: string; subject_label: string | null }): OutcomeSubject {
  return {
    kind: row.subject_kind as OutcomeSubject['kind'], // CHECK-constrained
    id: row.subject_id,
    label: row.subject_label,
  };
}

function mapMeasurement(row: MeasurementRow): OutcomeMeasurement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    outcomeId: row.outcome_id,
    value: row.value,
    note: row.note,
    evidence: mapEvidence(row.evidence),
    actor: mapActor(row),
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

function outcomeNotFound(outcomeId: string): LearningError {
  return new LearningError('outcome_not_found', `outcome '${outcomeId}' does not exist in this tenant`);
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/**
 * Assembles the derived current view from a view-join row: status from the
 * realization's existence, the frozen expected-versus-realized record on
 * settlements, the abandonment audit, and the observation-series summary.
 */
function mapOutcome(row: ViewRow): Outcome {
  const disposition = row.realization_disposition as OutcomeStatus | null; // CHECK-constrained

  let realization: OutcomeRealization | null = null;
  let abandonment: Outcome['abandonment'] = null;
  if (disposition === 'settled') {
    realization = {
      realizedValue: row.realized_value!,
      varianceVsExpected: row.variance_vs_expected!,
      improvementVsBaseline: row.improvement_vs_baseline!,
      assessment: row.assessment as OutcomeAssessment, // CHECK-constrained
      fromMeasurementId: row.realized_from_measurement_id!,
      note: row.realization_note,
      actor: {
        kind: row.realization_actor_kind as OutcomeActor['kind'], // CHECK-constrained
        id: row.realization_actor_id,
        label: row.realization_actor_label,
      },
      realizedByPrincipal: row.realized_by_principal!,
      settledAt: toIso(row.realized_at!),
    };
  } else if (disposition === 'abandoned') {
    abandonment = {
      reason: row.abandonment_reason!,
      actor: {
        kind: row.realization_actor_kind as OutcomeActor['kind'], // CHECK-constrained
        id: row.realization_actor_id,
        label: row.realization_actor_label,
      },
      abandonedByPrincipal: row.realized_by_principal!,
      abandonedAt: toIso(row.realized_at!),
    };
  }

  const latestMeasurement: OutcomeMeasurement | null =
    row.latest_measurement_id === null
      ? null
      : {
          id: row.latest_measurement_id,
          tenantId: row.tenant_id,
          outcomeId: row.id,
          value: row.latest_value!,
          note: row.latest_note,
          evidence: mapEvidence(row.latest_evidence),
          actor: {
            kind: row.latest_actor_kind as OutcomeActor['kind'], // CHECK-constrained
            id: row.latest_actor_id,
            label: row.latest_actor_label,
          },
          recordedByPrincipal: row.latest_recorded_by_principal!,
          recordedAt: toIso(row.latest_recorded_at!),
        };

  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: mapSubject(row),
    metricName: row.metric_name,
    metricUnit: row.metric_unit,
    direction: row.direction as OutcomeDirection, // CHECK-constrained
    baseline: row.baseline,
    expected: row.expected,
    horizon: row.horizon,
    affectedGoals: mapGoalRefs(row.affected_goals),
    originExecutionId: row.origin_execution_id,
    status: disposition ?? 'open',
    realization,
    abandonment,
    measurementCount: toInt(row.measurement_count),
    latestMeasurement,
    createdAt: toIso(row.recorded_at),
    lastChange: {
      actor: mapActor(row),
      changedByPrincipal: row.defined_by_principal,
      rationale: row.rationale,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

/**
 * Cross-module origin validation (the sanctioned `W013 → W040` dependency):
 * an outcome's originating cognitive execution must exist and be readable
 * in this tenant, verified through the cognition contract — never its
 * tables. Missing, malformed and foreign-tenant execution ids are uniformly
 * `invalid_origin_ref` (no existence leak).
 */
async function validateOriginExecutionRef(ctx: TenantContext, executionId: string): Promise<void> {
  try {
    await getExecution(ctx, { executionId });
  } catch (error) {
    if (error instanceof CognitionError) {
      throw new LearningError(
        'invalid_origin_ref',
        `originating execution '${executionId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// defineOutcome
// ---------------------------------------------------------------------------

export async function defineOutcome(ctx: TenantContext, input: DefineOutcomeInput): Promise<Outcome> {
  assertLearningTenantContext(ctx);
  const valid: ValidatedDefineInput = validateDefineOutcomeInput(input);
  if (valid.originExecutionId !== null) {
    await validateOriginExecutionRef(ctx, valid.originExecutionId);
  }
  const recordedAt = now();

  // The definition row is the outcome's only immutable content — version,
  // lifecycle and realization state are all derived (see the module header).
  const inserted = await getDb().query<OutcomeRow>(
    `INSERT INTO outcomes (
       tenant_id, subject_kind, subject_id, subject_label,
       metric_name, metric_unit, direction, baseline, expected, horizon,
       affected_goals, origin_execution_id,
       actor_kind, actor_id, actor_label, defined_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9, $10,
       $11::jsonb, $12,
       $13, $14, $15, $16, $17, $18::timestamptz
     ) RETURNING *`,
    [
      ctx.tenantId,
      valid.subject.kind,
      valid.subject.id,
      valid.subject.label,
      valid.metricName,
      valid.metricUnit,
      valid.direction,
      valid.baseline,
      valid.expected,
      valid.horizon,
      JSON.stringify(valid.affectedGoals),
      valid.originExecutionId,
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      ctx.principalId,
      valid.rationale,
      recordedAt,
    ],
  );
  const row = inserted.rows[0]!;

  // A fresh outcome: open, no realization, empty observation series.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: mapSubject(row),
    metricName: row.metric_name,
    metricUnit: row.metric_unit,
    direction: row.direction as OutcomeDirection, // CHECK-constrained
    baseline: row.baseline,
    expected: row.expected,
    horizon: row.horizon,
    affectedGoals: mapGoalRefs(row.affected_goals),
    originExecutionId: row.origin_execution_id,
    status: 'open',
    realization: null,
    abandonment: null,
    measurementCount: 0,
    latestMeasurement: null,
    createdAt: toIso(row.recorded_at),
    lastChange: {
      actor: mapActor(row),
      changedByPrincipal: row.defined_by_principal,
      rationale: row.rationale,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared mutation core (measure / settle / abandon)
// ---------------------------------------------------------------------------

/**
 * Locks the outcome definition row (FOR UPDATE — concurrent terminal
 * writers serialize here) and returns it, or `outcome_not_found` (uniform
 * for missing, malformed and foreign-tenant ids).
 */
async function lockOutcome(
  tx: Queryable,
  ctx: TenantContext,
  outcomeId: string,
): Promise<OutcomeRow> {
  const locked = await tx.query<OutcomeRow>(
    `SELECT * FROM outcomes WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.tenantId, outcomeId],
  );
  const row = locked.rows[0];
  if (row === undefined) throw outcomeNotFound(outcomeId);
  return row;
}

/** The outcome's terminal record, if any (tenant-scoped). */
async function findRealization(
  tx: Queryable,
  ctx: TenantContext,
  outcomeId: string,
): Promise<RealizationRow | null> {
  const rows = await tx.query<RealizationRow>(
    `SELECT * FROM outcome_realizations WHERE tenant_id = $1 AND outcome_id = $2`,
    [ctx.tenantId, outcomeId],
  );
  return rows.rows[0] ?? null;
}

/** Guards a mutation with the lifecycle gate: terminal outcomes accept nothing. */
function assertOpen(realization: RealizationRow | null, outcomeId: string): void {
  if (realization !== null) {
    throw new LearningError(
      'invalid_transition',
      `outcome '${outcomeId}' is ${realization.disposition} — a ${realization.disposition} outcome is terminal; tie the subject to a new outcome instead`,
    );
  }
}

/** The outcome's observation-series summary inside a mutation transaction. */
async function seriesSummary(
  tx: Queryable,
  ctx: TenantContext,
  outcomeId: string,
): Promise<{ count: number; latest: MeasurementRow | null }> {
  const counted = await tx.query<{ count: number | string }>(
    `SELECT count(*)::int AS count FROM outcome_measurements WHERE tenant_id = $1 AND outcome_id = $2`,
    [ctx.tenantId, outcomeId],
  );
  const latest = await tx.query<MeasurementRow>(
    `SELECT * FROM outcome_measurements
      WHERE tenant_id = $1 AND outcome_id = $2
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1`,
    [ctx.tenantId, outcomeId],
  );
  return { count: toInt(counted.rows[0]!.count), latest: latest.rows[0] ?? null };
}

/** Assembles the derived current view from a definition + terminal record + series summary. */
function assembleOutcome(
  definition: OutcomeRow,
  realization: RealizationRow,
  series: { count: number; latest: MeasurementRow | null },
): Outcome {
  const view: ViewRow = {
    ...definition,
    realization_disposition: realization.disposition,
    realized_value: realization.realized_value,
    variance_vs_expected: realization.variance_vs_expected,
    improvement_vs_baseline: realization.improvement_vs_baseline,
    assessment: realization.assessment,
    realized_from_measurement_id: realization.realized_from_measurement_id,
    realization_note: realization.note,
    abandonment_reason: realization.reason,
    realization_actor_kind: realization.actor_kind,
    realization_actor_id: realization.actor_id,
    realization_actor_label: realization.actor_label,
    realized_by_principal: realization.realized_by_principal,
    realized_at: realization.recorded_at,
    measurement_count: series.count,
    latest_measurement_id: series.latest?.id ?? null,
    latest_value: series.latest?.value ?? null,
    latest_note: series.latest?.note ?? null,
    latest_evidence: series.latest?.evidence ?? null,
    latest_actor_kind: series.latest?.actor_kind ?? null,
    latest_actor_id: series.latest?.actor_id ?? null,
    latest_actor_label: series.latest?.actor_label ?? null,
    latest_recorded_by_principal: series.latest?.recorded_by_principal ?? null,
    latest_recorded_at: series.latest?.recorded_at ?? null,
  };
  return mapOutcome(view);
}

// ---------------------------------------------------------------------------
// recordMeasurement
// ---------------------------------------------------------------------------

export async function recordMeasurement(
  ctx: TenantContext,
  input: RecordMeasurementInput,
): Promise<OutcomeMeasurement> {
  assertLearningTenantContext(ctx);
  const valid = validateRecordMeasurementInput(input);
  if (!isUuid(valid.outcomeId)) {
    // Malformed ids are indistinguishable from missing outcomes (no leak).
    throw outcomeNotFound(valid.outcomeId);
  }
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Lock + lifecycle gate inside the mutation transaction: a terminal
    // writer that commits first makes this insert impossible, and a
    // concurrent measurement simply serializes after it.
    await lockOutcome(tx, ctx, valid.outcomeId);
    const existing = await findRealization(tx, ctx, valid.outcomeId);
    assertOpen(existing, valid.outcomeId);

    const inserted = await tx.query<MeasurementRow>(
      `INSERT INTO outcome_measurements (
         tenant_id, outcome_id, value, note, evidence,
         actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb,
         $6, $7, $8, $9, $10::timestamptz
       ) RETURNING *`,
      [
        ctx.tenantId,
        valid.outcomeId,
        valid.value,
        valid.note,
        JSON.stringify(valid.evidence),
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        recordedAt,
      ],
    );
    return mapMeasurement(inserted.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// settleOutcome (open → settled, terminal)
// ---------------------------------------------------------------------------

export async function settleOutcome(ctx: TenantContext, input: SettleOutcomeInput): Promise<Outcome> {
  assertLearningTenantContext(ctx);
  const valid = validateSettleOutcomeInput(input);
  if (!isUuid(valid.outcomeId)) throw outcomeNotFound(valid.outcomeId);
  if (!isUuid(valid.measurementId)) {
    // Defense in depth (the validator already enforces uuid): a malformed
    // measurement id is indistinguishable from a missing one (no leak).
    throw new LearningError(
      'measurement_not_found',
      `measurement '${valid.measurementId}' does not exist for outcome '${valid.outcomeId}' in this tenant`,
    );
  }
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    const definition = await lockOutcome(tx, ctx, valid.outcomeId);
    const existing = await findRealization(tx, ctx, valid.outcomeId);
    assertOpen(existing, valid.outcomeId);

    // Realization is evidence-grounded: the realized value IS a recorded
    // measurement of THIS outcome (same tenant, same outcome — the SQL
    // never lets it be otherwise).
    const measured = await tx.query<MeasurementRow>(
      `SELECT * FROM outcome_measurements
        WHERE tenant_id = $1 AND outcome_id = $2 AND id = $3`,
      [ctx.tenantId, valid.outcomeId, valid.measurementId],
    );
    const measurement = measured.rows[0];
    if (measurement === undefined) {
      throw new LearningError(
        'measurement_not_found',
        `measurement '${valid.measurementId}' does not exist for outcome '${valid.outcomeId}' in this tenant`,
      );
    }

    // Freeze the expected-versus-realized record — the single deterministic
    // definition (validation.ts), stored once, never recomputed.
    const assessment = assessRealization(
      definition.direction as OutcomeDirection, // CHECK-constrained
      definition.baseline,
      definition.expected,
      measurement.value,
    );

    let inserted: DbResult<RealizationRow>;
    try {
      inserted = await tx.query<RealizationRow>(
        `INSERT INTO outcome_realizations (
           tenant_id, outcome_id, disposition,
           realized_value, variance_vs_expected, improvement_vs_baseline,
           assessment, realized_from_measurement_id, note,
           actor_kind, actor_id, actor_label, realized_by_principal, recorded_at
         ) VALUES (
           $1, $2, 'settled',
           $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12, $13::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          valid.outcomeId,
          measurement.value,
          assessment.varianceVsExpected,
          assessment.improvementVsBaseline,
          assessment.assessment,
          measurement.id,
          valid.note,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'outcome_realizations')) {
        throw new LearningError(
          'outcome_conflict',
          'a concurrent change realized this outcome first; re-read the outcome and retry',
        );
      }
      throw error;
    }

    const series = await seriesSummary(tx, ctx, valid.outcomeId);
    return assembleOutcome(definition, inserted.rows[0]!, series);
  });
}

// ---------------------------------------------------------------------------
// abandonOutcome (open → abandoned, terminal)
// ---------------------------------------------------------------------------

export async function abandonOutcome(
  ctx: TenantContext,
  input: AbandonOutcomeInput,
): Promise<Outcome> {
  assertLearningTenantContext(ctx);
  const valid = validateAbandonOutcomeInput(input);
  if (!isUuid(valid.outcomeId)) throw outcomeNotFound(valid.outcomeId);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    const definition = await lockOutcome(tx, ctx, valid.outcomeId);
    const existing = await findRealization(tx, ctx, valid.outcomeId);
    assertOpen(existing, valid.outcomeId);

    let inserted: DbResult<RealizationRow>;
    try {
      inserted = await tx.query<RealizationRow>(
        `INSERT INTO outcome_realizations (
           tenant_id, outcome_id, disposition, reason,
           actor_kind, actor_id, actor_label, realized_by_principal, recorded_at
         ) VALUES (
           $1, $2, 'abandoned', $3,
           $4, $5, $6, $7, $8::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          valid.outcomeId,
          valid.reason,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'outcome_realizations')) {
        throw new LearningError(
          'outcome_conflict',
          'a concurrent change realized this outcome first; re-read the outcome and retry',
        );
      }
      throw error;
    }

    const series = await seriesSummary(tx, ctx, valid.outcomeId);
    return assembleOutcome(definition, inserted.rows[0]!, series);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOutcome(ctx: TenantContext, outcomeId: string): Promise<Outcome> {
  assertLearningTenantContext(ctx);
  if (!isUuid(outcomeId)) throw outcomeNotFound(outcomeId);

  const rows = await getDb().query<ViewRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE o.tenant_id = $1 AND o.id = $2`,
    [ctx.tenantId, outcomeId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw outcomeNotFound(outcomeId);
  return mapOutcome(row);
}

export async function listOutcomes(ctx: TenantContext, query: ListOutcomesQuery): Promise<Outcome[]> {
  assertLearningTenantContext(ctx);
  const valid = validateListOutcomesQuery(query);

  const conditions: string[] = ['o.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.subjectKind !== null) add('o.subject_kind = $#', valid.subjectKind);
  if (valid.subjectId !== null) add('o.subject_id = $#', valid.subjectId);
  if (valid.status !== null) {
    // Status is derived from the realization row's existence/disposition.
    if (valid.status === 'open') conditions.push('r.disposition IS NULL');
    else add('r.disposition = $#', valid.status);
  }
  if (valid.assessment !== null) add('r.assessment = $#', valid.assessment);
  if (valid.affectedGoalId !== null) {
    // jsonb containment: matches any affected-goal entry carrying this id.
    add('o.affected_goals @> $#::jsonb', JSON.stringify([{ goalId: valid.affectedGoalId }]));
  }
  if (valid.originExecutionId !== null) {
    add('o.origin_execution_id = $#', valid.originExecutionId);
  }
  if (valid.search !== null) {
    // escaped substring match on the metric name — caller text is never a
    // wildcard pattern. The same placeholder is referenced twice ($n in
    // both arms), which SQL allows.
    params.push(escapeLike(valid.search));
    const placeholder = `$${params.length}`;
    conditions.push(`o.metric_name ILIKE '%' || ${placeholder} || '%' ESCAPE '\\'`);
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Newest definitions first (the management feed ordering); id breaks
  // ties deterministically.
  const rows = await getDb().query<ViewRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.recorded_at DESC, o.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapOutcome);
}

export async function getMeasurement(ctx: TenantContext, measurementId: string): Promise<OutcomeMeasurement> {
  assertLearningTenantContext(ctx);
  if (!isUuid(measurementId)) {
    throw new LearningError(
      'measurement_not_found',
      `measurement '${measurementId}' does not exist in this tenant`,
    );
  }

  const rows = await getDb().query<MeasurementRow>(
    `SELECT * FROM outcome_measurements WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, measurementId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new LearningError(
      'measurement_not_found',
      `measurement '${measurementId}' does not exist in this tenant`,
    );
  }
  return mapMeasurement(row);
}

export async function listMeasurements(
  ctx: TenantContext,
  query: ListMeasurementsQuery,
): Promise<OutcomeMeasurement[]> {
  assertLearningTenantContext(ctx);
  const valid = validateListMeasurementsQuery(query);

  const rows = await getDb().query<MeasurementRow>(
    `SELECT * FROM outcome_measurements
      WHERE tenant_id = $1 AND outcome_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, valid.outcomeId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such outcome in this tenant" from "outcome without
    // measurements" — a foreign-tenant outcome id reads the same as a
    // missing one either way; the explicit check keeps the error honest.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM outcomes WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.outcomeId],
    );
    if (exists.rows.length === 0) throw outcomeNotFound(valid.outcomeId);
  }
  return rows.rows.map(mapMeasurement);
}

// ---------------------------------------------------------------------------
// summarizeRealization — the expected-versus-realized rollup
// ---------------------------------------------------------------------------

/** Row shape of the GROUPING SETS rollup (per subject kind + the overall row). */
interface SummaryRow extends DbRow {
  subject_kind: string | null;
  total: number | string;
  open_count: number | string;
  settled_count: number | string;
  abandoned_count: number | string;
  settled_expected: number | string;
  settled_realized: number | string;
  net_variance: number | string;
  met_count: number | string;
  exceeded_count: number | string;
  missed_count: number | string;
}

function emptyBucket(): RealizationBucket {
  return {
    total: 0,
    open: 0,
    settled: 0,
    abandoned: 0,
    settledExpected: 0,
    settledRealized: 0,
    netVariance: 0,
    met: 0,
    exceeded: 0,
    missed: 0,
  };
}

function bucketOf(row: SummaryRow): RealizationBucket {
  return {
    total: toInt(row.total),
    open: toInt(row.open_count),
    settled: toInt(row.settled_count),
    abandoned: toInt(row.abandoned_count),
    settledExpected: toInt(row.settled_expected),
    settledRealized: toInt(row.settled_realized),
    netVariance: toInt(row.net_variance),
    met: toInt(row.met_count),
    exceeded: toInt(row.exceeded_count),
    missed: toInt(row.missed_count),
  };
}

/**
 * The expected-versus-realized rollup (W040's value surface): counts and
 * arithmetic sums over the derived current views, one bucket per subject
 * kind plus the overall aggregate. Sums are arithmetic over metric values
 * in the outcome's own unit — comparing across metrics is the caller's
 * interpretation, which is why buckets are per subject kind.
 */
export async function summarizeRealization(
  ctx: TenantContext,
  query: SummarizeRealizationQuery,
): Promise<RealizationSummary> {
  assertLearningTenantContext(ctx);
  const valid = validateSummarizeRealizationQuery(query);

  const conditions = ['o.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`o.subject_kind = $${params.length}`);
  }

  const rows = await getDb().query<SummaryRow>(
    `SELECT o.subject_kind,
       count(*)::int AS total,
       count(*) FILTER (WHERE r.id IS NULL)::int AS open_count,
       count(*) FILTER (WHERE r.disposition = 'settled')::int AS settled_count,
       count(*) FILTER (WHERE r.disposition = 'abandoned')::int AS abandoned_count,
       COALESCE(sum(o.expected) FILTER (WHERE r.disposition = 'settled'), 0) AS settled_expected,
       COALESCE(sum(r.realized_value) FILTER (WHERE r.disposition = 'settled'), 0) AS settled_realized,
       COALESCE(sum(r.variance_vs_expected) FILTER (WHERE r.disposition = 'settled'), 0) AS net_variance,
       count(*) FILTER (WHERE r.assessment = 'met')::int AS met_count,
       count(*) FILTER (WHERE r.assessment = 'exceeded')::int AS exceeded_count,
       count(*) FILTER (WHERE r.assessment = 'missed')::int AS missed_count
     FROM outcomes o
       LEFT JOIN outcome_realizations r
         ON r.outcome_id = o.id AND r.tenant_id = o.tenant_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY GROUPING SETS ((o.subject_kind), ())`,
    params,
  );

  let overall = emptyBucket();
  const bySubjectKind: RealizationSummary['bySubjectKind'] = {};
  for (const kind of OUTCOME_SUBJECT_KINDS) {
    if (valid.subjectKind === null || valid.subjectKind === kind) {
      bySubjectKind[kind] = emptyBucket();
    }
  }
  for (const row of rows.rows) {
    const bucket = bucketOf(row);
    if (row.subject_kind === null) {
      overall = bucket; // the GROUPING SETS () row aggregates everything
    } else {
      bySubjectKind[row.subject_kind as keyof typeof bySubjectKind] = bucket;
    }
  }

  return { overall, bySubjectKind };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// W053 — CompanyModel Learning (ADR-0016)
//
// The versioned CompanyModel: durable company-specific learning derived from
// evidence, outcomes and validated interactions. Two append-only tables
// (migrations/002-company-model.sql):
//
//   company_model_updates    — one row per RECORDED LEARNING UPDATE: the
//                              tenant-monotonic model_version, the required
//                              rationale ("what changed and why") and the
//                              acting party. ADR-0016's learning invariant
//                              and ADR-0019 make this the ONLY channel from
//                              completed evidence/outcomes to future
//                              behavior.
//   company_model_assertions — one row per LEARNED ASSERTION VERSION, every
//                              row carrying the ADR-mandated metadata:
//                              provenance (evidence refs and/or a
//                              tenant-scoped W040 outcome link — never
//                              free-floating), confidence, a validity
//                              interval and version metadata (per-chain
//                              version, supersedes link, owning update).
//
// Operations:
//   recordLearningUpdate — the ONE mutation: appends a change-set (new model
//      version) whose deltas each supersede the current head of their
//      (area, subject_key, topic) chain. No edit, no delete: superseded and
//      retracted versions remain as auditable history (lock 12), and the
//      current model is always "the highest version of each chain".
//   getCompanyModel — the derived effective view (current heads, active
//      now), optionally narrowed to areas and optionally including inactive
//      heads (pending/expired/retracted).
//   getCompanyModelAssertion / listCompanyModelAssertions — deep reads and
//      the audit trail over every version (status-filterable).
//   getLearningUpdate / listLearningUpdates — the recorded-learning-update
//      audit trail with its assertion deltas and linked outcomes.
//   rankCandidates — the application surface: applies the domain's learned
//      priors to caller-supplied, policy-vetted candidates through the pure
//      scoreCandidateSet (validation.ts). Learned preference NEVER overrides
//      explicit policy (lock 14): policy-excluded kinds always sink, policy
//      kind precedence is a hard sort key ahead of every learned score, and
//      the surface never adds or removes candidates.
//
// Concurrency: model versions are minted MAX+1 under UNIQUE (tenant_id,
// model_version); chain heads are locked FOR UPDATE and versions are unique
// per chain — a racing writer loses cleanly with `update_conflict` (the
// W040 outcome_conflict pattern).
//
// Provider independence (ADR-0016: learned state survives model/provider
// replacement): no provider/model identity exists anywhere in this surface
// — the store, the views and the scoring are provider-neutral by
// construction and live only in PostgreSQL (lock 35).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Row shape of `company_model_updates` (the recorded learning updates). */
interface CompanyModelUpdateRow extends DbRow {
  id: string;
  tenant_id: string;
  model_version: number | string;
  rationale: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of `company_model_assertions` (the learned assertion versions). */
interface CompanyModelAssertionRow extends DbRow {
  id: string;
  tenant_id: string;
  area: string;
  subject_kind: string;
  subject_key: string;
  subject_label: string | null;
  topic: string;
  statement: unknown;
  confidence: number;
  disposition: string;
  valid_from: Date | string;
  valid_until: Date | string | null;
  version: number;
  supersedes_id: string | null;
  update_id: string;
  evidence: unknown;
  outcome_id: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of the assertion current-view join (assertion ⊕ its update ⊕ superseded flag). */
interface AssertionViewRow extends CompanyModelAssertionRow {
  model_version: number | string;
  update_rationale: string;
  update_actor_kind: string;
  update_actor_id: string | null;
  update_actor_label: string | null;
  update_recorded_by_principal: string;
  update_recorded_at: Date | string;
  is_superseded: boolean;
}

/** The correlated "a newer version exists in this chain" subquery over alias `a`. */
const NEWER_VERSION_EXISTS = `EXISTS (
      SELECT 1 FROM company_model_assertions b
       WHERE b.tenant_id = a.tenant_id AND b.area = a.area
         AND b.subject_key = a.subject_key AND b.topic = a.topic
         AND b.version > a.version
    )`;

const ASSERTION_VIEW_COLUMNS = `SELECT
    a.id, a.tenant_id, a.area, a.subject_kind, a.subject_key, a.subject_label,
    a.topic, a.statement, a.confidence, a.disposition, a.valid_from, a.valid_until,
    a.version, a.supersedes_id, a.update_id, a.evidence, a.outcome_id,
    a.recorded_by_principal, a.recorded_at,
    u.model_version, u.rationale AS update_rationale,
    u.actor_kind AS update_actor_kind, u.actor_id AS update_actor_id,
    u.actor_label AS update_actor_label,
    u.recorded_by_principal AS update_recorded_by_principal,
    u.recorded_at AS update_recorded_at,
    ${NEWER_VERSION_EXISTS} AS is_superseded`;

const ASSERTION_VIEW_FROM = `FROM company_model_assertions a
  JOIN company_model_updates u
    ON u.id = a.update_id AND u.tenant_id = a.tenant_id`;

function assertionNotFound(assertionId: string): LearningError {
  return new LearningError(
    'assertion_not_found',
    `company model assertion '${assertionId}' does not exist in this tenant`,
  );
}

function learningUpdateNotFound(updateId: string): LearningError {
  return new LearningError(
    'learning_update_not_found',
    `learning update '${updateId}' does not exist in this tenant`,
  );
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapProvenance(value: unknown): AssertionProvenanceRef[] {
  return Array.isArray(value) ? (value as AssertionProvenanceRef[]) : [];
}

/**
 * The DERIVED lifecycle status of one assertion version at `nowIso` (never
 * stored): 'superseded' when a newer version exists in the chain, else
 * disposition + validity decide ('retracted' / 'pending' / 'expired' /
 * 'active'). Active means: asserted and [validFrom, validUntil) covers now.
 */
function deriveAssertionStatus(
  row: Pick<AssertionViewRow, 'disposition' | 'valid_from' | 'valid_until' | 'is_superseded'>,
  nowIso: string,
): CompanyModelAssertionStatus {
  if (row.is_superseded) return 'superseded';
  if (row.disposition === 'retracted') return 'retracted';
  const from = toIso(row.valid_from);
  const until = row.valid_until === null ? null : toIso(row.valid_until);
  if (from > nowIso) return 'pending';
  if (until !== null && until <= nowIso) return 'expired';
  return 'active';
}

/** Assembles the full learned-assertion view (assertion ⊕ change metadata). */
function mapAssertion(row: AssertionViewRow, nowIso: string): CompanyModelAssertion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    area: row.area as CompanyModelArea, // CHECK-constrained by migration 002
    subject: {
      kind: row.subject_kind as CompanyModelAssertion['subject']['kind'], // CHECK-constrained
      key: row.subject_key,
      label: row.subject_label,
    },
    topic: row.topic,
    statement: (typeof row.statement === 'object' && row.statement !== null
      ? row.statement
      : {}) as Record<string, unknown>,
    confidence: row.confidence,
    disposition: row.disposition as AssertionDisposition, // CHECK-constrained
    status: deriveAssertionStatus(row, nowIso),
    validFrom: toIso(row.valid_from),
    validUntil: row.valid_until === null ? null : toIso(row.valid_until),
    version: row.version,
    supersedesId: row.supersedes_id,
    updateId: row.update_id,
    provenance: {
      evidence: mapProvenance(row.evidence),
      outcomeId: row.outcome_id,
    },
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
    change: {
      updateId: row.update_id,
      modelVersion: toInt(row.model_version),
      rationale: row.update_rationale,
      actor: {
        kind: row.update_actor_kind as OutcomeActor['kind'], // CHECK-constrained
        id: row.update_actor_id,
        label: row.update_actor_label,
      },
      changedByPrincipal: row.update_recorded_by_principal,
      recordedAt: toIso(row.update_recorded_at),
    },
  };
}

/** Assembles the recorded-learning-update view from its row + assertion rows. */
function assembleUpdate(updateRow: CompanyModelUpdateRow, assertionRows: CompanyModelAssertionRow[]): LearningUpdate {
  const own = assertionRows
    .filter((row) => row.update_id === updateRow.id)
    .sort((x, y) =>
      `${x.area}|${x.subject_key}|${x.topic}`.localeCompare(`${y.area}|${y.subject_key}|${y.topic}`),
    );
  return {
    id: updateRow.id,
    tenantId: updateRow.tenant_id,
    modelVersion: toInt(updateRow.model_version),
    rationale: updateRow.rationale,
    actor: mapActor(updateRow),
    recordedByPrincipal: updateRow.recorded_by_principal,
    recordedAt: toIso(updateRow.recorded_at),
    changes: own.map((row) => ({
      assertionId: row.id,
      area: row.area as CompanyModelArea, // CHECK-constrained
      subject: {
        kind: row.subject_kind as CompanyModelAssertion['subject']['kind'], // CHECK-constrained
        key: row.subject_key,
        label: row.subject_label,
      },
      topic: row.topic,
      version: row.version,
      disposition: row.disposition as AssertionDisposition, // CHECK-constrained
    })),
    linkedOutcomeIds: [...new Set(own.filter((row) => row.outcome_id !== null).map((row) => row.outcome_id!))],
  };
}

/** The tenant's current CompanyModel version (0 when nothing is learned yet). */
async function currentModelVersion(ctx: TenantContext): Promise<number> {
  const rows = await getDb().query<{ model_version: number | string }>(
    `SELECT COALESCE(MAX(model_version), 0)::int AS model_version
       FROM company_model_updates WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  return toInt(rows.rows[0]!.model_version);
}

// ---------------------------------------------------------------------------
// recordLearningUpdate — the ONE CompanyModel mutation
// ---------------------------------------------------------------------------

export async function recordLearningUpdate(
  ctx: TenantContext,
  input: RecordLearningUpdateInput,
): Promise<LearningUpdate> {
  assertLearningTenantContext(ctx);
  const valid = validateRecordLearningUpdateInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Provenance gate (same module as W040's outcomes — direct tenant-scoped
    // existence check): every linked outcome must exist in THIS tenant;
    // missing, malformed and foreign-tenant ids are uniformly
    // `invalid_outcome_ref` (no existence leak).
    for (const change of valid.changes) {
      if (change.outcomeId === null) continue;
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM outcomes WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, change.outcomeId],
      );
      if (found.rows.length === 0) {
        throw new LearningError(
          'invalid_outcome_ref',
          `outcome '${change.outcomeId}' is not available in this tenant to this principal`,
        );
      }
    }

    // Mint the next tenant-monotonic model version. The UNIQUE
    // (tenant_id, model_version) constraint is the concurrency backstop:
    // a racing update that committed this version first loses cleanly.
    let updateRow: CompanyModelUpdateRow;
    try {
      const inserted = await tx.query<CompanyModelUpdateRow>(
        `INSERT INTO company_model_updates (
           tenant_id, model_version, rationale,
           actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
         ) VALUES (
           $1,
           (SELECT COALESCE(MAX(u.model_version), 0) + 1
              FROM company_model_updates u WHERE u.tenant_id = $1),
           $2, $3, $4, $5, $6, $7::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          valid.rationale,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
      updateRow = inserted.rows[0]!;
    } catch (error) {
      if (isDuplicateKeyOn(error, 'company_model_updates')) {
        throw new LearningError(
          'update_conflict',
          'a concurrent learning update advanced the company model; re-read the model and retry',
        );
      }
      throw error;
    }

    // Append each delta as a NEW version of its chain: lock the current
    // head (concurrent writers on the same chain serialize here), then
    // insert version+1 superseding it. First versions supersede nothing.
    const insertedAssertions: CompanyModelAssertionRow[] = [];
    for (const change of valid.changes) {
      const head = await tx.query<{ id: string; version: number }>(
        `SELECT id, version FROM company_model_assertions
          WHERE tenant_id = $1 AND area = $2 AND subject_key = $3 AND topic = $4
          ORDER BY version DESC
          LIMIT 1
          FOR UPDATE`,
        [ctx.tenantId, change.area, change.subject.key, change.topic],
      );
      const previous = head.rows[0] ?? null;
      const validFrom = change.validFrom ?? recordedAt.toISOString();

      let assertion: DbResult<CompanyModelAssertionRow>;
      try {
        assertion = await tx.query<CompanyModelAssertionRow>(
          `INSERT INTO company_model_assertions (
             tenant_id, area, subject_kind, subject_key, subject_label, topic,
             statement, confidence, disposition, valid_from, valid_until,
             version, supersedes_id, update_id, evidence, outcome_id,
             recorded_by_principal, recorded_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7::jsonb, $8, $9, $10::timestamptz, $11::timestamptz,
             $12, $13, $14, $15::jsonb, $16,
             $17, $18::timestamptz
           ) RETURNING *`,
          [
            ctx.tenantId,
            change.area,
            change.subject.kind,
            change.subject.key,
            change.subject.label,
            change.topic,
            JSON.stringify(change.statement),
            change.confidence,
            change.disposition,
            validFrom,
            change.validUntil,
            previous === null ? 1 : previous.version + 1,
            previous === null ? null : previous.id,
            updateRow.id,
            JSON.stringify(change.evidence),
            change.outcomeId,
            ctx.principalId,
            recordedAt,
          ],
        );
      } catch (error) {
        if (isDuplicateKeyOn(error, 'company_model_assertions')) {
          throw new LearningError(
            'update_conflict',
            'a concurrent learning update changed the same assertion chain; re-read the model and retry',
          );
        }
        throw error;
      }
      insertedAssertions.push(assertion.rows[0]!);
    }

    return assembleUpdate(updateRow, insertedAssertions);
  });
}

// ---------------------------------------------------------------------------
// getCompanyModel — the derived effective view
// ---------------------------------------------------------------------------

export async function getCompanyModel(
  ctx: TenantContext,
  query: GetCompanyModelQuery = {},
): Promise<CompanyModel> {
  assertLearningTenantContext(ctx);
  const valid = validateGetCompanyModelQuery(query);
  const nowIso = now().toISOString();

  const params: unknown[] = [ctx.tenantId];
  let areaFilter = '';
  if (valid.areas !== null) {
    const placeholders = valid.areas.map((_, index) => `$${index + 2}`).join(', ');
    areaFilter = ` AND a.area IN (${placeholders})`;
    params.push(...valid.areas);
  }

  // Current chain heads only (NOT EXISTS a newer version in the chain);
  // the effective/active filter is derived afterwards (status is never
  // stored, and "now" comes from the injectable clock).
  const rows = await getDb().query<AssertionViewRow>(
    `${ASSERTION_VIEW_COLUMNS} ${ASSERTION_VIEW_FROM}
      WHERE a.tenant_id = $1${areaFilter}
        AND NOT ${NEWER_VERSION_EXISTS}
      ORDER BY a.area, a.subject_key, a.topic`,
    params,
  );

  const assertions = rows.rows
    .map((row) => mapAssertion(row, nowIso))
    .filter((assertion) => valid.includeInactive || assertion.status === 'active');

  const modelVersion = await currentModelVersion(ctx);
  const areas = [...new Set(assertions.map((assertion) => assertion.area))];

  return {
    tenantId: ctx.tenantId,
    modelVersion,
    assertionCount: assertions.length,
    areas,
    assertions,
    generatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Assertion reads — deep link + audit trail
// ---------------------------------------------------------------------------

export async function getCompanyModelAssertion(
  ctx: TenantContext,
  assertionId: string,
): Promise<CompanyModelAssertion> {
  assertLearningTenantContext(ctx);
  if (!isUuid(assertionId)) throw assertionNotFound(assertionId);
  const nowIso = now().toISOString();

  const rows = await getDb().query<AssertionViewRow>(
    `${ASSERTION_VIEW_COLUMNS} ${ASSERTION_VIEW_FROM}
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [ctx.tenantId, assertionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw assertionNotFound(assertionId);
  return mapAssertion(row, nowIso);
}

export async function listCompanyModelAssertions(
  ctx: TenantContext,
  query: ListCompanyAssertionsQuery,
): Promise<CompanyModelAssertion[]> {
  assertLearningTenantContext(ctx);
  const valid = validateListCompanyAssertionsQuery(query);
  const nowIso = now().toISOString();

  const conditions: string[] = ['a.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.area !== null) add('a.area = $#', valid.area);
  if (valid.subjectKind !== null) add('a.subject_kind = $#', valid.subjectKind);
  if (valid.subjectKey !== null) add('a.subject_key = $#', valid.subjectKey);
  if (valid.topic !== null) add('a.topic = $#', valid.topic);
  if (valid.outcomeId !== null) add('a.outcome_id = $#', valid.outcomeId);
  if (valid.updateId !== null) add('a.update_id = $#', valid.updateId);
  if (valid.search !== null) {
    // escaped substring on topic or subject label — caller text is never a
    // wildcard pattern; the same placeholder is referenced twice.
    params.push(escapeLike(valid.search));
    const placeholder = `$${params.length}`;
    conditions.push(
      `(a.topic ILIKE '%' || ${placeholder} || '%' ESCAPE '\\' OR a.subject_label ILIKE '%' || ${placeholder} || '%' ESCAPE '\\')`,
    );
  }
  if (valid.status !== null) {
    // Status is derived from the chain + disposition + validity; the SQL
    // mirrors the TS derivation (deriveAssertionStatus) so LIMIT applies
    // to exactly the requested status.
    if (valid.status === 'superseded') {
      conditions.push(NEWER_VERSION_EXISTS);
    } else {
      conditions.push(`NOT ${NEWER_VERSION_EXISTS}`);
      if (valid.status === 'retracted') {
        conditions.push(`a.disposition = 'retracted'`);
      } else {
        conditions.push(`a.disposition = 'asserted'`);
        params.push(nowIso);
        const placeholder = `$${params.length}::timestamptz`;
        if (valid.status === 'active') {
          conditions.push(`a.valid_from <= ${placeholder} AND (a.valid_until IS NULL OR a.valid_until > ${placeholder})`);
        } else if (valid.status === 'pending') {
          conditions.push(`a.valid_from > ${placeholder}`);
        } else {
          conditions.push(`a.valid_until IS NOT NULL AND a.valid_until <= ${placeholder}`);
        }
      }
    }
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<AssertionViewRow>(
    `${ASSERTION_VIEW_COLUMNS} ${ASSERTION_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.recorded_at DESC, a.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapAssertion(row, nowIso));
}

// ---------------------------------------------------------------------------
// Learning-update reads — the recorded-update audit trail
// ---------------------------------------------------------------------------

export async function getLearningUpdate(ctx: TenantContext, updateId: string): Promise<LearningUpdate> {
  assertLearningTenantContext(ctx);
  if (!isUuid(updateId)) throw learningUpdateNotFound(updateId);

  const updates = await getDb().query<CompanyModelUpdateRow>(
    `SELECT * FROM company_model_updates WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, updateId],
  );
  const updateRow = updates.rows[0];
  if (updateRow === undefined) throw learningUpdateNotFound(updateId);

  const assertions = await getDb().query<CompanyModelAssertionRow>(
    `SELECT * FROM company_model_assertions WHERE tenant_id = $1 AND update_id = $2`,
    [ctx.tenantId, updateId],
  );
  return assembleUpdate(updateRow, assertions.rows);
}

export async function listLearningUpdates(
  ctx: TenantContext,
  query: ListLearningUpdatesQuery,
): Promise<LearningUpdate[]> {
  assertLearningTenantContext(ctx);
  const valid = validateListLearningUpdatesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.search !== null) {
    params.push(escapeLike(valid.search));
    const placeholder = `$${params.length}`;
    conditions.push(`rationale ILIKE '%' || ${placeholder} || '%' ESCAPE '\\'`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const updates = await getDb().query<CompanyModelUpdateRow>(
    `SELECT * FROM company_model_updates
      WHERE ${conditions.join(' AND ')}
      ORDER BY model_version DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  if (updates.rows.length === 0) return [];

  // The deltas of every listed update, in one query (≤ MAX_LIST_LIMIT ids).
  const updateIds = updates.rows.map((row) => row.id);
  const idPlaceholders = updateIds.map((_, index) => `$${index + 2}`).join(', ');
  const assertions = await getDb().query<CompanyModelAssertionRow>(
    `SELECT * FROM company_model_assertions
      WHERE tenant_id = $1 AND update_id IN (${idPlaceholders})`,
    [ctx.tenantId, ...updateIds],
  );

  return updates.rows.map((row) => assembleUpdate(row, assertions.rows));
}

// ---------------------------------------------------------------------------
// rankCandidates — the application surface (learned priors, policy-bound)
// ---------------------------------------------------------------------------

export async function rankCandidates(
  ctx: TenantContext,
  input: RankCandidatesInput,
): Promise<CompanyModelRanking> {
  assertLearningTenantContext(ctx);
  const valid = validateRankCandidatesInput(input);
  const family = RANK_DOMAIN_FAMILIES[valid.domain];
  const nowIso = now().toISOString();

  const modelVersion = await currentModelVersion(ctx);

  // The current active heads of the domain's canonical family, narrowed to
  // the candidate keys — nothing else can influence the ordering.
  const keys = valid.candidates.map((candidate) => candidate.key);
  const keyPlaceholders = keys.map((_, index) => `$${index + 4}`).join(', ');
  const nowPlaceholder = `$${keys.length + 4}::timestamptz`;
  const rows = await getDb().query<CompanyModelAssertionRow>(
    `SELECT a.* FROM company_model_assertions a
      WHERE a.tenant_id = $1 AND a.area = $2 AND a.topic = $3
        AND a.subject_key IN (${keyPlaceholders})
        AND a.disposition = 'asserted'
        AND a.valid_from <= ${nowPlaceholder}
        AND (a.valid_until IS NULL OR a.valid_until > ${nowPlaceholder})
        AND NOT ${NEWER_VERSION_EXISTS}`,
    [ctx.tenantId, family.area, family.topic, ...keys, nowIso],
  );

  const scoreable: ScoreableAssertion[] = rows.rows.map((row) => ({
    id: row.id,
    area: row.area as CompanyModelArea, // CHECK-constrained
    subjectKey: row.subject_key,
    topic: row.topic,
    statement: (typeof row.statement === 'object' && row.statement !== null
      ? row.statement
      : {}) as Record<string, unknown>,
    confidence: row.confidence,
    disposition: row.disposition as AssertionDisposition, // CHECK-constrained
    validFrom: toIso(row.valid_from),
    validUntil: row.valid_until === null ? null : toIso(row.valid_until),
    version: row.version,
  }));

  // The single deterministic definition (validation.ts): learned priors
  // blend into the base score by confidence, explicit policy stays
  // authoritative, and every applied prior carries its attribution.
  const ordered = scoreCandidateSet(scoreable, valid, nowIso);
  const candidates: RankedCandidate[] = ordered.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));

  return { modelVersion, domain: valid.domain, candidates };
}
