// Implementation of the learning module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`outcome_not_found` / `measurement_not_found` /
// `learning_not_found` / `learning_version_not_found`), on reads AND on
// writes (measuring, settling, abandoning, recording feedback for or
// appending to a foreign-tenant id read the same as a missing one).
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
//
// W041 acceptance (company learning) is carried by these deliberate
// properties, all tested:
//   1. VERSIONED: `company_learnings` holds one immutable chain head per
//      (tenant, target, aspect) — the company-specific subject — and
//      `company_learning_versions` holds the append-only version rows.
//      Every feedback event appends ONE version under a FOR UPDATE lock on
//      the head (version numbers are 1-based, monotonic, UNIQUE per
//      chain); nothing is ever rewritten, so "what changed" is always the
//      retained previous version and "why" the required reason
//      (ADR-0016's learning invariant). PostgreSQL rejects
//      UPDATE/DELETE/TRUNCATE on both tables via migration 002 triggers.
//   2. THREE FEEDBACK LEGS: explicit (a statement), behavioral (observed
//      behavior — requires ≥1 evidence reference) and outcome (grounded in
//      a SETTLED W040 outcome of the same tenant, its frozen assessment
//      snapshotted onto the version — the W040 → W041 dependency made
//      behavioral: ADR-0016 "A completed project or intervention may
//      improve future behavior only through a recorded learning update
//      linked to evidence and outcome").
//   3. POLICY NON-AUTHORITY (the item's "without mutating policy silently",
//      lock 14): the read model mints `authoritative: false` on every
//      version — there is no input field that could set it (validation
//      rejects unknown keys), no operation here touches any policy
//      surface, and versions are append-only, so a learned preference can
//      never silently override or mutate policy. Consumers must defer to
//      explicit policy.
//   4. TENANT-COMPANY-SPECIFIC: the chain key includes tenant_id — the
//      same target+aspect in two tenants is two independent chains.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, CognitionError } from '@/modules/cognition/contract';
import { LearningError } from './errors';
import {
  assertLearningTenantContext,
  assessRealization,
  deriveLearningStatus,
  escapeLike,
  isUuid,
  OUTCOME_SUBJECT_KINDS,
  validateAbandonOutcomeInput,
  validateDefineOutcomeInput,
  validateListCompanyLearningsQuery,
  validateListCompanyLearningVersionsQuery,
  validateListMeasurementsQuery,
  validateListOutcomesQuery,
  validateRecordCompanyLearningInput,
  validateRecordMeasurementInput,
  validateSettleOutcomeInput,
  validateSummarizeRealizationQuery,
  type ValidatedDefineInput,
} from './validation';
import type {
  AbandonOutcomeInput,
  CompanyLearning,
  CompanyLearningVersion,
  DefineOutcomeInput,
  ListCompanyLearningsQuery,
  ListCompanyLearningVersionsQuery,
  ListMeasurementsQuery,
  ListOutcomesQuery,
  LearningFeedbackChannel,
  LearningTarget,
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
  RecordCompanyLearningInput,
  RecordMeasurementInput,
  RealizationBucket,
  RealizationSummary,
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
// W041 — Company Learning (versioned usefulness/preferences)
// ---------------------------------------------------------------------------

/** Row shape of `company_learnings` (the immutable chain head). */
interface CompanyLearningRow extends DbRow {
  id: string;
  tenant_id: string;
  target_kind: string;
  target_id: string;
  target_label: string | null;
  aspect: string;
  created_at: Date | string;
}

/** Row shape of `company_learning_versions` (the append-only version rows). */
interface LearningVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  company_learning_id: string;
  version: number | string;
  channel: string;
  value: unknown;
  confidence: number;
  evidence: unknown;
  outcome_id: string | null;
  outcome_assessment: string | null;
  reason: string;
  valid_from: Date | string;
  valid_until: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of the derived chain-view join (head ⊕ current ⊕ previous ⊕ count). */
interface LearningViewRow extends DbRow {
  id: string;
  tenant_id: string;
  target_kind: string;
  target_id: string;
  target_label: string | null;
  aspect: string;
  created_at: Date | string;
  version_count: number | string;
}

// The derived chain view, shared by getCompanyLearning, listCompanyLearnings
// and recordCompanyLearning's return assembly. The two LATERAL joins pick
// the current version (max version) and the one it superseded,
// deterministically; the scalar subquery counts the chain.
const LEARNING_VIEW_FROM = `FROM company_learnings cl
  LEFT JOIN LATERAL (
    SELECT v.* FROM company_learning_versions v
      WHERE v.tenant_id = cl.tenant_id AND v.company_learning_id = cl.id
      ORDER BY v.version DESC LIMIT 1
  ) cv ON true
  LEFT JOIN LATERAL (
    SELECT v.* FROM company_learning_versions v
      WHERE v.tenant_id = cl.tenant_id AND v.company_learning_id = cl.id
      ORDER BY v.version DESC OFFSET 1 LIMIT 1
  ) pv ON true`;

const LEARNING_VIEW_COLUMNS = `SELECT
    cl.id, cl.tenant_id, cl.target_kind, cl.target_id, cl.target_label,
    cl.aspect, cl.created_at,
    (SELECT count(*)::int FROM company_learning_versions v
       WHERE v.tenant_id = cl.tenant_id AND v.company_learning_id = cl.id) AS version_count,
    cv.id AS cur_id, cv.company_learning_id AS cur_learning_id, cv.version AS cur_version,
    cv.channel AS cur_channel, cv.value AS cur_value, cv.confidence AS cur_confidence,
    cv.evidence AS cur_evidence, cv.outcome_id AS cur_outcome_id,
    cv.outcome_assessment AS cur_outcome_assessment, cv.reason AS cur_reason,
    cv.valid_from AS cur_valid_from, cv.valid_until AS cur_valid_until,
    cv.actor_kind AS cur_actor_kind, cv.actor_id AS cur_actor_id, cv.actor_label AS cur_actor_label,
    cv.recorded_by_principal AS cur_recorded_by_principal, cv.recorded_at AS cur_recorded_at,
    pv.id AS prev_id, pv.company_learning_id AS prev_learning_id, pv.version AS prev_version,
    pv.channel AS prev_channel, pv.value AS prev_value, pv.confidence AS prev_confidence,
    pv.evidence AS prev_evidence, pv.outcome_id AS prev_outcome_id,
    pv.outcome_assessment AS prev_outcome_assessment, pv.reason AS prev_reason,
    pv.valid_from AS prev_valid_from, pv.valid_until AS prev_valid_until,
    pv.actor_kind AS prev_actor_kind, pv.actor_id AS prev_actor_id, pv.actor_label AS prev_actor_label,
    pv.recorded_by_principal AS prev_recorded_by_principal, pv.recorded_at AS prev_recorded_at`;

function learningNotFound(learningId: string): LearningError {
  return new LearningError('learning_not_found', `company learning '${learningId}' does not exist in this tenant`);
}

function learningVersionNotFound(versionId: string): LearningError {
  return new LearningError(
    'learning_version_not_found',
    `company learning version '${versionId}' does not exist in this tenant`,
  );
}

/**
 * Maps one version row. `isCurrent` is DERIVED (the caller knows whether
 * this row is the chain's maximum version) — never stored. The
 * `authoritative: false` constant is minted here (lock 14, ADR-0016): a
 * learned assertion is never authoritative, and no input can forge it.
 */
function mapLearningVersion(row: LearningVersionRow, isCurrent: boolean): CompanyLearningVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    learningId: row.company_learning_id,
    version: toInt(row.version),
    isCurrent,
    channel: row.channel as LearningFeedbackChannel, // CHECK-constrained by migration 002
    value: row.value,
    confidence: row.confidence,
    evidence: mapEvidence(row.evidence),
    outcomeId: row.outcome_id,
    outcomeAssessment: row.outcome_assessment as OutcomeAssessment | null, // CHECK-constrained
    reason: row.reason,
    validFrom: toIso(row.valid_from),
    validUntil: row.valid_until,
    actor: mapActor(row),
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
    authoritative: false,
  };
}

