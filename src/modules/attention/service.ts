// Implementation of the attention module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps (`recorded_at`,
// `materialized_at`, `updated_at`) come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`candidate_not_found`, uniform `invalid_reference`
// / `invalid_evidence` on referenced records — no existence leak).
//
// W051 acceptance — "material goal/evidence gaps create candidate unknowns
// without a user question; candidate unknowns contain impact, urgency,
// confidence gap and information value; only material unknowns become
// missions; discovery is evidence-linked and auditable; end-to-end
// synthetic proof exists" — is carried by these deliberate properties:
//   1. the discovery input carries NO user question anywhere: goal
//      reference + evidence references + the derived gap analysis the
//      evaluator proposes (ADR-0017's propose/decide seam);
//   2. the application validates the goal (exists, readable, ACTIVE —
//      ADR-0017 derives from active goals), the evidence (readable in
//      this tenant) and every shape;
//   3. MATERIALLY is decided deterministically by the pure policy gate
//      (materiality.ts) against the tenant's policy (or the built-in
//      floor) — never by the proposer;
//   4. only material candidates materialize, and only through the policy:
//      'auto' releases them inside discovery, 'manual' requires the
//      explicit `materializeCandidate` call — mission creation is
//      application-owned, policy-gated and auditable (ADR-0017);
//   5. materialization drives the epistemics contract (recordUnknown) and
//      the missions contract (createMission) — the W007 unknown and the
//      W011 LearningMission — and links both back on the frozen candidate
//      row (one-way material -> materialized, storage-enforced);
//   6. the candidate row snapshots the policy thresholds that decided, so
//      every discovery stays reconstructable after policy changes.
//
// Cross-module integration: goals, epistemics, missions and cognition are
// read/driven ONLY through their public contracts; the evidence basis is
// validated through the observations contract (the epistemics module's
// own evidence-validation precedent — W007 is a declared dependency and
// observations is its foundation). Error propagation follows the policy
// documented in errors.ts.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getObservation, ObservationsError } from '@/modules/observations/contract';
import { getClaim, recordUnknown, EpistemicsError } from '@/modules/epistemics/contract';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import { createMission } from '@/modules/missions/contract';
import { getExecution, CognitionError } from '@/modules/cognition/contract';
import { AttentionError } from './errors';
import {
  BUILT_IN_DISCOVERY_POLICY,
  deriveMissionDefinition,
  deriveUnknownRecord,
  evaluateMateriality,
  type DerivationCandidate,
} from './materiality';
import {
  assertAttentionTenantContext,
  canAdministerDiscoveryPolicy,
  escapeLike,
  validateDiscoveryInput,
  validateGetQuery,
  validateListQuery,
  validateMaterializeInput,
  validatePolicyInput,
  type ValidatedDiscoveryInput,
} from './validation';
import type {
  AcquisitionPath,
  CandidateUnknown,
  DiscoveryPolicy,
  DiscoverGoalGapInput,
  EffectiveDiscoveryPolicy,
  GapProposer,
  GapUrgency,
  GetCandidateUnknownQuery,
  ListCandidateUnknownsQuery,
  MaterializeCandidateInput,
  SetDiscoveryPolicyInput,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface PolicyRow extends DbRow {
  tenant_id: string;
  min_decision_impact: number;
  min_information_value: number;
  mission_policy: string;
  investigation_budget_amount: number | string;
  investigation_budget_currency: string;
  reward_budget_amount: number | string;
  reward_budget_currency: string;
  updated_at: Date | string;
  updated_by: string;
}

interface CandidateRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  metric_name: string | null;
  missing_knowledge: string;
  impact_description: string;
  decision_impact: number;
  information_value: number;
  urgency: string;
  current_confidence: number;
  required_confidence: number;
  evidence_observation_ids: string[];
  evidence_claim_ids: string[];
  acquisition_paths: { kind: string; id: string | null; label: string | null }[];
  proposer_kind: string;
  proposer_id: string | null;
  proposer_label: string | null;
  proposer_note: string | null;
  execution_id: string | null;
  status: string;
  min_decision_impact: number;
  min_information_value: number;
  materiality_basis: string;
  recorded_by: string;
  recorded_at: Date | string;
  unknown_id: string | null;
  mission_id: string | null;
  materialized_at: Date | string | null;
  materialized_by: string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toAmount(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function mapPolicy(row: PolicyRow): DiscoveryPolicy {
  return {
    minDecisionImpact: row.min_decision_impact,
    minInformationValue: row.min_information_value,
    missionPolicy: row.mission_policy as DiscoveryPolicy['missionPolicy'],
    investigationBudget: {
      amount: toAmount(row.investigation_budget_amount),
      currency: row.investigation_budget_currency,
    },
    rewardBudget: {
      amount: toAmount(row.reward_budget_amount),
      currency: row.reward_budget_currency,
    },
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
  };
}

function mapCandidate(row: CandidateRow): CandidateUnknown {
  const status = row.status as CandidateUnknown['status'];
  const proposer: GapProposer = {
    kind: row.proposer_kind as GapProposer['kind'],
    id: row.proposer_id,
    label: row.proposer_label,
  };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    metricName: row.metric_name,
    missingKnowledge: row.missing_knowledge,
    impactDescription: row.impact_description,
    decisionImpact: row.decision_impact,
    informationValue: row.information_value,
    urgency: row.urgency as GapUrgency,
    currentConfidence: row.current_confidence,
    requiredConfidence: row.required_confidence,
    confidenceGap: row.required_confidence - row.current_confidence,
    evidenceObservationIds: [...(row.evidence_observation_ids ?? [])],
    evidenceClaimIds: [...(row.evidence_claim_ids ?? [])],
    acquisitionPaths: (row.acquisition_paths ?? []).map(
      (path): AcquisitionPath => ({ kind: path.kind as AcquisitionPath['kind'], id: path.id, label: path.label }),
    ),
    proposer,
    proposerNote: row.proposer_note,
    executionId: row.execution_id,
    status,
    // The verdict is frozen on the row: status carries the decision the
    // pure gate produced at record time ('immaterial' terminal, otherwise
    // 'material'); the thresholds that produced it are snapshotted beside it.
    materiality: {
      decision: status === 'immaterial' ? 'immaterial' : 'material',
      material: status !== 'immaterial',
      basis: row.materiality_basis,
      minDecisionImpact: row.min_decision_impact,
      minInformationValue: row.min_information_value,
    },
    recordedByPrincipal: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
    materialization:
      status === 'materialized' && row.unknown_id !== null && row.mission_id !== null
        ? {
            unknownId: row.unknown_id,
            missionId: row.mission_id,
            materializedAt: toIso(row.materialized_at!),
            materializedBy: row.materialized_by!,
          }
        : null,
  };
}

/** The pure-derivation view of one candidate row (materiality.ts seam). */
function toDerivationCandidate(candidate: CandidateUnknown): DerivationCandidate {
  return {
    id: candidate.id,
    goalId: candidate.goalId,
    metricName: candidate.metricName,
    missingKnowledge: candidate.missingKnowledge,
    impactDescription: candidate.impactDescription,
    urgency: candidate.urgency,
    informationValue: candidate.informationValue,
    currentConfidence: candidate.currentConfidence,
    requiredConfidence: candidate.requiredConfidence,
    evidenceObservationIds: candidate.evidenceObservationIds,
    evidenceClaimIds: candidate.evidenceClaimIds,
    acquisitionPaths: candidate.acquisitionPaths.map((path) => ({
      kind: path.kind,
      id: path.id ?? null,
      label: path.label ?? null,
    })),
    materialityBasis: candidate.materiality.basis,
    proposer: {
      kind: candidate.proposer.kind,
      id: candidate.proposer.id ?? null,
      label: candidate.proposer.label ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-module error mapping (uniform reference/evidence failures)
// ---------------------------------------------------------------------------

/** Maps a GoalsError from the goal lookup onto this module's vocabulary. */
function mapGoalsError(error: unknown, goalId: string): Error {
  if (error instanceof GoalsError) {
    return new AttentionError(
      'invalid_reference',
      `goal '${goalId}' is not available in this tenant to this principal`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Maps a CognitionError from the execution lookup onto this module's vocabulary. */
function mapCognitionError(error: unknown, executionId: string): Error {
  if (error instanceof CognitionError) {
    return new AttentionError(
      'invalid_reference',
      `cognitive execution '${executionId}' is not available in this tenant to this principal`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Maps an ObservationsError from the evidence validation onto this module's vocabulary. */
function mapObservationsError(error: unknown, observationId: string): Error {
  if (error instanceof ObservationsError) {
    return new AttentionError(
      'invalid_evidence',
      `evidence observation '${observationId}' is not available in this tenant to this principal`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Maps an EpistemicsError (claim lookup / unknown recording) onto this module's vocabulary. */
function mapEpistemicsError(error: unknown, claimId: string): Error {
  if (error instanceof EpistemicsError) {
    return new AttentionError(
      'invalid_evidence',
      `evidence claim '${claimId}' is not available in this tenant to this principal`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** True when `error` is a PostgreSQL unique violation naming `identifier`. */
function isDuplicateKeyOn(error: unknown, identifier: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(identifier)
  );
}

// ---------------------------------------------------------------------------
// Evidence and reference validation (through the owning contracts)
// ---------------------------------------------------------------------------

/**
 * Every evidence observation must exist in THIS tenant and be readable by
 * the acting principal — uniformly `invalid_evidence` otherwise (no
 * existence leak; the epistemics module's evidence-gate precedent).
 * Observations are immutable, so a validated link cannot dangle.
 */
async function validateObservationRefs(ctx: TenantContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await getObservation(ctx, id);
    } catch (error) {
      throw mapObservationsError(error, id);
    }
  }
}

/** Evidence claims must exist in THIS tenant (validated via epistemics). */
async function validateClaimRefs(ctx: TenantContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await getClaim(ctx, { claimId: id });
    } catch (error) {
      throw mapEpistemicsError(error, id);
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery policy (the materiality gate configuration)
// ---------------------------------------------------------------------------

/** The effective policy: the tenant row, or the built-in floor. */
async function loadEffectivePolicy(ctx: TenantContext): Promise<EffectiveDiscoveryPolicy> {
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM goal_gap_policies WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    return {
      ...BUILT_IN_DISCOVERY_POLICY,
      investigationBudget: { ...BUILT_IN_DISCOVERY_POLICY.investigationBudget },
      rewardBudget: { ...BUILT_IN_DISCOVERY_POLICY.rewardBudget },
      updatedAt: null,
      updatedBy: null,
      source: 'built-in',
    };
  }
  return { ...mapPolicy(row), source: 'tenant' };
}

/** `getDiscoveryPolicy` — the effective policy and where it comes from. */
export async function getDiscoveryPolicy(ctx: TenantContext): Promise<EffectiveDiscoveryPolicy> {
  assertAttentionTenantContext(ctx);
  return loadEffectivePolicy(ctx);
}

/**
 * `setDiscoveryPolicy` — set (replace) the tenant's discovery policy.
 * A management control: writing it requires the 'attention:administer'
 * authority claim (the notifications module's administer-claim precedent),
 * so a plain member cannot weaken the tenant's own materiality gate.
 */
export async function setDiscoveryPolicy(
  ctx: TenantContext,
  input: SetDiscoveryPolicyInput,
): Promise<DiscoveryPolicy> {
  assertAttentionTenantContext(ctx);
  if (!canAdministerDiscoveryPolicy(ctx)) {
    throw new AttentionError(
      'forbidden',
      "this operation requires the 'attention:administer' authority claim",
    );
  }
  const valid = validatePolicyInput(input);
  const updatedAt = now();
  const rows = await getDb().query<PolicyRow>(
    `INSERT INTO goal_gap_policies (
       tenant_id, min_decision_impact, min_information_value, mission_policy,
       investigation_budget_amount, investigation_budget_currency,
       reward_budget_amount, reward_budget_currency, updated_at, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id) DO UPDATE SET
       min_decision_impact = EXCLUDED.min_decision_impact,
       min_information_value = EXCLUDED.min_information_value,
       mission_policy = EXCLUDED.mission_policy,
       investigation_budget_amount = EXCLUDED.investigation_budget_amount,
       investigation_budget_currency = EXCLUDED.investigation_budget_currency,
       reward_budget_amount = EXCLUDED.reward_budget_amount,
       reward_budget_currency = EXCLUDED.reward_budget_currency,
       updated_at = EXCLUDED.updated_at,
       updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      ctx.tenantId,
      valid.minDecisionImpact,
      valid.minInformationValue,
      valid.missionPolicy,
      valid.investigationBudget.amount,
      valid.investigationBudget.currency,
      valid.rewardBudget.amount,
      valid.rewardBudget.currency,
      updatedAt,
      ctx.principalId,
    ],
  );
  return mapPolicy(rows.rows[0]!);
}

// ---------------------------------------------------------------------------
// Goal-gap discovery — the unprompted capability
// ---------------------------------------------------------------------------

async function findCandidateRow(ctx: TenantContext, candidateId: string): Promise<CandidateRow> {
  const rows = await getDb().query<CandidateRow>(
    `SELECT * FROM candidate_unknowns WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, candidateId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AttentionError(
      'candidate_not_found',
      `candidate unknown '${candidateId}' is not available in this tenant`,
    );
  }
  return row;
}

/**
 * Materialize ONE material candidate: record the epistemic unknown (W007),
 * launch the LearningMission (W011) and freeze the links on the candidate
 * row (one-way material -> materialized).
 *
 * Cross-module writes are contract-only and non-transactional across
 * modules (the cognition module's unknown-mission-evaluation precedent):
 * a failure surfaces as `materialization_failed` and leaves the candidate
 * 'material' — retryable, never half-linked.
 */
async function materializeCandidateRow(
  ctx: TenantContext,
  row: CandidateRow,
  goalTitle: string,
  policy: DiscoveryPolicy,
): Promise<CandidateRow> {
  const candidate = mapCandidate(row);
  const derivation = toDerivationCandidate(candidate);

  // 1. The epistemic unknown — question, consequence, evidence links and
  //    subject all derived deterministically from the candidate.
  let unknownId: string;
  try {
    const unknown = await recordUnknown(ctx, deriveUnknownRecord(derivation));
    unknownId = unknown.id;
  } catch (error) {
    throw new AttentionError(
      'materialization_failed',
      `recording the goal-gap unknown failed for candidate '${row.id}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 2. The LearningMission — through the policy gate's budgets, carrying
  //    the ADR-0017 field set derived from the candidate.
  let missionId: string;
  try {
    const definition = deriveMissionDefinition(derivation, goalTitle, {
      investigationBudget: policy.investigationBudget,
      rewardBudget: policy.rewardBudget,
    });
    const mission = await createMission(ctx, {
      title: definition.title,
      knowledgeObjective: definition.knowledgeObjective,
      affectedGoals: definition.affectedGoals,
      unknownIds: [unknownId],
      informationValue: definition.informationValue,
      urgency: definition.urgency,
      currentConfidence: definition.currentConfidence,
      targetConfidence: definition.targetConfidence,
      investigationBudget: definition.investigationBudget,
      rewardBudget: definition.rewardBudget,
      candidateSources: definition.candidateSources,
      completionCriteria: definition.completionCriteria,
      actor: {
        kind: derivation.proposer.kind as 'person' | 'team' | 'agent' | 'system' | 'external',
        id: derivation.proposer.id,
        label: derivation.proposer.label,
      },
      rationale: definition.rationale,
    });
    missionId = mission.id;
  } catch (error) {
    throw new AttentionError(
      'materialization_failed',
      `launching the goal-gap mission failed for candidate '${row.id}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 3. The one-way, storage-guarded transition that links both.
  const materializedAt = now();
  const updated = await getDb().query<CandidateRow>(
    `UPDATE candidate_unknowns
       SET status = 'materialized',
           unknown_id = $3,
           mission_id = $4,
           materialized_at = $5,
           materialized_by = $6
     WHERE tenant_id = $1 AND id = $2 AND status = 'material'
     RETURNING *`,
    [ctx.tenantId, row.id, unknownId, missionId, materializedAt, ctx.principalId],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow === undefined) {
    // A raced pump materialized between our read and this write.
    const current = await findCandidateRow(ctx, row.id);
    if (current.status !== 'materialized') {
      throw new AttentionError(
        'candidate_already_materialized',
        `candidate unknown '${row.id}' is no longer material ('${current.status}')`,
      );
    }
    return current;
  }
  return updatedRow;
}

/**
 * `discoverGoalGap` — THE unprompted discovery operation (ADR-0017):
 * evaluate one goal/evidence gap WITHOUT a user question, record the
 * candidate unknown with impact, urgency, confidence gap and information
 * value, decide materiality deterministically against the effective
 * policy, and — when the policy releases missions automatically —
 * materialize into the epistemic unknown and the LearningMission in the
 * same call.
 */
export async function discoverGoalGap(
  ctx: TenantContext,
  input: DiscoverGoalGapInput,
): Promise<CandidateUnknown> {
  assertAttentionTenantContext(ctx);
  const valid: ValidatedDiscoveryInput = validateDiscoveryInput(input);

  // The gap hangs off CURRENT direction: the goal must exist, be readable
  // and be ACTIVE in this tenant (ADR-0017: "derives consequential
  // unknowns from active goals").
  let goal;
  try {
    goal = await getGoal(ctx, valid.goalId);
  } catch (error) {
    throw mapGoalsError(error, valid.goalId);
  }
  if (goal.content.status !== 'active') {
    throw new AttentionError(
      'goal_not_active',
      `goal '${valid.goalId}' is ${goal.content.status} — goal-gap discovery derives from active goals only`,
    );
  }
  if (valid.metricName !== null) {
    const metricNames = goal.content.metrics.map((metric) => metric.name);
    if (!metricNames.includes(valid.metricName)) {
      throw new AttentionError(
        'invalid_discovery_input',
        `metricName '${valid.metricName}' is not a metric of goal '${valid.goalId}' (metrics: ${metricNames.join(', ') || 'none'})`,
      );
    }
  }

  // The loop trace link, when a cognitive execution produced this
  // evaluation (§24 reconstructability).
  if (valid.executionId !== null) {
    try {
      await getExecution(ctx, { executionId: valid.executionId });
    } catch (error) {
      throw mapCognitionError(error, valid.executionId);
    }
  }

  // Discovery is evidence-linked: the basis must be readable here.
  await validateObservationRefs(ctx, valid.evidenceObservationIds);
  await validateClaimRefs(ctx, valid.evidenceClaimIds);

  // The deterministic policy gate (never the proposer).
  const policy = await loadEffectivePolicy(ctx);
  const decision = evaluateMateriality(policy, {
    decisionImpact: valid.decisionImpact,
    informationValue: valid.informationValue,
  });

  const recordedAt = now();
  let row: CandidateRow;
  try {
    const inserted = await getDb().query<CandidateRow>(
      `INSERT INTO candidate_unknowns (
         tenant_id, goal_id, metric_name,
         missing_knowledge, impact_description,
         decision_impact, information_value, urgency,
         current_confidence, required_confidence,
         evidence_observation_ids, evidence_claim_ids, acquisition_paths,
         proposer_kind, proposer_id, proposer_label, proposer_note,
         execution_id,
         status, min_decision_impact, min_information_value, materiality_basis,
         recorded_by, recorded_at
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         $6, $7, $8,
         $9, $10,
         $11::jsonb, $12::jsonb, $13::jsonb,
         $14, $15, $16, $17,
         $18,
         $19, $20, $21, $22,
         $23, $24
       )
       RETURNING *`,
      [
        ctx.tenantId,
        valid.goalId,
        valid.metricName,
        valid.missingKnowledge,
        valid.impactDescription,
        valid.decisionImpact,
        valid.informationValue,
        valid.urgency,
        valid.currentConfidence,
        valid.requiredConfidence,
        JSON.stringify(valid.evidenceObservationIds),
        JSON.stringify(valid.evidenceClaimIds),
        JSON.stringify(valid.acquisitionPaths),
        valid.proposer.kind,
        valid.proposer.id,
        valid.proposer.label,
        valid.proposerNote,
        valid.executionId,
        decision.material ? 'material' : 'immaterial',
        policy.minDecisionImpact,
        policy.minInformationValue,
        decision.basis,
        ctx.principalId,
        recordedAt,
      ],
    );
    row = inserted.rows[0]!;
  } catch (error) {
    if (isDuplicateKeyOn(error, 'candidate_unknowns_gap_unique')) {
      throw new AttentionError(
        'candidate_conflict',
        `this goal gap is already recorded for goal '${valid.goalId}' — look at the existing candidate unknown`,
      );
    }
    throw error;
  }

  // The policy gate on mission creation: 'auto' releases material
  // candidates inside discovery (the unprompted, continuous capability);
  // 'manual' records the verdict for an explicit materialization.
  if (decision.material && policy.missionPolicy === 'auto') {
    row = await materializeCandidateRow(ctx, row, goal.content.title, policy);
  }
  return mapCandidate(row);
}

/**
 * `materializeCandidate` — the explicit policy-gate release: launch the
 * unknown + mission for a MATERIAL candidate (manual policy, or any
 * caller re-driving discovery). Immaterial candidates can never
 * materialize (ADR-0017's core invariant); materialized is terminal.
 * The goal must still be active — missions serve current direction.
 */
export async function materializeCandidate(
  ctx: TenantContext,
  input: MaterializeCandidateInput,
): Promise<CandidateUnknown> {
  assertAttentionTenantContext(ctx);
  const valid = validateMaterializeInput(input);
  const row = await findCandidateRow(ctx, valid.candidateId);
  if (row.status === 'immaterial') {
    throw new AttentionError(
      'candidate_not_material',
      `candidate unknown '${valid.candidateId}' is immaterial — only material unknowns may become missions`,
    );
  }
  if (row.status === 'materialized') {
    throw new AttentionError(
      'candidate_already_materialized',
      `candidate unknown '${valid.candidateId}' is already materialized (unknown ${row.unknown_id}, mission ${row.mission_id})`,
    );
  }

  let goal;
  try {
    goal = await getGoal(ctx, row.goal_id);
  } catch (error) {
    throw mapGoalsError(error, row.goal_id);
  }
  if (goal.content.status !== 'active') {
    throw new AttentionError(
      'goal_not_active',
      `goal '${row.goal_id}' is ${goal.content.status} — materialization serves current direction`,
    );
  }

  const policy = await loadEffectivePolicy(ctx);
  const updated = await materializeCandidateRow(ctx, row, goal.content.title, policy);
  return mapCandidate(updated);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `getCandidateUnknown` — one auditable discovery, deep-linked by id. */
export async function getCandidateUnknown(
  ctx: TenantContext,
  query: GetCandidateUnknownQuery,
): Promise<CandidateUnknown> {
  assertAttentionTenantContext(ctx);
  const valid = validateGetQuery(query);
  const row = await findCandidateRow(ctx, valid.candidateId);
  return mapCandidate(row);
}

/** `listCandidateUnknowns` — the discovery feed, filtered and ranked. */
export async function listCandidateUnknowns(
  ctx: TenantContext,
  query: ListCandidateUnknownsQuery,
): Promise<CandidateUnknown[]> {
  assertAttentionTenantContext(ctx);
  const valid = validateListQuery(query);

  const conditions: string[] = ['c.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.status !== undefined) add('c.status = $#', valid.status);
  if (valid.goalId !== undefined) add('c.goal_id = $#', valid.goalId);
  if (valid.urgency !== undefined) add('c.urgency = $#', valid.urgency);
  if (valid.proposerKind !== undefined) {
    const proposer =
      valid.proposerId === undefined
        ? { kind: valid.proposerKind }
        : { kind: valid.proposerKind, id: valid.proposerId };
    // jsonb containment: matches any proposer entry carrying this kind (and id).
    add('jsonb_build_object(\'kind\', c.proposer_kind, \'id\', c.proposer_id) @> $#::jsonb', JSON.stringify(proposer));
  }
  if (valid.executionId !== undefined) add('c.execution_id = $#', valid.executionId);
  if (valid.search !== undefined) {
    // escaped substring match on the missing-knowledge statement — caller
    // text is never a wildcard pattern.
    params.push(escapeLike(valid.search));
    const placeholder = `$${params.length}`;
    conditions.push(`c.missing_knowledge ILIKE '%' || ${placeholder} || '%' ESCAPE '\\'`);
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Urgency rank (critical first) is the management ordering; recorded_at
  // DESC and id make it deterministic. The rank CASE enumerates the
  // CHECK-constrained urgency values only.
  const rows = await getDb().query<CandidateRow>(
    `SELECT c.* FROM candidate_unknowns c
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE c.urgency
                 WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4
               END ASC,
               c.recorded_at DESC, c.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapCandidate);
}
