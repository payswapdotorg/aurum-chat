// Implementation of the contributions module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock
// and is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`contribution_not_found` /
// `validation_not_found`), on reads AND on writes (validating or
// measuring a foreign-tenant contribution id reads the same as a missing
// one).
//
// W042 acceptance is carried by these deliberate properties, all tested:
//   1. ANCHORED: every contribution is the answer of ONE answered
//      ask-person acquisition plan (W012), validated readable through the
//      knowledge-acquisition contract at write time (the sanctioned
//      W012 → W042 dependency). The contributing employee, the mission,
//      the targeted question, the answer's evidence observation and the
//      budget currency are DERIVED from that plan and minted by the
//      service — a caller can never forge the tie (UNIQUE (tenant_id,
//      plan_id): one contribution per acquisition).
//   2. VALIDATED: evidence-quality assessments form an append-only
//      series — revalidation is allowed, history is never rewritten and
//      contradictions are RETAINED (lock 12); the current validation is
//      the latest row. Validations may be appended even after the impact
//      was frozen.
//   3. MEASURED: the impact record (knowledge gain + mission impact +
//      affected goals + investigation-cost avoidance) is ONE per
//      contribution, first write wins, with the knowledge gain FROZEN by
//      the service (validation.ts `assessKnowledgeGain` — the single
//      deterministic definition) and the optional learning outcome (W040)
//      validated readable through the learning contract (the sanctioned
//      W040 → W042 dependency). Recording an impact requires at least one
//      validation first — §7's canonical order: assess evidence quality,
//      THEN update the mission.
//   4. APPEND-ONLY: there is no rewrite, no un-validate, no un-measure
//      and no delete anywhere; PostgreSQL itself rejects
//      UPDATE/DELETE/TRUNCATE on all three tables via migration 001
//      triggers.
//   5. ROLLUP: `summarizeContributions` aggregates the status ladder,
//      impact kinds, the total knowledge gain and the cost avoided PER
//      CURRENCY (money is never summed across currencies — the W012
//      convention), optionally narrowed to one contributing employee —
//      the surface W043 Rewards and W052 source ranking read.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getOutcome, LearningError } from '@/modules/learning/contract';
import {
  getAcquisitionPlan,
  KnowledgeAcquisitionError,
} from '@/modules/knowledge-acquisition/contract';
import { ContributionsError } from './errors';
import { assessKnowledgeGain } from './validation';
import {
  assertContributionsTenantContext,
  escapeLike,
  isUuid,
  validateListContributionsQuery,
  validateListValidationsQuery,
  validateRecordContributionInput,
  validateRecordImpactInput,
  validateSummarizeContributionsQuery,
  validateValidateContributionInput,
  type ValidatedImpactInput,
  type ValidatedRecordInput,
  type ValidatedValidationInput,
} from './validation';
import type {
  Contribution,
  ContributionActor,
  ContributionEvidenceRef,
  ContributionGoalRef,
  ContributionImpact,
  ContributionStatus,
  ContributionSummary,
  ContributionValidation,
  ContributionValidationOutcome,
  CostAvoidedBucket,
  ListContributionsQuery,
  ListValidationsQuery,
  MissionImpactKind,
  AvoidedPath,
  RecordContributionInput,
  RecordImpactInput,
  SummarizeContributionsQuery,
  ValidateContributionInput,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** Row shape of `contributions` (the immutable definition). */
interface ContributionRow extends DbRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  mission_id: string;
  evidence_observation_id: string;
  person_id: string;
  person_label: string | null;
  question: string;
  budget_currency: string;
  summary: string;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of `contribution_validations` (the append-only series). */
interface ValidationRow extends DbRow {
  id: string;
  tenant_id: string;
  contribution_id: string;
  outcome: string;
  quality: number;
  evidence: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of `contribution_impacts` (the frozen measured record). */
interface ImpactRow extends DbRow {
  id: string;
  tenant_id: string;
  contribution_id: string;
  mission_impact: string;
  confidence_before: number;
  confidence_after: number;
  knowledge_gain: number;
  affected_goals: unknown;
  avoided_cost: number | string;
  avoided_paths: unknown;
  outcome_id: string | null;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

/** Row shape of the derived current-view join (definition ⊕ latest validation ⊕ impact). */
interface ViewRow extends ContributionRow {
  validation_count: number | string;
  latest_validation_id: string | null;
  validation_outcome: string | null;
  validation_quality: number | null;
  validation_evidence: unknown;
  validation_note: string | null;
  validation_actor_kind: string | null;
  validation_actor_id: string | null;
  validation_actor_label: string | null;
  validation_recorded_by_principal: string | null;
  validation_recorded_at: Date | string | null;
  impact_id: string | null;
  mission_impact: string | null;
  confidence_before: number | null;
  confidence_after: number | null;
  knowledge_gain: number | null;
  affected_goals: unknown;
  avoided_cost: number | string | null;
  avoided_paths: unknown;
  outcome_id: string | null;
  impact_note: string | null;
  impact_actor_kind: string | null;
  impact_actor_id: string | null;
  impact_actor_label: string | null;
  impact_recorded_by_principal: string | null;
  impact_recorded_at: Date | string | null;
}

// The derived current view, shared by getContribution and
// listContributions. The LATERAL join picks the most recent validation
// deterministically (recorded_at DESC, id DESC); the scalar subquery
// counts the series.
const CURRENT_VIEW_FROM = `FROM contributions c
  LEFT JOIN contribution_impacts i
    ON i.contribution_id = c.id AND i.tenant_id = c.tenant_id
  LEFT JOIN LATERAL (
    SELECT v.* FROM contribution_validations v
     WHERE v.tenant_id = c.tenant_id AND v.contribution_id = c.id
     ORDER BY v.recorded_at DESC, v.id DESC
     LIMIT 1
  ) lv ON true`;

const CURRENT_VIEW_COLUMNS = `SELECT
    c.id, c.tenant_id, c.plan_id, c.mission_id, c.evidence_observation_id,
    c.person_id, c.person_label, c.question, c.budget_currency, c.summary,
    c.note, c.actor_kind, c.actor_id, c.actor_label,
    c.recorded_by_principal, c.recorded_at,
    (SELECT count(*)::int FROM contribution_validations v
       WHERE v.tenant_id = c.tenant_id AND v.contribution_id = c.id) AS validation_count,
    lv.id AS latest_validation_id, lv.outcome AS validation_outcome,
    lv.quality AS validation_quality, lv.evidence AS validation_evidence,
    lv.note AS validation_note, lv.actor_kind AS validation_actor_kind,
    lv.actor_id AS validation_actor_id, lv.actor_label AS validation_actor_label,
    lv.recorded_by_principal AS validation_recorded_by_principal,
    lv.recorded_at AS validation_recorded_at,
    i.id AS impact_id, i.mission_impact, i.confidence_before, i.confidence_after,
    i.knowledge_gain, i.affected_goals, i.avoided_cost, i.avoided_paths,
    i.outcome_id, i.note AS impact_note, i.actor_kind AS impact_actor_kind,
    i.actor_id AS impact_actor_id, i.actor_label AS impact_actor_label,
    i.recorded_by_principal AS impact_recorded_by_principal,
    i.recorded_at AS impact_recorded_at`;

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
}): ContributionActor {
  return {
    kind: row.actor_kind as ContributionActor['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapGoalRefs(value: unknown): ContributionGoalRef[] {
  return Array.isArray(value) ? (value as ContributionGoalRef[]) : [];
}

function mapEvidence(value: unknown): ContributionEvidenceRef[] {
  return Array.isArray(value) ? (value as ContributionEvidenceRef[]) : [];
}

function mapAvoidedPaths(value: unknown): AvoidedPath[] {
  return Array.isArray(value) ? (value as AvoidedPath[]) : [];
}

function mapValidation(row: ValidationRow): ContributionValidation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contributionId: row.contribution_id,
    outcome: row.outcome as ContributionValidationOutcome, // CHECK-constrained
    quality: row.quality,
    evidence: mapEvidence(row.evidence),
    note: row.note,
    actor: mapActor(row),
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

function contributionNotFound(contributionId: string): ContributionsError {
  return new ContributionsError(
    'contribution_not_found',
    `contribution '${contributionId}' does not exist in this tenant`,
  );
}

function validationNotFound(validationId: string): ContributionsError {
  return new ContributionsError(
    'validation_not_found',
    `contribution validation '${validationId}' does not exist in this tenant`,
  );
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
 * impact's existence (measured) or the latest validation's outcome, the
 * current validation, the frozen measured impact, and the validation-series
 * summary.
 */
function mapContribution(row: ViewRow): Contribution {
  const validation: ContributionValidation | null =
    row.latest_validation_id === null
      ? null
      : {
          id: row.latest_validation_id,
          tenantId: row.tenant_id,
          contributionId: row.id,
          outcome: row.validation_outcome as ContributionValidationOutcome, // CHECK-constrained
          quality: row.validation_quality!,
          evidence: mapEvidence(row.validation_evidence),
          note: row.validation_note,
          actor: {
            kind: row.validation_actor_kind as ContributionActor['kind'], // CHECK-constrained
            id: row.validation_actor_id,
            label: row.validation_actor_label,
          },
          recordedByPrincipal: row.validation_recorded_by_principal!,
          recordedAt: toIso(row.validation_recorded_at!),
        };

  const impact: ContributionImpact | null =
    row.impact_id === null
      ? null
      : {
          missionImpact: row.mission_impact as MissionImpactKind, // CHECK-constrained
          confidenceBefore: row.confidence_before!,
          confidenceAfter: row.confidence_after!,
          knowledgeGain: row.knowledge_gain!,
          affectedGoals: mapGoalRefs(row.affected_goals),
          avoidedCost: toInt(row.avoided_cost!),
          avoidedPaths: mapAvoidedPaths(row.avoided_paths),
          outcomeId: row.outcome_id,
          note: row.impact_note,
          actor: {
            kind: row.impact_actor_kind as ContributionActor['kind'], // CHECK-constrained
            id: row.impact_actor_id,
            label: row.impact_actor_label,
          },
          recordedByPrincipal: row.impact_recorded_by_principal!,
          recordedAt: toIso(row.impact_recorded_at!),
        };

  // Derived lifecycle: an impact record means 'measured'; otherwise the
  // latest validation's outcome; otherwise 'pending'.
  const status: ContributionStatus =
    row.impact_id !== null ? 'measured' : (row.validation_outcome as ContributionStatus | null) ?? 'pending';

  return {
    id: row.id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    missionId: row.mission_id,
    evidenceObservationId: row.evidence_observation_id,
    contributor: { id: row.person_id, label: row.person_label },
    question: row.question,
    budgetCurrency: row.budget_currency,
    summary: row.summary,
    note: row.note,
    status,
    validation,
    validationCount: toInt(row.validation_count),
    impact,
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
    actor: mapActor(row),
  };
}

/** The current view of one contribution by id (tenant-scoped), for internal reuse. */
async function currentView(ctx: TenantContext, contributionId: string): Promise<Contribution> {
  const rows = await getDb().query<ViewRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [ctx.tenantId, contributionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw contributionNotFound(contributionId);
  return mapContribution(row);
}

// ---------------------------------------------------------------------------
// Cross-module reference validation
// ---------------------------------------------------------------------------

/**
 * The acquisition-plan anchor (the sanctioned `W012 → W042` dependency):
 * the plan must exist and be readable in this tenant, verified through
 * the knowledge-acquisition contract — never its tables. Missing,
 * malformed and foreign-tenant plan ids are uniformly `invalid_plan_ref`
 * (no existence leak).
 */
async function loadAcquisitionPlan(
  ctx: TenantContext,
  planId: string,
): Promise<Awaited<ReturnType<typeof getAcquisitionPlan>>> {
  try {
    return await getAcquisitionPlan(ctx, planId);
  } catch (error) {
    if (error instanceof KnowledgeAcquisitionError) {
      throw new ContributionsError(
        'invalid_plan_ref',
        `acquisition plan '${planId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * The learning-outcome link (the sanctioned `W040 → W042` dependency):
 * a measured impact may be grounded in a learning outcome that measures
 * the mission's improvement — checked readable through the learning
 * contract at write time. Missing, malformed and foreign-tenant outcome
 * ids are uniformly `invalid_outcome_ref` (no existence leak).
 */
async function validateOutcomeRef(ctx: TenantContext, outcomeId: string): Promise<void> {
  try {
    await getOutcome(ctx, outcomeId);
  } catch (error) {
    if (error instanceof LearningError) {
      throw new ContributionsError(
        'invalid_outcome_ref',
        `learning outcome '${outcomeId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// recordContribution
// ---------------------------------------------------------------------------

export async function recordContribution(
  ctx: TenantContext,
  input: RecordContributionInput,
): Promise<Contribution> {
  assertContributionsTenantContext(ctx);
  const valid: ValidatedRecordInput = validateRecordContributionInput(input);

  // --- the anchor: one answered ask-person acquisition plan (W012) ---
  const plan = await loadAcquisitionPlan(ctx, valid.planId);
  if (plan.decision !== 'selected' || plan.action !== 'ask-person' || plan.chosen === null) {
    // A no_candidate plan has no action to answer; a non-ask-person plan
    // queried a system/document/external source/agent/analysis — that is
    // not an EMPLOYEE knowledge contribution (§7/lock 9). Either way the
    // plan cannot anchor a contribution.
    throw new ContributionsError(
      'invalid_plan_ref',
      `acquisition plan '${valid.planId}' is not an answered employee question — only a selected ask-person plan anchors a knowledge contribution`,
    );
  }
  if (
    plan.outcome === null ||
    plan.outcome.outcome !== 'answered' ||
    plan.outcome.evidenceObservationId === null
  ) {
    // The question was planned (and possibly sent), but no answer was
    // supplied: unavailable/failed acquisitions have nothing to
    // contribute.
    throw new ContributionsError(
      'plan_unanswered',
      `acquisition plan '${valid.planId}' carries no answered outcome — record the acquisition outcome (W012) first`,
    );
  }
  if (plan.chosen.kind !== 'person' || plan.chosen.id === null || plan.question === null) {
    // Defense in depth: the planner only selects resolvable persons with a
    // composed question; a plan that violates that shape is unusable.
    throw new ContributionsError(
      'invalid_plan_ref',
      `acquisition plan '${valid.planId}' does not identify a resolvable person and question`,
    );
  }

  // --- the derived, minted-by-the-system tie ---
  const recordedAt = now();
  let inserted: DbResult<ContributionRow>;
  try {
    inserted = await getDb().query<ContributionRow>(
      `INSERT INTO contributions (
         tenant_id, plan_id, mission_id, evidence_observation_id,
         person_id, person_label, question, budget_currency,
         summary, note,
         actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10,
         $11, $12, $13, $14, $15::timestamptz
       ) RETURNING *`,
      [
        ctx.tenantId,
        valid.planId,
        plan.missionId,
        plan.outcome.evidenceObservationId,
        plan.chosen.id,
        plan.chosen.label,
        plan.question,
        plan.budgetCurrency,
        valid.summary,
        valid.note,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        recordedAt,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'contributions')) {
      throw new ContributionsError(
        'contribution_conflict',
        `acquisition plan '${valid.planId}' already has its knowledge contribution — one question, one answer, one record`,
      );
    }
    throw error;
  }
  const row = inserted.rows[0]!;

  // A fresh contribution: pending, unvalidated, unmeasured.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    missionId: row.mission_id,
    evidenceObservationId: row.evidence_observation_id,
    contributor: { id: row.person_id, label: row.person_label },
    question: row.question,
    budgetCurrency: row.budget_currency,
    summary: row.summary,
    note: row.note,
    status: 'pending',
    validation: null,
    validationCount: 0,
    impact: null,
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
    actor: mapActor(row),
  };
}

// ---------------------------------------------------------------------------
// validateContribution
// ---------------------------------------------------------------------------

export async function validateContribution(
  ctx: TenantContext,
  input: ValidateContributionInput,
): Promise<ContributionValidation> {
  assertContributionsTenantContext(ctx);
  const valid: ValidatedValidationInput = validateValidateContributionInput(input);
  if (!isUuid(valid.contributionId)) {
    // Malformed ids are indistinguishable from missing contributions
    // (no leak).
    throw contributionNotFound(valid.contributionId);
  }
  const recordedAt = now();

  // The composite FK (contribution_id, tenant_id) would make a
  // foreign-tenant insert unrepresentable, but the pre-check keeps the
  // error uniform (contribution_not_found, not a raw FK violation).
  const exists = await getDb().query<{ id: string }>(
    `SELECT id FROM contributions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.contributionId],
  );
  if (exists.rows.length === 0) throw contributionNotFound(valid.contributionId);

  // Appends to the validation series — revalidation is allowed, history
  // is never rewritten, contradictions are retained (lock 12).
  const inserted = await getDb().query<ValidationRow>(
    `INSERT INTO contribution_validations (
       tenant_id, contribution_id, outcome, quality, evidence, note,
       actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6,
       $7, $8, $9, $10, $11::timestamptz
     ) RETURNING *`,
    [
      ctx.tenantId,
      valid.contributionId,
      valid.outcome,
      valid.quality,
      JSON.stringify(valid.evidence),
      valid.note,
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      ctx.principalId,
      recordedAt,
    ],
  );
  return mapValidation(inserted.rows[0]!);
}

// ---------------------------------------------------------------------------
// recordImpact (the one measured record; first write wins)
// ---------------------------------------------------------------------------

/** Locks the contribution row (FOR UPDATE) and returns it, or `contribution_not_found`. */
async function lockContribution(
  tx: Queryable,
  ctx: TenantContext,
  contributionId: string,
): Promise<ContributionRow> {
  const locked = await tx.query<ContributionRow>(
    `SELECT * FROM contributions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.tenantId, contributionId],
  );
  const row = locked.rows[0];
  if (row === undefined) throw contributionNotFound(contributionId);
  return row;
}

export async function recordImpact(
  ctx: TenantContext,
  input: RecordImpactInput,
): Promise<Contribution> {
  assertContributionsTenantContext(ctx);
  const valid: ValidatedImpactInput = validateRecordImpactInput(input);
  if (!isUuid(valid.contributionId)) throw contributionNotFound(valid.contributionId);
  if (valid.outcomeId !== null) {
    await validateOutcomeRef(ctx, valid.outcomeId);
  }
  const recordedAt = now();

  // Freeze the knowledge gain — the single deterministic definition
  // (validation.ts), stored once, never recomputed.
  const gain = assessKnowledgeGain(valid.confidenceBefore, valid.confidenceAfter);

  await getDb().transaction(async (tx) => {
    // Lock + the §7 canonical-order gate inside the mutation transaction:
    // evidence quality is assessed BEFORE the mission is updated.
    await lockContribution(tx, ctx, valid.contributionId);
    const series = await tx.query<{ count: number | string }>(
      `SELECT count(*)::int AS count FROM contribution_validations
        WHERE tenant_id = $1 AND contribution_id = $2`,
      [ctx.tenantId, valid.contributionId],
    );
    if (toInt(series.rows[0]!.count) === 0) {
      throw new ContributionsError(
        'impact_requires_validation',
        `contribution '${valid.contributionId}' has no evidence-quality assessment yet — assess evidence quality (validateContribution) before recording the impact (§7: record → assess → update the mission)`,
      );
    }

    try {
      await tx.query<ImpactRow>(
        `INSERT INTO contribution_impacts (
           tenant_id, contribution_id, mission_impact,
           confidence_before, confidence_after, knowledge_gain,
           affected_goals, avoided_cost, avoided_paths, outcome_id, note,
           actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7::jsonb, $8, $9::jsonb, $10, $11,
           $12, $13, $14, $15, $16::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          valid.contributionId,
          valid.missionImpact,
          valid.confidenceBefore,
          valid.confidenceAfter,
          gain.knowledgeGain,
          JSON.stringify(valid.affectedGoals),
          valid.avoidedCost,
          JSON.stringify(valid.avoidedPaths),
          valid.outcomeId,
          valid.note,
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'contribution_impacts')) {
        throw new ContributionsError(
          'impact_conflict',
          `contribution '${valid.contributionId}' already carries its measured impact — the first record wins and is frozen`,
        );
      }
      throw error;
    }
  });

  // The committed current view (status 'measured').
  return currentView(ctx, valid.contributionId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getContribution(
  ctx: TenantContext,
  contributionId: string,
): Promise<Contribution> {
  assertContributionsTenantContext(ctx);
  if (!isUuid(contributionId)) throw contributionNotFound(contributionId);
  return currentView(ctx, contributionId.toLowerCase());
}

export async function listContributions(
  ctx: TenantContext,
  query: ListContributionsQuery,
): Promise<Contribution[]> {
  assertContributionsTenantContext(ctx);
  const valid = validateListContributionsQuery(query);

  const conditions: string[] = ['c.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.missionId !== null) add('c.mission_id = $#', valid.missionId);
  if (valid.personId !== null) add('c.person_id = $#', valid.personId);
  if (valid.status !== null) {
    // Status is derived from the impact row's existence and the latest
    // validation's outcome.
    if (valid.status === 'measured') conditions.push('i.id IS NOT NULL');
    else if (valid.status === 'pending') conditions.push('i.id IS NULL AND lv.id IS NULL');
    else {
      params.push(valid.status);
      conditions.push(`i.id IS NULL AND lv.outcome = $${params.length}`);
    }
  }
  if (valid.missionImpact !== null) add('i.mission_impact = $#', valid.missionImpact);
  if (valid.search !== null) {
    // escaped substring match on the summary — caller text is never a
    // wildcard pattern.
    params.push(escapeLike(valid.search));
    const placeholder = `$${params.length}`;
    conditions.push(`c.summary ILIKE '%' || ${placeholder} || '%' ESCAPE '\\'`);
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Newest contributions first (the management feed ordering); id breaks
  // ties deterministically.
  const rows = await getDb().query<ViewRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.recorded_at DESC, c.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapContribution);
}

export async function getValidation(
  ctx: TenantContext,
  validationId: string,
): Promise<ContributionValidation> {
  assertContributionsTenantContext(ctx);
  if (!isUuid(validationId)) throw validationNotFound(validationId);

  const rows = await getDb().query<ValidationRow>(
    `SELECT * FROM contribution_validations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, validationId.toLowerCase()],
  );
  const row = rows.rows[0];
  if (row === undefined) throw validationNotFound(validationId);
  return mapValidation(row);
}

export async function listValidations(
  ctx: TenantContext,
  query: ListValidationsQuery,
): Promise<ContributionValidation[]> {
  assertContributionsTenantContext(ctx);
  const valid = validateListValidationsQuery(query);

  const rows = await getDb().query<ValidationRow>(
    `SELECT * FROM contribution_validations
      WHERE tenant_id = $1 AND contribution_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, valid.contributionId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such contribution in this tenant" from "contribution
    // without validations" — a foreign-tenant contribution id reads the
    // same as a missing one either way; the explicit check keeps the
    // error honest.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM contributions WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.contributionId],
    );
    if (exists.rows.length === 0) throw contributionNotFound(valid.contributionId);
  }
  return rows.rows.map(mapValidation);
}

// ---------------------------------------------------------------------------
// summarizeContributions — the contribution-value rollup
// ---------------------------------------------------------------------------

/** Row shape of the status/impact rollup over the current views. */
interface SummaryRow extends DbRow {
  total: number | string;
  pending_count: number | string;
  validated_count: number | string;
  contradicted_count: number | string;
  rejected_count: number | string;
  measured_count: number | string;
  advanced_count: number | string;
  resolved_count: number | string;
  no_effect_count: number | string;
  total_knowledge_gain: number | string;
}

/** Row shape of the per-currency cost-avoided rollup. */
interface CostRow extends DbRow {
  currency: string;
  contributions: number | string;
  avoided_cost: number | string;
}

/**
 * The contribution-value rollup (W042's value surface): counts over the
 * derived status ladder, impact-kind counts and the arithmetic knowledge
 * gain over the measured set, plus the investigation cost avoided summed
 * PER CURRENCY (money is never summed across currencies — the W012
 * convention). W043 Rewards and W052 source ranking read this surface.
 */
export async function summarizeContributions(
  ctx: TenantContext,
  query?: SummarizeContributionsQuery,
): Promise<ContributionSummary> {
  assertContributionsTenantContext(ctx);
  const valid = validateSummarizeContributionsQuery(query);

  const conditions = ['c.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.personId !== null) {
    params.push(valid.personId);
    conditions.push(`c.person_id = $${params.length}`);
  }

  const rows = await getDb().query<SummaryRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE i.id IS NULL AND lv.id IS NULL)::int AS pending_count,
       count(*) FILTER (WHERE i.id IS NULL AND lv.outcome = 'validated')::int AS validated_count,
       count(*) FILTER (WHERE i.id IS NULL AND lv.outcome = 'contradicted')::int AS contradicted_count,
       count(*) FILTER (WHERE i.id IS NULL AND lv.outcome = 'rejected')::int AS rejected_count,
       count(*) FILTER (WHERE i.id IS NOT NULL)::int AS measured_count,
       count(*) FILTER (WHERE i.mission_impact = 'advanced')::int AS advanced_count,
       count(*) FILTER (WHERE i.mission_impact = 'resolved')::int AS resolved_count,
       count(*) FILTER (WHERE i.mission_impact = 'no_effect')::int AS no_effect_count,
       COALESCE(sum(i.knowledge_gain) FILTER (WHERE i.id IS NOT NULL), 0) AS total_knowledge_gain
     ${CURRENT_VIEW_FROM}
     WHERE ${conditions.join(' AND ')}`,
    params,
  );
  const row = rows.rows[0]!;

  const costRows = await getDb().query<CostRow>(
    `SELECT c.budget_currency AS currency,
       count(*)::int AS contributions,
       COALESCE(sum(i.avoided_cost), 0) AS avoided_cost
     FROM contributions c
       JOIN contribution_impacts i
         ON i.contribution_id = c.id AND i.tenant_id = c.tenant_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY c.budget_currency
     ORDER BY c.budget_currency`,
    params,
  );
  const costAvoidedByCurrency: CostAvoidedBucket[] = costRows.rows.map((cost) => ({
    currency: cost.currency,
    contributions: toInt(cost.contributions),
    avoidedCost: toInt(cost.avoided_cost),
  }));

  return {
    total: toInt(row.total),
    pending: toInt(row.pending_count),
    validated: toInt(row.validated_count),
    contradicted: toInt(row.contradicted_count),
    rejected: toInt(row.rejected_count),
    measured: toInt(row.measured_count),
    missionsAdvanced: toInt(row.advanced_count),
    missionsResolved: toInt(row.resolved_count),
    noEffect: toInt(row.no_effect_count),
    totalKnowledgeGain: toInt(row.total_knowledge_gain),
    costAvoidedByCurrency,
  };
}