/** Projects the `cur_`/`prev_` columns of a view-join row into a version row shape. */
function prefixedVersion(row: LearningViewRow, prefix: 'cur' | 'prev'): LearningVersionRow | null {
  const id = row[`${prefix}_id`];
  if (id === null || id === undefined) return null;
  return {
    id: id as string,
    tenant_id: row.tenant_id,
    company_learning_id: row[`${prefix}_learning_id`] as string,
    version: row[`${prefix}_version`] as number | string,
    channel: row[`${prefix}_channel`] as string,
    value: row[`${prefix}_value`],
    confidence: row[`${prefix}_confidence`] as number,
    evidence: row[`${prefix}_evidence`],
    outcome_id: row[`${prefix}_outcome_id`] as string | null,
    outcome_assessment: row[`${prefix}_outcome_assessment`] as string | null,
    reason: row[`${prefix}_reason`] as string,
    valid_from: row[`${prefix}_valid_from`] as Date | string,
    valid_until: row[`${prefix}_valid_until`] as string | null,
    actor_kind: row[`${prefix}_actor_kind`] as string,
    actor_id: row[`${prefix}_actor_id`] as string | null,
    actor_label: row[`${prefix}_actor_label`] as string | null,
    recorded_by_principal: row[`${prefix}_recorded_by_principal`] as string,
    recorded_at: row[`${prefix}_recorded_at`] as Date | string,
  };
}

/** Assembles the derived chain view: current + previous version, derived validity. */
function mapCompanyLearning(row: LearningViewRow): CompanyLearning {
  const current = prefixedVersion(row, 'cur')!;
  const previous = prefixedVersion(row, 'prev');
  const currentVersion = mapLearningVersion(current, true);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    target: {
      kind: row.target_kind as LearningTarget['kind'], // CHECK-constrained
      id: row.target_id,
      label: row.target_label,
    },
    aspect: row.aspect,
    status: deriveLearningStatus(currentVersion.validUntil, now()),
    versionCount: toInt(row.version_count),
    currentVersion,
    previousVersion: previous === null ? null : mapLearningVersion(previous, false),
    createdAt: toIso(row.created_at),
    lastUpdatedAt: currentVersion.recordedAt,
  };
}

/** The chain's maximum version number (0 when the chain has no versions — never the case in practice). */
async function chainMaxVersion(ctx: TenantContext, learningId: string): Promise<number> {
  const rows = await getDb().query<{ max: number | string | null }>(
    `SELECT max(version) AS max FROM company_learning_versions
       WHERE tenant_id = $1 AND company_learning_id = $2`,
    [ctx.tenantId, learningId],
  );
  const max = rows.rows[0]?.max;
  return max === null || max === undefined ? 0 : toInt(max);
}

// ---------------------------------------------------------------------------
// recordCompanyLearning — one feedback event → one appended version
// ---------------------------------------------------------------------------

export async function recordCompanyLearning(
  ctx: TenantContext,
  input: RecordCompanyLearningInput,
): Promise<{ learning: CompanyLearning; version: CompanyLearningVersion }> {
  assertLearningTenantContext(ctx);
  const valid = validateRecordCompanyLearningInput(input);
  const recordedAt = now();

  // A validity window cannot be born elapsed: the pure validation checked
  // the calendar shape; the elapsed comparison needs the service clock.
  if (valid.validUntil !== null && valid.validUntil < recordedAt.toISOString().slice(0, 10)) {
    throw new LearningError(
      'invalid_learning_input',
      `validUntil '${valid.validUntil}' is already in the past — a learned assertion cannot be born expired`,
    );
  }

  // Outcome feedback is grounded in a SETTLED outcome of THIS tenant (the
  // W040 → W041 dependency made behavioral; ADR-0016: a learning update is
  // "linked to evidence and outcome"). Missing and foreign-tenant outcome
  // ids are uniformly `outcome_not_found` — no existence leak. No lock is
  // taken: a settled realization is terminal and immutable, so the read
  // can never flip.
  let outcomeAssessment: OutcomeAssessment | null = null;
  if (valid.channel === 'outcome') {
    const outcomeId = valid.outcomeId!;
    const rows = await getDb().query<{ disposition: string | null; assessment: string | null }>(
      `SELECT r.disposition, r.assessment
         FROM outcomes o
         LEFT JOIN outcome_realizations r
           ON r.outcome_id = o.id AND r.tenant_id = o.tenant_id
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [ctx.tenantId, outcomeId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw outcomeNotFound(outcomeId);
    if (row.disposition !== 'settled') {
      throw new LearningError(
        'invalid_outcome_ref',
        `outcome '${outcomeId}' is ${row.disposition ?? 'open'} — outcome feedback requires a settled (realized) outcome`,
      );
    }
    outcomeAssessment = row.assessment as OutcomeAssessment; // CHECK-constrained
  }

  return getDb().transaction(async (tx) => {
    // Ensure the chain head exists (first write wins on the label), then
    // lock it: version numbering serializes on this row, so concurrent
    // feedback for the same (tenant, target, aspect) appends strictly
    // after this version — a chain is one company-specific subject.
    await tx.query(
      `INSERT INTO company_learnings (
         tenant_id, target_kind, target_id, target_label, aspect, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (tenant_id, target_kind, target_id, aspect) DO NOTHING`,
      [ctx.tenantId, valid.target.kind, valid.target.id, valid.target.label, valid.aspect, recordedAt],
    );
    const headRows = await tx.query<CompanyLearningRow>(
      `SELECT * FROM company_learnings
        WHERE tenant_id = $1 AND target_kind = $2 AND target_id = $3 AND aspect = $4
        FOR UPDATE`,
      [ctx.tenantId, valid.target.kind, valid.target.id, valid.aspect],
    );
    const head = headRows.rows[0]!;

    const nextRows = await tx.query<{ next: number | string }>(
      `SELECT COALESCE(max(version), 0) + 1 AS next FROM company_learning_versions
        WHERE tenant_id = $1 AND company_learning_id = $2`,
      [ctx.tenantId, head.id],
    );
    const nextVersion = toInt(nextRows.rows[0]!.next);

    let inserted: DbResult<LearningVersionRow>;
    try {
      inserted = await tx.query<LearningVersionRow>(
        `INSERT INTO company_learning_versions (
           tenant_id, company_learning_id, version, channel,
           value, confidence, evidence, outcome_id, outcome_assessment,
           reason, valid_from, valid_until,
           actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
         ) VALUES (
           $1, $2, $3, $4,
           $5::jsonb, $6, $7::jsonb, $8, $9,
           $10, $11::timestamptz, $12,
           $13, $14, $15, $16, $17::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          head.id,
          nextVersion,
          valid.channel,
          JSON.stringify(valid.value),
          valid.confidence,
          JSON.stringify(valid.evidence),
          valid.outcomeId,
          outcomeAssessment,
          valid.reason,
          recordedAt,
          valid.validUntil,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'company_learning_versions')) {
        throw new LearningError(
          'learning_conflict',
          'a concurrent feedback event versioned this chain first; re-read the learning and retry',
        );
      }
      throw error;
    }

    // The just-appended version is the chain's maximum (the FOR UPDATE lock
    // guarantees it inside this transaction).
    const version = mapLearningVersion(inserted.rows[0]!, true);

    const viewRows = await tx.query<LearningViewRow>(
      `${LEARNING_VIEW_COLUMNS} ${LEARNING_VIEW_FROM}
        WHERE cl.tenant_id = $1 AND cl.id = $2`,
      [ctx.tenantId, head.id],
    );
    return { learning: mapCompanyLearning(viewRows.rows[0]!), version };
  });
}

// ---------------------------------------------------------------------------
// Company learning reads
// ---------------------------------------------------------------------------

export async function getCompanyLearning(
  ctx: TenantContext,
  learningId: string,
): Promise<CompanyLearning> {
  assertLearningTenantContext(ctx);
  if (!isUuid(learningId)) throw learningNotFound(learningId);

  const rows = await getDb().query<LearningViewRow>(
    `${LEARNING_VIEW_COLUMNS} ${LEARNING_VIEW_FROM}
      WHERE cl.tenant_id = $1 AND cl.id = $2`,
    [ctx.tenantId, learningId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw learningNotFound(learningId);
  return mapCompanyLearning(row);
}

export async function listCompanyLearnings(
  ctx: TenantContext,
  query: ListCompanyLearningsQuery,
): Promise<CompanyLearning[]> {
  assertLearningTenantContext(ctx);
  const valid = validateListCompanyLearningsQuery(query);

  const conditions: string[] = ['cl.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.targetKind !== null) add('cl.target_kind = $#', valid.targetKind);
  if (valid.targetId !== null) add('cl.target_id = $#', valid.targetId);
  if (valid.aspect !== null) add('cl.aspect = $#', valid.aspect);
  if (valid.channel !== null) add('cv.channel = $#', valid.channel);
  if (valid.validity !== null) {
    // Derived read-time validity, in lockstep with deriveLearningStatus:
    // active ⇔ valid_until is null or not before today (UTC); expired
    // otherwise. The comparison is chronological because ISO dates sort
    // lexicographically.
    const today = now().toISOString().slice(0, 10);
    if (valid.validity === 'active') {
      add('(cv.valid_until IS NULL OR cv.valid_until >= $#)', today);
    } else {
      add('(cv.valid_until IS NOT NULL AND cv.valid_until < $#)', today);
    }
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Most recently learned first (the "what changed lately" feed); the head
  // id breaks ties deterministically.
  const rows = await getDb().query<LearningViewRow>(
    `${LEARNING_VIEW_COLUMNS} ${LEARNING_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cv.recorded_at DESC, cl.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapCompanyLearning);
}

export async function getCompanyLearningVersion(
  ctx: TenantContext,
  versionId: string,
): Promise<CompanyLearningVersion> {
  assertLearningTenantContext(ctx);
  if (!isUuid(versionId)) throw learningVersionNotFound(versionId);

  const rows = await getDb().query<LearningVersionRow>(
    `SELECT * FROM company_learning_versions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, versionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw learningVersionNotFound(versionId);
  const max = await chainMaxVersion(ctx, row.company_learning_id);
  return mapLearningVersion(row, toInt(row.version) === max);
}

export async function listCompanyLearningVersions(
  ctx: TenantContext,
  query: ListCompanyLearningVersionsQuery,
): Promise<CompanyLearningVersion[]> {
  assertLearningTenantContext(ctx);
  const valid = validateListCompanyLearningVersionsQuery(query);

  // Distinguish "no such chain in this tenant" from "chain without
  // versions" — a foreign-tenant learning id reads the same as a missing
  // one either way; the explicit check keeps the error honest (the
  // listMeasurements precedent).
  const exists = await getDb().query<{ id: string }>(
    `SELECT id FROM company_learnings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.learningId],
  );
  if (exists.rows.length === 0) throw learningNotFound(valid.learningId);

  const rows = await getDb().query<LearningVersionRow>(
    `SELECT * FROM company_learning_versions
      WHERE tenant_id = $1 AND company_learning_id = $2
      ORDER BY version ASC, id ASC`,
    [ctx.tenantId, valid.learningId],
  );
  const last = rows.rows.at(-1);
  const max = last === undefined ? 0 : toInt(last.version);
  return rows.rows.map((row) => mapLearningVersion(row, toInt(row.version) === max));
}
